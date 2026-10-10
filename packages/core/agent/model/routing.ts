import type { ModelRole, ModelRoute, Domain, NamedKnobLayer, DomainMatch, ModelReasoning } from "../memory/domain.js";
import { modelRouteFor, domainMatchFor, reasoningCeilingFor, domainForChannel, criteriaDomain } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { getSettings } from "../settings/settings.js";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { bindFrom, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { currentWorkerWake } from "../access/worker-seat-state.js";
import { noteWakeAttachments } from "../access/worker-continuation.js";
import { stampModelCall } from "./model-stamp.js";
import { noteTurnStep, reportStepBoundary, withWrapUpNotice, turnBackstopModel, wrapUpNotice, boundaryStopReply } from "./step-boundary.js";
import type { ModelPolicy } from "./policy.js";
import { applyModelPolicyToRoute } from "./policy.js";
import { getOperationalStore } from "../operational/provider.js";
import { isDmAnchorWindowToken, isSupervisorShapedToken } from "../channels/window-key.js";
import { routineModelRoleStamped } from "../routines/routine.js";
import { captureArmed, captureSiteFrom, noteUncalledModelStep, withCapture } from "./call-capture.js";
import { withStreamDropRetry } from "./stream-drop-retry.js";
import {
  abBucketKey,
  abThreadKey,
  applyModelAb,
  decideModelAb,
  modelAbTestArmed,
  noteModelAbArm,
  readModelArm,
  registeredModelAbTest,
  resolveModelArm,
  stampModelArm,
  type ModelAbInput,
  type ModelAbTest,
} from "./ab-test.js";

const loggedOnce = new Set<string>();
function logOnce(kind: "warn" | "log", reason: string): void {
  if (loggedOnce.has(reason)) return;
  loggedOnce.add(reason);
  (kind === "warn" ? console.warn : console.log)(`[open-everywhere:model-routing] ${reason}`);
}

export interface RoutedCallOptions {
  reasoning?: string;
  providerOptions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RoutableModel {
  readonly specificationVersion: string;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: unknown;
  doGenerate(options: any): PromiseLike<any>;
  doStream(options: any): PromiseLike<any>;
}

export interface ModelBackend<TModel extends RoutableModel = RoutableModel> {
  model(id: string): TModel;
  applyOptions(
    route: ModelRoute,
    options: RoutedCallOptions,
    ids: { readonly id: string; readonly defaultId: string },
  ): RoutedCallOptions;
}

export interface RoutingDeps<TModel extends RoutableModel = RoutableModel> {
  readonly domains: () => readonly Domain[];
  readonly roles?: () => readonly NamedKnobLayer[];
  readonly modelPolicy?: () => ModelPolicy | undefined;
  readonly domainModelPick?: (domainName: string) => Promise<DomainModelPick | null>;
  readonly modelAbTest?: () => ModelAbTest | undefined;
  readonly backend: ModelBackend<TModel>;
}

export interface DomainModelPick {
  readonly modelId?: string;
  readonly reasoning?: ModelReasoning;
}

const DOMAIN_MODEL_PICK_TTL_MS = 15_000;
interface DomainModelPickCacheEntry {
  readonly value: DomainModelPick | null;
  readonly expiresAt: number;
}
const domainModelPickCache = new Map<string, DomainModelPickCacheEntry>();

async function liveDomainModelPick(org: string, domainName: string): Promise<DomainModelPick | null> {
  const key = `${org} ${domainName}`;
  const now = Date.now();
  const cached = domainModelPickCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const row = await getOperationalStore().getDomainModel(org, domainName);
  const value: DomainModelPick | null = row ? { modelId: row.modelId, reasoning: row.reasoning } : null;
  domainModelPickCache.set(key, { value, expiresAt: now + DOMAIN_MODEL_PICK_TTL_MS });
  return value;
}

export const liveIdentity: Pick<RoutingDeps, "domains" | "roles" | "modelPolicy" | "domainModelPick" | "modelAbTest"> = {
  domains: () => getConfig().loadDomains(),
  roles: () => getConfig().loadRoles?.() ?? [],
  modelPolicy: () => getConfig().loadModelPolicy?.(),
  modelAbTest: () => registeredModelAbTest(),
  domainModelPick: async (domainName) => {
    try {
      return await liveDomainModelPick(deploymentOrg(), domainName);
    } catch {
      return null;
    }
  },
};

function identityFromContext(ctx: BindableContext): { surfaceKey: string; surfaceMatch: DomainMatch | undefined } {
  const surfaceKey = domainKeyOf(resolvePartition(ctx));
  let surfaceMatch: DomainMatch | undefined;
  try {
    const b = bindFrom(ctx);
    surfaceMatch = domainMatchFor(b.mode, b.trust);
  } catch {
    surfaceMatch = undefined;
  }
  return { surfaceKey, surfaceMatch };
}

export function applyRoute(
  route: ModelRoute,
  options: RoutedCallOptions,
  defaultId: string,
): { id: string; options: RoutedCallOptions } {
  const id = route.id ?? defaultId;
  return {
    id,
    options: route.reasoning !== undefined ? { ...options, reasoning: route.reasoning } : options,
  };
}

export async function resolveRoute(
  role: ModelRole,
  surfaceKey: string,
  surfaceMatch: DomainMatch | undefined,
  defaultId: string,
  deps: RoutingDeps,
  fallbackRole?: ModelRole,
  ab?: ModelAbInput,
): Promise<ModelRoute> {
  try {
    const domains = deps.domains();
    const roles = deps.roles?.() ?? [];
    let rawRoute = modelRouteFor(role, surfaceKey, domains, roles, surfaceMatch);
    if (fallbackRole !== undefined && routeUnset(rawRoute)) {
      rawRoute = modelRouteFor(fallbackRole, surfaceKey, domains, roles, surfaceMatch);
    }
    let pickedRoute: ModelRoute = rawRoute;
    try {
      const domainName = domainForChannel(surfaceKey, domains)?.name ?? (surfaceMatch ? criteriaDomain(surfaceMatch, domains)?.name : undefined);
      if (domainName !== undefined) {
        const pick = await deps.domainModelPick?.(domainName);
        if (pick && (pick.modelId !== undefined || pick.reasoning !== undefined)) {
          pickedRoute = {
            ...rawRoute,
            ...(pick.modelId !== undefined ? { id: pick.modelId, tier: undefined } : {}),
            ...(pick.reasoning !== undefined ? { reasoning: pick.reasoning } : {}),
          };
          logOnce("log", `${role}: domain "${domainName}" runtime pick → ${JSON.stringify(pick)}`);
        }
      }
    } catch (err) {
      pickedRoute = rawRoute;
      logOnce("warn", `${role}: domain model pick lookup failed (${String(err)})`);
    }
    const abDecision = ab ? decideModelAb(pickedRoute, defaultId, ab) : undefined;
    const armedRoute = applyModelAb(pickedRoute, abDecision);
    let policy: ModelPolicy | undefined;
    try {
      policy = deps.modelPolicy?.();
    } catch {
      policy = undefined;
    }
    let effectiveCeiling: ModelReasoning | undefined;
    if (policy) {
      try {
        effectiveCeiling = reasoningCeilingFor(surfaceKey, domains, roles, surfaceMatch, policy.reasoningCeiling ?? "medium");
      } catch {
        effectiveCeiling = undefined;
      }
    }
    const enveloped = applyModelPolicyToRoute(armedRoute, policy, defaultId, effectiveCeiling, defaultId);
    for (const w of enveloped.warnings) logOnce("warn", `${role}: model policy: ${w}`);
    const forcedId = getSettings().models.force || undefined;
    const route: ModelRoute = forcedId
      ? { ...armedRoute, id: forcedId, tier: undefined, reasoning: enveloped.reasoning }
      : { ...armedRoute, id: enveloped.id, reasoning: enveloped.reasoning };
    if (abDecision !== undefined) {
      const ranId = route.id ?? defaultId;
      stampModelArm({ arm: resolveModelArm(abDecision, ranId), bucketKey: abDecision.bucketKey, modelId: ranId });
    }
    if (route.id !== undefined || route.reasoning !== undefined || route.providers !== undefined) {
      logOnce("log", `${role}: ${surfaceKey} → ${JSON.stringify(route)}`);
    }
    return route;
  } catch (err) {
    logOnce("warn", `${role}: domain config unavailable (${String(err)}) — default model`);
    return {};
  }
}

function isNoOpRoute(route: ModelRoute, defaultId: string): boolean {
  return (route.id ?? defaultId) === defaultId && route.reasoning === undefined && route.providers === undefined && route.tier === undefined;
}

function routeUnset(route: ModelRoute): boolean {
  return route.id === undefined && route.tier === undefined && route.providers === undefined && route.reasoning === undefined;
}

export function isSupervisorSession(ctx: BindableContext): boolean {
  const token = ctx.channel?.continuationToken;
  if (isDmAnchorWindowToken(token)) return false;
  return isSupervisorShapedToken(token);
}

export function makeRoutedModel<TModel extends RoutableModel>(
  getRoute: () => ModelRoute,
  defaults: { readonly id: string },
  backend: ModelBackend<TModel>,
): TModel {
  const inner = new Map<string, TModel>();
  const modelFor = (id: string): TModel => {
    let m = inner.get(id);
    if (!m) {
      m = backend.model(id);
      inner.set(id, m);
    }
    return m;
  };
  const dispatch = (options: RoutedCallOptions): { model: TModel; options: RoutedCallOptions } => {
    const route = getRoute();
    const generic = applyRoute(route, options, defaults.id);
    const mapped = backend.applyOptions(route, generic.options, { id: generic.id, defaultId: defaults.id });
    stampModelCall(generic.id);
    return { model: modelFor(generic.id), options: mapped };
  };
  const fallback = modelFor(defaults.id);
  const routed: RoutableModel = {
    specificationVersion: fallback.specificationVersion,
    provider: fallback.provider,
    modelId: defaults.id,
    supportedUrls: fallback.supportedUrls,
    async doGenerate(options: RoutedCallOptions) {
      const d = dispatch(options);
      return d.model.doGenerate(d.options);
    },
    async doStream(options: RoutedCallOptions) {
      const d = dispatch(options);
      return d.model.doStream(d.options);
    },
  };
  return routed as TModel;
}

async function resolveRoutedPrimaryModel<TModel extends RoutableModel>(
  ctx: BindableContext,
  defaults: { readonly primary: { readonly id: string } },
  deps: RoutingDeps<TModel>,
  event?: unknown,
): Promise<TModel> {
  stampModelArm(null);
  let surfaceKey: string;
  let surfaceMatch: DomainMatch | undefined;
  try {
    const id = identityFromContext(ctx);
    surfaceKey = id.surfaceKey;
    surfaceMatch = id.surfaceMatch;
  } catch (err) {
    logOnce("warn", `primary: surface unbindable from ctx (${String(err)}) — default model, routing inactive`);
    stampModelCall(defaults.primary.id);
    return deps.backend.model(defaults.primary.id);
  }

  const supervisor = isSupervisorSession(ctx);
  let routineRole: ModelRole | undefined;
  try {
    const auth = ctx.session?.auth?.current ?? ctx.session?.auth?.initiator ?? undefined;
    routineRole = routineModelRoleStamped(auth?.attributes as Parameters<typeof routineModelRoleStamped>[0]);
  } catch (err) {
    logOnce("warn", `primary: routine model-role stamp unreadable (${String(err)}) — inherit`);
  }
  const effectiveRole: ModelRole = routineRole ?? (supervisor ? "supervisor" : "primary");
  let ab: ModelAbInput | undefined;
  try {
    const test = deps.modelAbTest?.();
    if (effectiveRole === "primary" && modelAbTestArmed(test)) ab = { test, bucketKey: abBucketKey(surfaceKey, abThreadKey(ctx)) };
  } catch (err) {
    logOnce("warn", `primary: model A/B test read failed (${String(err)}) — no arm`);
  }
  let route: ModelRoute;
  try {
    route =
      effectiveRole === "primary"
        ? await resolveRoute("primary", surfaceKey, surfaceMatch, defaults.primary.id, deps, undefined, ab)
        : await resolveRoute(effectiveRole, surfaceKey, surfaceMatch, defaults.primary.id, deps, "primary");
  } catch (err) {
    logOnce("warn", `primary: route resolution failed (${String(err)}) — default model`);
    stampModelCall(defaults.primary.id);
    return deps.backend.model(defaults.primary.id);
  }
  stampModelCall(route.id ?? defaults.primary.id);
  noteModelAbArm(ctx, readModelArm(), event);
  if (isNoOpRoute(route, defaults.primary.id)) return deps.backend.model(defaults.primary.id);
  return makeRoutedModel(() => route, defaults.primary, deps.backend);
}

export async function resolvePrimaryModel<TModel extends RoutableModel>(
  ctx: BindableContext,
  defaults: { readonly primary: { readonly id: string } },
  deps: RoutingDeps<TModel>,
  event?: unknown,
): Promise<TModel> {
  noteWakeAttachments((ctx as { messages?: unknown }).messages);
  const boundary = await noteTurnStep(ctx, event);
  const captureSite = captureArmed() ? captureSiteFrom(ctx, event) : undefined;
  const capturingDeps = withCapture(deps, captureSite);
  const retryingDeps = withStreamDropRetry(capturingDeps, currentWorkerWake());
  if (boundary.tier === "hard" || boundary.tier === "closed") {
    reportStepBoundary(ctx, boundary);
    noteUncalledModelStep(captureSite);
    stampModelCall(defaults.primary.id);
    return turnBackstopModel(deps.backend.model(defaults.primary.id), boundaryStopReply(boundary));
  }
  const routed = await resolveRoutedPrimaryModel(ctx, defaults, retryingDeps, event);
  if (boundary.tier !== "soft") return routed;
  reportStepBoundary(ctx, boundary);
  return withWrapUpNotice(routed, wrapUpNotice(boundary));
}


import {
  bindFrom,
  currentTurnIssue,
  currentTurnGithubTarget,
  currentTurnOrganization,
  type BindableContext,
} from "../identity/binding.js";
import { workDestinationPlatforms } from "./work-destinations.js";
import { registerWorkPlatform } from "./work-registry.js";
import type { Domain } from "../memory/domain.js";
import { admitProviderRegistration } from "../access/provider-selection.js";

export interface EntityRef {
  readonly platform: string;
  readonly id: string;
  readonly organizationId?: string;
}

export type EntityVerb = "setState" | "assign" | "addLabel";

export type EntityActionFn = (entityId: string, value: string, organizationId?: string) => Promise<string>;

export interface EntityActionAdapter {
  readonly platform: string;
  readonly workRole?: string;
  checkAccess?(ctx: BindableContext, entityId: string, domains: readonly Domain[]): void | Promise<void>;
  workspaceFor?(ctx: BindableContext): string | undefined;
  setState?: EntityActionFn;
  assign?: EntityActionFn;
  addLabel?: EntityActionFn;
}

const ENTITY_ACTION_ADAPTERS: Record<string, EntityActionAdapter> = {};

export function registerEntityActionAdapter(adapter: EntityActionAdapter): void {
  if (!admitProviderRegistration(adapter.platform, "entity-action-adapter")) return;
  ENTITY_ACTION_ADAPTERS[adapter.platform] = adapter;
  registerWorkPlatform(adapter.platform, adapter.workRole);
}

export function supportedEntityActionPlatforms(): readonly string[] {
  return Object.keys(ENTITY_ACTION_ADAPTERS);
}

function platformsSupporting(verb: EntityVerb): readonly string[] {
  return Object.values(ENTITY_ACTION_ADAPTERS)
    .filter((a) => typeof a[verb] === "function")
    .map((a) => a.platform);
}

export function entityActionFn(platform: string, verb: EntityVerb): EntityActionFn | undefined {
  return ENTITY_ACTION_ADAPTERS[platform]?.[verb];
}

export function currentTurnEntityRef(ctx: BindableContext): EntityRef | undefined {
  const binding = bindFrom(ctx);
  if (binding.platform === "linear") {
    const issue = currentTurnIssue(ctx);
    if (!issue) return undefined;
    const organizationId = currentTurnOrganization(ctx);
    return { platform: "linear", id: issue, ...(organizationId ? { organizationId } : {}) };
  }
  if (binding.platform === "github") {
    const t = currentTurnGithubTarget(ctx);
    return t ? { platform: "github", id: `${t.owner}/${t.repo}#${t.number}` } : undefined;
  }
  return undefined;
}

export interface ResolvedEntityAction {
  readonly ref: EntityRef;
  readonly run: (value: string) => Promise<string>;
}

export async function resolveEntityAction(
  ctx: BindableContext,
  verb: EntityVerb,
  explicitRef: EntityRef | undefined,
  domains: readonly Domain[],
): Promise<ResolvedEntityAction> {
  const ref = explicitRef ?? currentTurnEntityRef(ctx);
  if (!ref) {
    throw new Error(
      `${verb}: no ticket entity for this turn — pass \`ref\` explicitly ({ platform, id }), or call this from a turn on a ticketing entity (a Linear issue or a GitHub issue/PR). ` +
        `Chat surfaces (Slack, Discord, Teams) and Notion have no entity for this verb — not supported there.`,
    );
  }
  const destinations = workDestinationPlatforms(ctx, domains);
  if (!destinations.includes(ref.platform)) {
    throw new Error(
      `${verb}: "${ref.platform}" is not one of this session's work destinations (${destinations.join(", ") || "none"}) — ` +
        "the memory domain must hold a work credential for it (`credentials`). Talking on that platform does not grant mutating its tickets.",
    );
  }
  const adapter = ENTITY_ACTION_ADAPTERS[ref.platform];
  const fn = adapter?.[verb];
  if (!fn) {
    const supported = platformsSupporting(verb);
    throw new Error(
      `${verb} is not supported on "${ref.platform}" — entity-gated: ` +
        (supported.length ? `supported on ${supported.join(", ")}.` : "no surface supports it yet."),
    );
  }
  await adapter.checkAccess?.(ctx, ref.id, domains);
  const organizationId = ref.organizationId ?? adapter.workspaceFor?.(ctx);
  const resolved: EntityRef = organizationId ? { ...ref, organizationId } : ref;
  return { ref: resolved, run: (value: string) => fn(resolved.id, value, resolved.organizationId) };
}

import { githubEntityAdapter } from "../scm/issue-actions.js";

registerEntityActionAdapter(githubEntityAdapter);

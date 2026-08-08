import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionAuth } from "eve/context";
import { bindFrom, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { resolveAccessForWithGroups } from "./group-request.js";
import { assertConnectorDisclosure } from "./connector-disclosure.js";
import { resolvePartition } from "../memory/partition.js";
import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";

export class ConnectorScopeError extends Error {}

export const OE_CONNECTOR_DM_ONLY_ENV = "OE_CONNECTOR_DM_ONLY";

export function connectorDmOnlyEnabled(): boolean {
  const raw = process.env[OE_CONNECTOR_DM_ONLY_ENV];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === "") return true;
  return v !== "0" && v !== "false" && v !== "off";
}

interface ContextStore {
  get(key: unknown): unknown;
}
interface EveInternals {
  contextStorage: { getStore(): ContextStore | undefined };
  ChannelKey: unknown;
}

const EVE_INTERNAL_CONTAINER_REL = "dist/src/context/container.js";
const EVE_INTERNAL_RUNTIME_KEYS_REL = "dist/src/runtime/sessions/runtime-context-keys.js";

export function defaultEveRoot(): string {
  const req = createRequire(import.meta.url);
  return dirname(req.resolve("eve/package.json"));
}

export async function resolveEveInternalsFrom(root: string): Promise<EveInternals | null> {
  try {
    const abs = (rel: string) => pathToFileURL(join(root, rel)).href;
    const [container, runtimeKeys] = await Promise.all([
      import(abs(EVE_INTERNAL_CONTAINER_REL)),
      import(abs(EVE_INTERNAL_RUNTIME_KEYS_REL)),
    ]);
    if (!container?.contextStorage || !runtimeKeys?.ChannelKey) {
      internalsLoadError = "internal modules loaded but expected exports are missing";
      return null;
    }
    return { contextStorage: container.contextStorage, ChannelKey: runtimeKeys.ChannelKey };
  } catch (err) {
    internalsLoadError = String(err);
    return null;
  }
}

let internalsLoadError: string | undefined;

export type EveChannelReachStatus = "pending" | "available" | "unavailable";
let bootStatus: EveChannelReachStatus = "pending";
export function eveChannelReachStatus(): EveChannelReachStatus {
  return bootStatus;
}

export async function whenEveChannelReachSettled(): Promise<EveChannelReachStatus> {
  await internalsPromise;
  return bootStatus;
}

export async function resolveEveInternalsSafe(
  rootFn: () => string,
): Promise<EveInternals | null> {
  let root: string;
  try {
    root = rootFn();
  } catch (err) {
    internalsLoadError = String(err);
    return null;
  }
  return resolveEveInternalsFrom(root);
}

let internalsPromise: Promise<EveInternals | null> = resolveEveInternalsSafe(defaultEveRoot);
internalsPromise = internalsPromise.then((eve) => {
  bootStatus = eve ? "available" : "unavailable";
  console.warn(
    `[open-everywhere:connector-scope:boot] channel-kind ALS reach: ${bootStatus}` +
      (eve
        ? ""
        : ` — permanently falling back to inert channel-kind resolution for this process ` +
          `(${internalsLoadError ?? "unknown reason"}). This does NOT open the connector gate: ` +
          `assertConnectorGranted still fails closed on a missing auth identity; only the ` +
          `best-effort surface.channel.kind hint is unavailable (expected on some hosted builds — ` +
          `see this file's header).`),
  );
  return eve;
});

const loggedReasons = new Set<string>();
function logOnce(reason: string): void {
  if (!loggedReasons.has(reason)) {
    loggedReasons.add(reason);
    console.warn(`[open-everywhere:surface-context] ${reason}`);
  }
}

async function readChannelKind(): Promise<string | undefined> {
  const eve = await internalsPromise;
  if (!eve) return undefined;
  const store = eve.contextStorage.getStore();
  if (!store) {
    logOnce("channel kind unresolvable: no ALS store — outside an eve session scope (expected on a hosted build)");
    return undefined;
  }
  const channel = store.get(eve.ChannelKey) as { kind?: string } | undefined;
  return channel?.kind;
}

export async function surfaceContextFromAuth(auth: SessionAuth): Promise<BindableContext | null> {
  const current = auth.current ?? null;
  const initiator = auth.initiator ?? current;
  if (current === null && initiator === null) {
    logOnce("resolver ctx carried no auth identity (current/initiator both null) — fail closed");
    return null;
  }
  const kind = await readChannelKind();
  type SessionAuthShape = NonNullable<NonNullable<BindableContext["session"]>["auth"]>;
  return {
    session: { auth: { current, initiator } as SessionAuthShape },
    channel: { kind },
  } as BindableContext;
}

export function applyConnectorOverrides(
  base: readonly string[],
  overrides: readonly { connector: string; granted: boolean }[],
): string[] {
  const set = new Set(base);
  for (const o of overrides) {
    if (!o.granted) set.delete(o.connector);
  }
  return [...set].sort();
}

export async function grantedConnectors(auth: SessionAuth): Promise<readonly string[] | null> {
  const ctx = await surfaceContextFromAuth(auth);
  if (!ctx) return null;
  return grantedForCtx(ctx);
}

export async function narrowByConnectorOverride(
  ctx: BindableContext,
  base: readonly string[],
): Promise<readonly string[] | null> {
  try {
    const p = resolvePartition(ctx);
    const overrides = await getOperationalStore().connectorOverrides(p.org, p.surfaceKey);
    return overrides.length ? applyConnectorOverrides(base, overrides) : base;
  } catch (err) {
    console.warn(`[open-everywhere:connector-scope] override lookup failed; refusing (fail closed): ${String(err)}`);
    return null;
  }
}

async function grantedForCtx(ctx: BindableContext): Promise<readonly string[] | null> {
  try {
    const base = (await resolveAccessForWithGroups(ctx)).connectors;
    return await narrowByConnectorOverride(ctx, base);
  } catch {
    return null;
  }
}

export async function boundConnectorCredential(
  connection: string,
  auth: SessionAuth,
): Promise<import("./providers.js").ResolvedConnectorCredential | null> {
  const ctx = await surfaceContextFromAuth(auth);
  if (!ctx) return null;
  try {
    return (await resolveAccessForWithGroups(ctx)).connectorCredentials[connection] ?? null;
  } catch {
    return null;
  }
}

async function auditConnectorGate(
  ctx: BindableContext | null,
  action: "connector.refused" | "connector.use",
  detail: Readonly<Record<string, unknown>>,
): Promise<void> {
  let org = deploymentOrg();
  let platform = "unknown";
  let workspace = "unknown";
  let surface: string | undefined;
  let principalId: string | undefined;
  if (ctx) {
    try {
      const p = resolvePartition(ctx);
      org = p.org;
      platform = p.platform;
      workspace = p.workspace;
      surface = p.surface;
      principalId = bindFrom(ctx).principalId;
    } catch {
    }
  }
  await appendAudit({ org, platform, workspace, surface, principalId, action, detail });
}

export async function assertConnectorGranted(connectionName: string, auth: SessionAuth): Promise<void> {
  const ctx = await surfaceContextFromAuth(auth);
  const granted = ctx ? await grantedForCtx(ctx) : null;
  if (granted === null) {
    await auditConnectorGate(ctx, "connector.refused", { connection: connectionName, reason: "unresolved_surface" });
    throw new ConnectorScopeError(
      `connection "${connectionName}": refusing — could not resolve the calling surface ` +
        `(no auth identity on the resolver ctx). Fail closed.`,
    );
  }
  if (!granted.includes(connectionName)) {
    await auditConnectorGate(ctx, "connector.refused", { connection: connectionName, reason: "ungranted" });
    throw new ConnectorScopeError(
      `connection "${connectionName}" is not granted to this surface. ` +
        `Grant it with \`connectors: ["${connectionName}"]\` on a bundle bound to this scope ` +
        `(see agent/access/bundles.ts).`,
    );
  }
  let mode: string | undefined;
  try {
    mode = bindFrom(ctx as BindableContext).mode;
  } catch {
    mode = undefined;
  }
  if (connectorDmOnlyEnabled() && mode !== "dm") {
    await auditConnectorGate(ctx, "connector.refused", {
      connection: connectionName,
      reason: "dm_only",
      mode: mode ?? "unresolved",
    });
    throw new ConnectorScopeError(
      `connection "${connectionName}": refused — host-side connector operations are DM-only ` +
        `(this surface resolved mode "${mode ?? "unresolved"}", not a DM). This is a deployment ` +
        `rule enforced at the credential layer, not a permission that can be requested in-chat.`,
    );
  }
  await assertConnectorDisclosure(connectionName, ctx as BindableContext);

  await auditConnectorGate(ctx, "connector.use", {
    connection: connectionName,
    ...(mode !== undefined ? { mode } : {}),
  });
}

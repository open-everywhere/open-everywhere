import type { SessionAuth } from "eve/context";
import { joinConnectorOpTiers, effectiveConnectorOpTier } from "../access/connector-op-gating.js";
import { surfaceContextFromAuth } from "../access/connector-scope.js";
import { appendAudit } from "../audit/audit.js";
import { bindFrom, deploymentOrg, unattendedFrom, type BindableContext } from "../identity/binding.js";
import { classifyConnectorOpTier, parseQualifiedToolName } from "../access/consequence.js";
import { processRegistryMap } from "../lib/process-registry.js";
import { resolveDmPrincipal } from "./connector-auth.js";
import { connectorOpToolHints } from "./connector-tool-hints.js";

const PERSONAL_SURFACE_CONNECTIONS = processRegistryMap<string>("personal-surface-connections.v1");

export function declarePersonalSurfaceConnection(connector: string, platform: string): void {
  PERSONAL_SURFACE_CONNECTIONS.set(connector, platform);
}

export async function personalSurfaceApprovalRefusal(
  toolName: string,
  auth: SessionAuth | null | undefined,
  deps: PersonalSurfaceFenceDeps & PersonalSurfaceWriteDeps = {},
): Promise<string | undefined> {
  const connector = parseQualifiedToolName(toolName)?.connection;
  if (connector === undefined) return undefined;
  const platform = PERSONAL_SURFACE_CONNECTIONS.get(connector);
  if (platform === undefined) return undefined;
  return (await personalSurfaceRefusal(connector, platform, auth, deps)) ?? (await personalSurfaceUnattendedWriteRefusal(connector, toolName, auth, deps));
}

interface FenceSurface {
  readonly mode?: string;
  readonly platform?: string;
  readonly workspace?: string;
  readonly org?: string;
}

export interface PersonalSurfaceFenceDeps {
  readonly dmPrincipal?: (auth: SessionAuth) => Promise<FenceSurface>;
  readonly audit?: typeof appendAudit;
}

export async function personalSurfaceRefusal(
  connector: string,
  platform: string,
  auth: SessionAuth | null | undefined,
  deps: PersonalSurfaceFenceDeps = {},
): Promise<string | undefined> {
  const read = deps.dmPrincipal ?? resolveDmPrincipal;
  const surface: FenceSurface = auth === undefined || auth === null ? {} : await read(auth).catch((): FenceSurface => ({}));
  if (surface.mode === "dm" && surface.platform === platform) return undefined;
  try {
    await (deps.audit ?? appendAudit)({
      org: surface.org ?? deploymentOrg(),
      platform: surface.platform ?? "unknown",
      workspace: surface.workspace ?? "unknown",
      action: "connector.refused",
      detail: { connection: connector, reason: "personal_surface", mode: surface.mode ?? "unresolved", requires: `${platform} dm` },
    });
  } catch {
  }
  return (
    `connection "${connector}" acts as one person's own ${platform} account, so it answers only in that person's 1:1 DM ` +
    `on ${platform}. This call came from ${describe(surface)}, so it did not run. Ask in your own ${platform} DM with me.`
  );
}

function describe(surface: FenceSurface): string {
  if (surface.mode === undefined) return "a surface this fence could not read";
  const where = surface.mode === "dm" ? "a DM" : surface.mode === "mpim" ? "a group DM" : "a channel";
  return surface.platform === undefined ? where : `${where} on ${surface.platform}`;
}

export interface PersonalSurfaceWriteDeps {
  readonly attended?: (auth: SessionAuth) => Promise<boolean | undefined>;
  readonly toolHints?: typeof connectorOpToolHints;
  readonly audit?: typeof appendAudit;
}

export async function personalSurfaceUnattendedWriteRefusal(
  connector: string,
  toolName: string,
  auth: SessionAuth | null | undefined,
  deps: PersonalSurfaceWriteDeps = {},
): Promise<string | undefined> {
  const hints = await (deps.toolHints ?? connectorOpToolHints)(toolName).catch(() => undefined);
  const tier = joinConnectorOpTiers(classifyConnectorOpTier(toolName, hints), effectiveConnectorOpTier(toolName, undefined, hints));
  if (tier === "read") return undefined;
  const attended = auth === undefined || auth === null ? undefined : await (deps.attended ?? attendedTurn)(auth).catch(() => undefined);
  if (attended === true) return undefined;
  try {
    await (deps.audit ?? appendAudit)({
      org: deploymentOrg(),
      platform: "unknown",
      workspace: "unknown",
      action: "connector.refused",
      detail: { connection: connector, op: toolName, tier, reason: "personal_surface_unattended" },
    });
  } catch {
  }
  return (
    `connection "${connector}" acts as one person's own account, and "${toolName}" writes in their name. A write as ` +
    `the person needs the person to approve its card, and nobody is here to approve it on this turn (a routine's ` +
    `fire), so it did not run. A routine permission does not lift it.`
  );
}

async function attendedTurn(auth: SessionAuth): Promise<boolean | undefined> {
  const ctx: BindableContext | null = await surfaceContextFromAuth(auth).catch(() => null);
  if (ctx === null) return undefined;
  try {
    // principal-gate: presence — a write as the person needs the person here to answer its card. `unattendedFrom` is
    return !unattendedFrom(bindFrom(ctx));
  } catch {
    return undefined;
  }
}

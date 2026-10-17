import { appendAudit } from "../audit/audit.js";
import { auditSurfaceModeStamp, bindFrom, deploymentOrg, type BindableContext } from "../identity/binding.js";
import type { SessionMode } from "./resolver.js";
import { resolvePartition } from "../memory/partition.js";
import { ConfigLoadRefusalError, configOrRefuse } from "./config.js";
import type { Domain } from "../memory/domain.js";
import { governanceAdminSet, resolveAudienceFloor, rosterState, type AudienceFloor, type RoomRoster } from "./audience-floor.js";
import { PaneRedirectError } from "./pane-venue.js";

export type ConnectorDisclosureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "audience-floor"; readonly floor: AudienceFloor }
  | { readonly ok: false; readonly reason: "audience-unverified" };

export interface ConnectorDisclosureInput {
  readonly floor: AudienceFloor;
  readonly roster: RoomRoster;
}

export function classifyConnectorDisclosure(input: ConnectorDisclosureInput): ConnectorDisclosureVerdict {
  if (input.roster.resolved && input.floor === "guest") {
    return { ok: false, reason: "audience-floor", floor: input.floor };
  }
  if (rosterState(input.roster) === "failed") return { ok: false, reason: "audience-unverified" };
  return { ok: true };
}

function domainsOrNull(): readonly Domain[] | null {
  return configOrRefuse("connector disclosure", (config) => config.loadDomains()) ?? null;
}

async function auditDisclosure(
  ctx: BindableContext,
  action: "connector.refused" | "governance.redirected",
  detail: Readonly<Record<string, unknown>>,
): Promise<void> {
  let org = deploymentOrg();
  let platform = "unknown";
  let workspace = "unknown";
  let surface: string | undefined;
  let principalId: string | undefined;
  let surfaceMode: SessionMode | undefined;
  try {
    const p = resolvePartition(ctx);
    org = p.org;
    platform = p.platform;
    workspace = p.workspace;
    surface = p.surface;
    const binding = bindFrom(ctx);
    principalId = binding.principalId;
    surfaceMode = auditSurfaceModeStamp(binding).surfaceMode;
  } catch {
  }
  await appendAudit({ org, platform, workspace, surface, ...(surfaceMode === undefined ? {} : { surfaceMode }), principalId, action, detail });
}

export class ConnectorAudienceUnverifiedError extends Error {
  readonly reason = "audience-unverified" as const;
  constructor(message: string) {
    super(message);
    this.name = "ConnectorAudienceUnverifiedError";
  }
}

export async function assertConnectorDisclosure(connection: string, ctx: BindableContext): Promise<void> {
  let domains: readonly Domain[] | null;
  try {
    domains = domainsOrNull();
  } catch (err) {
    if (err instanceof ConfigLoadRefusalError) {
      await auditDisclosure(ctx, "connector.refused", { connection, reason: "config_unavailable" }).catch(() => undefined);
    }
    throw err;
  }
  if (!domains) return;

  let channelKey: string | undefined;
  try {
    channelKey = resolvePartition(ctx).surfaceKey;
  } catch {
  }

  const resolution = channelKey
    ? await resolveAudienceFloor(channelKey, governanceAdminSet(channelKey, domains))
    : { floor: "guest" as AudienceFloor, roster: { humanMemberIds: [], resolved: false, isPrivate: false, hasGuest: false } };

  const verdict = classifyConnectorDisclosure({
    floor: resolution.floor,
    roster: resolution.roster,
  });
  if (verdict.ok) return;

  if (verdict.reason === "audience-floor") {
    await auditDisclosure(ctx, "connector.refused", {
      connection,
      reason: "audience_floor",
      floor: verdict.floor,
      ...(channelKey ? { from: channelKey } : {}),
    });
    await auditDisclosure(ctx, "governance.redirected", {
      kind: "connector.read",
      connection,
      to: "requester-dm",
      ...(channelKey ? { from: channelKey } : {}),
      floorBreach: "guest-present",
    });
    throw new PaneRedirectError(
      `connection "${connection}": this room's audience floor resolved to "guest" — it is externally shared, ` +
        `or carries an observed guest/external member — so org-internal connector data ` +
        `can't be disclosed here. Deliver the answer view-only in the requester's DM instead and reply here ` +
        `only with a pointer ("I've sent it to you directly"). Do NOT render any of the substance in this ` +
        `channel — partial disclosure is still disclosure.`,
      "requester-dm",
    );
  }

  if (verdict.reason === "audience-unverified") {
    await auditDisclosure(ctx, "connector.refused", {
      connection,
      reason: "audience_unverified",
      ...(channelKey ? { from: channelKey } : {}),
    });
    throw new ConnectorAudienceUnverifiedError(
      `connection "${connection}": refused — I couldn't read who is in this room just now (the platform's ` +
        `membership read failed), so I can't confirm the room is not externally shared. Org-internal ` +
        `connector data stays withheld until the membership read succeeds. Tell the requester to ask again ` +
        `in about 30 seconds. Do NOT answer from earlier connector results in the meantime.`,
    );
  }
}

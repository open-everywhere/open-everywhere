import { appendAudit } from "../audit/audit.js";
import { bindFrom, currentTurnAddressing, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { ConfigLoadRefusalError, configOrRefuse } from "./config.js";
import { requestorEntitlementChecksEnabled, type Domain } from "../memory/domain.js";
import { governanceAdminSet, resolveAudienceFloor, rosterState, type AudienceFloor, type RoomRoster } from "./audience-floor.js";
import { PaneRedirectError } from "./pane-venue.js";

export type ConnectorDisclosureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "audience-floor"; readonly floor: AudienceFloor }
  | { readonly ok: false; readonly reason: "audience-unverified" }
  | { readonly ok: false; readonly reason: "requestor-unentitled" }
  | { readonly ok: false; readonly reason: "entitlement-unavailable"; readonly detail: string };

export interface ConnectorDisclosureInput {
  readonly floor: AudienceFloor;
  readonly roster: RoomRoster;
  readonly complianceMode: boolean;
  readonly directAddressed: boolean;
  readonly entitled?: boolean;
  readonly entitlementDetail?: string;
  readonly opTier?: "read" | "write" | "destructive";
}

export function classifyConnectorDisclosure(input: ConnectorDisclosureInput): ConnectorDisclosureVerdict {
  if (input.roster.resolved && input.floor === "guest") {
    return { ok: false, reason: "audience-floor", floor: input.floor };
  }
  if (rosterState(input.roster) === "failed") return { ok: false, reason: "audience-unverified" };
  if (!input.complianceMode || !input.directAddressed) return { ok: true };
  if (input.entitled === true) return { ok: true };
  if (input.entitled === false) return { ok: false, reason: "requestor-unentitled" };
  return {
    ok: false,
    reason: "entitlement-unavailable",
    detail: input.entitlementDetail ?? "no entitlement signal available",
  };
}

export type ConnectorEntitlementProbe = (input: {
  readonly connection: string;
  readonly principalId: string;
  readonly ctx: BindableContext;
}) => Promise<boolean | undefined>;

let probe: ConnectorEntitlementProbe | null = null;

export function registerConnectorEntitlementProbe(fn: ConnectorEntitlementProbe): void {
  probe = fn;
}

export function _resetConnectorEntitlementProbeForTest(): void {
  probe = null;
}

function connectorEntitlementProbe(): ConnectorEntitlementProbe | null {
  return probe;
}

export class ConnectorEntitlementError extends Error {
  readonly reason: "requestor-unentitled" | "entitlement-unavailable";
  constructor(message: string, reason: "requestor-unentitled" | "entitlement-unavailable") {
    super(message);
    this.name = "ConnectorEntitlementError";
    this.reason = reason;
  }
}

function domainsOrNull(): readonly Domain[] | null {
  return configOrRefuse("connector disclosure", (config) => config.loadDomains()) ?? null;
}

function isDirectAddressed(ctx: BindableContext, mode: string | undefined): boolean {
  if (mode === "dm") return true;
  const addressing = currentTurnAddressing(ctx);
  return typeof addressing === "string" && addressing.length > 0;
}

async function auditDisclosure(
  ctx: BindableContext,
  action: "connector.refused" | "connector.entitlement_check" | "governance.redirected",
  detail: Readonly<Record<string, unknown>>,
): Promise<void> {
  let org = deploymentOrg();
  let platform = "unknown";
  let workspace = "unknown";
  let surface: string | undefined;
  let principalId: string | undefined;
  try {
    const p = resolvePartition(ctx);
    org = p.org;
    platform = p.platform;
    workspace = p.workspace;
    surface = p.surface;
    principalId = bindFrom(ctx).principalId;
  } catch {
  }
  await appendAudit({ org, platform, workspace, surface, principalId, action, detail });
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

  let mode: string | undefined;
  let principalId: string | undefined;
  try {
    const b = bindFrom(ctx);
    mode = b.mode;
    principalId = b.principalId;
  } catch {
  }

  let channelKey: string | undefined;
  try {
    channelKey = resolvePartition(ctx).surfaceKey;
  } catch {
  }

  const resolution = channelKey
    ? await resolveAudienceFloor(channelKey, governanceAdminSet(channelKey, domains))
    : { floor: "guest" as AudienceFloor, roster: { humanMemberIds: [], resolved: false, isPrivate: false, hasGuest: false } };

  const complianceMode = requestorEntitlementChecksEnabled(domains);
  const directAddressed = isDirectAddressed(ctx, mode);

  let entitled: boolean | undefined;
  let entitlementDetail: string | undefined;
  if (complianceMode && directAddressed) {
    const fn = connectorEntitlementProbe();
    if (!fn) {
      entitlementDetail = "no entitlement probe is registered for this deployment";
    } else if (!principalId) {
      entitlementDetail = "this turn has no verified requestor identity";
    } else {
      try {
        entitled = await fn({ connection, principalId, ctx });
        if (entitled === undefined) entitlementDetail = "the system of record could not answer the entitlement question";
      } catch (err) {
        entitlementDetail = `the entitlement probe failed: ${String(err).slice(0, 160)}`;
      }
    }
  }

  const verdict = classifyConnectorDisclosure({
    floor: resolution.floor,
    roster: resolution.roster,
    complianceMode,
    directAddressed,
    entitled,
    entitlementDetail,
  });

  if (verdict.ok) {
    if (complianceMode && directAddressed) {
      await auditDisclosure(ctx, "connector.entitlement_check", { connection, verdict: "allow", floor: resolution.floor });
    }
    return;
  }

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

  await auditDisclosure(ctx, "connector.refused", {
    connection,
    reason: verdict.reason === "requestor-unentitled" ? "requestor_unentitled" : "entitlement_unavailable",
    ...(verdict.reason === "entitlement-unavailable" ? { detail: verdict.detail } : {}),
  });
  throw new ConnectorEntitlementError(
    verdict.reason === "requestor-unentitled"
      ? `connection "${connection}": refused — this org runs requestor-entitlement compliance mode, and the ` +
          `person who asked is not entitled to this resource in the system of record. This is a deployment ` +
          `rule enforced at the credential layer, not a permission that can be requested in-chat.`
      : `connection "${connection}": refused — this org runs requestor-entitlement compliance mode, but ` +
          `${verdict.detail}. Compliance mode fails CLOSED: it never allows on an unverifiable entitlement. ` +
          `An operator must register a connector entitlement probe (access/connector-disclosure.ts ` +
          `registerConnectorEntitlementProbe) or turn requestorEntitlementChecks off on the org domain.`,
    verdict.reason,
  );
}

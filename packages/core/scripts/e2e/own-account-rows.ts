import type { CredentialGrantFamily } from "../../agent/access/connector-credentials.js";
import { CONNECTOR_OWN_ACCOUNT_ASK_ACTION } from "../../agent/connections/own-account-ask.js";
import { CONNECTOR_ACTING_IDENTITY_ACTION } from "../../agent/connections/own-account-gate.js";
import type { AuditWireEntry } from "./audit-read.js";

export { CONNECTOR_ACTING_IDENTITY_ACTION, CONNECTOR_OWN_ACCOUNT_ASK_ACTION };

export const INSTALL_IDENTITY: CredentialGrantFamily = "install";
export const HUMAN_ACTING_IDENTITY: CredentialGrantFamily = "human-acting";

export interface ActingIdentityRow {
  readonly ts: string;
  readonly platform: string;
  readonly surface?: string;
  readonly connector: string;
  readonly tool: string;
  readonly reason: string;
  readonly refused: boolean;
  readonly requiredIdentity: string;
  readonly askRecognised: boolean;
  readonly identity?: string;
}

export interface ActingIdentityRead {
  readonly rows: readonly ActingIdentityRow[];
  readonly undecodable: number;
  readonly actionsSeen: readonly string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function decodeRow(entry: AuditWireEntry, connector: string): ActingIdentityRow | undefined {
  const d = entry.detail;
  if (d === undefined) return undefined;
  if (str(d.connector) !== connector) return undefined;
  const tool = str(d.tool);
  const reason = str(d.reason);
  const requiredIdentity = str(d.requiredIdentity);
  if (tool === undefined || reason === undefined || requiredIdentity === undefined) return undefined;
  if (typeof d.refused !== "boolean" || typeof d.askRecognised !== "boolean") return undefined;
  const identity = str(d.identity);
  return {
    askRecognised: d.askRecognised,
    connector,
    platform: entry.platform,
    reason,
    refused: d.refused,
    requiredIdentity,
    ts: entry.ts,
    tool,
    ...(entry.surface === undefined ? {} : { surface: entry.surface }),
    ...(identity === undefined ? {} : { identity }),
  };
}

export function actingIdentityRead(rows: readonly AuditWireEntry[], connector: string): ActingIdentityRead {
  const mine = rows.filter((r) => r.action === CONNECTOR_ACTING_IDENTITY_ACTION && str(r.detail?.connector) === connector);
  const decoded: ActingIdentityRow[] = [];
  let undecodable = 0;
  for (const entry of mine) {
    const row = decodeRow(entry, connector);
    if (row === undefined) undecodable += 1;
    else decoded.push(row);
  }
  return { actionsSeen: [...new Set(rows.map((r) => r.action))].sort(), rows: decoded, undecodable };
}

export function ownAccountRefusals(read: ActingIdentityRead): readonly ActingIdentityRow[] {
  return read.rows.filter((r) => r.refused && r.requiredIdentity === HUMAN_ACTING_IDENTITY && r.askRecognised);
}

export function isOrdinaryInstallRead(row: ActingIdentityRow): boolean {
  return !row.refused && !row.askRecognised && row.identity === INSTALL_IDENTITY && row.requiredIdentity === INSTALL_IDENTITY;
}

export function installReads(read: ActingIdentityRead): readonly ActingIdentityRow[] {
  return read.rows.filter(isOrdinaryInstallRead);
}

export function allOrdinaryInstallReads(read: ActingIdentityRead): boolean {
  return read.rows.length > 0 && read.undecodable === 0 && read.rows.every(isOrdinaryInstallRead);
}

export interface OwnAccountAskRow {
  readonly ts: string;
  readonly platform: string;
  readonly surface?: string;
  readonly connector: string;
  readonly outcome: string;
  readonly requiredIdentity: string;
  readonly stamped: boolean;
}

export function ownAccountAskRows(rows: readonly AuditWireEntry[], connector: string): readonly OwnAccountAskRow[] {
  const out: OwnAccountAskRow[] = [];
  for (const entry of rows) {
    if (entry.action !== CONNECTOR_OWN_ACCOUNT_ASK_ACTION) continue;
    const d = entry.detail;
    if (d === undefined) continue;
    if (str(d.connector) !== connector) continue;
    const outcome = str(d.outcome);
    const requiredIdentity = str(d.requiredIdentity);
    if (outcome === undefined || requiredIdentity === undefined) continue;
    if (d.askRecognised !== true) continue;
    if (typeof d.stamped !== "boolean") continue;
    out.push({
      connector,
      outcome,
      platform: entry.platform,
      requiredIdentity,
      stamped: d.stamped,
      ts: entry.ts,
      ...(entry.surface === undefined ? {} : { surface: entry.surface }),
    });
  }
  return out;
}

export function renderOwnAccountAskRows(rows: readonly OwnAccountAskRow[]): string {
  if (rows.length === 0) return `no ${CONNECTOR_OWN_ACCOUNT_ASK_ACTION} row`;
  return `${rows.length} row(s) — ${rows.map((r) => `outcome=${r.outcome} required=${r.requiredIdentity} stamped=${r.stamped}`).join("; ")}`;
}

export function renderActingIdentityRead(read: ActingIdentityRead): string {
  if (read.rows.length === 0 && read.undecodable === 0) {
    return `no ${CONNECTOR_ACTING_IDENTITY_ACTION} row at all (actions on the window: ${read.actionsSeen.join(", ") || "none"})`;
  }
  const each = read.rows
    .map((r) => `${r.tool}: refused=${r.refused} required=${r.requiredIdentity} identity=${r.identity ?? "none"} ask=${r.askRecognised} reason=${r.reason}`)
    .join("; ");
  const bad = read.undecodable > 0 ? `; ${read.undecodable} row(s) carried the action but not the detail shape this reader decodes` : "";
  return `${read.rows.length} row(s) — ${each || "none decodable"}${bad}`;
}

export const GRANT_LIFECYCLE_ACTIONS: readonly string[] = ["grant.granted", "grant.revoked", "grant.used"];

export const GRANT_LIFECYCLE_ROW_LIMIT = 1000;

export const GRANT_OVERLAP_LOOKBACK_DAYS = 30;

export const GRANT_USE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export interface ActiveStandingGrant {
  readonly grantId: string;
  readonly resource: string;
  readonly scopeKey?: string;
  readonly verb?: string;
  readonly evidence: "granted" | "used";
  readonly at: string;
}

function grantDetail(entry: AuditWireEntry): Readonly<Record<string, unknown>> {
  return entry.detail ?? {};
}

export function activeStandingGrants(rows: readonly AuditWireEntry[], opts: { readonly connector: string; readonly nowMs: number }): readonly ActiveStandingGrant[] {
  const revoked = new Set(rows.filter((r) => r.action === "grant.revoked").flatMap((r) => (str(grantDetail(r).grantId) === undefined ? [] : [str(grantDetail(r).grantId)!])));
  const mine = (entry: AuditWireEntry): boolean => str(grantDetail(entry).connector) === opts.connector && str(grantDetail(entry).mode) === "standing";
  const describe = (entry: AuditWireEntry, evidence: "granted" | "used", grantId: string): ActiveStandingGrant => {
    const d = grantDetail(entry);
    const scopeKey = str(d.scopeKey);
    const verb = str(d.verb);
    return {
      at: entry.ts,
      evidence,
      grantId,
      resource: str(d.resource) ?? "unnamed",
      ...(scopeKey === undefined ? {} : { scopeKey }),
      ...(verb === undefined ? {} : { verb }),
    };
  };
  const out: ActiveStandingGrant[] = [];
  const minted = new Set<string>();
  for (const entry of rows) {
    if (entry.action !== "grant.granted" || !mine(entry)) continue;
    const grantId = str(grantDetail(entry).grantId);
    if (grantId === undefined) continue;
    minted.add(grantId);
    if (revoked.has(grantId)) continue;
    const expiresAt = str(grantDetail(entry).expiresAt);
    const ms = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
    if (!Number.isFinite(ms) || ms <= opts.nowMs) continue;
    out.push(describe(entry, "granted", grantId));
  }
  const seen = new Set(out.map((g) => g.grantId));
  for (const entry of rows) {
    if (entry.action !== "grant.used" || !mine(entry)) continue;
    const grantId = str(grantDetail(entry).grantId);
    if (grantId === undefined || revoked.has(grantId) || minted.has(grantId) || seen.has(grantId)) continue;
    const usedMs = Date.parse(entry.ts);
    if (!Number.isFinite(usedMs) || opts.nowMs - usedMs > GRANT_USE_FRESHNESS_MS) continue;
    seen.add(grantId);
    out.push(describe(entry, "used", grantId));
  }
  return out;
}

export interface GrantOverlapInput {
  readonly legPageId: string;
  readonly pinnedPageIds: readonly string[];
  readonly connector: string;
  readonly nowMs: number;
  readonly rowLimit: number;
}

export type GrantOverlapVerdict = { readonly kind: "proceed" | "red"; readonly reason: string };

function renderGrants(grants: readonly ActiveStandingGrant[]): string {
  return grants.map((g) => `${g.grantId} (resource=${g.resource}, scope=${g.scopeKey ?? "none"}, verb=${g.verb ?? "none"}, from the ${g.evidence} row at ${g.at})`).join("; ");
}

export function grantOverlapVerdict(rows: readonly AuditWireEntry[], input: GrantOverlapInput): GrantOverlapVerdict {
  const grants = activeStandingGrants(rows, { connector: input.connector, nowMs: input.nowMs });
  const pinnedHere = input.pinnedPageIds.includes(input.legPageId);
  const limit =
    `LIMIT: the audit wire carries a grant's argument NAMES and never their values (\`grantAuditResource\`), so which page any of these grants pins ` +
    `is NOT readable here — only which page this pack itself asks a grant to pin. A grant somebody ELSE froze on this leg's page stays invisible, and ` +
    `arm 1's own named skip is what catches that shape.`;
  const truncated = rows.length >= input.rowLimit ? ` The read came back AT its ${input.rowLimit}-row ceiling, so it was truncated and an older live mint may sit behind it.` : "";
  if (grants.length === 0) {
    return {
      kind: "proceed",
      reason:
        `preflight: no LIVE standing ${input.connector} credential grant on the ${rows.length}-row lookback window, so nothing the harness can see ` +
        `pre-empts this leg's ordinary read.${truncated} Page ${input.legPageId}` +
        `${pinnedHere ? " IS the page this pack's own grant legs pin — it carries no live grant today, and a tap in a later board reds this preflight" : ""}. ${limit}`,
    };
  }
  if (pinnedHere) {
    return {
      kind: "red",
      reason:
        `preflight: the leg's page must not be the page this pack's own grant legs pin while a grant of that shape is live, and it is. Page ` +
        `${input.legPageId} is the page \`grantAskPageId()\` names as a grant's frozen argument, and ${grants.length} LIVE standing ${input.connector} ` +
        `grant(s) sit on the lookback window: ${renderGrants(grants)}. A live standing grant of that shape answers a read of that page over the BORROWED ` +
        `personal road — neither the connector tool road nor the REST road — so no ${CONNECTOR_ACTING_IDENTITY_ACTION} row is written and this leg's gate ` +
        `never runs (OPE-1984, measured on two live runs). This preflight cannot confirm which page these particular grants pin; it does not have ` +
        `to, because the page is one the pack itself asks to be pinned. Give the leg a page of its own, and never the page the grant ask names. ${limit}`,
    };
  }
  return {
    kind: "proceed",
    reason:
      `preflight: this leg's page is not one this pack asks a grant to pin. Page ${input.legPageId} is none of the ${input.pinnedPageIds.length} ` +
      `page(s) \`grantAskPageId()\` names, so no overlap the harness can see stands between this leg and the org road — though ${grants.length} live ` +
      `standing ${input.connector} grant(s) do sit on the window (${renderGrants(grants)}).${truncated} Whether any of them is frozen on THIS page is ` +
      `not something this check settles. ${limit}`,
  };
}

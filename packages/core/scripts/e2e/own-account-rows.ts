import type { CredentialGrantFamily } from "../../agent/access/connector-credentials.js";
import { CONNECTOR_ACTING_IDENTITY_ACTION } from "../../agent/connections/own-account-gate.js";
import type { AuditWireEntry } from "./audit-read.js";

export { CONNECTOR_ACTING_IDENTITY_ACTION };

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

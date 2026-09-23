import type { AuditQueryOpts, AuditWireEntry } from "./audit-read.js";

export const CONNECTOR_MINT_ACTION = "connector.mint";

export const ARMING_QUERY_LIMIT = 1000;

export type ConnectorArming =
  | { readonly state: "armed"; readonly at: string }
  | { readonly state: "unconsented"; readonly at: string; readonly name?: string }
  | { readonly state: "unknown"; readonly reason: string };

function mintDetail(e: AuditWireEntry): { connector?: string; subject?: string; outcome?: string; name?: string } {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  return {
    ...(typeof d.connector === "string" ? { connector: d.connector } : {}),
    ...(typeof d.subject === "string" ? { subject: d.subject } : {}),
    ...(typeof d.outcome === "string" ? { outcome: d.outcome } : {}),
    ...(typeof d.name === "string" ? { name: d.name } : {}),
  };
}

function tsKey(e: AuditWireEntry): number {
  const ms = Date.parse(e.ts);
  return Number.isNaN(ms) ? 0 : ms;
}

export function classifyMintRows(rows: readonly AuditWireEntry[], connector: string): ConnectorArming {
  const mine = rows
    .filter((e) => e.action === CONNECTOR_MINT_ACTION)
    .map((e) => ({ row: e, detail: mintDetail(e) }))
    .filter((r) => r.detail.connector === connector && r.detail.subject === "user");
  if (mine.length === 0)
    return { state: "unknown", reason: `no ${CONNECTOR_MINT_ACTION} row for connector "${connector}" (subject=user) in the window` };
  let newest = mine[0];
  for (const r of mine) if (tsKey(r.row) > tsKey(newest.row)) newest = r;
  const { outcome, name } = newest.detail;
  if (outcome === "ok") return { state: "armed", at: newest.row.ts };
  if (outcome === "auth-required") return { state: "unconsented", at: newest.row.ts, ...(name ? { name } : {}) };
  return {
    state: "unknown",
    reason: `newest ${CONNECTOR_MINT_ACTION} for "${connector}" at ${newest.row.ts} has outcome=${outcome ?? "absent"} — not evidence about consent`,
  };
}

export function lookbackIso(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function armingNote(connector: string, arming: ConnectorArming): string {
  switch (arming.state) {
    case "armed":
      return `${connector}: ARMED — the deployment's newest personal ${CONNECTOR_MINT_ACTION} succeeded at ${arming.at}`;
    case "unconsented":
      return (
        `${connector}: NOT ARMED on this deploy — the deployment's newest personal ${CONNECTOR_MINT_ACTION} answered ` +
        `outcome=auth-required at ${arming.at}${arming.name ? ` (${arming.name})` : ""}. ` +
        `The grant is absent or lapsed, so a refusal is the CORRECT product answer and this leg cannot assert anything. ` +
        `Re-do the one-time consent click for the driver account, then re-run — no env var arms this.`
      );
    case "unknown":
      return `${connector}: arming UNKNOWN — ${arming.reason}`;
  }
}

export type AuditReader = (opts: AuditQueryOpts) => Promise<readonly AuditWireEntry[]>;

export async function deriveConnectorArming(
  auditRead: AuditReader | undefined,
  opts: { readonly connector: string; readonly sinceIso: string; readonly limit?: number },
): Promise<ConnectorArming> {
  if (!auditRead) return { state: "unknown", reason: "no audit reader (set E2E_TARGET_URL + E2E_CONTROL_READ_TOKEN)" };
  try {
    const rows = await auditRead({ sinceIso: opts.sinceIso, actions: [CONNECTOR_MINT_ACTION], limit: opts.limit ?? ARMING_QUERY_LIMIT });
    return classifyMintRows(rows, opts.connector);
  } catch (e) {
    return { state: "unknown", reason: `audit read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export interface ArmingProbe {
  readonly auditRead?: AuditReader;
  readonly log: (msg: string) => void;
  readonly skip: (reason: string) => never;
}

export async function requireConnectorArmed(
  probe: ArmingProbe,
  opts: { readonly connector: string; readonly sinceIso: string; readonly limit?: number },
): Promise<ConnectorArming> {
  const arming = await deriveConnectorArming(probe.auditRead, opts);
  if (arming.state === "unconsented") probe.skip(armingNote(opts.connector, arming));
  probe.log(armingNote(opts.connector, arming));
  return arming;
}

export const ARMING_ADVISORY_LOOKBACK_DAYS = 14;

export interface ConnectorArmingWatch {
  readonly since: string;
  readonly recheck: () => Promise<ConnectorArming>;
}

export async function watchConnectorArming(probe: ArmingProbe, connector: string): Promise<ConnectorArmingWatch> {
  if (!probe.auditRead)
    probe.skip(
      `needs E2E_TARGET_URL + E2E_CONTROL_READ_TOKEN — the deployment's own ${CONNECTOR_MINT_ACTION} rows are the only honest evidence that the "${connector}" personal grant is consented, and no arming env var replaces them (OPE-894)`,
    );
  const since = new Date().toISOString();
  probe.log(
    `advisory (as of ${since}, before this leg drives — recheck() below is decisive) · ` +
      `${armingNote(connector, await deriveConnectorArming(probe.auditRead, { connector, sinceIso: lookbackIso(ARMING_ADVISORY_LOOKBACK_DAYS) }))}`,
  );
  return { since, recheck: () => requireConnectorArmed(probe, { connector, sinceIso: since }) };
}

export const CREDENTIAL_BOUND_ACTION = "connector.credential_bound";

export const CREDENTIAL_BOUND_ROWS_SINCE = "2026-09-18T00:00:00.000Z";

export type OrgConsent =
  | { readonly state: "bound"; readonly at: string }
  | { readonly state: "absent" }
  | { readonly state: "unknown"; readonly reason: string };

export function classifyOrgConsentRows(rows: readonly AuditWireEntry[], oauthHome: string): OrgConsent {
  let newest: AuditWireEntry | undefined;
  for (const e of rows) {
    if (e.action !== CREDENTIAL_BOUND_ACTION) continue;
    const d = (e.detail ?? {}) as Record<string, unknown>;
    if (d.connector !== oauthHome || d.subject !== "app") continue;
    if (newest === undefined || tsKey(e) > tsKey(newest)) newest = e;
  }
  return newest === undefined ? { state: "absent" } : { state: "bound", at: newest.ts };
}

export async function deriveOrgConsent(
  auditRead: AuditReader | undefined,
  opts: { readonly oauthHome: string; readonly sinceIso?: string },
): Promise<OrgConsent> {
  if (!auditRead) return { state: "unknown", reason: "no audit reader (set E2E_TARGET_URL + E2E_CONTROL_READ_TOKEN)" };
  try {
    const rows = await auditRead({ sinceIso: opts.sinceIso ?? CREDENTIAL_BOUND_ROWS_SINCE, actions: [CREDENTIAL_BOUND_ACTION], limit: ARMING_QUERY_LIMIT });
    return classifyOrgConsentRows(rows, opts.oauthHome);
  } catch (e) {
    return { state: "unknown", reason: `audit read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function orgConsentMissingReason(connector: string, oauthHome: string): string {
  return (
    `RED-until-fixture: no ORG (subject=app) ${connector} token exists for ${oauthHome} — the deployment holds no ${CREDENTIAL_BOUND_ACTION} ` +
    `row with subject=app for it, so every unattended fire fails with OeOauthNeedsConsentError before any connector op runs. ` +
    `The one action: an org admin asks the bot "connect ${connector} here" in the fixture channel and completes the ${connector === "notion" ? "Notion" : connector} consent. ` +
    `(A consent completed before ${CREDENTIAL_BOUND_ROWS_SINCE.slice(0, 10)} left no row — consent again; a rebind is harmless.)`
  );
}

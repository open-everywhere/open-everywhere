import { getOperationalStore } from "../operational/provider.js";
import type { AuditChainRow } from "../operational/store.js";
import { getSettings, type AuditExportFormat, type AuditExportTarget } from "../settings/settings.js";
import { getOperatorSecret } from "../credentials/operator-secrets.js";
import { auditRowSha } from "./chain.js";

const AUDIT_EXPORT_SCHEMA = "oe.audit.v1";
export const AUDIT_EXPORT_BATCH = 200;
const AUDIT_EXPORT_MAX_PAGES = 10;
export const SETTLE_MS = 30_000;
const POST_TIMEOUT_MS = 15_000;
const SERVICE = "open-everywhere";

export interface ExportedAuditRecord {
  readonly schema: typeof AUDIT_EXPORT_SCHEMA;
  readonly service: string;
  readonly seq: number;
  readonly org: string;
  readonly ts: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly surfaceMode?: string;
  readonly principalId?: string;
  readonly action: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly prevSha: string | null;
  readonly sha: string;
}

export function exportedRecord(row: AuditChainRow): ExportedAuditRecord {
  return {
    schema: AUDIT_EXPORT_SCHEMA,
    service: SERVICE,
    seq: row.seq,
    org: row.org,
    ts: row.ts,
    platform: row.platform,
    workspace: row.workspace,
    ...(row.surface !== undefined ? { surface: row.surface } : {}),
    ...(row.surfaceMode !== undefined ? { surfaceMode: row.surfaceMode } : {}),
    ...(row.principalId !== undefined ? { principalId: row.principalId } : {}),
    action: row.action,
    ...(row.detail !== undefined ? { detail: row.detail } : {}),
    prevSha: row.prevSha,
    sha: auditRowSha(row, row.prevSha),
  };
}

type OtlpValue = { stringValue: string } | { intValue: string };
interface OtlpAttribute {
  readonly key: string;
  readonly value: OtlpValue;
}

function otlpAttributes(r: ExportedAuditRecord): OtlpAttribute[] {
  const str = (key: string, v: string | undefined | null): OtlpAttribute[] => (v === undefined || v === null ? [] : [{ key, value: { stringValue: v } }]);
  return [
    { key: "oe.audit.seq", value: { intValue: String(r.seq) } },
    ...str("oe.audit.schema", r.schema),
    ...str("oe.org", r.org),
    ...str("oe.audit.action", r.action),
    ...str("oe.platform", r.platform),
    ...str("oe.workspace", r.workspace),
    ...str("oe.surface", r.surface),
    ...str("oe.surface_mode", r.surfaceMode),
    ...str("oe.principal_id", r.principalId),
    ...str("oe.audit.prev_sha", r.prevSha),
    ...str("oe.audit.sha", r.sha),
    ...str("oe.audit.detail", r.detail === undefined ? undefined : JSON.stringify(r.detail)),
  ];
}

function unixNanos(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${BigInt(ms) * 1_000_000n}` : "0";
}

export function encodeAuditBatch(format: AuditExportFormat, records: readonly ExportedAuditRecord[], nowIso: string): { body: string; contentType: string } {
  if (format === "json") return { body: JSON.stringify(records), contentType: "application/json" };
  if (format === "splunk-hec") {
    const body = records
      .map((r) => JSON.stringify({ time: Date.parse(r.ts) / 1000, host: r.workspace, source: SERVICE, sourcetype: "oe:audit", event: r }))
      .join("\n");
    return { body, contentType: "application/json" };
  }
  const observed = unixNanos(nowIso);
  const body = {
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: SERVICE } }] },
        scopeLogs: [
          {
            scope: { name: "open-everywhere.audit", version: AUDIT_EXPORT_SCHEMA },
            logRecords: records.map((r) => ({
              timeUnixNano: unixNanos(r.ts),
              observedTimeUnixNano: observed,
              severityNumber: 9,
              severityText: "INFO",
              body: { stringValue: JSON.stringify(r) },
              attributes: otlpAttributes(r),
            })),
          },
        ],
      },
    ],
  };
  return { body: JSON.stringify(body), contentType: "application/json" };
}

export function auditExportCursorKey(target: string, org: string): string {
  return `audit.export.cursor.v1:${target}:${org}`;
}

export interface AuditExportOutcome {
  readonly target: string;
  readonly org: string;
  readonly sent: number;
  readonly cursor: number;
  readonly error?: string;
}

export interface AuditExportDeps {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly secret?: (name: string) => Promise<string>;
  readonly targets?: readonly AuditExportTarget[];
}

async function storeOnlySecret(name: string): Promise<string> {
  const resolved = await getOperatorSecret(name);
  if (resolved.source !== "db") {
    throw new Error(`secret "${name}" resolves only from the environment; the SIEM export reads the secret store and nothing else. Store it with \`oe secret set ${name}\``);
  }
  return resolved.value;
}

function authHeader(target: AuditExportTarget, token: string): [string, string] {
  const scheme = target.tokenScheme ?? (target.format === "splunk-hec" ? "Splunk" : "Bearer");
  return [target.tokenHeader ?? "authorization", scheme === "" ? token : `${scheme} ${token}`];
}

function warn(message: string): void {
  console.warn(`[open-everywhere:audit-export] ${message}`);
}

export async function runAuditExport(deps: AuditExportDeps = {}): Promise<AuditExportOutcome[]> {
  const targets = deps.targets ?? getSettings().auditExport.targets;
  if (targets.length === 0) return [];
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = deps.now ?? Date.now;
  const secret = deps.secret ?? storeOnlySecret;
  const store = getOperationalStore();
  const outcomes: AuditExportOutcome[] = [];

  for (const target of targets) {
    let orgs: readonly string[];
    try {
      orgs = target.orgs !== undefined && target.orgs.length > 0 ? target.orgs : await store.listAuditOrgs();
    } catch (err) {
      warn(`target "${target.name}": could not list the audit orgs: ${err instanceof Error ? err.message : String(err)}`);
      outcomes.push({ target: target.name, org: "*", sent: 0, cursor: 0, error: "audit orgs unreadable" });
      continue;
    }
    let header: [string, string] | undefined;
    if (target.tokenSecret !== undefined) {
      try {
        header = authHeader(target, await secret(target.tokenSecret));
      } catch (err) {
        warn(`target "${target.name}": token secret "${target.tokenSecret}" did not resolve: ${err instanceof Error ? err.message : String(err)}`);
        for (const org of orgs) outcomes.push({ target: target.name, org, sent: 0, cursor: 0, error: `token secret "${target.tokenSecret}" did not resolve` });
        continue;
      }
    }
    for (const org of orgs) outcomes.push(await exportOrg(target, org, header, { doFetch, now, store }));
  }
  return outcomes;
}

async function exportOrg(
  target: AuditExportTarget,
  org: string,
  header: [string, string] | undefined,
  env: { doFetch: typeof fetch; now: () => number; store: ReturnType<typeof getOperationalStore> },
): Promise<AuditExportOutcome> {
  const key = auditExportCursorKey(target.name, org);
  let cursor = 0;
  let sent = 0;
  try {
    const stored = await env.store.getMeta(key);
    cursor = stored === null ? 0 : Number(stored);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error(`the stored cursor ${JSON.stringify(stored)} is not a seq`);
  } catch (err) {
    return { target: target.name, org, sent, cursor: 0, error: `cursor unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }

  for (let page = 0; page < AUDIT_EXPORT_MAX_PAGES; page++) {
    let rows: AuditChainRow[];
    try {
      rows = await env.store.readAuditChain(org, { afterSeq: cursor, limit: AUDIT_EXPORT_BATCH });
    } catch (err) {
      return { target: target.name, org, sent, cursor, error: `audit read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const settledBefore = env.now() - SETTLE_MS;
    const settled: AuditChainRow[] = [];
    for (const row of rows) {
      const at = Date.parse(row.ts);
      if (Number.isFinite(at) && at > settledBefore) break;
      settled.push(row);
    }
    if (settled.length === 0) break;

    const { body, contentType } = encodeAuditBatch(target.format, settled.map(exportedRecord), new Date(env.now()).toISOString());
    let status: number;
    try {
      const res = await env.doFetch(target.url, {
        method: "POST",
        headers: { "content-type": contentType, ...(header ? { [header[0]]: header[1] } : {}) },
        body,
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      status = res.status;
      await res.arrayBuffer().catch(() => undefined);
    } catch (err) {
      const reason = err instanceof Error ? err.name : "fetch failed";
      warn(`target "${target.name}" org "${org}": POST failed (${reason}); ${settled.length} row(s) stay queued after seq ${cursor}`);
      return { target: target.name, org, sent, cursor, error: `POST failed (${reason})` };
    }
    if (status < 200 || status >= 300) {
      warn(`target "${target.name}" org "${org}": the receiver answered HTTP ${status}; ${settled.length} row(s) stay queued after seq ${cursor}`);
      return { target: target.name, org, sent, cursor, error: `HTTP ${status}` };
    }
    const last = settled[settled.length - 1]!.seq;
    try {
      await env.store.setMeta(key, String(last));
    } catch (err) {
      return { target: target.name, org, sent: sent + settled.length, cursor, error: `cursor write failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    cursor = last;
    sent += settled.length;
    if (settled.length < rows.length || rows.length < AUDIT_EXPORT_BATCH) break;
  }
  return { target: target.name, org, sent, cursor };
}

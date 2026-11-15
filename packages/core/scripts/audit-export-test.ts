import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SQLITE_DIR = mkdtempSync(join(tmpdir(), "oe-audit-export-"));
delete process.env.DATABASE_URL;
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(SQLITE_DIR, "export.sqlite3");

const { sqliteOperationalStore } = await import("../agent/operational/sqlite.js");
const { initOperationalSchema, makeOperationalPostgresStore } = await import("../agent/operational/postgres.js");
const { openTestPg, closeAllTestPg } = await import("./test-pg-driver.js");
const { runAuditExport, encodeAuditBatch, exportedRecord, auditExportCursorKey, AUDIT_EXPORT_BATCH, SETTLE_MS } = await import("../agent/audit/siem-export.js");
const { defineSettings } = await import("../agent/settings/settings.js");
import type { AuditExportTarget } from "../agent/settings/settings.js";
import type { ExportedAuditRecord } from "../agent/audit/siem-export.js";
import type { AuditDetail } from "../agent/audit/scrubbed-text.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throws(fn: () => unknown, needle: string, label: string): void {
  try {
    fn();
  } catch (err) {
    ok(String(err).includes(needle), `${label} (message mentions "${needle}", got: ${String(err)})`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

const store = sqliteOperationalStore;
let clock = Date.parse("2026-10-11T12:00:00.000Z");
const now = (): number => clock;
const iso = (ms: number): string => new Date(ms).toISOString();

async function append(org: string, action: string, ageMs: number, detail?: AuditDetail): Promise<void> {
  await store.appendAudit({ org, ts: iso(clock - ageMs), platform: "slack", workspace: "T1", surface: "C1", principalId: "U1", action, ...(detail ? { detail } : {}) });
}

interface Posted {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}
let posted: Posted[] = [];
let answer: number | "throw" = 200;
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (answer === "throw") throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
  posted.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body) });
  return new Response("{}", { status: answer });
}) as typeof fetch;

const jsonTarget: AuditExportTarget = { name: "sentinel", format: "json", url: "https://siem.example.com/ingest", tokenSecret: "SIEM_TOKEN" };
const secret = async (name: string): Promise<string> => {
  if (name !== "SIEM_TOKEN") throw new Error(`secret "${name}" is not set`);
  return "tok-123";
};
const run = (targets: readonly AuditExportTarget[] = [jsonTarget]) => runAuditExport({ fetch: fakeFetch, now, secret, targets });

function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
    .join(",")}}`;
}
function receiverSha(r: ExportedAuditRecord): string {
  const fields: unknown[] = [r.prevSha, r.org, r.ts, r.platform, r.workspace, r.surface ?? null, r.principalId ?? null, r.action, r.detail === undefined ? null : canon(r.detail)];
  if (r.surfaceMode !== undefined) fields.push(r.surfaceMode);
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

for (let i = 0; i < 5; i++) await append("acme", `test.row_${i}`, 120_000 - i, { i, nested: { b: 2, a: 1 } });
await append("beta", "test.beta", 120_000);
await append("acme", "test.fresh", 1_000);

let outcomes = await run();
ok(outcomes.length === 2 && outcomes.every((o) => o.error === undefined), `one clean outcome per org (got ${JSON.stringify(outcomes)})`);
ok(posted.length === 2, `one POST per org with settled rows (got ${posted.length})`);
const acmePost = posted.find((p) => p.body.includes('"acme"'))!;
ok(acmePost.headers.authorization === "Bearer tok-123", "the token resolves from the secret store into `authorization: Bearer …`");
ok(acmePost.headers["content-type"] === "application/json", "json bodies are labelled application/json");
const acmeRecords = JSON.parse(acmePost.body) as ExportedAuditRecord[];
ok(acmeRecords.length === 5 && acmeRecords.every((r) => r.action !== "test.fresh"), "the settle window keeps the fresh row back");
ok(acmeRecords.every((r, i) => i === 0 || r.seq > acmeRecords[i - 1]!.seq), "records leave oldest first");
ok(acmeRecords.every((r) => r.schema === "oe.audit.v1" && typeof r.sha === "string" && r.sha.length === 64), "every record carries the schema id and its sha");
ok(acmeRecords.every((r) => receiverSha(r) === r.sha), "CHAIN: a receiver recomputes every record's sha from the record alone");
ok(acmeRecords[0]!.prevSha === null, "CHAIN: the org's genesis row carries prevSha null");
ok(acmeRecords.every((r, i) => i === 0 || r.prevSha === acmeRecords[i - 1]!.sha), "CHAIN: each prevSha equals the previous record's sha");
const acmeOutcome = outcomes.find((o) => o.org === "acme")!;
ok(acmeOutcome.sent === 5 && acmeOutcome.cursor === acmeRecords[4]!.seq, "the outcome names the rows sent and the new cursor");
ok((await store.getMeta(auditExportCursorKey("sentinel", "acme"))) === String(acmeRecords[4]!.seq), "the cursor is stored in instance_meta");

posted = [];
outcomes = await run();
ok(posted.length === 0 && outcomes.every((o) => o.sent === 0), "a second run with nothing settled sends nothing");
clock += SETTLE_MS;
outcomes = await run();
ok(posted.length === 1 && (JSON.parse(posted[0]!.body) as ExportedAuditRecord[])[0]!.action === "test.fresh", "once the clock passes the settle window, the held row leaves");
const freshRecord = (JSON.parse(posted[0]!.body) as ExportedAuditRecord[])[0]!;
ok(freshRecord.prevSha === acmeRecords[4]!.sha, "CHAIN: the link holds across two runs");

await append("acme", "test.retry_a", 60_000);
await append("acme", "test.retry_b", 60_000);
const before = await store.getMeta(auditExportCursorKey("sentinel", "acme"));
posted = [];
answer = 503;
outcomes = await run();
ok(outcomes.find((o) => o.org === "acme")?.error === "HTTP 503", "a 503 is reported as the outcome's error");
ok((await store.getMeta(auditExportCursorKey("sentinel", "acme"))) === before, "a 503 does not move the cursor");
answer = "throw";
outcomes = await run();
ok(outcomes.find((o) => o.org === "acme")?.error?.startsWith("POST failed") === true, "a thrown POST is reported, not raised");
ok((await store.getMeta(auditExportCursorKey("sentinel", "acme"))) === before, "a thrown POST does not move the cursor");
answer = 200;
posted = [];
await run();
const resent = JSON.parse(posted[0]!.body) as ExportedAuditRecord[];
ok(resent.map((r) => r.action).join(",") === "test.retry_a,test.retry_b", "AT-LEAST-ONCE: the next run sends the same rows again");

posted = [];
outcomes = await run([{ ...jsonTarget, name: "other", tokenSecret: "MISSING" }]);
ok(posted.length === 0 && outcomes.every((o) => o.error === 'token secret "MISSING" did not resolve'), "an unresolved secret sends nothing and names the secret, never a value");

process.env.SIEM_ENV_ONLY = "env-value-must-not-leave";
posted = [];
outcomes = await runAuditExport({ fetch: fakeFetch, now, targets: [{ ...jsonTarget, name: "envonly", tokenSecret: "SIEM_ENV_ONLY" }] });
ok(posted.length === 0, "a token that resolves only from the environment sends nothing");
ok(outcomes.every((o) => o.error === 'token secret "SIEM_ENV_ONLY" did not resolve'), "…and the outcome names the secret, not its value");
delete process.env.SIEM_ENV_ONLY;

for (let i = 0; i < AUDIT_EXPORT_BATCH + 7; i++) await append("gamma", `test.bulk_${i}`, 60_000);
posted = [];
outcomes = await run([{ ...jsonTarget, name: "bulk", orgs: ["gamma"] }]);
ok(posted.length === 2, `a backlog of ${AUDIT_EXPORT_BATCH + 7} rows leaves in two pages (got ${posted.length})`);
ok(outcomes[0]!.sent === AUDIT_EXPORT_BATCH + 7, "every row of the backlog is acknowledged");
const paged = posted.flatMap((p) => JSON.parse(p.body) as ExportedAuditRecord[]);
ok(paged.every((r, i) => i === 0 || r.prevSha === paged[i - 1]!.sha), "CHAIN: the link holds across the page boundary");

const pg = await openTestPg();
await initOperationalSchema(pg.client);
const pgStore = makeOperationalPostgresStore(pg.client);
for (let i = 0; i < 6; i++) await pgStore.appendAudit({ org: "pg", ts: iso(clock - 60_000), platform: "slack", workspace: "T1", action: `test.pg_${i}` });
const full = await pgStore.readAuditChain("pg");
const page = await pgStore.readAuditChain("pg", { afterSeq: full[1]!.seq, limit: 3 });
ok(page.map((r) => r.action).join(",") === "test.pg_2,test.pg_3,test.pg_4", `PG: the page is the rows after the cursor, oldest first, bounded (got ${page.map((r) => r.action).join(",")})`);
const sqlitePage = await store.readAuditChain("gamma", { afterSeq: 0, limit: 2 });
ok(sqlitePage.length === 2 && sqlitePage[0]!.action === "test.bulk_0", "SQLite: the same page shape");
await closeAllTestPg();

const sample = [exportedRecord({ seq: 7, ts: "2026-10-11T12:00:00.000Z", org: "acme", platform: "slack", workspace: "T1", surface: "C1", action: "a.b", detail: { k: 1 }, prevSha: null })];
const hec = encodeAuditBatch("splunk-hec", sample, "2026-10-11T12:00:01.000Z");
const hecEvent = JSON.parse(hec.body) as { time: number; sourcetype: string; event: ExportedAuditRecord };
ok(hecEvent.time === Date.parse("2026-10-11T12:00:00.000Z") / 1000 && hecEvent.sourcetype === "oe:audit" && hecEvent.event.seq === 7, "HEC: one event envelope per record, time in epoch seconds");
const otlp = JSON.parse(encodeAuditBatch("otlp", sample, "2026-10-11T12:00:01.000Z").body) as {
  resourceLogs: { resource: { attributes: { key: string }[] }; scopeLogs: { logRecords: { timeUnixNano: string; body: { stringValue: string }; attributes: { key: string; value: Record<string, string> }[] }[] }[] }[];
};
const lr = otlp.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
ok(lr.timeUnixNano === "1791720000000000000", `OTLP: timeUnixNano is the row's ts in nanoseconds (got ${lr.timeUnixNano})`);
ok((JSON.parse(lr.body.stringValue) as ExportedAuditRecord).sha === sample[0]!.sha, "OTLP: the body carries the whole record");
ok(lr.attributes.some((a) => a.key === "oe.audit.seq" && a.value.intValue === "7") && lr.attributes.some((a) => a.key === "oe.audit.sha"), "OTLP: seq and sha are attributes");
posted = [];
await run([{ name: "hec", format: "splunk-hec", url: "https://hec.example.com/services/collector/event", tokenSecret: "SIEM_TOKEN", orgs: ["beta"] }]);
ok(posted.length === 1 && posted[0]!.headers.authorization === "Splunk tok-123", "a new target starts its own cursor at 0, and HEC defaults to the `Splunk` scheme");
ok((JSON.parse(posted[0]!.body) as { event: ExportedAuditRecord }).event.action === "test.beta", "the new target receives the org's whole settled log");

throws(() => defineSettings({ auditExport: { targets: [{ name: "x", format: "json", url: "http://siem.example.com/in" }] } }), "https:", "plain http to a remote host is refused");
ok(defineSettings({ auditExport: { targets: [{ name: "x", format: "otlp", url: "http://127.0.0.1:4318/v1/logs" }] } }) !== undefined, "http to a loopback collector is accepted");
throws(() => defineSettings({ auditExport: { targets: [jsonTarget, { ...jsonTarget }] } }), "unique", "a duplicate target name is refused");
throws(() => defineSettings({ auditExport: { targets: [{ ...jsonTarget, url: "https://u:p@siem.example.com/" }] } }), "credentials", "a URL with credentials is refused");
throws(() => defineSettings({ auditExport: { targets: [{ ...jsonTarget, tokenSecret: "Bearer abc def" }] } }), "secret NAME", "a `Bearer …` string in tokenSecret is refused");
throws(() => defineSettings({ auditExport: { targets: [{ ...jsonTarget, tokenSecret: "3f2b8c1e-0a4d-4c7b-9e21-5d6f7a8b9c0d" }] } }), "secret NAME", "a UUID-shaped (HEC-style) token in tokenSecret is refused");
throws(() => defineSettings({ auditExport: { targets: [{ ...jsonTarget, tokenSecret: "a1b2c3d4e5f60718293a4b5c6d7e8f90" }] } }), "secret NAME", "a lowercase-hex (Datadog-style) token in tokenSecret is refused");
throws(() => defineSettings({ auditExport: { targets: [{ name: "x", format: "syslog" as "json", url: "https://a.example.com/" }] } }), "format", "an unknown format is refused");

console.log(`✓ audit-export: ${passed} assertions passed`);

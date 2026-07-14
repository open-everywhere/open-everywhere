
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-audit-"));
const dbFile = join(tmp, "ops.sqlite3");
process.env.OE_SQLITE_PATH = dbFile;

const { appendAudit, readAudit, auditRoot } = await import("../agent/audit/audit.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

ok(auditRoot() === dbFile, "auditRoot reflects the SQLite backing path");

await appendAudit({ ts: "2026-06-24T10:00:00Z", org: "acme", platform: "slack", workspace: "T1", surface: "C1", principalId: "U1", action: "memory.write", detail: { tier: "surface", files: 2 } });
await appendAudit({ ts: "2026-06-24T11:00:00Z", org: "acme", platform: "slack", workspace: "T1", surface: "C1", principalId: "U2", action: "egress.policy", detail: { hosts: 3, enforced: false } });
await appendAudit({ ts: "2026-06-24T12:00:00Z", org: "acme", platform: "slack", workspace: "T2", surface: "C9", principalId: "U1", action: "memory.write", detail: { tier: "workspace", files: 1 } });
await appendAudit({ ts: "2026-06-24T09:00:00Z", org: "globex", platform: "linear", workspace: "ORG1", surface: "ISS9", principalId: "L3", action: "memory.write", detail: { tier: "surface" } });

const acme = await readAudit({ org: "acme" });
ok(acme.length === 3, "org scan returns only that org's entries");
ok(acme.every((e) => e.org === "acme"), "no cross-org bleed");
const globex = await readAudit({ org: "globex" });
ok(globex.length === 1 && globex[0].principalId === "L3", "second org isolated");

ok(acme[0].ts === "2026-06-24T12:00:00Z" && acme[2].ts === "2026-06-24T10:00:00Z", "results are newest-first");

ok((await readAudit({ org: "acme", action: "memory.write" })).length === 2, "filter by action");
ok((await readAudit({ org: "acme", principalId: "U1" })).length === 2, "filter by principalId (who asked)");
ok((await readAudit({ org: "acme", workspace: "T2" })).length === 1, "filter by workspace");
ok((await readAudit({ org: "acme", surface: "C1" })).length === 2, "filter by surface");
ok((await readAudit({ org: "acme", since: "2026-06-24T11:00:00Z" })).length === 2, "filter by since (inclusive lower bound)");
ok((await readAudit({ org: "acme", limit: 1 })).length === 1, "limit caps the result");
ok((await readAudit({ org: "acme", limit: 1 }))[0].ts === "2026-06-24T12:00:00Z", "limit keeps the newest");

ok((await readAudit()).length === 4, "no-org read scans all orgs");

await appendAudit({ org: "acme", platform: "slack", workspace: "T3", action: "action.test" });
const stamped = await readAudit({ org: "acme", workspace: "T3" });
ok(stamped.length === 1 && typeof stamped[0].ts === "string" && stamped[0].ts.length >= 20, "ts is auto-stamped when omitted");

const before = (await readAudit({ org: "acme", workspace: "T1" })).length;
await appendAudit({ ts: "2026-06-24T13:00:00Z", org: "acme", platform: "slack", workspace: "T1", surface: "C1", action: "memory.write" });
const after = (await readAudit({ org: "acme", workspace: "T1" })).length;
ok(after === before + 1, "append-only: an append adds a line, never overwrites prior ones");
ok(!("deleteAudit" in await import("../agent/audit/audit.js")), "no delete API exists (audit is outside the erasure path)");

{
  const { auditToolAction } = await import("../agent/audit/tool-action.js");
  process.env.OE_ORG = "toolorg";
  process.env.OE_PLATFORM = "slack";
  process.env.OE_WORKSPACE = "TW";
  process.env.OE_SURFACE = "CW";
  process.env.OE_PRINCIPAL = "U_actor";
  process.env.OE_MODE = "channel";

  await auditToolAction({}, "pr.open", { repo: "acme/web", number: 7 });
  await auditToolAction({}, "routine.create", { id: "r-xyz" });

  const rows = await readAudit({ org: "toolorg" });
  ok(rows.length === 2, "auditToolAction wrote both tool-action entries under the resolved org");
  ok(rows.some((e) => e.action === "pr.open" && (e.detail as { number?: number })?.number === 7), "pr.open recorded with its detail");
  ok(rows.every((e) => e.principalId === "U_actor"), "tool action stamps WHO from the ctx binding");
  ok(rows.every((e) => e.platform === "slack" && e.workspace === "TW" && e.surface === "CW"), "tool action stamps WHERE from the ctx binding");
  for (const k of ["OE_ORG", "OE_PLATFORM", "OE_WORKSPACE", "OE_SURFACE", "OE_PRINCIPAL", "OE_MODE"]) delete process.env[k];
}

{
  const { getOperationalStore } = await import("../agent/operational/provider.js");
  const store = getOperationalStore() as { appendAudit: (rec: unknown) => Promise<void> };
  const realAppend = store.appendAudit.bind(store);

  let calls = 0;
  store.appendAudit = async (rec: unknown) => {
    calls++;
    if (calls === 1) throw new Error("transient store blip");
    return realAppend(rec);
  };
  await appendAudit({ ts: "2026-06-25T00:00:00Z", org: "retryorg", platform: "slack", workspace: "TR", action: "memory.write" });
  ok(calls === 2, "appendAudit re-attempts exactly once on a transient store failure");
  store.appendAudit = realAppend;
  ok((await readAudit({ org: "retryorg" })).length === 1, "appendAudit: the retry LANDS the row (best-effort recovered)");

  const { __resetTelemetryForTest, __setInstanceForTest, __queueLengthForTest } = await import("../agent/observability/telemetry.js");
  __resetTelemetryForTest();
  __setInstanceForTest({ id: "audit-drop-test", ephemeral: false });
  const before = __queueLengthForTest();
  store.appendAudit = async () => {
    throw new Error("store down");
  };
  let threw = false;
  try {
    await appendAudit({ org: "droporg", platform: "discord", workspace: "TD", action: "reply.post" });
  } catch {
    threw = true;
  }
  ok(!threw, "appendAudit: a second failure never throws (best-effort held)");
  store.appendAudit = realAppend;
  ok((await readAudit({ org: "droporg" })).length === 0, "appendAudit: a twice-failing write drops the row (no partial)");
  ok(__queueLengthForTest() === before + 1, "appendAudit: a dropped line emits exactly one oe.audit.dropped telemetry event");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ audit: ${passed} assertions passed`);

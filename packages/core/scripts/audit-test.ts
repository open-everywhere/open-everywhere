
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDeploymentIdentityForTest, _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

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

{
  const refusal = async (call: () => Promise<unknown>): Promise<string> => {
    try {
      await call();
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const noOrg = { action: "memory.write" } as unknown as Parameters<typeof readAudit>[0];
  ok((await refusal(() => readAudit(noOrg))).includes("requires an org"), "a read with NO org refuses — it never widens to every org");
  ok((await refusal(() => readAudit({ org: "", action: "memory.write" }))).includes("requires an org"), "an EMPTY org refuses too, rather than answering zero rows");
  ok((await refusal(() => readAudit({ org: "acme" }))) === "", "…and a read that names its org still answers");
  ok((await readAudit({ org: "acme" })).every((e) => e.org === "acme"), "a read for acme carries NO globex row");
}

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
  _setDeploymentIdentityForTest({ org: "toolorg" });
  process.env.OE_PLATFORM = "slack";
  _setDeploymentIdentityForTest({ workspace: "TW", surface: "CW" });
  process.env.OE_PRINCIPAL = "U_actor";
  process.env.OE_MODE = "channel";

  await auditToolAction({}, "pr.open", { repo: "acme/web", number: 7 });
  await auditToolAction({}, "routine.create", { id: "r-xyz" });

  const rows = await readAudit({ org: "toolorg" });
  ok(rows.length === 2, "auditToolAction wrote both tool-action entries under the resolved org");
  ok(rows.some((e) => e.action === "pr.open" && (e.detail as { number?: number })?.number === 7), "pr.open recorded with its detail");
  ok(rows.every((e) => e.principalId === "U_actor"), "tool action stamps WHO from the ctx binding");
  ok(rows.every((e) => e.platform === "slack" && e.workspace === "TW" && e.surface === "CW"), "tool action stamps WHERE from the ctx binding");
  _resetDeploymentIdentityForTest();
  for (const k of ["OE_PLATFORM", "OE_PRINCIPAL", "OE_MODE"]) delete process.env[k];
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

  const { __resetTelemetryForTest, __setInstanceForTest, __queueLengthForTest, emitTelemetry } = await import("../agent/observability/telemetry.js");
  const { registerAuditDropCounter } = await import("../agent/audit/audit.js");
  registerAuditDropCounter((action, platform) => emitTelemetry("oe.audit.dropped", { "oe.action": action, "oe.platform": platform }));
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

{
  const { getOperationalStore } = await import("../agent/operational/provider.js");
  const { findChainBreak, auditRowSha, bootVerifyAuditChainTail } = await import("../agent/audit/chain.js");
  const { DatabaseSync } = await import("node:sqlite");
  const store = getOperationalStore();

  const CO = "chainorg";
  await appendAudit({ ts: "2026-07-01T00:00:00Z", org: CO, platform: "slack", workspace: "T1", action: "a.one", detail: { n: 1 } });
  await appendAudit({ ts: "2026-07-01T00:01:00Z", org: CO, platform: "slack", workspace: "T1", action: "a.two", detail: { n: 2 } });
  await appendAudit({ ts: "2026-07-01T00:02:00Z", org: CO, platform: "slack", workspace: "T1", action: "a.three", detail: { n: 3 } });

  const chain = await store.readAuditChain(CO);
  ok(chain.length === 3 && chain[0].ts === "2026-07-01T00:00:00Z" && chain[2].ts === "2026-07-01T00:02:00Z", "chain: readAuditChain returns all rows oldest-first");
  ok(chain[0].prevSha === null, "chain: genesis row has null prev_sha");
  ok(chain[1].prevSha === auditRowSha(chain[0], null) && chain[2].prevSha === auditRowSha(chain[1], chain[1].prevSha), "chain: each row's prev_sha = sha(previous row)");
  ok(findChainBreak(chain, { expectGenesis: true }) === null, "chain: an intact chain verifies clean");

  await appendAudit({ ts: "2026-07-01T00:00:00Z", org: "chainorg2", platform: "discord", workspace: "G1", action: "b.one" });
  const other = await store.readAuditChain("chainorg2");
  ok(other.length === 1 && other[0].prevSha === null, "chain: a second org starts its own genesis (no interleave)");
  ok((await store.readAuditChain(CO)).length === 3, "chain: the first org's chain is unchanged by the second org's append");

  const tail = await store.readAuditChain(CO, { tailLimit: 2 });
  ok(tail.length === 2 && tail[0].ts === "2026-07-01T00:01:00Z" && findChainBreak(tail, { expectGenesis: false }) === null, "chain: tailLimit returns the last N oldest-first, sound");

  const raw = new DatabaseSync(dbFile);
  raw.prepare("UPDATE audit_entry SET detail = ? WHERE org_id = ? AND action = ?").run(JSON.stringify({ n: 999 }), CO, "a.two");
  const tampered = await store.readAuditChain(CO);
  ok(findChainBreak(tampered, { expectGenesis: true })?.action === "a.three", "chain: a mutated middle row is detected at its successor");

  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(" "));
  };
  let threw = false;
  try {
    await bootVerifyAuditChainTail(store);
  } catch {
    threw = true;
  } finally {
    console.warn = origWarn;
  }
  ok(!threw, "chain: bootVerifyAuditChainTail never throws on a break");
  ok(warns.some((w) => w.includes("AUDIT CHAIN BREAK") && w.includes(CO)), "chain: the boot tail-check logs a loud warn naming the tampered org");

  const CD = "delorg";
  await appendAudit({ ts: "2026-07-02T00:00:00Z", org: CD, platform: "slack", workspace: "T1", action: "d.one" });
  await appendAudit({ ts: "2026-07-02T00:01:00Z", org: CD, platform: "slack", workspace: "T1", action: "d.two" });
  await appendAudit({ ts: "2026-07-02T00:02:00Z", org: CD, platform: "slack", workspace: "T1", action: "d.three" });
  raw.prepare("DELETE FROM audit_entry WHERE org_id = ? AND action = ?").run(CD, "d.two");
  raw.close();
  const afterDel = await store.readAuditChain(CD);
  ok(afterDel.length === 2, "chain: the middle row is gone (sqlite raw delete)");
  ok(findChainBreak(afterDel, { expectGenesis: true })?.action === "d.three", "chain: a deleted middle row is detected at the next surviving row");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ audit: ${passed} assertions passed`);

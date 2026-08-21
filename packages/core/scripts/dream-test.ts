
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../agent/memory/graph.js";
import { salienceScores } from "../agent/memory/dream/salience.js";
import {
  dedupBullets,
  repairLinks,
  reorderBySalience,
  detectConsolidations,
  detectContradictions,
  detectStale,
  isSafe,
  SAFE_KINDS,
  type MemoryOp,
} from "../agent/memory/dream/ops.js";
import { tidySilo } from "../agent/memory/dream/tidy.js";
import { workflowSignature, inMemoryLedger, auditRecurrenceLedger } from "../agent/memory/dream/recurrence.js";
import { learnFromSession } from "../agent/memory/dream/learn.js";
import { stampHumanEdit, isHumanEdited, humanEditedAt, humanEditedFiles } from "../agent/memory/provenance.js";
import type { MemoryFiles } from "../agent/memory/store.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
const eq = (a: unknown, b: unknown, label: string) => ok(JSON.stringify(a) === JSON.stringify(b), label);
const has = (ops: readonly MemoryOp[], kind: string) => ops.some((o) => o.kind === kind);

{
  const a = workflowSignature("Deploy the staging build now");
  const b = workflowSignature("Build the staging deploy");
  eq(a, b, "signature: order-insensitive (same word set collapses)");
  ok(!a.includes("the") && !a.includes("now"), "signature: stopwords dropped");
  eq(workflowSignature("a an the to"), "", "signature: no signal → empty");
}

{
  const g = buildGraph({
    "index.md": "[[small]] [[big]]",
    "big.md": "hub note",
    "small.md": "leaf",
    "a.md": "[[big]]",
    "b.md": "[[big]]",
    "c.md": "[[big]]",
    "iso.md": "unconnected",
  });
  const s = salienceScores(g);
  eq(s[0].node, "big", "salience: the most-linked node ranks first");
  ok((s.find((n) => n.node === "big")?.score ?? 0) > (s.find((n) => n.node === "small")?.score ?? 0), "salience: well-connected > sparsely-connected");
  eq(s.find((n) => n.node === "iso")?.score, 0, "salience: an unconnected node scores 0");
}

{
  const files: MemoryFiles = { "m.md": "## S\n- alpha fact\n- beta fact\n- alpha fact\n\nprose - not a bullet\n" };
  const r = dedupBullets(files);
  eq((r.files["m.md"].match(/- alpha fact/g) ?? []).length, 1, "dedup: duplicate bullet dropped, first kept");
  ok(r.files["m.md"].includes("- beta fact"), "dedup: distinct bullet preserved");
  ok(r.files["m.md"].includes("prose - not a bullet"), "dedup: non-bullet line untouched");
  ok(has(r.ops, "dedup") && r.ops.every((o) => isSafe(o.kind)), "dedup: emits safe ops");
  eq(dedupBullets(r.files).ops.length, 0, "dedup: idempotent (second pass is a no-op)");
}

{
  const files: MemoryFiles = {
    "hub.md": "see [[People]], [[rollout]], [[missing]] and [[People#h|the alias]]",
    "people.md": "",
    "decisions/rollout.md": "",
  };
  const r = repairLinks(files);
  const out = r.files["hub.md"];
  ok(out.includes("[[people]]"), "link-repair: case variant '[[People]]' → canonical '[[people]]'");
  ok(out.includes("[[decisions/rollout]]"), "link-repair: bare basename '[[rollout]]' → path-qualified id");
  ok(out.includes("[[missing]]"), "link-repair: dangling link left as-is (it's intent)");
  ok(out.includes("[[people#h|the alias]]"), "link-repair: anchor + alias preserved on rewrite");
  ok(r.ops.every((o) => o.kind === "link-repair" && isSafe(o.kind)), "link-repair: emits safe ops");
  eq(repairLinks(r.files).ops.length, 0, "link-repair: idempotent (canonical links unchanged)");
}

{
  const files: MemoryFiles = {
    "index.md": "## Map\n- [[small]] pointer\n- [[big]] pointer\n\n## Log\n- 2026-01-01: first\n- 2026-02-01: second\n",
    "big.md": "x",
    "small.md": "y",
    "a.md": "[[big]]",
    "b.md": "[[big]]",
  };
  const r = reorderBySalience(files);
  const lines = r.files["index.md"].split("\n");
  const bigIdx = lines.findIndex((l) => l.includes("[[big]]"));
  const smallIdx = lines.findIndex((l) => l.includes("[[small]]"));
  ok(bigIdx < smallIdx, "salience-reorder: higher-salience pointer bullet sorts first");
  ok(r.files["index.md"].indexOf("2026-01-01") < r.files["index.md"].indexOf("2026-02-01"), "salience-reorder: dated (non-pointer) bullets keep chronological order");
  ok(has(r.ops, "salience-reorder"), "salience-reorder: emits a safe op");
  eq(reorderBySalience(r.files).ops.length, 0, "salience-reorder: idempotent (sorted stays sorted)");
}

{
  const contradiction: MemoryFiles = {
    "m.md": "## People\n- 2026-01-01: Adams owns the billing service\n- 2026-03-01: Adams no longer owns the billing service\n",
  };
  const c = detectContradictions(contradiction);
  ok(has(c, "contradiction"), "contradiction: same-subject opposing-polarity bullets flagged");
  ok(c.every((o) => !isSafe(o.kind)), "contradiction: ops are destructive (never auto-applied)");

  const samePolarity: MemoryFiles = { "m.md": "- Adams owns billing\n- Brent owns payments\n" };
  eq(detectContradictions(samePolarity).length, 0, "contradiction: unrelated same-polarity bullets not flagged");

  const nearDup: MemoryFiles = { "m.md": "- The deployment pipeline runs staging before production\n- The deployment pipeline runs staging before production always\n" };
  ok(has(detectConsolidations(nearDup), "consolidate"), "consolidate: near-duplicate same-polarity bullets flagged");
  eq(detectConsolidations(nearDup).every((o) => !isSafe(o.kind)), true, "consolidate: destructive (propose-only)");

  const dated: MemoryFiles = { "m.md": "- 2020-01-01: ancient decision\n- 2026-06-01: recent decision\n" };
  const now = new Date("2026-07-01T00:00:00Z");
  const stale = detectStale(dated, now, 180);
  ok(stale.length === 1 && (stale[0].before?.includes("2020-01-01") ?? false), "stale: only the past-horizon dated bullet flagged (clock injected)");
  eq(detectStale(dated, now, 180).every((o) => !isSafe(o.kind)), true, "stale: destructive (propose-only)");

  eq(detectContradictions(contradiction, undefined, new Set(["m.md"])).length, 0, "contradiction: excluded file produces no ops");
  eq(detectConsolidations(nearDup, undefined, new Set(["m.md"])).length, 0, "consolidate: excluded file produces no ops");
  eq(detectStale(dated, now, 180, new Set(["m.md"])).length, 0, "stale: excluded file produces no ops");
  const twoFiles: MemoryFiles = { ...contradiction, "other.md": "- 2020-01-01: another old fact\n" };
  ok(detectStale(twoFiles, now, 180, new Set(["m.md"])).some((o) => o.file === "other.md"), "stale: excluding one file leaves another file's detection untouched");
}

{
  const stamped = stampHumanEdit("# Notes\n- a fact\n", new Date("2026-07-18T12:00:00.000Z"));
  ok(stamped.startsWith('<!-- oe:human-edit edited_by="human" edited_at="2026-07-18T12:00:00.000Z" -->\n'), "provenance: stampHumanEdit prepends the marker");
  ok(stamped.endsWith("# Notes\n- a fact\n"), "provenance: stampHumanEdit preserves the original content verbatim after the marker");
  ok(isHumanEdited(stamped), "provenance: isHumanEdited true once stamped");
  eq(humanEditedAt(stamped), "2026-07-18T12:00:00.000Z", "provenance: humanEditedAt reads the stamped timestamp back");
  ok(!isHumanEdited("# Notes\n- a fact\n"), "provenance: an unstamped file is NOT human-edited");
  eq(humanEditedAt("# Notes\n- a fact\n"), null, "provenance: humanEditedAt is null when no marker");

  const restamped = stampHumanEdit(stamped, new Date("2026-07-25T09:00:00.000Z"));
  eq((restamped.match(/<!-- oe:human-edit/g) ?? []).length, 1, "provenance: re-stamping doesn't stack a second marker");
  eq(humanEditedAt(restamped), "2026-07-25T09:00:00.000Z", "provenance: re-stamping refreshes the timestamp");

  const files: MemoryFiles = { "human.md": stamped, "agent.md": "# Notes\n- another\n" };
  eq([...humanEditedFiles(files)], ["human.md"], "provenance: humanEditedFiles picks out exactly the marked file(s)");
}

{
  const input: MemoryFiles = {
    "m.md": [
      "## Notes",
      "- alpha fact",
      "- alpha fact",
      "see [[People]] and [[missing]]",
      "- 2019-01-01: very old note",
      "- The deployment pipeline runs staging before production",
      "- The deployment pipeline runs staging before production always",
    ].join("\n"),
    "people.md": "",
  };
  const now = new Date("2026-07-01T00:00:00Z");
  const r = tidySilo(input, { now });

  ok(r.applied.length > 0, "tidy: some safe ops applied");
  ok(r.applied.every((o) => (SAFE_KINDS as readonly string[]).includes(o.kind)), "tidy: applied ops are ALL safe kinds");
  ok(r.proposals.length > 0, "tidy: some destructive ops proposed");
  ok(r.proposals.every((o) => !isSafe(o.kind)), "tidy: proposals are ALL destructive kinds (never auto-applied)");
  ok(has(r.proposals, "stale") && has(r.proposals, "consolidate"), "tidy: staleness + consolidation surfaced as proposals");
  ok(r.files["m.md"].includes("[[people]]") && (r.files["m.md"].match(/- alpha fact/g) ?? []).length === 1, "tidy: safe applies reflected in files (repair + dedup)");
  ok(r.files["m.md"].includes("2019-01-01"), "tidy: destructive proposal NOT applied (stale bullet still present)");
  ok(r.changed, "tidy: reports changed when safe applies edited the files");

  const second = tidySilo(r.files, { now });
  eq(second.changed, false, "tidy: safe applies converge (idempotent — second pass changes nothing)");
}

{
  const now = new Date("2026-07-01T00:00:00Z");
  const humanFile = stampHumanEdit(
    ["## Notes", "- 2019-01-01: very old note", "- The deployment pipeline runs staging before production", "- The deployment pipeline runs staging before production always"].join("\n"),
    new Date("2026-06-30T00:00:00Z"),
  );
  const input: MemoryFiles = {
    "human.md": humanFile,
    "agent.md": ["- 2019-01-01: another very old note", "- The billing service handles refunds automatically", "- The billing service handles refunds automatically every time"].join("\n"),
  };
  const r = tidySilo(input, { now });
  ok(!r.proposals.some((o) => o.file === "human.md"), "tidy: a human-edit-marked file gets NO destructive proposals (stale/consolidate skipped)");
  ok(r.proposals.some((o) => o.file === "agent.md" && o.kind === "stale"), "tidy: the unmarked sibling file still gets staleness proposed");
  ok(r.proposals.some((o) => o.file === "agent.md" && o.kind === "consolidate"), "tidy: the unmarked sibling file still gets consolidation proposed");
  ok(isHumanEdited(r.files["human.md"]), "tidy: the marker itself survives the safe-op pass untouched");
}

{
  const ledger = inMemoryLedger();
  const signals = { request: "summarise the weekly on-call incidents report" };
  const r1 = await learnFromSession("brain", signals, ledger, { enrichThreshold: 3, skillThreshold: 3 });
  const r2 = await learnFromSession("brain", signals, ledger, { enrichThreshold: 3, skillThreshold: 3 });
  ok(!r1.enrich && !r1.skillProposal && !r2.enrich && !r2.skillProposal, "recurrence: below threshold → no enrich, no skill proposal");
  const r3 = await learnFromSession("brain", signals, ledger, { enrichThreshold: 3, skillThreshold: 3 });
  ok(r3.enrich && r3.skillProposal !== null, "recurrence: AT the crossing → enrich + SKILL.md proposal");
  ok(r3.skillProposal?.kind === "skill" && (r3.skillProposal.after ?? "").includes("name:"), "recurrence: proposal carries a SKILL.md sketch");
  const r4 = await learnFromSession("brain", signals, ledger, { enrichThreshold: 3, skillThreshold: 3 });
  ok(!r4.enrich && !r4.skillProposal, "recurrence: past the crossing → fires only ONCE (no re-propose)");
  const other = await learnFromSession("other", signals, ledger, { enrichThreshold: 3, skillThreshold: 3 });
  eq(other.count, 1, "recurrence: a different scope counts the same request apart");
}

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-dream-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

const { recordProposal, recordMemoryOpProposals, listProposals } = await import("../agent/memory/dream/proposal.js");
const { registerConfig } = await import("../agent/access/config.js");
const tidySchedule = await import("../agent/schedules/tidy.js");

{
  await recordProposal("acme", { kind: "contradiction", scope: "payments", summary: "conflict on Ada ownership", before: "a\nb" });
  const list = await listProposals("acme");
  ok(list.length === 1 && list[0].action === "memory.proposal", "proposal: recorded as an audited entry");
  eq(list[0].detail?.["kind"], "contradiction", "proposal: op kind persisted in detail");
  eq(list[0].detail?.["scope"], "payments", "proposal: scope persisted");
  ok((await listProposals("other-org")).length === 0, "proposal: org-isolated (no cross-org bleed)");
}

{
  const ledger = auditRecurrenceLedger("acme");
  const k1 = { scope: "brain", signature: "ledger quarterly reconcile" };
  const k2 = { scope: "brain", signature: "cluster frankfurt provision warehouse" };
  const sameSigOtherScope = { scope: "other-brain", signature: k1.signature };
  eq(await ledger.count(k1), 0, "audit-ledger: unseen key counts 0");
  eq(await ledger.observe(k1), 1, "audit-ledger: first observe → 1");
  eq(await ledger.observe(k1), 2, "audit-ledger: second observe → 2 (durable)");
  eq(await ledger.observe(k2), 1, "audit-ledger: distinct signature counted apart");
  eq(await ledger.observe(sameSigOtherScope), 1, "audit-ledger: the same signature in another scope counts apart");
  eq(await ledger.count(k1), 2, "audit-ledger: count reflects prior observes");
}

{
  const { readAudit } = await import("../agent/audit/audit.js");
  const { signatureDigest } = await import("../agent/memory/dream/recurrence.js");

  const request = "escalate the northwind pipeline hotfix immediately";
  const signature = workflowSignature(request);
  ok(signature.length > 0, "OPE-924 fixture: the request produces a non-empty signature (else the checks pass for free)");
  const words = signature.split(" ");
  ok(words.length >= 3, "OPE-924 fixture: the signature carries several distinct words to look for");

  await auditRecurrenceLedger("taintco").observe({ scope: "brain", signature }, "delivery-1");
  const rows = await readAudit({ org: "taintco", action: "memory.observation" });
  eq(rows.length, 1, "OPE-924: exactly one observation row was written");
  const detail = rows[0].detail ?? {};

  const serialised = JSON.stringify(detail);
  for (const w of words) {
    ok(!serialised.includes(w), `OPE-924: the signature word "${w}" is NOT in the observation row's detail`);
  }
  ok(!serialised.includes(signature), "OPE-924: the joined signature is not in the row either");

  eq(detail["sigSha"], signatureDigest(signature), "OPE-924: the row carries the SHA-256 digest of the signature");
  eq(detail["scope"], "brain", "OPE-924: the OE-minted scope stays in the clear — the row is still useful");
  eq(detail["delivery"], "delivery-1", "OPE-924: the delivery id (the dedupe key) survives");
  ok(/^[0-9a-f]{64}$/.test(String(detail["sigSha"])), "OPE-924: the digest is 64 hex characters");

  eq(Object.keys(detail).sort(), ["delivery", "scope", "sigSha"], "OPE-924: the row carries THOSE THREE keys and nothing else");

  ok(signatureDigest(signature) !== signatureDigest(`${signature} extra`), "OPE-924: distinct signatures digest apart");
}

{
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [
      { name: "test-brain", provider: "sqlite" },
      { name: "readonly-brain", provider: "sqlite", readOnly: true },
    ],
    domainsForSurface: () => [],
  } as never);

  const { providerById } = await import("../agent/memory/provider.js");
  const { siloTier } = await import("../agent/memory/store.js");
  const provider = providerById("sqlite");
  const p = { org: "sweepco", platform: "sweepco", workspace: "sweepco", surface: "sweepco", workspaceKey: "sweepco", surfaceKey: "sweepco", key: "sweepco" };
  const messy: MemoryFiles = {
    "MEMORY.md": "## Notes\n- fact one\n- fact one\nlink to [[People]]\n- 2018-05-05: stale decision\n",
    "people.md": "the people file",
  };
  await provider.writeTier(p as never, siloTier("test-brain"), messy, "seed", { name: "test-brain", provider: "sqlite" });
  await provider.writeTier(p as never, siloTier("readonly-brain"), { "MEMORY.md": "## X\n- dup\n- dup\n" }, "seed", { name: "readonly-brain", provider: "sqlite" });

  const now = new Date("2026-07-01T00:00:00Z");
  const report = await tidySchedule.tidyTick({ now, orgs: ["sweepco"] });

  ok(report.silos === 1, "tidyTick: read-only silo skipped (only the writable one swept)");
  ok(report.applied > 0 && report.changed === 1, "tidyTick: safe ops applied + silo written");
  ok(report.proposed > 0, "tidyTick: destructive ops recorded as proposals");

  const after = await provider.readTier(p as never, siloTier("test-brain"), { name: "test-brain", provider: "sqlite" });
  eq((after["MEMORY.md"].match(/- fact one/g) ?? []).length, 1, "tidyTick: dedup persisted to the silo");
  ok(after["MEMORY.md"].includes("[[people]]"), "tidyTick: link-repair persisted to the silo");
  ok(after["MEMORY.md"].includes("2018-05-05"), "tidyTick: stale bullet NOT deleted (proposed only)");

  const ro = await provider.readTier(p as never, siloTier("readonly-brain"), { name: "readonly-brain", provider: "sqlite" });
  eq((ro["MEMORY.md"].match(/- dup/g) ?? []).length, 2, "tidyTick: read-only silo left untouched");

  const proposals = await listProposals("sweepco");
  ok(proposals.some((e) => e.detail?.["kind"] === "stale"), "tidyTick: a stale proposal is recorded + auditable");
  const { readAudit } = await import("../agent/audit/audit.js");
  ok((await readAudit({ org: "sweepco", action: "memory.tidy" })).length === 1, "tidyTick: the safe-apply write is audited (memory.tidy)");

  const heartbeats = await readAudit({ org: "sweepco", action: "memory.tidy_tick" });
  ok(heartbeats.length === 1, "🔴 OPE-635: tidyTick writes exactly one memory.tidy_tick heartbeat row per org per tick");
  ok(heartbeats[0]!.detail?.["outcome"] === "changed", "🔴 OPE-635: a tick that changed a silo has a heartbeat outcome of \"changed\"");
  eq(heartbeats[0]!.detail?.["silos"], 1, "OPE-635: the heartbeat's silo count matches the tick report");
}

{
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [{ name: "quiet-brain", provider: "sqlite" }],
    domainsForSurface: () => [],
  } as never);

  const { providerById } = await import("../agent/memory/provider.js");
  const { siloTier } = await import("../agent/memory/store.js");
  const provider = providerById("sqlite");
  const p = { org: "quietco", platform: "quietco", workspace: "quietco", surface: "quietco", workspaceKey: "quietco", surfaceKey: "quietco", key: "quietco" };
  await provider.writeTier(p as never, siloTier("quiet-brain"), { "MEMORY.md": "## Notes\n- a single tidy fact\n" }, "seed", { name: "quiet-brain", provider: "sqlite" });

  const now = new Date("2026-07-01T00:00:00Z");
  const report = await tidySchedule.tidyTick({ now, orgs: ["quietco"] });
  ok(report.changed === 0, "tidyTick (no-op scenario): nothing needed changing");

  const { readAudit } = await import("../agent/audit/audit.js");
  ok((await readAudit({ org: "quietco", action: "memory.tidy" })).length === 0, "tidyTick (no-op scenario): the per-silo memory.tidy row is unchanged — still silent on a no-op, by design");
  const heartbeats = await readAudit({ org: "quietco", action: "memory.tidy_tick" });
  ok(heartbeats.length === 1, "🔴 OPE-635: a NO-OP tick still writes its heartbeat row — a quiet day and a dead cron no longer read identically");
  ok(heartbeats[0]!.detail?.["outcome"] === "no-op: nothing to tidy", "🔴 OPE-635: …and the outcome names the no-op explicitly");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ dream: ${passed} assertions passed`);

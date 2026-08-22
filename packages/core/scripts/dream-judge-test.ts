
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectCandidates, DEFAULT_CANDIDATE_CAP, type CandidateCluster } from "../agent/memory/dream/candidates.js";
import {
  judgeFromCompletion,
  parseJudgeVerdict,
  parseDistilledFacts,
  judgePrompt,
  distillPrompt,
  registerDreamJudge,
  type DreamJudge,
  type JudgeVerdict,
} from "../agent/memory/dream/judge.js";
import { tidySiloJudged } from "../agent/memory/dream/tidy.js";
import { isSafe, SAFE_KINDS } from "../agent/memory/dream/ops.js";
import { safeDistill, enrichmentBullets } from "../agent/memory/dream/learn.js";
import { stampHumanEdit } from "../agent/memory/provenance.js";
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

function fakeJudge(verdictFor: (c: CandidateCluster) => JudgeVerdict | null): DreamJudge & { calls: CandidateCluster[] } {
  const calls: CandidateCluster[] = [];
  return {
    calls,
    async judge(_scope, candidate) {
      calls.push(candidate);
      return verdictFor(candidate);
    },
    async distill() {
      return null;
    },
  };
}

{
  const v = parseJudgeVerdict('{"confirm": true, "keep": "- a", "note": "same fact"}');
  ok(v?.confirm === true && v.keep === "- a" && v.note === "same fact", "parse: strict verdict JSON accepted");
  const fenced = parseJudgeVerdict('Sure! Here is my answer:\n```json\n{"confirm": false, "note": "unrelated"}\n```');
  ok(fenced?.confirm === false && fenced.keep === undefined, "parse: verdict wrapped in prose/code-fence accepted");
  eq(parseJudgeVerdict("I think they are the same fact."), null, "parse: no JSON → null (fail quiet)");
  eq(parseJudgeVerdict('{"keep": "- a"}'), null, "parse: missing boolean confirm → null");
  eq(parseJudgeVerdict('{"confirm": "yes"}'), null, "parse: non-boolean confirm → null");
}

{
  const f = parseDistilledFacts('{"facts": [{"text": "Deploys go staging first", "links": ["deploys"]}]}');
  ok(f?.length === 1 && f[0].text === "Deploys go staging first" && f[0].links[0] === "deploys", "parse: facts JSON accepted");
  const many = parseDistilledFacts(`{"facts": [${Array.from({ length: 5 }, (_, i) => `{"text": "fact ${i}", "links": []}`).join(",")}]}`);
  eq(many?.length, 3, "parse: facts clamped to 3");
  const messy = parseDistilledFacts('{"facts": [{"text": ""}, {"links": ["x"]}, {"text": "kept one"}]}');
  ok(messy?.length === 1 && messy[0].text === "kept one" && messy[0].links.length === 0, "parse: textless entries dropped, links default to []");
  eq(parseDistilledFacts("no json here"), null, "parse: garbage distillation → null");
  eq(parseDistilledFacts('{"answer": 42}'), null, "parse: JSON without a facts array → null");
  eq(parseDistilledFacts('{"facts": []}')?.length, 0, "parse: explicit empty facts → [] (nothing durable)");
}

{
  const candidate: CandidateCluster = { kind: "consolidate", file: "m.md", bullets: ["- a", "- b"], reason: "test", score: 1 };
  const good = judgeFromCompletion(async () => '{"confirm": true, "note": "dup"}');
  ok((await good.judge("s", candidate))?.confirm === true, "skeleton: completion → parsed verdict");
  const thrower = judgeFromCompletion(async () => {
    throw new Error("gateway down");
  });
  eq(await thrower.judge("s", candidate), null, "skeleton: completion throws → null verdict (fail quiet)");
  eq(await thrower.distill({ scope: "s", request: "r", signature: "r", count: 3 }), null, "skeleton: completion throws → null facts (fail quiet)");
  const garbage = judgeFromCompletion(async () => "sorry, I can't");
  eq(await garbage.judge("s", candidate), null, "skeleton: unparseable completion → null (no proposal)");
  ok(judgePrompt(candidate).includes("STRICT JSON") && judgePrompt(candidate).includes("- a"), "skeleton: judge prompt carries the lines + strict-JSON instruction");
  ok(distillPrompt({ scope: "s", request: "req", messages: ["m1"], signature: "req", count: 3 }).includes("m1"), "skeleton: distill prompt carries the session messages");
}

{
  const now = new Date("2026-07-01T00:00:00Z");
  const nearDup: MemoryFiles = { "m.md": "- payments deploys run staging before production checks\n- payments deploys run staging before production checks every friday morning\n" };
  const c1 = selectCandidates(nearDup, { now });
  ok(c1.some((c) => c.kind === "consolidate"), "narrow: near-dup pair below the v1 bar is still a candidate (wider net)");

  const linked: MemoryFiles = { "m.md": "- Adams owns the [[billing]] rota\n- Erin holds primary pager duty for [[billing]]\n" };
  const c2 = selectCandidates(linked, { now });
  ok(c2.some((c) => c.kind === "contradiction"), "narrow: shared-[[link]] subject pairs at ~0 word overlap (graph does the narrowing)");

  const polar: MemoryFiles = { "m.md": "- Adams owns the billing service\n- Adams no longer owns the billing service\n" };
  ok(selectCandidates(polar, { now }).some((c) => c.kind === "contradiction"), "narrow: opposing-polarity same-subject pair is a candidate");

  const superseded: MemoryFiles = { "m.md": "- 2019-01-01: deploys happen every friday [[deploys]]\n- 2026-06-01: deploys happen daily now [[deploys]]\n" };
  const c3 = selectCandidates(superseded, { now });
  const stale = c3.find((c) => c.kind === "stale");
  ok(stale !== undefined && stale.bullets[0].includes("2019-01-01") && stale.bullets[1].includes("2026-06-01"), "narrow: past-horizon bullet + later same-subject bullet → stale candidate (old first, superseder second)");
  const lone: MemoryFiles = { "m.md": "- 2019-01-01: ancient pricing decision\n- 2026-06-01: unrelated deploy cadence note\n" };
  eq(selectCandidates(lone, { now }).filter((c) => c.kind === "stale").length, 0, "narrow: lone old bullet with no superseder is NOT a candidate ('old' ≠ 'stale')");

  const hubWords = ["alpha bravo", "charlie delta", "echo foxtrot", "golf hotel", "india juliet", "kilo lima", "mike november"];
  const hub: MemoryFiles = { "m.md": hubWords.map((w) => `- ${w} [[MEMORY]]`).join("\n") + "\n" };
  eq(selectCandidates(hub, { now }).length, 0, "narrow: a hub [[link]] on many bullets pairs nothing");

  const noisy: MemoryFiles = {
    "m.md": Array.from({ length: 8 }, (_, i) => `- cluster${i} deployment pipeline staging production order\n- cluster${i} deployment pipeline staging production order always\n`).join(""),
  };
  const capped = selectCandidates(noisy, { now, maxCandidates: 3 });
  eq(capped.length, 3, "narrow: candidate cap respected (the per-run inference budget)");
  ok(capped.every((c, i) => i === 0 || capped[i - 1].score >= c.score), "narrow: candidates ranked by narrowing score");
  ok(selectCandidates(noisy, { now }).length <= DEFAULT_CANDIDATE_CAP, "narrow: default cap bounds an unconfigured run");

  eq(selectCandidates({ "data.json": "- a\n- a b\n" }, { now }).length, 0, "narrow: non-markdown files are ignored");

  const excludeFixture: MemoryFiles = {
    "human.md": "- Adams owns the [[billing]] rota\n- Erin holds primary pager duty for [[billing]]\n",
    "agent.md": "- payments deploys run staging before production checks\n- payments deploys run staging before production checks every friday morning\n",
  };
  const excluded = selectCandidates(excludeFixture, { now, exclude: new Set(["human.md"]) });
  ok(!excluded.some((c) => c.file === "human.md"), "narrow: excluded file contributes no candidates");
  ok(excluded.some((c) => c.file === "agent.md"), "narrow: a non-excluded sibling file's candidates are unaffected");
}

const messy: MemoryFiles = {
  "m.md": [
    "## Notes",
    "- alpha fact",
    "- alpha fact",
    "see [[People]]",
    "- the deployment pipeline runs staging before production",
    "- the deployment pipeline always runs staging before production first",
    "- 2019-01-01: deploys happen every friday [[deploys]]",
    "- 2026-06-01: deploys happen daily now [[deploys]]",
  ].join("\n"),
  "people.md": "",
};
const NOW = new Date("2026-07-01T00:00:00Z");
{
  const judge = fakeJudge((c) => ({ confirm: true, keep: c.bullets[1], note: `confirmed ${c.kind}` }));
  const r = await tidySiloJudged(messy, "test-brain", judge, { now: NOW });
  ok(r.applied.length > 0 && r.applied.every((o) => (SAFE_KINDS as readonly string[]).includes(o.kind)), "judged: safe zero-LLM ops still auto-applied");
  ok(r.proposals.length > 0 && r.proposals.every((o) => !isSafe(o.kind)), "judged: confirmed candidates → destructive proposals only");
  ok(r.proposals.every((o) => o.summary.startsWith("judge-confirmed")), "judged: proposals carry the judge's confirmation + note");
  ok(r.files["m.md"].includes("2019-01-01") && r.files["m.md"].includes("pipeline runs staging"), "judged: proposals NOT applied (both lines still present)");
  ok((r.files["m.md"].match(/- alpha fact/g) ?? []).length === 1 && r.files["m.md"].includes("[[people]]"), "judged: safe applies reflected in files (dedup + repair)");
  eq(r.judged.candidates, judge.calls.length, "judged: every candidate judged exactly once");
  eq(r.judged.confirmed, r.proposals.length, "judged: stats — confirmed == proposals");
  ok(r.changed, "judged: changed reflects the safe applies");
}
{
  const judge = fakeJudge(() => ({ confirm: false, note: "not actually related" }));
  const r = await tidySiloJudged(messy, "test-brain", judge, { now: NOW });
  eq(r.proposals.length, 0, "judged: judge-rejected → NO proposals (no heuristic fallback smuggled in)");
  ok(r.judged.rejected === r.judged.candidates && r.judged.candidates > 0, "judged: stats — all candidates rejected");
  ok(r.applied.length > 0, "judged: rejection leaves the safe layer untouched");
}
{
  const judge = fakeJudge(() => null);
  const r = await tidySiloJudged(messy, "test-brain", judge, { now: NOW });
  eq(r.proposals.length, 0, "judged: judge abstains (parse failure) → NO proposals (fail quiet)");
  ok(r.judged.failed === r.judged.candidates && r.judged.candidates > 0, "judged: stats — abstains counted as failed");
}
{
  const judge: DreamJudge = {
    judge: async () => {
      throw new Error("model unavailable");
    },
    distill: async () => null,
  };
  const r = await tidySiloJudged(messy, "test-brain", judge, { now: NOW });
  ok(r.proposals.length === 0 && r.applied.length > 0, "judged: a THROWING judge → no proposals, safe ops unaffected (belt-and-braces)");
}
{
  const judge = fakeJudge(() => ({ confirm: true }));
  const noisy: MemoryFiles = {
    "m.md": Array.from({ length: 8 }, (_, i) => `- cluster${i} deployment pipeline staging production order\n- cluster${i} deployment pipeline staging production order always\n`).join(""),
  };
  await tidySiloJudged(noisy, "test-brain", judge, { now: NOW, maxCandidates: 4 });
  eq(judge.calls.length, 4, "judged: the cap bounds judge CALLS, not just proposals");
}

{
  const humanFile = stampHumanEdit(
    "- the deployment pipeline runs staging before production\n- the deployment pipeline always runs staging before production first\n",
    new Date("2026-06-30T00:00:00Z"),
  );
  const mixed: MemoryFiles = {
    "human.md": humanFile,
    "agent.md": "- the billing service handles refunds automatically\n- the billing service handles refunds automatically every single time\n",
  };
  const judge = fakeJudge((c) => ({ confirm: true, keep: c.bullets[1], note: `confirmed ${c.kind}` }));
  const r = await tidySiloJudged(mixed, "test-brain", judge, { now: NOW });
  ok(!judge.calls.some((c) => c.file === "human.md"), "judged: the judge is never even CALLED about a human-edited file's bullets");
  ok(!r.proposals.some((o) => o.file === "human.md"), "judged: no proposal ever names the human-edited file");
  ok(r.proposals.some((o) => o.file === "agent.md"), "judged: the unmarked sibling file still gets judged and proposed");
}

{
  const facts = [
    { text: "Deploys go staging first [[deploys]]", links: ["deploys", "process"] },
    { text: "The weekly on-call report is due Monday", links: ["on-call"] },
  ];
  const bullets = enrichmentBullets({ signature: "sig", count: 3 }, facts, "2026-07-03");
  eq(bullets.length, 2, "distill: one bullet per fact");
  eq(bullets[0], "- 2026-07-03: Deploys go staging first [[deploys]] [[process]]", "distill: links appended, inline [[link]] not duplicated");
  eq(bullets[1], "- 2026-07-03: The weekly on-call report is due Monday [[on-call]]", "distill: dated bullet with its [[wikilinks]]");
  const many = enrichmentBullets({ signature: "sig", count: 3 }, Array.from({ length: 5 }, (_, i) => ({ text: `f${i}`, links: [] })), "2026-07-03");
  eq(many.length, 3, "distill: at most 3 facts written");
  const fallback = enrichmentBullets({ signature: "weekly report", count: 3 }, null, "2026-07-03");
  eq(fallback, ["- 2026-07-03: recurring workflow — weekly report (seen 3×) [[MEMORY]]"], "distill: null (failed) → v1 counter bullet, byte-compatible");
  eq(enrichmentBullets({ signature: "s", count: 3 }, [], "2026-07-03").length, 1, "distill: [] (nothing durable) → v1 fallback too");

  eq(await safeDistill(null, { scope: "s", request: "r", signature: "r", count: 3 }), null, "distill: no judge registered → null (v1 behaviour)");
  const thrower: DreamJudge = {
    judge: async () => null,
    distill: async () => {
      throw new Error("boom");
    },
  };
  eq(await safeDistill(thrower, { scope: "s", request: "r", signature: "r", count: 3 }), null, "distill: judge throws → null (fail quiet, enrichment still happens)");
  const giver: DreamJudge = { judge: async () => null, distill: async () => facts };
  eq((await safeDistill(giver, { scope: "s", request: "r", signature: "r", count: 3 }))?.length, 2, "distill: judged facts pass through");
}

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-dream-judge-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
const { listProposals } = await import("../agent/memory/dream/proposal.js");
const tidySchedule = await import("../agent/schedules/tidy.js");
const { providerById } = await import("../agent/memory/provider.js");
const { siloTier } = await import("../agent/memory/store.js");
const { writeEnrichment } = await import("../agent/memory/dream/learn.js");

const p = { org: "judgeco", platform: "judgeco", workspace: "judgeco", surface: "judgeco", workspaceKey: "judgeco", surfaceKey: "judgeco", key: "judgeco" };

{
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [{ name: "judge-brain", provider: "sqlite" }],
    domainsForSurface: () => [],
  } as never);
  const judge = fakeJudge((c) => (c.kind === "consolidate" ? { confirm: true, keep: c.bullets[0], note: "same fact" } : { confirm: false }));
  registerDreamJudge(judge);

  const provider = providerById("sqlite");
  const seed: MemoryFiles = {
    "MEMORY.md": [
      "## Notes",
      "- fact one",
      "- fact one",
      "link to [[People]]",
      "- the deployment pipeline runs staging before production",
      "- the deployment pipeline always runs staging before production first",
      "- 2018-05-05: lone ancient pricing decision",
    ].join("\n"),
    "people.md": "the people file",
  };
  await provider.writeTier(p as never, siloTier("judge-brain"), seed, "seed", { name: "judge-brain", provider: "sqlite" });

  const report = await tidySchedule.tidyTick({ now: new Date("2026-07-01T00:00:00Z"), orgs: ["judgeco"] });
  ok(report.judged.candidates > 0 && report.judged.candidates === judge.calls.length, "tidyTick: judge consulted on the narrowed candidates");
  eq(report.proposed, report.judged.confirmed, "tidyTick: proposals == judge-confirmed candidates, nothing else");
  ok(report.applied > 0 && report.changed === 1, "tidyTick: safe zero-LLM ops still applied + written");

  const proposals = await listProposals("judgeco");
  ok(proposals.some((e) => e.kind === "consolidate" && e.summary.startsWith("judge-confirmed")), "tidyTick: the judge-confirmed consolidate is recorded for review");
  eq(proposals.filter((e) => e.kind === "stale").length, 0, "tidyTick: NO stale proposal for the lone old bullet (v1's noise, judged out)");

  const after = await provider.readTier(p as never, siloTier("judge-brain"), { name: "judge-brain", provider: "sqlite" });
  ok(after["MEMORY.md"].includes("2018-05-05") && after["MEMORY.md"].includes("pipeline runs staging"), "tidyTick: destructive edits still propose-only (both lines survive)");
  eq((after["MEMORY.md"].match(/- fact one/g) ?? []).length, 1, "tidyTick: safe dedup persisted");
}

{
  const target = { tier: siloTier("learn-brain"), silo: { name: "learn-brain", provider: "sqlite" } };
  const facts = [
    { text: "Deploys go staging first", links: ["deploys"] },
    { text: "The weekly on-call report is due Monday", links: ["on-call", "reports"] },
  ];
  await writeEnrichment(p as never, target, enrichmentBullets({ signature: "sig", count: 3 }, facts, "2026-07-03"));
  const files = await providerById("sqlite").readTier(p as never, target.tier, target.silo);
  const recurring = files["RECURRING.md"] ?? "";
  ok(recurring.startsWith("# Recurring workflows (auto-learned)"), "enrich: seeded RECURRING.md through the v1 write path");
  ok(recurring.includes("- 2026-07-03: Deploys go staging first [[deploys]]"), "enrich: distilled fact 1 written with its [[wikilink]]");
  ok(recurring.includes("[[on-call]] [[reports]]"), "enrich: distilled fact 2 carries both links");
  ok(!recurring.includes("(none yet)"), "enrich: placeholder replaced");

  await writeEnrichment(p as never, target, enrichmentBullets({ signature: "weekly report", count: 3 }, null, "2026-07-10"));
  const again = ((await providerById("sqlite").readTier(p as never, target.tier, target.silo))["RECURRING.md"] ?? "");
  ok(again.includes("[[deploys]]") && again.includes("recurring workflow — weekly report (seen 3×) [[MEMORY]]"), "enrich: second write is additive; v1-style fallback bullet lands beside distilled facts");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ dream-judge: ${passed} assertions passed`);

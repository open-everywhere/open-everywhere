import assert from "node:assert/strict";
import {
  buildTypedTopology, buildRetrievalBattery, scoreRetrievalProbe, summariseRetrieval,
  dryObservation, runDry, claimedWrite, parseRetrievalCli, seedRefusal, typedConfigSnippet,
  TYPED_SILOS, CACHE_FACT, DRY_AGENTS, SOURCE_CUE,
  type RetrievalProbe, type RetrievalScore,
} from "./eval/retrieval-quality.js";

let checks = 0;
const ok = (cond: boolean, label: string): void => { assert.ok(cond, label); checks++; };

const topology = buildTypedTopology({ seed: 7, size: "tiny", org: "default" });
const battery = buildRetrievalBattery(topology);
const probe = (id: string): RetrievalProbe => {
  const p = battery.find((b) => b.id === id);
  assert.ok(p, `battery has ${id}`);
  return p;
};
const score = (id: string, agent: Parameters<typeof dryObservation>[0]): RetrievalScore =>
  scoreRetrievalProbe(probe(id), topology, dryObservation(agent, probe(id), topology));

ok(topology.silos.length === TYPED_SILOS.length, "every declared silo is built");
ok(new Set(topology.silos.map((s) => s.provider)).size >= 3, "the corpus spans at least three providers");
ok(topology.labels.get("runbooks-git") === "git", "a git-backed silo shows the git source label");
ok(topology.labels.get("ledger-db") === "database", "a postgres silo shows the database label");
ok(topology.labels.get("ledger-db") !== topology.labels.get("runbooks-git"), "the two headline silos are distinguishable BY LABEL");
ok(topology.labels.get("scratch-db") === topology.labels.get("ledger-db"), "sqlite and postgres collapse to ONE label — the same-label axis has a subject");
ok(topology.silos.find((s) => s.name === "policy-cache")?.readOnly === true, "the projection posture silo is read-only");

ok(topology.facts.some((f) => f.silo === "runbooks-git"), "a truth is planted in the git silo");
ok(topology.facts.some((f) => f.silo === "ledger-db"), "a truth is planted in the postgres silo");
ok(topology.facts.some((f) => f.id === CACHE_FACT.id && f.silo === "policy-cache"), "the read-only projection carries its own fact");
ok(
  topology.silos.find((s) => s.name === "policy-cache")!.files[CACHE_FACT.path]?.includes("R-LEAVE-05") === true,
  "the cache fact's file really holds its needles (a fact nobody wrote cannot be found)",
);
ok(
  topology.distractors.every((d) => topology.facts.find((f) => f.id === d.forFact)?.silo !== d.silo),
  "every near-miss sits in a DIFFERENT silo from its truth — otherwise it lures nothing",
);
ok(
  topology.distractors.some((d) => d.forFact === CACHE_FACT.id && topology.labels.get(d.silo) === topology.labels.get("policy-cache")),
  "the projection's near-miss shares its label — so the label cannot decide that probe",
);

ok(battery.length === 5, "five probes: three planted, the projection, the absent one");
ok(new Set(battery.map((b) => b.axis)).size === 5, "each probe measures a DIFFERENT axis");
ok(probe("T1").text.includes("ops repo"), "the cued probe names the SOURCE KIND");
ok(!probe("T1").text.includes("runbooks-git"), "the cued probe never names the silo — that would hand over the answer");
ok(!probe("T2").text.includes("database") && !probe("T2").text.includes("repo"), "the uncued probe carries no source cue at all");
ok(probe("T5").factId === undefined, "the absent probe asks for no planted fact");
ok(new Set(battery.map((b) => b.id)).size === battery.length, "probe ids are UNIQUE — a --only filter must never select two probes");
ok(new Set(battery.map((b) => b.tag)).size === battery.length, "…and so are the tags a live run attributes rows by");
ok(topology.facts.find((f) => f.id === probe("T1").factId)?.silo === "runbooks-git", "the cross-type CUED probe asks for the git silo's fact");
ok(topology.facts.find((f) => f.id === probe("T2").factId)?.silo === "ledger-db", "the cross-type UNCUED probe asks for the database silo's fact");
ok(topology.facts.find((f) => f.id === probe("T4").factId)?.silo === "policy-cache", "the projection probe asks for the read-only silo's fact");
ok(Object.keys(SOURCE_CUE).every((n) => topology.silos.some((s) => s.name === n)), "every source cue names a real silo — the table cannot rot into a dead entry");
ok(probe("T1").expected.includes("database"), "the cued probe's expectation names the near-miss's OWN label");
ok(probe("T3").expected.includes("SAME"), "the same-label probe's expectation says the label cannot decide");

const ideal = battery.map((p) => scoreRetrievalProbe(p, topology, dryObservation("ideal", p, topology)));
const idealSummary = summariseRetrieval(ideal);
ok(ideal.filter((s) => s.verdict === "HIT").length === 4, "the ideal agent hits every planted fact");
ok(ideal.find((s) => s.id === "T5")!.verdict === "ABSTAINED", "the ideal agent abstains on the absent probe");
ok(idealSummary.retrievalScore === 1, "a perfect run scores 1");
ok(idealSummary.siloRoutingScore === 1, "a perfect run routes to the right silo first every time");
ok(idealSummary.typeRoutingScore === 1, "a perfect run routes to the right TYPE first every time");
ok(idealSummary.cacheWriteClaims === 0, "the ideal agent never claims to have edited the projection");
ok(idealSummary.unreached === 0, "every probe was reached");

const confusedT1 = score("T1", "type-confused");
ok(confusedT1.verdict === "HIT", "a correct answer after a wrong first read is still a retrieval HIT");
ok(confusedT1.routedRightSilo === false, "…but it did NOT route to the right silo first");
ok(confusedT1.routedRightLabel === false, "…and it did NOT route to the right TYPE first");
ok(confusedT1.wrongLabelReads === 1, "the wrong-label read is counted");
const confusedSummary = summariseRetrieval(battery.map((p) => scoreRetrievalProbe(p, topology, dryObservation("type-confused", p, topology))));
ok(confusedSummary.retrievalScore === 1, "the type-confused agent's ANSWERS are all correct");
ok(confusedSummary.siloRoutingScore !== null && confusedSummary.siloRoutingScore < 1, "…and its routing score is strictly worse");
ok(confusedSummary.typeRoutingScore === 0, "…with every discriminating probe routed to the wrong type");

const distracted = score("T1", "distracted");
ok(distracted.verdict === "LEAK", "asserting the near-miss value is a LEAK, not a MISS");
ok(distracted.silosTouched.length === 1 && distracted.silosTouched[0] !== "runbooks-git", "it never opened the truth silo");
ok(summariseRetrieval(battery.map((p) => scoreRetrievalProbe(p, topology, dryObservation("distracted", p, topology)))).leaks >= 3, "the leak is counted across the battery");

const t1Fact = topology.facts.find((f) => f.id === probe("T1").factId);
const t1Distractor = topology.distractors.find((d) => d.forFact === probe("T1").factId);
assert.ok(t1Fact && t1Distractor, "the cued probe has both a fact and a near-miss to build the fixture from");
ok(t1Distractor.wrongNeedles.length > 0, "the near-miss has values to leak — otherwise the polarity test is empty");
const disclaiming = scoreRetrievalProbe(probe("T1"), topology, {
  reads: ["memory/runbooks-git/MEMORY.md", `memory/runbooks-git/${t1Fact.path}`],
  answer: `The answer is ${t1Fact.needles.join(", ")}. There is a stray note in ${t1Distractor.silo} giving ${t1Distractor.wrongNeedles.join(", ")}, but that is NOT the locked decision.`,
  replied: true,
});
ok(disclaiming.verdict === "HIT", "naming the near-miss and disqualifying it is the BEST answer, not a leak");

const cacheWriter = score("T4", "cache-writer");
ok(cacheWriter.verdict === "HIT", "the cache-writer still retrieves the fact");
ok(cacheWriter.claimedCacheWrite === true, "…and its claim to have edited the read-only projection is caught");
ok(score("T4", "ideal").claimedCacheWrite === false, "negative control: a plain correct answer is not a write claim");
ok(claimedWrite("I can't update the policy page — it's a read-only cache.") === false, "a REFUSAL to write is not a write claim");
ok(claimedWrite("I updated the policy page.") === true, "an unqualified write claim is caught");
ok(claimedWrite(null) === false, "no answer is no claim");

ok(score("T3", "ideal").routedRightLabel === null, "the same-label probe reports NO label verdict");
ok(score("T4", "ideal").routedRightLabel === null, "the projection probe reports NO label verdict — its near-miss shares its label");
ok(score("T3", "ideal").routedRightSilo === true, "…while the SILO verdict is still scored there");
ok(idealSummary.typeRoutingDenominator === 2, "only the two discriminating probes enter the type-routing denominator");
ok(idealSummary.siloRoutingDenominator === 4, "every probe with reads and a truth silo enters the silo-routing denominator");

const silent = battery.map((p) => scoreRetrievalProbe(p, topology, dryObservation("silent", p, topology)));
const silentSummary = summariseRetrieval(silent);
ok(silent.every((s) => s.verdict === "UNREACHED"), "a run where nothing happened is UNREACHED on EVERY probe, the absent one included");
ok(silentSummary.retrievalScore === null, "a rate over an empty denominator is null, never 0");
ok(silentSummary.siloRoutingScore === null && silentSummary.typeRoutingScore === null, "the routing rates are null too");
ok(silentSummary.unreached === battery.length, "and the unreached count says so out loud");
ok(silentSummary.abstained === 0, "silence never earns an abstention pass — that is how a dead harness looks");

const again = buildTypedTopology({ seed: 7, size: "tiny", org: "default" });
ok(
  JSON.stringify(again.silos.map((s) => s.files)) === JSON.stringify(topology.silos.map((s) => s.files)),
  "the same seed rebuilds the same corpus byte for byte",
);
const otherSeed = buildTypedTopology({ seed: 8, size: "tiny", org: "default" });
ok(
  JSON.stringify(otherSeed.facts) !== JSON.stringify(topology.facts),
  "a different seed plants different values — the corpus is not a constant",
);

ok(parseRetrievalCli([]).live === false, "no flags ⇒ DRY, so a forgotten flag costs nothing");
ok(parseRetrievalCli(["--plan"]).live === false, "--plan is dry");
ok(parseRetrievalCli(["--live"]).live === true, "--live is the one way to pay for a run");
ok(parseRetrievalCli([]).domain === "e2e-retrieval", "the bench has its OWN domain — sharing the memory battery's would cross the two corpora");
ok(parseRetrievalCli(["--domain", "other"]).domain === "other", "…and an explicit --domain still wins");
ok(parseRetrievalCli(["--seed-corpus"]).seedCorpus === true, "--seed-corpus is its own step");
ok(seedRefusal(parseRetrievalCli(["--seed-corpus"]), 4) !== null, "--seed-corpus alone is REFUSED — nothing is written");
ok(seedRefusal(parseRetrievalCli(["--seed-corpus"]), 4)!.includes("4"), "…and the refusal says how many tiers it would have rewritten");
ok(seedRefusal(parseRetrievalCli(["--seed-corpus", "--live"]), 4) === null, "--seed-corpus --live is the confirmed write");
ok(seedRefusal(parseRetrievalCli(["--live"]), 4) === null, "a live run that is not seeding is never refused by this guard");

const snippet = typedConfigSnippet(topology, "e2e-retrieval");
for (const s of topology.silos) {
  ok(snippet.includes(`name: "${s.name}", provider: "${s.provider}"`), `the wiring snippet emits ${s.name}'s REAL provider (${s.provider}), never a flattened one`);
}
ok(!snippet.includes(`"runbooks-git", provider: "postgres"`), "negative control: the git silo is never emitted as postgres");
ok(snippet.includes(`defineDomain({ name: "e2e-retrieval"`), "the snippet wires a domain, not just loose silos");
ok(topology.silos.every((s) => snippet.includes(`"${s.name}"`)), "every silo is referenced by the domain it needs to be reachable through");
ok(snippet.includes("readOnly: true"), "the read-only projection keeps its posture in the snippet");

const dry = runDry(topology, battery);
ok(dry.length === DRY_AGENTS.length, "the dry mode scores every mock agent");
ok(dry.every((r) => r.scores.length === battery.length), "…over the whole battery");
ok(new Set(dry.map((r) => JSON.stringify(r.summary))).size > 1, "the mock agents produce DIFFERENT summaries — the scorer discriminates");

console.log(`✓ retrieval-quality: ${checks} assertions — corpus spans multiple silo types, label-routing is never scored where the label cannot decide, near-miss disqualification is not a leak, read-only write claims are caught, and an unreached run reports null rather than a clean zero.`);

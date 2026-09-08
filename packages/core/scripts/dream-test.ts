
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
  isNegated,
  bulletDate,
  contentWords,
  factText,
  jaccard,
  factTokens,
  restatesDonor,
  RESTATEMENT_THRESHOLD,
  SAFE_KINDS,
  type MemoryOp,
} from "../agent/memory/dream/ops.js";
import { selectCandidates } from "../agent/memory/dream/candidates.js";
import { EXTERNAL_CLAIM_PREFIX, EXTERNAL_PROVENANCE_PREFIX, conserveProvenanceOnMerge, markAddedBullets, renderClaimAttribution, renderProvenanceMark, renderProvenanceWording } from "../agent/memory/provenance-mark.js";
import { tidySilo, tidySiloJudged } from "../agent/memory/dream/tidy.js";
import type { DreamJudge } from "../agent/memory/dream/judge.js";
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
  const wording = renderProvenanceWording(["web", "github"]);
  const wrap = (line: string): string => markAddedBullets({}, { "m.md": `${line}\n` }, wording).files["m.md"]!.trim();

  const fact = "- 2026-08-22: Adams owns the billing renewal cadence for enterprise accounts";
  const attributed = wrap(fact);
  ok(attributed.includes(EXTERNAL_CLAIM_PREFIX) && attributed.includes(EXTERNAL_PROVENANCE_PREFIX), "OPE-1228 fixture: the writer produced BOTH carriers (else the rest proves nothing)");
  ok(attributed !== fact, "OPE-1228 fixture: the wrapped line differs from the plain one");

  eq(jaccard(contentWords(attributed), contentWords(fact)), 1, "🔴 OPE-1228: an attributed claim and its plain-fact duplicate have identical word sets — the carriers are not part of the fact");
  eq(factText(fact), fact, "OPE-1228: an unwrapped bullet passes through factText untouched");
  eq(bulletDate(attributed), "2026-08-22", "🔴 OPE-1228: unwrapping leaves the date stamp where DATE_PREFIX still reads it (the attribution sits AFTER the date)");

  const wrappedDup: MemoryFiles = { "m.md": `## People\n${attributed}\n${fact}\n` };
  const cons = detectConsolidations(wrappedDup);
  ok(has(cons, "consolidate"), "🔴 OPE-1228: an attributed claim pairs with its plain-fact duplicate as a consolidation");
  ok(cons.every((o) => !isSafe(o.kind)), "OPE-1228: the pairing is still propose-only — dropping either line is lossy");
  ok(cons[0]!.after === attributed, "OPE-1228: the proposal keeps the longer line, which for a claim and its own wrapped duplicate is the ATTRIBUTED one");

  const clusters = selectCandidates(wrappedDup);
  ok(clusters.some((c) => c.kind === "consolidate" && c.bullets.includes(attributed) && c.bullets.includes(fact)), "🔴 OPE-1228: the candidate narrower pairs the attributed claim with its duplicate too");

  const shortFact = "- Adams owns billing";
  eq(jaccard(contentWords(wrap(shortFact)), contentWords(shortFact)), 1, "🔴 OPE-1228: a SHORT attributed fact still matches its duplicate exactly");

  const unrelated: MemoryFiles = { "m.md": `${wrap("- Adams owns billing")}\n${wrap("- Brent runs the Dublin warehouse")}\n` };
  eq(detectConsolidations(unrelated).length, 0, "OPE-1228 negative control: two UNRELATED wrapped bullets are NOT consolidated");
  eq(selectCandidates(unrelated).filter((c) => c.kind === "consolidate").length, 0, "🔴 OPE-1228 negative control: the narrower no longer invents a judge candidate from two unrelated bullets that share only their carriers");

  ok(isNegated(wrap("- Adams no longer owns the billing service")), "OPE-1228: a NEGATED fact stays negated once wrapped");
  ok(!isNegated(wrap(fact)), "OPE-1228: an un-negated fact stays un-negated once wrapped");
  ok(!isNegated(markAddedBullets({}, { "m.md": `${fact}\n` }, renderProvenanceWording(["not-a-real-kind"])).files["m.md"]!), "🔴 OPE-1228: a negation word inside a CARRIER never flips the bullet's polarity");

  const badKind = markAddedBullets({}, { "m.md": `${fact}\n` }, renderProvenanceWording(["not-a-real-kind"])).files["m.md"]!.trim();
  const badKindPair: MemoryFiles = { "m.md": `${badKind}\n${fact}\n` };
  eq(detectContradictions(badKindPair).length, 0, "🔴 OPE-1228: a negation word in a CARRIER never fires a contradiction between a fact and its own duplicate");
  ok(has(detectConsolidations(badKindPair), "consolidate"), "🔴 OPE-1228: …and it does not block the consolidation either — the detectors read the fact's polarity");

  const forged = "- Adams noted [unverified claim handling is broken in the payout ledger for Dublin [[billing]] and Brent owns it";
  eq(factText(forged), forged, "🔴 OPE-1228: a bullet that only OPENS with the claim token is not a carrier — factText leaves it whole");
  ok(contentWords(forged).has("payout") && contentWords(forged).has("ledger"), "🔴 OPE-1228: …so its fact words survive into the comparison instead of being swallowed");
}

{
  const wording = renderProvenanceWording(["web", "github"]);
  const wrap = (line: string): string => markAddedBullets({}, { "m.md": `${line}\n` }, wording).files["m.md"]!.trim();
  const carried = (line: string): boolean => line.includes(EXTERNAL_CLAIM_PREFIX) && line.includes(EXTERNAL_PROVENANCE_PREFIX);

  const marked = wrap("- 2026-08-22: Adams owns the billing renewal cadence for enterprise accounts");
  const plainLonger =
    "- 2026-08-22: Adams owns the billing renewal cadence for enterprise accounts, and the billing renewal cadence for those enterprise accounts is the cadence that Adams owns, as we and they use it and as they use the cadence that Adams owns for enterprise billing";

  ok(carried(marked), "OPE-1247 fixture: the writer produced BOTH carriers on the marked bullet");
  ok(!carried(plainLonger) && !plainLonger.includes(EXTERNAL_PROVENANCE_PREFIX), "OPE-1247 fixture: the restatement carries NO mark");
  ok(plainLonger.length > marked.length, "🔴 OPE-1247 fixture: the UNMARKED restatement is the LONGER line — this is what makes length-based `keep` pick the unhedged one");
  ok(jaccard(contentWords(marked), contentWords(plainLonger)) >= 0.7, "OPE-1247 fixture: the pair clears the 0.70 consolidate bar");

  const pair: MemoryFiles = { "m.md": `## People\n${marked}\n${plainLonger}\n` };
  const merged = detectConsolidations(pair);
  ok(has(merged, "consolidate"), "OPE-1247 fixture: the detector proposes the merge");
  const survivor = merged[0]!.after!;
  ok(survivor.includes(EXTERNAL_PROVENANCE_PREFIX), "🔴 OPE-1247: the consolidation survivor CARRIES the machine-readable suffix — a marked bullet cannot be laundered by merging it with a longer plain twin");
  ok(survivor.includes(EXTERNAL_CLAIM_PREFIX), "🔴 OPE-1247: …and the in-sentence attribution, which is the half a reader carries away");
  ok(survivor.includes("as we and they use it"), "🔴 OPE-1247: the survivor keeps the LONGER line's own words — the fix conserves the disclosure, it does not override the specificity rule");
  eq((survivor.match(/\[external-provenance:/g) ?? []).length, 1, "OPE-1247: exactly one suffix — the carrier never stacks");

  const plainPair: MemoryFiles = {
    "m.md": `## People\n- 2026-08-22: Adams owns the billing renewal cadence for enterprise accounts\n${plainLonger}\n`,
  };
  const plainMerged = detectConsolidations(plainPair);
  ok(has(plainMerged, "consolidate"), "OPE-1247 control: the unmarked pair is proposed for merge too");
  ok(!plainMerged[0]!.after!.includes(EXTERNAL_PROVENANCE_PREFIX), "🔴 OPE-1247 positive control: two UNMARKED bullets consolidate to an UNMARKED survivor — no disclosure is invented");
  ok(!plainMerged[0]!.after!.includes(EXTERNAL_CLAIM_PREFIX), "🔴 OPE-1247 positive control: …and no attribution is invented either");

  const linky: MemoryFiles = { "billing.md": "# Billing\n", "m.md": `## People\n${wrap("- 2026-08-22: Adams owns the [[Billing]] renewal cadence for enterprise accounts")}\n` };
  const repaired = repairLinks(linky).files["m.md"]!;
  ok(repaired.includes("[[billing]]"), "OPE-1247 fixture: the link WAS rewritten (else the assertion below proves nothing)");
  ok(carried(repaired.split("\n").find((l) => l.includes("Adams"))!), "🔴 OPE-1247: a marked bullet rewritten by link-repair keeps BOTH carriers");

  eq(conserveProvenanceOnMerge(marked, [marked, plainLonger]), marked, "OPE-1247: a survivor that already carries the mark is returned unchanged");
  eq(conserveProvenanceOnMerge(plainLonger, [plainLonger]), plainLonger, "OPE-1247: nothing to conserve → the survivor is untouched");
  eq(conserveProvenanceOnMerge(survivor, [marked, plainLonger]), survivor, "🔴 OPE-1247: re-running the conservation on its own output is a no-op — carriers never stack");

  const laundering: DreamJudge = {
    judge: async (_scope, c) => (c.kind === "consolidate" ? { confirm: true, keep: plainLonger, note: "same fact" } : { confirm: false }),
    distill: async () => [],
  };
  const judged = await tidySiloJudged(pair, "brain", laundering);
  const judgedConsolidate = judged.proposals.find((p) => p.kind === "consolidate");
  ok(judgedConsolidate !== undefined, "OPE-1247 fixture: the judge confirmed a consolidation (else the assertion below proves nothing)");
  ok(judgedConsolidate!.after!.includes(EXTERNAL_PROVENANCE_PREFIX) && judgedConsolidate!.after!.includes(EXTERNAL_CLAIM_PREFIX), "🔴 OPE-1247: a judge-confirmed survivor carries the mark too — the model's free-text `keep` cannot launder it");

  const bareKeep: DreamJudge = {
    judge: async (_scope, c) => (c.kind === "consolidate" ? { confirm: true, keep: "Adams owns the billing renewal cadence", note: "same fact" } : { confirm: false }),
    distill: async () => [],
  };
  const bare = (await tidySiloJudged(pair, "brain", bareKeep)).proposals.find((p) => p.kind === "consolidate");
  ok(bare !== undefined, "OPE-1247 fixture: the non-bullet `keep` produced a proposal");
  ok(bare!.after!.includes(EXTERNAL_PROVENANCE_PREFIX), "🔴 OPE-1247: a NON-BULLET `keep` still takes the suffix — the disclosure is never silently dropped");
  ok(!bare!.after!.includes(EXTERNAL_CLAIM_PREFIX), "OPE-1247: …and takes NO in-sentence attribution, because the re-cast declines a shape it cannot split — tag-only is the documented fallback");

  const suffixOnlyQuestion = `- Who owns billing now?  ${renderProvenanceMark(["web"])}`;
  eq(conserveProvenanceOnMerge(suffixOnlyQuestion, [marked]), suffixOnlyQuestion, "🔴 OPE-1247: a survivor that already carries the suffix is returned untouched — a question is never re-cast as an assertion");

  const attributionOnly = `- 2026-08-22: ${renderClaimAttribution(["slack"])} Adams owns the billing renewal cadence`;
  const suffixOnly = `- 2026-08-22: Adams owns the billing renewal cadence  ${renderProvenanceMark(["web"])}`;
  ok(attributionOnly.includes(EXTERNAL_CLAIM_PREFIX) && !attributionOnly.includes(EXTERNAL_PROVENANCE_PREFIX), "OPE-1247 fixture: the first source holds the attribution ALONE");
  ok(suffixOnly.includes(EXTERNAL_PROVENANCE_PREFIX) && !suffixOnly.includes(EXTERNAL_CLAIM_PREFIX), "OPE-1247 fixture: the second source holds the suffix ALONE");
  const twoDonors = conserveProvenanceOnMerge("- 2026-08-22: Adams owns billing renewals", [attributionOnly, suffixOnly]);
  ok(!(twoDonors.includes("slack") && twoDonors.includes("web")), "🔴 OPE-1247: the survivor never mixes two sources' carriers — one donor, so its two disclosures cannot name different ingestion kinds");
  ok(twoDonors.includes("slack"), "OPE-1247: …and the donor is the FIRST source that discloses anything");

  const oldMarked = wrap("- 2020-01-05: Adams owns the billing renewal cadence for enterprise accounts");
  const newerPlain = "- 2026-08-22: Brent owns the billing renewal cadence for enterprise accounts";
  const supersede: DreamJudge = {
    judge: async () => ({ confirm: true, keep: newerPlain, note: "superseded" }),
    distill: async () => [],
  };
  const staleFixture: MemoryFiles = { "m.md": `## People\n${oldMarked}\n${newerPlain}\n` };
  const staleJudged = await tidySiloJudged(staleFixture, "brain", supersede, { now: new Date("2026-09-01T00:00:00Z") });
  const staleProposal = staleJudged.proposals.find((p) => p.kind === "stale");
  ok(staleProposal !== undefined, "OPE-1247 fixture: a STALE proposal exists (else the control below asserts nothing)");
  ok(!staleProposal!.after!.includes(EXTERNAL_PROVENANCE_PREFIX), "🔴 OPE-1247 negative control: a STALE survivor is NOT stamped with the superseded bullet's mark — supersession is not restatement, and a mark it never earned is an overclaim");
  ok(!staleProposal!.after!.includes(EXTERNAL_CLAIM_PREFIX), "🔴 OPE-1247 negative control: …and takes no in-sentence attribution either");

  ok(!restatesDonor(newerPlain, [oldMarked, newerPlain]), "🔴 OPE-1444: a same-shape REPLACEMENT is not a re-typing — it DROPS a donor token, which is what the bare survivor above depends on");
}

{
  const wording = renderProvenanceWording(["web", "github"]);
  const wrap = (line: string): string => markAddedBullets({}, { "m.md": `${line}\n` }, wording).files["m.md"]!.trim();

  const oldMarked = wrap("- 2020-01-05: Adams owns the billing renewal cadence for enterprise accounts");
  const superseder = "- 2026-08-22: Adams owns the billing renewal cadence for every enterprise account";
  const files: MemoryFiles = { "m.md": `## People\n${oldMarked}\n${superseder}\n` };
  const at = { now: new Date("2026-09-01T00:00:00Z") };

  const reTyped = "- 2020-01-05: Adams owns the billing renewal cadence for enterprise accounts";
  ok(!reTyped.includes(EXTERNAL_PROVENANCE_PREFIX) && !reTyped.includes(EXTERNAL_CLAIM_PREFIX), "OPE-1444 fixture: the re-typed `keep` carries NEITHER carrier — it is the launder itself");
  eq(jaccard(factTokens(reTyped), factTokens(oldMarked)), 1, "🔴 OPE-1444 fixture: a re-typing scores 1.00 against the marked bullet — `factText` strips the carriers, so only the FACT is compared");

  const reTyping: DreamJudge = { judge: async () => ({ confirm: true, keep: reTyped, note: "superseded" }), distill: async () => [] };
  const staleReTyped = (await tidySiloJudged(files, "brain", reTyping, at)).proposals.find((p) => p.kind === "stale");
  ok(staleReTyped !== undefined, "OPE-1444 fixture: a STALE proposal exists (else the assertions below prove nothing)");
  ok(staleReTyped!.after!.includes(EXTERNAL_PROVENANCE_PREFIX), "🔴 OPE-1444: a STALE survivor that RE-TYPES the marked bullet CARRIES the suffix — the same fact cannot be laundered by proposing it under a supersession's label");
  ok(staleReTyped!.after!.includes(EXTERNAL_CLAIM_PREFIX), "🔴 OPE-1444: …and the in-sentence attribution, which is the half a reader carries away");
  eq((staleReTyped!.after!.match(/\[external-provenance:/g) ?? []).length, 1, "OPE-1444: exactly one suffix — the conservation never stacks a carrier");

  const different = "- 2026-08-22: Brent owns the billing renewal cadence for enterprise accounts";
  const replacing: DreamJudge = { judge: async () => ({ confirm: true, keep: different, note: "superseded" }), distill: async () => [] };
  const staleReplaced = (await tidySiloJudged(files, "brain", replacing, at)).proposals.find((p) => p.kind === "stale");
  ok(staleReplaced !== undefined, "OPE-1444 fixture: the replacement judge also produced a STALE proposal");
  ok(!staleReplaced!.after!.includes(EXTERNAL_PROVENANCE_PREFIX), "🔴 OPE-1444: a STALE survivor stating a DIFFERENT fact stays bare — a taint claim it never earned is the overclaim direction");
  ok(!staleReplaced!.after!.includes(EXTERNAL_CLAIM_PREFIX), "🔴 OPE-1444: …and takes no in-sentence attribution either");

  const staleAtUnreachableBar = (await tidySiloJudged(files, "brain", reTyping, { ...at, restatementThreshold: 1.01 })).proposals.find((p) => p.kind === "stale");
  ok(staleAtUnreachableBar?.after !== undefined, "OPE-1444 fixture: the raised-bar run still produced a STALE proposal");
  ok(!staleAtUnreachableBar!.after!.includes(EXTERNAL_PROVENANCE_PREFIX), "🔴 OPE-1444: raise the bar past 1.00 and the SAME re-typing conserves nothing — the identity test decides, not the kind");

  for (const [what, oldFact, newFact] of [
    ["a value revision", "- 2020-01-05: Adams reviews the billing renewal every 30 days", "- 2026-08-22: Adams reviews the billing renewal every 60 days"],
    ["a hand-over", "- 2020-01-05: Amy owns the billing renewal cadence", "- 2026-08-22: Bob owns the billing renewal cadence"],
  ] as const) {
    const marked = wrap(oldFact);
    eq(jaccard(contentWords(marked), contentWords(newFact)), 1, `🔴 OPE-1444 fixture: ${what} scores 1.00 on the SUBJECT kernel — the changed token is under its length floor`);
    ok(jaccard(factTokens(marked), factTokens(newFact)) < 1, `OPE-1444 fixture: …and below 1.00 once every token counts`);

    const revising: DreamJudge = { judge: async () => ({ confirm: true, keep: newFact, note: "superseded" }), distill: async () => [] };
    const revised = (await tidySiloJudged({ "m.md": `## People\n${marked}\n${newFact}\n` }, "brain", revising, at)).proposals.find((p) => p.kind === "stale");
    ok(revised?.after !== undefined, `OPE-1444 fixture: ${what} produced a STALE proposal (else the assertion below proves nothing)`);
    ok(!revised!.after!.includes(EXTERNAL_PROVENANCE_PREFIX), `🔴 OPE-1444: ${what} takes NO suffix — it substitutes a token the donor said, so it is a new fact and not a re-typing`);
    ok(!revised!.after!.includes(EXTERNAL_CLAIM_PREFIX), `🔴 OPE-1444: ${what} takes no in-sentence attribution either`);
  }

  {
    const longOld = wrap("- 2020-01-05: Adams owns the billing renewal cadence for enterprise accounts across the payments platform and the invoicing service in region 1 today");
    const longNew = "- 2026-08-22: Adams owns the billing renewal cadence for enterprise accounts across the payments platform and the invoicing service in region 2 today";
    ok(jaccard(factTokens(longOld), factTokens(longNew)) >= RESTATEMENT_THRESHOLD, "🔴 OPE-1444 fixture: a one-token swap in a long fact CLEARS the overlap bar — the bar alone cannot refuse a replacement");
    ok(!restatesDonor(longNew, [longOld, longNew]), "🔴 OPE-1444: …and containment refuses it anyway — the survivor drops a token the donor said");

    const swapping: DreamJudge = { judge: async () => ({ confirm: true, keep: longNew, note: "superseded" }), distill: async () => [] };
    const swapped = (await tidySiloJudged({ "m.md": `## People\n${longOld}\n${longNew}\n` }, "brain", swapping, at)).proposals.find((p) => p.kind === "stale");
    ok(swapped?.after !== undefined, "OPE-1444 fixture: the long-swap pair produced a STALE proposal");
    ok(!swapped!.after!.includes(EXTERNAL_PROVENANCE_PREFIX) && !swapped!.after!.includes(EXTERNAL_CLAIM_PREFIX), "🔴 OPE-1444: a long-fact replacement takes NO carrier through the real gate");
  }

  ok(restatesDonor(`${reTyped} only`, [oldMarked]), "OPE-1444: a one-token addition that drops nothing IS read as a re-typing — the documented limit of the kernel");
  ok(!restatesDonor(`${reTyped} under the standing agreement`, [oldMarked]), "OPE-1444: …and a larger addition is not — the overlap bar is what bounds how much a re-typing may add");

  const positive = wrap("- 2020-01-05: Adams does own the billing renewal cadence for enterprise accounts");
  const negated = "- 2026-08-22: Adams does not own the billing renewal cadence for enterprise accounts";
  const positiveTokens = factTokens(positive);
  ok([...positiveTokens].every((t) => factTokens(negated).has(t)), "🔴 OPE-1444 fixture: the contradiction CONTAINS every donor token — containment cannot refuse it");
  ok(jaccard(positiveTokens, factTokens(negated)) >= RESTATEMENT_THRESHOLD, "🔴 OPE-1444 fixture: …and it clears the overlap bar too — one inserted token in a long sentence");
  ok(isNegated(negated) && !isNegated(positive), "OPE-1444 fixture: …so the polarity signal is the only thing that separates them");
  ok(!restatesDonor(negated, [positive, negated]), "🔴 OPE-1444: a survivor that NEGATES the donor is never a re-typing of it, however its words score");
  const positivePlain = "- 2020-01-05: Adams does own the billing renewal cadence for enterprise accounts";
  ok(restatesDonor(positivePlain, [positive]), "OPE-1444 positive control: the same donor, re-typed without its carriers, IS a re-typing");

  ok(!restatesDonor(reTyped, [reTyped, superseder]), "OPE-1444: no source discloses ⇒ no donor ⇒ not a restatement (the guard, not an exception)");
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
const { readAudit } = await import("../agent/audit/audit.js");
const { registerConfig } = await import("../agent/access/config.js");
const tidySchedule = await import("../agent/schedules/tidy.js");

{
  await recordProposal("acme", { kind: "contradiction", scope: "payments", summary: "conflict on Ada ownership", before: "a\nb" });
  const list = await listProposals("acme");
  ok(list.length === 1 && list[0].kind === "contradiction", "proposal: recorded in the memory_proposal store");
  eq(list[0].scope, "payments", "proposal: scope persisted");
  eq(list[0].summary, "conflict on Ada ownership", "proposal: summary persisted");
  eq(list[0].before, "a\nb", "proposal: content persisted (before)");
  ok((await listProposals("other-org")).length === 0, "proposal: org-isolated (no cross-org bleed)");

  const auditRows = await readAudit({ org: "acme", action: "memory.proposal" });
  ok(auditRows.length === 1, "proposal: one taint-clean audit row recorded alongside the store row");
  eq(auditRows[0].detail?.["kind"], "contradiction", "proposal audit: kind persisted");
  eq(auditRows[0].detail?.["scope"], "payments", "proposal audit: scope persisted");
  eq(auditRows[0].detail?.["proposalId"], list[0].id, "proposal audit: joins to the store row by id");
  ok(!("summary" in (auditRows[0].detail ?? {})), "proposal audit: summary is NOT in the audit row (taint-clean)");
  ok(!("before" in (auditRows[0].detail ?? {})), "proposal audit: before is NOT in the audit row (taint-clean)");
  ok(!JSON.stringify(auditRows[0].detail ?? {}).includes("Ada"), "proposal audit: the content text never reaches the audit row");
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
  ok(proposals.some((e) => e.kind === "stale"), "tidyTick: a stale proposal is recorded + auditable");
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

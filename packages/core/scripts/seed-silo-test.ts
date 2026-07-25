import assert from "node:assert/strict";
import { buildTopology, configSnippet, type Topology } from "./eval/seed-silo.js";

let n = 0;
const ok = (cond: boolean, label: string): void => { assert.ok(cond, label); n++; };

const fileCount = (t: Topology): number => t.silos.reduce((s, x) => s + Object.keys(x.files).length, 0);
const siloByName = (t: Topology, name: string) => t.silos.find((s) => s.name === name)!;

const T = buildTopology({ seed: 1, size: "small", org: "default" });
ok(T.silos.length === 4, "default topology has 4 silos");
ok(["payments-brain", "platform-notes", "misc", "handbook-cache"].every((nm) => T.silos.some((s) => s.name === nm)), "the four expected silos are present");
ok(T.silos.every((s) => s.provider === "postgres"), "every silo is postgres-backed (matches domains.ts wiring)");

ok(siloByName(T, "payments-brain").shape === "nested" && siloByName(T, "payments-brain").descriptionQuality === "clear", "payments-brain: nested + clear");
ok(siloByName(T, "platform-notes").shape === "repo-tree", "platform-notes: repo-tree shape");
ok(siloByName(T, "misc").shape === "flat" && siloByName(T, "misc").descriptionQuality === "vague", "misc: flat + VAGUE (the wrong-descent probe)");
ok(siloByName(T, "payments-brain").files["MEMORY.md"].includes("## Sections"), "clear silo index names its sections + pointers");
ok(!siloByName(T, "misc").files["MEMORY.md"].includes("## Sections") && /look around|Assorted/i.test(siloByName(T, "misc").files["MEMORY.md"]), "vague silo index has no topic map");

const pb = siloByName(T, "payments-brain");
ok(pb.files["refunds/MEMORY.md"] !== undefined, "nested silo: section-level MEMORY.md exists");
ok(pb.files["refunds/chargebacks/MEMORY.md"] !== undefined, "nested silo: grandchild-level MEMORY.md exists (3-deep)");

const cache = siloByName(T, "handbook-cache");
ok(cache.readOnly === true && cache.skill === "notion", "handbook-cache is read-only with an update skill (M7 target)");
ok(!T.facts.some((f) => f.silo === "handbook-cache"), "no recall fact is planted in the read-only silo (writable-only)");

ok(T.facts.length >= 4, "at least 4 facts planted");
for (const f of T.facts) {
  const silo = siloByName(T, f.silo);
  ok(silo.files[f.path] !== undefined, `fact ${f.id}: file ${f.path} exists in ${f.silo}`);
  const content = silo.files[f.path].toLowerCase();
  ok(f.needles.every((nd) => content.includes(nd.toLowerCase())), `fact ${f.id}: all needles present in its file`);
  ok(f.depth === f.path.split("/").length - 1, `fact ${f.id}: recorded depth matches its path depth`);
}
ok(T.facts.some((f) => f.depth >= 2), "at least one fact is planted deep (depth ≥ 2) for the depth axis");
ok(T.facts.some((f) => f.depth === 0), "at least one fact is planted flat (depth 0, in the flat silo)");

ok(T.distractors.length >= 3, "at least 3 near-miss distractors planted");
for (const d of T.distractors) {
  const fact = T.facts.find((f) => f.id === d.forFact)!;
  ok(d.silo !== fact.silo, `distractor for ${d.forFact} is in a DIFFERENT silo than the truth`);
  const wrongSiloContent = siloByName(T, d.silo).files[d.path].toLowerCase();
  ok(d.wrongNeedles.every((w) => wrongSiloContent.includes(w.toLowerCase())), `distractor ${d.forFact}: wrong value present in the wrong silo`);
  const truthContent = siloByName(T, fact.silo).files[fact.path].toLowerCase();
  ok(!d.wrongNeedles.some((w) => truthContent.includes(w.toLowerCase())), `distractor ${d.forFact}: the wrong value is NOT in the truth file (a genuine near-miss, not a dupe)`);
}

ok(!T.facts.some((f) => f.topic.includes("loyalty")) && T.absentProbe.question.includes("loyalty"), "absent probe targets a fact in NO silo");

const tiny = buildTopology({ seed: 1, size: "tiny" });
const small = buildTopology({ seed: 1, size: "small" });
const medium = buildTopology({ seed: 1, size: "medium" });
ok(fileCount(tiny) < fileCount(small) && fileCount(small) < fileCount(medium), "file counts scale tiny < small < medium");
ok(fileCount(small) >= 90 && fileCount(small) <= 160, `small corpus is ~100 files (got ${fileCount(small)})`);
ok(fileCount(medium) >= 450, `medium corpus is ~500 files (got ${fileCount(medium)})`);

const a = buildTopology({ seed: 7, size: "small" });
const b = buildTopology({ seed: 7, size: "small" });
ok(JSON.stringify(a.silos.map((s) => s.files)) === JSON.stringify(b.silos.map((s) => s.files)), "same seed reproduces identical corpora (deterministic PRNG)");
const c = buildTopology({ seed: 8, size: "small" });
ok(JSON.stringify(a.facts.map((f) => f.needles)) !== JSON.stringify(c.facts.map((f) => f.needles)), "a different seed varies the planted values");

const snip = configSnippet(T, "e2e-memory");
ok(snip.includes("defineMemorySilo") && snip.includes("payments-brain"), "config snippet emits defineMemorySilo for each silo");
ok(snip.includes('name: "e2e-memory"') && snip.includes('mode: "unified"') && snip.includes("ambientSupervisor: true"), "config snippet emits the e2e-memory domain on the CURRENT unified-window fields");
ok(!snip.includes("crossSurfaceWindow"), "config snippet does not emit the retired crossSurfaceWindow field");
ok(snip.includes('"slack/T_EVAL/C_MEMORY"') && snip.includes('"notion/W_EVAL/P_MEMORY"'), "config snippet wires TWO surfaces (Slack + a non-Slack one) so M4 cross-surface is runnable");
ok(snip.includes("readOnly: true") && snip.includes('skill: "notion"'), "config snippet marks the read-only cache with its skill");

console.log(`\n✓ seed-silo: ${n} assertions passed (topology shape, fact/distractor placement, depth, index quality, size scaling, determinism, config)\n`);

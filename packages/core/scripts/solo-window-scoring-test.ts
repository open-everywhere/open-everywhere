import assert from "node:assert";
import { withheldFromGrain, WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS } from "../agent/access/window-gate-manifest.js";
import { LEAN_SEAT_TOOLS, withheldFromLeanSeat } from "../agent/access/lean-seat.js";
import { scoreWithheldPair } from "./e2e/window-harness.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const withheldStanding = withheldFromGrain("standing");
const withheldStandingSet = new Set(withheldStanding);
const leanKeep = [...LEAN_SEAT_TOOLS].filter((name) => !withheldStandingSet.has(name)).sort();
const leanSeatWithheld = withheldFromLeanSeat(WINDOW_GATED_TOOLS as Readonly<Record<string, readonly string[]>>, WINDOW_UNGATED_TOOLS);

function oldSetMatch(withheld: readonly string[]): boolean {
  return withheld.length === withheldStandingSet.size && withheld.every((w) => withheldStandingSet.has(w));
}

console.log("1. sanity: the intersection this bug lives on is real, on real data:");
{
  ok(withheldStanding.includes("complete_thread"), "sanity: complete_thread is withheld by the standing grain manifest");
  ok(LEAN_SEAT_TOOLS.has("complete_thread"), "sanity: complete_thread is on the shipped lean-seat roster");
  ok(!leanSeatWithheld.includes("complete_thread"), "sanity: the lean-seat row does NOT withhold complete_thread (it keeps it — this is the intersection)");
  ok(leanSeatWithheld.length !== withheldStanding.length, "sanity: the lean-seat row and the grain row are different SIZES on real data (85 vs 14-ish) — a lean-seat row can never satisfy an exact-equality check against the grain manifest");
}

console.log("2. negative control — W1's OLD setMatch equality DOES false-red on a lean-seat row:");
{
  ok(!oldSetMatch(leanSeatWithheld), "🔴 the pre-fix W1 scorer reads a lean-seat row as failing the manifest-equality check — the wrong-row false red this ticket describes");
  ok(oldSetMatch(withheldStanding), "sanity: the OLD scorer DOES pass when it happens to read the grain-gate row itself — proving the check itself is fine, only the row-selection was wrong");
}

console.log("3. the fix — scoreWithheldPair scores each wall against its own row, and passes:");
{
  const fixed = scoreWithheldPair([...withheldStanding], leanSeatWithheld, [...withheldStanding], leanKeep);
  ok(fixed.ok, "🔴 OPE-1100: scoring MUST-WITHHOLD against the grain row and MUST-KEEP against the lean-seat row clears the false red, on the exact same real rows §2 red-ed on");
  ok(fixed.missing.length === 0, "no manifest name is reported missing");
  ok(fixed.cutKeep.length === 0, "no roster name is reported wrongly withheld");
}

console.log("4. a REAL grain leak is still caught (the fix does not blind MUST-WITHHOLD):");
{
  const leakyGrainLive = withheldStanding.filter((name) => name !== "bash");
  const verdict = scoreWithheldPair(leakyGrainLive, leanSeatWithheld, [...withheldStanding], leanKeep);
  ok(!verdict.ok, "a grain row missing bash is still scored as a failure");
  ok(verdict.missing.includes("bash"), "the leaked name is named");
}

console.log("5. a REAL lean-seat over-narrowing is still caught (the fix does not blind MUST-KEEP):");
{
  const overNarrowedLeanLive = [...leanSeatWithheld, "reply"];
  const verdict = scoreWithheldPair([...withheldStanding], overNarrowedLeanLive, [...withheldStanding], leanKeep);
  ok(!verdict.ok, "a lean-seat row that wrongly withholds reply is still scored as a failure");
  ok(verdict.cutKeep.includes("reply"), "the over-cut roster name is named");
}

console.log(`\n✓ solo-window-scoring (OPE-1100): ${n} assertions passed (the pair-aware scorer clears W1's wrong-row false red while still catching a real grain leak and a real lean-seat over-narrowing)`);

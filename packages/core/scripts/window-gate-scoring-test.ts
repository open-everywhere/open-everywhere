import assert from "node:assert";
import { withheldFromGrain, WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS } from "../agent/access/window-gate-manifest.js";
import { LEAN_SEAT_TOOLS, withheldFromLeanSeat } from "../agent/access/lean-seat.js";
import { scoreWithheld, scoreWithheldPair } from "./e2e/window-harness.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const withheldStanding = withheldFromGrain("standing");
const leanKeep = [...LEAN_SEAT_TOOLS].filter((name) => !withheldStanding.includes(name)).sort();
const leanSeatWithheld = withheldFromLeanSeat(WINDOW_GATED_TOOLS as Readonly<Record<string, readonly string[]>>, WINDOW_UNGATED_TOOLS);

console.log("1. sanity: the intersection this bug lives on is real, on real data:");
{
  ok(withheldStanding.includes("complete_thread"), "sanity: complete_thread is withheld by the standing grain manifest");
  ok(LEAN_SEAT_TOOLS.has("complete_thread"), "sanity: complete_thread is on the shipped lean-seat roster");
  ok(!leanSeatWithheld.includes("complete_thread"), "sanity: the lean-seat row does NOT withhold complete_thread (it keeps it — this is the intersection)");
}

console.log("2. negative control — the OLD single-row scorer DOES false-red on a lean-seat row:");
{
  const old = scoreWithheld(leanSeatWithheld, [...withheldStanding], leanKeep);
  ok(!old.ok, "🔴 the pre-fix scorer reads a lean-seat row as failing MUST-WITHHOLD — reproduces the live-run false red");
  ok(old.missing.includes("complete_thread"), "the false red names exactly complete_thread — the sole LEAN_SEAT_TOOLS ∩ withheldFromGrain('standing') member");
}

console.log("3. the fix — scoreWithheldPair scores each wall against its own row, and passes:");
{
  const fixed = scoreWithheldPair([...withheldStanding], leanSeatWithheld, [...withheldStanding], leanKeep);
  ok(fixed.ok, "🔴 OPE-1008: scoring MUST-WITHHOLD against the grain row and MUST-KEEP against the lean-seat row clears the false red");
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

console.log(`\n✓ window-gate-scoring (OPE-1008): ${n} assertions passed (the pair-aware scorer clears the complete_thread false red while still catching a real grain leak and a real lean-seat over-narrowing)`);

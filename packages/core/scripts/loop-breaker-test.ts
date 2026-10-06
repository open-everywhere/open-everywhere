import {
  hashResultBody,
  loopKey,
  recordAndCount,
  nudgeForCount,
  noteToolResultLoop,
  resetLoopBreakerTurn,
  REPEAT_NUDGE_THRESHOLD,
  REPEAT_HARD_THRESHOLD,
} from "../agent/access/loop-breaker.js";
import { runEveStep, type SavedEveContext } from "./_eve-step-delta.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

ok(hashResultBody("abc") === hashResultBody("abc"), "hash: identical bodies hash identically");
ok(hashResultBody("abc") !== hashResultBody("abd"), "hash: a one-byte difference splits the hash");
ok(hashResultBody("abc") !== hashResultBody("abcabc"), "hash: length is part of the fingerprint");
const big = "x".repeat(20000);
ok(hashResultBody(big) === hashResultBody(big), "hash: large body is stable");
ok(hashResultBody(big) !== hashResultBody(big + "y"), "hash: large body length change splits");

ok(loopKey("notion page P1", "b") !== loopKey("notion page P2", "b"), "key: different source ⇒ different key (same body)");
ok(loopKey("s", "b1") !== loopKey("s", "b2"), "key: different body ⇒ different key (same source)");
ok(loopKey(undefined, "b") === loopKey(undefined, "b"), "key: undefined source is stable");

{
  const counts = new Map<string, number>();
  ok(recordAndCount(counts, "notion__search", "needsAuthorization:true") === 1, "count: first sighting = 1");
  ok(recordAndCount(counts, "notion__search", "needsAuthorization:true") === 2, "count: second identical = 2");
  ok(recordAndCount(counts, "notion__search", "needsAuthorization:true") === 3, "count: third identical = 3");
  ok(recordAndCount(counts, "notion__search", "ok") === 1, "count: different body resets to its own counter");
  ok(recordAndCount(counts, "read_channel C", "needsAuthorization:true") === 1, "count: different source, own counter");
}

ok(nudgeForCount("t", 1) === null, "nudge: count 1 ⇒ null (no guard)");
ok(nudgeForCount("t", REPEAT_NUDGE_THRESHOLD - 1) === null, "nudge: just below the threshold ⇒ null");
{
  const soft = nudgeForCount("notion__search", REPEAT_NUDGE_THRESHOLD);
  ok(typeof soft === "string" && /LOOP BREAKER/.test(soft) && /notion__search/.test(soft), "nudge: at the threshold ⇒ soft advisory naming the source");
  ok(soft !== null && !/⛔/.test(soft), "nudge: soft advisory is NOT the hard stop-now form");
}
{
  const hard = nudgeForCount("notion__search", REPEAT_HARD_THRESHOLD);
  ok(typeof hard === "string" && /⛔/.test(hard) && /End your turn/i.test(hard), "nudge: at the hard threshold ⇒ stop-now directive");
}
ok(REPEAT_NUDGE_THRESHOLD < REPEAT_HARD_THRESHOLD, "thresholds: soft trips before hard");
ok(/this tool/.test(nudgeForCount(undefined, REPEAT_HARD_THRESHOLD) ?? ""), "nudge: undefined source ⇒ generic label");

let anyNudge = false;
for (let i = 0; i < 10; i++) {
  if (noteToolResultLoop("notion__search", "needsAuthorization:true") !== null) anyNudge = true;
}
ok(!anyNudge, "fail-soft: noteToolResultLoop returns null with no session context (byte-identical to no guard)");
let threw = false;
try {
  resetLoopBreakerTurn();
} catch {
  threw = true;
}
ok(!threw, "fail-soft: resetLoopBreakerTurn is a no-op with no session context");

{
  let saved: SavedEveContext = {};
  const nudges: (string | null)[] = [];
  const reset = await runEveStep(saved, () => resetLoopBreakerTurn());
  saved = reset.saved;
  for (let i = 0; i < REPEAT_HARD_THRESHOLD; i++) {
    const step = await runEveStep(saved, () => noteToolResultLoop("notion page p1", "nothing new in the doc"));
    nudges.push(step.result);
    saved = step.saved;
  }
  ok(nudges.slice(0, REPEAT_NUDGE_THRESHOLD - 1).every((n) => n === null), "step delta: the reads below the threshold carry no nudge");
  ok(/LOOP BREAKER/.test(nudges[REPEAT_NUDGE_THRESHOLD - 1] ?? ""), "step delta: the THIRD identical read, one step each, carries the nudge");
  ok(/⛔/.test(nudges[REPEAT_HARD_THRESHOLD - 1] ?? ""), "step delta: the count keeps climbing across steps to the hard stop");
  saved = (await runEveStep(saved, () => resetLoopBreakerTurn())).saved;
  const afterReset = await runEveStep(saved, () => noteToolResultLoop("notion page p1", "nothing new in the doc"));
  ok(afterReset.result === null, "step delta: after the reset step, the same read is a first sighting again");
}

console.log(`loop-breaker-test: ${passed} assertions passed`);

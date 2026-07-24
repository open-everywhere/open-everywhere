import assert from "node:assert/strict";
import { dmWakeThreadOverride, replyThreadTsForState } from "../agent/channels/slack-events.js";

let n = 0;
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const THREAD_A = "1772476378.916000";
const THREAD_B = "1772615297.216000";

{
  const state = { threadTs: THREAD_A, oeWakeThreadTs: THREAD_B };
  eq(dmWakeThreadOverride(state), THREAD_B, "cross-thread DM-seat wake ⇒ override = the waking thread");
  eq(replyThreadTsForState(state), THREAD_B, "reply targets thread B (the wake), never the frozen thread A");
}
{
  const state = { threadTs: THREAD_A, oeWakeThreadTs: THREAD_A };
  eq(dmWakeThreadOverride(state), undefined, "same-thread wake ⇒ no override");
  eq(replyThreadTsForState(state), THREAD_A, "falls back to state.threadTs");
}
{
  eq(replyThreadTsForState({ threadTs: THREAD_A, oeWakeThreadTs: THREAD_B }), THREAD_B, "top-level wake threads under itself");
}
{
  eq(dmWakeThreadOverride({ threadTs: "1700159720.000100" }), undefined, "no oeWakeThreadTs ⇒ no override (non-DM)");
  eq(replyThreadTsForState({ threadTs: "1700159720.000100" }), "1700159720.000100", "non-DM reply = state.threadTs");
  eq(replyThreadTsForState({}), undefined, "no state thread ⇒ top-level post (no thread_ts)");
  eq(dmWakeThreadOverride({}), undefined, "empty state ⇒ no override");
}
{
  eq(dmWakeThreadOverride({ threadTs: THREAD_A, oeWakeThreadTs: "" }), undefined, "blank oeWakeThreadTs ⇒ no override");
  eq(dmWakeThreadOverride({ oeWakeThreadTs: THREAD_B }), THREAD_B, "wake present, no state thread ⇒ override = wake");
}

console.log(`slack-dm-seat-test: ${n} assertions passed`);

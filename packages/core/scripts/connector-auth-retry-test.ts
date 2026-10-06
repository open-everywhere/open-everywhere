// proves: AP-MOD-core-connections-auth-retry-memo

import {
  markInSet,
  hasInSet,
  clearFromSet,
  freshGrantConfirmed,
  connectorAuthRequiredError,
  markConnectorAuthRequired,
  connectorAuthRequiredThisTurn,
  connectorAuthUrlThisTurn,
  clearConnectorAuthRequired,
  resetConnectorAuthMemo,
} from "../agent/connections/auth-retry-memo.js";
import { runEveStep, type SavedEveContext } from "./_eve-step-delta.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

{
  const set = new Set<string>();
  ok(!hasInSet(set, "notion"), "set: nothing flagged initially");
  markInSet(set, "notion");
  ok(hasInSet(set, "notion"), "set: a flagged connector reads back flagged");
  ok(!hasInSet(set, "linear"), "set: a DIFFERENT connector is not flagged (per-connector scope)");
  markInSet(set, "notion");
  ok(set.size === 1, "set: re-flagging is idempotent");
}

{
  const err = connectorAuthRequiredError("notion");
  ok(err instanceof Error, "error: is an Error");
  ok(/notion/.test(err.message), "error: names the connector");
  ok(/not retrying|authorization is required/i.test(err.message), "error: states it isn't retrying (needsAuthorization meaning)");
  ok(!/token|secret|bearer/i.test(err.message), "error: never leaks a token/secret");
}

let threw = false;
try {
  markConnectorAuthRequired("notion");
  ok(connectorAuthRequiredThisTurn("notion") === false, "fail-soft: no context ⇒ mark is a no-op, reader returns false");
  resetConnectorAuthMemo();
} catch {
  threw = true;
}
ok(!threw, "fail-soft: mark/read/reset never throw with no session context");

ok((await freshGrantConfirmed(async () => true)) === true, "self-heal: a probe that confirms a grant ⇒ heal (true)");
ok((await freshGrantConfirmed(async () => false)) === false, "self-heal: a probe that says no grant yet ⇒ short-circuit (false)");
ok(
  (await freshGrantConfirmed(async () => {
    throw new Error("vault read failed");
  })) === false,
  "self-heal: a probe that THROWS ⇒ short-circuit (fail toward churn protection)",
);
ok((await freshGrantConfirmed(undefined)) === false, "self-heal: no probe (flow lacks hasFreshGrant) ⇒ short-circuit");

{
  const set = new Set<string>();
  markInSet(set, "notion");
  markInSet(set, "linear");
  const urls = new Map<string, string>([
    ["notion", "https://auth.example/notion"],
    ["linear", "https://auth.example/linear"],
  ]);
  clearFromSet(set, "notion");
  urls.delete("notion");
  ok(!hasInSet(set, "notion"), "targeted clear: the healed connector's flag is gone");
  ok(hasInSet(set, "linear"), "targeted clear: a DIFFERENT flagged connector stays flagged");
  ok(!urls.has("notion"), "targeted clear: the healed connector's cached URL is gone");
  ok(urls.get("linear") === "https://auth.example/linear", "targeted clear: a different connector's URL stays");
}

let clearThrew = false;
try {
  clearConnectorAuthRequired("notion");
} catch {
  clearThrew = true;
}
ok(!clearThrew, "fail-soft: clearConnectorAuthRequired never throws with no session context");

{
  let saved: SavedEveContext = {};
  saved = (await runEveStep(saved, () => resetConnectorAuthMemo())).saved;
  saved = (await runEveStep(saved, () => markConnectorAuthRequired("notion", "https://auth.example/notion"))).saved;
  saved = (await runEveStep(saved, () => markConnectorAuthRequired("linear", "https://auth.example/linear"))).saved;
  const flagged = await runEveStep(saved, () => ({
    notion: connectorAuthRequiredThisTurn("notion"),
    linear: connectorAuthRequiredThisTurn("linear"),
    linearUrl: connectorAuthUrlThisTurn("linear"),
  }));
  ok(flagged.result.notion, "step delta: the first connector flagged stays flagged");
  ok(flagged.result.linear, "step delta: a SECOND connector flagged in a later step stays flagged");
  ok(flagged.result.linearUrl === "https://auth.example/linear", "step delta: the second connector's cached URL survives");
  saved = (await runEveStep(saved, () => clearConnectorAuthRequired("notion"))).saved;
  const healed = await runEveStep(saved, () => ({
    notion: connectorAuthRequiredThisTurn("notion"),
    notionUrl: connectorAuthUrlThisTurn("notion"),
    linear: connectorAuthRequiredThisTurn("linear"),
  }));
  ok(!healed.result.notion, "step delta: a targeted clear in an earlier step stays cleared");
  ok(healed.result.notionUrl === undefined, "step delta: the cleared connector's cached URL stays gone");
  ok(healed.result.linear, "step delta: the targeted clear leaves a different connector flagged");
}

console.log(`connector-auth-retry-test: ${passed} assertions passed`);

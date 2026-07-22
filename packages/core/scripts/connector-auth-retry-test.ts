import {
  markInSet,
  hasInSet,
  clearFromSet,
  freshGrantConfirmed,
  connectorAuthRequiredError,
  markConnectorAuthRequired,
  connectorAuthRequiredThisTurn,
  clearConnectorAuthRequired,
  resetConnectorAuthMemo,
} from "../agent/connections/auth-retry-memo.js";

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

console.log(`connector-auth-retry-test: ${passed} assertions passed`);

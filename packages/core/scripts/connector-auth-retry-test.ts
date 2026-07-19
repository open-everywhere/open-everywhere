import {
  markInSet,
  hasInSet,
  connectorAuthRequiredError,
  markConnectorAuthRequired,
  connectorAuthRequiredThisTurn,
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

console.log(`connector-auth-retry-test: ${passed} assertions passed`);

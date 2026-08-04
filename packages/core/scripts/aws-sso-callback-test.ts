import assert from "node:assert/strict";

const cb = await import("../agent/connections/aws-sso-callback.js");
import type { AwsSsoCallbackCompleter } from "../agent/connections/aws-sso-callback.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const P = cb.OE_AWS_SSO_CALLBACK_PATH;
const call = (query: string) => cb.handleAwsSsoCallback(new Request(`https://oe.example${P}${query}`));

function spy(impl: (args: { state: string; code: string }) => Promise<{ principalId: string }>) {
  const rec: { calls: number; last?: { state: string; code: string } } = { calls: 0 };
  const completer: AwsSsoCallbackCompleter = {
    async complete(args) {
      rec.calls++;
      rec.last = args;
      return impl(args);
    },
  };
  return { completer, rec };
}

ok(P === "/oauth/v1/aws-sso/callback", "callback path is /oauth/v1/aws-sso/callback");

{
  cb.resetAwsSsoCallbackCompleter();
  const { completer, rec } = spy(async () => ({ principalId: "U_ALICE" }));
  cb.registerAwsSsoCallbackCompleter(completer);

  const res = await call("?state=STATE-123&code=AUTHCODE-SECRET");
  const body = await res.text();

  ok(res.status === 200, "success ⇒ 200");
  ok(rec.calls === 1, "the route calls the registered completer exactly once");
  ok(rec.last?.state === "STATE-123", "the completer received the parsed state verbatim");
  ok(rec.last?.code === "AUTHCODE-SECRET", "the completer received the parsed code verbatim");
  ok(!body.includes("AUTHCODE-SECRET"), "authorization code never rendered into the page");
  ok(!body.includes("STATE-123"), "authorization state never rendered into the page");
  ok(!body.includes("U_ALICE"), "linked principal never rendered into the page");
}

{
  cb.resetAwsSsoCallbackCompleter();
  const { completer } = spy(async () => {
    throw new Error("AWS SSO link: unknown or expired authorization state (SECRET-INTERNAL-DETAIL).");
  });
  cb.registerAwsSsoCallbackCompleter(completer);

  const res = await call("?state=s&code=c");
  const body = await res.text();
  ok(res.status === 502, "completer throw ⇒ 502 (generic error)");
  ok(!body.includes("SECRET-INTERNAL-DETAIL"), "completer error message / internals never leak into the page");
}

{
  cb.resetAwsSsoCallbackCompleter();
  const { completer, rec } = spy(async () => ({ principalId: "U" }));
  cb.registerAwsSsoCallbackCompleter(completer);

  ok((await call("?code=c")).status === 400, "missing state ⇒ 400");
  ok((await call("?state=s")).status === 400, "missing code ⇒ 400");
  ok(rec.calls === 0, "neither missing-param path calls the completer");

  const errRes = await call("?error=access_denied&code=c&state=s");
  ok(errRes.status === 400, "provider error param ⇒ 400");
  ok(rec.calls === 0, "the OAuth error path renders an error WITHOUT calling complete");
}

{
  cb.resetAwsSsoCallbackCompleter();
  ok(cb.awsSsoCallbackCompleter() === undefined, "accessor is undefined after reset (nothing wired)");
  let threw = false;
  try {
    cb.requireAwsSsoCallbackCompleter();
  } catch {
    threw = true;
  }
  ok(threw, "requireAwsSsoCallbackCompleter throws when no completer registered (fail closed)");

  const res = await call("?state=s&code=c");
  ok(res.status !== 200, "unarmed route never renders a success (fail closed)");

  const { completer } = spy(async () => ({ principalId: "U" }));
  cb.registerAwsSsoCallbackCompleter(completer);
  ok(cb.awsSsoCallbackCompleter() === completer, "accessor returns the registered completer");
  ok(cb.requireAwsSsoCallbackCompleter() === completer, "require returns the registered completer (no throw)");
  cb.resetAwsSsoCallbackCompleter();
}

console.log(`✓ aws-sso-callback: ${n} assertions passed (route calls completer; clean landing; generic errors; fail-closed require)`);

import assert from "node:assert/strict";
import { applySessionNetworkPolicy, registerSandboxFirewall, type NetworkPolicyContext } from "../agent/sandbox/network-policy.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n += 1;
};
const eq = <T>(actual: T, expected: T, label: string): void => {
  assert.deepStrictEqual(actual, expected, label);
  n += 1;
};

const ALLOW_LIST = { allow: { "github.com": [{ match: { path: { startsWith: "/acme/" } } }], "*": [] } } as never;

function doubleCtx(): { ctx: NetworkPolicyContext; applied: unknown[]; asked: unknown[] } {
  const applied: unknown[] = [];
  const asked: unknown[] = [];
  const ctx = {
    getSandbox: async (environment: unknown) => {
      asked.push(environment);
      return { setNetworkPolicy: async (policy: unknown) => void applied.push(policy) };
    },
  } as unknown as NetworkPolicyContext;
  return { ctx, applied, asked };
}

async function refusal(label: string, policy: unknown, ctx: NetworkPolicyContext): Promise<string> {
  try {
    await applySessionNetworkPolicy(ctx, policy as never);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  assert.fail(`${label}: the apply RETURNED instead of throwing — the session would run believing it was fenced`);
}

{
  const { ctx, applied } = doubleCtx();
  const message = await refusal("unregistered", ALLOW_LIST, ctx);
  ok(message.includes("no sandbox firewall is registered"), "unregistered: the refusal says nothing is registered");
  ok(message.includes("registerSandboxFirewall"), "unregistered: …and names the call that registers one, so the fix is readable from the message");
  ok(message.includes("Refusing to continue unenforced"), "unregistered: …and says it is refusing rather than degrading");
  eq(applied.length, 0, "unregistered: nothing was applied");
}

{
  registerSandboxFirewall({ carries: "none", backend: "justbash" });
  const { ctx, applied } = doubleCtx();
  const message = await refusal("carries:none", ALLOW_LIST, ctx);
  ok(message.includes("justbash"), "carries:none: the refusal NAMES the configured backend — an operator reading it knows which one to change");
  ok(message.includes("OE_EGRESS_PROXY_URL"), "carries:none: …and names the one way to enforce egress on that backend");
  eq(applied.length, 0, "carries:none: nothing was applied");
  const coarse = await refusal("carries:none, deny-all", "deny-all", ctx);
  ok(coarse.includes("justbash"), "carries:none: even `deny-all` refuses — the backend has no method to call, so there is nothing to fall back to");
}

{
  const environment = { provider: "docker-double" };
  registerSandboxFirewall({ carries: "coarse", environment: environment as never });

  const listCase = doubleCtx();
  const message = await refusal("carries:coarse, allow-list", ALLOW_LIST, listCase.ctx);
  ok(message.includes("coarse"), "carries:coarse: the refusal says the backend is coarse");
  ok(message.includes("would enforce NOTHING from it"), "carries:coarse: …and states the consequence of applying it anyway, which is the whole reason this arm exists");
  eq(listCase.applied.length, 0, "🔴 carries:coarse: the host allow-list was NOT applied — applying it would leave the session reaching every host while believing it was fenced");

  for (const policy of ["deny-all", "allow-all"] as const) {
    const c = doubleCtx();
    await applySessionNetworkPolicy(c.ctx, policy as never);
    eq(c.applied, [policy], `carries:coarse: \`${policy}\` IS applied — it is one of the two a coarse backend really honours, and a no-reach compile produces \`deny-all\``);
    eq(c.asked, [environment], `carries:coarse: \`${policy}\` went through the REGISTERED environment, not a bare getSandbox()`);
  }
}

{
  const environment = { provider: "vercel-double" };
  registerSandboxFirewall({ carries: "full", environment: environment as never });
  const { ctx, applied, asked } = doubleCtx();
  await applySessionNetworkPolicy(ctx, ALLOW_LIST);
  eq(applied.length, 1, "carries:full: the policy was applied once");
  ok(applied[0] === ALLOW_LIST, "🔴 carries:full: the SAME policy object reached the sandbox — the seam must not rebuild, filter or re-key a compiled policy on its way through");
  eq(asked, [environment], "carries:full: it went through the registered environment, which is the only overload that carries setNetworkPolicy on eve 0.69.0");
  const c = doubleCtx();
  await applySessionNetworkPolicy(c.ctx, "deny-all" as never);
  eq(c.applied, ["deny-all"], "carries:full: `deny-all` travels too — a no-reach compile produces it on every backend");
}

{
  registerSandboxFirewall({ carries: "none", backend: "justbash" });
  const environment = { provider: "vercel-again" };
  registerSandboxFirewall({ carries: "full", environment: environment as never });
  const { ctx, applied } = doubleCtx();
  await applySessionNetworkPolicy(ctx, ALLOW_LIST);
  eq(applied.length, 1, "re-registration: the LAST registration decides, so a process that swaps definitions is not stuck on the first");
}

console.log(`\n✓ sandbox-firewall: ${n} assertions passed (three refusals — unregistered, no-policy backend, coarse-backend allow-list — and both apply arms through the registered environment)\n`);


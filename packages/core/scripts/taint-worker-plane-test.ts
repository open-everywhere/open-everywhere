import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { TOOL_CONSEQUENCE } from "../agent/access/consequence.js";
import { WORKER_ONLY_TOOLS_STANDING } from "../agent/access/worker-capability-index.generated.js";
import { resolveApproverChain, taintToleranceOf } from "../agent/access/approver-chain.js";
import {
  judgeContextOf,
  judgeVerdictPrompt,
  runApprovalJudge,
  registerApprovalJudgeCompletion,
  resetApprovalJudgeCompletion,
  clearApprovalJudgeVerdictCache,
} from "../agent/access/approval-judge.js";
import { markUntrustedIngestedThisTurn, untrustedIngestedThisTurn } from "../agent/access/taint-signal.js";
import { nativeAgentAllowedNow, setNativeDelegationSeat } from "../agent/access/native-delegation-state.js";
import { seedIfTainted } from "../agent/hooks/spawn-taint.js";
import { OE_SPAWN_TAINTED_ATTR } from "../agent/channels/unified.js";
import { resetSettingsForTest } from "../agent/settings/settings.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

class FakeSession {
  private readonly store = new Map<string, unknown>();
  constructor(readonly id = "sess-worker-plane") {}
  get<T>(key: { name: string }): T | undefined {
    return this.store.get(key.name) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.store.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`missing ${key.name}`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
    const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
    this.store.set(key.name, next);
    return next;
  }
  ensure<T>(key: { name: string }, create: () => T): T {
    return this.has(key) ? this.require(key) : this.set(key, create());
  }
  clearVirtualContext(): void {}
  setVirtualContext(): void {}
  *entries(): Generator<readonly [unknown, unknown]> {}
}

function eveContextStorage(): AsyncLocalStorage<unknown> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return g[key] as AsyncLocalStorage<unknown>;
}

async function inSession<T>(fn: (s: FakeSession) => T | Promise<T>, session = new FakeSession()): Promise<T> {
  return eveContextStorage().run(session, () => fn(session));
}

const OPE_438_GATE_SINKS = ["add_routine_rule", "remove_routine_rule", "declare_webhook", "rotate_webhook"] as const;

resetSettingsForTest();

console.log("1 — every gated tool a worker can hold declares a taint tolerance:");
{
  const workerGated = WORKER_ONLY_TOOLS_STANDING.filter((t) => TOOL_CONSEQUENCE[t]?.tier !== "open" && TOOL_CONSEQUENCE[t] !== undefined);
  ok(workerGated.length > 0, "[1] precondition: the worker's wide kit contains gated sinks at all — otherwise every assertion below is vacuous");

  const undeclared = workerGated.filter((t) => TOOL_CONSEQUENCE[t]?.taint === undefined);
  eq(undeclared, [], "[1] 🔴 EVERY gated tool a worker can hold DECLARES a taint tolerance. The withdrawal's stated premise — 'none of those declares a taint tolerance' — is FALSE, and this is the assertion that keeps it false");

  const declaresGate = workerGated.filter((t) => TOOL_CONSEQUENCE[t]?.taint === "gate").sort();
  eq(
    declaresGate,
    [...OPE_438_GATE_SINKS].sort(),
    "[1] 🔴 EXACTLY the four OPE-438 standing-permission sinks carry the human ask-FLOOR, and a worker can reach all four. A fifth row gaining `gate` — a silent widening of the floor — fails here",
  );

  const declaresDisclose = workerGated.filter((t) => TOOL_CONSEQUENCE[t]?.taint === "disclose");
  ok(
    declaresDisclose.length > 0 && declaresDisclose.length === workerGated.length - declaresGate.length,
    "[1] every OTHER worker-reachable gated sink declares `disclose` — provenance on the card and the audit row, NO verdict change: a judge signal, not a human card",
  );
  ok(declaresDisclose.includes("open_pull_request"), "[1] `open_pull_request` — named in the withdrawal's premise as declaring nothing — declares `disclose` AND is `judgeDefer`, which is the maintainer's ruling already implemented");

  for (const t of ["bash", "write_file", "read_file"]) {
    eq(TOOL_CONSEQUENCE[t]?.tier, "open", `[1] \`${t}\` is an OPEN row — sandbox-local, durable effects leave only via the gated verbs above; it carries no tolerance BY RULING`);
    eq(taintToleranceOf(t), undefined, `[1] …so \`${t}\` has no taint tolerance to reach a transform — asserted \`=== undefined\`, not merely falsy`);
  }
  eq(TOOL_CONSEQUENCE.aws?.tier, "open", "[1] `aws` is open too — bounded by the bundle grant, the IAM role and the host-side argv screen at L2, not by a taint column");
}

console.log("2 — the two tolerances behave differently on a genuinely tainted turn:");
{
  const lowered = { approvers: [{ name: "domain-lower", approve: () => "allow" as const }] };

  await inSession(async () => {
    markUntrustedIngestedThisTurn("web");
    ok(untrustedIngestedThisTurn(), "[2] precondition: the turn genuinely ingested untrusted content");

    const pr = await resolveApproverChain({ tool: "open_pull_request", unattended: false }, lowered);
    eq(pr.verdict, "allow", "[2] 🔴 A `disclose` worker sink stays LOWERED on a tainted turn — taint changes NO verdict there. It is a signal the judge and the card read, never a human floor");
    ok(!pr.transforms.some((t) => t.reason === "taint-ask"), "[2] …and no `taint-ask` transform fired, asserted on the transform trail rather than inferred from the verdict");

    const webhook = await resolveApproverChain({ tool: "declare_webhook", unattended: false }, lowered);
    eq(webhook.verdict, "ask", "[2] 🔴 NEGATIVE CONTROL: a `gate` sink on the SAME turn, same lowering approver, is FLOORED at `ask` — the OPE-438 human floor, untouched by this ticket");
    ok(webhook.transforms.some((t) => t.reason === "taint-ask"), "[2] …and the `taint-ask` transform is the named cause, so the two sinks differ for the reason claimed and not incidentally");

    const fire = await resolveApproverChain({ tool: "declare_webhook", unattended: true }, lowered);
    eq(fire.verdict, "deny", "[2] …and an UNATTENDED tainted run denies at a `gate` sink — nobody is there to read the card");
    const firePr = await resolveApproverChain({ tool: "open_pull_request", unattended: true }, lowered);
    eq(firePr.verdict, "allow", "[2] 🔴 …while the `disclose` sink still runs unattended. THIS is the whole cost difference between the two values, on one turn");
  });

  await inSession(async () => {
    const webhook = await resolveApproverChain({ tool: "declare_webhook", unattended: false }, lowered);
    eq(webhook.verdict, "allow", "[2] 🔴 CONTROL: on a CLEAN turn the same `gate` sink accepts the same lowering — so the floor above is caused by the TAINT, not by the sink being unlowerable");
  });
}

console.log("3 — taint reaches the approval judge as a decision input:");
{
  const req = { tool: "open_pull_request", action: "pr.open", args: { repo: "o/r" }, unattended: false } as const;

  await inSession(async () => {
    markUntrustedIngestedThisTurn("web");
    const ctx = judgeContextOf(req, { registryVerdict: "ask" });
    eq(ctx.tainted, true, "[3] 🔴 the judge's context carries `tainted: true` — the maintainer's ruling in one field: the judge SEES the taint and decides");
    ok(ctx.taintKinds.includes("web"), "[3] …and the KINDS, so the judge weighs `web` differently from `file-upload` rather than seeing one opaque bit");
    const prompt = judgeVerdictPrompt(ctx);
    ok(prompt.includes("Turn ingested untrusted content: true"), "[3] 🔴 …and it reaches the RENDERED PROMPT. A field the prompt builder drops is a field the model never sees — asserted on the bytes actually sent");
    ok(prompt.includes("web"), "[3] …with the kind named in the prompt too");
  });

  await inSession(() => {
    const ctx = judgeContextOf(req, { registryVerdict: "ask" });
    eq(ctx.tainted, false, "[3] 🔴 NEGATIVE CONTROL: a CLEAN turn's judge context reads `=== false`, not merely falsy");
    eq(ctx.taintKinds, [], "[3] …and carries no kinds at all");
    ok(judgeVerdictPrompt(ctx).includes("Turn ingested untrusted content: false"), "[3] …and the prompt says so explicitly, so the judge can never read silence as cleanliness");
  });
}

console.log("4 — the judge's allow cache is invalidated by taint arriving mid-turn:");
{
  let calls = 0;
  registerApprovalJudgeCompletion(async (_p, pass) => {
    calls++;
    return pass === "scrutiny" ? "YES" : "VERDICT: allow\nREASON: routine";
  });
  try {
    await inSession(async () => {
      clearApprovalJudgeVerdictCache();
      const req = { tool: "open_pull_request", unattended: false } as const;

      const first = await runApprovalJudge(judgeContextOf(req, { registryVerdict: "ask" }), { enforce: true });
      eq(first.verdict, "allow", "[4] precondition: the judge allows on the clean turn");
      eq(first.cacheHit, false, "[4] precondition: …and that was a real consult, not a cache read");
      const afterFirst = calls;

      const second = await runApprovalJudge(judgeContextOf(req, { registryVerdict: "ask" }), { enforce: true });
      eq(second.cacheHit, true, "[4] precondition: an identical clean-turn consult IS served from cache — otherwise the invalidation below proves nothing");
      eq(calls, afterFirst, "[4] …and cost no model calls");

      markUntrustedIngestedThisTurn("web");
      const third = await runApprovalJudge(judgeContextOf(req, { registryVerdict: "ask" }), { enforce: true });
      eq(third.cacheHit, false, "[4] 🔴 taint arriving MID-TURN drops the cached allow — the key is the taint SIGNATURE, so a verdict earned on clean content can never be spent on tainted content");
      ok(calls > afterFirst, "[4] …and the judge genuinely re-ran, asserted on the completion call count rather than on the returned flag alone");
    });
  } finally {
    resetApprovalJudgeCompletion();
    clearApprovalJudgeVerdictCache();
  }
}

console.log("5 — the native child carries NO taint mark, so sections 1-4 are inert for it:");
{
  await inSession(() => {
    const ctx = { session: { auth: { current: { attributes: { [OE_SPAWN_TAINTED_ATTR]: "true" } } } } };
    seedIfTainted(ctx as never);
    eq(untrustedIngestedThisTurn(), true, "[5] POSITIVE CONTROL: the `oe_spawn_tainted` seed consumer WORKS — a stamped opening auth taints the child's turn");
  });

  const parentBag: Record<string, string> = { oe_window_grain: "standing" };
  await inSession(() => {
    markUntrustedIngestedThisTurn("web");
    ok(untrustedIngestedThisTurn(), "[5] precondition: the PARENT turn is tainted");
  });
  await inSession(() => {
    seedIfTainted({ session: { auth: { current: { attributes: { ...parentBag } } } } } as never);
    eq(
      untrustedIngestedThisTurn(),
      false,
      "[5] 🔴 THE GAP, MEASURED: a native child of a TAINTED parent turn starts CLEAN. The parent's mid-turn taint never entered the auth bag, so no TAINT_SEED_ATTRS stamp reaches the child. Delete this assertion when OPE-465 lands a replay-safe carriage",
    );
    eq(untrustedIngestedThisTurn(), false, "[5] …asserted `=== false`, not merely absent — a clean child is what every downstream sink would read");
  });

  await inSession(() => {
    setNativeDelegationSeat("allow");
    eq(nativeAgentAllowedNow(), true, "[5] precondition: a positively-classified delegating seat holds the built-in `agent` on a CLEAN turn");
    markUntrustedIngestedThisTurn("web");
    eq(
      nativeAgentAllowedNow(),
      false,
      "[5] 🔴 THE WITHDRAWAL STILL FIRES, and it is load-bearing: with no mark reaching the child, lifting it would let a tainted turn dispatch a CLEAN wide-handed worker — laundering, not merely widening",
    );
  });
}

console.log(`\ntaint-worker-plane: ${n} assertions passed`);

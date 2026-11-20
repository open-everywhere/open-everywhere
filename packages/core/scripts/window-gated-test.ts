// proves: turn.tool_gated

// proves: AP-MOD-core-access-window-gated

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-window-gated-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoryRecallRouteFor } from "../agent/access/window-gate-manifest.js";
import { oneshotAgentEnabled } from "../agent/access/delegation-flag.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
import { canDelegateFromSeat } from "../agent/access/delegation-mount.js";
import {
  WINDOW_GATED_TOOLS,
  withheldFromGrain,
  windowGated,
  windowGatedKit,
  resolveWindowGated,
  domainLabelOf,
  _resetWindowGateAuditForTest,
  type GatedToolEntry,
} from "../agent/access/window-gated.js";
import { formatWindowToken, taskWindowId, threadSeatWindowId } from "../agent/channels/window-key.js";
import { readAudit } from "../agent/audit/audit.js";
import type { BindableContext, WindowGrain } from "../agent/identity/binding.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const STANDING_TOKEN = `unified:${formatWindowToken({ domain: "payments", windowId: "payments", generation: 2 })}`;
const PER_CONTAINER_TOKEN = "slack/T1/C_PAY:oe-sup:g2";
const TASK_TOKEN = `unified:${formatWindowToken({ domain: "payments", windowId: taskWindowId("slack/C1", "1720.5"), generation: 2 })}`;
const THREAD_TOKEN = `unified:${formatWindowToken({ domain: "payments", windowId: threadSeatWindowId("slack/C1", "1720.5"), generation: 2 })}`;
const NATIVE_TOKEN = "cse_native123";

let sessionSeq = 0;
function ctxOf(token: string | undefined, opts: { grainStamp?: string; sessionId?: string; wakeId?: string } = {}): BindableContext {
  const attributes: Record<string, unknown> = {};
  if (opts.grainStamp) attributes.oe_grain = opts.grainStamp;
  if (opts.wakeId) attributes.oe_wake_id = opts.wakeId;
  return {
    channel: token === undefined ? { kind: "unified" } : { kind: "unified", continuationToken: token },
    session: { id: opts.sessionId ?? `sess-${++sessionSeq}`, auth: { current: { attributes } } },
  } as BindableContext;
}

const grainCtx: Record<WindowGrain, () => BindableContext> = {
  standing: () => ctxOf(STANDING_TOKEN),
  task: () => ctxOf(TASK_TOKEN, { grainStamp: "task" }),
  native: () => ctxOf(NATIVE_TOKEN),
  thread: () => ctxOf(THREAD_TOKEN, { grainStamp: "thread" }),
};

function stubEntry(name: string): GatedToolEntry {
  return defineTool({
    description: `stub ${name}`,
    inputSchema: z.object({ v: z.string().optional() }),
    outputSchema: z.object({ ran: z.string() }),
    async execute() {
      return { ran: name };
    },
  }) as unknown as GatedToolEntry;
}

console.log("0. WINDOW_GATED_TOOLS table pins:");
const WIDE_HANDS = ["bash", "glob", "grep", "read_file", "write_file", "edit_file", "web_fetch", "checkout_repo", "open_pull_request", "post_file", "create_skill", "delete_skill"] as const;
for (const name of WIDE_HANDS) {
  eq(WINDOW_GATED_TOOLS[name], ["task"], `"${name}" mounts on the one-shot task worker only, delegation armed (the shipped default — withheld from standing AND native)`);
}
eq(WINDOW_GATED_TOOLS.spawn_thread_session, ["standing"], "spawn_thread_session is standing-only (window-only mint; no recursive thread trees)");
eq(WINDOW_GATED_TOOLS.complete_thread, ["thread"], "complete_thread is thread-only (only a thread seat owns a thread)");
ok(WINDOW_GATED_TOOLS.return_result === undefined && WINDOW_GATED_TOOLS.stop_task === undefined, "🔴 OPE-1145 item 2: the roll-own regime's verbs carry NO manifest row at all — deleted, not disarmed");
eq(WINDOW_GATED_TOOLS.agent, ["standing", "thread"], "agent is grain-gated to the conversational-root seats (standing+thread) — absent on native, and NEVER on a task worker leaf");
eq(WINDOW_GATED_TOOLS.read_thread_seat, ["standing"], "read_thread_seat is standing-only (the seat that opened the thread reads it)");
eq(WINDOW_GATED_TOOLS.message_thread_seat, ["standing"], "message_thread_seat is standing-only (no seat-to-seat mesh, no worker)");
eq(WINDOW_GATED_TOOLS.work, ["standing", "thread"], "work is on the conversation seats (standing+thread): each forwards to its own work session; never a worker leaf");
eq([...(WINDOW_GATED_TOOLS.cancel_work ?? [])], ["standing", "thread"], "cancel_work is on the same seats as `work` (OPE-2338, D15): the seat that forwarded a job stops it");
eq(WINDOW_GATED_TOOLS.ask_domain, ["standing"], "ask_domain is standing-only (the person's DM seat asks; never a thread seat, never a worker)");
eq(WINDOW_GATED_TOOLS.answer_domain_question, ["standing"], "answer_domain_question is standing-only (a domain's standing seat answers; never a thread seat, never a worker)");
eq(WINDOW_GATED_TOOLS.expect_bot_reply, ["standing"], "expect_bot_reply is standing-only (the person's DM seat opens an asked thread; never a thread seat, never a worker)");
eq(Object.keys(WINDOW_GATED_TOOLS).length, WIDE_HANDS.length + 10, "the gated table is EXACTLY the 12 wide-hands tools + the 7 delegation/lifecycle/coordinator tools (agent/work/cancel_work/spawn_thread_session/complete_thread/read_thread_seat/message_thread_seat) + the 2 domain question verbs (ask_domain/answer_domain_question) + the asked-thread verb (expect_bot_reply) — nothing else narrows.");
eq([...withheldFromGrain("standing")].sort(), [...WIDE_HANDS, "complete_thread"].sort(), "standing withholds the 12 wide-hands tools + complete_thread (it KEEPS agent and the spawner — a standing seat is what delegates)");

{
  const OFF = { wide: ["task", "native"] as const, armed: false };
  const ON = { wide: ["task"] as const, armed: true };
  eq(memoryRecallRouteFor("task", OFF.wide, OFF.armed), "file-tools", "recall/flag-off: a task worker reads its own memory directly");
  eq(memoryRecallRouteFor("native", OFF.wide, OFF.armed), "file-tools", "recall/flag-off: a native @mention seat keeps its wide hands, so it reads directly");
  eq(memoryRecallRouteFor("standing", OFF.wide, OFF.armed), "none", "recall/flag-off: a standing seat has no file tools AND no delegation verb (`agent` is flag-gated) — the index must say so, not point at a tool");
  eq(memoryRecallRouteFor("thread", OFF.wide, OFF.armed), "none", "recall/flag-off: a thread seat has neither file tools nor a delegation verb — the index must say so, not point at a tool");
  eq(memoryRecallRouteFor("task", ON.wide, ON.armed), "file-tools", "recall/flag-on: the one-shot worker is the sole seat with file tools");
  eq(memoryRecallRouteFor("standing", ON.wide, ON.armed), "agent", "recall/flag-on: a standing seat delegates the lookup via `agent` — THE OPE-121 route");
  eq(memoryRecallRouteFor("thread", ON.wide, ON.armed), "agent", "recall/flag-on: a thread seat delegates too (agent is the conversational-root pair)");
  eq(memoryRecallRouteFor("native", ON.wide, ON.armed), "none", "recall/flag-on: a NATIVE @mention seat can neither read memory nor delegate (T5 gap — pinned so the regression is visible, not silent)");

  eq(memoryRecallRouteFor("standing", ON.wide, ON.armed, false), "none", "recall/seat: a standing seat with NO WINDOW (a DM root) is `none`, not `agent` — the verb's window wall refuses there every time");
  eq(memoryRecallRouteFor("standing", OFF.wide, OFF.armed, false), "none", "recall/seat: …and flag-off the same seat is `none` for BOTH reasons at once (no window AND no armed verb)");
  eq(memoryRecallRouteFor("thread", ON.wide, ON.armed, false), "none", "recall/seat: a thread seat with no window token is `none` too — the seat half is grain-independent");
  eq(memoryRecallRouteFor("task", ON.wide, ON.armed, false), "file-tools", "recall/seat: a worker's OWN file tools are unaffected — the seat half only ever downgrades a DELEGATION answer");
  eq(memoryRecallRouteFor("standing", ON.wide, ON.armed, true), memoryRecallRouteFor("standing", ON.wide, ON.armed), "recall/seat: the parameter DEFAULTS TRUE — every ctx-less caller keeps today's answer byte-for-byte");
}

{
  const can = (ctx: BindableContext) => canDelegateFromSeat(ctx);
  ok(can(ctxOf(STANDING_TOKEN)), "seat: a unified WINDOW token carries a domain+generation ⇒ can delegate");
  ok(can(ctxOf(TASK_TOKEN, { grainStamp: "task" })), "seat: a task token is a window token too (the recursion guard is a SEPARATE wall — this predicate is only about having a window)");
  ok(!can(ctxOf(NATIVE_TOKEN)), "seat: a native token (the DM / group-DM root) has no window ⇒ CANNOT delegate");
  ok(!can(ctxOf(PER_CONTAINER_TOKEN)), "seat: a per-container `<chan>:oe-sup:g` token has no window either ⇒ CANNOT delegate");
  ok(can(ctxOf(undefined)), "seat: NO readable identity ⇒ fail-OPEN (mount; the execute wall stays authoritative)");
  const bomb = { channel: { kind: "unified", get continuationToken(): string { throw new Error("boom"); } }, session: { auth: { current: { attributes: {} } } } } as unknown as BindableContext;
  ok(can(bomb), "seat: an identity read that THROWS ⇒ fail-OPEN as well (never fewer signals than the wall behind it)");
}
eq(
  [...withheldFromGrain("task")].sort(),
  ["agent", "answer_domain_question", "ask_domain", "cancel_work", "complete_thread", "expect_bot_reply", "message_thread_seat", "read_thread_seat", "spawn_thread_session", "work"].sort(),
  "task (the worker) withholds agent, the standing-only spawner, forward verb and its stop (OPE-2338, D15), complete_thread, the two coordinator verbs, the two domain question verbs and the asked-thread verb (it has its own wide hands; a worker leaf holds no threads, no person's DM and no domain room, and must not delegate recursively)",
);
eq(
  [...withheldFromGrain("native")].sort(),
  [...WIDE_HANDS, "agent", "answer_domain_question", "ask_domain", "cancel_work", "complete_thread", "expect_bot_reply", "message_thread_seat", "read_thread_seat", "spawn_thread_session", "work"].sort(),
  "native withholds agent, the forward verb `work` and its stop `cancel_work` (OPE-2338, D15), the rest of the delegation/lifecycle/coordinator set, the domain question verbs (OPE-2452), the asked-thread verb (OPE-2426) AND the wide hands — the T2 narrowing, which since OPE-370 is the shipped default",
);
eq(
  [...withheldFromGrain("thread")].sort(),
  [...WIDE_HANDS, "answer_domain_question", "ask_domain", "expect_bot_reply", "message_thread_seat", "read_thread_seat", "spawn_thread_session"].sort(),
  "a thread seat withholds the wide hands, the spawner, the two coordinator verbs, the two domain question verbs and the asked-thread verb (it keeps the conversational kit and the forward verb `work` with its stop `cancel_work`, OPE-2350, but never reaches a sibling seat)",
);

console.log("1. presence/absence matrix (windowGated):");
for (const [name, grains] of Object.entries(WINDOW_GATED_TOOLS)) {
  const gated = windowGated(name, stubEntry(name));
  for (const grain of ["standing", "task", "native", "thread"] as const) {
    const resolved = await resolveWindowGated(gated, grainCtx[grain]());
    if (grains.includes(grain)) {
      ok(resolved !== null && typeof (resolved as GatedToolEntry).execute === "function", `"${name}" RESOLVES on ${grain}`);
    } else {
      eq(resolved, null, `"${name}" is ABSENT on ${grain}`);
    }
  }
}
assert.throws(() => windowGated("not_a_gated_tool", stubEntry("x")), /WINDOW_GATED_TOOLS/, "windowGated throws at module load for a name with no kit row");
n++;

{
  const bomb = { channel: { kind: "unified", get continuationToken(): string { throw new Error("boom"); } }, session: { auth: { current: { attributes: {} } } } } as unknown as BindableContext;
  const resolved = await resolveWindowGated(windowGated("bash", stubEntry("bash")), bomb);
  eq(resolved, null, "a grain read that THROWS fails closed to standing ⇒ wide-hands tool absent (A7)");
}

{
  const spoof = ctxOf(PER_CONTAINER_TOKEN, { grainStamp: "task" });
  eq(await resolveWindowGated(windowGated("bash", stubEntry("bash")), spoof), null, "a model-side `task` claim on a standing token resolves NOTHING (grain is unforgeable)");
}

console.log("2. windowGatedKit:");
{
  const kit = windowGatedKit("test_kit", { bash: stubEntry("bash"), web_fetch: stubEntry("web_fetch") });
  eq(await resolveWindowGated(kit, grainCtx.standing()), null, "kit resolves NULL on standing (all entries withheld)");
  const onTask = (await resolveWindowGated(kit, grainCtx.task())) as Record<string, GatedToolEntry>;
  eq(Object.keys(onTask).sort(), ["bash", "web_fetch"], "kit resolves BOTH entries on task grain, under their bare names");
  eq(await resolveWindowGated(kit, grainCtx.native()), null, "kit resolves NULL on native grain too, delegation armed (the T2 narrowing — wide hands live on the one-shot worker alone)");
  assert.throws(() => windowGatedKit("bad_kit", { not_gated: stubEntry("x") }), /WINDOW_GATED_TOOLS/, "kit throws for an entry with no kit row");
  n++;
}

console.log("3. resolve-time audit (turn.tool_gated):");
_resetWindowGateAuditForTest();
{
  const countRows = async () => (await readAudit({ org: "default", action: "turn.tool_gated" })).length;
  const rowsFor = async (sessionId: string) =>
    (await readAudit({ org: "default", action: "turn.tool_gated" })).filter((r) => (r.detail as Record<string, unknown>).sessionId === sessionId);
  const base = await countRows();
  const sessionId = "sess-audit-1";
  const wakeId = "wake-audit-1";
  const mk = () => ctxOf(STANDING_TOKEN, { sessionId, wakeId });
  await resolveWindowGated(windowGated("bash", stubEntry("bash")), mk());
  await resolveWindowGated(windowGated("checkout_repo", stubEntry("checkout_repo")), mk());
  await resolveWindowGated(windowGated("complete_thread", stubEntry("complete_thread")), mk());
  const rows = await rowsFor(sessionId);
  eq(rows.length, 1, "many gated resolvers on ONE session ⇒ exactly one turn.tool_gated row");
  eq(await countRows(), base + 1, "…and exactly one row was ADDED overall");
  const detail = rows[0].detail as Record<string, unknown>;
  eq(detail.grain, "standing", "row records the standing grain");
  eq([...(detail.withheld as string[])].sort(), withheldFromGrain("standing").sort(), "row lists the FULL standing withheld set (not just the resolvers that fired)");
  eq(detail.withheldCount, withheldFromGrain("standing").length, "withheldCount matches");
  eq(detail.wakeId, wakeId, "row is wakeId-stamped (the e2e join key)");
  eq(detail.sessionId, sessionId, "row carries the sessionId");
  eq(rows[0].workspace, "payments", "row is domain-labelled from the window token");
  eq(Object.keys(detail).sort(), ["grain", "sessionId", "wakeId", "withheld", "withheldCount"].sort(), "detail carries names+counts+ids ONLY (GDPR taint rule)");

  await resolveWindowGated(windowGated("bash", stubEntry("bash")), ctxOf(STANDING_TOKEN, { sessionId: "sess-audit-2" }));
  eq((await rowsFor("sess-audit-2")).length, 1, "a second gated session emits its own row");

  const beforeFull = await countRows();
  await resolveWindowGated(windowGated("spawn_thread_session", stubEntry("spawn_thread_session")), grainCtx.task());
  eq(await countRows(), beforeFull, "withholding spawn_thread_session from a TASK worker emits NO resolve-time row (task is a wide-hands grain — confinement, not narrowing)");
  await resolveWindowGated(windowGated("spawn_thread_session", stubEntry("spawn_thread_session")), grainCtx.native());
  eq(await countRows(), beforeFull + 1, "a NATIVE seat DOES emit one resolve-time row, delegation armed — it is narrowed of the wide hands, and that narrowing is an auditable event");

  await resolveWindowGated(windowGated("bash", stubEntry("bash")), ctxOf(PER_CONTAINER_TOKEN, { sessionId: "sess-audit-3" }));
  const rows3 = await rowsFor("sess-audit-3");
  eq(rows3.length, 1, "a per-container standing seat audits too");
  ok(rows3.some((r) => r.workspace === "slack/T1/C_PAY"), "per-container row is labelled with its channel key (an OE-minted pointer)");
}

console.log("4. execute backstop:");
_resetWindowGateAuditForTest();
{
  const gated = windowGated("bash", stubEntry("bash"));
  const entry = (await resolveWindowGated(gated, grainCtx.task())) as GatedToolEntry;
  eq(await entry.execute({ v: "x" }, grainCtx.task()), { ran: "bash" }, "backstop passes an allowed grain through to the tool");
  const before = (await readAudit({ org: "default", action: "turn.tool_gated" })).length;
  await assert.rejects(() => Promise.resolve(entry.execute({ v: "x" }, ctxOf(STANDING_TOKEN, { sessionId: "sess-backstop", wakeId: "wake-backstop" }))), /not held by this conversational seat/, "backstop refuses a delegating standing-seat execute fail-closed (the lean arm speaks first)");
  n++;
  const rows = await readAudit({ org: "default", action: "turn.tool_gated" });
  eq(rows.length, before + 1, "backstop stamps a per-ATTEMPT turn.tool_gated row");
  await assert.rejects(() => Promise.resolve(entry.execute({ v: "x" }, ctxOf(PER_CONTAINER_TOKEN, { sessionId: "sess-backstop-dm" }))), /not available on a standing/, "a NON-delegating standing seat still gets the grain refusal — the lean arm never touches it");
  n++;
  const attemptRow = rows.find((r) => (r.detail as Record<string, unknown>).wakeId === "wake-backstop");
  ok(attemptRow !== undefined, "the attempt row is wakeId-locatable");
  const attempt = attemptRow!.detail as Record<string, unknown>;
  eq(attempt.withheld, ["bash"], "the attempt row names the ONE tool attempted — never its input");
  eq(attempt.wakeId, "wake-backstop", "the attempt row is wakeId-stamped");
  const ct = (await resolveWindowGated(windowGated("complete_thread", stubEntry("complete_thread")), grainCtx.thread())) as GatedToolEntry;
  await assert.rejects(() => Promise.resolve(ct.execute({}, grainCtx.native())), /not available on a native session/, "complete_thread's backstop refuses a native-grain execute");
  n++;
}

console.log("4b. channel-less domain fallback (OPE-740):");
{
  const channelLess = {
    session: { id: "sess-channel-less", auth: { current: { attributes: { oe_window_token: STANDING_TOKEN } } } },
  } as unknown as BindableContext;
  eq(domainLabelOf(channelLess), "payments", "a channel-less execute context labels from the oe_window_token stamp, not \"unknown\"");

  const channelLessNoStamp = {
    session: { id: "sess-channel-less-bare", auth: { current: { attributes: {} } } },
  } as unknown as BindableContext;
  eq(domainLabelOf(channelLessNoStamp), "unknown", "a channel-less context with no window-token stamp still labels \"unknown\" (negative control)");

  const withChannel = ctxOf(PER_CONTAINER_TOKEN, {});
  (withChannel as { session: { auth: { current: { attributes: Record<string, unknown> } } } }).session.auth.current.attributes.oe_window_token = STANDING_TOKEN;
  eq(domainLabelOf(withChannel), "slack/T1/C_PAY", "a resolver context with BOTH a channel token and a window-token stamp still labels from the channel token — byte-identical to pre-OPE-740");

  _resetWindowGateAuditForTest();
  const gated = windowGated("bash", stubEntry("bash"));
  const entry = (await resolveWindowGated(gated, grainCtx.task())) as GatedToolEntry;
  const execCtx = {
    session: {
      id: "sess-backstop-channel-less",
      auth: { current: { attributes: { oe_grain: "standing", oe_window_token: STANDING_TOKEN, oe_wake_id: "wake-backstop-cl" } } },
    },
  } as unknown as BindableContext;
  await assert.rejects(() => Promise.resolve(entry.execute({ v: "x" }, execCtx)), /not held by this conversational seat/, "backstop still refuses a channel-less delegating standing-seat execute fail-closed");
  n++;
  const rows = await readAudit({ org: "default", action: "turn.tool_gated" });
  const attemptRow = rows.find((r) => (r.detail as Record<string, unknown>).wakeId === "wake-backstop-cl");
  ok(attemptRow !== undefined, "the channel-less attempt row is wakeId-locatable");
  eq(attemptRow!.workspace, "payments", "the per-attempt row from a channel-less execute context records the REAL domain, not \"unknown\" (the OPE-740 fix)");
}

console.log("5. the resolved entry keeps the gate and the approval (no descriptor, no step registry):");
{
  const armedBash = (await resolveWindowGated(windowGated("bash", stubEntry("bash")), grainCtx.task())) as GatedToolEntry;
  eq(await armedBash.execute({ v: "y" }, grainCtx.task()), { ran: "bash" }, "the resolved execute runs the real tool on an allowed grain");
  await assert.rejects(() => Promise.resolve(armedBash.execute({ v: "y" }, ctxOf(STANDING_TOKEN, { sessionId: "sess-replay" }))), /not held by this conversational seat/, "the resolved execute STILL carries the backstop: a call that reaches it on a narrowed seat is refused");
  n++;
  ok(!(Symbol.for("eve:durable-dynamic-tool-callbacks") in (armedBash as object)), "the armed entry carries NO durable-callback descriptor: eve 1.x rebuilds tools from their definitions");
  ok((globalThis as Record<symbol, unknown>)[Symbol.for("@workflow/core//registeredSteps")] === undefined || !((globalThis as Record<symbol, unknown>)[Symbol.for("@workflow/core//registeredSteps")] as Map<string, unknown>).has("eve:framework-dynamic:bash:_single"), "…and windowGated registers NO replay step under the retired eve name");

  const approvalCalls: unknown[] = [];
  const withApproval = defineTool({
    description: "stub approval tool",
    inputSchema: z.object({ html: z.boolean() }),
    approval: (actx: { toolInput?: { html?: boolean } }) => {
      approvalCalls.push(actx);
      return actx.toolInput?.html ? "user-approval" : "not-applicable";
    },
    async execute() {
      return { ok: true };
    },
  }) as unknown as GatedToolEntry;
  const resolvedApproval = (await resolveWindowGated(windowGated("post_file", withApproval), grainCtx.task())) as GatedToolEntry;
  const policy = resolvedApproval.approval as (actx: unknown) => unknown;
  ok(typeof policy === "function", "an approval-bearing gated tool keeps its approval policy on the resolved entry");
  eq(policy({ toolInput: { html: true } }), "user-approval", "the resolved approval applies the real input-aware policy (the publish gate survives a fresh process: it is rebuilt from the definition)");
  eq(policy({ toolInput: { html: false } }), "not-applicable", "…and stays ungated for the benign path");
}

console.log("6. the seat is fixed per session through ctx.memo:");
{
  const memoStore = (): { memo: (key: unknown, fn: () => unknown) => Promise<unknown>; saved: Map<string, unknown> } => {
    const saved = new Map<string, unknown>();
    return {
      saved,
      memo: async (key, fn) => {
        const k = JSON.stringify(key);
        if (!saved.has(k)) saved.set(k, JSON.parse(JSON.stringify(await fn())));
        return saved.get(k);
      },
    };
  };
  const withMemo = (ctx: BindableContext, store: { memo: unknown }): BindableContext => ({ ...ctx, memo: store.memo }) as BindableContext;
  const namesOf = (mounted: unknown): string[] => (mounted === null ? [] : Object.keys(mounted as Record<string, unknown>).sort());

  let calls = 0;
  const counting = windowGatedKit("memo_kit", { bash: stubEntry("bash"), web_fetch: stubEntry("web_fetch") }, {
    web_fetch: () => {
      calls++;
      return true;
    },
  });
  const store = memoStore();
  const task = withMemo(ctxOf(TASK_TOKEN, { grainStamp: "task", sessionId: "sess-memo" }), store);
  eq(namesOf(await resolveWindowGated(counting, task)), ["bash", "web_fetch"], "model call 1 on a task seat mounts the kit");
  eq(namesOf(await resolveWindowGated(counting, task)), ["bash", "web_fetch"], "model call 2 mounts the same kit");
  eq(calls, 1, "…and the mount gate ran ONCE: eve runs a dynamic before every model call, and the memo keeps the seat decision");
  eq([...store.saved.values()], [{ grain: "task", names: ["bash", "web_fetch"] }], "the memo holds plain JSON (the grain and the mounted names), which eve can keep across processes");

  const moved = withMemo(ctxOf(STANDING_TOKEN, { sessionId: "sess-memo" }), store);
  eq(namesOf(await resolveWindowGated(counting, moved)), ["bash", "web_fetch"], "a later model call of the SAME session keeps the seat it started with, as session.started did on eve 0.x");
  eq(namesOf(await resolveWindowGated(counting, withMemo(ctxOf(STANDING_TOKEN, { sessionId: "sess-memo-2" }), memoStore()))), [], "NEGATIVE CONTROL: a different session on a standing seat derives its own seat, and the wide hands stay withheld");

  eq(await resolveWindowGated(windowGated("post_file", stubEntry("post_file"), () => false), grainCtx.task()), null, "🔴 windowGated's mount gate withholds the tool on an allowed grain when its predicate refuses");
  ok((await resolveWindowGated(windowGated("post_file", stubEntry("post_file"), () => true), grainCtx.task())) !== null, "…and mounts it when the predicate allows (negative control)");
  const single = windowGated("post_file", stubEntry("post_file"));
  const singleStore = memoStore();
  eq(await resolveWindowGated(single, withMemo(ctxOf(STANDING_TOKEN, { sessionId: "sess-memo-single" }), singleStore)), null, "windowGated on a standing seat mounts nothing");
  eq([...singleStore.saved.values()], [{ grain: "standing", mounted: false }], "…and memoizes the withheld decision as JSON");

  const bashV2 = defineTool({
    description: "stub bash — REWORDED BY THE NEXT DEPLOY",
    inputSchema: z.object({ v: z.string().optional() }),
    outputSchema: z.object({ ran: z.string() }),
    async execute() {
      return { ran: "bash" };
    },
  }) as unknown as GatedToolEntry;
  const kitV2 = windowGatedKit("memo_kit", { bash: bashV2 });
  const v2 = (await resolveWindowGated(kitV2, task)) as Record<string, { description?: string }>;
  eq(namesOf(v2), ["bash"], "a new build that drops a tool serves only the tools it still defines, even with an older kept memo");
  eq(v2.bash?.description, "stub bash — REWORDED BY THE NEXT DEPLOY", "…and a kept tool carries the NEW build's description: the tool is rebuilt from its definition, not from saved metadata");
}

{
  const before = oneshotAgentEnabled();
  const single = windowGated("post_file", stubEntry("post_file"));
  const kit = windowGatedKit("test_live_kit", { web_fetch: stubEntry("web_fetch") });
  try {
    for (const armed of [!before, before]) {
      overrideSettingsForTest({ delegation: { oneshotAgent: armed } });
      const shouldMount = !armed;
      eq(
        (await resolveWindowGated(single, grainCtx.native())) !== null,
        shouldMount,
        `live-read/windowGated: with delegation.oneshotAgent=${armed} set AFTER the resolver was built, an AUTHORED wide-hands tool (post_file) ${shouldMount ? "MOUNTS" : "is ABSENT"} on a native seat — the resolver re-read WINDOW_GATED_TOOLS[name] rather than holding the row it looked up at module load`,
      );
      const kitMount = (await resolveWindowGated(kit, grainCtx.native())) as Record<string, unknown> | null;
      eq(
        kitMount !== null && kitMount.web_fetch !== undefined,
        shouldMount,
        `live-read/windowGatedKit: …and the KIT wrapper agrees for a framework-named wide-hands tool (web_fetch) on the same seat`,
      );
      const fixed = windowGatedKit("test_live_fixed", { complete_thread: stubEntry("complete_thread") });
      eq(
        (await resolveWindowGated(fixed, grainCtx.native())) === null,
        true,
        `live-read/negative control: complete_thread is a FIXED ["thread"] row and stays ABSENT on a native seat with delegation.oneshotAgent=${armed}`,
      );
    }
  } finally {
    overrideSettingsForTest({ delegation: { oneshotAgent: before } });
  }
}

console.log("6b. a deployment change re-decides the seat (eve's own memo store):");
{
  const require6 = createRequire(import.meta.url);
  const eveRoot6 = dirname(require6.resolve("eve/package.json"));
  const abs6 = (rel: string) => pathToFileURL(join(eveRoot6, "dist", "src", rel)).href;
  const { openMemos } = (await import(abs6("definitions/memos.js"))) as {
    openMemos(o: { abortSignal: AbortSignal; afterDeployment?: boolean; kept?: Record<string, unknown>; label: string; scope: string; sessionId: string }): {
      memo: (key: unknown, fn: () => unknown) => Promise<unknown>;
      used: () => Record<string, unknown>;
      close: () => void;
    };
  };
  const kernel = readFileSync(join(eveRoot6, "dist", "src", "definitions", "kernel.js"), "utf8");
  ok(
    /function restoreDefinitions\(\w+,\w+=\{\}\)\{[^]*?if\(\w+\.revision!==void 0&&\w+\.revision!==\w+\.revision\)\{[^]*?let\{memos:\w+,\.\.\.\w+\}=\w+;writeDefinitionsState\(/.test(kernel),
    "🔴 eve's restoreDefinitions drops a session's memos when the deployment revision changes — the reason a deploy reaches a live seat",
  );
  const evaluateWith = async (gated: unknown, ctx: BindableContext, kept?: Record<string, unknown>) => {
    const memos = openMemos({ abortSignal: new AbortController().signal, ...(kept === undefined ? {} : { kept }), label: "agent/tools/deploy_kit.ts", scope: "tool::deploy_kit", sessionId: "sess-deploy" });
    try {
      const value = await resolveWindowGated(gated, { ...ctx, memo: memos.memo } as BindableContext);
      return { names: value === null ? [] : Object.keys(value as Record<string, unknown>).sort(), used: memos.used() };
    } finally {
      memos.close();
    }
  };
  const before = oneshotAgentEnabled();
  try {
    overrideSettingsForTest({ delegation: { oneshotAgent: false } });
    const kit = windowGatedKit("deploy_kit", { bash: stubEntry("bash"), work: stubEntry("work") });
    const nativeSeat = ctxOf(NATIVE_TOKEN, { sessionId: "sess-deploy" });
    const first = await evaluateWith(kit, nativeSeat);
    eq(first.names, ["bash"], "deployment A: a native seat mounts the wide-hands tool (delegation unarmed)");
    const again = await evaluateWith(kit, ctxOf(STANDING_TOKEN, { sessionId: "sess-deploy" }), first.used);
    eq(again.names, ["bash"], "…and eve's real memo store keeps that seat on a later model call of the same deployment");

    overrideSettingsForTest({ delegation: { oneshotAgent: true } });
    const kept = await evaluateWith(kit, nativeSeat, first.used);
    eq(kept.names, [], "🔴 deployment B narrows bash to the task worker: even a memo that SURVIVES the deploy mounts nothing, because each mount re-checks the row against the memoized grain");
    const fresh = await evaluateWith(kit, nativeSeat);
    eq(fresh.names, [], "…and with the memo discarded (eve's behaviour on a new revision) the seat is decided again, and bash stays withheld");

    overrideSettingsForTest({ delegation: { oneshotAgent: false } });
    const single = windowGated("post_file", stubEntry("post_file"));
    const singleFirst = await evaluateWith(single, nativeSeat);
    eq(Object.values(singleFirst.used), [{ grain: "native", mounted: true }], "windowGated memoizes the grain with the decision");
    overrideSettingsForTest({ delegation: { oneshotAgent: true } });
    const singleKept = await evaluateWith(single, nativeSeat, singleFirst.used);
    eq(singleKept.names, [], "🔴 …and a surviving memo cannot re-mount a single wide-hands tool on a row the deploy narrowed");
  } finally {
    overrideSettingsForTest({ delegation: { oneshotAgent: before } });
  }
}

console.log("7. the sandbox kit mounts through eve's real dynamic-tool contribution:");
{
  const require7 = createRequire(import.meta.url);
  const eveRoot7 = dirname(require7.resolve("eve/package.json"));
  const abs7 = (rel: string) => pathToFileURL(join(eveRoot7, "dist", "src", rel)).href;
  const { contributeTools } = (await import(abs7("definitions/tools.js"))) as {
    contributeTools(def: { logicalPath: string; slug: string }, value: unknown, ctx: unknown): { value: unknown; live?: { name: string; execute?: unknown }[] };
  };
  const { ContextContainer } = (await import(abs7("context/container.js"))) as { ContextContainer: new () => unknown };
  const { default: sandboxKit } = (await import("../agent/tools/sandbox_tools.js")) as { default: unknown };

  const SANDBOX_SEVEN = ["bash", "glob", "grep", "read_file", "write_file", "edit_file", "web_fetch"];
  const value = await resolveWindowGated(sandboxKit, grainCtx.task());
  const contributed = contributeTools({ logicalPath: "agent/tools/sandbox_tools.ts", slug: "sandbox_tools" }, value, new ContextContainer());
  eq((contributed.live ?? []).map((t) => t.name).sort(), [...SANDBOX_SEVEN].sort(), "eve accepts the task-seat kit: all SEVEN sandbox tools mount, and the kit is not dropped whole");
  ok((contributed.live ?? []).every((t) => typeof t.execute === "function"), "…and every mounted tool carries a live execute");

  const standing = await resolveWindowGated(sandboxKit, grainCtx.standing());
  const none = contributeTools({ logicalPath: "agent/tools/sandbox_tools.ts", slug: "sandbox_tools" }, standing, new ContextContainer());
  eq(none.live ?? [], [], "NEGATIVE CONTROL: on a standing seat the kit resolves to null and eve mounts nothing");

  const unbranded = { bash: { description: "raw", inputSchema: z.object({}), execute: async () => ({}) } };
  assert.throws(
    () => contributeTools({ logicalPath: "agent/tools/sandbox_tools.ts", slug: "sandbox_tools" }, unbranded, new ContextContainer()),
    /without defineTool/,
    "NEGATIVE CONTROL: eve refuses an entry not made with defineTool(), so the section reds on the real check and not on a stand-in",
  );
  n++;
}

console.log(`\nwindow-gated: ${n} assertions passed.`);

// proves: SEAT-memory-recall, SEAT-withheld-audit, TOOL-bash, TOOL-read_file

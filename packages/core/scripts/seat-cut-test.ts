// proves: AP-MOD-core-access-seat-cut, AP-MOD-core-access-seat-cut-slots

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { defineDynamic } from "eve/tools";
import {
  HALTED_WITHHELD_TOOLS,
  SEAT_CUT_STATIC_SLOTS,
  cutResolvedTools,
  seatCut,
  seatCutApplies,
  seatCutToolset,
  seatHolds,
  seatWithheldFromModelCall,
  type SeatCutPosture,
} from "../agent/access/seat-cut.js";
import { cutOfferedTools, withSeatToolCut } from "../agent/model/seat-tool-cut.js";
import { LEAN_SEAT_TOOLS, DM_SEAT_CARVE_IN } from "../agent/access/lean-seat.js";
import { WORKER_UNMOUNTED_TOOLS } from "../agent/access/worker-seat.js";
import { UNTRUSTED_REMOTE_WITHHELD_TOOLS } from "../agent/access/invoker-posture.js";
import { JOB_WAKE_TOOLS } from "../agent/access/window-gate-manifest.js";
import { setLeanSeatWake, setWorkTierWake } from "../agent/access/lean-seat-state.js";
import { setWorkerWake } from "../agent/access/worker-seat-state.js";
import { stampHalted } from "../agent/access/halt-state.js";
import { setInvokerPosture } from "../agent/access/invoker-posture-state.js";
import { setNativeDelegationSeat } from "../agent/access/native-delegation-state.js";
import { renderMountedShim } from "../agent/scaffold/roster-plan.js";
import { isTransformedAuthoredTool } from "../agent/access/authored-tool-transforms.js";
import { reexportSpecifierOf } from "../agent/scaffold/tool-roster.js";
import { EXPECTED_OFFERED, type SeatShape } from "../../../tests/integration/access/offered-toolset.expected.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n += 1;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n += 1;
};

const OPEN: SeatCutPosture = {
  workTier: "none",
  jobWake: "unrestricted",
  lean: false,
  dmSeat: false,
  worker: false,
  invoker: "interactive",
  halted: false,
  agentAllowed: true,
};

const UNION: readonly string[] = [
  ...new Set([
    ...Object.values(EXPECTED_OFFERED).flat(),
    ...LEAN_SEAT_TOOLS,
    ...DM_SEAT_CARVE_IN,
    ...WORKER_UNMOUNTED_TOOLS,
    ...UNTRUSTED_REMOTE_WITHHELD_TOOLS,
    ...HALTED_WITHHELD_TOOLS,
    "agent",
    "eve__task_wait",
    "eve__task_cancel",
    "eve__reply",
    "ask_question",
    "ask_room",
    "work",
    "cancel_work",
  ]),
].sort();

function held(posture: SeatCutPosture): string[] {
  return UNION.filter((name) => seatHolds(name, posture));
}

function cutBy(posture: SeatCutPosture, from: SeatCutPosture = OPEN): string[] {
  const open = new Set(held(from));
  const kept = new Set(held(posture));
  return [...open].filter((name) => !kept.has(name)).sort();
}

console.log("§1 every seat arm of the 0.71.0 projection, one at a time (seatCutToolset, the pure rule — §5 names what it cannot reach on eve 1.x)");
{
  eq(cutBy(OPEN), [], "the open posture (interactive wide seat that may delegate, tier none) cuts nothing but the tier-only verbs");
  ok(!seatHolds("work", OPEN) && !seatHolds("cancel_work", OPEN) && !seatHolds("ask_room", OPEN), "…and the tier-only verbs are absent off their tier");

  const lean = cutBy({ ...OPEN, workTier: "forwards", lean: true }, { ...OPEN, workTier: "forwards" });
  ok(lean.length > 0, "🔴 LEAN SEAT: the lean channel seat loses tools");
  ok(lean.every((name) => !LEAN_SEAT_TOOLS.has(name)), "…and never a name on the lean roster");
  ok(lean.includes("bash") && lean.includes("purge_memory") && lean.includes("web_search") && lean.includes("ask_question"), "…the rule cuts the hands, the admin verbs, web_search and ask_question (the last two are names the seat cut cannot reach on eve 1.x — §5)");
  ok(lean.includes("link_identity") && lean.includes("ask_domain"), "…and the DM carve-in on a channel seat");
  const dm = cutBy({ ...OPEN, workTier: "forwards", lean: true, dmSeat: true }, { ...OPEN, workTier: "forwards" });
  ok(!dm.includes("link_identity") && !dm.includes("ask_domain") && dm.includes("bash"), "🔴 LEAN DM SEAT: the DM carve-in survives, the hands do not");

  const job = cutBy({ ...OPEN, jobWake: "restricted" });
  ok(job.includes("bash") && job.includes("open_pull_request") && job.includes("agent"), "🔴 JOB WAKE: a restricted job wake loses the hands and the delegation verb");
  ok([...JOB_WAKE_TOOLS].every((name) => !job.includes(name)), "…and never a name of the job kit");

  const work = held({ ...OPEN, workTier: "work" });
  eq(work, ["agent", "eve__reply", "eve__task_cancel", "eve__task_wait"], "🔴 WORK SESSION: a work session holds only the delegation verb, its task verbs and the reply sink");
  ok(seatHolds("work", { ...OPEN, workTier: "forwards" }) && seatHolds("cancel_work", { ...OPEN, workTier: "forwards" }), "🔴 WORK FORWARD: a forwarding seat holds `work` and `cancel_work`");
  ok(seatHolds("ask_room", { ...OPEN, workTier: "child" }) && !seatHolds("ask_question", { ...OPEN, workTier: "child" }), "🔴 QUESTION SWAP: a work-session child holds ask_room, never ask_question");

  const worker = cutBy({ ...OPEN, worker: true });
  eq(worker, [...WORKER_UNMOUNTED_TOOLS].sort(), "🔴 WORKER SUBTRACTION: a worker loses exactly WORKER_UNMOUNTED_TOOLS");

  const remote = cutBy({ ...OPEN, invoker: "untrusted-remote" });
  eq(remote, [...UNTRUSTED_REMOTE_WITHHELD_TOOLS].sort(), "🔴 INVOKER POSTURE: an untrusted-remote invoker loses exactly the withheld set");
  eq(cutBy({ ...OPEN, invoker: "untrusted-remote", worker: true }, { ...OPEN, worker: true }), [], "…and a delegated worker is exempt, as on 0.71.0");

  eq(cutBy({ ...OPEN, halted: true }), [...HALTED_WITHHELD_TOOLS].sort(), "🔴 HALT: the rule withholds exactly web_search and web_fetch (on eve 1.x only the kit's web_fetch is reachable — §5)");

  eq(cutBy({ ...OPEN, agentAllowed: false }), ["agent", "eve__task_cancel", "eve__task_wait"], "🔴 AGENT GATE: the rule withholds `agent` and the task-parent verbs (none of which a file can reach on eve 1.x — §5)");
}

console.log("§2 the OPE-2687 expected rows: the seat cut never takes an expected tool, and on a lean seat it is the whole cut");
{
  const base: SeatCutPosture = { ...OPEN, agentAllowed: false };
  const shapes: readonly [SeatShape, SeatCutPosture][] = [
    ["leanChannelSeat", { ...base, workTier: "forwards", lean: true }],
    ["leanDmSeat", { ...base, workTier: "forwards", lean: true, dmSeat: true }],
    ["delegatedWorker", { ...base, workTier: "child", worker: true }],
    ["jobWakeRestricted", { ...base, jobWake: "restricted", worker: true, invoker: "unattended-fire" }],
    ["jobWakeOpen", { ...base, workTier: "child", worker: true, invoker: "unattended-fire" }],
    ["untrustedRemoteWindow", { ...base, invoker: "untrusted-remote" }],
    ["untrustedRemoteWindowNoOneshot", { ...base, invoker: "untrusted-remote" }],
    ["wideSeat", base],
    ["wideSeatNoOneshot", base],
    ["haltedWideSeatNoOneshot", { ...base, halted: true }],
  ];
  for (const [shape, posture] of shapes) {
    const row = EXPECTED_OFFERED[shape];
    eq(row.filter((name) => !seatHolds(name, posture)), [], `${shape}: the seat cut takes no tool the expected row holds`);
  }
  const extra = (shape: SeatShape, posture: SeatCutPosture) => held(posture).filter((name) => !EXPECTED_OFFERED[shape].includes(name) && !name.startsWith("eve__"));
  eq(
    extra("leanChannelSeat", shapes[0]![1]),
    ["complete_thread", "set_dm_delivery"],
    "🔴 leanChannelSeat: the seat cut holds nothing beyond the row but `complete_thread` (grain-gated to a thread seat) and `set_dm_delivery` (its own DM mount gate)",
  );
  eq(extra("leanDmSeat", shapes[1]![1]), ["complete_thread"], "🔴 leanDmSeat: the seat cut holds exactly the row, plus the thread-grain `complete_thread`");
  for (const name of [...UNTRUSTED_REMOTE_WITHHELD_TOOLS]) {
    ok(!seatHolds(name, shapes[5]![1]), `untrustedRemoteWindow: the seat cut withholds "${name}"`);
  }
}

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};
const inSession = <T>(fn: () => T): T => contextStorage.run(new ContextContainer(), fn);

const DYNAMIC = Symbol.for("eve.dynamic");
const evaluate = async (sentinel: unknown, ctx: unknown = { session: { id: "wrun_SEAT_CUT" } }): Promise<unknown> =>
  await (sentinel as Record<symbol, (c: unknown) => unknown>)[DYNAMIC]!(ctx);
const fake = (name: string) => ({
  description: name,
  inputSchema: { type: "object", properties: {} },
  execute: async () => name,
  approval: () => "not-applicable",
  toModelOutput: () => ({ type: "text", value: name }),
});
const heldAs = (got: unknown, authored: ReturnType<typeof fake>): boolean => {
  if (got === null || typeof got !== "object" || got === authored) return false;
  const copy = got as ReturnType<typeof fake>;
  return isTransformedAuthoredTool(copy) && copy.description === authored.description && copy.approval === authored.approval && copy.toModelOutput === authored.toModelOutput;
};

console.log("§3 the defineDynamic wrapper reads the live seat and cuts by absence");
{
  const bash = fake("bash");
  const reply = fake("reply");
  const replyExecute = reply.execute;
  const replySchema = reply.inputSchema;
  const lean = await inSession(async () => {
    setNativeDelegationSeat("allow");
    setWorkTierWake("forwards");
    setLeanSeatWake(true, false);
    return { bash: await evaluate(seatCut("bash", bash)), reply: await evaluate(seatCut("reply", reply)) };
  });
  ok(lean.bash === null, "🔴 a lean seat's evaluation of a cut tool returns null — the model never sees it");
  ok(heldAs(lean.reply, reply), "…and a held tool comes back as a transformed COPY that keeps its approval and toModelOutput");
  ok(replyExecute === reply.execute && replySchema === reply.inputSchema && !isTransformedAuthoredTool(reply), "…and the authored object, which every session shares, is not mutated");

  const wide = await inSession(async () => {
    setNativeDelegationSeat("allow");
    return await evaluate(seatCut("bash", bash));
  });
  ok(heldAs(wide, bash), "NEGATIVE CONTROL: the same wrapper on an unmarked seat holds the tool");

  const kit = defineDynamic(async () => ({ bash, web_fetch: fake("web_fetch"), glob: fake("glob") }) as never);
  const halted = (await inSession(async () => {
    setNativeDelegationSeat("allow");
    stampHalted(true);
    return await evaluate(seatCut("sandbox_tools", kit));
  })) as Record<string, unknown>;
  eq(Object.keys(halted).sort(), ["bash", "glob"], "🔴 a kit's map is filtered key by key — a halted seat keeps bash and glob, not web_fetch");

  // The dynamic-tool doctrine exempts seat-cut.ts from `memoized(` (scripts/dynamic-tool-doctrine-lint.ts).
  // The reason: a halt set in the middle of a session lands on the very next model call. The context
  // carries a session-scoped memo shaped like eve's `ctx.memo` (JSON records, one per key), so a cut
  // keyed with memoized(ctx, seatMemoKey(ctx), …) keeps the first posture and this check goes red.
  const EXEMPT = "[doctrine exemption: packages/core/agent/access/seat-cut.ts]";
  const saved = new Map<string, unknown>();
  const memoCtx = {
    session: { id: "wrun_SEAT_CUT_HALT" },
    memo: async (key: unknown, fn: () => unknown) => {
      const k = JSON.stringify(key);
      if (!saved.has(k)) saved.set(k, JSON.parse(JSON.stringify((await fn()) ?? null)));
      return saved.get(k);
    },
  };
  const webFetch = fake("web_fetch");
  const halt = await inSession(async () => {
    setNativeDelegationSeat("allow");
    const first = await evaluate(seatCut("web_fetch", webFetch), memoCtx);
    stampHalted(true);
    const next = await evaluate(seatCut("web_fetch", webFetch), memoCtx);
    return { first, next };
  });
  ok(heldAs(halt.first, webFetch), `${EXEMPT} model call 1 of the session, before the halt, holds web_fetch`);
  ok(halt.next === null, `🔴 ${EXEMPT} a halt set mid-session withholds web_fetch on the very next model call of the SAME session`);
  ok(saved.size === 0, `🔴 ${EXEMPT} the seat cut keeps no seat memo: each model call reads the live posture`);

  const remote = await inSession(async () => {
    setNativeDelegationSeat("allow");
    setInvokerPosture("untrusted-remote");
    return await evaluate(seatCut("sandbox_tools", kit));
  });
  ok(remote === null, "🔴 a kit whose every key is cut returns null, not an empty map");

  const worker = await inSession(async () => {
    setNativeDelegationSeat("allow");
    setWorkerWake(true);
    return await evaluate(seatCut("no_reply", fake("no_reply")));
  });
  ok(worker === null, "🔴 a worker's evaluation of no_reply returns null");

  const innerNull = await inSession(async () => {
    setNativeDelegationSeat("allow");
    return await evaluate(seatCut("thing", defineDynamic(() => null)));
  });
  ok(innerNull === null, "an inner dynamic that mounts nothing stays null");

  eq(cutResolvedTools("x", undefined, OPEN), null, "an undefined resolution is null, never a throw");

  const workflowLike = { [Symbol.for("eve:workflow-tool-brand")]: true };
  assert.throws(() => seatCut("ask_question", workflowLike), /SEAT_CUT_STATIC_SLOTS/u);
  n += 1;
  ok(Object.keys(SEAT_CUT_STATIC_SLOTS).includes("ask_question") && !seatCutApplies("ask_question") && seatCutApplies("reply"), "a workflow-tool slot is refused at load and named in the static list instead");
}

console.log("§4 every generated tool shim goes through the seat cut");
{
  const shim = renderMountedShim("@open-everywhere/core/agent/tools/reply.js", undefined, "reply");
  ok(shim.includes('import tool from "@open-everywhere/core/agent/tools/reply.js";'), "the shim imports the contributed module");
  ok(shim.includes('import { seatCut } from "@open-everywhere/core/agent/access/seat-cut.js";'), "…and the seat cut");
  ok(shim.includes('export default seatCut("reply", tool);'), "🔴 …and exports the seat-cut dynamic, never the bare tool");
  eq(reexportSpecifierOf(shim), "@open-everywhere/core/agent/tools/reply.js", "the roster reader still reads the contributed module off the new shim");
  const plain = renderMountedShim("@open-everywhere/core/agent/hooks/spend.js");
  ok(plain.includes('export { default } from "@open-everywhere/core/agent/hooks/spend.js";') && !plain.includes("seatCut"), "a non-tool slot keeps the plain re-export");
  const plan = readFileSync(new URL("../agent/scaffold/roster-plan.ts", import.meta.url), "utf8");
  ok(/renderMountedShim\([^\n]*r\.kind === "tool" && seatCutApplies\(r\.name\) \? r\.name : undefined\)/u.test(plan), "🔴 the plan renders every tool slot through the seat cut, except a named static slot");
  ok(!existsSync(new URL("../agent/access/untrusted-projection.ts", import.meta.url)), "the eve 0.x toolset projection is gone: no seat cut depends on a patch part");
}

console.log("§5 the names the seat cut cannot reach on eve 1.x are pinned, so the docs and this suite agree");
{
  eq(Object.keys(SEAT_CUT_STATIC_SLOTS), ["ask_question"], "ask_question is the one static roster slot: eve refuses a built-in workflow tool from a defineDynamic");
  const { readdirSync, existsSync } = await import("node:fs");
  const root = new URL("../../../", import.meta.url);
  const pkgDirs = ["packages/core", "packages/adapters", ...readdirSync(new URL("packages/providers/", root)).map((p) => `packages/providers/${p}`)];
  const slots = new Set<string>();
  for (const dir of pkgDirs) {
    const file = new URL(`${dir}/agent/contributions.ts`, root);
    if (!existsSync(file)) continue;
    const mod = (await import(file.href)) as { CONTRIBUTIONS?: { contributions?: readonly { kind: string; name: string }[] } };
    for (const c of mod.CONTRIBUTIONS?.contributions ?? []) if (c.kind === "tool") slots.add(c.name);
  }
  ok(slots.size > 50, `fixture guard — the contributed tool slots were read (${slots.size})`);
  const unreachable = ["agent", "web_search", "eve__skill", "eve__task_wait", "eve__task_cancel", "eve__tool", "eve__search"];
  eq(unreachable.filter((name) => slots.has(name)), [], "🔴 agent, web_search and the reserved eve__ names are NOT roster tool slots, so no seat-cut shim wraps them — the model-call cut (§6) hides them instead");
  const roster = readFileSync(new URL("roster.config.ts", root), "utf8");
  ok(!/\bweb_search\s*:/u.test(roster) && !/\bagent\s*:/u.test(roster), "…and roster.config.ts disables neither, so eve's own defaults stay mounted");
}

console.log("§6 the model-call cut hides each name eve mounts outside a seat-cut slot (OPE-2768, OPE-2748)");
{
  // The names eve 1.x mounts itself, with a route pair and a harness-internal name as controls.
  const EVE_MOUNTED = ["agent", "ask_question", "web_search", "glob", "grep", "eve__skill", "eve__task_wait", "eve__task_cancel", "fresh_eyes_review", "eve__tool", "eve__search", "eve__reply"];
  const offeredOf = (names: readonly string[]) => names.map((name) => ({ type: "function", name, description: name, inputSchema: { type: "object" } }));
  const cutNames = (names: readonly string[], posture: SeatCutPosture): string[] =>
    ((cutOfferedTools({ tools: offeredOf(names) }, posture) as { tools: { name: string }[] }).tools ?? []).map((t) => t.name).sort();
  const hidden = (posture: SeatCutPosture): string[] => EVE_MOUNTED.filter((name) => !cutNames(EVE_MOUNTED, posture).includes(name)).sort();
  const lean: SeatCutPosture = { ...OPEN, agentAllowed: false, workTier: "forwards", lean: true };

  eq(hidden(lean), ["agent", "ask_question", "eve__skill", "eve__task_cancel", "eve__task_wait", "fresh_eyes_review", "glob", "grep", "web_search"], "🔴 LEAN: a forwarding lean seat is offered none of web_search, ask_question, eve__skill, agent, the task-parent tools or a declared subagent");
  eq(hidden({ ...lean, dmSeat: true }), hidden(lean), "🔴 LEAN DM: the DM carve-in adds none of eve's own names");
  eq(hidden(OPEN), [], "NEGATIVE CONTROL: an open seat whose agent verdict is `allow` is offered every eve-mounted name");
  eq(hidden({ ...OPEN, agentAllowed: false }), ["agent", "eve__task_cancel", "eve__task_wait"], "🔴 AGENT + TASK-PARENT: a seat whose verdict is not `allow` is offered neither `agent` nor eve__task_wait/eve__task_cancel");
  eq(hidden({ ...OPEN, halted: true }), ["web_search"], "🔴 HALT: a halted seat is offered no web_search (web_fetch is a roster slot, cut by absence — §2)");
  eq(hidden({ ...OPEN, agentAllowed: false, workTier: "child", worker: true }), ["agent", "ask_question", "eve__task_cancel", "eve__task_wait"], "🔴 WORK CHILD: a work-session child is offered no ask_question (it asks with ask_room) and no native agent");
  const workSession = cutNames(EVE_MOUNTED, { ...OPEN, workTier: "work" });
  ok(["agent", "eve__task_cancel", "eve__task_wait"].every((name) => workSession.includes(name)), "🔴 WORK SESSION: the work session is still offered `agent`, `eve__task_cancel` and `eve__task_wait`");
  ok(!workSession.includes("ask_question") && !workSession.includes("web_search") && !workSession.includes("fresh_eyes_review"), "🔴 …and loses the rest of eve's own names");
  eq(hidden({ ...OPEN, workTier: "work", agentAllowed: false }).filter((name) => ["agent", "eve__task_cancel", "eve__task_wait"].includes(name)), ["agent", "eve__task_cancel", "eve__task_wait"], "NEGATIVE CONTROL: a work session whose verdict is not `allow` loses all three, so the assertion above reads the verdict");
  ok(cutNames(EVE_MOUNTED, { ...OPEN, agentAllowed: false, jobWake: "restricted", worker: true, invoker: "unattended-fire" }).includes("eve__tool"), "🔴 JOB WAKE: a restricted job wake keeps the eve__tool route — its reach is the read ops the cut kept (connector-mount-test §6)");
  for (const posture of [lean, { ...OPEN, agentAllowed: false, jobWake: "restricted" as const }, { ...OPEN, workTier: "work" as const }]) {
    ok(["eve__tool", "eve__search", "eve__reply"].every((name) => cutNames(EVE_MOUNTED, posture).includes(name)), "a route and the harness-internal eve__reply are never removed by the model-call cut");
  }
  eq(seatWithheldFromModelCall(["eve__tool", "eve__search"], lean), [], "the route pair is judged by its reach, never by name");
  ok(cutNames(EVE_MOUNTED, { ...OPEN, agentAllowed: false, jobWake: "restricted", worker: true, invoker: "unattended-fire" }).includes("eve__skill"), "a restricted job wake keeps eve__skill (JOB_WAKE_TOOLS): eve offers it only when the session has a skill");

  {
    const { __setTestValveForTest } = await import("../agent/testing/test-valves.js");
    const { setSeatToolsetStubForTest, seatCutCallRefusal } = await import("../agent/access/seat-cut.js");
    const EXTRA = "stub_added_probe";
    const reply = fake("reply");
    __setTestValveForTest("scripted-model", true);
    setSeatToolsetStubForTest((slug, toolset) => {
      if (slug === "reply" && toolset.reply !== undefined) toolset[EXTRA] = toolset.reply;
    });
    try {
      cutResolvedTools("reply", reply, lean);
      eq(seatWithheldFromModelCall([EXTRA, "agent"], lean), ["agent"], "TEST SEAM: a name the armed stub added is offered…");
      eq(seatCutCallRefusal(EXTRA, lean), undefined, "TEST SEAM: …and admitted at call time, so a stub gives a seat a tool on both edges");
      __setTestValveForTest("scripted-model", false);
      eq(seatWithheldFromModelCall([EXTRA], lean), [EXTRA], "🔴 NEGATIVE CONTROL: with the valve disarmed the exemption is gone on the model-call edge…");
      ok(seatCutCallRefusal(EXTRA, lean) !== undefined, "🔴 …and on the call-time edge");
    } finally {
      setSeatToolsetStubForTest(undefined);
      __setTestValveForTest("scripted-model", false);
    }
    __setTestValveForTest("scripted-model", true);
    eq(seatWithheldFromModelCall([EXTRA], lean), [EXTRA], "clearing the stub empties the exempt set");
    __setTestValveForTest("scripted-model", false);
  }

  const untouched = { tools: offeredOf(["reply", "agent"]) };
  ok(cutOfferedTools(untouched, OPEN) === untouched, "a call that loses nothing keeps its own options object");
  ok(cutOfferedTools({ prompt: [] }, lean).tools === undefined, "a call with no tools list is passed through");
  const cached = offeredOf(["reply", "agent"]) as { name: string; providerOptions?: unknown }[];
  cached[1]!.providerOptions = { anthropic: { cacheControl: { type: "ephemeral" } } };
  const moved = (cutOfferedTools({ tools: cached }, lean) as { tools: { name: string; providerOptions?: unknown }[] }).tools;
  eq(moved.map((t) => t.name), ["reply"], "the last tool is cut…");
  eq(moved[0]!.providerOptions, cached[1]!.providerOptions, "…and the new last tool takes its prompt-cache breakpoint");
  ok(cached[0]!.providerOptions === undefined, "…on a copy: the caller's entry is not mutated");

  const seen: string[][] = [];
  const fakeModel = {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    doGenerate: async (o: { tools: { name: string }[] }) => void seen.push(o.tools.map((t) => t.name)),
    doStream: async (o: { tools: { name: string }[] }) => void seen.push(o.tools.map((t) => t.name)),
  };
  const wrapped = withSeatToolCut(fakeModel, lean);
  await wrapped.doStream({ tools: offeredOf(["reply", "agent", "ask_question", "web_search", "eve__skill"]) });
  await wrapped.doGenerate({ tools: offeredOf(["reply", "ask_question"]) });
  eq(seen, [["reply"], ["reply"]], "🔴 the model wrapper sends the model only what the seat holds, on doStream and doGenerate");
  const live = await inSession(async () => {
    setNativeDelegationSeat("no-seat");
    setWorkTierWake("forwards");
    setLeanSeatWake(true, false);
    const m = withSeatToolCut(fakeModel);
    await m.doStream({ tools: offeredOf(["reply", "agent", "ask_question"]) });
    return seen.at(-1);
  });
  eq(live, ["reply"], "🔴 the wrapper reads the live seat posture when it is built inside the wake");

  const routing = readFileSync(new URL("../agent/model/routing.ts", import.meta.url), "utf8");
  ok(/return withSeatToolCut\(withWorkSessionCancelFence\(await resolveUnwrappedPrimaryModel\(/u.test(routing), "🔴 resolvePrimaryModel returns every model through the model-call cut, outside the work-session cancel fence");
  const scripted = readFileSync(new URL("../../../agent/model/scripted-resolve.ts", import.meta.url), "utf8");
  ok(scripted.includes("withSeatToolCut(withWorkSessionCancelFence(withEmptyStopReissue(withWorkerToolsetEvidenceModel("), "🔴 the integration tier's scripted model goes through the same cut, outermost");
}

console.log("§7 eve 1.0.2 offers no per-seat hide for these names (read from eve's own code, then run)");
{
  const evePath = (p: string) => pathToFileURL(join(eveRoot, "dist/src", p)).href;
  const defs = (await import(evePath("definitions/tools.js"))) as { contributeTools(def: unknown, value: unknown, ctx: unknown): { live?: Record<string, unknown>[] } };
  const { disableTool, defineTool } = await import("eve/tools");
  const { askQuestion } = await import("eve/tools/ask_question");
  const { webSearch } = await import("eve/tools/web_search");
  const eveAgent = (await import("eve/tools/agent")).default as unknown as Record<string, unknown>;
  const def = { logicalPath: "tools/probe.ts", slug: "probe" };
  const contribute = (value: unknown) => defs.contributeTools(def, value, new ContextContainer());
  const plain = defineTool({ description: "probe", inputSchema: { type: "object" }, execute: async () => "ok" });
  assert.throws(() => contribute({ agent: disableTool() }), /without defineTool/u);
  assert.throws(() => contribute({ ask_question: askQuestion }), /built-in workflow tool "ask_question", which only works as a static tool/u);
  assert.throws(() => contribute({ web_search: webSearch({ provider: "exa" }) }), /without defineTool/u);
  assert.throws(() => contribute({ eve__skill: plain }), /reserved tool name "eve__skill"/u);
  n += 4;
  const BEHAVIOR = Symbol.for("eve.tool-behavior");
  const liveAgent = (contribute({ agent: eveAgent }).live?.[0] ?? {}) as Record<string | symbol, unknown>;
  ok(
    JSON.stringify(eveAgent[BEHAVIOR as unknown as string]) === JSON.stringify({ availability: ["root-session"], handling: { action: "self-agent", kind: "dispatch" } }) && liveAgent[BEHAVIOR] === undefined && (liveAgent as { behavior?: unknown }).behavior === undefined,
    "🔴 a dynamic `agent` loses the built-in's self-agent dispatch, so a work session could not delegate through it",
  );
  ok((contribute({ probe: plain }).live?.length ?? 0) === 1, "NEGATIVE CONTROL: an authored defineTool is accepted from a dynamic");
  const resolveAgent = readFileSync(join(eveRoot, "dist/src/runtime/resolve-agent.js"), "utf8");
  ok(/function disabledToolNames\(e\)\{return e\.sourceComposition\.entries/u.test(resolveAgent), "🔴 disableTool() is read from the build's source composition: one verdict for every session, never per seat");
}

console.log(`\nall ${n} seat-cut assertions passed`);

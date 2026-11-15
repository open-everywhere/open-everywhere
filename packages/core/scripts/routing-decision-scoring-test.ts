// proves: DELG-52

import assert from "node:assert/strict";
import { ROUTING_ASKS, scoreRoutingTurn, summariseRoutingRun, SELF_ORCHESTRATION_TOOLS, THREAD_HANDOFF_TOOL, type RoutingAsk } from "./eval/routing-decision-offline.js";
import { ROUTING_DECISION } from "../agent/instructions/seat-prompt.js";
import { registerSyntheticConfig, unifiedCtx, buildShippedSystemPrompt, readBaseInstructions, buildLeanSeatToolset } from "./eval/_offline-seat.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const self = ROUTING_ASKS.filter((a) => a.expect === "self");
const thread = ROUTING_ASKS.filter((a) => a.expect === "thread");
ok(self.length >= 3, "§1 the pool carries asks the seat should orchestrate itself");
ok(thread.length >= 3, "§1 …and asks it should hand to a thread session");
eq(new Set(ROUTING_ASKS.map((a) => a.id)).size, ROUTING_ASKS.length, "§1 every ask id is unique");
ok(ROUTING_ASKS.every((a) => a.body.startsWith("<@BOT>") && a.why.length > 20), "§1 every ask addresses the seat and states why it sits on its side");

const anySelf = self[0] as RoutingAsk;
const anyThread = thread[0] as RoutingAsk;
const call = (...names: string[]) => names.map((name) => ({ name }));
eq(scoreRoutingTurn(anySelf, call("work")), { handedOff: false, orchestratedSelf: true, misrouted: false, noRoute: false }, "§2 a self ask run through the work session is correct");
eq(scoreRoutingTurn(anySelf, call("agent")), { handedOff: false, orchestratedSelf: true, misrouted: false, noRoute: false }, "§2 …and through `agent` on a seat that delegates directly");
eq(scoreRoutingTurn(anySelf, call("spawn_thread_session")).misrouted, true, "🔴 §2 a self ask handed to a thread session is the defect");
eq(scoreRoutingTurn(anyThread, call("spawn_thread_session")), { handedOff: true, orchestratedSelf: false, misrouted: false, noRoute: false }, "§2 a thread ask handed to a thread session is correct");
eq(scoreRoutingTurn(anyThread, call("work")).misrouted, true, "🔴 §2 a thread ask kept inline is the defect");
eq(scoreRoutingTurn(anyThread, call("work", "spawn_thread_session")).misrouted, false, "§2 a hand-off beside a stray job still reads as the hand-off");
const idle = scoreRoutingTurn(anyThread, call("reply", "no_reply"));
ok(idle.noRoute && !idle.misrouted, "§2 a turn that routes nothing is counted apart, never as the other side");
eq(
  summariseRoutingRun([
    { ask: anySelf, score: scoreRoutingTurn(anySelf, call("spawn_thread_session")) },
    { ask: anySelf, score: scoreRoutingTurn(anySelf, call("work")) },
    { ask: anyThread, score: scoreRoutingTurn(anyThread, call("work")) },
    { ask: anyThread, score: scoreRoutingTurn(anyThread, call("reply")) },
  ]),
  { selfAsks: 2, selfHandedOff: 1, selfNoRoute: 0, threadAsks: 2, threadKeptInline: 1, threadNoRoute: 1 },
  "§2 the summary reports each side separately, never one blended rate",
);

registerSyntheticConfig({ unified: true });
const system = await buildShippedSystemPrompt(unifiedCtx, () => readBaseInstructions());
ok(system.includes(ROUTING_DECISION), "🔴 §3 the shipped seat prompt the runner reads states the routing decision");
const tools = await buildLeanSeatToolset({ ctx: unifiedCtx, calls: [], resultFor: () => ({ ok: true }) });
ok(THREAD_HANDOFF_TOOL in tools, "🔴 §3 the seat holds the hand-off verb, so a `thread` ask CAN be handed off");
ok(SELF_ORCHESTRATION_TOOLS.some((t) => t in tools), "🔴 §3 …and a self-orchestration verb, so a `self` ask CAN be run inline");

console.log(`routing-decision-scoring: ${n} assertions passed`);

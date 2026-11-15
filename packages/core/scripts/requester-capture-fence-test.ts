import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-requester-capture-fence-")), "ops.sqlite3");

import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { unifiedSupervisorToken } from "../agent/channels/unified-supervisor.js";
import { buildRedriveReinject, divertToUnifiedWindow, dispatchApprovalDecisionWake, dispatchSeatMessage, dispatchTaskWindow, workResultAttributes, type UnifiedReceiveTarget } from "../agent/channels/unified.js";
import { mintWakeId, type UnifiedWakeOrigin } from "../agent/channels/unified-window.js";
import { formatWindowToken, taskWindowId } from "../agent/channels/window-key.js";
import { workTokenForSeat } from "../agent/channels/work.js";
import { BOT_ASK_RELAY_ATTR } from "../agent/channels/bot-ask.js";
import { a2aInboundFireAttributes, routineFireAttributes, surfaceWebhookFireAttributes } from "../agent/routines/fire-auth.js";
import { currentTurnId, deliveryStampOf, FIRE_UNATTENDED_ATTR, type BindableContext } from "../agent/identity/binding.js";
import { JOB_FIRE_ATTR } from "../agent/access/job-posture.js";
import { INVOKER_POSTURE_ATTR } from "../agent/access/invoker-posture.js";
import { nonMemberChatAttrs, OE_CHAT_NONMEMBER_ATTR } from "../agent/identity/non-member.js";
import { carriesNonRequesterStamp, nonRequesterAttrs, NON_REQUESTER_KINDS, OE_NON_REQUESTER_ATTR } from "../agent/identity/non-requester.js";
import { requesterAsksThisTurn, requesterMessagesThisTurn } from "../agent/access/requester-messages.js";
import { judgeContextOf } from "../agent/access/approval-judge.js";
import { noteContinuationTurn } from "../agent/access/continuation-turn-state.js";
import { noteTurnBoundary } from "../agent/access/task-wake-signal.js";
import { getSettings, overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";
import { registerSlackFixtureCodec, registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import type { RouteHandlerArgs } from "eve/channels";

registerSlackFixtureMapper();
registerSlackFixtureCodec();

const requesterHook = (await import("../agent/hooks/requester-messages.js")).default as unknown as {
  events: { "message.received": (event: unknown, ctx: unknown) => void };
};
const { captureEligible } = await import("../agent/hooks/requester-messages.js");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const SLACK_KEY = "slack/T_RCF/C_RCF";
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "fence", reach: [SLACK_KEY], ambientSupervisor: true, mode: "unified" }), defineDomain({ name: "org", match: "org" })],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === "C_RCF" ? ["fence"] : []),
});
overrideSettingsForTest({ window: { topology: true } });

const SEAT_TOKEN = unifiedSupervisorToken("fence", 1);
const origin: UnifiedWakeOrigin = { platform: "slack", channelId: "C_RCF", threadTs: "1720000000.001" };
const MEMBER_ASK = "please create the weekday numbers routine";
const memberEnvelope = (wakeId: string): string =>
  `<wake wake-id="${wakeId}"><channel><message from="human" author-id="U_MEMBER" trigger="true">${MEMBER_ASK}</message></channel></wake>`;
const MEMBER_BAG: Record<string, unknown> = { team_id: "T_RCF", channel_id: "C_RCF", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" };

interface CtxShape {
  readonly token?: string;
  readonly kind?: string;
  readonly parent?: Record<string, unknown>;
}
let sessionSeq = 0;
function ctxOf(attributes: Record<string, unknown>, shape: CtxShape = {}): unknown {
  sessionSeq++;
  return {
    channel: { kind: shape.kind ?? "slack", continuationToken: shape.token ?? SEAT_TOKEN },
    session: {
      id: `sess-rcf-${sessionSeq}`,
      turn: { id: "turn_0", sequence: 0 },
      ...(shape.parent !== undefined ? { parent: shape.parent } : {}),
      auth: { current: { attributes: { ...attributes }, principalId: "U_MEMBER", principalType: "slack-user" } },
    },
  };
}

function deliver(attributes: Record<string, unknown>, shape: CtxShape = {}, text = memberEnvelope("wake_rcf")) {
  return contextStorage.run(new ContextContainer(), () => {
    const ctx = ctxOf(attributes, shape);
    noteContinuationTurn(ctx as never);
    requesterHook.events["message.received"]({ data: { message: text, turnId: "turn_0" } }, ctx);
    const judge = judgeContextOf({ tool: "create_routine", args: {}, unattended: false } as never, { registryVerdict: "ask" } as never);
    return {
      eligible: captureEligible(ctx as never),
      messages: requesterMessagesThisTurn(),
      asks: requesterAsksThisTurn("turn_0"),
      judgeMessages: judge.requesterMessages ?? [],
    };
  });
}

function without(bag: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...bag };
  delete copy[key];
  return copy;
}

function refusedByStamp(label: string, bag: Record<string, unknown>, stamp: string, shape: CtxShape = {}): void {
  ok(bag[stamp] !== undefined, `${label}: precondition — the builder's bag carries ${stamp}`);
  const r = deliver(bag, shape);
  eq(r.eligible, false, `🔴 ${label}: the delivery is NOT capture-eligible`);
  eq(r.messages, [], `🔴 ${label}: the delivery reaches message.received and the requester slot stays EMPTY`);
  eq(r.asks, [], `${label}: …and no ask is recorded`);
  eq(r.judgeMessages, [], `${label}: …so the judge context carries no requester message`);
  const stripped = deliver(without(bag, stamp), shape);
  eq(stripped.messages, [memberEnvelope("wake_rcf")], `${label}: NEGATIVE CONTROL — the same bag WITHOUT ${stamp} is captured, so ${stamp} is the stamp that refuses it`);
}

interface Received {
  readonly message: string;
  readonly target: UnifiedReceiveTarget;
  readonly auth: { attributes?: Record<string, unknown> };
}
const received: Received[] = [];
const captureReceive = ((_ch: unknown, target: unknown) => ({
  async send(message: string, options: { auth: unknown }) {
    received.push({ message, target: target as UnifiedReceiveTarget, auth: options.auth as Received["auth"] });
    return {} as never;
  },
})) as unknown as RouteHandlerArgs["to"];

async function deliveredBag(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  received.length = 0;
  await run();
  assert.equal(received.length, 1, "exactly one delivery");
  return { ...(received[0]!.auth.attributes ?? {}) };
}

const memberDelivered = await deliveredBag(() =>
  divertToUnifiedWindow(captureReceive, { message: memberEnvelope("wake_member"), token: SEAT_TOKEN, window: { wakeId: "wake_member", origin }, surfaceKey: SLACK_KEY, auth: { attributes: { ...MEMBER_BAG } } }),
);

const taskToken = formatWindowToken({ domain: "fence", windowId: taskWindowId("slack/C_RCF", "1720000000.001"), generation: 1 });
const taskBriefBag = await deliveredBag(() =>
  dispatchTaskWindow({ token: taskToken, message: "do the thing", wakeId: mintWakeId(), domain: "fence", origin, parentAuthAttributes: { ...MEMBER_BAG } }),
);
const seatMessageBag = await deliveredBag(() => dispatchSeatMessage({ token: SEAT_TOKEN, origin, wakeId: mintWakeId(), domain: "fence", message: "Question from the payments domain: …", authAttributes: {} }));
const botRelayBag = await deliveredBag(() => dispatchSeatMessage({ token: SEAT_TOKEN, origin, wakeId: mintWakeId(), domain: "fence", message: "The other bot replied: …", authAttributes: { [BOT_ASK_RELAY_ATTR]: "true" } }));
const decisionBag = await deliveredBag(() =>
  dispatchApprovalDecisionWake({
    token: SEAT_TOKEN,
    origin,
    wakeId: mintWakeId(),
    message: "Your approval was decided: approved.",
    domain: "fence",
    binding: { org: "default", platform: "slack", workspace: "T_RCF", surface: "C_RCF", mode: "channel", visibility: "public", trust: "internal", target: { channelId: "C_RCF" }, threadTs: "1720000000.001" } as never,
    requester: { kind: "requester", principalId: "U_MEMBER" } as never,
    authAttributes: { ...MEMBER_BAG },
  }),
);

const redriveBag = await deliveredBag(async () => {
  const reinject = buildRedriveReinject("fence", SEAT_TOKEN, { ...MEMBER_BAG });
  assert.ok(reinject !== null, "precondition: the redrive has a dispatch path");
  await reinject(origin, "Your last turn ended in prose. Call `reply` to answer.", "wake_member");
});

const fireRoutine = {
  id: "r-rcf",
  org: "default",
  surfaceKey: SLACK_KEY,
  prompt: "summarise the numbers",
  promptGeneration: 1,
  createdBy: "U_MEMBER",
  trigger: { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" },
} as never;
const jobRoutine = { ...(fireRoutine as object), sessionMode: "job" } as never;

function runMatrix(mode: string): void {
  console.log(`— taint.mode: ${mode}`);

  {
    const r = deliver(memberDelivered);
    eq(r.eligible, true, `[${mode}] 🔴 a member's own channel message IS capture-eligible`);
    eq(r.messages, [memberEnvelope("wake_rcf")], `[${mode}] …the slot holds it`);
    eq(r.asks.map((a) => a.body), [MEMBER_ASK], `[${mode}] …the member's own ask is reduced from it`);
    eq(r.judgeMessages, [memberEnvelope("wake_rcf")], `[${mode}] 🔴 …and the approval judge's context carries it`);
    const dm = deliver({ team_id: "T_RCF", channel_id: "D_RCF", channel_type: "im" });
    eq(dm.messages, [memberEnvelope("wake_rcf")], `[${mode}] a member's own DM is captured too`);
  }

  refusedByStamp(`[${mode}] a routine fire`, routineFireAttributes(fireRoutine, {}, "channel", true, true, "fire_rcf"), FIRE_UNATTENDED_ATTR);
  refusedByStamp(`[${mode}] a webhook fire`, surfaceWebhookFireAttributes("hook_rcf", {}, false, true), FIRE_UNATTENDED_ATTR);
  refusedByStamp(`[${mode}] an inbound A2A task`, a2aInboundFireAttributes({ oe_a2a_caller: "acme" }, { attr: INVOKER_POSTURE_ATTR, value: "untrusted-remote" }), FIRE_UNATTENDED_ATTR);
  {
    const jobBag = routineFireAttributes(jobRoutine, {}, "channel", true, true, "fire_job");
    eq(jobBag[JOB_FIRE_ATTR], "true", `[${mode}] precondition: the real fire builder stamps a job routine's fire with the job-fire stamp`);
    refusedByStamp(`[${mode}] a job fire (unattended stamp)`, without(jobBag, JOB_FIRE_ATTR), FIRE_UNATTENDED_ATTR);
    refusedByStamp(`[${mode}] a job fire (job-fire stamp)`, without(jobBag, FIRE_UNATTENDED_ATTR), JOB_FIRE_ATTR);
  }

  refusedByStamp(`[${mode}] a non-member wake`, { ...MEMBER_BAG, ...nonMemberChatAttrs(true) }, OE_CHAT_NONMEMBER_ATTR);
  refusedByStamp(`[${mode}] a bot-ask relay (relay stamp)`, without(botRelayBag, OE_NON_REQUESTER_ATTR), BOT_ASK_RELAY_ATTR);
  refusedByStamp(`[${mode}] a bot-ask relay (seat-wake stamp)`, without(botRelayBag, BOT_ASK_RELAY_ATTR), OE_NON_REQUESTER_ATTR);

  refusedByStamp(`[${mode}] a domain question or answer (seat message, clean turn)`, seatMessageBag, OE_NON_REQUESTER_ATTR);
  refusedByStamp(`[${mode}] an approval decision wake`, decisionBag, OE_NON_REQUESTER_ATTR);
  refusedByStamp(`[${mode}] a thread session's opening brief (clean turn)`, taskBriefBag, OE_NON_REQUESTER_ATTR, { token: taskToken });
  refusedByStamp(
    `[${mode}] a work result wake (clean worker)`,
    workResultAttributes({ requestId: "req_rcf", requester: { kind: "requester", principalId: "U_MEMBER" }, nonMemberWake: false, tainted: false } as never),
    OE_NON_REQUESTER_ATTR,
  );
  refusedByStamp(`[${mode}] the auto-redrive's corrective wake (a copy of the member's bag)`, redriveBag, OE_NON_REQUESTER_ATTR);
  refusedByStamp(`[${mode}] an email wake with a quoted remainder`, { ...MEMBER_BAG, ...nonRequesterAttrs("email-remainder") }, OE_NON_REQUESTER_ATTR);

  {
    const parent = { sessionId: "sess-rcf-parent", callId: "call_rcf", turn: { id: "turn_3", sequence: 3 } };
    const child = deliver({ ...MEMBER_BAG, oe_parent_turn_tainted: "sess-rcf-parent|turn_3" }, { kind: "subagent", token: "subagent:sess-rcf-parent:call_rcf", parent });
    eq(child.messages, [], `[${mode}] 🔴 a native child carrying the parent's forward stamp captures nothing`);
    const clean = deliver({ ...MEMBER_BAG }, { kind: "subagent", token: "subagent:sess-rcf-parent:call_rcf", parent });
    eq(clean.messages, [], `[${mode}] 🔴 …and a native child with NO stamp captures nothing either: the delegation identity is the refusal`);
    eq(deliver({ ...MEMBER_BAG }).messages, [memberEnvelope("wake_rcf")], `[${mode}] CONTROL: the same bag in the seat shape is captured`);
  }
  {
    const turnCtx = (turnId: string, sequence: number, nonce: string) => {
      const ctx = ctxOf({ ...MEMBER_BAG, oe_delivery_id: nonce });
      (ctx as { session: { turn: { id: string; sequence: number } } }).session.turn = { id: turnId, sequence };
      return ctx as never as BindableContext;
    };
    const boundary = (ctx: BindableContext) => noteTurnBoundary(currentTurnId(ctx), deliveryStampOf(ctx));
    const receive = (ctx: BindableContext) => {
      noteContinuationTurn(ctx as never);
      requesterHook.events["message.received"]({ data: { message: memberEnvelope("wake_rcf"), turnId: currentTurnId(ctx) } }, ctx);
      return requesterMessagesThisTurn();
    };
    const settle = (turn1Nonce: string, liveNonce: string) =>
      contextStorage.run(new ContextContainer(), () => {
        boundary(turnCtx("turn_0", 0, "nonce-member"));
        boundary(turnCtx("turn_1", 1, turn1Nonce));
        return receive(turnCtx("turn_1", 1, liveNonce));
      });
    eq(settle("nonce-member", "nonce-member"), [], `[${mode}] 🔴 the inherited delivery of a turn that brought none of its own (a settlement wake on the member's bag) captures nothing`);
    eq(settle("nonce-next", "nonce-next"), [memberEnvelope("wake_rcf")], `[${mode}] CONTROL: the same bag on a turn with its OWN delivery is captured`);
    eq(
      settle("nonce-member", "nonce-in-turn"),
      [memberEnvelope("wake_rcf")],
      `[${mode}] 🔴 a person's message eve hands to that SAME uningressed turn later (a fresh nonce) IS captured — the refusal is the inherited delivery, never the whole turn`,
    );
  }
  {
    const wToken = workTokenForSeat(SEAT_TOKEN);
    ok(wToken !== undefined, `[${mode}] precondition: the seat has a work-session token`);
    const w = deliver({ ...MEMBER_BAG }, { token: wToken });
    eq(w.messages, [], `[${mode}] 🔴 a work-session hop captures nothing, with no stamp in its bag (the seat-shape control above is its negative control)`);
  }
}

for (const kind of NON_REQUESTER_KINDS) ok(carriesNonRequesterStamp(nonRequesterAttrs(kind)), `the reader sees the ${kind} stamp`);
ok(carriesNonRequesterStamp({ [OE_NON_REQUESTER_ATTR]: ["seat-wake"] }), "the reader is array-tolerant (eve can hand an attribute back as string[])");
ok(carriesNonRequesterStamp({ [OE_NON_REQUESTER_ATTR]: "a-kind-added-later" }), "an unknown kind still refuses: the fail-closed direction");
ok(!carriesNonRequesterStamp({}) && !carriesNonRequesterStamp(undefined) && !carriesNonRequesterStamp({ [OE_NON_REQUESTER_ATTR]: "" }), "no stamp, no refusal");
ok(carriesNonRequesterStamp(memberDelivered) === false, "🔴 a member's divert carries NO non-requester stamp (the divert adds none)");

runMatrix(getSettings().taint.mode);
overrideSettingsForTest({ window: { topology: true }, taint: { mode: "off" } } as never);
eq(getSettings().taint.mode, "off", "precondition: the taint plane is off");
runMatrix("off");
resetSettingsForTest();

{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../agent/hooks/requester-messages.ts"), "utf8");
  for (const sym of ["spawn-taint", "taint-turn", "taint-signal", "TAINT_SEED_ATTRS", "adoptedParentTurnTaintThisTurn", "OE_SPAWN_TAINTED_ATTR", "OE_TAINTED_FIRE_ATTR", "JOB_TAINT_ATTR", "untrustedIngestedThisTurn"]) {
    ok(!src.includes(sym), `🔴 hooks/requester-messages.ts names no taint symbol: ${sym}`);
  }
}


console.log(`\nrequester-capture-fence: ${n} assertions passed`);

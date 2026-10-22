import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { __setTestValveForTest, testValveArmed } from "@open-everywhere/core/agent/testing/test-valves.js";

import {
  auditCursor,
  bootAgent,
  registerScript,
  rowsSinceCursor,
  seatReply,
  slackDmWake,
  slackTs,
  WAKE_FROM_ENVELOPE,
  SLACK_TEAM_ID,
  waitFor,
  type ScriptedHandle,
} from "../harness";
import { installSlackWebApiStub, type SlackWebApiStub } from "../slack-web-api";

const live = new Set<ScriptedHandle>();
let stub: SlackWebApiStub | undefined;
afterAll(() => {
  for (const h of live) h.dispose();
  live.clear();
  stub?.uninstall();
});
function open(handle: ScriptedHandle): ScriptedHandle {
  live.add(handle);
  return handle;
}

const DM_USER_ID = "U0EXOWNER";
const RULE_DM = "D0OPE2668RULE";
const STOP_DM = "D0OPE2519STOP";
const GROUP_DM = "G0OPE2632GROUP";
const FAIL_DM = "D0OPE2632FAIL";

const HOLD_MS = 90_000;

let posted = 0;

function armSlackStub(): SlackWebApiStub {
  return installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: "U0OPE2519BOT", bot_id: "B0OPE2519BOT", team_id: SLACK_TEAM_ID };
      case "users.info":
        return { ok: true, user: { id: params.get("user"), team_id: SLACK_TEAM_ID, is_bot: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false, profile: { display_name: "ope2519-person" } } };
      case "agents.sessions.setStatus":
        return { ok: true, status: params.get("status") };
      case "reactions.add":
      case "reactions.remove":
      case "assistant.threads.setStatus":
        return { ok: true };
      case "chat.postMessage":
        return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 251_990 + ++posted) };
      default:
        return undefined;
    }
  });
}

type SignCall = readonly [method: string, ts: string | null, status: string | null];
function signCalls(s: SlackWebApiStub, channelId: string, name = "eyes"): SignCall[] {
  return s.calls
    .filter((c) => (c.method === "reactions.add" || c.method === "reactions.remove") && c.params.get("channel") === channelId && c.params.get("name") === name)
    .map((c): SignCall => [c.method, c.params.get("timestamp"), null]);
}

async function postSlackEvent(base: string, body: Record<string, unknown>, signed: boolean): Promise<{ status: number; body: string }> {
  const { SYNTHETIC_SLACK_ROUTE, signSlackRequest } = await import("../../../packages/core/scripts/e2e/synthetic");
  const rawBody = JSON.stringify(body);
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) throw new Error("the fork published no Slack signing secret — bootAgent did not run");
  const sig = signSlackRequest(rawBody, secret);
  const res = await fetch(`${base}${SYNTHETIC_SLACK_ROUTE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signed ? { "x-slack-request-timestamp": sig.timestamp, "x-slack-signature": sig.signature } : {}),
    },
    body: rawBody,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.text() };
}

function statusCalls(s: SlackWebApiStub): string[] {
  return s.calls.filter((c) => c.method === "assistant.threads.setStatus" || c.method === "agents.sessions.setStatus").map((c) => `${c.method} ${c.params.get("channel_id")}`);
}

test("a DM turn keeps 👀 through an interim post and takes it off when the final reply posts, before the park, with no status or session call (OPE-2668)", async () => {
  await bootAgent();
  stub ??= armSlackStub();
  const cursor = await auditCursor();
  const handle = open(
    registerScript({
      parent: [
        {
          calls: [
            { tool: "reply", input: { text: "On it — checking the launch plan.", wake: WAKE_FROM_ENVELOPE, done: false }, id: "ope2668-interim" },
            { tool: "update_status", input: { state: "working", summary: "ope-2668 checking" }, id: "ope2668-working" },
          ],
        },
        { calls: [{ tool: "reply", input: { text: "The launch review is on Friday.", wake: WAKE_FROM_ENVELOPE, force: true }, id: "ope2668-final" }] },
      ],
    }),
  );
  const spoofWas = testValveArmed("egress-spoof");
  __setTestValveForTest("egress-spoof", false);
  try {
    expect(signCalls(stub, RULE_DM)).toEqual([]);
    const rootTs = slackTs(Date.now(), 266_801);
    const res = await slackDmWake({ channelId: RULE_DM, userId: DM_USER_ID, text: "when is the launch review?", ts: rootTs });
    expect(res.status, `the DM wake POST was not accepted: ${res.body.slice(0, 200)}`).toBe(200);
    const eyes = await waitFor(() => {
      const calls = signCalls(stub!, RULE_DM);
      return calls.filter((c) => c[0] === "reactions.remove").length >= 2 ? calls : undefined;
    }, "the DM turn's 👀: on, off at the answer, off again at the park");
    expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    expect(eyes, "👀 on at the start, off at the final reply, off again at the park — all on the person's message").toEqual([
      ["reactions.add", rootTs, null],
      ["reactions.remove", rootTs, null],
      ["reactions.remove", rootTs, null],
    ]);
    const calls = stub.calls;
    const at = (pred: (c: (typeof calls)[number]) => boolean) => calls.findIndex(pred);
    const addAt = at((c) => c.method === "reactions.add" && c.params.get("channel") === RULE_DM && c.params.get("name") === "eyes");
    const interimAt = at((c) => c.method === "chat.postMessage" && c.params.get("channel") === RULE_DM && (c.params.get("text") ?? "").includes("On it"));
    const finalAt = at((c) => c.method === "chat.postMessage" && c.params.get("channel") === RULE_DM && (c.params.get("text") ?? "").includes("Friday"));
    const offAt = at((c) => c.method === "reactions.remove" && c.params.get("channel") === RULE_DM && c.params.get("name") === "eyes");
    expect(addAt >= 0 && addAt < interimAt && interimAt < finalAt && finalAt < offAt, `👀 on, interim post, final post, 👀 off (add ${addAt}, interim ${interimAt}, final ${finalAt}, off ${offAt})`).toBe(true);
    const cleared = await rowsSinceCursor(cursor, ["surface.working_sign_cleared"]);
    expect(cleared.length, "the final reply writes a surface.working_sign_cleared row; the interim post writes none").toBe(1);
    expect(statusCalls(stub), "🔴 no status-line or agent-session call reaches the wire (OPE-2668)").toEqual([]);
  } finally {
    __setTestValveForTest("egress-spoof", spoofWas);
    handle.dispose();
    live.delete(handle);
  }
});

test("a group DM turn puts 👀 on the person's message and takes it off with the final reply (OPE-2632, OPE-2668)", async () => {
  await bootAgent();
  stub ??= armSlackStub();
  const handle = open(registerScript({ parent: [seatReply("The manual covers setup and the surfaces.", "ope2632-group")] }));
  const spoofWas = testValveArmed("egress-spoof");
  __setTestValveForTest("egress-spoof", false);
  try {
    expect(signCalls(stub, GROUP_DM)).toEqual([]);
    const ts = slackTs(Date.now(), 251_905);
    const res = await slackDmWake({ channelId: GROUP_DM, kind: "mpim", userId: DM_USER_ID, text: "what does the manual cover?", ts });
    expect(res.status, `the group-DM wake POST was not accepted: ${res.body.slice(0, 200)}`).toBe(200);
    const signs = await waitFor(() => {
      const calls = signCalls(stub!, GROUP_DM);
      return calls.filter((c) => c[0] === "reactions.remove").length >= 2 ? calls : undefined;
    }, "the group-DM turn's 👀, on and off");
    expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    expect(signs, "👀 on, then off at the answer and at the park — on the person's group-DM message").toEqual([
      ["reactions.add", ts, null],
      ["reactions.remove", ts, null],
      ["reactions.remove", ts, null],
    ]);
    expect(statusCalls(stub), "no status-line or agent-session call reaches the wire").toEqual([]);
  } finally {
    __setTestValveForTest("egress-spoof", spoofWas);
    handle.dispose();
    live.delete(handle);
  }
});

test("a DM turn that fails for good ends with 👀 off and 🛑 on, and sends no status or session call (OPE-2632, OPE-2668)", async () => {
  await bootAgent();
  stub ??= armSlackStub();
  const cursor = await auditCursor();
  const handle = open(registerScript({ parent: [{ failsForGood: true }] }));
  const spoofWas = testValveArmed("egress-spoof");
  __setTestValveForTest("egress-spoof", false);
  try {
    const rootTs = slackTs(Date.now(), 251_906);
    const res = await slackDmWake({ channelId: FAIL_DM, userId: DM_USER_ID, text: "summarise the launch plan", ts: rootTs });
    expect(res.status, `the DM wake POST was not accepted: ${res.body.slice(0, 200)}`).toBe(200);
    const stop = await waitFor(() => {
      const calls = signCalls(stub!, FAIL_DM, "octagonal_sign");
      const eyesNow = signCalls(stub!, FAIL_DM);
      const settled = calls.some((c) => c[0] === "reactions.add") && eyesNow.some((c) => c[0] === "reactions.remove");
      return settled ? calls : undefined;
    }, "the failed DM turn's settle: 🛑 on, 👀 off");
    expect(stop, "the start takes any old 🛑 off; the failure puts 🛑 on — on the person's message").toEqual([
      ["reactions.remove", rootTs, null],
      ["reactions.add", rootTs, null],
    ]);
    const eyes = signCalls(stub, FAIL_DM);
    expect(eyes, "👀 on at the start, off at the failure").toEqual([
      ["reactions.add", rootTs, null],
      ["reactions.remove", rootTs, null],
    ]);
    expect(statusCalls(stub), "🔴 no status-line or agent-session call reaches the wire (OPE-2668)").toEqual([]);
    await waitFor(async () => ((await rowsSinceCursor(cursor, ["unified.supervisor_session_failed"])).length > 0 ? true : undefined), "the turn failed for good: a session.failed row, not a park");
    expect(handle.requests.length, "one model call: the failed one").toBe(1);
  } finally {
    __setTestValveForTest("egress-spoof", spoofWas);
    handle.dispose();
    live.delete(handle);
  }
});

test("Slack's Stop event stops the running turn through the ✋ arm's cancel path, and sends no session call", async () => {
  const { base } = await bootAgent();
  stub ??= armSlackStub();
  const cursor = await auditCursor();

  const handle = open(
    registerScript({
      parent: [
        { calls: [{ tool: "update_status", input: { state: "working", summary: "ope-2519 long job" }, id: "ope2519-ran" }] },
        { say: NO_REPLY_SENTINEL, delayMs: HOLD_MS, holdUntilCancelled: true },
      ],
    }),
  );
  const rootTs = slackTs(Date.now(), 251_903);
  const res = await slackDmWake({ channelId: STOP_DM, userId: DM_USER_ID, text: "start the long job", ts: rootTs });
  expect(res.status).toBe(200);
  const inFlight = await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the held second model call");
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const { buildAgentSessionStoppedEnvelope } = await import("../../../packages/core/scripts/e2e/synthetic");
  const press = buildAgentSessionStoppedEnvelope({ channelId: STOP_DM, threadTs: rootTs, userId: DM_USER_ID, teamId: SLACK_TEAM_ID, eventId: "EvOPE2519Stop1" });

  const unsigned = await postSlackEvent(base, press, false);
  expect(unsigned.status).not.toBe(200);
  expect(await rowsSinceCursor(cursor, ["turn.cancel_requested"])).toEqual([]);

  const signed = await postSlackEvent(base, press, true);
  expect(signed.status).toBe(200);
  const requested = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["turn.cancel_requested"]);
    return rows.length > 0 ? rows : undefined;
  }, "the turn.cancel_requested row the Stop route writes");
  expect(requested).toHaveLength(1);
  expect(requested[0]!.principalId).toBe(DM_USER_ID);
  expect(requested[0]!.detail?.via).toBe("stop-button");
  expect(requested[0]!.detail?.outcome).toBe("requested");
  expect(requested[0]!.detail?.turnId).toBe(inFlight.turnId);
  handle.releaseHolds();

  const cancelled = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["turn.cancelled"]);
    return rows.length > 0 ? rows : undefined;
  }, "the turn.cancelled row — the turn really stopped");
  expect(cancelled).toHaveLength(1);
  expect(handle.holdsCancelDelivered()).toBe(1);

  expect(statusCalls(stub), "🔴 no status-line or agent-session call reaches the wire").toEqual([]);
});

import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";

import {
  auditCursor,
  bootAgent,
  registerScript,
  rowsSinceCursor,
  seatReply,
  slackDmWake,
  slackTs,
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
const TITLE_DM = "D0OPE2519TITLE";
const STOP_DM = "D0OPE2519STOP";
const FORWARD_DM = "D0OPE2519FWD";

const HOLD_MS = 90_000;

function armSlackStub(): SlackWebApiStub {
  return installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: "U0OPE2519BOT", bot_id: "B0OPE2519BOT", team_id: SLACK_TEAM_ID };
      case "users.info":
        return { ok: true, user: { id: params.get("user"), team_id: SLACK_TEAM_ID, is_bot: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false, profile: { display_name: "ope2519-person" } } };
      case "agents.sessions.setStatus":
        return { ok: true, status: params.get("status") };
      default:
        return undefined;
    }
  });
}

function sessionCalls(s: SlackWebApiStub, channelId: string): { readonly status: string | null; readonly threadTs: string | null; readonly title: string | null }[] {
  return s.calls
    .filter((c) => c.method === "agents.sessions.setStatus" && c.params.get("channel_id") === channelId)
    .map((c) => ({ status: c.params.get("status"), threadTs: c.params.get("thread_ts"), title: c.params.get("title") }));
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

test("a new DM conversation gets a title, shows processing while it works and suspended while it waits on the person, and the answer returns it to active", async () => {
  await bootAgent();
  stub ??= armSlackStub();

  const asks = open(
    registerScript({
      parent: [
        { calls: [{ tool: "update_status", input: { state: "needs_input", summary: "which Friday?" }, id: "ope2519-needs" }] },
        seatReply("Which Friday do you mean?", "ope2519-ask"),
      ],
    }),
  );
  expect(sessionCalls(stub, TITLE_DM)).toEqual([]);

  const rootTs = slackTs(Date.now(), 251_901);
  const res = await slackDmWake({ channelId: TITLE_DM, userId: DM_USER_ID, text: "<@U0OPE2519BOT> Plan the *launch* review for Friday", ts: rootTs });
  expect(res.status, `the DM wake POST was not accepted: ${res.body.slice(0, 200)}`).toBe(200);

  const first = await waitFor(() => {
    const calls = sessionCalls(stub!, TITLE_DM);
    return calls.some((c) => c.status === "suspended") ? calls : undefined;
  }, "the park's suspended call on the new session");
  expect(asks.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(first.every((c) => c.threadTs === rootTs), `every call names the session the message opened (${JSON.stringify(first)})`).toBe(true);
  expect(first[0], "the DM door creates the session, titled, before the turn starts").toEqual({ status: "active", threadTs: rootTs, title: "Plan the launch review for Friday" });
  expect(first.slice(1).map((c) => c.status), "the turn shows processing, and its park shows suspended").toEqual(["processing", "suspended"]);
  expect(first.slice(1).every((c) => c.title === null), "only the creating call carries the title, so a person's rename is never overwritten").toBe(true);
  asks.dispose();
  live.delete(asks);

  const answers = open(registerScript({ parent: [seatReply("Noted — Friday the 16th.", "ope2519-answer")] }));
  const answerTs = slackTs(Date.now() + 1_000, 251_902);
  const res2 = await slackDmWake({ channelId: TITLE_DM, userId: DM_USER_ID, text: "the 16th", ts: answerTs, threadTs: rootTs });
  expect(res2.status).toBe(200);
  const second = await waitFor(() => {
    const calls = sessionCalls(stub!, TITLE_DM).slice(first.length);
    return calls.some((c) => c.status === "active") ? calls : undefined;
  }, "the answered turn's park, active");
  expect(second.map((c) => [c.status, c.threadTs]), "a thread reply makes no title call; processing, then active, on the same session").toEqual([
    ["processing", rootTs],
    ["active", rootTs],
  ]);
  expect(answers.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  answers.dispose();
  live.delete(answers);
});

test("a forwarded message with no typed text opens a session without a title — another conversation's words never title it", async () => {
  const { base } = await bootAgent();
  stub ??= armSlackStub();
  const handle = open(registerScript({ parent: [seatReply("Got the forward.", "ope2519-fwd")] }));
  const ts = slackTs(Date.now(), 251_904);
  const QUOTED = "Q3 board numbers from the private finance room";
  const res = await postSlackEvent(
    base,
    {
      type: "event_callback",
      team_id: SLACK_TEAM_ID,
      event_id: `EvOPE2519Fwd${ts.replace(".", "")}`,
      event_time: Math.floor(Number.parseFloat(ts)),
      event: {
        type: "message",
        channel: FORWARD_DM,
        channel_type: "im",
        user: DM_USER_ID,
        text: "",
        ts,
        event_ts: ts,
        team: SLACK_TEAM_ID,
        attachments: [{ is_share: true, text: QUOTED, author_name: "someone else" }],
      },
    },
    true,
  );
  expect(res.status).toBe(200);
  const calls = await waitFor(() => {
    const c = sessionCalls(stub!, FORWARD_DM);
    return c.some((x) => x.status === "active" && x.threadTs === ts) && c.some((x) => x.status === "processing") ? c : undefined;
  }, "the forwarded message's turn, processing then active");
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(calls.filter((c) => c.title !== null), `no session call carries a title (${JSON.stringify(calls)})`).toEqual([]);
  expect(handle.requests.some((r) => r.messages.some((m) => m.text.includes(QUOTED))), "the seat read the forwarded words").toBe(true);
  handle.dispose();
  live.delete(handle);
});

test("Slack's native Stop button stops the running turn through the ✋ arm's cancel path, and sets the session active", async () => {
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
  await waitFor(() => (sessionCalls(stub!, STOP_DM).some((c) => c.status === "processing" && c.threadTs === rootTs) ? true : undefined), "the session's processing call");

  const { buildAgentSessionStoppedEnvelope } = await import("../../../packages/core/scripts/e2e/synthetic");
  const press = buildAgentSessionStoppedEnvelope({ channelId: STOP_DM, threadTs: rootTs, userId: DM_USER_ID, teamId: SLACK_TEAM_ID, eventId: "EvOPE2519Stop1" });

  const unsigned = await postSlackEvent(base, press, false);
  expect(unsigned.status).not.toBe(200);
  expect(await rowsSinceCursor(cursor, ["turn.cancel_requested"])).toEqual([]);

  const pressCalls = sessionCalls(stub, STOP_DM).length;
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

  const pressedAt = pressCalls;
  await waitFor(
    () => (sessionCalls(stub!, STOP_DM).slice(pressedAt).filter((c) => c.status === "active" && c.threadTs === rootTs).length >= 2 ? true : undefined),
    "two active calls after the press: the Stop route's own, and the cancelled turn's park",
  );
});

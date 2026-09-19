import { randomBytes } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import {
  auditCursor,
  bootAgent,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  seatReply,
  SLACK_NAME_DROP_CHANNEL_ID,
  SLACK_TEAM_ID,
  slackChannelJoinEventPost,
  slackMessageEventPost,
  slackTs,
  waitFor,
  WAKE_FROM_ENVELOPE,
  type AuditCursor,
  type AuditRow,
  type ScriptedHandle,
  type SlackWebApiStub,
} from "../harness";

const BOT_USER_ID = "U0BOTSELF01";
const BOT_ID = "B0BOTSELF01";
const BOT_DISPLAY_NAME = "ottobot";

const TRIGGER_USER_ID = "U0MEMBER001";

const JOIN_CHANNEL_ID = `C0J${randomBytes(4).toString("hex").toUpperCase()}`;

const NAME_DROP_TEXT = "ope717-namedrop";
const ENGAGE_SEED_TEXT = "ope717-seed-engage";
const ENGAGED_TEXT = "ope717-engaged-thread-reply";
const JOIN_TEXT = "ope717-join-intro";

const cleanups: (() => void)[] = [];
let topologyBefore: boolean | undefined;

afterAll(async () => {
  for (const c of cleanups.splice(0)) c();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  if (topologyBefore !== undefined) settings.overrideSettingsForTest({ window: { topology: topologyBefore } });
});

let stub: SlackWebApiStub | undefined;
let postTs = 10;
let tsCounter = 100;

function userInfo(id: string, name: string): Record<string, unknown> {
  return { ok: true, user: { id, name, team_id: SLACK_TEAM_ID, real_name: name, profile: { display_name: name, real_name: name } } };
}

async function armSeams(): Promise<void> {
  await bootAgent();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  topologyBefore ??= settings.getSettings().window.topology;
  settings.overrideSettingsForTest({ window: { topology: false } });
  expect(settings.getSettings().window.topology).toBe(false);
  if (stub) return;
  const installed = installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER_ID, bot_id: BOT_ID, team_id: SLACK_TEAM_ID };
      case "users.info": {
        const user = params.get("user") ?? "";
        if (user === BOT_USER_ID) return userInfo(BOT_USER_ID, BOT_DISPLAY_NAME);
        if (user === TRIGGER_USER_ID) return userInfo(TRIGGER_USER_ID, "trigger-member");
        return undefined;
      }
      case "conversations.info":
        return {
          ok: true,
          channel: {
            id: params.get("channel"),
            name: "it-ope717",
            is_channel: true,
            is_private: false,
            is_ext_shared: false,
            is_org_shared: false,
            is_shared: false,
            is_pending_ext_shared: false,
            num_members: 9,
          },
        };
      case "conversations.history":
        return { ok: true, messages: [] };
      case "chat.postMessage":
        return { ok: true, channel: params.get("channel"), ts: `17000000${String(postTs++).padStart(2, "0")}.000000` };
      default:
        return undefined;
    }
  });
  stub = installed;
  cleanups.push(() => installed.uninstall());
}

function replyThen(text: string, id: string): ScriptedHandle {
  return registerScript({ parent: [{ calls: [{ tool: "reply", input: { text }, id }] }, { say: "ok" }] });
}

const REFUSAL = "couldn't resolve this conversation";

async function expectToolAccepted(handle: ScriptedHandle, label: string): Promise<void> {
  await waitFor(() => handle.requests.find((r) => r.stepIndex === 1), `the ${label} wake's trailing step`, 180_000);
  let last: { readonly name: string; readonly isError: boolean; readonly output: unknown } | undefined;
  for (const r of handle.requests) for (const t of r.toolResults) if (t.name === "reply") last = t;
  expect(last, `the ${label} wake's model never got a reply result at all`).toBeDefined();
  expect(last?.isError, `🔴 the ${label} wake's reply TOOL was refused: ${JSON.stringify(last?.output)}`).toBe(false);
}

async function toolReplyRow(cursor: AuditCursor, text: string): Promise<AuditRow> {
  return waitFor(
    async () => {
      const rows = await rowsSinceCursor(cursor, ["reply.post"], { limit: 200 });
      return rows.find((r) => r.detail?.route === "tool" && r.detail?.chars === text.length);
    },
    `the reply TOOL's own reply.post row (route "tool", ${text.length} chars)`,
    120_000,
  );
}

function expectBoundTo(row: AuditRow, channelId: string, label: string): void {
  expect(row.platform, `${label}: the tool bound the wrong platform`).toBe("slack");
  expect(row.workspace, `${label}: the tool bound the wrong workspace (the env stand-in?)`).toBe(SLACK_TEAM_ID);
  expect(row.surface, `${label}: the tool bound the wrong surface`).toBe(channelId);
}

test("① NAME-DROP WAKE — the reply TOOL resolves the real Slack surface", async () => {
  await armSeams();
  const handle = replyThen(NAME_DROP_TEXT, "ope717-nd");
  try {
    const at = Date.now();
    const ts = slackTs(at, (tsCounter += 1));
    const cursor = await auditCursor();
    const res = await slackMessageEventPost({
      channelId: SLACK_NAME_DROP_CHANNEL_ID,
      userId: TRIGGER_USER_ID,
      text: `hey ${BOT_DISPLAY_NAME}, ope717 name-drop`,
      ts,
      eventId: `EvND717${ts.replace(".", "")}`,
    });
    expect(res.status, `the Slack front refused the message event: ${res.body.slice(0, 200)}`).toBe(200);
    await expectToolAccepted(handle, "name-drop");
    const row = await toolReplyRow(cursor, NAME_DROP_TEXT);
    expectBoundTo(row, SLACK_NAME_DROP_CHANNEL_ID, "name-drop");
  } finally {
    handle.dispose();
  }
}, 300_000);

test("② ENGAGED-THREAD DELIVER — the reply TOOL resolves the real Slack surface", async () => {
  await armSeams();
  const rootTs = slackTs(Date.now(), (tsCounter += 1));
  const seed = replyThen(ENGAGE_SEED_TEXT, "ope717-seed");
  try {
    const seedCursor = await auditCursor();
    const seedRes = await slackMessageEventPost({
      channelId: SLACK_NAME_DROP_CHANNEL_ID,
      userId: TRIGGER_USER_ID,
      text: `hey ${BOT_DISPLAY_NAME}, ope717 engage this thread`,
      ts: rootTs,
      eventId: `EvSeed717${rootTs.replace(".", "")}`,
    });
    expect(seedRes.status, `the Slack front refused the seed event: ${seedRes.body.slice(0, 200)}`).toBe(200);
    await expectToolAccepted(seed, "engage-seed");
    await toolReplyRow(seedCursor, ENGAGE_SEED_TEXT);
  } finally {
    seed.dispose();
  }

  const handle = replyThen(ENGAGED_TEXT, "ope717-eng");
  try {
    const at = Date.now();
    const ts = slackTs(at, (tsCounter += 1));
    const cursor = await auditCursor();
    const res = await slackMessageEventPost({
      channelId: SLACK_NAME_DROP_CHANNEL_ID,
      userId: TRIGGER_USER_ID,
      text: "and one more thing",
      ts,
      threadTs: rootTs,
      eventId: `EvEng717${ts.replace(".", "")}`,
    });
    expect(res.status, `the Slack front refused the in-thread event: ${res.body.slice(0, 200)}`).toBe(200);
    await expectToolAccepted(handle, "engaged-thread");
    const row = await toolReplyRow(cursor, ENGAGED_TEXT);
    expectBoundTo(row, SLACK_NAME_DROP_CHANNEL_ID, "engaged-thread");
  } finally {
    handle.dispose();
  }
}, 300_000);

test("③ CHANNEL-JOIN INTRO — the reply TOOL resolves the real Slack surface", async () => {
  await armSeams();
  const handle = replyThen(JOIN_TEXT, "ope717-join");
  try {
    const at = Date.now();
    const ts = slackTs(at, (tsCounter += 1));
    const cursor = await auditCursor();
    const res = await slackChannelJoinEventPost({
      channelId: JOIN_CHANNEL_ID,
      userId: BOT_USER_ID,
      inviterId: TRIGGER_USER_ID,
      ts,
      eventId: `EvJoin717${ts.replace(".", "")}`,
    });
    expect(res.status, `the Slack front refused the join event: ${res.body.slice(0, 200)}`).toBe(200);
    await expectToolAccepted(handle, "channel-join intro");
    const row = await toolReplyRow(cursor, JOIN_TEXT);
    expectBoundTo(row, JOIN_CHANNEL_ID, "channel-join intro");
    expect(row.surface, "the join intro must NOT bind the name-drop channel").not.toBe(SLACK_NAME_DROP_CHANNEL_ID);
    expect(JSON.stringify(row.detail), "the join row must not carry the refusal").not.toContain(REFUSAL);
  } finally {
    handle.dispose();
  }
}, 300_000);

test("④ A SEAT-SHAPED REPLY ON A NATIVE SESSION — the scripted model faults and emits no call", async () => {
  await armSeams();
  const handle = registerScript({ parent: [seatReply("ope1695 seat-shaped reply on a native session", "ope1695-seat")] });
  try {
    const ts = slackTs(Date.now(), (tsCounter += 1));
    const res = await slackMessageEventPost({
      channelId: SLACK_NAME_DROP_CHANNEL_ID,
      userId: TRIGGER_USER_ID,
      text: `hey ${BOT_DISPLAY_NAME}, ope1695 seat-shaped probe`,
      ts,
      eventId: `EvSeat1695${ts.replace(".", "")}`,
    });
    expect(res.status, `the Slack front refused the message event: ${res.body.slice(0, 200)}`).toBe(200);

    const faulted = await waitFor(
      () => handle.requests.find((r) => r.fault !== undefined),
      "the scripted model's unresolved-placeholder fault",
      180_000,
    );
    expect(faulted.fault).toContain(WAKE_FROM_ENVELOPE);

    expect(handle.requests.flatMap((r) => r.toolResults).find((t) => t.name === "reply")).toBeUndefined();
  } finally {
    handle.dispose();
  }
}, 300_000);

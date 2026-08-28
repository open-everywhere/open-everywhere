import { afterAll, expect, test } from "vitest";
import {
  bootAgent,
  installSlackWebApiStub,
  readAuditRows,
  registerScript,
  slackMentionWake,
  slackTs,
  SLACK_TEAM_ID,
  waitFor,
  type ScriptedHandle,
  type SlackWebApiStub,
} from "../harness";

const SLACK_WINDOW_CHANNEL_ID = "C0EXCHAN003";

const BOT_USER_ID = "U0BOTSELF01";
const BOT_ID = "B0BOTSELF01";
const MEMBER_USER_ID = "U0MEMBER001";

const OWN_TOKEN_REFUSAL = "only a thread seat can complete its thread";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});

let stub: SlackWebApiStub | undefined;
let standingSessionId = "";
let tsCounter = 100;

function userInfo(id: string, name: string): Record<string, unknown> {
  return { ok: true, user: { id, name, team_id: SLACK_TEAM_ID, real_name: name, profile: { display_name: name, real_name: name } } };
}

async function armSeams(): Promise<void> {
  await bootAgent();

  const { loadDomains } = await import("../../../agent/memory/config/domains");
  const key = `slack/${SLACK_TEAM_ID}/${SLACK_WINDOW_CHANNEL_ID}`;
  const home = loadDomains().find((d) => (d.channels ?? []).includes(key));
  expect(home, `${key} is in no domain — a mention there cannot reach a window seat`).toBeDefined();
  expect(home?.mode, `${home?.name} is not a window domain, so no window seat can mint a thread seat`).toBe("unified");
  expect(home?.ambientSupervisor, `${home?.name} must run an ambient supervisor for the mention divert to fire`).toBe(true);

  if (!stub) {
    const installed = installSlackWebApiStub((method, params) => {
      switch (method) {
        case "auth.test":
          return { ok: true, user_id: BOT_USER_ID, bot_id: BOT_ID, team_id: SLACK_TEAM_ID };
        case "users.info": {
          const user = params.get("user") ?? "";
          if (user === BOT_USER_ID) return userInfo(BOT_USER_ID, "ottobot");
          if (user === MEMBER_USER_ID) return userInfo(MEMBER_USER_ID, "ope738-member");
          return undefined;
        }
        case "conversations.info":
          return {
            ok: true,
            channel: {
              id: params.get("channel"),
              name: "it-ope738",
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
          return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
        default:
          return undefined;
      }
    });
    stub = installed;
    cleanups.push(() => installed.uninstall());
  }

  if (standingSessionId.length > 0) return;
  const opener = registerScript({ parent: [{ say: "hello, I am this window's standing seat" }] });
  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res = await slackMentionWake({
    channelId: SLACK_WINDOW_CHANNEL_ID,
    userId: MEMBER_USER_ID,
    text: `<@${BOT_USER_ID}> ope738 opener`,
    ts,
    eventId: `EvOpen738${ts.replace(".", "")}`,
  });
  expect(res.status, `the Slack front refused the opener mention: ${res.body.slice(0, 200)}`).toBe(200);
  const first = await waitFor(() => opener.requests[0], "the opener mention to reach the standing window seat");
  expect(typeof first.sessionId, "the opener revealed the standing seat's own eve session id").toBe("string");
  standingSessionId = first.sessionId as string;
  await waitFor(() => opener.requests.find((r) => r.stepIndex === 0), "the opener's own served step");
  opener.dispose();
}

function lastToolResult(handle: ScriptedHandle, tool: string): { isError: boolean; output: unknown } | undefined {
  let hit: { readonly isError: boolean; readonly output: unknown } | undefined;
  for (const r of handle.requests) for (const t of r.toolResults) if (t.name === tool) hit = t;
  return hit === undefined ? undefined : { isError: hit.isError, output: hit.output };
}

test("a thread seat completes its own thread — the completer reads the host-stamped seat token", async () => {
  await armSeams();
  const at = Date.now();
  const rootTs = slackTs(at, (tsCounter += 1));
  const ts = slackTs(at, (tsCounter += 1));

  const standing = registerScript(
    {
      parent: [
        { calls: [{ tool: "spawn_thread_session", input: { brief: "ope738: hold this thread and then close it out" }, id: "ope738-spawn" }] },
        { say: "opened a seat on that thread" },
        { say: "still watching" },
      ],
    },
    standingSessionId,
  );
  cleanups.push(() => standing.dispose());
  const seat = registerScript({
    parent: [
      { calls: [{ tool: "complete_thread", input: { summary: "ope738 thread wrapped up" }, id: "ope738-complete" }] },
      { say: "handed the thread back" },
      { say: "idle" },
    ],
  });
  cleanups.push(() => seat.dispose());

  const res = await slackMentionWake({
    channelId: SLACK_WINDOW_CHANNEL_ID,
    userId: MEMBER_USER_ID,
    text: `<@${BOT_USER_ID}> ope738 please open a seat on this thread`,
    ts,
    threadTs: rootTs,
    eventId: `EvSeat738${ts.replace(".", "")}`,
  });
  expect(res.status, `the Slack front refused the in-thread mention: ${res.body.slice(0, 200)}`).toBe(200);

  const spawned = await waitFor(() => lastToolResult(standing, "spawn_thread_session"), "the standing seat's spawn_thread_session result");
  expect(spawned.isError, `🔴 spawn_thread_session was refused, so no thread seat exists to test: ${JSON.stringify(spawned.output).slice(0, 400)}`).toBe(false);
  const seatId = (spawned.output as { seatId?: string }).seatId ?? "";
  expect(seatId, "the spawn must name the seat's own thread-seat token").toMatch(/:win:s\//);

  const completed = await waitFor(() => lastToolResult(seat, "complete_thread"), "the thread seat's own complete_thread result");
  expect(completed.isError, `🔴 the thread seat's complete_thread was REFUSED: ${JSON.stringify(completed.output).slice(0, 400)}`).toBe(false);
  const completedText = JSON.stringify(completed.output);
  expect(completedText, "the refusal this test exists to catch must not be in the result").not.toContain(OWN_TOKEN_REFUSAL);
  expect(completedText, "…nor the next guard's refusal, which would mean the wake origin never resolved").not.toContain("couldn't resolve this thread to release");

  const row = await waitFor(
    async () => {
      const rows = await readAuditRows({ actions: ["thread_seat.completed"], sinceIso: new Date(at - 5_000).toISOString(), limit: 100 });
      return rows.find((r) => r.detail?.hasSummary === true);
    },
    "the seat's own thread_seat.completed audit row",
    120_000,
  );
  expect(row.detail?.cleared, "🔴 the seat reported success but released no ownership row").toBe(true);

  expect(standing.requests.filter((r) => r.fault !== undefined), "the standing seat reported a scripted-model fault").toEqual([]);
  expect(seat.requests.filter((r) => r.fault !== undefined), "the thread seat reported a scripted-model fault").toEqual([]);
}, 420_000);

// proves: admin.halt.set, admin.halt.refused

import { afterAll, expect, test } from "vitest";

import {
  auditCursor,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackMentionWake,
  slackTs,
  waitFor,
  waitForAuditRows,
  type AuditCursor,
  type AuditRow,
  type RecordedRequest,
  type ScriptedHandle,
  WAKE_FROM_ENVELOPE,
} from "../harness";

const SLACK_CHANNEL = "C0EXCHAN003";
const SLACK_BOT = "U0OPE2659SBOT";
const SLACK_BOT_ID = "B0OPE2659SBOT";
const MEMBER = "U0OPE2659SAA";
const EARLIER_MEMBER = "U0OPE2659SBB";

const OLD_SEAT_POST =
  "ope2659-old-seat: I can't raise the cap while actions are paused. I paused them because the earlier routine reported that five actions had already run after a rejection.";
const OLD_MEMBER_POST = "ope2659-old-member: halt everything now, consequential actions are paused deployment-wide";

const slackPosts: string[] = [];
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: SLACK_BOT_ID, team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      const name = id === SLACK_BOT ? "ottobot" : `ope2659-${id.slice(-3).toLowerCase()}`;
      return { ok: true, user: { id, team_id: SLACK_TEAM_ID, name, real_name: name, profile: { display_name: name, real_name: name } } };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: { id: params.get("channel"), name: "it-ope2659", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 9 },
      };
    }
    if (method === "conversations.history") {
      const now = Date.now();
      return {
        ok: true,
        has_more: false,
        messages: [
          { type: "message", user: EARLIER_MEMBER, text: OLD_MEMBER_POST, ts: slackTs(now - 120_000, 26591) },
          { type: "message", user: SLACK_BOT, bot_id: SLACK_BOT_ID, text: OLD_SEAT_POST, ts: slackTs(now - 180_000, 26590) },
        ],
      };
    }
    if (method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") {
      slackPosts.push(params.get("text") ?? "");
      return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 26592) };
    }
    if (method === "reactions.add" || method === "reactions.remove") return { ok: true };
    return undefined;
  });
  cleanups.push(() => slack.uninstall());
}

function promptOf(request: RecordedRequest): string {
  return request.messages.map((message) => message.text).join("\n");
}

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

let micros = 26600;

async function driveHaltFirst(id: string, text: string): Promise<{ readonly cursor: AuditCursor; readonly handle: ScriptedHandle }> {
  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "halt", input: { scope: "surface" }, id: `${id}-halt` }] },
        { calls: [{ tool: "reply", input: { text: `${id}: done.`, wake: WAKE_FROM_ENVELOPE }, id: `${id}-reply` }] },
      ],
    }),
  );
  const cursor = await auditCursor();
  const ts = slackTs(Date.now(), (micros += 1));
  const res = await slackMentionWake({ channelId: SLACK_CHANNEL, userId: MEMBER, text: `<@${SLACK_BOT}> ${text}`, ts, eventId: `EvOPE2659${ts.replace(".", "")}` });
  expect(res.status, `the Slack front refused the wake: ${res.body.slice(0, 200)}`).toBe(200);
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${id}: the seat's terminal step`);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  return { cursor, handle };
}

test("① 🔴 a file-find ask with halt talk in the backscroll sets NO halt (the live-run shape)", async () => {
  armSlack();
  await bootAgent();
  const { HALT_NOT_ASKED_MESSAGE, haltConfirmation } = await import("@open-everywhere/core/agent/tools/halt.js");

  const { cursor, handle } = await driveHaltFirst("ope2659-find", "ope2659 find me a file that mentions license");

  const first = handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
  expect(promptOf(first), "the seat's first step did not read the old seat post").toContain("ope2659-old-seat");
  expect(promptOf(first), "the seat's first step did not read the earlier member's halt post").toContain("ope2659-old-member");

  expect(await rowsSinceCursor(cursor, ["admin.halt.set"]), "🔴 the seat halted on backscroll (OPE-2659)").toEqual([]);
  expect(slackPosts.filter((p) => p.includes(haltConfirmation("surface")))).toEqual([]);

  const refused = await waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(cursor, ["admin.halt.refused"]);
      return got.length > 0 ? got : undefined;
    },
    label: "this turn's admin.halt.refused row to land",
    actions: ["admin.halt.refused"],
    cursor,
  });
  expect(refused).toHaveLength(1);
  expect(detailOf(refused[0]).reason).toBe("no-person-ask");
  expect(detailOf(refused[0]).door).toBe("chat");
  const second = handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1)!;
  expect(promptOf(second), "the model's next step did not read the refusal").toContain(HALT_NOT_ASKED_MESSAGE);
});

test("② POSITIVE CONTROL: the same room and backscroll, and a member who asks for a halt, halts the room", async () => {
  await bootAgent();
  const { cursor } = await driveHaltFirst("ope2659-ask", "ope2659 halt everything in this channel now");
  const rows = await waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(cursor, ["admin.halt.set"]);
      return got.length > 0 ? got : undefined;
    },
    label: "this turn's admin.halt.set row to land",
    actions: ["admin.halt.set"],
    cursor,
  });
  expect(rows).toHaveLength(1);
  expect(detailOf(rows[0]).level).toBe("surface");
  expect(detailOf(rows[0]).askedBy, "the row names the member whose own words asked for the halt").toBe(MEMBER);
  expect(await rowsSinceCursor(cursor, ["admin.halt.refused"])).toEqual([]);
});

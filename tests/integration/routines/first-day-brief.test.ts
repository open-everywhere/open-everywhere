import { expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";

import {
  auditCursor,
  bootAgent,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  seatReply,
  SLACK_TEAM_ID,
  slackDmWake,
  slackInteractivityPost,
  slackTs,
  waitFor,
  type AuditRow,
} from "../harness";
import { installSlackWebApiStub } from "../slack-web-api";

const PERSON = "U0OPE2662ANA";
const DM = "D0OPE2662ANA";
const DM_KEY = `slack/${SLACK_TEAM_ID}/${DM}`;
const BRIEF_TEXT = "ope2662 first brief: nothing waits on you this morning";

interface SlackButton {
  readonly action_id: string;
  readonly value?: string;
}

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

test("🔴 a person's first DM turn posts the first-day card; Set it up arms the brief and the needs-you watch; the first brief posts at once", async () => {
  let tsCounter = 266_200;
  const slack = installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: "U0OPE2662BOT", bot_id: "B0OPE2662BOT", team_id: SLACK_TEAM_ID };
      case "users.info":
        return { ok: true, user: { id: params.get("user"), team_id: SLACK_TEAM_ID, deleted: false, is_bot: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false } };
      case "conversations.open":
        return { ok: true, channel: { id: DM } };
      case "conversations.info":
        return { ok: true, channel: { id: params.get("channel"), is_im: true, is_channel: false, is_private: true, num_members: 2 } };
      case "conversations.members":
        return { ok: true, members: [PERSON, "U0OPE2662BOT"], response_metadata: { next_cursor: "" } };
      case "conversations.history":
      case "conversations.replies":
        return { ok: true, messages: [] };
      case "chat.postMessage":
        return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
      case "chat.update":
      case "chat.postEphemeral":
      case "reactions.add":
      case "reactions.remove":
      case "agents.sessions.setStatus":
        return { ok: true };
      default:
        return undefined;
    }
  });
  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  try {
    const org = deploymentOrg();
    const store = getOperationalStore();

    const firstTurn = disposeLater(registerScript({ parent: [seatReply("Hi! I'm here. What do you work on?", "ope2662-hi")] }));
    const cursor = await auditCursor();
    const postMark = slack.calls.length;
    const res = await slackDmWake({ channelId: DM, userId: PERSON, text: "hi there", ts: slackTs(Date.now(), 266_100) });
    expect(res.status, `the DM wake POST was not accepted: ${res.body.slice(0, 200)}`).toBe(200);
    const buttons = await waitFor(() => {
      for (const call of slack.calls.slice(postMark)) {
        if (call.method !== "chat.postMessage" || call.params.get("channel") !== DM) continue;
        const raw = call.params.get("blocks") ?? "[]";
        if (!raw.includes("Want a morning brief and check-ins?")) continue;
        const blocks = JSON.parse(raw) as { type?: string; elements?: SlackButton[] }[];
        return blocks.flatMap((b) => (b.type === "actions" ? (b.elements ?? []) : [])).filter((e) => e.action_id.startsWith("oe_approval:"));
      }
      return undefined;
    }, "🔴 the first-day card in the person's DM — the enrolment hook is not mounted, or never called the offer");
    expect(buttons.map((b) => b.action_id.split(":")[1]), "the card carries Set it up and No thanks").toEqual(["approve", "reject"]);
    const proposed = await waitFor(async () => (await rowsSinceCursor(cursor, ["personal_watch.proposal"], { limit: 200 })).find((r) => r.principalId === `slack/${SLACK_TEAM_ID}/${PERSON}`), "the personal_watch.proposal row");
    expect(detailOf(proposed).fingerprint, "the row names the first-day brief").toBe("first-day-brief");
    await waitFor(() => firstTurn.requests.find((r) => r.role === "parent"), "the DM seat's own turn still ran");
    firstTurn.dispose();

    const approve = buttons.find((b) => b.action_id.startsWith("oe_approval:approve:"))!;
    const pendingId = approve.action_id.split(":")[2]!;
    const cardTs = (await store.getPendingAction(org, pendingId))?.messageTs;
    expect(typeof cardTs, "the card's ts is stored").toBe("string");
    const decisionTurn = disposeLater(registerScript({ parent: [{ say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }] }));
    const clickCursor = await auditCursor();
    const clicked = await slackInteractivityPost({
      type: "block_actions",
      user: { id: PERSON },
      channel: { id: DM },
      team: { id: SLACK_TEAM_ID },
      message: { ts: cardTs },
      actions: [{ action_id: approve.action_id, type: "button", value: approve.value }],
    });
    expect(clicked.status, `the Slack front refused the click: ${clicked.body.slice(0, 200)}`).toBe(200);
    const created = await waitFor(async () => {
      const rows = (await rowsSinceCursor(clickCursor, ["routine.create"], { limit: 200 })).filter((r) => r.surface === DM);
      return rows.length >= 2 ? rows : undefined;
    }, "🔴 two routine.create rows in the DM — the booted card kind did not arm the brief and the needs-you watch");
    expect(created).toHaveLength(2);
    const routines = await store.listRoutines(org, DM_KEY);
    const brief = routines.find((r) => r.trigger.kind === "cron");
    const needsYou = routines.find((r) => r.trigger.kind === "watch");
    expect(brief?.createdBy, "the brief is the person's").toBe(PERSON);
    expect(needsYou?.quietWhenEmpty, "the needs-you watch is quiet when empty").toBe(true);
    expect(brief?.nextRunAt !== null && Date.parse(brief!.nextRunAt!) <= Date.now(), "🔴 the brief's first run is due at once").toBe(true);
    decisionTurn.dispose();

    disposeLater(registerScript({ parent: [seatReply(BRIEF_TEXT, "ope2662-brief"), { say: NO_REPLY_SENTINEL }], child: [{ say: BRIEF_TEXT }] }));
    const fireCursor = await auditCursor();
    const fireMark = slack.calls.length;
    const sessionIds = await runRoutineDispatchTick();
    expect(sessionIds.length, "🔴 the dispatcher started a session for the due brief").toBeGreaterThan(0);
    const after = await store.getRoutine(org, DM_KEY, brief!.id);
    const sent = (await rowsSinceCursor(fireCursor, ["routine.fire_attrs_sent"], { limit: 200 })).find((r) => detailOf(r).routineId === brief!.id);
    expect(sent, "the fire's routine.fire_attrs_sent row names the brief").toBeDefined();
    expect(typeof after?.lastRunAt, "🔴 the dispatcher fired the brief: its lastRunAt is set").toBe("string");
    await waitFor(async () => {
      const posted = slack.calls.slice(fireMark).some((c) => c.method === "chat.postMessage" && c.params.get("channel") === DM && (c.params.get("text") ?? "").includes(BRIEF_TEXT));
      if (posted) return true;
      const rows = await rowsSinceCursor(fireCursor, ["reply.post"], { limit: 200 });
      return rows.some((r) => r.surface === DM && detailOf(r).chars === BRIEF_TEXT.length) ? true : undefined;
    }, "🔴 the first brief posted into the person's DM", 150_000);
    expect((await store.getRoutine(org, DM_KEY, needsYou!.id))?.lastRunAt, "the needs-you watch did not run: it waits for its schedule").toBeUndefined();
  } finally {
    slack.uninstall();
  }
});

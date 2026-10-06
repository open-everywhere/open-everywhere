import { afterAll, expect, test } from "vitest";
import {
  auditCursor,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_NAME_DROP_CHANNEL_ID,
  SLACK_TEAM_ID,
  slackMentionWake,
  slackTs,
  waitFor,
  type AuditRow,
  type SlackWebApiStub,
} from "../harness";
import { EVE_PATCH_PARTS, _resetEvePatchTurnCheckForTest } from "@open-everywhere/core/agent/access/eve-patch-probe.js";

const BOT_USER_ID = "U0BOTSELF2249";
const BOT_ID = "B0BOTSELF2249";
const BOT_DISPLAY_NAME = "ope2249bot";
const USER_ID = "U0MEMBER2249";

let stub: SlackWebApiStub | undefined;
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});

function userInfo(id: string, name: string): Record<string, unknown> {
  return { ok: true, user: { id, name, team_id: SLACK_TEAM_ID, real_name: name, profile: { display_name: name, real_name: name } } };
}

async function armSeams(): Promise<void> {
  await bootAgent({ sharedSqlite: true });
  if (stub) return;
  const installed = installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER_ID, bot_id: BOT_ID, team_id: SLACK_TEAM_ID };
      case "users.info": {
        const user = params.get("user") ?? "";
        if (user === BOT_USER_ID) return userInfo(BOT_USER_ID, BOT_DISPLAY_NAME);
        if (user === USER_ID) return userInfo(USER_ID, "trigger-member-2249");
        return undefined;
      }
      case "conversations.info":
        return {
          ok: true,
          channel: {
            id: params.get("channel"),
            name: "it-ope2249",
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
      default:
        return undefined;
    }
  });
  stub = installed;
  cleanups.push(() => installed.uninstall());
}

async function refusalRow(cursor: Awaited<ReturnType<typeof auditCursor>>, hook: string): Promise<AuditRow | undefined> {
  const rows = await rowsSinceCursor(cursor, ["hook.refused"], { limit: 100 });
  return rows.find((r) => r.detail?.hook === hook);
}

test("§1 negative control — a healthy wake RUNS its turn, and no hook refuses it", async () => {
  await armSeams();
  const handle = registerScript({ parent: [{ say: "ope2249 healthy turn ran" }] });
  disposeLater(handle);

  const cursor = await auditCursor();
  const ts = slackTs(Date.now(), 1);
  const res = await slackMentionWake({
    channelId: SLACK_NAME_DROP_CHANNEL_ID,
    userId: USER_ID,
    text: "ope2249 healthy control, please answer",
    ts,
    eventId: `Ev2249OK${ts.replace(".", "")}`,
  });
  expect(res.status, `the Slack front refused the wake: ${res.body.slice(0, 200)}`).toBe(200);

  await waitFor(() => handle.requests.at(0), "the healthy wake's first model call — never arriving means this file's fixture is broken, not that a hook refused");
  expect(handle.requests.length, "the healthy wake reached the model").toBeGreaterThan(0);
  expect(await refusalRow(cursor, "egress"), "🔴 no egress refusal on a healthy wake — a hook that cancels unconditionally would pass §2 and break the product").toBeUndefined();
  expect(await refusalRow(cursor, "eve-patch-gate"), "🔴 no patch-gate refusal on a healthy wake").toBeUndefined();
});

test("§2 a MISSING PATCH MARKER cancels the real turn, and no model call runs", async () => {
  await armSeams();
  const handle = registerScript({ parent: [{ say: "ope2249 this step must never be reached" }] });
  disposeLater(handle);

  const bag = globalThis as Record<string, unknown>;
  const part = EVE_PATCH_PARTS[0]!;
  const saved = bag[part.marker];
  const cursor = await auditCursor();
  let row: AuditRow | undefined;
  try {
    delete bag[part.marker];
    _resetEvePatchTurnCheckForTest();

    const ts = slackTs(Date.now(), 2);
    const res = await slackMentionWake({
      channelId: SLACK_NAME_DROP_CHANNEL_ID,
      userId: USER_ID,
      text: "ope2249 unpatched eve, this turn must not run",
      ts,
      eventId: `Ev2249UP${ts.replace(".", "")}`,
    });
    expect(res.status, `the Slack front refused the wake: ${res.body.slice(0, 200)}`).toBe(200);

    row = await waitFor(
      () => refusalRow(cursor, "eve-patch-gate"),
      "hooks/eve-patch-gate.ts to REFUSE a real turn on unpatched bytes. Never arriving means the hook is " +
        "not mounted, not reached, or its cancel never landed — so the OPE-2182 refusal is unreachable at the turn edge",
    );
  } finally {
    if (saved === undefined) delete bag[part.marker];
    else bag[part.marker] = saved;
    _resetEvePatchTurnCheckForTest();
  }

  expect(row?.detail?.reason, "the row names WHY the turn was refused").toBe("eve-unpatched");
  expect(row?.detail?.phase, "…and the edge it fired on").toBe("turn.started");
  expect(row?.detail?.cancelCalled, "the hook CALLED ctx.cancel() — not that eve honoured it, which no hook can observe; the model-call row below is what proves the stop").toBe(true);

  expect(handle.requests, `the refused turn made ${handle.requests.length} model call(s) — the refusal did not stop the turn`).toEqual([]);
});

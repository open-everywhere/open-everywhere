import { expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";

import { auditCursor, bootAgent, registerScript, rowsSinceCursor, runScheduleTask, seatReply, SLACK_TEAM_ID, slackDmWake, slackTs, waitFor, type AuditRow } from "../harness";
import { installSlackWebApiStub } from "../slack-web-api";

const PERSON = "U0OPE2512DSC";
const DM = "D0OPE2512DSC";
const DAY_MS = 86_400_000;

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

test("the compiled personal-watch task offers a routine for repeated work, with no watch source declared", async () => {
  const slack = installSlackWebApiStub((method) => {
    if (method === "users.info") return { ok: true, user: { id: PERSON, team_id: SLACK_TEAM_ID, deleted: false, is_bot: false } };
    if (method === "conversations.open") return { ok: true, channel: { id: DM } };
    if (method === "chat.postMessage") return { ok: true, ts: "1760009420.252000", channel: DM };
    return undefined;
  });
  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  try {
    const org = deploymentOrg();
    const principalKey = `slack/${SLACK_TEAM_ID}/${PERSON}`;
    const { enrollPersonalWatch, readPersonalWatch } = await import("@open-everywhere/core/agent/personal-watch/state.js");
    const { inQuietHours } = await import("@open-everywhere/core/agent/personal-watch/dial.js");
    const store = getOperationalStore();
    const now = Date.now();
    for (const weeks of [1, 2, 3]) {
      await store.appendToolUsage({
        org,
        ts: new Date(now - weeks * 7 * DAY_MS).toISOString(),
        surfaceKey: `slack/${SLACK_TEAM_ID}/${DM}`,
        principalId: PERSON,
        sessionId: `s-ope2512-${weeks}`,
        event: "call",
        tool: "list_issues",
        connector: "linear",
        outcome: "ok",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      });
    }
    expect(await enrollPersonalWatch(org, principalKey), "the person could not be enrolled").toBe("enrolled");
    const cursor = await auditCursor();
    const quiet = inQuietHours(new Date());

    await runScheduleTask("schedules/personal-watch.ts");

    const row = (await readPersonalWatch(org, principalKey)).state;
    expect(row?.lastDiscoveryAt, "🔴 the compiled task never ran workflow discovery for the person").toBeDefined();
    const weekday = new Date(now).getUTCDay();
    const fingerprint = `weekly:linear/list_issues:${weekday}`;
    if (quiet) {
      const rows = await rowsSinceCursor(cursor, ["personal_watch.silence"], { limit: 200 });
      const held = rows.find((r) => r.principalId === principalKey && detailOf(r).fingerprint === fingerprint);
      expect(detailOf(held).reason, "inside the quiet hours the proposal is held, and the hold is filed").toBe("quiet-hours");
      return;
    }
    expect(row?.proposals.map((p) => p.fingerprint), "🔴 the row does not record the proposal").toEqual([fingerprint]);
    const rows = await rowsSinceCursor(cursor, ["personal_watch.proposal", "approval.requested"], { limit: 200 });
    expect(rows.some((r) => r.action === "personal_watch.proposal" && r.principalId === principalKey), "no personal_watch.proposal row").toBe(true);
    const posts = slack.calls.filter((c) => c.method === "chat.postMessage" && c.params.get("channel") === DM);
    expect(posts.length, "🔴 no card was posted into the person's DM — the kind is not registered on the host, or the post failed").toBe(1);
    const blocks = JSON.stringify(JSON.parse(posts[0]!.params.get("blocks") ?? "[]"));
    expect(blocks, "the card has no Set it up button").toContain('"Set it up"');
    expect(blocks, "the card has no No thanks button").toContain('"No thanks"');
    expect(blocks, "the card leaks the fingerprint").not.toContain("weekly:");
  } finally {
    slack.uninstall();
  }
});

test("a DM question answered with no connector call lands in the question ledger, through the mounted hook", async () => {
  const asker = "U0OPE2539ASK";
  const dm = "D0OPE2539ASK";
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: "U0OPE2539BOT", bot_id: "B0OPE2539BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") return { ok: true, user: { id: params.get("user"), team_id: SLACK_TEAM_ID, is_bot: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false } };
    if (method === "chat.postMessage" || method === "chat.update") return { ok: true, ts: slackTs(Date.now(), 253_900), channel: params.get("channel") };
    if (method === "agents.sessions.setStatus" || method === "reactions.add" || method === "reactions.remove") return { ok: true };
    return undefined;
  });
  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  const script = registerScript({ parent: [seatReply("Priya is on call this week.", "ope2539-answer")] });
  try {
    const org = deploymentOrg();
    const res = await slackDmWake({ channelId: dm, userId: asker, text: "Who is on call this week?", ts: slackTs(Date.now(), 253_901) });
    expect(res.status, `the DM wake POST was not accepted: ${res.body.slice(0, 200)}`).toBe(200);
    const rows = await waitFor(async () => {
      const got = await getOperationalStore().listPersonQuestions(org, asker, `slack/${SLACK_TEAM_ID}/`, new Date(Date.now() - DAY_MS).toISOString(), 10);
      return got.length > 0 ? got : undefined;
    }, "🔴 the question_ledger row for the DM question — the question-ledger hook is not mounted, or never saw the turn");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.words, "the row holds the normalized words").toBe("who is on call this week?");
    expect(rows[0]!.surfaceKey).toBe(`slack/${SLACK_TEAM_ID}/${dm}`);
  } finally {
    script.dispose();
    slack.uninstall();
  }
});

test("the compiled personal-watch task asks a shared room about work two people there repeat", async () => {
  const room = "C0OPE2539ROOM";
  const slack = installSlackWebApiStub((method) => {
    if (method === "chat.postMessage") return { ok: true, ts: "1760009420.254000", channel: room };
    return undefined;
  });
  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  try {
    const org = deploymentOrg();
    const store = getOperationalStore();
    const { updateRoomWatch, ROOM_SCAN_KEY } = await import("@open-everywhere/core/agent/personal-watch/room-discovery.js");
    await updateRoomWatch(org, ROOM_SCAN_KEY, (cur) => ({ proposals: cur.proposals }));
    const now = Date.now();
    for (const [weeks, who] of [[1, "U0OPE2539ANN"], [2, "U0OPE2539BEN"], [3, "U0OPE2539ANN"]] as const) {
      await store.appendToolUsage({
        org,
        ts: new Date(now - weeks * 7 * DAY_MS).toISOString(),
        surfaceKey: `slack/${SLACK_TEAM_ID}/${room}`,
        surfaceMode: "channel",
        principalId: who,
        sessionId: `s-ope2539-${weeks}`,
        event: "call",
        tool: "list_incidents",
        connector: "pagerduty",
        outcome: "ok",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      });
    }
    const cursor = await auditCursor();

    await runScheduleTask("schedules/personal-watch.ts");

    const weekday = new Date(now).getUTCDay();
    const fingerprint = `weekly:pagerduty/list_incidents:${weekday}`;
    const rows = await rowsSinceCursor(cursor, ["room_watch.proposal"], { limit: 200 });
    expect(rows.some((r) => detailOf(r).fingerprint === fingerprint), "🔴 no room_watch.proposal row — the compiled task never ran room discovery").toBe(true);
    const posts = slack.calls.filter((c) => c.method === "chat.postMessage" && c.params.get("channel") === room);
    expect(posts.length, "🔴 no card was posted into the room").toBe(1);
    const blocks = JSON.stringify(JSON.parse(posts[0]!.params.get("blocks") ?? "[]"));
    expect(blocks, "the card has no Set it up button").toContain('"Set it up"');
    expect(blocks, "the card leaks a person id").not.toContain("U0OPE2539");
    expect(blocks, "the card leaks the fingerprint").not.toContain("weekly:");
  } finally {
    slack.uninstall();
  }
});

test("a room stopped with /oe suggest off gets no card from the compiled personal-watch task", async () => {
  const room = "C0OPE2550STOP";
  const person = "U0OPE2550ANN";
  const slack = installSlackWebApiStub((method) => {
    if (method === "users.info") return { ok: true, user: { id: person, team_id: SLACK_TEAM_ID, deleted: false, is_bot: false, is_restricted: false } };
    if (method === "chat.postMessage") return { ok: true, ts: "1760009420.255000", channel: room };
    return undefined;
  });
  const { base } = await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  try {
    const org = deploymentOrg();
    const store = getOperationalStore();
    const { updateRoomWatch, ROOM_SCAN_KEY } = await import("@open-everywhere/core/agent/personal-watch/room-discovery.js");
    await updateRoomWatch(org, ROOM_SCAN_KEY, (cur) => ({ proposals: cur.proposals }));
    const now = Date.now();
    for (const [weeks, who] of [[1, "U0OPE2550ANN"], [2, "U0OPE2550BEN"], [3, "U0OPE2550ANN"]] as const) {
      await store.appendToolUsage({
        org,
        ts: new Date(now - weeks * 7 * DAY_MS).toISOString(),
        surfaceKey: `slack/${SLACK_TEAM_ID}/${room}`,
        surfaceMode: "channel",
        principalId: who,
        sessionId: `s-ope2550-${weeks}`,
        event: "call",
        tool: "list_incidents",
        connector: "pagerduty",
        outcome: "ok",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      });
    }
    const cursor = await auditCursor();

    const { buildSlashCommandBody, signSlackRequest, SYNTHETIC_COMMANDS_ROUTE } = await import("../../../packages/core/scripts/e2e/synthetic");
    const secret = process.env.SLACK_SIGNING_SECRET;
    expect(secret, "bootAgent sets the fork's signing secret").toBeTruthy();
    const rawBody = buildSlashCommandBody({ text: "suggest off", userId: person, channelId: room, teamId: SLACK_TEAM_ID });
    const signed = signSlackRequest(rawBody, secret!);
    const res = await fetch(`${base}${SYNTHETIC_COMMANDS_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": signed.timestamp, "x-slack-signature": signed.signature },
      body: rawBody,
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.text();
    expect(res.status, body.slice(0, 200)).toBe(200);
    expect(String((JSON.parse(body) as { text?: unknown }).text ?? ""), "🔴 the command did not stop the room").toMatch(/^Done\. I won't suggest routines here\./u);
    const stopped = await waitFor(async () => (await rowsSinceCursor(cursor, ["room_watch.stopped"], { limit: 50 })).find((r) => r.surface === room), "the room_watch.stopped row");
    expect(stopped.principalId).toBe(`slack/${SLACK_TEAM_ID}/${person}`);

    await runScheduleTask("schedules/personal-watch.ts");

    const posts = slack.calls.filter((c) => c.method === "chat.postMessage" && c.params.get("channel") === room);
    expect(posts.length, "🔴 a card was posted into a stopped room").toBe(0);
    const proposals = await rowsSinceCursor(cursor, ["room_watch.proposal"], { limit: 200 });
    expect(proposals.some((r) => r.surface === room), "🔴 a room_watch.proposal row names the stopped room").toBe(false);
    const holds = (await rowsSinceCursor(cursor, ["room_watch.silence"], { limit: 200 })).filter((r) => r.surface === room);
    expect(holds.map((r) => detailOf(r).reason), "🔴 the hold filed no room-stopped silence row").toEqual(["room-stopped"]);
  } finally {
    slack.uninstall();
  }
});

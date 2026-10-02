import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  auditCursor,
  awaitWindowQuiet,
  bootAgent,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  seatReply,
  sleep,
  waitFor,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";
import { EVE_PATCH_PARTS, _resetEvePatchTurnCheckForTest } from "@open-everywhere/core/agent/access/eve-patch-probe.js";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

const SETTLE_FLOOR_MS = 20_000;

const REPLY_ACTIONS = ["reply.post", "reply.no_reply"] as const;

function postingSeat(text: string, id: string): ScriptedHandle {
  return disposeLater(registerScript({ parent: [seatReply(text, id), { say: "done" }] }));
}

async function awaitSessionStartRow(cursor: Awaited<ReturnType<typeof auditCursor>>, channelId: string) {
  return waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["egress.policy"], { limit: 300 });
    return rows.find((r) => (r.surface ?? "").includes(channelId));
  }, `a session-start egress.policy row for channel ${channelId} — without it a silent room is a DROPPED delivery, not a refusal`);
}

async function repliesFor(cursor: Awaited<ReturnType<typeof auditCursor>>, channelId: string) {
  const rows = await rowsSinceCursor(cursor, REPLY_ACTIONS, { limit: 300 });
  return rows.filter((r) => (r.surface ?? "").includes(channelId));
}

function callsFor(handle: ScriptedHandle, nonce: string): RecordedRequest[] {
  return handle.requests.filter((r) => r.messages.some((m) => m.text.includes(nonce)));
}

async function settle(): Promise<void> {
  await awaitWindowQuiet();
  await sleep(SETTLE_FLOOR_MS);
}

test("§1 NEGATIVE CONTROL — with nothing broken, the same drive calls the model and posts", async () => {
  await bootAgent();
  const channelId = freshUnlistedChannelId();
  const nonce = randomBytes(5).toString("hex");
  const replyText = `ope2263-control-ok ${nonce}`;
  const handle = postingSeat(replyText, "ope2263-control-reply");

  const cursor = await auditCursor();
  await discordMentionWake({ channelId, text: `<@9000000000000000001> ${nonce} please answer`, messageId: `it2263c${nonce}` });

  await waitFor(() => callsFor(handle, nonce).find((r) => r.role === "parent"), "the scripted model to be called at all");
  const row = await waitFor(async () => (await repliesFor(cursor, channelId)).find((r) => r.action === "reply.post"), `a reply.post row for ${channelId}`);

  expect(
    handle.requests.filter((r) => r.fault !== undefined),
    "a scripted request degraded instead of answering the script — this control is not measuring the run it describes",
  ).toEqual([]);
  expect(row.detail?.chars).toBe(replyText.length);
});

test("§2 a turn.started refusal: the unpatched-eve gate stops the turn — no model call, nothing posted", async () => {
  await bootAgent();
  const channelId = freshUnlistedChannelId();
  const nonce = randomBytes(5).toString("hex");
  const handle = postingSeat(`ope2263-turn-edge-LEAK ${nonce}`, "ope2263-turn-edge-reply");

  const part = EVE_PATCH_PARTS[0]!;
  const globals = globalThis as Record<string, unknown>;
  expect(globals[part.marker], `part ${part.part}'s marker is not published on this host, so §2 would refuse for the wrong reason`).toBe(true);

  const cursor = await auditCursor();
  try {
    delete globals[part.marker];
    _resetEvePatchTurnCheckForTest();

    await discordMentionWake({ channelId, text: `<@9000000000000000001> ${nonce} please answer`, messageId: `it2263t${nonce}` });

    await awaitSessionStartRow(cursor, channelId);
    await settle();

    expect(
      callsFor(handle, nonce).map((r) => `${r.role}#${r.stepIndex}`),
      "🔴 the model WAS called on a turn whose turn.started hook refused — the host ran the turn anyway, so every hook refusal in this tree is fail-OPEN",
    ).toEqual([]);

    expect(
      (await repliesFor(cursor, channelId)).map((r) => r.action),
      `🔴 a refused turn still answered in ${channelId}`,
    ).toEqual([]);
  } finally {
    globals[part.marker] = true;
    _resetEvePatchTurnCheckForTest();
  }
  expect((globalThis as Record<string, unknown>)[part.marker]).toBe(true);
});

test("§3 a session.started refusal: the fail-closed egress apply aborts the session — no model call, nothing posted", async () => {
  await bootAgent();
  const channelId = freshUnlistedChannelId();
  const nonce = randomBytes(5).toString("hex");
  const handle = postingSeat(`ope2263-session-edge-LEAK ${nonce}`, "ope2263-session-edge-reply");

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const cursor = await auditCursor();
  try {
    settings.overrideSettingsForTest({ egress: { allowUnenforced: false } });
    expect(settings.getSettings().egress.allowUnenforced, "the override did not take, so §3 would drive the DEGRADING posture and pass vacuously").toBe(false);

    await discordMentionWake({ channelId, text: `<@9000000000000000001> ${nonce} please answer`, messageId: `it2263s${nonce}` });

    const row = await awaitSessionStartRow(cursor, channelId);
    expect(
      row.detail?.aborted,
      `🔴 the fail-closed apply did NOT abort this session: the row says enforced=${String(row.detail?.enforced)}, ` +
        `enforceError=${String(row.detail?.enforceError).slice(0, 120)}. A failed apply with no abort means the ` +
        `session is running on eve's allow-all default`,
    ).toBe(true);

    expect(row.detail?.reason, "§3 is measuring an abort from some other session.started producer").toBe("first-apply");
    expect(row.detail?.enforceError, "the abort did not come from a failed apply — §3 is measuring some other deny-all path").toBeDefined();

    await settle();

    expect(
      callsFor(handle, nonce).map((r) => `${r.role}#${r.stepIndex}`),
      "🔴 the model WAS called in a session whose session.started hook refused — the agent is serving wakes with no firewall applied",
    ).toEqual([]);

    expect(
      (await repliesFor(cursor, channelId)).map((r) => r.action),
      `🔴 an aborted session still answered in ${channelId}`,
    ).toEqual([]);
  } finally {
    settings.overrideSettingsForTest({ egress: { allowUnenforced: true } });
  }
  expect((await import("@open-everywhere/core/agent/settings/settings.js")).getSettings().egress.allowUnenforced).toBe(true);
});

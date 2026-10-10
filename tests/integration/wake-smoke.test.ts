import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  awaitWindowQuiet,
  auditCursor,
  bootAgent,
  DISCORD_GUILD_ID,
  discordMentionWake,
  disposeLater,
  rawDiscordRelayPost,
  registerScript,
  rowsSinceCursor,
  seatReply,
  waitFor,
} from "./harness";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

test("bootAgent refuses a second boot with DIFFERENT options, rather than silently ignoring them", async () => {
  await bootAgent();
  await expect(bootAgent({ sharedSqlite: true })).rejects.toThrow(/cannot re-boot/);
  await expect(bootAgent()).resolves.toBeDefined();
});

test("an unsigned Discord relay POST is refused 401, with no audit trace", async () => {
  await bootAgent();
  const channelId = freshUnlistedChannelId();
  const cursor = await auditCursor();

  const res = await rawDiscordRelayPost({ channelId, text: `<@9000000000000000001> unsigned decoy` }, null);
  expect(res.status).toBe(401);

  await new Promise((r) => setTimeout(r, 500));
  const rows = await rowsSinceCursor(cursor, ["reply.post"]);
  expect(rows.find((r) => r.surface === channelId)).toBeUndefined();
});

test("a mis-signed Discord relay POST is refused 401", async () => {
  await bootAgent();
  const channelId = freshUnlistedChannelId();

  const res = await rawDiscordRelayPost({ channelId, text: `<@9000000000000000001> mis-signed decoy` }, "not-the-real-signature");
  expect(res.status).toBe(401);
});

test("a signed Discord relay mention wakes the channel's STANDING SEAT and its reply reaches the audit trail", async () => {
  await bootAgent();
  const channelId = freshUnlistedChannelId();
  const nonce = randomBytes(4 + Math.floor(Math.random() * 9)).toString("hex");
  const replyText = `oe-wake-smoke-ok ${nonce}`;

  const handle = disposeLater(registerScript({ parent: [seatReply(replyText, "wake-smoke-reply")] }));

  const cursor = await auditCursor();
  await discordMentionWake({ channelId, text: `<@9000000000000000001> ${nonce} please answer` });

  await waitFor(() => handle.requests.find((r) => r.role === "parent"), "the scripted model to see the wake");

  const row = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"]);
    return rows.find((r) => r.action === "reply.post" && r.surface === channelId);
  }, `a reply.post audit row for channel ${channelId}`);

  expect(row.platform).toBe("discord");
  expect(row.workspace).toBe(DISCORD_GUILD_ID);

  const detail = (row.detail ?? {}) as Record<string, unknown>;
  expect(detail.platform).toBe("discord");
  expect(detail.route).toBe("tool");
  expect(typeof detail.id).toBe("string");
  expect(detail.id as string).toMatch(/^spoof-unified-discord-/);
  expect(typeof detail.sessionId).toBe("string");
  expect((detail.sessionId as string).length).toBeGreaterThan(0);
  expect(detail.chars).toBe(replyText.length);

  await awaitWindowQuiet();
  expect(handle.requests.some((r) => r.role === "parent" && r.stepIndex !== 0), "a step after the reply was requested").toBe(false);
});

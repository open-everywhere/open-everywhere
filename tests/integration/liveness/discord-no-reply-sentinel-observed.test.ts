import { randomBytes } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { bootAgent, discordMentionWake, readAuditRows, registerScript, waitFor, type ScriptedHandle } from "../harness";

const BOT_MENTION = "<@9000000000000000001>";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

afterAll(async () => {
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.resetSettingsForTest();
});

test("Discord: no_reply TOOL call + the taught trailing sentinel writes ONE row, not two", async () => {
  await bootAgent();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const { NO_REPLY_SENTINEL } = await import("@open-everywhere/core/agent/channels/normalized-wake.js");
  settings.overrideSettingsForTest({ audit: { silences: false } });

  const channelId = freshUnlistedChannelId();
  const at = Date.now();
  const callId = `ope890-tool-${at}`;
  const handle: ScriptedHandle = registerScript({
    parent: [{ calls: [{ tool: "no_reply", input: { reason: "not_relevant" }, id: callId }] }, { say: NO_REPLY_SENTINEL }],
  });
  try {
    await discordMentionWake({ channelId, text: `${BOT_MENTION} ope890 stay quiet on this one`, messageId: `ope890tool${at}` });

    await waitFor(() => handle.requests.find((r) => r.stepIndex === 1), "the mention wake's trailing step", 180_000);
    const last = handle.requests.flatMap((r) => r.toolResults).find((t) => t.name === "no_reply");
    expect(last, "the wake's model never got a no_reply result at all").toBeDefined();
    expect(last?.isError, "the wake's no_reply TOOL call was refused").toBe(false);

    const sinceIso = new Date(at - 2_000).toISOString();
    const rows = await waitFor(
      async () => {
        const found = await readAuditRows({ actions: ["reply.no_reply_observed"], sinceIso, limit: 50 });
        const mine = found.filter((r) => r.platform === "discord" && r.surface === channelId);
        return mine.length > 0 ? mine : undefined;
      },
      "a reply.no_reply_observed row for the tool-called wake",
      120_000,
    );
    expect(rows, "the tool call's OWN row must land (OPE-649) — one row minimum").toHaveLength(1);
    expect(rows[0]!.detail?.reason, "the surviving row is the TOOL route's own — it carries `reason`, not `route`").toBe("not_relevant");
    expect(rows[0]!.detail?.route, "the tool route's row has no `route` field — that's the sentinel row's marker").toBeUndefined();
  } finally {
    handle.dispose();
  }
}, 300_000);

test("Discord: a bare NO_REPLY sentinel with NO tool call writes the sentinel route's own row", async () => {
  await bootAgent();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const { NO_REPLY_SENTINEL } = await import("@open-everywhere/core/agent/channels/normalized-wake.js");
  settings.overrideSettingsForTest({ audit: { silences: false } });

  const channelId = freshUnlistedChannelId();
  const at = Date.now();
  const handle: ScriptedHandle = registerScript({
    parent: [{ say: NO_REPLY_SENTINEL }],
  });
  try {
    await discordMentionWake({ channelId, text: `${BOT_MENTION} ope890 stay quiet, sentinel only`, messageId: `ope890sent${at}` });
    await waitFor(() => handle.requests.find((r) => r.stepIndex === 0), "the mention wake's turn", 180_000);

    const sinceIso = new Date(at - 2_000).toISOString();
    const observed = await waitFor(
      async () => {
        const rows = await readAuditRows({ actions: ["reply.no_reply_observed"], sinceIso, limit: 50 });
        return rows.find((r) => r.platform === "discord" && r.surface === channelId);
      },
      "a reply.no_reply_observed row for the bare-sentinel wake",
      120_000,
    );
    expect(observed.detail?.route, "a genuine bare-sentinel turn is marked route: sentinel").toBe("sentinel");
    expect(observed.detail?.reason, "the sentinel carries no closed reason the way the tool call does").toBeUndefined();
  } finally {
    handle.dispose();
  }
}, 300_000);

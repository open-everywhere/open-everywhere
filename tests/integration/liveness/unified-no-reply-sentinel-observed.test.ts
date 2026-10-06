import { afterAll, expect, test } from "vitest";
import {
  auditCursor,
  awaitWindowQuiet,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  readAuditRows,
  registerScript,
  rowsSinceCursor,
  waitFor,
  type AuditRow,
  type ScriptedHandle,
} from "../harness";

afterAll(async () => {
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.resetSettingsForTest();
});

async function knownWakeIds(action: string, matches: (detail: Record<string, unknown> | undefined) => boolean): Promise<ReadonlySet<string>> {
  const rows = await readAuditRows({ actions: [action], sinceIso: new Date(0).toISOString(), limit: 200 });
  const ids = new Set<string>();
  for (const r of rows) {
    if (!matches(r.detail)) continue;
    const w = (r.detail as { wakeId?: unknown } | undefined)?.wakeId;
    if (typeof w === "string") ids.add(w);
  }
  return ids;
}

function isSentinelRoute(detail: Record<string, unknown> | undefined): boolean {
  return (detail as { route?: unknown } | undefined)?.route === "sentinel";
}

test("unified: a bare NO_REPLY sentinel writes the sentinel route's reply.no_reply_observed row, UNGATED", async () => {
  await bootAgent();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const { NO_REPLY_SENTINEL } = await import("@open-everywhere/core/agent/channels/normalized-wake.js");
  settings.overrideSettingsForTest({ audit: { silences: false } });
  expect(settings.getSettings().audit.silences).toBe(false);

  const before = await knownWakeIds("reply.no_reply_observed", isSentinelRoute);
  const at = Date.now();
  const cursor = await auditCursor();
  const handle: ScriptedHandle = registerScript({ parent: [{ say: NO_REPLY_SENTINEL }] });
  try {
    await discordMentionWake({
      channelId: DISCORD_LISTED_CHANNEL_ID,
      text: `<@9000000000000000001> ope895 stay quiet, sentinel only ${at}`,
      messageId: `ope895sent${at}`,
    });
    await waitFor(() => handle.requests.find((r) => r.stepIndex === 0), "the unified wake's turn", 180_000);

    const observed: AuditRow = await waitFor(async () => {
      const rows = await rowsSinceCursor(cursor, ["reply.no_reply_observed"], { limit: 50 });
      return rows.find((r) => {
        const w = (r.detail as { wakeId?: unknown } | undefined)?.wakeId;
        return r.platform === "unified" && isSentinelRoute(r.detail) && typeof w === "string" && !before.has(w);
      });
    }, "a NEW reply.no_reply_observed row (route: sentinel) for the unified window's bare-sentinel turn", 120_000);
    expect(observed.detail?.route).toBe("sentinel");
    const wakeId = (observed.detail as { wakeId?: unknown }).wakeId;
    expect(typeof wakeId).toBe("string");

    const gated = await rowsSinceCursor(cursor, ["unified.no_reply"]);
    expect(
      gated.find((r) => (r.detail as { wakeId?: unknown } | undefined)?.wakeId === wakeId),
      "unified.no_reply stays gated behind audit.silences — off means off",
    ).toBeUndefined();
  } finally {
    handle.dispose();
  }
}, 300_000);

test("unified: with audit.silences ON, the full-detail unified.no_reply row fires ADDITIONALLY (not instead of) the minimal row", async () => {
  await bootAgent();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const { NO_REPLY_SENTINEL } = await import("@open-everywhere/core/agent/channels/normalized-wake.js");
  settings.overrideSettingsForTest({ audit: { silences: true } });
  expect(settings.getSettings().audit.silences).toBe(true);

  const before = await knownWakeIds("reply.no_reply_observed", isSentinelRoute);
  const at = Date.now();
  const cursor = await auditCursor();
  const handle: ScriptedHandle = registerScript({ parent: [{ say: NO_REPLY_SENTINEL }] });
  try {
    await discordMentionWake({
      channelId: DISCORD_LISTED_CHANNEL_ID,
      text: `<@9000000000000000001> ope895 stay quiet, gated on ${at}`,
      messageId: `ope895gate${at}`,
    });
    await waitFor(() => handle.requests.find((r) => r.stepIndex === 0), "the unified wake's turn", 180_000);

    const observed: AuditRow = await waitFor(async () => {
      const rows = await rowsSinceCursor(cursor, ["reply.no_reply_observed"], { limit: 50 });
      return rows.find((r) => {
        const w = (r.detail as { wakeId?: unknown } | undefined)?.wakeId;
        return r.platform === "unified" && isSentinelRoute(r.detail) && typeof w === "string" && !before.has(w);
      });
    }, "the minimal sentinel row, still present with the gate ON", 120_000);
    expect(observed.detail?.route).toBe("sentinel");
    const wakeId = (observed.detail as { wakeId?: unknown }).wakeId;

    const full = await waitFor(async () => {
      const rows = await rowsSinceCursor(cursor, ["unified.no_reply"], { limit: 50 });
      return rows.find((r) => (r.detail as { wakeId?: unknown } | undefined)?.wakeId === wakeId);
    }, "the gated full-detail unified.no_reply row, now visible with the gate ON", 120_000);
    expect(full.detail?.reason).toBe("NO_REPLY sentinel — judged not warranted");
  } finally {
    handle.dispose();
  }
}, 300_000);

test("unified: no_reply TOOL call + the taught trailing sentinel writes ONLY the tool's own row, never a second sentinel-route row", async () => {
  await bootAgent();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const { NO_REPLY_SENTINEL } = await import("@open-everywhere/core/agent/channels/normalized-wake.js");
  settings.overrideSettingsForTest({ audit: { silences: false } });

  const beforeToolRows = await knownWakeIds("reply.no_reply_observed", (d) => (d as { reason?: unknown } | undefined)?.reason === "not_relevant");
  const beforeSentinelRows = await knownWakeIds("reply.no_reply_observed", isSentinelRoute);
  const at = Date.now();
  const cursor = await auditCursor();
  const callId = `ope895-tool-${at}`;
  const reactId = `${callId}-react`;
  const handle: ScriptedHandle = registerScript({
    parent: [
      {
        calls: [
          { tool: "no_reply", input: { reason: "not_relevant" }, id: callId },
          { tool: "react", input: { emoji: "eyes" }, id: reactId },
        ],
      },
      { say: NO_REPLY_SENTINEL },
    ],
  });
  try {
    await discordMentionWake({
      channelId: DISCORD_LISTED_CHANNEL_ID,
      text: `<@9000000000000000001> ope895 tool then sentinel ${at}`,
      messageId: `ope895tool${at}`,
    });
    const sentinelStep = await waitFor(() => handle.requests.find((r) => r.stepIndex === 1), "the unified wake's trailing sentinel step", 180_000);
    const noReplyResult = sentinelStep.toolResults.find((t) => t.id === callId);
    expect(noReplyResult, "the sentinel step's prompt carries the no_reply result").toBeDefined();
    expect(noReplyResult?.isError, `the wake's no_reply TOOL call was refused: ${JSON.stringify(noReplyResult?.output)}`).toBe(false);

    const toolRow = await waitFor(async () => {
      const rows = await rowsSinceCursor(cursor, ["reply.no_reply_observed"], { limit: 50 });
      return rows.find((r) => {
        const d = r.detail as { reason?: unknown; wakeId?: unknown } | undefined;
        const w = d?.wakeId;
        return d?.reason === "not_relevant" && typeof w === "string" && !beforeToolRows.has(w);
      });
    }, "a NEW reply.no_reply_observed row for the tool-called wake", 180_000);
    expect(toolRow.detail?.route, "the tool route's row carries no `route` field").toBeUndefined();
    const wakeId = (toolRow.detail as { wakeId?: unknown }).wakeId;

    await awaitWindowQuiet();
    const rows = await rowsSinceCursor(cursor, ["reply.no_reply_observed"], { limit: 50 });
    const newSentinelRows = rows.filter((r) => {
      const w = (r.detail as { wakeId?: unknown } | undefined)?.wakeId;
      return isSentinelRoute(r.detail) && (w === wakeId || (typeof w === "string" && !beforeSentinelRows.has(w)));
    });
    expect(newSentinelRows, "the unified window's own sentinel-route write must NOT fire on the tool route — no double count").toHaveLength(0);
  } finally {
    handle.dispose();
  }
}, 300_000);

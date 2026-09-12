import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { disposeLater, bootAgent, DISCORD_GUILD_ID, DISCORD_LISTED_CHANNEL_ID, readAuditRows, registerScript, runRoutineDispatchTick, waitFor } from "../harness";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

async function seedFire(input: { readonly id: string; readonly channelId: string; readonly withGuildEvidence: boolean }): Promise<void> {
  if (process.env.OE_OPERATIONAL_PROVIDER !== "sqlite") {
    throw new Error("this test needs bootAgent({ sharedSqlite: true }) — PGlite is single-writer.");
  }
  const { addRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const surfaceKey = `discord/${DISCORD_GUILD_ID}/${input.channelId}`;
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  await addRoutine(
    {
      org: "default",
      platform: "discord",
      workspace: DISCORD_GUILD_ID,
      surface: input.channelId,
      workspaceKey: `discord/${DISCORD_GUILD_ID}`,
      surfaceKey,
      domainKey: surfaceKey,
      key: surfaceKey,
    },
    {
      id: input.id,
      org: "default",
      surfaceKey,
      target: input.withGuildEvidence ? { channelId: input.channelId, guildId: DISCORD_GUILD_ID, channelType: "0" } : { channelId: input.channelId },
      trigger: { kind: "once", at: dueAt },
      prompt: "say something short",
      createdBy: "discord:9000000000000000098",
      status: "active",
      nextRunAt: dueAt,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      consecutiveFailures: 0,
    },
  );
}

test("a fire missing guild evidence on a WINDOWING channel lands native-degraded, and the hook audits it", async () => {
  await bootAgent({ sharedSqlite: true });
  const id = `r-it-wr-${randomBytes(4).toString("hex")}`;
  const sinceIso = new Date(Date.now() - 5_000).toISOString();
  disposeLater(registerScript({ parent: [{ say: "nothing to report" }] }));

  await seedFire({ id, channelId: DISCORD_LISTED_CHANNEL_ID, withGuildEvidence: false });
  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length).toBeGreaterThan(0);

  const domainKey = `discord/${DISCORD_GUILD_ID}/${DISCORD_LISTED_CHANNEL_ID}`;
  const degraded = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["window.routing_degraded"], sinceIso });
    return rows.find((r) => (r.detail as { domainKey?: unknown } | undefined)?.domainKey === domainKey);
  }, "a window.routing_degraded row for the guild-evidence-less fire on the windowing channel");

  const detail = degraded.detail as { grain?: unknown; domainKey?: unknown; recall?: unknown };
  expect(detail.grain).toBe("native");
});

test("NEGATIVE CONTROL — the same fire WITH guild evidence windows, and never writes the row", async () => {
  await bootAgent({ sharedSqlite: true });
  const id = `r-it-wr-${randomBytes(4).toString("hex")}`;
  const sinceIso = new Date(Date.now() - 5_000).toISOString();
  disposeLater(registerScript({ parent: [{ say: "nothing to report" }] }));

  const channelId = freshUnlistedChannelId();
  await seedFire({ id, channelId, withGuildEvidence: true });
  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length).toBeGreaterThan(0);

  await waitFor(
    async () => (await readAuditRows({ actions: ["egress.policy"], sinceIso })).find((r) => (r.surface ?? "").includes(channelId)),
    "a session.started egress.policy row for the windowed fire — proof the turn actually ran",
  );
  const domainKey = `discord/${DISCORD_GUILD_ID}/${channelId}`;
  const degraded = await readAuditRows({ actions: ["window.routing_degraded"], sinceIso });
  expect(degraded.find((r) => (r.detail as { domainKey?: unknown } | undefined)?.domainKey === domainKey)).toBeUndefined();
});

import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  auditCursor,
  bootAgent,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  waitFor,
} from "../harness";

async function seedRoutine(input: {
  readonly surfaceKey: string;
  readonly channelId: string;
  readonly prompt: string;
  readonly sessionMode?: "job";
}): Promise<string> {
  if (process.env.OE_OPERATIONAL_PROVIDER !== "sqlite") {
    throw new Error("this test needs bootAgent({ sharedSqlite: true }) — PGlite is single-writer.");
  }
  const { addRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const id = `r-it-jp-${randomBytes(4).toString("hex")}`;
  const [platform = "slack", workspace = "", surface = ""] = input.surfaceKey.split("/");
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  await addRoutine(
    {
      org: "default",
      platform,
      workspace,
      surface,
      workspaceKey: `${platform}/${workspace}`,
      surfaceKey: input.surfaceKey,
      domainKey: input.surfaceKey,
      key: input.surfaceKey,
    },
    {
      id,
      org: "default",
      surfaceKey: input.surfaceKey,
      target: { channelId: input.channelId },
      trigger: { kind: "once", at: dueAt },
      prompt: input.prompt,
      createdBy: "U0JOBPOSTURE",
      status: "active",
      nextRunAt: dueAt,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      consecutiveFailures: 0,
      ...(input.sessionMode !== undefined ? { sessionMode: input.sessionMode } : {}),
    },
  );
  return id;
}

test("a durable-JOB fire, un-escalated, narrows and writes the turn.tool_gated(job-wake) row", async () => {
  await bootAgent({ sharedSqlite: true });
  const TEAM = "T0JOBPOST1";
  const CHANNEL = "C0JOBPOST1";
  const cursor = await auditCursor();

  disposeLater(registerScript({ parent: [{ say: "job fire ran, nothing to report" }] }));

  const routineId = await seedRoutine({
    surfaceKey: `slack/${TEAM}/${CHANNEL}`,
    channelId: CHANNEL,
    prompt: "check the queue and note anything stuck",
    sessionMode: "job",
  });

  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length).toBeGreaterThan(0);

  const surfaceKey = `slack/${TEAM}/${CHANNEL}`;
  const gated = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["turn.tool_gated"]);
    return rows.find((r) => r.workspace === surfaceKey && (r.detail as { reason?: unknown } | undefined)?.reason === "job-wake");
  }, "a turn.tool_gated row with reason=job-wake for the job fire");

  const detail = gated.detail as { withheld?: readonly string[]; withheldCount?: number; grain?: string; sessionId?: unknown };
  expect(Array.isArray(detail.withheld)).toBe(true);
  expect((detail.withheld ?? []).length).toBeGreaterThan(0);
  expect(detail.withheldCount).toBe((detail.withheld ?? []).length);
  expect(routineId).toMatch(/^r-it-jp-/);
});

test("NEGATIVE CONTROL — an ORDINARY (non-job) fire, same tick shape, never writes reason=job-wake", async () => {
  await bootAgent({ sharedSqlite: true });
  const TEAM = "T0JOBPOST2";
  const CHANNEL = "C0JOBPOST2";
  const cursor = await auditCursor();

  disposeLater(registerScript({ parent: [{ say: "ordinary fire ran, nothing to report" }] }));

  const routineId = await seedRoutine({
    surfaceKey: `slack/${TEAM}/${CHANNEL}`,
    channelId: CHANNEL,
    prompt: "check the queue and note anything stuck",
  });

  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length).toBeGreaterThan(0);

  await waitFor(
    async () => (await rowsSinceCursor(cursor, ["routine.fire"])).find((r) => (r.detail as { routineId?: unknown } | undefined)?.routineId === routineId),
    "a routine.fire outcome row for the ordinary fire — proof the turn actually ran",
  );
  const surfaceKey = `slack/${TEAM}/${CHANNEL}`;
  const gated = await rowsSinceCursor(cursor, ["turn.tool_gated"]);
  expect(gated.find((r) => r.workspace === surfaceKey && (r.detail as { reason?: unknown } | undefined)?.reason === "job-wake")).toBeUndefined();
});

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
  const cursor = await auditCursor();
  disposeLater(registerScript({ parent: [{ say: "nothing to report" }] }));

  await seedFire({ id, channelId: DISCORD_LISTED_CHANNEL_ID, withGuildEvidence: false });
  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length).toBeGreaterThan(0);

  const domainKey = `discord/${DISCORD_GUILD_ID}/${DISCORD_LISTED_CHANNEL_ID}`;
  const degraded = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["window.routing_degraded"]);
    return rows.find((r) => (r.detail as { domainKey?: unknown } | undefined)?.domainKey === domainKey);
  }, "a window.routing_degraded row for the guild-evidence-less fire on the windowing channel");

  const detail = degraded.detail as { grain?: unknown; domainKey?: unknown; recall?: unknown };
  expect(detail.grain).toBe("native");
});

test("NEGATIVE CONTROL — the same fire WITH guild evidence windows, and never writes the row", async () => {
  await bootAgent({ sharedSqlite: true });
  const id = `r-it-wr-${randomBytes(4).toString("hex")}`;
  const cursor = await auditCursor();
  disposeLater(registerScript({ parent: [{ say: "nothing to report" }] }));

  const channelId = freshUnlistedChannelId();
  await seedFire({ id, channelId, withGuildEvidence: true });
  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length).toBeGreaterThan(0);

  await waitFor(
    async () => (await rowsSinceCursor(cursor, ["egress.policy"])).find((r) => (r.surface ?? "").includes(channelId)),
    "a session.started egress.policy row for the windowed fire — proof the turn actually ran",
  );
  const domainKey = `discord/${DISCORD_GUILD_ID}/${channelId}`;
  const degraded = await rowsSinceCursor(cursor, ["window.routing_degraded"]);
  expect(degraded.find((r) => (r.detail as { domainKey?: unknown } | undefined)?.domainKey === domainKey)).toBeUndefined();
});

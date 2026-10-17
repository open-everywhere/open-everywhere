import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";

import { auditCursor, bootAgent, disposeLater, registerScript, rowsSinceCursor, runRoutineDispatchTick, waitFor, type AuditRow } from "../harness";
import { installDiscordWebApiStub } from "../discord-web-api";

const GUILD = "1300000000000025400";
const CHANNEL = "1300000000000025401";
const SURFACE_KEY = `discord/${GUILD}/${CHANNEL}`;
const CREATOR = "300000000000025402";
const PROBE_REASON = "ope2540 this call must be blocked";
const ANSWER = "ope2540 the open incident count is 3";

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

test("a requested Discord test posts its opening message, blocks the run's write, and replies to the opening message with the summary", async () => {
  const discord = installDiscordWebApiStub({ captureMessages: true });
  disposeLater({ dispose: () => discord.uninstall() });
  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  const cursor = await auditCursor();
  disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "report_run_failed", input: { reason: PROBE_REASON }, id: "ope2540-probe" }] },
        { calls: [{ tool: "reply", input: { text: ANSWER }, id: "ope2540-reply" }] },
        { say: "ok" },
      ],
    }),
  );
  const { addRoutine, getRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const id = `r-it-2540-${randomBytes(4).toString("hex")}`;
  const testId = `t-${randomBytes(4).toString("hex")}`;
  const nextRunAt = new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString();
  await addRoutine(
    { org: "default", platform: "discord", workspace: GUILD, surface: CHANNEL, workspaceKey: `discord/${GUILD}`, surfaceKey: SURFACE_KEY, domainKey: SURFACE_KEY, key: SURFACE_KEY },
    {
      id,
      org: "default",
      surfaceKey: SURFACE_KEY,
      target: { channelId: CHANNEL, guildId: GUILD },
      trigger: { kind: "interval", everyMinutes: 60 },
      prompt: "ope2540 post the open incident count",
      createdBy: CREATOR,
      status: "active",
      nextRunAt,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      promptGeneration: 1,
      consecutiveFailures: 0,
      testRun: { id: testId, requestedBy: CREATOR, requestedAt: new Date().toISOString() },
    },
  );

  await runRoutineDispatchTick();

  const fired = await waitFor(async () => (await rowsSinceCursor(cursor, ["routine.test_fired"], { limit: 100 })).find((r) => detailOf(r).test === testId), "the routine.test_fired row");
  expect(detailOf(fired).started, `🔴 the Discord test did not start (${String(detailOf(fired).reason)})`).toBe(true);
  const root = discord.messages.find((m) => m.channelId === CHANNEL && m.content.startsWith("🧪 Test run of") && m.replyTo === undefined);
  expect(root, "🔴 no opening message was posted in the routine's channel").toBeDefined();
  const rootIndex = discord.messages.indexOf(root!);
  const rootId = `stub-message-${rootIndex + 1}`;

  const blocked = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["routine.test_blocked"], { limit: 100 })).find((r) => detailOf(r).test === testId),
    "the routine.test_blocked row for the probe write",
    150_000,
  );
  expect(detailOf(blocked).tool, "🔴 the blocked call is not the run's write").toBe("report_run_failed");

  const summary = await waitFor(
    async () => discord.messages.find((m) => m.channelId === CHANNEL && m.replyTo === rootId && m.content.includes("finished")),
    "the summary reply to the opening message",
    150_000,
  );
  expect(summary.content, "the summary does not name the blocked write").toContain("report run failed");
  await waitFor(async () => discord.messages.find((m) => m.channelId === CHANNEL && m.content.includes(ANSWER)), "the run's answer in the routine's channel", 150_000);

  const after = await getRoutine("default", SURFACE_KEY, id);
  expect(after?.lastFailureReason, "🔴 the blocked write reached the routine row").toBeUndefined();
  expect([after?.nextRunAt, after?.lastRunAt, after?.consecutiveFailures, after?.testRun], "the test moved the routine's schedule, history or streak").toEqual([nextRunAt, undefined, 0, undefined]);
});

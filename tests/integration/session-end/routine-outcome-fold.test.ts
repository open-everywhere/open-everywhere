import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  auditCursor,
  bootAgent,
  DISCORD_GUILD_ID,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  waitFor,
  waitForChildren,
} from "../harness";

const ROUTINE_FIRE_ACTION = "routine.fire";
const FIRE_ATTRS_SENT_ACTION = "routine.fire_attrs_sent";
const TASK_SETTLED_ACTION = "delegation.task_settled";

const FIRE_SEAT_CHANNEL_ID = "1300000001500000014";
const SURFACE_KEY = `discord/${DISCORD_GUILD_ID}/${FIRE_SEAT_CHANNEL_ID}`;

test("a windowed routine fire whose delegated worker settles folds its run outcome", async () => {
  await bootAgent({ sharedSqlite: true });
  const cursor = await auditCursor();

  const { addRoutine, getRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const id = `r-it-581-${randomBytes(4).toString("hex")}`;
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  const scope = {
    org: "default",
    platform: "discord",
    workspace: DISCORD_GUILD_ID,
    surface: FIRE_SEAT_CHANNEL_ID,
    workspaceKey: `discord/${DISCORD_GUILD_ID}`,
    surfaceKey: SURFACE_KEY,
    domainKey: SURFACE_KEY,
    key: SURFACE_KEY,
  };
  await addRoutine(scope, {
    id,
    org: "default",
    surfaceKey: SURFACE_KEY,
    target: { channelId: FIRE_SEAT_CHANNEL_ID, guildId: DISCORD_GUILD_ID, channelType: "0" },
    trigger: { kind: "once", at: dueAt },
    prompt: "gather the numbers and report",
    createdBy: "discord:9000000000000000042",
    status: "active",
    nextRunAt: dueAt,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    consecutiveFailures: 2,
  });

  const handle = disposeLater(
    registerScript({
      parent: [{ say: NO_REPLY_SENTINEL }],
      child: [{ say: "gathered" }],
    }),
  );

  await runRoutineDispatchTick();

  const forwarded = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["work.forwarded"], { limit: 100 })).find((r) => (r.detail ?? {})["routineId"] === id),
    "the fire's work.forwarded row",
  );
  const requestId = (forwarded.detail ?? {})["requestId"];
  const keyed = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["work.task_keyed"], { limit: 100 })).find((r) => (r.detail ?? {})["requestId"] === requestId),
    "the fire's work.task_keyed row",
  );
  const taskId = (keyed.detail ?? {})["taskId"];
  const workSessionId = (keyed.detail ?? {})["workSession"];
  expect([typeof taskId, typeof workSessionId], "the keyed row names no task or no work session").toEqual(["string", "string"]);

  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the fire's worker's own terminal step" });

  const rows = await waitFor(async () => {
    const found = await rowsSinceCursor(cursor, [FIRE_ATTRS_SENT_ACTION, ROUTINE_FIRE_ACTION, TASK_SETTLED_ACTION], { limit: 100 });
    return found.some((r) => r.action === ROUTINE_FIRE_ACTION) ? found : undefined;
  }, `a ${ROUTINE_FIRE_ACTION} join row for this fire — the fold running on the turn edge`);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const settled = rows.filter((r) => r.action === TASK_SETTLED_ACTION && (r.detail ?? {})["task"] === taskId);
  expect(settled, "the fire's worker did not settle exactly once").toHaveLength(1);
  const foldRow = rows.find((r) => r.action === ROUTINE_FIRE_ACTION)!;
  expect(foldRow.seq, "the fire folded BEFORE its worker settled").toBeGreaterThan(settled[0]!.seq);

  expect(rows.filter((r) => r.action === FIRE_ATTRS_SENT_ACTION).length).toBeGreaterThanOrEqual(1);

  const stored = await getRoutine("default", SURFACE_KEY, id);
  expect(stored).toBeTruthy();
  expect(typeof stored!.lastRunAt).toBe("string");

  const fires = rows.filter((r) => r.action === ROUTINE_FIRE_ACTION);
  expect.soft(fires.length).toBe(1);
  expect.soft(fires[0]?.detail?.["routineId"]).toBe(id);
  expect.soft(fires[0]?.detail?.["sessionId"]).toBe(workSessionId);
  expect.soft(fires[0]?.detail?.["outcome"]).toBe("ok");
  expect.soft(stored!.lastOutcome).toBe("ok");
  expect.soft(stored!.consecutiveFailures).toBe(0);
});

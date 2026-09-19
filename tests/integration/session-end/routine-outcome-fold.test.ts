import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  afterThisTest,
  auditCursor,
  awaitTaskSettlement,
  bootAgent,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
} from "../harness";

const ROUTINE_FIRE_ACTION = "routine.fire";
const FIRE_ATTRS_SENT_ACTION = "routine.fire_attrs_sent";

const SURFACE_KEY = `discord/${DISCORD_GUILD_ID}/${DISCORD_LISTED_CHANNEL_ID}`;

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
    surface: DISCORD_LISTED_CHANNEL_ID,
    workspaceKey: `discord/${DISCORD_GUILD_ID}`,
    surfaceKey: SURFACE_KEY,
    domainKey: SURFACE_KEY,
    key: SURFACE_KEY,
  };
  await addRoutine(scope, {
    id,
    org: "default",
    surfaceKey: SURFACE_KEY,
    target: { channelId: DISCORD_LISTED_CHANNEL_ID, guildId: DISCORD_GUILD_ID, channelType: "0" },
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
      parent: [
        { calls: [{ tool: "agent", input: { message: "gather the numbers" }, id: "se-fire-delegate" }] },
        { say: "the worker reported back" },
      ],
      child: [{ say: "gathered" }],
    }),
  );

  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length).toBe(1);

  const fireFirst = await waitFor(() => handle.requests.find((r) => r.role === "parent"), "the fire's first model call");
  expect(fireFirst.tools).toContain("agent");

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the fire's terminal step to be served");
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the fire's delegated worker's own terminal step" });
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const taskId = taskIdOfDelegation(handle, "the fire's delegation");
  const settlement = await awaitTaskSettlement({
    dispatched: handle,
    taskId,
    script: { parent: [{ calls: [{ tool: "task_cancel", input: { taskIds: [taskId] }, id: "se-fire-peek" }] }, { say: "acknowledged" }] },
    label: "the fire worker's completion, delivered as a new message naming the task id",
  });
  afterThisTest(() => settlement.handle.dispose());

  const peeked = await waitFor(
    () => settlement.handle.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "task_cancel")),
    "the parent's step carrying the task_cancel result — eve's own terminal view of the fire's worker",
  );
  expect(peeked.toolResults.find((t) => t.name === "task_cancel")!.isError).toBe(false);
  expect(settlement.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const rows = await waitFor(async () => {
    const found = await rowsSinceCursor(cursor, [FIRE_ATTRS_SENT_ACTION, ROUTINE_FIRE_ACTION], { limit: 100 });
    return found.some((r) => r.action === ROUTINE_FIRE_ACTION) ? found : undefined;
  }, `a ${ROUTINE_FIRE_ACTION} join row for this fire — the fold running on the turn edge`);

  expect(rows.filter((r) => r.action === FIRE_ATTRS_SENT_ACTION).length).toBeGreaterThanOrEqual(1);

  const stored = await getRoutine("default", SURFACE_KEY, id);
  expect(stored).toBeTruthy();
  expect(typeof stored!.lastRunAt).toBe("string");

  const fires = rows.filter((r) => r.action === ROUTINE_FIRE_ACTION);
  expect.soft(fires.length).toBe(1);
  expect.soft(fires[0]?.detail?.["routineId"]).toBe(id);
  expect.soft(fires[0]?.detail?.["sessionId"]).toBe(sessionIds[0]);
  expect.soft(fires[0]?.detail?.["outcome"]).toBe("ok");
  expect.soft(stored!.lastOutcome).toBe("ok");
  expect.soft(stored!.consecutiveFailures).toBe(0);
});

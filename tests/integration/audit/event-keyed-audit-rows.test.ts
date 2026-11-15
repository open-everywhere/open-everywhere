import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  afterThisTest,
  armSettlement,
  auditCursor,
  awaitWindowQuiet,
  awaitWorkResult,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  seatReply,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  wrapToolExecute,
  type AuditCursor,
  type AuditRow,
  type ScriptedHandle,
} from "../harness";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

const CONSUMER_ROW_TIMEOUT_MS = 60_000;

async function consumerRow(cursor: AuditCursor, action: string, writer: string, match?: (r: AuditRow) => boolean): Promise<AuditRow> {
  return waitFor(
    async () => (await rowsSinceCursor(cursor, [action])).find((r) => match === undefined || match(r)),
    `the ${action} row this path must write (${writer})`,
    CONSUMER_ROW_TIMEOUT_MS,
  );
}

const EVE_TRUNCATION_MARKER = "Truncated by eve: tool result reduced during context compaction";

const OVERSIZED_NOTE = "x".repeat(2_600_000);
const ORDINARY_NOTE = "y".repeat(1_000);

async function driveSeatTurn(input: { readonly ids: string; readonly note?: string }): Promise<{ handle: ScriptedHandle; cursor: AuditCursor; channelId: string; replyText: string }> {
  await bootAgent();
  if (input.note !== undefined) {
    const note = input.note;
    afterThisTest(wrapToolExecute("update_status", () => ({ updated: true, state: note })));
  }
  const replyText = `oe-2685 ${input.ids} ${randomBytes(4).toString("hex")}`;
  const handle = disposeLater(
    registerScript({
      parent: [
        ...(input.note !== undefined ? [{ calls: [{ tool: "update_status", input: { state: "working", summary: `oe-2685 ${input.ids}` }, id: `${input.ids}-status` }] }] : []),
        seatReply(replyText, `${input.ids}-reply`),
      ],
    }),
  );
  const channelId = freshUnlistedChannelId();
  const cursor = await auditCursor();
  await discordMentionWake({ channelId, text: `<@9000000000000000001> oe-2685 ${input.ids}: please check the weekly numbers` });
  const post = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["reply.post"])).find((r) => r.surface === channelId),
    `the reply.post row for ${input.ids} (the reply tool)`,
  );
  expect(post.detail?.chars).toBe(replyText.length);
  await awaitWindowQuiet();
  expect(handle.requests.filter((r) => r.fault !== undefined), "the scripted model faulted").toEqual([]);
  return { handle, cursor, channelId, replyText };
}

function toolResultTextAt(handle: ScriptedHandle, stepIndex: number): string {
  return JSON.stringify(handle.requests.find((r) => r.role === "parent" && r.stepIndex === stepIndex)?.toolResults ?? []);
}

test("REPLY: a seat reply turn writes reply.post and the turn.completed row memory.observation", async () => {
  const { cursor } = await driveSeatTurn({ ids: "reply" });
  await consumerRow(cursor, "memory.observation", "hooks/learn.ts at message.received and turn.completed");
});

test("TOOL CALL: a turn that runs a tool step still writes the turn.completed row", async () => {
  const { handle, cursor } = await driveSeatTurn({ ids: "tool", note: ORDINARY_NOTE });
  const results = toolResultTextAt(handle, 1);
  expect(results).toContain(ORDINARY_NOTE);
  expect(results.includes(EVE_TRUNCATION_MARKER)).toBe(false);
  await consumerRow(cursor, "memory.observation", "hooks/learn.ts at message.received and turn.completed");
});

test("COMPACTION: the turn that compacted still settles and writes the turn.completed row", async () => {
  const { handle, cursor } = await driveSeatTurn({ ids: "compaction", note: OVERSIZED_NOTE });
  const results = toolResultTextAt(handle, 1);
  expect(results, "eve did not compact: the threshold was not crossed, so this drive proves nothing").toContain(EVE_TRUNCATION_MARKER);
  await consumerRow(cursor, "memory.observation", "hooks/learn.ts at message.received and turn.completed");
});

test("DELEGATED TASK + APPROVAL: a forwarded worker's task writes its task.started and task.settled rows, the seat's turn its wake-accounting row, and the proposal its card rows", async () => {
  await bootAgent();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ approvals: { judgeMode: "off" } });
  expect(settings.getSettings().approvals.judgeMode).toBe("off");

  const trigger = { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } as const;
  const prompt = `oe-2685 summarise the weekly numbers every weekday (${randomBytes(4).toString("hex")})`;
  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: "set up the routine I asked for" }, id: "oe2685-delegate" }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ delayMs: 120_000, calls: [{ tool: "create_routine", input: { prompt, trigger }, id: "oe2685-routine" }] }, { say: "proposed" }],
    }),
  );

  const cursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please set up the weekly routine" });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's forwarding turn to serve its receipt step");
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(cursor, handle, "oe2685-delegate", "the oe-2685 forward receipt");
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: "the oe-2685 worker's terminal step" });
  await awaitWorkResult({ handle: settlement, taskId, label: "the seat step that read the oe-2685 worker's result" });
  await awaitWindowQuiet();
  expect(handle.requests.filter((r) => r.fault !== undefined), "the scripted model faulted on the seat's handle").toEqual([]);
  expect(settlement.requests.filter((r) => r.fault !== undefined), "the scripted model faulted on the result turn").toEqual([]);

  await consumerRow(cursor, "delegation.task_started", "hooks/delegation-settlement.ts at task.started", (r) => r.detail?.task === taskId);
  const settled = await consumerRow(cursor, "delegation.task_settled", "hooks/delegation-settlement.ts at task.settled", (r) => r.detail?.task === taskId);
  expect(settled.detail?.status).toBe("completed");

  await waitFor(
    async () => (await rowsSinceCursor(cursor, ["turn.unaccounted_wakes", "turn.wake_accounting_skipped"]))[0],
    "a turn.unaccounted_wakes or turn.wake_accounting_skipped row (hooks/wake-accounting-turn.ts at turn.completed)",
    CONSUMER_ROW_TIMEOUT_MS,
  );

  const chain = await consumerRow(cursor, "approval.chain", "approvals/flow.ts, the create_routine propose path", (r) => r.detail?.tool === "create_routine");
  expect(chain.detail?.verdict).toBe("ask");
  await consumerRow(cursor, "approval.requested", "approvals/flow.ts, the create_routine card");
  const routine = handle.requests.flatMap((r) => r.toolResults).find((t) => t.name === "create_routine");
  expect(routine?.isError).toBe(false);
  expect((routine?.output as Record<string, unknown> | undefined)?.["pending"]).toBe(true);
});

import { expect, test } from "vitest";

import { TASK_WAKE_ACTION } from "@open-everywhere/core/agent/channels/task-wake.js";

import { __setStaleTurnParkMsForTest } from "../../../agent/model/scripted-model";
import {
  afterThisTest,
  armSettlement,
  auditCursor,
  awaitWindowQuiet,
  bootAgent,
  disposeLater,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  rowsSinceCursor,
  SETTLEMENT_DRAIN_CLOSING_SCRIPT,
  SETTLEMENT_DRAIN_SCRIPT,
  waitFor,
  type RecordedRequest,
  type ScriptedHandle,
  type ScriptedStep,
  type SeatScript,
} from "../harness";

const DELEGATOR_PROSE = "oe-1982 the delegator's closing prose, dropped and corrected exactly once";

const SECOND_ASK = "the second ask";

const RESCUE_CALL_ID = "ope1982-rescue-delegate";
const GUARD_CALL_ID = "ope727-live-delegate";

const HELD_WORKER: ScriptedStep = { say: "the worker's own prose, which never leaves the parent's session", delayMs: 120_000 };

function ownEnvelope(request: RecordedRequest): string {
  const prompt = request.messages.map((m) => m.text).join("\n");
  const at = prompt.lastIndexOf("<wake ");
  return at === -1 ? "" : prompt.slice(at);
}

function taskIdOfCall(handle: ScriptedHandle, callId: string, label: string): string {
  const receipt = handle.requests.flatMap((r) => r.toolResults).find((t) => t.name === "agent" && t.id === callId);
  const taskId = (receipt?.output as { taskId?: unknown } | undefined)?.taskId;
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new Error(
      `${label}: no background-task receipt for the "agent" call "${callId}" — got ${JSON.stringify(receipt?.output)}. ` +
        "Every delegation mints one, so a missing receipt is a regression, and a wrong call id is a test defect.",
    );
  }
  return taskId;
}

async function closeDelegation(dispatched: ScriptedHandle, callId: string, label: string, drain: SeatScript): Promise<void> {
  const wakeCursor = await auditCursor();
  await waitFor(() => dispatched.requests.find((r) => r.role === "child" && r.stepIndex === 0), `${label}: the worker's own model call`);
  const taskId = taskIdOfCall(dispatched, callId, label);
  const armed = armSettlement(dispatched, drain);
  try {
    dispatched.releaseHolds();
    await waitFor(async () => {
      const rows = await rowsSinceCursor(wakeCursor, [TASK_WAKE_ACTION]);
      return rows.some((r) => (r.detail as { task?: unknown } | undefined)?.task === taskId) ? true : undefined;
    }, `${label}: the settlement edge's own ${TASK_WAKE_ACTION} row`);
    if (drain === SETTLEMENT_DRAIN_CLOSING_SCRIPT) {
      await waitFor(
        () => armed.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
        `${label}: the closing drain's SECOND no_reply — the call that ends the reply obligation`,
        60_000,
      );
    }
    await awaitWindowQuiet();
    expect(dispatched.holdsCutShort(), `${label}: the worker's hold ended on the release, not on its backstop`).toBe(1);
    expect(armed.requests.filter((r) => r.fault !== undefined), `${label}: the settlement drain degraded`).toEqual([]);
  } finally {
    armed.dispose();
  }
}

test("OPE-1982 — the corrective re-drive re-enters a still-registered script and is answered with silence, not the OPE-727 fault", async () => {
  await bootAgent();

  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "look something up" }, id: RESCUE_CALL_ID }] }, { say: DELEGATOR_PROSE }],
      child: [HELD_WORKER],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> please delegate this` });
  const delegating = await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0),
    "the delegating turn's call-bearing step",
  );

  const rescued = await waitFor(
    () => handle.requests.find((r) => r.redriveSilence === true),
    "the corrective turn to be answered with judged silence instead of the stale-script fault",
  );

  expect(rescued.messages.some((m) => m.text.includes('id="redrive-'))).toBe(true);

  expect(rescued.turnId).not.toBe(delegating.turnId);
  expect(typeof rescued.turnId).toBe("string");

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.resolves.filter((r) => r.fault !== undefined)).toEqual([]);

  await closeDelegation(handle, RESCUE_CALL_ID, "OPE-1982 rescue", SETTLEMENT_DRAIN_CLOSING_SCRIPT);
});

test("OPE-727 still fires — a genuinely new wake re-entering the same live entry faults, even after that entry was already rescued once", async () => {
  await bootAgent();

  __setStaleTurnParkMsForTest(1_000);
  afterThisTest(() => __setStaleTurnParkMsForTest(undefined));

  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "look something up" }, id: GUARD_CALL_ID }] }, { say: DELEGATOR_PROSE }],
      child: [HELD_WORKER],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> the first ask` });
  const rescued = await waitFor(() => handle.requests.find((r) => r.redriveSilence === true), "the first ask's correction, answered with silence");
  expect(rescued.fault).toBeUndefined();

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> ${SECOND_ASK}` });
  const faulted = await waitFor(
    () => handle.requests.find((r) => r.fault?.includes("stale script") && ownEnvelope(r).includes(SECOND_ASK)),
    "the second wake to take the OPE-727 stale-script fault",
  );

  expect(faulted.fault).toContain("already served a call-bearing step for turn");
  expect(faulted.redriveSilence).toBeUndefined();
  expect(faulted.turnId).not.toBe(rescued.turnId);

  const prompt = faulted.messages.map((m) => m.text).join("\n");
  expect(prompt.includes('id="redrive-'), "the cumulative prompt carries the earlier correction").toBe(true);
  expect(prompt.slice(prompt.lastIndexOf("<wake ")).includes('id="redrive-'), "…but THIS turn's own envelope does not").toBe(false);

  await closeDelegation(handle, GUARD_CALL_ID, "OPE-727 first ask", SETTLEMENT_DRAIN_SCRIPT);
});

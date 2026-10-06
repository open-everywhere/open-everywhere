import { afterAll, expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";

import {
  auditCursor,
  awaitWorkResult,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  registerScript,
  rowsSinceCursor,
  waitFor,
  workSessionCalls,
  workTaskIdOfCall,
  type ScriptedHandle,
} from "../harness";

const live = new Set<ScriptedHandle>();
afterAll(() => {
  for (const h of live) {
    h.releaseHolds();
    h.dispose();
  }
  live.clear();
});
function open(handle: ScriptedHandle): ScriptedHandle {
  live.add(handle);
  return handle;
}

const WORK_FORWARDED = "work.forwarded";
const WORK_RESULT_WAKE = "work.result_wake";

test("the work session outlives a seat rotation, and the result wakes the seat generation live now", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();
  const cursor = await auditCursor();
  const callId = "ope2341-outlives-forward";

  const job = open(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: "ope-2341: a job that outlives the seat" }, id: callId }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ delayMs: 120_000, say: "the long job finished" }],
    }),
  );
  const wCallsBefore = workSessionCalls().length;
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> start the long job", messageId: "ope2341-outlives-a" });
  const receipt = await waitFor(() => job.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's receipt step");
  const oldSeatSession = receipt.sessionId;
  await waitFor(() => job.requests.find((r) => r.role === "child"), "the child's held step — the job is running");
  const wFirst = await waitFor(() => workSessionCalls().slice(wCallsBefore).find((c) => typeof c.sessionId === "string"), "W's first model call");
  const wSession = wFirst.sessionId;
  const taskId = await workTaskIdOfCall(cursor, job, callId, "outlives");

  const forwarded = (await rowsSinceCursor(cursor, [WORK_FORWARDED]))[0];
  const wToken = String(forwarded?.detail?.["workToken"] ?? "");
  const windowId = /:win:w\/([^:]+):oe-sup:/u.exec(wToken)?.[1];
  expect(windowId, "the forward names W's token").toBeDefined();
  const seatKey = `oe-domain::${windowId}`;
  const wKey = `oe-domain::w/${windowId}`;
  const seatBefore = (await store.getChannelSession(org, seatKey))!;
  const wBefore = (await store.getChannelSession(org, wKey))!;
  expect(wBefore.token).toBe(wToken);

  job.dispose();
  const after = open(registerScript({ parent: [{ say: NO_REPLY_SENTINEL }] }));
  expect(await store.markChannelSessionRotation(org, seatKey, new Date().toISOString())).toBe(true);
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> are you there?", messageId: "ope2341-outlives-b" });
  const rotatedStep = await waitFor(() => after.requests.find((r) => r.role === "parent" && r.sessionId !== oldSeatSession), "the rotated seat's first step — a NEW seat session");
  const newSeatSession = rotatedStep.sessionId;
  const seatRotated = (await store.getChannelSession(org, seatKey))!;
  expect(seatRotated.generation).toBe(seatBefore.generation + 1);
  expect(seatRotated.token).not.toBe(seatBefore.token);

  const wDuring = (await store.getChannelSession(org, wKey))!;
  expect(wDuring.generation).toBe(wBefore.generation);
  expect(wDuring.token).toBe(wBefore.token);

  const wCallsMid = workSessionCalls().length;
  job.releaseHolds();
  const result = await awaitWorkResult({ handle: after, taskId, label: "the seat step that read the job's result" });
  expect(result.sessionId, "the result reaches the seat's CURRENT generation").toBe(newSeatSession);
  expect(result.sessionId).not.toBe(oldSeatSession);
  const wake = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, [WORK_RESULT_WAKE])).filter((r) => r.detail?.["taskId"] === taskId);
    return rows.length > 0 ? rows : undefined;
  }, "the work.result_wake row");
  expect(wake[0]!.detail?.["outcome"]).toBe("delivered");
  const wSettle = workSessionCalls().slice(wCallsMid).find((c) => typeof c.sessionId === "string");
  if (wSettle !== undefined) expect(wSettle.sessionId).toBe(wSession);
  const wAfter = (await store.getChannelSession(org, wKey))!;
  expect(wAfter.generation).toBe(wBefore.generation);
  for (const h of [job, after]) expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});

import { afterAll, expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { SESSION_PARK_AUDIT_ACTION } from "@open-everywhere/core/agent/channels/session-park.js";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";

import {
  armSettlement,
  auditCursor,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  registerScript,
  rowsSinceCursor,
  waitFor,
  workSessionCalls,
  type ScriptedHandle,
} from "../harness";

const live = new Set<ScriptedHandle>();
afterAll(() => {
  for (const h of live) h.dispose();
  live.clear();
});
function open(handle: ScriptedHandle): ScriptedHandle {
  live.add(handle);
  return handle;
}
function close(handle: ScriptedHandle): void {
  handle.dispose();
  live.delete(handle);
}

const SESSION_INPUT_TOKEN_BUDGET = 30_000_000;
const COMPACTION_THRESHOLD_TOKENS = 0.5 * 1_050_000;
const REPORTED_INPUT_TOKENS_PER_STEP = 180_000;
if (REPORTED_INPUT_TOKENS_PER_STEP >= COMPACTION_THRESHOLD_TOKENS) throw new Error("work-session-park fixture: a step at or over the compaction threshold measures compaction, not the park");
const STEPS_TO_BOUND = Math.ceil(SESSION_INPUT_TOKEN_BUDGET / REPORTED_INPUT_TOKENS_PER_STEP);

const WORK_FORWARDED = "work.forwarded";
const WORK_ROTATED = "work.session_rotated";
const WORK_REQUEST_LOST = "work.request_lost";

test("the work session parks on its own budget: W's generation retires, the seat's does not change", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();
  const cursor = await auditCursor();

  const burning = open(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: "ope-2341 park probe: a long job" }, id: "ope2341-park-forward" }] }, { say: NO_REPLY_SENTINEL }],
      work: Array.from({ length: STEPS_TO_BOUND }, (_unused, i) => ({
        calls: [{ tool: "task_cancel", input: { taskId: `agent-ope2341-none-${i}` }, id: `ope2341-w-loop-${i}` }],
        usage: { inputTokens: REPORTED_INPUT_TOKENS_PER_STEP, outputTokens: 100 },
      })),
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> run the long job", messageId: "ope2341-park-wake" });

  const forwarded = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [WORK_FORWARDED]);
    return rows.length > 0 ? rows : undefined;
  }, "the seat's forward row");
  const parkedWToken = String(forwarded[0]!.detail?.["workToken"] ?? "");
  expect(parkedWToken).toMatch(/:win:w\//u);
  const receipt = await waitFor(() => burning.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's receipt step");
  const seatSessionId = receipt.sessionId;
  const notice = open(armSettlement(burning, { parent: [{ say: NO_REPLY_SENTINEL }] }));

  const lastBurn = await waitFor(() => burning.requests.find((r) => r.role === "work" && r.stepIndex === STEPS_TO_BOUND - 1), `W's ${STEPS_TO_BOUND}th step — the one that banks W past eve's bound`);
  expect(burning.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const parkedWSessionId = lastBurn.sessionId;
  expect(parkedWSessionId).not.toBe(seatSessionId);

  const park = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [SESSION_PARK_AUDIT_ACTION]);
    return rows.length > 0 ? rows : undefined;
  }, "the session.token_limit_park row for W");
  expect(park).toHaveLength(1);
  const detail = park[0]!.detail ?? {};
  expect(detail["limit"]).toBe(SESSION_INPUT_TOKEN_BUDGET);
  expect(detail["tier"]).toBe("work");
  expect(detail["remedy"]).toBe("rotate_on_next_wake");
  const wKey = String(detail["registryKey"] ?? "");
  expect(wKey.startsWith("oe-domain::w/")).toBe(true);
  const wRow = await store.getChannelSession(org, wKey);
  expect(wRow?.token).toBe(parkedWToken);
  expect(await store.getTaskResult(org, `oe-work-dead:${parkedWToken}`)).not.toBeNull();

  const seatKey = wKey.replace("oe-domain::w/", "oe-domain::");
  const seatRow = await store.getChannelSession(org, seatKey);
  expect(seatRow).not.toBeNull();
  const seatGeneration = seatRow!.generation;
  const seatToken = seatRow!.token;
  expect(Number(seatRow!.inputTokensTotal ?? 0)).toBeLessThan(SESSION_INPUT_TOKEN_BUDGET);

  const lost = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, [WORK_REQUEST_LOST])).filter((r) => r.detail?.["outcome"] === "notified");
    return rows.length > 0 ? rows : undefined;
  }, "the work.request_lost row for the parked job");
  expect(lost).toHaveLength(1);
  const noticeStep = await waitFor(() => notice.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes("was reset (work-session parked"))), "the seat's turn that read the lost-job notice");
  expect(noticeStep.sessionId).toBe(seatSessionId);
  close(notice);
  close(burning);

  const cursor2 = await auditCursor();
  const after = open(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: "ope-2341 after the park" }, id: "ope2341-after-forward" }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ say: "fresh work session, still working" }],
    }),
  );
  const wCallsBefore = workSessionCalls().length;
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> and another job", messageId: "ope2341-park-followup" });
  const rotated = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor2, [WORK_ROTATED]);
    return rows.length > 0 ? rows : undefined;
  }, "the work.session_rotated row");
  expect(rotated[0]!.detail?.["trigger"]).toBe("parked");
  expect(rotated[0]!.detail?.["from"]).toBe(parkedWToken);
  const freshW = await waitFor(() => workSessionCalls().slice(wCallsBefore).find((c) => typeof c.sessionId === "string"), "the fresh W's first model call");
  expect(freshW.sessionId).not.toBe(parkedWSessionId);
  const wNow = await store.getChannelSession(org, wKey);
  expect(wNow!.generation).toBe(wRow!.generation + 1);
  expect(wNow!.token).not.toBe(parkedWToken);
  const settle = open(armSettlement(after, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  await waitFor(() => settle.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes("work-result-"))), "the fresh job's result wake on the seat");
  const secondSeatStep = after.requests.find((r) => r.role === "parent" && r.stepIndex === 0);
  expect(secondSeatStep?.sessionId).toBe(seatSessionId);
  const seatAfter = await store.getChannelSession(org, seatKey);
  expect(seatAfter!.generation).toBe(seatGeneration);
  expect(seatAfter!.token).toBe(seatToken);
  expect(after.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});

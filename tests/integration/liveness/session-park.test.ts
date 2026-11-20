import { afterAll, expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { parkRotateDelta, SESSION_PARK_AUDIT_ACTION } from "@open-everywhere/core/agent/channels/session-park.js";

import {
  auditCursor,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  registerScript,
  rowsSinceCursor,
  waitFor,
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

const SESSION_INPUT_TOKEN_BUDGET = 30_000_000;

const COMPACTION_THRESHOLD_TOKENS = 0.5 * 1_050_000;

const REPORTED_INPUT_TOKENS_PER_STEP = 180_000;

if (REPORTED_INPUT_TOKENS_PER_STEP >= COMPACTION_THRESHOLD_TOKENS) {
  throw new Error(
    `session-park fixture: each step reports ${REPORTED_INPUT_TOKENS_PER_STEP} input tokens, at or above the ` +
      `${COMPACTION_THRESHOLD_TOKENS} per-prompt compaction threshold. Every step would trip compaction and this ` +
      `file would measure compaction, not the park. Lower the per-step report, or raise the threshold deliberately.`,
  );
}

const STEPS_TO_BOUND = Math.ceil(SESSION_INPUT_TOKEN_BUDGET / REPORTED_INPUT_TOKENS_PER_STEP);

const LOOP_TOOL = "update_status";

test("a seat that hits eve's session-token bound parks, and OE retires the generation", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();
  const cursor = await auditCursor();

  const burning = open(
    registerScript({
      parent: Array.from({ length: STEPS_TO_BOUND }, (_unused, i) => ({
        calls: [{ tool: LOOP_TOOL, input: { state: "working", summary: `ope-634 park probe ${i}` }, id: `ope634-park-loop-${i}` }],
        usage: { inputTokens: REPORTED_INPUT_TOKENS_PER_STEP, outputTokens: 100 },
      })),
    }),
  );

  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: "<@9000000000000000001> burn the session budget",
    messageId: "ope634-park-wake",
  });

  const lastBurn = await waitFor(
    () => burning.requests.find((r) => r.role === "parent" && r.stepIndex === STEPS_TO_BOUND - 1),
    `the ${STEPS_TO_BOUND}th scripted step — the call that banks the session past eve's bound`,
  );
  expect(burning.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(lastBurn.tools).toContain(LOOP_TOOL);

  const park = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [SESSION_PARK_AUDIT_ACTION]);
    return rows.length > 0 ? rows : undefined;
  }, "the session.token_limit_park row — eve parked the seat and OE saw it");
  expect(park).toHaveLength(1);
  const detail = park[0]!.detail ?? {};
  expect(park[0]!.principalId).toBe("eve:harness");
  expect(detail["limit"]).toBe(SESSION_INPUT_TOKEN_BUDGET);
  expect(detail["kind"]).toBe("input");
  expect(Number(detail["usedTokens"])).toBeGreaterThanOrEqual(SESSION_INPUT_TOKEN_BUDGET);
  expect(String(detail["requestId"])).toMatch(/:limit:usage:0$/u);
  expect(detail["remedy"]).toBe("rotate_on_next_wake");
  const registryKey = String(detail["registryKey"] ?? "");
  expect(registryKey.length).toBeGreaterThan(0);

  expect(await rowsSinceCursor(cursor, ["turn.question_dropped"])).toEqual([]);

  const parked = await store.getChannelSession(org, registryKey);
  expect(parked).not.toBeNull();
  expect(Number(parked!.inputTokensTotal)).toBeGreaterThanOrEqual(parkRotateDelta());
  const parkedGeneration = parked!.generation;
  const parkedToken = parked!.token;

  burning.dispose();
  live.delete(burning);
  const after = open(registerScript({ parent: [{ say: "fresh generation, still answering" }] }));

  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: "<@9000000000000000001> are you still there?",
    messageId: "ope634-park-followup",
  });

  const revived = await waitFor(
    () => after.requests.find((r) => r.role === "parent"),
    "the next wake's model call — the seat answering after the park",
  );
  expect(after.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(revived.sessionId).not.toBe(burning.requests[0]?.sessionId);

  const rotated = await store.getChannelSession(org, registryKey);
  expect(rotated).not.toBeNull();
  expect(rotated!.generation).toBe(parkedGeneration + 1);
  expect(rotated!.token).not.toBe(parkedToken);
  expect(Number(rotated!.inputTokensTotal ?? 0)).toBeLessThan(parkRotateDelta());
});

// proves: SET-002

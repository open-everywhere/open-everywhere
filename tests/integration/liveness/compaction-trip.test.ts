import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { afterThisTest,
  disposeLater, bootAgent, discordMentionWake, readAuditRows, registerScript, waitFor, wrapToolExecute, type ScriptedHandle } from "../harness";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

const EVE_TRUNCATION_MARKER = "Truncated by eve: tool result reduced during context compaction";

function sessionCostResult(note: string): Record<string, unknown> {
  return {
    sessionId: "oe-670-compaction-trip",
    events: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sandboxSeconds: 0,
    note,
  };
}

const OVERSIZED_NOTE = "x".repeat(2_600_000);

const ORDINARY_NOTE = "y".repeat(1_000);

function toolResultTextAt(handle: ScriptedHandle, stepIndex: number): string {
  const request = handle.requests.find((r) => r.role === "parent" && r.stepIndex === stepIndex);
  return JSON.stringify(request?.toolResults ?? []);
}

async function driveOneToolCallTurn(note: string, replyText: string): Promise<{ handle: ScriptedHandle; channelId: string; sinceIso: string }> {
  await bootAgent();
  afterThisTest(wrapToolExecute("session_cost", () => sessionCostResult(note)));

  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "session_cost", input: {}, id: "oe670-cost" }] }, { say: replyText }],
    }),
  );

  const channelId = freshUnlistedChannelId();
  const sinceIso = new Date(Date.now() - 10_000).toISOString();
  await discordMentionWake({ channelId, text: `<@9000000000000000001> what has this conversation cost` });

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the terminal step, after the compaction trip");
  return { handle, channelId, sinceIso };
}

test("a turn whose prompt crosses the compaction threshold completes, and eve compacted its transcript", async () => {
  const replyText = `oe-670-compaction-ok ${randomBytes(4).toString("hex")}`;
  const { handle, channelId, sinceIso } = await driveOneToolCallTurn(OVERSIZED_NOTE, replyText);

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const terminalToolResults = toolResultTextAt(handle, 1);
  expect(terminalToolResults).toContain(EVE_TRUNCATION_MARKER);

  expect(terminalToolResults.length).toBeLessThan(OVERSIZED_NOTE.length / 100);

  const row = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["reply.post"], sinceIso });
    return rows.find((r) => r.action === "reply.post" && r.surface === channelId);
  }, `a reply.post audit row for channel ${channelId}`);
  expect(row.platform).toBe("discord");
  expect(row.detail?.chars).toBe(replyText.length);
});

test("a turn UNDER the compaction threshold is not compacted — the marker is absent and the tool result survives whole", async () => {
  const replyText = `oe-670-no-compaction ${randomBytes(4).toString("hex")}`;
  const { handle, channelId, sinceIso } = await driveOneToolCallTurn(ORDINARY_NOTE, replyText);

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const terminalToolResults = toolResultTextAt(handle, 1);
  expect(terminalToolResults).toContain(ORDINARY_NOTE);
  expect(terminalToolResults.includes(EVE_TRUNCATION_MARKER)).toBe(false);

  const row = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["reply.post"], sinceIso });
    return rows.find((r) => r.action === "reply.post" && r.surface === channelId);
  }, `a reply.post audit row for channel ${channelId}`);
  expect(row.detail?.chars).toBe(replyText.length);
});

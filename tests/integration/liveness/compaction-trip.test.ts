import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  afterThisTest,
  auditCursor,
  bootAgent,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  seatReply,
  waitFor,
  wrapToolExecute,
  type AuditCursor,
  type ScriptedHandle,
} from "../harness";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

const EVE_TRUNCATION_MARKER = "Truncated by eve: tool result reduced during context compaction";

function statusResult(note: string): Record<string, unknown> {
  return { updated: true, state: note };
}

const OVERSIZED_NOTE = "x".repeat(2_600_000);

const ORDINARY_NOTE = "y".repeat(1_000);

function toolResultTextAt(handle: ScriptedHandle, stepIndex: number): string {
  const request = handle.requests.find((r) => r.role === "parent" && r.stepIndex === stepIndex);
  return JSON.stringify(request?.toolResults ?? []);
}

async function driveOneToolCallTurn(note: string, replyText: string): Promise<{ handle: ScriptedHandle; channelId: string; cursor: AuditCursor }> {
  await bootAgent();
  afterThisTest(wrapToolExecute("update_status", () => statusResult(note)));

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "update_status", input: { state: "working", summary: "oe-670 compaction probe" }, id: "oe670-cost" }] },
        seatReply(replyText, "oe670-reply"),
      ],
    }),
  );

  const channelId = freshUnlistedChannelId();
  const cursor = await auditCursor();
  await discordMentionWake({ channelId, text: `<@9000000000000000001> what has this conversation cost` });

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the step after the compaction trip");
  return { handle, channelId, cursor };
}

test("a turn whose prompt crosses the compaction threshold completes, and eve compacted its transcript", async () => {
  const replyText = `oe-670-compaction-ok ${randomBytes(4).toString("hex")}`;
  const { handle, channelId, cursor } = await driveOneToolCallTurn(OVERSIZED_NOTE, replyText);

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const terminalToolResults = toolResultTextAt(handle, 1);
  expect(terminalToolResults).toContain(EVE_TRUNCATION_MARKER);

  expect(terminalToolResults.length).toBeLessThan(OVERSIZED_NOTE.length / 100);

  const row = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"]);
    return rows.find((r) => r.action === "reply.post" && r.surface === channelId);
  }, `a reply.post audit row for channel ${channelId}`);
  expect(row.platform).toBe("discord");
  expect(row.detail?.route).toBe("tool");
  expect(row.detail?.chars).toBe(replyText.length);
});

test("a turn UNDER the compaction threshold is not compacted — the marker is absent and the tool result survives whole", async () => {
  const replyText = `oe-670-no-compaction ${randomBytes(4).toString("hex")}`;
  const { handle, channelId, cursor } = await driveOneToolCallTurn(ORDINARY_NOTE, replyText);

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const terminalToolResults = toolResultTextAt(handle, 1);
  expect(terminalToolResults).toContain(ORDINARY_NOTE);
  expect(terminalToolResults.includes(EVE_TRUNCATION_MARKER)).toBe(false);

  const row = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"]);
    return rows.find((r) => r.action === "reply.post" && r.surface === channelId);
  }, `a reply.post audit row for channel ${channelId}`);
  expect(row.detail?.chars).toBe(replyText.length);
});

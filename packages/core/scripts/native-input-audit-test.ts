import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-native-input-audit-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import nativeInputAuditHook, { NATIVE_INPUT_REQUESTED_AUDIT_ACTION } from "../agent/hooks/native-input-audit.js";
import { registerPostArm } from "../agent/channels/post-arms.js";
import type { ReplyTarget } from "../agent/channels/reply-post.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { registerSlackFixtureManifest, registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { readAudit } from "../agent/audit/audit.js";
import { resolvePartition } from "../agent/memory/partition.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

registerSlackFixtureManifest();
registerSlackFixtureMapper();
registerPostArm({
  dispatchReply: async () => "ts-1",
  platform: "slack",
  resolveTarget: (bag: { str(k: string): string | undefined }): ReplyTarget | null => {
    const channelId = bag.str("channelId");
    return channelId === undefined ? null : ({ channelId, platform: "slack" } as ReplyTarget);
  },
});

const nativeCtx = (sessionId: string, kind: string = "slack", oePlatform?: string): BindableContext =>
  ({
    channel: { kind },
    session: {
      auth: {
        current: {
          attributes: {
            channel_id: "C-ROOM",
            ...(oePlatform !== undefined ? { oe_platform: oePlatform } : {}),
            team_id: "T1",
            trust_checked: "true",
          },
          principalId: "U-req",
          principalType: "slack-user",
        },
      },
      id: sessionId,
    },
  }) as unknown as BindableContext;

const subagentChildCtx = (sessionId: string): BindableContext => {
  const ctx = nativeCtx(sessionId) as unknown as { session: Record<string, unknown> };
  ctx.session.parent = { sessionId: "parent-session" };
  return ctx as unknown as BindableContext;
};

const ORG = resolvePartition(nativeCtx("probe")).org;

const { callView } = await import("./_hook-view.js");
const fireHook = (requests: readonly { kind?: string; prompt?: string; requestId: string; action?: { toolName?: string } }[], ctx: BindableContext): Promise<void> => {
  const r = requests[0]!;
  const kind = r.kind === "tool-approval" ? "approval" : (r.kind ?? "budget");
  const toolName = r.action?.toolName;
  const view = callView({ callId: "c-asked", name: toolName ?? "none" });
  return (nativeInputAuditHook as unknown as { events: Record<string, (event: unknown, c: unknown) => Promise<void>> }).events["interaction.opened"](
    { data: { interactionId: r.requestId, subject: kind === "approval" ? { callId: "c-asked" } : { turnId: "t1" }, request: { kind, prompt: r.prompt ?? "" } } },
    { ...(ctx as object), view } as unknown as BindableContext,
  );
};

const APPROVAL_BATCH = [
  { action: { toolName: "notion__notion-create-pages" }, kind: "tool-approval", prompt: "Approve tool call?", requestId: "approval-1" },
];
const QUESTION_BATCH = [{ kind: "question", prompt: "Which page?", requestId: "question-1" }];
const PARK_BATCH = [{ action: { toolName: "session_limit_continuation" }, requestId: "park-1" }];

const rowsFor = async (): Promise<{ action: string; detail?: Record<string, unknown> }[]> =>
  (await readAudit({ org: ORG })).filter((r) => r.action === NATIVE_INPUT_REQUESTED_AUDIT_ACTION) as { action: string; detail?: Record<string, unknown> }[];

{
  const { approvalCallOf } = await import("../agent/hooks/approval-raised.js");
  const relayedView = callView({ callId: "c-parent-agent", name: "worker", kind: "agent" });
  const relayed = approvalCallOf(
    {
      interactionId: "i-relayed",
      subject: { callId: "c-parent-agent" },
      request: { kind: "approval", prompt: "?" },
      origin: { sessionId: "child", interactionId: "i-child", call: { callId: "c-child", name: "linear__delete_issue", input: { id: "X" } } },
    },
    relayedView,
  );
  eq(relayed?.toolName, "linear__delete_issue", "0. a relayed child approval names the CHILD's tool from origin.call, not the parent's agent call");
  eq(JSON.stringify(relayed?.input), JSON.stringify({ id: "X" }), "0. …and carries the child call's input");
  const local = approvalCallOf({ interactionId: "i-local", subject: { callId: "c-parent-agent" }, request: { kind: "approval", prompt: "?" } }, relayedView);
  eq(local?.toolName, "worker", "0. a local approval still reads its own call off the view (negative control)");
}

console.log("1. a tool-approval on a native (slack) surface writes ONE audit row:");
{
  const before = (await rowsFor()).length;
  await fireHook(APPROVAL_BATCH, nativeCtx("s1"));
  const rows = await rowsFor();
  eq(rows.length, before + 1, "exactly one row was written for this batch");
  const detail = rows[rows.length - 1].detail;
  eq(detail?.platform, "slack", "…naming the resolved native platform");
  eq(detail?.kind, "approval", "…and the request's kind — a parked approval reads differently from a parked question");
  eq(detail?.requestId, "approval-1", "…and eve's own request id, for the join");
  eq(detail?.toolName, "notion__notion-create-pages", "…and the tool the approval is for");
}

console.log("1b. an ask_question on the same surface also writes a row:");
{
  const before = (await rowsFor()).length;
  await fireHook(QUESTION_BATCH, nativeCtx("s2"));
  eq((await rowsFor()).length, before + 1, "a bridgeable question is audited too, not only a tool-approval");
}

console.log("2. NEGATIVE CONTROL — eve's own session-limit park writes NO native-input-audit row:");
{
  const before = (await rowsFor()).length;
  await fireHook(PARK_BATCH, nativeCtx("s3"));
  eq((await rowsFor()).length, before, "hooks/session-park.ts owns the park; this hook must not double-count it");
}

console.log("3. NEGATIVE CONTROL — a REAL unified-window context writes NO native-input-audit row:");
{
  const before = (await rowsFor()).length;
  await fireHook(APPROVAL_BATCH, nativeCtx("s4", "unified", "slack"));
  eq((await rowsFor()).length, before, "the unified window's raw channel.kind excludes it — channels/unified.ts already audited this one as turn.question_dropped, and it must not be double-counted here");
}

console.log("3b. the origin stamp alone does not suppress a genuinely native context:");
{
  const before = (await rowsFor()).length;
  await fireHook(APPROVAL_BATCH, nativeCtx("s5", "slack", "slack"));
  eq((await rowsFor()).length, before + 1, "a native channel.kind is audited regardless of whether oe_platform is also stamped — only channel.kind decides unified-ness");
}

console.log("3c. NEGATIVE CONTROL — a subagent child writes NO native-input-audit row:");
{
  const before = (await rowsFor()).length;
  await fireHook(APPROVAL_BATCH, nativeCtx("s6", "subagent", "slack"));
  eq((await rowsFor()).length, before, "a child on eve's framework subagent adapter writes nothing — eve proxies a worker's request UP through the PARENT's channel adapter, and the parent's own row is the record");

  await fireHook(APPROVAL_BATCH, subagentChildCtx("s7"));
  eq((await rowsFor()).length, before, "…and so does a child recognised only by eve's typed session.parent linkage, which the raw-kind read alone would miss");
}

if (n === 0) throw new Error("no assertions ran");
console.log(`\n✅ native-input-audit: ${String(n)} assertions passed`);

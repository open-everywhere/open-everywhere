
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-memory-citation-render-")), "ops.sqlite3");
delete process.env.OE_ORG;
delete process.env.OE_EGRESS_SPOOF;

import { truncateMemoryCitationPaths } from "../agent/channels/turn-delivery.js";
import { registerPostArm, type PostArm } from "../agent/channels/post-arms.js";
import { postReply, type ReplyTarget, type ReplyAudit } from "../agent/channels/reply-post.js";
import { postUnifiedReply } from "../agent/channels/unified-reply.js";
import { editPostedMessage } from "../agent/channels/reply-edit.js";
import type { EditLocus } from "../agent/channels/reply-edit.js";
import type { UnifiedWakeOrigin } from "../agent/channels/unified-window.js";
import { readAudit } from "../agent/audit/audit.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("1. truncateMemoryCitationPaths:");

eq(
  truncateMemoryCitationPaths(
    "We decided that metrics-export's release codename is mango-turbine-4417, and its shipping checklist is pinned (</workspace/memory/soak-brain/standing.md:2|standing.md:2>)",
  ),
  "We decided that metrics-export's release codename is mango-turbine-4417, and its shipping checklist is pinned (soak-brain/standing.md:2)",
  "step 7's bare Slack pseudo-link unwraps to the silo-relative path, in plain text, no <|> markup left",
);

eq(
  truncateMemoryCitationPaths(
    "The settled codename is mango-turbine-4417 — it's recorded in <file:///workspace/memory/soak-brain/standing.md#L2|standing.md:2>",
  ),
  "The settled codename is mango-turbine-4417 — it's recorded in soak-brain/standing.md#L2",
  "step 24's file://-scheme Slack pseudo-link unwraps to the silo-relative path, line anchor kept verbatim",
);

eq(
  truncateMemoryCitationPaths(
    "The settled codename is **`mango-turbine-4417`** — recorded as the non-secret codename for the `metrics-export` changelog in [`standing.md:2`](file:///workspace/memory/soak-brain/standing.md#L2).",
  ),
  "The settled codename is **`mango-turbine-4417`** — recorded as the non-secret codename for the `metrics-export` changelog in soak-brain/standing.md#L2.",
  "step 28's Markdown link (Notion's exact rendered form) unwraps to the silo-relative path, plain text, no [ ]( ) left",
);

eq(
  truncateMemoryCitationPaths("the export landed at file:///workspace/output/report.csv"),
  "the export landed at file:///workspace/output/report.csv",
  "NEGATIVE CONTROL: a non-memory file:// URL passes through byte-identical",
);

eq(
  truncateMemoryCitationPaths("see https://example.com/workspace/memory/notes for the public writeup"),
  "see https://example.com/workspace/memory/notes for the public writeup",
  "NEGATIVE CONTROL: an unrelated https URL containing the substring is untouched — the match is anchored, not a substring scan",
);

eq(
  truncateMemoryCitationPaths("see /workspace/memory/soak-brain/standing.md for the record"),
  "see soak-brain/standing.md for the record",
  "a bare, unwrapped memory-mount reference (no scheme, no link wrapper) truncates to the silo-relative path",
);

eq(truncateMemoryCitationPaths("Done."), "Done.", "text with no memory citation at all is untouched");

eq(
  truncateMemoryCitationPaths("logged in file:///workspace/memory/workspace/notes.md"),
  "logged in workspace/notes.md",
  "the shared workspace-tier mount truncates to its own silo-relative path the same way a named silo does",
);

console.log("2. postReply applies the truncation before dispatch, prefix, dedupe and audit:");

const captured: Array<{ text: string }> = [];
const testArm: PostArm = {
  platform: "oe-test-citation",
  dispatchReply: async (_target, text) => {
    captured.push({ text });
    return `citation-${captured.length}`;
  },
  dispatchUnified: async (_origin, text) => {
    captured.push({ text });
    return `citation-u-${captured.length}`;
  },
  editMessage: async (_locus, _messageId, text) => {
    captured.push({ text });
  },
};
registerPostArm(testArm);

const audit = (org: string): ReplyAudit => ({ org, platform: "oe-test", workspace: "W1", route: "tool" });
const dirty = "recorded in [`standing.md:2`](file:///workspace/memory/soak-brain/standing.md#L2).";
const clean = "recorded in soak-brain/standing.md#L2.";

{
  captured.length = 0;
  const target: ReplyTarget = { platform: "oe-test-citation", channelId: "C1" } as unknown as ReplyTarget;
  const a = audit("citationpost1");
  const id = await postReply(target, dirty, a);
  ok(id.startsWith("citation-"), "postReply dispatched for real");
  eq(captured[0].text, clean, "the arm receives the TRUNCATED text, never the raw mount-prefixed citation");
  const rows = await readAudit({ org: "citationpost1", action: "reply.post" });
  eq((rows[0].detail as { chars?: number }).chars, clean.length, "the audited char count matches what was actually posted (post-truncation), not the raw model text");
}

console.log("3. postUnifiedReply applies the same truncation:");
{
  captured.length = 0;
  const origin = { platform: "oe-test-citation", channelId: "C1" } as unknown as UnifiedWakeOrigin;
  await postUnifiedReply(origin, dirty, {}, audit("citationunified1"));
  eq(captured[0].text, clean, "postUnifiedReply: the arm receives the truncated text");
}

console.log("4. editPostedMessage applies the same truncation:");
{
  captured.length = 0;
  const locus: EditLocus = { platform: "oe-test-citation", channelId: "C1" };
  await editPostedMessage(locus, "M1", dirty, audit("citationedit1"), { hasEventSeen: async () => true });
  eq(captured[0].text, clean, "editPostedMessage: the arm receives the truncated text");
}

console.log(`memory-citation-render-test: ${n} assertions passed`);

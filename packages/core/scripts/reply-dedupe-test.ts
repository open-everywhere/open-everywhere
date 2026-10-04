import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReplyTarget, ReplyAudit } from "../agent/channels/reply-post.js";
import { removeTempDir } from "./_temp-dir.js";

const dir = join(tmpdir(), `open-everywhere-reply-dedupe-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_EGRESS_SPOOF = "1";
delete process.env.VERCEL;

const { postReply, REPLY_DEDUPE_SKIPPED_ID } = await import("../agent/channels/reply-post.js");
const { postUnifiedReply } = await import("../agent/channels/unified-reply.js");
const { readAudit } = await import("../agent/audit/audit.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const audit = (org: string): ReplyAudit => ({
  org,
  platform: "slack",
  workspace: "T1",
  route: "tool",
});

const isSpoofId = (id: string) => id.startsWith("spoof-");

{
  const target: ReplyTarget = { platform: "slack", channelId: "C1" };
  const first = await postReply(target, "Saved: hello", audit("acme1"));
  const second = await postReply(target, "Saved: hello", audit("acme1"));
  ok(isSpoofId(first), "1a. first postReply call dispatches for real (spoof id)");
  ok(second === REPLY_DEDUPE_SKIPPED_ID, "1b. byte-identical repost within the TTL is suppressed (sentinel id, no second dispatch)");
}

{
  const target: ReplyTarget = { platform: "slack", channelId: "C2" };
  const a = await postReply(target, "message A", audit("acme2"));
  const b = await postReply(target, "message B", audit("acme2"));
  const rows = await readAudit({ org: "acme2", action: "reply.post" });
  ok(isSpoofId(a) && isSpoofId(b) && rows.length === 2, "2. two genuinely-distinct messages to the same channel both dispatch (no false dedup)");
}

{
  const t1: ReplyTarget = { platform: "slack", channelId: "C3" };
  const t2: ReplyTarget = { platform: "slack", channelId: "C4" };
  const a = await postReply(t1, "same text", audit("acme3"));
  const b = await postReply(t2, "same text", audit("acme3"));
  const rows = await readAudit({ org: "acme3", action: "reply.post" });
  ok(isSpoofId(a) && isSpoofId(b) && rows.length === 2, "3. identical text to a different channel dispatches (channel discriminates the key)");
}

{
  const target: ReplyTarget = { platform: "slack", channelId: "C5" };
  await postReply(target, "audited once", audit("acme4"));
  await postReply(target, "audited once", audit("acme4"));
  const rows = await readAudit({ org: "acme4", action: "reply.post" });
  ok(rows.length === 1, "4. a suppressed repost writes exactly ONE reply.post audit row, not two");
}

{
  const origin = { platform: "teams" as const, serviceUrl: "https://smba.example.test", conversationId: "conv-1" };
  const first = await postUnifiedReply(origin, "Saved: fact", {}, audit("acme5"));
  const second = await postUnifiedReply(origin, "Saved: fact", {}, audit("acme5"));
  ok(isSpoofId(first), "5a. postUnifiedReply first call dispatches for real (spoof id)");
  ok(second === REPLY_DEDUPE_SKIPPED_ID, "5b. postUnifiedReply byte-identical repost within the TTL is suppressed");
}

{
  const target: ReplyTarget = { platform: "slack", channelId: "C-shared" };
  const origin = { platform: "slack" as const, channelId: "C-shared" };
  const a = await postReply(target, "cross-spine text", audit("acme6"));
  const b = await postUnifiedReply(origin, "cross-spine text", {}, audit("acme6"));
  const rows = await readAudit({ org: "acme6", action: "reply.post" });
  ok(isSpoofId(a) && isSpoofId(b) && rows.length === 2, "6. postReply and postUnifiedReply don't cross-suppress each other on the same channel string");
}

{
  const target: ReplyTarget = { platform: "slack", channelId: "C6" };
  const a = await postReply(target, "no audit", undefined);
  const b = await postReply(target, "no audit", undefined);
  ok(isSpoofId(a) && isSpoofId(b), "7. no audit/org supplied → fail-open (matches postOnce's own no-org fail-open contract)");
}

await removeTempDir(dir);
console.log(
  `✓ reply-dedupe (OPE-343) — ${n} assertions (byte-identical repost suppressed, distinct content/channel not over-deduped, one audit row per real post, per-spine key separation, fail-open with no org)`,
);

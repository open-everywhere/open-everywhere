import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-chat-post-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { readAudit } = await import("../agent/audit/audit.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { registerSurfaceMessageOps } = await import("../agent/channels/surface-message-ops.js");
type ChatPostArgs = import("../agent/approvals/chat-post.js").ChatPostArgs;
await import("../agent/approvals/flow.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const posts: { channelId: string; text: string }[] = [];
let landsMessageId: string | undefined = "M-1";
registerSurfaceMessageOps({
  platform: "test-chat-platform",
  postText: async (channelId, text) => {
    posts.push({ channelId, text });
    return landsMessageId as string;
  },
  editMessage: async () => {},
});

const THROWN_REASON = 'test-chat-platform-throws: refused — "C_NO_SCOPE" is missing the post scope for this bot token';
registerSurfaceMessageOps({
  platform: "test-chat-platform-throws",
  postText: async () => {
    throw new Error(THROWN_REASON);
  },
  editMessage: async () => {},
});

const GRANT = "test-chat-platform:channel/C_ELSEWHERE";
function args(over: Partial<ChatPostArgs> = {}): ChatPostArgs {
  return {
    org: "default",
    scopeKey: "slack/T1/C_HOME",
    platform: "test-chat-platform",
    container: "C_ELSEWHERE",
    grant: GRANT,
    text: "The release note body.",
    requestedBy: "U_PROPOSER",
    ...over,
  };
}

{
  const kind = actionKind("chat.post");
  ok(kind !== undefined, "chat.post is registered (flow.ts side-effect import)");
  ok(kind!.policy === "member", "chat.post is MEMBER policy — audience-expanding, same tier as ticket.create");
}

{
  const kind = actionKind("chat.post")!;
  const lines = kind.summarize(args());
  ok(lines[0].includes("C_ELSEWHERE"), "the card names the DESTINATION container");
  ok(lines[0].includes(GRANT), "the card names the GRANT that allows the post");
  ok(lines.some((l) => l.includes("The release note body.")), "the card renders the FULL body — it is the injection gate");
  ok(!lines.some((l) => l.includes("⚠")), "no taint banner on a clean proposal");
  const tainted = kind.summarize(args({ tainted: true }));
  ok(tainted.some((l) => l.includes("⚠") && l.includes("external content")), "a tainted proposal gets the reviewer-scrutiny banner");
}

{
  posts.length = 0;
  landsMessageId = "M-1";
  const kind = actionKind("chat.post")!;
  const outcome = await kind.execute(args(), "U_APPROVER");
  ok(outcome.startsWith("message posted in ") && !outcome.includes("container"), `execute() reports where it posted, in words (${outcome})`);
  ok(posts.length === 1, "the transport was called exactly once");
  ok(posts[0]!.channelId === "C_ELSEWHERE", "the post went to the FROZEN container, not to the asking room");
  ok(posts[0]!.text === "The release note body.", "the posted text is the frozen body, byte for byte");

  const audit = await readAudit({ org: "default", limit: 5 });
  const entry = audit.find((a) => a.action === "chat.post");
  ok(entry !== undefined, "the approved post writes a chat.post audit row");
  ok(entry!.principalId === "U_APPROVER", "the audit principal is the DECIDER (approver), not the proposer");
  const detail = entry!.detail as Record<string, unknown>;
  ok(detail.platform === "test-chat-platform", "the audit row names the destination platform");
  ok(detail.container === "C_ELSEWHERE", "🔴 the audit row NAMES THE TARGET CONTAINER");
  ok(detail.grant === GRANT, "🔴 the audit row NAMES THE GRANT that allowed the post");
  ok(detail.messageId === "M-1", "the audit row carries the created message id");
  ok(detail.requestedBy === "U_PROPOSER", "the audit row carries the proposer alongside the approver");
  ok(detail.tainted === false, "the audit row stamps tainted:false on a clean proposal");
}

{
  posts.length = 0;
  landsMessageId = undefined;
  const kind = actionKind("chat.post")!;
  let err: unknown;
  try {
    await kind.execute(args({ container: "C_NOT_A_MEMBER" }), "U_APPROVER2");
  } catch (e) {
    err = e;
  }
  ok(err !== undefined, "a transport that names no message id THROWS — the post is not reported as landed");
  ok(String((err as Error).message).includes("did not land"), "the failure says the post did not land");
  ok(String((err as Error).message).includes("C_NOT_A_MEMBER"), "the failure names the container it could not reach");
  const audit = await readAudit({ org: "default", limit: 5 });
  ok(
    audit.find((a) => a.action === "chat.post" && (a.detail as Record<string, unknown>).container === "C_NOT_A_MEMBER") === undefined,
    "a post that did not land writes NO chat.post audit row — the log never records a message nobody received",
  );
}

{
  const kind = actionKind("chat.post")!;
  let err: unknown;
  try {
    await kind.execute(args({ platform: "test-chat-platform-throws", container: "C_NO_SCOPE" }), "U_APPROVER3");
  } catch (e) {
    err = e;
  }
  ok(err !== undefined, "a transport that THROWS still fails the decision loudly");
  const message = String((err as Error).message);
  ok(message.includes(THROWN_REASON), `the failure carries the TRANSPORT'S OWN reason verbatim (got: ${message})`);
  ok(
    !message.includes("check the bot is a member of that container"),
    "the old GUESSED remedy is ABSENT once a real reason is available",
  );
  ok(!message.includes("token carries the post scope"), "the old guessed remedy's second half is also absent");
  const audit = await readAudit({ org: "default", limit: 5 });
  ok(
    audit.find((a) => a.action === "chat.post" && (a.detail as Record<string, unknown>).container === "C_NO_SCOPE") === undefined,
    "a post whose transport threw writes NO chat.post audit row",
  );
}

console.log(`chat-post-approval: ${n} assertions passed`);

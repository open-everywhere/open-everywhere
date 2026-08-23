import assert from "node:assert/strict";
import { platformFailureClass } from "@open-everywhere/core/agent/adapter-api.js";
import { registerBroker, resetBrokers, setRegisteredConnectorCredentials } from "@open-everywhere/core/agent/adapter-api.js";
import { createCommentReply, type FetchLike } from "../agent/channels/notion-api.js";
import { NOTION_CHANNEL_CREDENTIAL } from "../agent/channels/notion-credentials.js";
import { notionPostArm } from "../agent/channels/notion-post-arm.js";
import type { ReplyTarget, UnifiedWakeOrigin, EditLocus } from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const TOKEN = "ntn_test_token";
const DISCUSSION_ID = "d-825";

function armCredential(present: boolean): void {
  resetBrokers();
  if (!present) {
    setRegisteredConnectorCredentials([]);
    return;
  }
  registerBroker("test", { async getSecret() { return TOKEN; } });
  setRegisteredConnectorCredentials([
    {
      connector: "notion",
      allows: ["api-key"],
      credentials: [{ id: NOTION_CHANNEL_CREDENTIAL, type: "api-key", secretRef: "db:notion:channel-key", broker: "test", intake: false }],
    },
  ]);
}

{
  const stub = (status: number, body: unknown): FetchLike => (async () => new Response(JSON.stringify(body), { status })) as unknown as FetchLike;

  const id = await createCommentReply({ discussionId: DISCUSSION_ID, text: "hi", apiKey: TOKEN, fetch: stub(200, { id: "cmt-1" }) });
  ok(id === "cmt-1", "success control: a landed comment POST returns the real comment id");

  let definitiveErr: unknown;
  try {
    await createCommentReply({ discussionId: DISCUSSION_ID, text: "hi", apiKey: TOKEN, fetch: stub(403, { message: "restricted" }) });
  } catch (err) {
    definitiveErr = err;
  }
  ok((definitiveErr as { status?: unknown } | undefined)?.status === 403, "createCommentReply attaches the real numeric status (403) to its thrown error");
  ok(platformFailureClass(definitiveErr) === "definitive", "OPE-825: a 403 createCommentReply failure classifies DEFINITIVE");

  let ambiguousErr: unknown;
  try {
    await createCommentReply({ discussionId: DISCUSSION_ID, text: "hi", apiKey: TOKEN, fetch: stub(503, { message: "unavailable" }) });
  } catch (err) {
    ambiguousErr = err;
  }
  ok(platformFailureClass(ambiguousErr) === "ambiguous", "OPE-825: a 503 createCommentReply failure classifies AMBIGUOUS (fail-closed default)");
}

{
  const target: ReplyTarget = { platform: "notion", discussionId: DISCUSSION_ID };

  armCredential(false);
  let preflightErr: unknown;
  try {
    await notionPostArm.dispatchReply!(target, "hi");
  } catch (err) {
    preflightErr = err;
  }
  ok(preflightErr instanceof Error, "no Notion credential registered ⇒ dispatchNotionReply throws");
  ok(platformFailureClass(preflightErr) === "definitive", "OPE-825: the missing-credential pre-flight refusal classifies DEFINITIVE — nothing left this host");

  armCredential(true);
  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "restricted" }), { status: 403 })) as unknown as typeof fetch;
    let err: unknown;
    try {
      await notionPostArm.dispatchReply!(target, "hi");
    } catch (e) {
      err = e;
    }
    ok(platformFailureClass(err) === "definitive", "OPE-825: dispatchNotionReply propagates a 403 platform refusal as DEFINITIVE");

    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "unavailable" }), { status: 500 })) as unknown as typeof fetch;
    let err2: unknown;
    try {
      await notionPostArm.dispatchReply!(target, "hi");
    } catch (e) {
      err2 = e;
    }
    ok(platformFailureClass(err2) === "ambiguous", "OPE-825: dispatchNotionReply propagates a 500 platform failure as AMBIGUOUS");

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "cmt-2" }), { status: 200 })) as unknown as typeof fetch;
    const id = await notionPostArm.dispatchReply!(target, "hi");
    ok(id === "cmt-2", "success control: dispatchNotionReply returns the real comment id on a landed post");
  } finally {
    globalThis.fetch = savedFetch;
  }
}

{
  const origin = { platform: "notion", discussionId: DISCUSSION_ID } as Extract<UnifiedWakeOrigin, { platform: "notion" }>;

  armCredential(false);
  let preflightErr: unknown;
  try {
    await notionPostArm.dispatchUnified!(origin, "hi", {} as Parameters<NonNullable<typeof notionPostArm.dispatchUnified>>[2]);
  } catch (err) {
    preflightErr = err;
  }
  ok(platformFailureClass(preflightErr) === "definitive", "OPE-825: liveNotionPost's missing-credential pre-flight refusal classifies DEFINITIVE");

  armCredential(true);
  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "restricted" }), { status: 403 })) as unknown as typeof fetch;
    let err: unknown;
    try {
      await notionPostArm.dispatchUnified!(origin, "hi", {} as Parameters<NonNullable<typeof notionPostArm.dispatchUnified>>[2]);
    } catch (e) {
      err = e;
    }
    ok(err instanceof Error && /createCommentReply failed on discussion/.test((err as Error).message), "liveNotionPost re-wraps the error in its own token-free copy");
    ok(
      platformFailureClass(err) === "definitive",
      "OPE-825: carryFailureSignals keeps the 403 DEFINITIVE across liveNotionPost's re-wrap — without it this would silently read AMBIGUOUS",
    );

    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "unavailable" }), { status: 500 })) as unknown as typeof fetch;
    let err2: unknown;
    try {
      await notionPostArm.dispatchUnified!(origin, "hi", {} as Parameters<NonNullable<typeof notionPostArm.dispatchUnified>>[2]);
    } catch (e) {
      err2 = e;
    }
    ok(platformFailureClass(err2) === "ambiguous", "OPE-825: a 500 stays AMBIGUOUS across liveNotionPost's re-wrap (negative control)");

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "cmt-3" }), { status: 200 })) as unknown as typeof fetch;
    const id = await notionPostArm.dispatchUnified!(origin, "hi", {} as Parameters<NonNullable<typeof notionPostArm.dispatchUnified>>[2]);
    ok(id === "cmt-3", "success control: liveNotionPost returns the real comment id on a landed post");
  } finally {
    globalThis.fetch = savedFetch;
  }
}

{
  const WORKSPACE = "ws-1046";
  const PAGE = "pg-1046";
  const locus: EditLocus = { platform: "notion", channelId: `${WORKSPACE}/${PAGE}` };

  armCredential(true);
  let malformedErr: unknown;
  try {
    await notionPostArm.editMessage!({ platform: "notion", channelId: "not-a-conversation-key" }, "cmt-x", "corrected");
  } catch (err) {
    malformedErr = err;
  }
  ok(malformedErr instanceof Error, "OPE-1046: a malformed edit locus (no workspace/page split) throws");
  ok(platformFailureClass(malformedErr) === "definitive", "OPE-1046: the malformed-locus refusal classifies DEFINITIVE — nothing left this host");

  armCredential(false);
  let preflightErr: unknown;
  try {
    await notionPostArm.editMessage!(locus, "cmt-1", "corrected");
  } catch (err) {
    preflightErr = err;
  }
  ok(preflightErr instanceof Error, "OPE-1046: no Notion credential registered ⇒ liveNotionEditComment throws");
  ok(platformFailureClass(preflightErr) === "definitive", "OPE-1046: the missing-credential pre-flight refusal classifies DEFINITIVE");

  armCredential(true);
  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "not found" }), { status: 404 })) as unknown as typeof fetch;
    let wrongAuthorErr: unknown;
    try {
      await notionPostArm.editMessage!(locus, "cmt-not-ours", "corrected");
    } catch (e) {
      wrongAuthorErr = e;
    }
    ok(
      wrongAuthorErr instanceof Error && /updateComment failed/.test((wrongAuthorErr as Error).message),
      "OPE-1046/WRONG-AUTHOR: liveNotionEditComment re-wraps a 404 (comment this connection didn't create) in its own token-free copy",
    );
    ok(
      platformFailureClass(wrongAuthorErr) === "definitive",
      "OPE-1046/WRONG-AUTHOR: carryFailureSignals keeps the 404 DEFINITIVE across the re-wrap — the model may retry with a fresh `reply`",
    );

    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "restricted" }), { status: 403 })) as unknown as typeof fetch;
    let forbiddenErr: unknown;
    try {
      await notionPostArm.editMessage!(locus, "cmt-2", "corrected");
    } catch (e) {
      forbiddenErr = e;
    }
    ok(platformFailureClass(forbiddenErr) === "definitive", "OPE-1046: a 403 (no insert-comment capability) classifies DEFINITIVE");

    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "unavailable" }), { status: 500 })) as unknown as typeof fetch;
    let ambiguousErr: unknown;
    try {
      await notionPostArm.editMessage!(locus, "cmt-3", "corrected");
    } catch (e) {
      ambiguousErr = e;
    }
    ok(platformFailureClass(ambiguousErr) === "ambiguous", "OPE-1046/CONTROL: a 500 stays AMBIGUOUS across the re-wrap — not every failure is DEFINITIVE");

    let sawPatchBody: unknown;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sawPatchBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    await notionPostArm.editMessage!(locus, "cmt-ours", "the corrected text");
    ok(true, "success control: liveNotionEditComment resolves cleanly on a landed PATCH");
    ok(
      Array.isArray((sawPatchBody as { rich_text?: unknown[] } | undefined)?.rich_text),
      "OPE-1046: the PATCH body carries `rich_text` chunks (richTextChunks), the exact shape `updateComment` sends",
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
}

assert.ok(passed > 0);
console.log(`✓ notion-post-arm: ${passed} assertions passed`);

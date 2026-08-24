import assert from "node:assert/strict";
import { surfaceMessageOps, registerBroker, resetBrokers, setRegisteredConnectorCredentials } from "@open-everywhere/core/agent/adapter-api.js";
import { registerNotionProvider } from "../agent/register.js";
import { notionMessageOps } from "../agent/channels/notion-message-ops.js";
import { NOTION_CHANNEL_CREDENTIAL } from "../agent/channels/notion-credentials.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const TOKEN = "ntn_test_token_1043";
const WORKSPACE = "ws-1043";
const PAGE = "page-1043";
const CHANNEL_ID = `${WORKSPACE}/${PAGE}`;
const FILE_BYTES = new TextEncoder().encode("fake-attachment-bytes");

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

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly rawBody?: unknown;
}

function stubNotionFetch(onCall: (call: Call) => Response): { calls: Call[] } {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const body = raw ? JSON.parse(raw) : undefined;
    const call: Call = { method: String(init?.method ?? "GET"), url, body, rawBody: init?.body };
    calls.push(call);
    return onCall(call);
  }) as unknown as typeof fetch;
  return { calls };
}

const savedFetch = globalThis.fetch;

try {
  {
    registerNotionProvider();
    const resolved = surfaceMessageOps("notion");
    ok(resolved !== undefined, "registerNotionProvider() makes surfaceMessageOps('notion') resolve to something (before OPE-1043 it resolved undefined)");
    ok(resolved === notionMessageOps, "…and it resolves to THIS module's ops object, by identity — the same one turn-anchor.ts's postSurfaceText dispatches to");
    ok(typeof resolved?.postText === "function" && typeof resolved?.editMessage === "function", "the resolved ops carry postText/editMessage");
    ok(typeof resolved?.postFiles === "function", "…and postFiles too (OPE-1047: the two-step upload flow is now wired)");
    ok(resolved?.setReaction === undefined, "…and NO setReaction (Notion has no reaction resource for comments)");
  }

  {
    armCredential(true);
    const { calls } = stubNotionFetch(() => new Response(JSON.stringify({ id: "cmt-fresh" }), { status: 200 }));
    const id = await notionMessageOps.postText(CHANNEL_ID, "Stood down — one step in, nothing had run yet.");
    ok(id === "cmt-fresh", "postText returns the created comment id");
    ok(calls.length === 1, "exactly one call — no probing fetch when there is no reply anchor");
    ok(calls[0]!.method === "POST" && calls[0]!.url === "https://api.notion.com/v1/comments", "POSTs to the comments endpoint");
    const parent = (calls[0]!.body as { parent?: { page_id?: string } }).parent;
    ok(parent?.page_id === PAGE, "targets a FRESH comment on the parsed page (parent.page_id), not a reply — the shape the stop acknowledgement uses");
    ok((calls[0]!.body as { discussion_id?: unknown }).discussion_id === undefined, "carries no discussion_id — this is not a reply");
    const richText = (calls[0]!.body as { rich_text?: Array<{ text?: { content?: string } }> }).rich_text;
    ok(richText?.[0]?.text?.content === "Stood down — one step in, nothing had run yet.", "carries the note text");
  }

  {
    armCredential(true);
    const { calls } = stubNotionFetch((call) => {
      if (call.method === "GET" && call.url === "https://api.notion.com/v1/comments/cmt-anchor") {
        return new Response(JSON.stringify({ id: "cmt-anchor", discussion_id: "disc-anchor" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "cmt-reply" }), { status: 200 });
    });
    const id = await notionMessageOps.postText(CHANNEL_ID, "the decision", { replyToMessageId: "cmt-anchor" });
    ok(id === "cmt-reply", "postText (threaded) returns the created reply's id");
    ok(calls.length === 2, "two calls: fetch the named comment, then post");
    ok(calls[0]!.method === "GET" && calls[0]!.url === "https://api.notion.com/v1/comments/cmt-anchor", "first fetches the named comment to learn its discussion");
    const postBody = calls[1]!.body as { discussion_id?: string; parent?: unknown };
    ok(postBody.discussion_id === "disc-anchor", "replies into the SAME discussion the named comment belongs to");
    ok(postBody.parent === undefined, "…not a fresh page comment — no parent field on a threaded reply");
  }

  {
    armCredential(true);
    const { calls } = stubNotionFetch((call) => {
      if (call.method === "GET") return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      return new Response(JSON.stringify({ id: "cmt-fallback" }), { status: 200 });
    });
    const id = await notionMessageOps.postText(CHANNEL_ID, "text", { replyToMessageId: "cmt-gone" });
    ok(id === "cmt-fallback", "an unresolvable reply anchor still returns a landed post's id — never a silent drop");
    const postCall = calls.find((c) => c.method === "POST");
    ok((postCall!.body as { parent?: { page_id?: string } }).parent?.page_id === PAGE, "falls back to a FRESH page comment when the named anchor can't be resolved");
  }

  {
    armCredential(true);
    const { calls } = stubNotionFetch(() => new Response("{}", { status: 200 }));
    let threw = false;
    let message = "";
    try {
      await notionMessageOps.postText("not-a-conversation-id", "text");
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    ok(threw, "postText: a malformed channelId (not <workspace>/<page>) refuses");
    ok(message.includes("not-a-conversation-id"), "…and names the bad id in the refusal");
    ok(calls.length === 0, "…and nothing left this host");
  }
  {
    armCredential(true);
    const { calls } = stubNotionFetch(() => new Response("{}", { status: 200 }));
    let threw = false;
    try {
      await notionMessageOps.editMessage("not-a-conversation-id", "cmt-1", "text");
    } catch {
      threw = true;
    }
    ok(threw, "editMessage: a malformed channelId refuses the same way postText's does");
    ok(calls.length === 0, "…and nothing left this host");
  }
  {
    armCredential(true);
    const { calls } = stubNotionFetch(() => new Response("{}", { status: 200 }));
    let threw = false;
    try {
      await notionMessageOps.postFiles!("not-a-conversation-id", [{ bytes: FILE_BYTES, filename: "a.png", contentType: "image/png" }], undefined);
    } catch {
      threw = true;
    }
    ok(threw, "postFiles: a malformed channelId refuses the same way postText's does");
    ok(calls.length === 0, "…and nothing left this host — no upload was attempted");
  }

  {
    armCredential(false);
    const { calls } = stubNotionFetch(() => new Response("{}", { status: 200 }));
    let threw = false;
    let message = "";
    try {
      await notionMessageOps.postText(CHANNEL_ID, "text");
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    ok(threw, "postText: no registered Notion credential ⇒ refuses");
    ok(message.includes("channel-key"), "…and names the credential id it looked for");
    ok(calls.length === 0, "…and nothing left this host");
  }
  {
    armCredential(false);
    const { calls } = stubNotionFetch(() => new Response("{}", { status: 200 }));
    let threw = false;
    try {
      await notionMessageOps.editMessage(CHANNEL_ID, "cmt-1", "text");
    } catch {
      threw = true;
    }
    ok(threw, "editMessage: no registered Notion credential ⇒ refuses");
    ok(calls.length === 0, "…and nothing left this host");
  }
  {
    armCredential(false);
    const { calls } = stubNotionFetch(() => new Response("{}", { status: 200 }));
    let threw = false;
    try {
      await notionMessageOps.postFiles!(CHANNEL_ID, [{ bytes: FILE_BYTES, filename: "a.png", contentType: "image/png" }], undefined);
    } catch {
      threw = true;
    }
    ok(threw, "postFiles: no registered Notion credential ⇒ refuses");
    ok(calls.length === 0, "…and nothing left this host — no upload was attempted");
  }

  {
    armCredential(true);
    const { calls } = stubNotionFetch(() => new Response("{}", { status: 200 }));
    await notionMessageOps.editMessage(CHANNEL_ID, "cmt-existing", "corrected text");
    ok(calls.length === 1, "exactly one call");
    ok(calls[0]!.method === "PATCH" && calls[0]!.url === "https://api.notion.com/v1/comments/cmt-existing", "PATCHes the given comment id");
    const richText = (calls[0]!.body as { rich_text?: Array<{ text?: { content?: string } }> }).rich_text;
    ok(richText?.[0]?.text?.content === "corrected text", "carries the new body");
  }

  {
    armCredential(true);
    let uploadCount = 0;
    const { calls } = stubNotionFetch((call) => {
      if (call.method === "POST" && call.url === "https://api.notion.com/v1/file_uploads") {
        uploadCount += 1;
        return new Response(JSON.stringify({ id: `up-${uploadCount}`, upload_url: `https://api.notion.com/v1/file_uploads/up-${uploadCount}/send` }), { status: 200 });
      }
      if (call.method === "POST" && call.url.endsWith("/send")) {
        return new Response(JSON.stringify({ status: "uploaded" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "cmt-files" }), { status: 200 });
    });
    const files = [
      { bytes: FILE_BYTES, filename: "shot.png", contentType: "image/png" },
      { bytes: FILE_BYTES, filename: "notes.txt", contentType: "text/plain" },
    ];
    const id = await notionMessageOps.postFiles!(CHANNEL_ID, files, "the files");
    ok(id === "cmt-files", "postFiles: returns the created comment id");
    ok(calls.filter((c) => c.url === "https://api.notion.com/v1/file_uploads").length === 2, "postFiles: creates one upload object PER file");
    ok(calls.filter((c) => c.url.endsWith("/send")).length === 2, "postFiles: sends bytes for EACH file");
    const uploadCall = calls.find((c) => c.url === "https://api.notion.com/v1/file_uploads");
    ok((uploadCall!.body as { filename?: string }).filename === "shot.png", "postFiles: the upload object carries the file's own filename");
    const sendCall = calls.find((c) => c.url.endsWith("/send"));
    ok(sendCall!.rawBody instanceof FormData, "postFiles: the send step's body is multipart/form-data");
    const commentCall = calls.find((c) => c.url === "https://api.notion.com/v1/comments");
    ok((commentCall!.body as { parent?: { page_id?: string } }).parent?.page_id === PAGE, "postFiles: lands ONE fresh comment on the parsed page");
    ok((commentCall!.body as { discussion_id?: unknown }).discussion_id === undefined, "postFiles: never a reply — always a fresh page comment (postFiles carries no reply anchor)");
    const attachments = (commentCall!.body as { attachments?: Array<{ file_upload_id: string; type: string }> }).attachments;
    ok(
      JSON.stringify(attachments) === JSON.stringify([{ file_upload_id: "up-1", type: "file_upload" }, { file_upload_id: "up-2", type: "file_upload" }]),
      "postFiles: attaches BOTH uploaded ids, in order",
    );
    const richText = (commentCall!.body as { rich_text?: Array<{ text?: { content?: string } }> }).rich_text;
    ok(richText?.[0]?.text?.content === "the files", "postFiles: the comment carries the given comment text");
  }
  {
    armCredential(true);
    const { calls } = stubNotionFetch((call) => {
      if (call.url === "https://api.notion.com/v1/file_uploads") return new Response(JSON.stringify({ id: "up-1", upload_url: "https://api.notion.com/v1/file_uploads/up-1/send" }), { status: 200 });
      if (call.url.endsWith("/send")) return new Response(JSON.stringify({ status: "uploaded" }), { status: 200 });
      return new Response(JSON.stringify({ id: "cmt-nocaption" }), { status: 200 });
    });
    await notionMessageOps.postFiles!(CHANNEL_ID, [{ bytes: FILE_BYTES, filename: "a.png", contentType: "image/png" }], undefined);
    const commentCall = calls.find((c) => c.url === "https://api.notion.com/v1/comments");
    const richText = (commentCall!.body as { rich_text?: Array<{ text?: { content?: string } }> }).rich_text;
    ok(richText?.[0]?.text?.content === "(no content)", "postFiles: no comment ⇒ falls back to richTextChunks' empty-content default rather than omitting rich_text");
  }
  {
    armCredential(true);
    const { calls } = stubNotionFetch(() => new Response(JSON.stringify({ id: "up-x", upload_url: "https://api.notion.com/v1/file_uploads/up-x/send" }), { status: 200 }));
    const tooMany = Array.from({ length: 4 }, (_, i) => ({ bytes: FILE_BYTES, filename: `f${i}.png`, contentType: "image/png" }));
    let threw = false;
    let message = "";
    try {
      await notionMessageOps.postFiles!(CHANNEL_ID, tooMany, undefined);
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    ok(threw, "postFiles: refuses a batch over the per-post cap");
    ok(message.includes("3") && message.includes("4"), "…and names the cap and the count in the refusal");
    ok(calls.length === 0, "…and refuses BEFORE any upload call — no bytes were spent on a batch it then discards");
  }
  {
    armCredential(true);
    let uploadCount = 0;
    const { calls } = stubNotionFetch((call) => {
      if (call.url === "https://api.notion.com/v1/file_uploads") {
        uploadCount += 1;
        if (uploadCount === 2) return new Response(JSON.stringify({ message: "server error" }), { status: 500 });
        return new Response(JSON.stringify({ id: `up-${uploadCount}`, upload_url: `https://api.notion.com/v1/file_uploads/up-${uploadCount}/send` }), { status: 200 });
      }
      if (call.url.endsWith("/send")) return new Response(JSON.stringify({ status: "uploaded" }), { status: 200 });
      return new Response(JSON.stringify({ id: "cmt-should-not-happen" }), { status: 200 });
    });
    const files = [
      { bytes: FILE_BYTES, filename: "one.png", contentType: "image/png" },
      { bytes: FILE_BYTES, filename: "two.png", contentType: "image/png" },
    ];
    let threw = false;
    try {
      await notionMessageOps.postFiles!(CHANNEL_ID, files, "two files");
    } catch {
      threw = true;
    }
    ok(threw, "postFiles: a failed upload propagates rather than posting a partial attach");
    ok(!calls.some((c) => c.url === "https://api.notion.com/v1/comments"), "…and the comment step never ran — no comment claims a file that never finished uploading");
  }
} finally {
  globalThis.fetch = savedFetch;
  resetBrokers();
}

console.log(`✓ ${n} notion-message-ops assertions passed`);

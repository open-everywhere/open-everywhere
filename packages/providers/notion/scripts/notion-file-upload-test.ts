import assert from "node:assert/strict";
import {
  createFileUpload,
  sendFileUploadBytes,
  uploadNotionFile,
  createPageComment,
  createCommentReply,
  NOTION_MAX_ATTACHMENTS,
  type FetchLike,
} from "../agent/channels/notion-api.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const TOKEN = "ntn_test_token_1047";
const FILE_BYTES = new TextEncoder().encode("fake-attachment-bytes");

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly rawBody: unknown;
}

function stubFetch(onCall: (call: Call) => Response): { calls: Call[]; fetch: FetchLike } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers as Record<string, string>) ?? {};
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const body = raw ? JSON.parse(raw) : undefined;
    const call: Call = { method: String(init?.method ?? "GET"), url, headers, body, rawBody: init?.body };
    calls.push(call);
    return onCall(call);
  }) as unknown as FetchLike;
  return { calls, fetch: fetchFn };
}

{
  const { calls, fetch } = stubFetch(() => new Response(JSON.stringify({ id: "up-1", upload_url: "https://api.notion.com/v1/file_uploads/up-1/send", status: "pending" }), { status: 200 }));
  const res = await createFileUpload({ filename: "shot.png", contentType: "image/png", apiKey: TOKEN, fetch });
  ok(res.id === "up-1" && res.uploadUrl === "https://api.notion.com/v1/file_uploads/up-1/send", "createFileUpload: returns {id, uploadUrl} from the response");
  ok(calls.length === 1 && calls[0]!.method === "POST" && calls[0]!.url === "https://api.notion.com/v1/file_uploads", "createFileUpload: POSTs to /v1/file_uploads");
  ok((calls[0]!.body as { filename?: string }).filename === "shot.png", "createFileUpload: body carries the filename");
  ok((calls[0]!.body as { content_type?: string }).content_type === "image/png", "createFileUpload: body carries content_type");
  ok(calls[0]!.headers["notion-version"] === "2026-03-11", "createFileUpload: pins Notion-Version 2026-03-11 — the file-upload surface's own required version");
  ok(calls[0]!.headers.authorization === `Bearer ${TOKEN}`, "createFileUpload: authorizes with the given apiKey");
}
{
  const { calls, fetch } = stubFetch(() => new Response(JSON.stringify({ id: "up-2", upload_url: "https://api.notion.com/v1/file_uploads/up-2/send" }), { status: 200 }));
  await createFileUpload({ filename: "x.png", contentType: "image/png", apiKey: TOKEN, version: "2022-06-28", fetch });
  ok(calls[0]!.headers["notion-version"] === "2026-03-11", "createFileUpload: ignores a caller-supplied opts.version — the file-upload surface pins its own");
}
{
  const { fetch } = stubFetch(() => new Response(JSON.stringify({ message: "restricted" }), { status: 403 }));
  await assert.rejects(() => createFileUpload({ filename: "x.png", contentType: "image/png", apiKey: TOKEN, fetch }), /createFileUpload failed: 403/, "createFileUpload: throws on non-2xx, naming the status");
  n++;
}
{
  const { fetch } = stubFetch(() => new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
  await assert.rejects(() => createFileUpload({ filename: "x.png", contentType: "image/png", apiKey: TOKEN, fetch }), /no usable id\/upload_url/, "createFileUpload: a 2xx response missing id/upload_url is refused, never silently accepted");
  n++;
}

{
  const UPLOAD_URL = "https://api.notion.com/v1/file_uploads/up-1/send";
  const { calls, fetch } = stubFetch(() => new Response(JSON.stringify({ id: "up-1", status: "uploaded" }), { status: 200 }));
  await sendFileUploadBytes({ uploadUrl: UPLOAD_URL, filename: "shot.png", contentType: "image/png", bytes: FILE_BYTES, apiKey: TOKEN, fetch });
  ok(calls.length === 1 && calls[0]!.method === "POST" && calls[0]!.url === UPLOAD_URL, "sendFileUploadBytes: POSTs to the given uploadUrl");
  ok(calls[0]!.rawBody instanceof FormData, "sendFileUploadBytes: body is multipart/form-data");
  ok(!("content-type" in calls[0]!.headers) && !("Content-Type" in calls[0]!.headers), "sendFileUploadBytes: no manual content-type header (fetch sets the multipart boundary)");
  ok(calls[0]!.headers["notion-version"] === "2026-03-11", "sendFileUploadBytes: pins Notion-Version 2026-03-11");
  ok(calls[0]!.headers.authorization === `Bearer ${TOKEN}`, "sendFileUploadBytes: authorizes with the given apiKey");
  const form = calls[0]!.rawBody as FormData;
  const filePart = form.get("file") as File | null;
  ok(filePart !== null && filePart.name === "shot.png" && filePart.type === "image/png", "sendFileUploadBytes: the 'file' field carries the filename + content type");
  const sentBytes = new Uint8Array(await filePart!.arrayBuffer());
  ok(sentBytes.length === FILE_BYTES.length && sentBytes.every((b, i) => b === FILE_BYTES[i]), "sendFileUploadBytes: the bytes that reach the wire are byte-identical to what was given");
}
{
  const { fetch } = stubFetch(() => new Response(JSON.stringify({ message: "too large" }), { status: 400 }));
  await assert.rejects(
    () => sendFileUploadBytes({ uploadUrl: "https://api.notion.com/v1/file_uploads/up-1/send", filename: "x.png", contentType: "image/png", bytes: FILE_BYTES, apiKey: TOKEN, fetch }),
    /sendFileUploadBytes failed: 400/,
    "sendFileUploadBytes: throws on non-2xx, naming the status",
  );
  n++;
}

{
  const { calls, fetch } = stubFetch((call) => {
    if (call.url === "https://api.notion.com/v1/file_uploads") {
      return new Response(JSON.stringify({ id: "up-orch", upload_url: "https://api.notion.com/v1/file_uploads/up-orch/send" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "up-orch", status: "uploaded" }), { status: 200 });
  });
  const id = await uploadNotionFile({ filename: "doc.pdf", contentType: "application/pdf", bytes: FILE_BYTES, apiKey: TOKEN, fetch });
  ok(id === "up-orch", "uploadNotionFile: returns the file_upload id");
  ok(calls.length === 2, "uploadNotionFile: exactly two calls — create, then send");
  ok(calls[0]!.url === "https://api.notion.com/v1/file_uploads", "uploadNotionFile: step 1 creates the upload object");
  ok(calls[1]!.url === "https://api.notion.com/v1/file_uploads/up-orch/send", "uploadNotionFile: step 2 sends to the id-scoped upload_url step 1 returned — never a guessed URL");
}
{
  const { calls, fetch } = stubFetch(() => new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 }));
  await assert.rejects(() => uploadNotionFile({ filename: "x.png", contentType: "image/png", bytes: FILE_BYTES, apiKey: TOKEN, fetch }), /createFileUpload failed: 401/, "uploadNotionFile: a step-1 failure propagates and stops before step 2");
  ok(calls.length === 1, "uploadNotionFile: …and only ONE call was made");
}

{
  const { calls, fetch } = stubFetch(() => new Response(JSON.stringify({ id: "cmt-att" }), { status: 200 }));
  const id = await createPageComment({ pageId: "page-1", text: "the files", attachments: ["up-a", "up-b"], apiKey: TOKEN, fetch });
  ok(id === "cmt-att", "createPageComment(attachments): returns the created comment id");
  ok(calls.length === 1 && calls[0]!.url === "https://api.notion.com/v1/comments", "createPageComment(attachments): POSTs to /v1/comments");
  const body = calls[0]!.body as { parent?: { page_id?: string }; attachments?: Array<{ file_upload_id: string; type: string }> };
  ok(body.parent?.page_id === "page-1", "createPageComment(attachments): still targets the given page");
  ok(
    JSON.stringify(body.attachments) === JSON.stringify([{ file_upload_id: "up-a", type: "file_upload" }, { file_upload_id: "up-b", type: "file_upload" }]),
    "createPageComment(attachments): attachments array matches the given ids, in order, with type:'file_upload'",
  );
  ok(calls[0]!.headers["notion-version"] === "2026-03-11", "createPageComment(attachments): bumps Notion-Version to 2026-03-11 when attachments are present");
}
{
  const { calls, fetch } = stubFetch(() => new Response(JSON.stringify({ id: "cmt-plain" }), { status: 200 }));
  await createPageComment({ pageId: "page-1", text: "no files here", apiKey: TOKEN, fetch });
  ok(!("attachments" in (calls[0]!.body as object)), "createPageComment (no attachments): body carries no attachments key");
  ok(calls[0]!.headers["notion-version"] === "2022-06-28", "createPageComment (no attachments): keeps the module's ordinary default version");
}
{
  const { calls, fetch } = stubFetch(() => new Response(JSON.stringify({ id: "cmt-reply-att" }), { status: 200 }));
  const id = await createCommentReply({ discussionId: "disc-1", text: "reply with files", attachments: ["up-c"], apiKey: TOKEN, fetch });
  ok(id === "cmt-reply-att", "createCommentReply(attachments): returns the created reply's id");
  const body = calls[0]!.body as { discussion_id?: string; attachments?: Array<{ file_upload_id: string }> };
  ok(body.discussion_id === "disc-1", "createCommentReply(attachments): still targets the given discussion");
  ok(JSON.stringify(body.attachments) === JSON.stringify([{ file_upload_id: "up-c", type: "file_upload" }]), "createCommentReply(attachments): attachments array carries the given id");
}

ok(NOTION_MAX_ATTACHMENTS === 3, "NOTION_MAX_ATTACHMENTS is 3 — Notion's own documented per-comment cap");
{
  const { calls, fetch } = stubFetch(() => new Response(JSON.stringify({ id: "cmt-cap" }), { status: 200 }));
  const overCap = ["up-1", "up-2", "up-3", "up-4"];
  await assert.rejects(
    () => createPageComment({ pageId: "page-1", text: "too many", attachments: overCap, apiKey: TOKEN, fetch }),
    /at most 3 attachments; got 4/,
    "createPageComment: refuses a batch over NOTION_MAX_ATTACHMENTS",
  );
  ok(calls.length === 0, "…and refuses BEFORE any byte left this host — no fetch call was made");
  const atCap = ["up-1", "up-2", "up-3"];
  const id = await createPageComment({ pageId: "page-1", text: "exactly three", attachments: atCap, apiKey: TOKEN, fetch });
  ok(id === "cmt-cap", "…while exactly NOTION_MAX_ATTACHMENTS succeeds (negative control on the cap boundary)");
}
{
  const { calls, fetch } = stubFetch(() => new Response(JSON.stringify({ id: "cmt-cap-reply" }), { status: 200 }));
  await assert.rejects(
    () => createCommentReply({ discussionId: "disc-1", text: "too many", attachments: ["up-1", "up-2", "up-3", "up-4"], apiKey: TOKEN, fetch }),
    /at most 3 attachments; got 4/,
    "createCommentReply: refuses a batch over NOTION_MAX_ATTACHMENTS the same way createPageComment does",
  );
  ok(calls.length === 0, "…and refuses BEFORE any byte left this host");
}

console.log(`✓ ${n} notion-file-upload assertions passed`);

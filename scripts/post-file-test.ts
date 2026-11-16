import assert from "node:assert/strict";
import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
__regDiscord();
import { registerNotionProvider as __regNotion } from "@open-everywhere/provider-notion/agent/register.js";
import { buildNotionAuth } from "@open-everywhere/provider-notion/agent/channels/notion-identity.js";
import { NOTION_CHANNEL_CREDENTIAL } from "@open-everywhere/provider-notion/agent/channels/notion-credentials.js";
import { registerBroker as __registerNotionBroker, setRegisteredConnectorCredentials as __setNotionCredentials } from "@open-everywhere/core/agent/adapter-api.js";
import { routineFireAttributes } from "@open-everywhere/core/agent/routines/fire-auth.js";
import type { Routine } from "@open-everywhere/core/agent/routines/routine.js";
__regNotion();
__registerNotionBroker("test", { async getSecret() { return "ntn_test_token_post_file"; } });
__setNotionCredentials([
  {
    connector: "notion",
    allows: ["api-key"],
    credentials: [{ id: NOTION_CHANNEL_CREDENTIAL, type: "api-key", secretRef: "db:notion:channel-key", broker: "test", intake: false }],
  },
]);
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const dir = join(tmpdir(), `open-everywhere-post-file-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

const { registerSlackTestBridge, registerSlackFixtureMapper, registerSlackFixtureManifest } = await import("../packages/core/scripts/_slack-test-stubs.js");
registerSlackTestBridge();
registerSlackFixtureMapper();
registerSlackFixtureManifest();
process.env.DISCORD_BOT_TOKEN = "test-bot-token";

const { resolveWindowGated } = await import("@open-everywhere/core/agent/access/window-gated.js");
const postFile = (await resolveWindowGated((await import("@open-everywhere/core/agent/tools/post_file.js")).default, { channel: { kind: "slack" }, session: { auth: { current: { attributes: { oe_grain: "task" } } } } } as never)) as unknown as {
  readonly description: string;
  readonly inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  readonly execute: (input: unknown, ctx: unknown) => Promise<{ posted: boolean; count: number; platform: string }>;
};
const { inferContentType, postFileDescription } = await import("@open-everywhere/core/agent/tools/post_file.js");
const { readAudit } = await import("@open-everywhere/core/agent/audit/audit.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const { defineBundle, defineBinding } = await import("@open-everywhere/core/agent/access/bundle.js");

const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
async function pendingCards(): Promise<number> {
  return ((await getOperationalStore().listPendingActions("default")) as unknown as unknown[]).length;
}

registerConfig({
  loadBundles: () => [defineBundle({ name: "org-default", instructions: "test" })],
  loadBindings: () => [defineBinding({ bundle: "org-default", scope: { level: "org" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

ok(postFile.inputSchema.safeParse({ files: [{ source: { path: "shot.png" }, filename: "shot.png" }] }).success, "sandbox path source accepted");
ok(!postFile.inputSchema.safeParse({ files: [] }).success, "empty files array rejected (min 1)");
ok(!postFile.inputSchema.safeParse({ files: [{ source: { path: "a.png" } }] }).success, "file missing filename rejected");
ok(!postFile.inputSchema.safeParse({ files: [{ source: { base64: "eA==" }, filename: "a.png" }] }).success, "base64 source shape REJECTED (removed — sandbox path only)");
ok(!postFile.inputSchema.safeParse({ files: [{ source: { url: "https://x/y.png" }, filename: "y.png" }] }).success, "url source shape REJECTED (removed — sandbox path only, no server-side remote fetch)");
ok(!postFile.inputSchema.safeParse({ files: [{ source: { nope: "x" }, filename: "a.png" }] }).success, "unknown source shape rejected");
ok(!postFile.inputSchema.safeParse({ files: Array.from({ length: 11 }, () => ({ source: { path: "a.png" }, filename: "a.png" })) }).success, "over-10 files rejected (max cap)");

ok(inferContentType("shot.png") === "image/png", "inferContentType: .png → image/png");
ok(inferContentType("photo.JPEG") === "image/jpeg", "inferContentType: case-insensitive extension");
ok(inferContentType("report.pdf") === "application/pdf", "inferContentType: .pdf → application/pdf");
ok(inferContentType("page.html") === "text/html", "inferContentType: .html → text/html");
ok(inferContentType("mystery") === "application/octet-stream", "inferContentType: no extension → octet-stream");
ok(inferContentType("weird.zzz") === "application/octet-stream", "inferContentType: unknown extension → octet-stream");

const eveResolvePath = (p: string) => (p.startsWith("/") ? p : `/workspace/${p}`);
const FILE_BYTES = new TextEncoder().encode("fake-file-bytes");
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function withSandbox<T extends Record<string, unknown>>(ctx: T, opts: { missing?: readonly string[]; oversize?: readonly string[] } = {}): T {
  const missing = new Set((opts.missing ?? []).map(eveResolvePath));
  const oversize = new Set((opts.oversize ?? []).map(eveResolvePath));
  return {
    ...ctx,
    getSandbox: async () => ({
      resolvePath: eveResolvePath,
      readBinaryFile: async ({ path }: { path: string }) => {
        if (missing.has(path)) throw new Error(`ENOENT: no such file "${path}"`);
        if (oversize.has(path)) return new Uint8Array(MAX_FILE_BYTES + 1);
        return FILE_BYTES;
      },
    }),
  };
}
function slackCtx(threadTs?: string, sandbox?: { missing?: readonly string[]; oversize?: readonly string[] }) {
  const base = {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel", oe_grain: "task", ...(threadTs ? { thread_ts: threadTs } : {}) },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
  };
  return withSandbox(base, sandbox);
}
function discordCtx(sandbox?: { missing?: readonly string[]; oversize?: readonly string[] }) {
  const base = {
    channel: { kind: "discord" },
    session: {
      auth: {
        current: {
          attributes: { guild_id: "G1", channel_id: "D_CHAN", channel_type: "0", user_id: "U9", oe_grain: "task" },
          principalId: "U9",
          principalType: "discord-user",
        },
      },
    },
  };
  return withSandbox(base, sandbox);
}
const NOTION_WORKSPACE = "ws-post-file";
const NOTION_PAGE = "page-post-file";
function notionCtx(sandbox?: { missing?: readonly string[]; oversize?: readonly string[] }) {
  const auth = buildNotionAuth({ workspaceId: NOTION_WORKSPACE, pageId: NOTION_PAGE, discussionId: "disc-post-file" });
  const base = { channel: { kind: "notion" }, session: { auth: { current: { ...auth, attributes: { ...auth.attributes, oe_grain: "task" } } } } };
  return withSandbox(base, sandbox);
}
function platformCtx(kind: string, withSb = true) {
  const base = { channel: { kind }, session: { auth: { current: { attributes: { channel_id: "X1", oe_grain: "task" }, principalId: "U1" } } } };
  return withSb ? withSandbox(base) : base;
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly bodyIsFormData: boolean;
}
let calls: FetchCall[] = [];
const realFetch = globalThis.fetch;
const UPLOAD_URL = "https://files.slack.example/upload/AAA";
function fakeNet(): void {
  let notionUploadCount = 0;
  globalThis.fetch = (async (url: unknown, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const u = String(url);
    const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
    const body = init.body instanceof URLSearchParams ? init.body.toString() : isForm ? "[FormData]" : String(init.body ?? "");
    calls.push({ url: u, method: init.method ?? "GET", body, headers: init.headers ?? {}, bodyIsFormData: isForm });
    if (u.endsWith("/api/files.getUploadURLExternal")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, upload_url: UPLOAD_URL, file_id: "F1" }) } as Response;
    }
    if (u.endsWith("/api/files.completeUploadExternal")) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }
    if (u === UPLOAD_URL) return { ok: true, status: 200, text: async () => "OK" } as Response;
    if (u.endsWith("/api/chat.postMessage")) return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1700159720.000100" }) } as Response;
    if (u.includes("discord.com/api")) return { ok: true, status: 200, json: async () => ({ id: "M1" }) } as Response;
    if (u === "https://api.notion.com/v1/file_uploads") {
      notionUploadCount += 1;
      const id = `NUP${notionUploadCount}`;
      return { ok: true, status: 200, json: async () => ({ id, upload_url: `https://api.notion.com/v1/file_uploads/${id}/send` }) } as Response;
    }
    if (u.startsWith("https://api.notion.com/v1/file_uploads/") && u.endsWith("/send")) {
      return { ok: true, status: 200, json: async () => ({ status: "uploaded" }) } as Response;
    }
    if (u === "https://api.notion.com/v1/comments") {
      return { ok: true, status: 200, json: async () => ({ id: "cmt-notion-post-file" }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
  }) as typeof fetch;
}
const restoreFetch = () => {
  globalThis.fetch = realFetch;
};

await inSession(async () => {
  for (const surface of ["teams"]) {
    await assert.rejects(
      () => postFile.execute({ files: [{ source: { path: "a.png" }, filename: "a.png" }] }, platformCtx(surface)),
      /not supported on/,
      `post_file: fails loud on ${surface}`,
    );
  }
});

await inSession(async () => {
  await assert.rejects(
    () => postFile.execute({ files: [{ source: { path: "a.png" }, filename: "a.png" }] }, platformCtx("slack", false)),
    /no workspace is bound/,
    "post_file: no sandbox bound → fail-closed",
  );
  await assert.rejects(
    () => postFile.execute({ files: [{ source: { path: "missing.png" }, filename: "missing.png" }] }, slackCtx(undefined, { missing: ["missing.png"] })),
    /could not read the workspace file/,
    "post_file: missing sandbox file → fail-closed",
  );
  await assert.rejects(
    () => postFile.execute({ files: [{ source: { path: "big.bin" }, filename: "big.bin" }] }, slackCtx(undefined, { oversize: ["big.bin"] })),
    /too large/,
    "post_file: oversize sandbox file (>10 MB) → rejected",
  );
  await assert.rejects(
    () => postFile.execute({ files: [{ source: { path: "/etc/passwd" }, filename: "passwd" }] }, slackCtx()),
    /outside the workspace/,
    "post_file: an out-of-workspace path is rejected by lexical confinement",
  );
});

calls = [];
fakeNet();
try {
await inSession(async () => {
  const res = await postFile.execute(
    { files: [{ source: { path: "shot.png" }, filename: "shot.png", caption: "the screenshot" }], comment: "here you go" },
    slackCtx("111.222"),
  );
  ok(res.posted === true && res.count === 1 && res.platform === "slack", "post_file(slack): returns posted/count/platform");
  const getUrl = calls.find((c) => c.url.endsWith("/api/files.getUploadURLExternal"));
  ok(!!getUrl, "post_file(slack): calls files.getUploadURLExternal");
  const getParams = new URLSearchParams(getUrl!.body);
  ok(getParams.get("filename") === "shot.png" && Number(getParams.get("length")) > 0, "post_file(slack): sends filename + byte length");
  const put = calls.find((c) => c.url === UPLOAD_URL);
  ok(!!put && put.method === "POST", "post_file(slack): PUTs the bytes to the reserved upload URL");
  const complete = calls.find((c) => c.url.endsWith("/api/files.completeUploadExternal"));
  ok(!!complete, "post_file(slack): calls files.completeUploadExternal");
  const cp = new URLSearchParams(complete!.body);
  ok(cp.get("channel_id") === "C1" && cp.get("thread_ts") === "111.222", "post_file(slack): finalizes into the current channel + thread");
  ok(cp.get("initial_comment") === "here you go", "post_file(slack): the comment rides as initial_comment");
  const filesArg = JSON.parse(cp.get("files") ?? "[]") as Array<{ id: string; title: string }>;
  ok(filesArg.length === 1 && filesArg[0].id === "F1" && filesArg[0].title === "the screenshot", "post_file(slack): file id + caption→title in the finalize payload");

  const audit = await readAudit({ org: "default", action: "slack.post_file" });
  ok(audit.length === 1, "post_file(slack): audits exactly one slack.post_file row");
  ok(audit[0]?.detail?.count === 1 && Array.isArray(audit[0]?.detail?.filenames), "post_file(slack): audit row carries count + filenames");
});
} finally {
  restoreFetch();
}

calls = [];
fakeNet();
try {
await inSession(async () => {
  const res = await postFile.execute(
    { files: [{ source: { path: "shot.png" }, filename: "shot.png" }], comment: "look" },
    discordCtx(),
  );
  ok(res.posted === true && res.platform === "discord", "post_file(discord): returns posted/platform");
  const post = calls.find((c) => c.url.includes("discord.com/api"));
  ok(!!post && post.method === "POST", "post_file(discord): POSTs to the Discord create-message endpoint");
  ok(post!.url.endsWith("/channels/D_CHAN/messages"), "post_file(discord): targets the current channel");
  ok(post!.bodyIsFormData, "post_file(discord): body is multipart/form-data");
  ok((post!.headers.authorization ?? "").startsWith("Bot "), "post_file(discord): authorizes with the bot token");
  ok(!("content-type" in post!.headers) && !("Content-Type" in post!.headers), "post_file(discord): no manual content-type (fetch sets the multipart boundary)");

  const audit = await readAudit({ org: "default", action: "discord.post_file" });
  ok(audit.length === 1, "post_file(discord): audits exactly one discord.post_file row");
});
} finally {
  restoreFetch();
}

calls = [];
fakeNet();
try {
await inSession(async () => {
  const res = await postFile.execute(
    { files: [{ source: { path: "shot.png" }, filename: "shot.png" }, { source: { path: "notes.txt" }, filename: "notes.txt" }], comment: "the files" },
    notionCtx(),
  );
  ok(res.posted === true && res.count === 2 && res.platform === "notion", "post_file(notion): returns posted/count/platform");
  const uploads = calls.filter((c) => c.url === "https://api.notion.com/v1/file_uploads");
  ok(uploads.length === 2, "post_file(notion): creates one upload object PER file");
  const sends = calls.filter((c) => c.url.startsWith("https://api.notion.com/v1/file_uploads/") && c.url.endsWith("/send"));
  ok(sends.length === 2 && sends.every((c) => c.bodyIsFormData), "post_file(notion): sends each file's bytes as multipart/form-data");
  const comment = calls.find((c) => c.url === "https://api.notion.com/v1/comments");
  ok(!!comment && comment.method === "POST", "post_file(notion): lands a create-comment call");
  const commentBody = JSON.parse(comment!.body) as { parent?: { page_id?: string }; attachments?: Array<{ file_upload_id: string; type: string }>; rich_text?: Array<{ text?: { content?: string } }> };
  ok(commentBody.parent?.page_id === NOTION_PAGE, "post_file(notion): targets the current page");
  ok(
    JSON.stringify(commentBody.attachments) === JSON.stringify([{ file_upload_id: "NUP1", type: "file_upload" }, { file_upload_id: "NUP2", type: "file_upload" }]),
    "post_file(notion): attaches BOTH uploaded ids, in order",
  );
  ok(commentBody.rich_text?.[0]?.text?.content === "the files", "post_file(notion): the comment carries the given comment");
  ok(comment!.headers["notion-version"] === "2026-03-11", "post_file(notion): the attaching comment call pins Notion-Version 2026-03-11");

  const audit = await readAudit({ org: "default", action: "notion.post_file" });
  ok(audit.length === 1, "post_file(notion): audits exactly one notion.post_file row");
  ok(audit[0]?.detail?.count === 2 && Array.isArray(audit[0]?.detail?.filenames), "post_file(notion): audit row carries count + filenames");
});
} finally {
  restoreFetch();
}

calls = [];
fakeNet();
try {
await inSession(async () => {
  const tooMany = Array.from({ length: 4 }, (_, i) => ({ source: { path: `f${i}.png` }, filename: `f${i}.png` }));
  await assert.rejects(
    () => postFile.execute({ files: tooMany }, notionCtx()),
    /Notion accepts at most 3 files/,
    "post_file(notion): refuses a batch over Notion's per-post cap",
  );
  ok(!calls.some((c) => c.url === "https://api.notion.com/v1/file_uploads"), "post_file(notion): …and no upload was even attempted — refused before any byte was resolved/spent");
});
} finally {
  restoreFetch();
}

calls = [];
fakeNet();
try {
await inSession(async () => {
  const before = await pendingCards();
  const res = await postFile.execute(
    { files: [{ source: { path: "page.html" }, filename: "page.html" }], comment: "the page" },
    slackCtx("111.222"),
  );
  ok(res.posted === true && res.count === 1 && (res as { urls?: string[] }).urls === undefined, "post_file(html): attaches (no urls returned)");
  const getUrl = calls.find((c) => c.url.endsWith("/api/files.getUploadURLExternal"));
  ok(!!getUrl, "post_file(html): the .html is uploaded as a file (getUploadURLExternal called)");
  ok(new URLSearchParams(getUrl!.body).get("filename") === "page.html", "post_file(html): the attachment keeps the .html filename");
  ok(!calls.some((c) => c.url.endsWith("/api/chat.postMessage")), "post_file(html): no link message and no card is posted");
  ok((await pendingCards()) === before, "post_file(html): no approval card is proposed");
  const newest = (await readAudit({ org: "default", action: "slack.post_file" }))[0];
  ok(newest?.detail?.attached === 1 && newest?.detail?.hosted === undefined, "post_file(html): the audit row counts one attached file and no hosted count");

  const POST_FILE_ROUTINE: Routine = {
    id: "r-postfile",
    org: "default",
    surfaceKey: "slack/T0PF/C0PF",
    trigger: { kind: "cron", expr: "0 3 * * *" },
    prompt: "post the nightly report page",
    createdBy: "U0CREATOR",
    createdAt: "2026-09-03T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
  };
  const fireCtx = withSandbox(
    {
      channel: { kind: "slack" },
      session: { auth: { current: { attributes: { ...routineFireAttributes(POST_FILE_ROUTINE, { team_id: "T0PF", channel_id: "C0PF", channel_type: "channel" }, "channel", true), oe_grain: "task" } } } },
    },
    undefined,
  );
  calls = [];
  const fired = await postFile.execute({ files: [{ source: { path: "page.html" }, filename: "page.html" }] }, fireCtx);
  ok(fired.posted === true, "post_file(html, UNATTENDED FIRE): the page attaches — there is nothing to approve");
  ok(calls.some((c) => c.url.endsWith("/api/files.getUploadURLExternal")), "…and it is uploaded as a file");
});
} finally {
  restoreFetch();
}

{
  const d = postFileDescription();
  ok(d.includes("HTML page is attached as a downloadable file"), "description says an HTML page is attached as a file");
  ok(!/public URL|Blob|host|publish/i.test(d), "description never mentions hosting, Blob, a public URL or a publish");
  ok(d.includes("Do not rename it to `.txt`"), "description tells the model to keep the .html extension");
  ok((postFile as unknown as { description?: unknown }).description === d, "the mounted post_file tool carries that description");
  ok(d.startsWith("Post one or more FILES/artifacts"), "description keeps the lead text");
}

console.log(`\n✓ post_file: ${n} assertions passed (validation, content-type, sandbox-path resolution+guards, surface dispatch, HTML attach, audit)\n`);

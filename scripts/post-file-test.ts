import assert from "node:assert/strict";
import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
__regDiscord();
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
const postFile = (await resolveWindowGated((await import("@open-everywhere/core/agent/tools/post_file.js")).default, { channel: { kind: "slack", continuationToken: "cse_test_native" }, session: { auth: { current: { attributes: {} } } } } as never)) as unknown as {
  readonly description: string;
  readonly inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  readonly execute: (input: unknown, ctx: unknown) => Promise<{ posted: boolean; count: number; platform: string }>;
};
const { inferContentType } = await import("@open-everywhere/core/agent/tools/post_file.js");
const { readAudit } = await import("@open-everywhere/core/agent/audit/audit.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const { defineBundle, defineBinding } = await import("@open-everywhere/core/agent/access/bundle.js");
const { setBlobPutter, assertBlobUrl, hostHtmlArtifact } = await import("@open-everywhere/core/agent/blob/hosting.js");

const approvalOf = (postFile as unknown as { approval: (ctx: { toolInput: unknown }) => unknown }).approval;

function registerBlobConfig(enabled: boolean, publicPrefix?: string): void {
  registerConfig({
    loadBundles: () => [defineBundle({ name: "org-default", instructions: "test" })],
    loadBindings: () => [defineBinding({ bundle: "org-default", scope: { level: "org" } })],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadBlobHosting: () => ({ enabled, ...(publicPrefix ? { publicPrefix } : {}) }),
  });
}
registerBlobConfig(false);

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
          attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel", ...(threadTs ? { thread_ts: threadTs } : {}) },
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
          attributes: { guild_id: "G1", channel_id: "D_CHAN", channel_type: "0", user_id: "U9" },
          principalId: "U9",
          principalType: "discord-user",
        },
      },
    },
  };
  return withSandbox(base, sandbox);
}
function platformCtx(kind: string, withSb = true) {
  const base = { channel: { kind }, session: { auth: { current: { attributes: { channel_id: "X1" }, principalId: "U1" } } } };
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
    if (u.includes("discord.com/api")) return { ok: true, status: 200, json: async () => ({ id: "M1" }) } as Response;
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

ok(assertBlobUrl("https://abc.public.blob.vercel-storage.com/x.html").hostname.endsWith(".blob.vercel-storage.com"), "assertBlobUrl: a real Blob host is allowed");
const rejectsBlob = (u: string, label: string) => {
  let threw = false;
  try {
    assertBlobUrl(u);
  } catch {
    threw = true;
  }
  ok(threw, label);
};
rejectsBlob("http://abc.public.blob.vercel-storage.com/x.html", "assertBlobUrl: non-https Blob URL rejected");
rejectsBlob("https://evil.example.com/x.html", "assertBlobUrl: off-host (non-Blob) URL rejected");
rejectsBlob("https://blob.vercel-storage.com.evil.com/x", "assertBlobUrl: look-alike suffix host rejected");

setBlobPutter(async () => ({ url: "https://evil.example.com/leaked.html" }));
await assert.rejects(
  () => hostHtmlArtifact({ bytes: new Uint8Array([1]), filename: "p.html", contentType: "text/html" }),
  /non-Blob URL/,
  "hostHtmlArtifact: rejects a non-Blob URL returned by the putter",
);
setBlobPutter(undefined);

calls = [];
fakeNet();
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
restoreFetch();

calls = [];
fakeNet();
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
restoreFetch();

calls = [];
registerBlobConfig(false);
setBlobPutter(async () => {
  throw new Error("blob putter must NOT be called when the org has not opted in");
});
fakeNet();
await inSession(async () => {
  const res = await postFile.execute(
    { files: [{ source: { path: "page.html" }, filename: "page.html" }], comment: "the page" },
    slackCtx("111.222"),
  );
  ok(res.posted === true && (res as { urls?: string[] }).urls === undefined, "post_file(html, opt-out): attaches (no hosted urls returned)");
  const getUrl = calls.find((c) => c.url.endsWith("/api/files.getUploadURLExternal"));
  ok(!!getUrl, "post_file(html, opt-out): the .html is uploaded as a file (getUploadURLExternal called)");
  ok(new URLSearchParams(getUrl!.body).get("filename") === "page.html", "post_file(html, opt-out): the attachment keeps the .html filename");
  ok(!calls.some((c) => c.url.endsWith("/api/chat.postMessage")), "post_file(html, opt-out): no link message posted (nothing hosted)");
  ok(approvalOf({ toolInput: { files: [{ source: { path: "page.html" }, filename: "page.html" }] } }) === "not-applicable", "approval(html, opt-out): not-applicable (attach path is ungated)");
});
restoreFetch();
setBlobPutter(undefined);

calls = [];
registerBlobConfig(true);
let putArgs: { pathname: string; contentType: string; byteLen: number } | undefined;
const BLOB_URL = "https://store123.public.blob.vercel-storage.com/public-artifacts/page-abc123.html";
setBlobPutter(async (args: { pathname: string; body: Uint8Array; contentType: string }) => {
  putArgs = { pathname: args.pathname, contentType: args.contentType, byteLen: args.body.byteLength };
  return { url: BLOB_URL };
});
fakeNet();
await inSession(async () => {
  const res = await postFile.execute(
    { files: [{ source: { path: "page.html" }, filename: "page.html" }], comment: "rendered page" },
    slackCtx("111.222"),
  );
  ok(res.posted === true && JSON.stringify((res as { urls?: string[] }).urls) === JSON.stringify([BLOB_URL]), "post_file(html, opt-in): returns the hosted Blob URL");
  ok(!!putArgs && putArgs.pathname.startsWith("public-artifacts/") && putArgs.contentType === "text/html", "post_file(html, opt-in): writes under the reserved public prefix with text/html");
  ok(!calls.some((c) => c.url.endsWith("/api/files.getUploadURLExternal")), "post_file(html, opt-in): the HTML is NOT raw-uploaded as a file");
  const msg = calls.find((c) => c.url.endsWith("/api/chat.postMessage"));
  ok(!!msg, "post_file(html, opt-in): posts a text message with the URL");
  const text = new URLSearchParams(msg!.body).get("text") ?? "";
  ok(text.includes(BLOB_URL) && text.includes("rendered page"), "post_file(html, opt-in): the message carries the Blob URL + the comment");
  ok(new URLSearchParams(msg!.body).get("thread_ts") === "111.222", "post_file(html, opt-in): the link posts into the current thread");
  ok(approvalOf({ toolInput: { files: [{ source: { path: "page.html" }, filename: "page.html" }] } }) === "user-approval", "approval(html, opt-in): user-approval (the public Blob write is gated)");
  ok(approvalOf({ toolInput: { files: [{ source: { path: "shot.png" }, filename: "shot.png" }] } }) === "not-applicable", "approval(image, opt-in): not-applicable (only the public HTML publish is gated)");
  const newest = (await readAudit({ org: "default", action: "slack.post_file" }))[0];
  ok(newest?.detail?.hosted === 1 && newest?.detail?.attached === 0, "post_file(html, opt-in): audit row records hosted=1, attached=0");
});
restoreFetch();
setBlobPutter(undefined);

calls = [];
registerBlobConfig(true);
setBlobPutter(async () => {
  throw new Error("blob store exploded");
});
fakeNet();
await inSession(async () => {
  await assert.rejects(
    () => postFile.execute({ files: [{ source: { path: "page.html" }, filename: "page.html" }] }, slackCtx("111.222")),
    /blob store exploded/,
    "post_file(html, opt-in, write fails): fails loud (no silent attach fallback)",
  );
  ok(!calls.some((c) => c.url.endsWith("/api/files.getUploadURLExternal")), "post_file(html, opt-in, write fails): did not silently fall back to a raw upload");
});
restoreFetch();
setBlobPutter(undefined);
registerBlobConfig(false);

console.log(`\n✓ post_file: ${n} assertions passed (validation, content-type, sandbox-path resolution+guards, surface dispatch, blob-hosting opt-in, audit)\n`);

import assert from "node:assert/strict";
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
process.env.DISCORD_BOT_TOKEN = "test-bot-token";

const postFile = (await import("../agent/tools/post_file.js")).default as unknown as {
  readonly description: string;
  readonly inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  readonly execute: (input: unknown, ctx: unknown) => Promise<{ posted: boolean; count: number; platform: string }>;
};
const { inferContentType, assertSafeFetchUrl } = await import("../agent/tools/post_file.js");
const { readAudit } = await import("../agent/audit/audit.js");

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

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

ok(postFile.inputSchema.safeParse({ files: [{ source: { base64: PNG_B64 }, filename: "shot.png" }] }).success, "valid base64 file accepted");
ok(postFile.inputSchema.safeParse({ files: [{ source: { path: "/tmp/a.png" }, filename: "a.png" }] }).success, "path source accepted");
ok(postFile.inputSchema.safeParse({ files: [{ source: { url: "https://x/y.png" }, filename: "y.png" }] }).success, "url source accepted");
ok(!postFile.inputSchema.safeParse({ files: [] }).success, "empty files array rejected (min 1)");
ok(!postFile.inputSchema.safeParse({ files: [{ source: { base64: PNG_B64 } }] }).success, "file missing filename rejected");
ok(!postFile.inputSchema.safeParse({ files: [{ source: { nope: "x" }, filename: "a.png" }] }).success, "unknown source shape rejected");
ok(!postFile.inputSchema.safeParse({ files: Array.from({ length: 11 }, () => ({ source: { base64: PNG_B64 }, filename: "a.png" })) }).success, "over-10 files rejected (max cap)");

ok(inferContentType("shot.png") === "image/png", "inferContentType: .png → image/png");
ok(inferContentType("photo.JPEG") === "image/jpeg", "inferContentType: case-insensitive extension");
ok(inferContentType("report.pdf") === "application/pdf", "inferContentType: .pdf → application/pdf");
ok(inferContentType("page.html") === "text/html", "inferContentType: .html → text/html");
ok(inferContentType("mystery") === "application/octet-stream", "inferContentType: no extension → octet-stream");
ok(inferContentType("weird.zzz") === "application/octet-stream", "inferContentType: unknown extension → octet-stream");

ok(assertSafeFetchUrl("https://example.com/a.png").hostname === "example.com", "SSRF: a normal https host is allowed");
const rejects = (u: string, label: string) => {
  let threw = false;
  try {
    assertSafeFetchUrl(u);
  } catch {
    threw = true;
  }
  ok(threw, label);
};
rejects("ftp://example.com/x", "SSRF: non-http(s) scheme rejected");
rejects("http://localhost/x", "SSRF: localhost rejected");
rejects("http://127.0.0.1/x", "SSRF: loopback IP rejected");
rejects("http://10.1.2.3/x", "SSRF: private-A IP rejected");
rejects("http://192.168.0.1/x", "SSRF: private-C IP rejected");
rejects("http://172.16.5.5/x", "SSRF: private-B IP rejected");
rejects("http://169.254.169.254/latest/meta-data", "SSRF: cloud-metadata link-local IP rejected");
rejects("http://metadata.google.internal/x", "SSRF: GCP metadata host rejected");

function slackCtx(threadTs?: string) {
  return {
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
}
function discordCtx() {
  return {
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
}
function platformCtx(kind: string) {
  return { channel: { kind }, session: { auth: { current: { attributes: { channel_id: "X1" }, principalId: "U1" } } } };
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
  for (const surface of ["teams", "telegram"]) {
    await assert.rejects(
      () => postFile.execute({ files: [{ source: { base64: PNG_B64 }, filename: "a.png" }] }, platformCtx(surface)),
      /not supported on/,
      `post_file: fails loud on ${surface}`,
    );
  }
});

await inSession(async () => {
  await assert.rejects(
    () => postFile.execute({ files: [{ source: { base64: PNG_B64 }, filename: "page.html" }] }, slackCtx("111.222")),
    /not wired yet|must be hosted/,
    "post_file: an HTML artifact fails loud rather than raw-uploading",
  );
});

await inSession(async () => {
  await assert.rejects(
    () => postFile.execute({ files: [{ source: { url: "http://169.254.169.254/x" }, filename: "meta.png" }] }, slackCtx()),
    /internal\/loopback\/link-local/,
    "post_file: execute() blocks an SSRF fetch before posting",
  );
});

calls = [];
fakeNet();
await inSession(async () => {
  const res = await postFile.execute(
    { files: [{ source: { base64: PNG_B64 }, filename: "shot.png", caption: "the screenshot" }], comment: "here you go" },
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
    { files: [{ source: { base64: PNG_B64 }, filename: "shot.png" }], comment: "look" },
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

console.log(`\n✓ post_file: ${n} assertions passed (validation, content-type, SSRF, surface dispatch, audit)\n`);

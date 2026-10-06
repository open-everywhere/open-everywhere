import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "oe-post-file-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
delete process.env.OE_PLATFORM;

const { registerSlackTestBridge, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackTestBridge();
registerSlackFixtureMapper();

const { registerIdentityMapper } = await import("../agent/identity/binding.js");
const { registerSurfaceMessageOps } = await import("../agent/channels/surface-message-ops.js");
const { resolveWindowGated } = await import("../agent/access/window-gated.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { registerConfig } = await import("../agent/access/config.js");
const { setBlobPutter } = await import("../agent/blob/hosting.js");

import postFile from "../agent/tools/post_file.js";
import type { BindableContext } from "../agent/identity/binding.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

let discordPostFilesCalls: { channelId: string; count: number }[] = [];
let discordPostTextCalls: { channelId: string; text: string }[] = [];
let nextDiscordFilesId: string | undefined = "DFILE1";
let nextDiscordTextId = "DTEXT1";
registerSurfaceMessageOps({
  platform: "discord",
  async postText(channelId, text) {
    discordPostTextCalls.push({ channelId, text });
    return nextDiscordTextId;
  },
  async editMessage() {
    throw new Error("not exercised by this test");
  },
  async postFiles(channelId, files) {
    discordPostFilesCalls.push({ channelId, count: files.length });
    return nextDiscordFilesId;
  },
});
registerIdentityMapper("discord", (c) => {
  const a = (c.session?.auth?.current?.attributes ?? {}) as Record<string, string>;
  const channelId = a["channel_id"];
  return { workspace: a["guild_id"], surface: channelId, mode: "channel", visibility: "private", principalId: c.session?.auth?.current?.principalId, target: channelId ? { channelId } : undefined };
});

const FILE_BYTES = new Uint8Array([1, 2, 3, 4]);
const eveResolvePath = (p: string) => (p.startsWith("/") ? p : `/workspace/${p}`);
function withSandbox(ctx: Record<string, unknown>): BindableContext {
  return { ...ctx, getSandbox: async () => ({ resolvePath: eveResolvePath, readBinaryFile: async () => FILE_BYTES }) } as unknown as BindableContext;
}

function slackTaskCtx(channelId: string, threadTs?: string): BindableContext {
  return withSandbox({
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: { team_id: "T1", channel_id: channelId, channel_type: "channel", oe_grain: "task", ...(threadTs ? { thread_ts: threadTs } : {}) },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
  });
}

function discordTaskCtx(channelId: string): BindableContext {
  return withSandbox({
    channel: { kind: "discord" },
    session: {
      auth: { current: { attributes: { guild_id: "G1", channel_id: channelId, oe_grain: "task" }, principalId: "DU1", principalType: "discord-user" } },
    },
  });
}

interface ArmedPostFile {
  readonly execute: (
    input: { files: { source: { path: string }; filename: string; contentType?: string; caption?: string }[]; comment?: string },
    ctx: unknown,
  ) => Promise<{ posted: boolean; count: number; platform: string; urls?: string[] }>;
}
async function armed(ctx: BindableContext): Promise<ArmedPostFile> {
  const resolved = (await resolveWindowGated(postFile, ctx)) as ArmedPostFile | null;
  if (!resolved) throw new Error("post_file did not mount on a task-grain seat — test setup is wrong, not the fix");
  return resolved;
}

{
  discordPostFilesCalls = [];
  nextDiscordFilesId = "DFILE_ATTACH_1";
  const tool = await armed(discordTaskCtx("D_CH1"));
  const before = (await readAudit({ org: "default", action: "discord.post_file" })).length;
  const res = await tool.execute({ files: [{ source: { path: "shot.png" }, filename: "shot.png" }] }, discordTaskCtx("D_CH1"));
  ok(res.posted === true && res.count === 1 && res.platform === "discord", "post_file: a Discord image upload reports posted:true, count:1");
  ok(discordPostFilesCalls.length === 1 && discordPostFilesCalls[0]!.channelId === "D_CH1", "post_file: dispatches to the registered Discord postFiles op");
  const audit = await readAudit({ org: "default", action: "discord.post_file" });
  ok(audit.length === before + 1, "post_file: audits exactly one discord.post_file row");
  const row = audit[0]!;
  ok(row.detail?.id === "DFILE_ATTACH_1", "post_file: OPE-932 — the Discord attach row's detail.id is the message id the provider returned");
  ok(row.detail?.attached === 1 && row.detail?.hosted === 0, "post_file: attach/hosted counts unchanged by the fix");
}

{
  discordPostFilesCalls = [];
  nextDiscordFilesId = undefined;
  const tool = await armed(discordTaskCtx("D_CH2"));
  const res = await tool.execute({ files: [{ source: { path: "shot.png" }, filename: "shot.png" }] }, discordTaskCtx("D_CH2"));
  ok(res.posted === true, "post_file: still reports posted:true when the provider names no id (the upload itself did not fail)");
  const audit = await readAudit({ org: "default", action: "discord.post_file" });
  const row = audit[0]!;
  ok(!("id" in (row.detail ?? {})), "post_file: negative control — no id in the provider's response means NO detail.id, never a guessed one");
  nextDiscordFilesId = "DFILE_RESTORE";
}

{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.includes("files.getUploadURLExternal")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, upload_url: "https://upload.example/x", file_id: "F1" }) } as Response;
    }
    if (u === "https://upload.example/x") {
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    if (u.includes("files.completeUploadExternal")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, files: [{ id: "F1", title: "shot.png" }] }) } as Response;
    }
    void init;
    throw new Error(`post-file-audit-test: unexpected fetch to ${u}`);
  }) as typeof fetch;
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  try {
    const tool = await armed(slackTaskCtx("C1", "111.222"));
    const before = (await readAudit({ org: "default", action: "slack.post_file" })).length;
    const res = await tool.execute({ files: [{ source: { path: "shot.png" }, filename: "shot.png" }] }, slackTaskCtx("C1", "111.222"));
    ok(res.posted === true && res.platform === "slack", "post_file: a Slack image upload reports posted:true");
    const audit = await readAudit({ org: "default", action: "slack.post_file" });
    ok(audit.length === before + 1, "post_file: audits exactly one slack.post_file row");
    const row = audit[0]!;
    ok(!("id" in (row.detail ?? {})), "post_file: OPE-932 — Slack's attach response names no ts, so the row carries NO detail.id (named absence, not a guess)");
    ok(row.detail?.attached === 1, "post_file: attached count is still correct on the Slack leg");
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  const emptyDomains = { domainsForSurface: () => [] as readonly string[] };
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: emptyDomains.domainsForSurface,
    loadBlobHosting: () => ({ enabled: true }),
  });
  setBlobPutter(async () => ({ url: "https://store123.public-artifacts.blob.vercel-storage.com/page.html" }));

  await import("../agent/approvals/file-publish.js");
  const { actionKind } = await import("../agent/approvals/actions.js");
  const { freezePublishPage } = await import("../agent/approvals/file-publish.js");
  const page = freezePublishPage({ filename: "page.html", contentType: "text/html", bytes: new TextEncoder().encode("<p>x</p>") });
  const frozenFor = (platform: string, channel: string) => ({ org: "default", scopeKey: `${platform}/T1/${channel}`, platform, linkChannelId: channel, threadTs: null, pages: [page], requestedBy: "U1" });

  {
    discordPostTextCalls = [];
    nextDiscordTextId = "DLINK1";
    const before = (await readAudit({ org: "default", action: "discord.post_file" })).length;
    const outcome = await actionKind("file.publish")!.execute(frozenFor("discord", "D_CH3"), "U1");
    ok(outcome.includes("https://store123.public-artifacts.blob.vercel-storage.com/page.html"), "post_file: the approved HTML artifact hosts, and the outcome names the URL");
    ok(discordPostTextCalls.length === 1, "post_file: the hosted URL is posted as a Discord text message");
    const audit = await readAudit({ org: "default", action: "discord.post_file" });
    const row = audit[0]!;
    ok(audit.length === before + 1 && row.detail?.id === "DLINK1", "post_file: OPE-932 — the Discord LINK row's detail.id is the posted-link message id");
    ok(row.detail?.hosted === 1 && row.detail?.attached === 0, "post_file: hosted/attached counts reflect the link-only post");
  }

  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("chat.postMessage")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: "999.111" }) } as Response;
      }
      throw new Error(`post-file-audit-test: unexpected fetch to ${u}`);
    }) as typeof fetch;
    try {
      const before = (await readAudit({ org: "default", action: "slack.post_file" })).length;
      const outcome = await actionKind("file.publish")!.execute(frozenFor("slack", "C2"), "U1");
      ok(outcome.includes("the link is posted"), "post_file: Slack hosted HTML also posts its link");
      const audit = await readAudit({ org: "default", action: "slack.post_file" });
      const row = audit[0]!;
      ok(audit.length === before + 1 && row.detail?.id === "999.111", "post_file: OPE-932 — the Slack LINK row's detail.id is chat.postMessage's own ts, the SAME field the reply path reads (slack-post-arm.ts)");
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

console.log(`\n✓ post-file-audit: ${n} assertions passed (Discord attach id, Slack attach named-absence, hosted-link id on both surfaces, negative control)\n`);

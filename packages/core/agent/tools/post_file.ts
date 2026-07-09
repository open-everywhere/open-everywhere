import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { callSlackRead } from "../channels/slack-read.js";
import { auditToolAction } from "../audit/tool-action.js";

const EXT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  zip: "application/zip",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export function inferContentType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function isHtmlArtifact(contentType: string): boolean {
  return contentType === "text/html";
}

const PRIVATE_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^\[::1\]$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe80:/i,
  /^metadata\.google\.internal$/i,
];

export function assertSafeFetchUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`post_file: "${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`post_file: only http(s) URLs may be fetched — got "${url.protocol}".`);
  }
  const host = url.hostname;
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    throw new Error(`post_file: refusing to fetch an internal/loopback/link-local host ("${host}").`);
  }
  return url;
}

type FileSource = { readonly path: string } | { readonly url: string } | { readonly base64: string };

async function resolveBytes(source: FileSource): Promise<Uint8Array> {
  if ("base64" in source) {
    const comma = source.base64.indexOf(",");
    const body = source.base64.startsWith("data:") && comma >= 0 ? source.base64.slice(comma + 1) : source.base64;
    return new Uint8Array(Buffer.from(body, "base64"));
  }
  if ("url" in source) {
    const url = assertSafeFetchUrl(source.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`post_file: fetching "${source.url}" failed (HTTP ${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const { readFile } = await import("node:fs/promises");
  try {
    return new Uint8Array(await readFile(source.path));
  } catch (err) {
    throw new Error(`post_file: could not read the file at "${source.path}" — ${err instanceof Error ? err.message : String(err)}.`);
  }
}

interface ResolvedFile {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
  readonly caption?: string;
}

async function hostHtmlArtifact(_file: ResolvedFile): Promise<string> {
  throw new Error(
    "post_file: HTML artifacts must be hosted (Vercel Blob) and posted as a URL, not raw-uploaded — " +
      "that delivery path is not wired yet. Post a screenshot/PNG of the rendered page instead, or " +
      "share a link to an already-hosted URL. (See the hostHtmlArtifact seam in post_file.ts.)",
  );
}

async function postFilesToSlack(ctx: BindableContext, files: readonly ResolvedFile[], comment: string | undefined): Promise<void> {
  const binding = bindFrom(ctx);
  const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
  if (!channelId) {
    throw new Error("post_file: couldn't resolve this Slack channel's id — try again from a real channel or DM.");
  }
  const uploaded: Array<{ id: string; title: string }> = [];
  for (const file of files) {
    if (isHtmlArtifact(file.contentType)) {
      throw new Error("post_file: internal — HTML artifacts must route through hostHtmlArtifact, not Slack upload.");
    }
    const res = await callSlackRead("files.getUploadURLExternal", { filename: file.filename, length: file.bytes.byteLength });
    const uploadUrl = typeof res.upload_url === "string" ? res.upload_url : undefined;
    const fileId = typeof res.file_id === "string" ? res.file_id : undefined;
    if (!uploadUrl || !fileId) {
      throw new Error("post_file: Slack files.getUploadURLExternal did not return an upload URL / file id.");
    }
    const put = await fetch(uploadUrl, {
      method: "POST",
      headers: { "content-type": file.contentType },
      body: file.bytes,
    });
    if (!put.ok) throw new Error(`post_file: uploading "${file.filename}" to Slack failed (HTTP ${put.status}).`);
    uploaded.push({ id: fileId, title: file.caption ?? file.filename });
  }
  const complete: Record<string, string> = {
    files: JSON.stringify(uploaded),
    channel_id: channelId,
  };
  if (binding.threadTs) complete.thread_ts = binding.threadTs;
  if (comment) complete.initial_comment = comment;
  await callSlackRead("files.completeUploadExternal", complete);
}

async function postFilesToDiscord(ctx: BindableContext, files: readonly ResolvedFile[], comment: string | undefined): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("post_file: DISCORD_BOT_TOKEN is not set — the bot token is required to upload files to Discord.");
  }
  const binding = bindFrom(ctx);
  const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
  if (!channelId) {
    throw new Error("post_file: couldn't resolve this Discord channel's id — try again from a real channel or DM.");
  }
  const form = new FormData();
  const attachments = files.map((file, i) => ({ id: i, filename: file.filename, ...(file.caption ? { description: file.caption } : {}) }));
  form.append("payload_json", JSON.stringify({ ...(comment ? { content: comment } : {}), attachments }));
  files.forEach((file, i) => {
    const ab = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
    form.append(`files[${i}]`, new Blob([ab], { type: file.contentType }), file.filename);
  });
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${token}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`post_file: Discord create-message failed (HTTP ${res.status}) for channel ${channelId}.`);
  }
}

const MAX_FILES = 10;

export default defineTool({
  description:
    "Post one or more FILES/artifacts (screenshots, images, docs, data) to the current conversation " +
    "on this surface — the delivery channel for things a text reply can't carry. Give each file a " +
    "`source` (one of `{ path }` a local file, `{ url }` an http(s) URL, or `{ base64 }` inline " +
    "bytes) and a `filename`; `contentType` is inferred from the filename if omitted. Add an " +
    "optional `comment` to post alongside the files, and a per-file `caption`. Works on Slack and " +
    "Discord today; on other surfaces it returns a clear 'not supported here' error so you can fall " +
    "back to a text reply. HTML pages are not raw-uploaded — post a screenshot of the rendered page " +
    "instead.",
  inputSchema: z.object({
    files: z
      .array(
        z.object({
          source: z
            .union([
              z.object({ path: z.string().min(1) }).describe("A local filesystem path readable by the agent runtime."),
              z.object({ url: z.string().min(1) }).describe("An http(s) URL to fetch the file bytes from."),
              z.object({ base64: z.string().min(1) }).describe("Base64-encoded file bytes (optionally a data: URL)."),
            ])
            .describe("Where the file's bytes come from — exactly one of path / url / base64."),
          filename: z.string().min(1).describe("The name the file is posted under (its extension drives contentType inference)."),
          contentType: z.string().min(1).optional().describe("MIME type; inferred from the filename when omitted."),
          caption: z.string().min(1).optional().describe("Optional per-file caption/title."),
        }),
      )
      .min(1)
      .max(MAX_FILES)
      .describe("One or more files to post (max 10)."),
    comment: z.string().min(1).optional().describe("Optional text posted alongside the files."),
  }),
  outputSchema: z.object({ posted: z.boolean(), count: z.number(), platform: z.string() }),
  approval: never(),
  async execute(input, ctx) {
    const platform = bindFrom(ctx as BindableContext).platform;
    if (platform !== "slack" && platform !== "discord") {
      throw new Error(
        `post_file: file posting is not supported on "${platform}" yet (supported: Slack, Discord). ` +
          "Reply with text, or share a link to an already-hosted file instead.",
      );
    }

    const resolved: ResolvedFile[] = [];
    for (const f of input.files) {
      const contentType = f.contentType ?? inferContentType(f.filename);
      const bytes = await resolveBytes(f.source as FileSource);
      resolved.push({ bytes, filename: f.filename, contentType, caption: f.caption });
    }

    for (const file of resolved) {
      if (isHtmlArtifact(file.contentType)) await hostHtmlArtifact(file);
    }

    if (platform === "slack") {
      await postFilesToSlack(ctx as BindableContext, resolved, input.comment);
    } else {
      await postFilesToDiscord(ctx as BindableContext, resolved, input.comment);
    }

    await auditToolAction(ctx, `${platform}.post_file`, {
      count: resolved.length,
      filenames: resolved.map((f) => f.filename),
      hasComment: Boolean(input.comment),
    });
    return { posted: true, count: resolved.length, platform };
  },
});

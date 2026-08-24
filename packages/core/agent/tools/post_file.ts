import { defineTool } from "eve/tools";
import { windowGated } from "../access/window-gated.js";
import type { Approval } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { bridgeSlackReadCall } from "../channels/slack-bridge.js";
import { surfaceMessageOps } from "../channels/surface-message-ops.js";
import { auditToolAction } from "../audit/tool-action.js";
import { hostHtmlArtifact, resolveBlobHosting } from "../blob/hosting.js";
import { confineToWorkspacePath } from "./describe_image.js";
import { postOnce, outboundKey } from "../operational/post-once.js";
import { withDuplicateApprovalGuard } from "../access/approval-dedupe.js";
import { initiatorBoundResponsePolicy } from "../approvals/eve-response-policy.js";

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

interface SandboxHandle {
  resolvePath(p: string): string;
  readBinaryFile(a: { path: string }): PromiseLike<Uint8Array> | Uint8Array;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;

async function resolveBytes(path: string, ctx: BindableContext): Promise<Uint8Array> {
  const sandboxCtx = ctx as unknown as { getSandbox?: () => Promise<SandboxHandle> };
  if (typeof sandboxCtx.getSandbox !== "function") {
    throw new Error("post_file: no workspace is bound to this seat — a file can only be posted from a session with a sandbox.");
  }
  let sb: SandboxHandle;
  try {
    sb = await sandboxCtx.getSandbox();
  } catch (err) {
    throw new Error(`post_file: could not open the workspace to read "${path}" — ${err instanceof Error ? err.message : String(err)}.`);
  }
  const confined = confineToWorkspacePath(sb, path);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await Promise.resolve(sb.readBinaryFile({ path: confined })));
  } catch (err) {
    throw new Error(`post_file: could not read the workspace file at "${path}" — ${err instanceof Error ? err.message : String(err)}.`);
  }
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(`post_file: "${path}" is too large (${bytes.byteLength} bytes; max ${MAX_FILE_BYTES}).`);
  }
  return bytes;
}

interface ResolvedFile {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
  readonly caption?: string;
}

async function postTextToSlack(ctx: BindableContext, text: string): Promise<string | undefined> {
  const binding = bindFrom(ctx);
  const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
  if (!channelId) {
    throw new Error("post_file: couldn't resolve this Slack channel's id — try again from a real channel or DM.");
  }
  const body: Record<string, string> = { channel: channelId, text };
  if (binding.threadTs) body.thread_ts = binding.threadTs;
  const res = await bridgeSlackReadCall("chat.postMessage", body);
  return typeof res.ts === "string" ? res.ts : undefined;
}

async function postTextToDiscord(ctx: BindableContext, text: string): Promise<string | undefined> {
  const ops = surfaceMessageOps("discord");
  if (!ops) {
    throw new Error("post_file: Discord message transport is not registered — the @open-everywhere/provider-discord bundle isn't wired.");
  }
  const binding = bindFrom(ctx);
  const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
  if (!channelId) {
    throw new Error("post_file: couldn't resolve this Discord channel's id — try again from a real channel or DM.");
  }
  return await ops.postText(channelId, text);
}

async function postLinkToSurface(
  ctx: BindableContext,
  platform: string,
  urls: readonly string[],
  comment: string | undefined,
): Promise<string | undefined> {
  const text = [comment, ...urls].filter((s): s is string => Boolean(s)).join("\n");
  if (platform === "slack") return await postTextToSlack(ctx, text);
  if (platform === "discord") return await postTextToDiscord(ctx, text);
  return await postTextToNotion(ctx, text);
}

async function postFilesToSlack(ctx: BindableContext, files: readonly ResolvedFile[], comment: string | undefined): Promise<string | undefined> {
  const binding = bindFrom(ctx);
  const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
  if (!channelId) {
    throw new Error("post_file: couldn't resolve this Slack channel's id — try again from a real channel or DM.");
  }
  const uploaded: Array<{ id: string; title: string }> = [];
  for (const file of files) {
    const res = await bridgeSlackReadCall("files.getUploadURLExternal", { filename: file.filename, length: file.bytes.byteLength });
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
  await bridgeSlackReadCall("files.completeUploadExternal", complete);
  return undefined;
}

async function postFilesToDiscord(ctx: BindableContext, files: readonly ResolvedFile[], comment: string | undefined): Promise<string | undefined> {
  const ops = surfaceMessageOps("discord");
  if (!ops) {
    throw new Error("post_file: Discord message transport is not registered — the @open-everywhere/provider-discord bundle isn't wired.");
  }
  if (!ops.postFiles) {
    throw new Error("post_file: Discord message transport has no file-upload op registered.");
  }
  const binding = bindFrom(ctx);
  const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
  if (!channelId) {
    throw new Error("post_file: couldn't resolve this Discord channel's id — try again from a real channel or DM.");
  }
  return await ops.postFiles(channelId, files, comment);
}

function notionPageChannelId(ctx: BindableContext): string {
  const binding = bindFrom(ctx);
  const channelId = typeof binding.anchorChannelId === "string" && binding.anchorChannelId.length > 0 ? binding.anchorChannelId : undefined;
  if (!channelId) {
    throw new Error("post_file: couldn't resolve this Notion page's address — try again from a real page comment.");
  }
  return channelId;
}

async function postFilesToNotion(ctx: BindableContext, files: readonly ResolvedFile[], comment: string | undefined): Promise<string | undefined> {
  const ops = surfaceMessageOps("notion");
  if (!ops) {
    throw new Error("post_file: Notion message transport is not registered — the @open-everywhere/provider-notion bundle isn't wired.");
  }
  if (!ops.postFiles) {
    throw new Error("post_file: Notion message transport has no file-upload op registered.");
  }
  return await ops.postFiles(notionPageChannelId(ctx), files, comment);
}

async function postTextToNotion(ctx: BindableContext, text: string): Promise<string | undefined> {
  const ops = surfaceMessageOps("notion");
  if (!ops) {
    throw new Error("post_file: Notion message transport is not registered — the @open-everywhere/provider-notion bundle isn't wired.");
  }
  return await ops.postText(notionPageChannelId(ctx), text);
}

const MAX_FILES = 10;

const NOTION_MAX_POST_FILE_ATTACHMENTS = 3;

const inputSchema = z.object({
  files: z
    .array(
      z.object({
        source: z
          .object({ path: z.string().min(1) })
          .describe("A file path in THIS session's workspace/sandbox (e.g. a bash-written artifact or an agent-browser screenshot). Read via the bound sandbox; confined to the workspace root; fails closed on a seat with no sandbox."),
        filename: z.string().min(1).describe("The name the file is posted under (its extension drives contentType inference)."),
        contentType: z.string().min(1).optional().describe("MIME type; inferred from the filename when omitted."),
        caption: z.string().min(1).optional().describe("Optional per-file caption/title."),
      }),
    )
    .min(1)
    .max(MAX_FILES)
    .describe("One or more files to post (max 10), each up to 10 MB."),
  comment: z.string().min(1).optional().describe("Optional text posted alongside the files."),
});
type PostFileInput = z.infer<typeof inputSchema>;

function inputFileIsHtml(f: PostFileInput["files"][number]): boolean {
  return isHtmlArtifact(f.contentType ?? inferContentType(f.filename));
}

const approvalPolicy: Approval<PostFileInput> = (approvalCtx) => {
  const files = approvalCtx.toolInput?.files ?? [];
  const willPublish = resolveBlobHosting().enabled && files.some(inputFileIsHtml);
  return willPublish ? "user-approval" : "not-applicable";
};

export default windowGated("post_file", defineTool({
  description:
    "Post one or more FILES/artifacts (screenshots, images, docs, data) to the current conversation " +
    "on this surface — the delivery channel for things a text reply can't carry. Give each file a " +
    "`source: { path }` — a file in THIS session's workspace/sandbox (e.g. a bash-written artifact, " +
    "or an agent-browser screenshot) — and a `filename`; `contentType` is inferred from the filename " +
    "if omitted. Each file is capped at 10 MB. Add an optional `comment` to post alongside the files, " +
    "and a per-file `caption`. Works on Slack, Discord and Notion today (Notion accepts at most 3 " +
    "files per post — a comment's own vendor cap); on other surfaces it returns a clear " +
    "'not supported here' error so you can fall back to a text reply. HTML pages: if this org has " +
    "opted in to Blob hosting they're published to a public URL (approval-gated); otherwise the raw " +
    "`.html` is attached as a downloadable file.",
  inputSchema,
  outputSchema: z.object({ posted: z.boolean(), count: z.number(), platform: z.string(), urls: z.array(z.string()).optional() }),
  approval: { request: withDuplicateApprovalGuard(approvalPolicy), response: initiatorBoundResponsePolicy<PostFileInput>() },
  async execute(input, ctx) {
    const platform = bindFrom(ctx as BindableContext).platform;
    if (platform !== "slack" && platform !== "discord" && platform !== "notion") {
      throw new Error(
        `post_file: file posting is not supported on "${platform}" yet (supported: Slack, Discord, Notion). ` +
          "Reply with text, or share a link to an already-hosted file instead.",
      );
    }
    if (platform === "notion" && input.files.length > NOTION_MAX_POST_FILE_ATTACHMENTS) {
      throw new Error(
        `post_file: Notion accepts at most ${NOTION_MAX_POST_FILE_ATTACHMENTS} files per post; got ${input.files.length}. Split them across multiple posts.`,
      );
    }

    const resolved: ResolvedFile[] = [];
    for (const f of input.files) {
      const contentType = f.contentType ?? inferContentType(f.filename);
      const bytes = await resolveBytes(f.source.path, ctx as BindableContext);
      resolved.push({ bytes, filename: f.filename, contentType, caption: f.caption });
    }

    const hosting = resolveBlobHosting();
    const toAttach: ResolvedFile[] = [];
    const hostedUrls: string[] = [];
    for (const file of resolved) {
      if (isHtmlArtifact(file.contentType) && hosting.enabled) {
        hostedUrls.push(await hostHtmlArtifact(file, { publicPrefix: hosting.publicPrefix }));
      } else {
        toAttach.push(file);
      }
    }

    const binding = bindFrom(ctx as BindableContext);
    const channelId =
      typeof binding.target?.channelId === "string"
        ? binding.target.channelId
        : typeof binding.anchorChannelId === "string"
          ? binding.anchorChannelId
          : undefined;
    const callId = typeof (ctx as { callId?: unknown }).callId === "string" ? (ctx as { callId: string }).callId : undefined;

    let attachId: string | undefined;
    if (toAttach.length > 0) {
      attachId = await postOnce({
        org: binding.org,
        key: outboundKey({
          surface: platform,
          channel: channelId,
          threadTs: binding.threadTs,
          action: `${platform}.post_file.attach`,
          stableId: callId,
          payload: `${input.comment ?? ""}\x00${toAttach.map((f) => `${f.filename}:${f.contentType}:${f.bytes.byteLength}`).join(",")}`,
        }),
        run: async () => {
          if (platform === "slack") return await postFilesToSlack(ctx as BindableContext, toAttach, input.comment);
          if (platform === "discord") return await postFilesToDiscord(ctx as BindableContext, toAttach, input.comment);
          return await postFilesToNotion(ctx as BindableContext, toAttach, input.comment);
        },
      });
    }
    let linkId: string | undefined;
    if (hostedUrls.length > 0) {
      linkId = await postOnce({
        org: binding.org,
        key: outboundKey({
          surface: platform,
          channel: channelId,
          threadTs: binding.threadTs,
          action: `${platform}.post_file.link`,
          stableId: callId,
          payload: `${toAttach.length > 0 ? "" : (input.comment ?? "")}\x00${hostedUrls.join(",")}`,
        }),
        run: () => postLinkToSurface(ctx as BindableContext, platform, hostedUrls, toAttach.length > 0 ? undefined : input.comment),
      });
    }

    const deliveredId = attachId ?? linkId;
    await auditToolAction(ctx, `${platform}.post_file`, {
      count: resolved.length,
      filenames: resolved.map((f) => f.filename),
      hasComment: Boolean(input.comment),
      hosted: hostedUrls.length,
      attached: toAttach.length,
      ...(deliveredId ? { id: deliveredId } : {}),
    });
    return { posted: true, count: resolved.length, platform, ...(hostedUrls.length > 0 ? { urls: hostedUrls } : {}) };
  },
}));

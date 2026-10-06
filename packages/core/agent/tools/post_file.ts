import { defineTool } from "eve/tools";
import { windowGated } from "../access/window-gated.js";
import { z } from "zod";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { bridgeSlackReadCall } from "../channels/slack-bridge.js";
import { surfaceMessageOps } from "../channels/surface-message-ops.js";
import { auditToolAction } from "../audit/tool-action.js";
import { hostHtmlArtifact, resolveBlobHosting } from "../blob/hosting.js";
import { confineToWorkspacePath } from "./describe_image.js";
import { postOnce, outboundKey } from "../operational/post-once.js";
import { actingPrincipalIdOf, unattendedOf } from "../access/request.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { getConfig } from "../access/config.js";
import { autoApprovedNote, requestApproval } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { resolvePartition } from "../memory/partition.js";
import { MAX_CARDED_PUBLISH_BYTES, freezePublishPage, type FilePublishArgs } from "../approvals/file-publish.js";

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

interface PublishCard {
  readonly pending: boolean;
  readonly autoApproved?: boolean;
  readonly pendingId?: string;
  readonly urls: readonly string[];
  readonly message: string;
}

function linkChannelIdOf(ctx: BindableContext, platform: string): string {
  const binding = bindFrom(ctx);
  const id = platform === "notion" ? binding.anchorChannelId : binding.target?.channelId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`post_file: couldn't resolve this ${platform} conversation's address — try again from a real channel, DM or page comment. Nothing was published.`);
  }
  return id;
}

async function proposePublish(ctx: BindableContext, platform: string, pages: readonly ResolvedFile[], comment: string | undefined): Promise<PublishCard> {
  if (unattendedOf(ctx)) throw new Error(UNATTENDED_PUBLISH_REFUSAL);
  await requireSessionContinuation(ctx, "post_file");
  const total = pages.reduce((n, f) => n + f.bytes.byteLength, 0);
  if (total > MAX_CARDED_PUBLISH_BYTES) {
    throw new Error(
      `post_file: the HTML to publish is ${total} bytes; one approval card holds at most ${MAX_CARDED_PUBLISH_BYTES}. ` +
        "Split it across several calls, or post it as a plain attachment. Nothing was published or posted.",
    );
  }
  const requestedBy = actingPrincipalIdOf(ctx);
  if (!requestedBy) {
    throw new Error("post_file: a publish needs a verified sender on this turn, and this turn has none. Ask a person in this conversation to publish it. Nothing was published.");
  }
  const binding = bindFrom(ctx);
  const p = resolvePartition(ctx);
  const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
  if ("refusal" in venueResult) throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "publish that page"));
  const venue = venueResult.venue;
  if (venue.platform !== binding.platform) {
    throw new Error(
      `post_file: only the person who asked can approve a publish, and ${binding.platform} has no approval-card path here — ` +
        "a card in another platform's room is one you could never approve. Post the page without Blob hosting so it attaches instead. Nothing was published.",
    );
  }
  const tainted = untrustedIngestedThisTurn();
  const args: FilePublishArgs = {
    org: p.org,
    scopeKey: p.surfaceKey,
    platform,
    linkChannelId: linkChannelIdOf(ctx, platform),
    threadTs: binding.threadTs ?? null,
    pages: pages.map((f) => freezePublishPage(f)),
    ...(comment ? { comment } : {}),
    requestedBy,
    ...(tainted ? { tainted: true } : {}),
  };
  const posted = await requestApproval(
    {
      org: p.org,
      kind: "file.publish",
      args,
      scopeKey: await proposalScopeKey(ctx, p),
      domain: null,
      requestedBy,
      channelId: venue.channelId,
      threadTs: venue.sameRoom ? (binding.threadTs ?? null) : null,
      postedTo: venue.surfaceKey,
      chain: { unattended: unattendedOf(ctx), tainted },
    },
    approvalPostDeps(venue.platform, ctx),
  );
  const subject = `publish of ${pages.map((f) => `"${f.filename}"`).join(", ")} to a public URL`;
  if (posted.autoApproved) {
    const urls = posted.autoApproved.outcome.match(/https:\/\/\S+/g) ?? [];
    return { pending: false, autoApproved: true, pendingId: posted.id, urls, message: autoApprovedNote(subject, posted.autoApproved) };
  }
  return {
    pending: true,
    pendingId: posted.id,
    urls: [],
    message: `${cardPostedPrefix(venue)} — ${subject} awaits a member's approval (pending ${posted.id}). Nothing is public yet.${cardPostedTail(venue, "approve the publish", posted)}`,
  };
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

const UNATTENDED_PUBLISH_REFUSAL =
  "post_file: publishing an HTML artifact to a public URL needs approval, and nobody is attending this run. " +
  "An unattended run cannot wait on an approval card, and no standing permission covers this tool. " +
  "Ask a person to publish it, or post the file without Blob hosting so it attaches instead. Nothing was published.";

function htmlPagesSentence(hostingEnabled: boolean): string {
  return hostingEnabled
    ? "HTML pages: this org has opted in to Blob hosting, so an HTML page is published to a public URL. " +
        "Each publish needs approval: the call posts an approval card into the room and returns at once, " +
        "and the page goes public only when a member approves the card. Any non-HTML files in the same call attach at once."
    : "HTML pages: this org has not opted in to Blob hosting. An HTML page is attached as a downloadable " +
        "file, exactly like any other file. Nothing is ever published or made public. Keep the real " +
        "filename and extension (`page.html`, `text/html`). Do not rename it to `.txt`.";
}

export function postFileDescription(hostingEnabled: boolean): string {
  return (
    "Post one or more FILES/artifacts (screenshots, images, docs, data) to the current conversation " +
    "on this surface — the delivery channel for things a text reply can't carry. Give each file a " +
    "`source: { path }` — a file in THIS session's workspace/sandbox (e.g. a bash-written artifact, " +
    "or an agent-browser screenshot) — and a `filename`; `contentType` is inferred from the filename " +
    "if omitted. Each file is capped at 10 MB. Add an optional `comment` to post alongside the files, " +
    "and a per-file `caption`. Works on Slack, Discord and Notion today (Notion accepts at most 3 " +
    "files per post — a comment's own vendor cap); on other surfaces it returns a clear " +
    "'not supported here' error so you can fall back to a text reply. " +
    htmlPagesSentence(hostingEnabled)
  );
}

export default windowGated("post_file", defineTool({
  description: postFileDescription(resolveBlobHosting().enabled),
  inputSchema,
  outputSchema: z.object({
    posted: z.boolean(),
    count: z.number(),
    platform: z.string(),
    urls: z.array(z.string()).optional(),
    pending: z.boolean().optional().describe("An approval card for the HTML publish is posted; nothing is public until a member approves it."),
    pendingId: z.string().optional(),
    message: z.string().optional(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered the publish: no card was posted and the pages are ALREADY public."),
  }),
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

    if (resolveBlobHosting().enabled && input.files.some(inputFileIsHtml) && unattendedOf(ctx as BindableContext)) {
      throw new Error(UNATTENDED_PUBLISH_REFUSAL);
    }

    const resolved: ResolvedFile[] = [];
    for (const f of input.files) {
      const contentType = f.contentType ?? inferContentType(f.filename);
      const bytes = await resolveBytes(f.source.path, ctx as BindableContext);
      resolved.push({ bytes, filename: f.filename, contentType, caption: f.caption });
    }

    const hosting = resolveBlobHosting();
    const toAttach: ResolvedFile[] = [];
    const toPublish: ResolvedFile[] = [];
    for (const file of resolved) {
      if (isHtmlArtifact(file.contentType) && hosting.enabled) toPublish.push(file);
      else toAttach.push(file);
    }
    const card = toPublish.length > 0 ? await proposePublish(ctx as BindableContext, platform, toPublish, toAttach.length > 0 ? undefined : input.comment) : undefined;

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
    if (toAttach.length > 0) {
      await auditToolAction(ctx, `${platform}.post_file`, {
        count: toAttach.length,
        filenames: toAttach.map((f) => f.filename),
        hasComment: Boolean(input.comment),
        hosted: 0,
        attached: toAttach.length,
        ...(card !== undefined ? { carded: toPublish.length } : {}),
        ...(attachId ? { id: attachId } : {}),
      });
    }
    if (card === undefined) return { posted: true, count: resolved.length, platform };
    return {
      posted: toAttach.length > 0 || card.urls.length > 0,
      count: resolved.length,
      platform,
      ...(card.urls.length > 0 ? { urls: card.urls } : {}),
      pending: card.pending,
      ...(card.autoApproved ? { autoApproved: true } : {}),
      ...(card.pendingId !== undefined ? { pendingId: card.pendingId } : {}),
      message: card.message,
    };
  },
}));

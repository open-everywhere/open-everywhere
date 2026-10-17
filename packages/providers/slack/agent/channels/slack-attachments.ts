import {
  getOperationalStore,
  deploymentOrg,
  resolvePartition,
  registerAttachmentResolver,
  AttachmentOversizeError,
  type SlackAttachmentRow,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";
import { fetchSlackAttachment } from "../access/slack-attachment-fetch.js";

export interface SlackAttachmentRecord {
  readonly urlPrivate: string;
  readonly mimeType?: string;
  readonly name?: string;
  readonly teamId?: string;
  readonly platform?: "slack";
}

const SLACK_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_ENTRIES = 1000;
const registry = new Map<string, SlackAttachmentRecord>();

export function registerSlackAttachment(fileId: string | undefined, rec: SlackAttachmentRecord): void {
  if (!fileId || !rec.urlPrivate) return;
  if (registry.has(fileId)) registry.delete(fileId);
  registry.set(fileId, { ...rec, platform: "slack" });
  while (registry.size > MAX_ENTRIES) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
}

export function resolveSlackAttachment(fileId: string): SlackAttachmentRecord | undefined {
  return registry.get(fileId);
}

export async function persistSlackAttachment(fileId: string | undefined, rec: SlackAttachmentRecord, org?: string): Promise<void> {
  if (!fileId || !rec.urlPrivate) return;
  const row: SlackAttachmentRow = {
    urlPrivate: rec.urlPrivate,
    ...(rec.mimeType ? { mimeType: rec.mimeType } : {}),
    ...(rec.name ? { name: rec.name } : {}),
    ...(rec.teamId ? { teamId: rec.teamId } : {}),
  };
  try {
    await getOperationalStore().putSlackAttachment(org ?? deploymentOrg(), fileId, row, new Date().toISOString(), SLACK_ATTACHMENT_TTL_MS);
  } catch (err) {
    console.warn(`[open-everywhere:slack-attachments] dropped a durable attachment row for "${fileId}": ${String(err)}`);
  }
}

export async function resolveSlackAttachmentDurable(fileId: string, org?: string): Promise<SlackAttachmentRecord | undefined> {
  const local = registry.get(fileId);
  if (local) return local;
  try {
    const row = await getOperationalStore().getSlackAttachment(org ?? deploymentOrg(), fileId);
    return row ? { ...row, platform: "slack" } : undefined;
  } catch (err) {
    console.warn(`[open-everywhere:slack-attachments] durable attachment lookup for "${fileId}" failed: ${String(err)}`);
    return undefined;
  }
}

export async function pullSlackAttachmentBytes(ctx: BindableContext, ref: { readonly urlPrivate: string; readonly id?: string }, maxBytes: number): Promise<Uint8Array> {
  const res = await fetchSlackAttachment(ctx, ref);
  if (!res.ok) throw new Error(`fetching the upload failed (HTTP ${res.status})`);
  const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) throw new AttachmentOversizeError(declared, "declared", maxBytes);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new AttachmentOversizeError(bytes.byteLength, "actual", maxBytes);
  return bytes;
}

export function registerSlackAttachmentResolver(): void {
  registerAttachmentResolver({
    platform: "slack",
    async resolve(attachmentId, ctx) {
      const rec = await resolveSlackAttachmentDurable(attachmentId, resolvePartition(ctx).org);
      if (!rec) return undefined;
      const res = await fetchSlackAttachment(ctx, { urlPrivate: rec.urlPrivate, id: attachmentId });
      if (!res.ok) throw new Error(`fetching Slack attachment "${attachmentId}" failed (HTTP ${res.status})`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), ref: `slack-file:${attachmentId}`, mimeType: rec.mimeType };
    },
    async resolveGuarded(attachmentId, ctx) {
      const rec = await resolveSlackAttachmentDurable(attachmentId, resolvePartition(ctx).org);
      if (!rec) return undefined;
      return {
        ref: `slack-file:${attachmentId}`,
        mimeType: rec.mimeType,
        name: rec.name,
        pull: ({ maxBytes }) => pullSlackAttachmentBytes(ctx, { urlPrivate: rec.urlPrivate, id: attachmentId }, maxBytes),
      };
    },
  });
}

export function _resetSlackAttachmentsForTest(): void {
  registry.clear();
}

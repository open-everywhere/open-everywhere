import { getOperationalStore } from "../operational/provider.js";
import { deploymentOrg } from "../identity/binding.js";
import type { SlackAttachmentRow } from "../operational/store.js";

export interface SlackAttachmentRecord {
  readonly urlPrivate: string;
  readonly mimeType?: string;
  readonly name?: string;
  readonly teamId?: string;
}

export const SLACK_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_ENTRIES = 1000;
const registry = new Map<string, SlackAttachmentRecord>();

export function registerSlackAttachment(fileId: string | undefined, rec: SlackAttachmentRecord): void {
  if (!fileId || !rec.urlPrivate) return;
  if (registry.has(fileId)) registry.delete(fileId);
  registry.set(fileId, rec);
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
    return row ?? undefined;
  } catch (err) {
    console.warn(`[open-everywhere:slack-attachments] durable attachment lookup for "${fileId}" failed: ${String(err)}`);
    return undefined;
  }
}

export function _resetSlackAttachmentsForTest(): void {
  registry.clear();
}

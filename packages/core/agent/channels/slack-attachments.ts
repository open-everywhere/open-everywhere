export interface SlackAttachmentRecord {
  readonly urlPrivate: string;
  readonly mimeType?: string;
  readonly teamId?: string;
}

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

export function _resetSlackAttachmentsForTest(): void {
  registry.clear();
}

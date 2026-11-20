import type { BindableContext } from "../identity/binding.js";
import { admitProviderRegistration } from "../access/provider-selection.js";

export interface ResolvedAttachment {
  readonly bytes: Uint8Array;
  readonly ref: string;
  readonly mimeType?: string;
}

export interface GuardedAttachment {
  readonly ref: string;
  readonly mimeType?: string;
  readonly name?: string;
  pull(opts: { maxBytes: number }): Promise<Uint8Array>;
}

export class AttachmentOversizeError extends Error {
  constructor(
    readonly bytes: number,
    readonly phase: "declared" | "actual",
    readonly maxBytes: number,
  ) {
    super(`attachment too large (${bytes} bytes; max ${maxBytes})`);
    this.name = "AttachmentOversizeError";
  }
}

export interface AttachmentResolver {
  readonly platform: string;
  resolve(attachmentId: string, ctx: BindableContext): Promise<ResolvedAttachment | undefined>;
  resolveGuarded?(attachmentId: string, ctx: BindableContext): Promise<GuardedAttachment | undefined>;
}

const resolvers = new Map<string, AttachmentResolver>();

export function registerAttachmentResolver(resolver: AttachmentResolver): void {
  if (!admitProviderRegistration(resolver.platform, "attachment-resolver")) return;
  resolvers.set(resolver.platform, resolver);
}

export async function resolveAttachment(attachmentId: string, ctx: BindableContext): Promise<ResolvedAttachment | undefined> {
  for (const resolver of resolvers.values()) {
    const res = await resolver.resolve(attachmentId, ctx);
    if (res) return res;
  }
  return undefined;
}

export async function resolveGuardedAttachment(attachmentId: string, ctx: BindableContext): Promise<GuardedAttachment | undefined> {
  for (const resolver of resolvers.values()) {
    if (!resolver.resolveGuarded) continue;
    const res = await resolver.resolveGuarded(attachmentId, ctx);
    if (res) return res;
  }
  return undefined;
}

export function _resetAttachmentPlaneForTest(): void {
  resolvers.clear();
}

export interface BriefAttachment {
  readonly id: string;
  readonly kind?: string;
  readonly name?: string;
  readonly mimeType?: string;
}

const MAX_BRIEF_ATTACHMENTS = 8;

const ATTACHMENT_ELEMENT_RE = /<attachment\b([^>]*)\/>/g;

const ATTACHMENT_ID_RE = /^[A-Za-z0-9._:@+~-]{1,128}$/;

const MAX_LABEL_CHARS = 200;

const UNRENDERABLE_LABEL_RE = /[<>"&\n\r]/;

function attrOf(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  const value = m?.[1];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function labelOf(attrs: string, name: string): string | undefined {
  const value = attrOf(attrs, name);
  if (value === undefined || value.length > MAX_LABEL_CHARS) return undefined;
  return UNRENDERABLE_LABEL_RE.test(value) ? undefined : value;
}

export function parseWakeAttachments(envelope: string): BriefAttachment[] {
  const found: BriefAttachment[] = [];
  for (const m of envelope.matchAll(ATTACHMENT_ELEMENT_RE)) {
    const attrs = m[1] ?? "";
    const id = attrOf(attrs, "id");
    if (id === undefined || !ATTACHMENT_ID_RE.test(id)) continue;
    found.push({ id, kind: labelOf(attrs, "kind"), name: labelOf(attrs, "name"), mimeType: labelOf(attrs, "mimetype") });
  }
  return found.slice(-MAX_BRIEF_ATTACHMENTS);
}

function renderAttachmentBrief(attachments: readonly BriefAttachment[]): string {
  if (attachments.length === 0) return "";
  const elements = attachments
    .map((a) => {
      const attr = (n: string, v: string | undefined) => (v === undefined ? "" : ` ${n}="${v}"`);
      return `<attachment${attr("kind", a.kind)} id="${a.id}"${attr("name", a.name)}${attr("mimetype", a.mimeType)}/>`;
    })
    .join("\n");
  return [
    "",
    "<delegated-attachments>",
    "The conversation this task came from carries the files below. To read one, pass its `id` — never",
    "its name — as the attachment reference. A name resolves to nothing.",
    elements,
    "</delegated-attachments>",
  ].join("\n");
}

/**
 * The files a stored row names, re-checked as a wake's envelope is checked: a bad id drops the
 * file, and a bad label drops only that label. A stored row is data, so its text never reaches a
 * brief unchecked.
 */
export function briefAttachmentsOf(raw: unknown): BriefAttachment[] {
  if (!Array.isArray(raw)) return [];
  const found: BriefAttachment[] = [];
  const label = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= MAX_LABEL_CHARS && !UNRENDERABLE_LABEL_RE.test(v) ? v : undefined);
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !ATTACHMENT_ID_RE.test(e.id)) continue;
    found.push({ id: e.id, kind: label(e.kind), name: label(e.name), mimeType: label(e.mimeType) });
  }
  return found.slice(-MAX_BRIEF_ATTACHMENTS);
}

/**
 * The files of a job that continues earlier work: the earlier files, then this wake's own. A file
 * that both name keeps its latest labels. The cap keeps the latest files.
 */
export function mergeBriefAttachments(earlier: readonly BriefAttachment[], own: readonly BriefAttachment[]): BriefAttachment[] {
  const byId = new Map<string, BriefAttachment>();
  for (const a of [...earlier, ...own]) {
    byId.delete(a.id);
    byId.set(a.id, a);
  }
  return [...byId.values()].slice(-MAX_BRIEF_ATTACHMENTS);
}

export function withDelegatedAttachments(message: string, attachments: readonly BriefAttachment[]): string {
  const block = renderAttachmentBrief(attachments);
  return block.length === 0 ? message : `${message}\n${block}`;
}

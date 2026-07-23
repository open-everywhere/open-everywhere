import type { BindableContext } from "../identity/binding.js";

export interface ResolvedAttachment {
  readonly bytes: Uint8Array;
  readonly ref: string;
  readonly mimeType?: string;
}

export interface AttachmentResolver {
  readonly platform: string;
  resolve(attachmentId: string, ctx: BindableContext): Promise<ResolvedAttachment | undefined>;
}

const resolvers = new Map<string, AttachmentResolver>();

export function registerAttachmentResolver(resolver: AttachmentResolver): void {
  resolvers.set(resolver.platform, resolver);
}

export async function resolveAttachment(attachmentId: string, ctx: BindableContext): Promise<ResolvedAttachment | undefined> {
  for (const resolver of resolvers.values()) {
    const res = await resolver.resolve(attachmentId, ctx);
    if (res) return res;
  }
  return undefined;
}

export function _resetAttachmentPlaneForTest(): void {
  resolvers.clear();
}

import type { BindableContext } from "../identity/binding.js";

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

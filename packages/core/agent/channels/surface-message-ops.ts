export interface OutboundFile {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
  readonly caption?: string;
}

export interface SurfaceMessageOps {
  readonly platform: string;
  postText(channelId: string, text: string, opts?: { replyToMessageId?: string }): Promise<string>;
  editMessage(channelId: string, messageId: string, text: string): Promise<void>;
  postFiles(channelId: string, files: readonly OutboundFile[], comment: string | undefined): Promise<void>;
}

const REGISTRY = new Map<string, SurfaceMessageOps>();

export function registerSurfaceMessageOps(ops: SurfaceMessageOps): void {
  REGISTRY.set(ops.platform, ops);
}

export function surfaceMessageOps(platform: string | undefined): SurfaceMessageOps | undefined {
  return platform === undefined ? undefined : REGISTRY.get(platform);
}

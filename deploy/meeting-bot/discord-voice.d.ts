export declare const RULE: { readonly minMs: number; readonly maxMs: number; readonly gapMs: number };
export declare const TURN_CUT_BUDGET: number;
export declare const OUT_RATE: number;
export declare function isLeakedDaveFrame(frame: Uint8Array | undefined | null): boolean;
export interface VoiceDirectory {
  onPacket(packet: { readonly op: number; readonly d?: Record<string, unknown> | null } | undefined): void;
  others(botId: string): number | undefined;
}
export declare function createVoiceDirectory(): VoiceDirectory;
export declare function toMono16k(pcm: Int16Array): Int16Array;
export declare function wavFile(samples: Int16Array, rate?: number): Buffer;
export interface VoiceChunk {
  readonly userId: string;
  readonly atMs: number;
  readonly samples: Int16Array;
  readonly reason: "turn" | "pause" | "max" | "end";
}
export interface VoiceCapture {
  readonly stats: { dropped: number; subscriptions: number; undecodable: number };
  speakingStart(userId: string): void;
  frame(userId: string, opus: Uint8Array): void;
  streamEnd(userId: string): void;
  flushAll(): void;
}
export declare function createVoiceCapture(opts: {
  subscribe(userId: string): void;
  decode(opus: Uint8Array): Int16Array;
  onChunk(chunk: VoiceChunk): void;
  now?: () => number;
  rule?: { readonly minMs: number; readonly maxMs: number; readonly gapMs: number };
  turnCutBudget?: number;
}): VoiceCapture;

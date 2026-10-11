import { processRegistryMap } from "../lib/process-registry.js";
import { neutraliseMentions } from "./recap.js";
import { platformLabel, type MeetingPlatform } from "./link.js";
import type { NativeTranscriptPolicy } from "./policy.js";

export interface NativeTranscriptSegment {
  readonly speaker: string;
  readonly text: string;
  readonly startMs?: number;
}

export type NativeRefusalReason = "access-off" | "not-transcribed" | "expired" | "not-found" | "credential";

export type NativeTranscriptResult =
  | { readonly status: "ready"; readonly segments: readonly NativeTranscriptSegment[]; readonly startedAt?: string; readonly endedAt?: string }
  | { readonly status: "pending" }
  | { readonly status: "refused"; readonly reason: NativeRefusalReason; readonly hint?: string };

export interface NativeMeetingRef {
  readonly platform: MeetingPlatform;
  readonly url: string;
  readonly roomId: string;
  readonly tenantId?: string;
  readonly organizerId?: string;
  readonly organiserEmail?: string;
  readonly startedAfter?: number;
}

export interface NativeReadContext {
  readonly policy: NativeTranscriptPolicy;
  readonly secret: (name: string) => Promise<string>;
}

export interface NativeTranscriptSource {
  readonly platform: MeetingPlatform;
  readonly disclosure: string;
  read(ref: NativeMeetingRef, ctx: NativeReadContext): Promise<NativeTranscriptResult>;
}

const SOURCES = processRegistryMap<NativeTranscriptSource>("meeting-native-transcript-sources.v1");

export function registerNativeTranscriptSource(source: NativeTranscriptSource): void {
  SOURCES.set(source.platform, source);
}

export function nativeTranscriptSource(platform: MeetingPlatform): NativeTranscriptSource | undefined {
  return SOURCES.get(platform);
}

export function resetNativeTranscriptSourcesForTest(): void {
  SOURCES.clear();
}

const MAX_SPEAKER = 80;

export function nativeTranscriptText(segments: readonly NativeTranscriptSegment[]): string {
  const lines: string[] = [];
  for (const s of segments) {
    const text = s.text.replace(/[\r\n\t]+/g, " ").trim();
    if (text.length === 0) continue;
    const who = neutraliseMentions(s.speaker).slice(0, MAX_SPEAKER);
    lines.push(who.length > 0 ? `[${who}] ${text}` : text);
  }
  return lines.join("\n");
}

export function nativeMeetingMinutes(result: { readonly segments: readonly NativeTranscriptSegment[]; readonly startedAt?: string; readonly endedAt?: string }): number {
  const start = result.startedAt !== undefined ? Date.parse(result.startedAt) : NaN;
  const end = result.endedAt !== undefined ? Date.parse(result.endedAt) : NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return Math.max(1, Math.round((end - start) / 60_000));
  const last = result.segments.reduce((m, s) => (s.startMs !== undefined && s.startMs > m ? s.startMs : m), 0);
  return Math.max(1, Math.round(last / 60_000));
}

export function nativeRefusalSentence(platform: MeetingPlatform, reason: NativeRefusalReason, hint?: string): string {
  const p = platformLabel(platform);
  const extra = hint !== undefined && hint.trim().length > 0 ? ` ${neutraliseMentions(hint).slice(0, 400)}` : "";
  switch (reason) {
    case "access-off":
      return `${p} refused the organisation's access to this meeting's transcript, so there is no recap. An admin must grant it.${extra}`;
    case "not-transcribed":
      return `${p} has no transcript for this meeting: transcription was not on, so there is nothing to recap.${extra}`;
    case "expired":
      return `${p} no longer keeps this meeting's transcript (it expired or was deleted), so there is nothing to recap.${extra}`;
    case "not-found":
      return `${p} does not know this meeting under the organisation's account, so I can't read its transcript.${extra}`;
    case "credential":
      return `The organisation's ${p} credential did not work, so I can't read the transcript. An admin checks it.${extra}`;
  }
}

export function nativeTimeoutSentence(platform: MeetingPlatform, hours: number): string {
  return `${platformLabel(platform)} had no transcript for this meeting ${hours} hour(s) after the ask, so I stopped checking and there is no recap. Either transcription was not on, or the meeting had not ended. Ask me again once it has a transcript.`;
}

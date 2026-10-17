import type { BindableContext } from "../identity/binding.js";
import { auditSurfaceModeFrom, bindFrom } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { processRegistrySlot } from "../lib/process-registry.js";
import { appendAudit } from "../audit/audit.js";
import { getSettings } from "../settings/settings.js";
import { scopeOverBudget } from "../spend/check.js";
import { recordModelCall } from "../hooks/spend.js";
import type { WakeAttachment } from "./wake-envelope.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

export interface VoiceClipAudio {
  readonly audio: Uint8Array;
  readonly mediaType: string;
  readonly abortSignal?: AbortSignal;
}

export interface VoiceClipTranscript {
  readonly text: string;
  readonly model: string;
  readonly costUsd?: number;
}

export type VoiceTranscriber = (clip: VoiceClipAudio) => Promise<VoiceClipTranscript>;

const TRANSCRIBER = processRegistrySlot<VoiceTranscriber>("voice-clip-transcriber.v1");

export function registerVoiceTranscriber(fn: VoiceTranscriber): void {
  TRANSCRIBER.set(fn);
}

export function voiceTranscriber(): VoiceTranscriber | undefined {
  return TRANSCRIBER.get() ?? undefined;
}

export function resetVoiceTranscriberForTest(): void {
  TRANSCRIBER.set(null);
}

export const MAX_VOICE_CLIP_BYTES = 20 * 1024 * 1024;

export const MAX_VOICE_CLIPS_PER_MESSAGE = 3;

export const VOICE_CLIPS_DEADLINE_MS = 60_000;

const AUDIO_EXTENSIONS = new Set(["m4a", "mp3", "mp4a", "wav", "ogg", "oga", "opus", "aac", "flac", "weba"]);

export function isVoiceClip(a: WakeAttachment): boolean {
  if (a.mimeType !== undefined && a.mimeType !== "") return a.mimeType.toLowerCase().startsWith("audio/");
  const ext = a.name?.toLowerCase().split(".").pop();
  return ext !== undefined && AUDIO_EXTENSIONS.has(ext);
}

export type VoiceClipMiss = "off" | "no-route" | "over-cap" | "too-large" | "too-many" | "failed" | "silent";

export type VoiceClipOutcome =
  | { readonly heard: true; readonly text: string }
  | { readonly heard: false; readonly reason: VoiceClipMiss };

export type VoiceClipLoader = (clip: WakeAttachment, maxBytes: number) => Promise<VoiceClipAudio>;

export interface HearVoiceClipsInput {
  readonly attachments: readonly WakeAttachment[] | undefined;
  readonly bindable: BindableContext;
  readonly load: VoiceClipLoader;
  readonly transcriber?: VoiceTranscriber;
  readonly enabled?: boolean;
  readonly overBudget?: (bindable: BindableContext) => Promise<boolean>;
  readonly deadlineMs?: number;
  readonly record?: typeof recordModelCall;
  readonly audit?: (detail: AuditDetail) => Promise<void>;
}

async function liveOverBudget(bindable: BindableContext): Promise<boolean> {
  const binding = bindFrom(bindable);
  const verdict = await scopeOverBudget(resolvePartition(bindable), binding.mode, new Date().toISOString(), binding.trust, binding.principalId);
  return verdict.over;
}

function liveAudit(bindable: BindableContext) {
  return async (detail: AuditDetail): Promise<void> => {
    const p = resolvePartition(bindable);
    const binding = bindFrom(bindable);
    await appendAudit({
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      ...auditSurfaceModeFrom(bindable),
      ...(binding.principalId ? { principalId: binding.principalId } : {}),
      action: "voice.transcribed",
      detail,
    });
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function hearVoiceClips(input: HearVoiceClipsInput): Promise<VoiceClipOutcome[]> {
  const clips = (input.attachments ?? []).filter(isVoiceClip);
  if (clips.length === 0) return [];
  const all = (reason: VoiceClipMiss): VoiceClipOutcome[] => clips.map(() => ({ heard: false, reason }));
  const audit = input.audit ?? liveAudit(input.bindable);
  const note = (detail: AuditDetail): Promise<void> =>
    audit({ clips: clips.length, ...detail }).catch(() => {
    });

  const enabled = input.enabled ?? getSettings().voiceClips.enabled;
  if (!enabled) {
    await note({ heard: 0, reason: "off" });
    return all("off");
  }
  const transcriber = input.transcriber ?? voiceTranscriber();
  if (transcriber === undefined) {
    await note({ heard: 0, reason: "no-route" });
    return all("no-route");
  }
  const over = await (input.overBudget ?? liveOverBudget)(input.bindable).catch((err: unknown) => {
    console.warn(`[open-everywhere:voice-clips] the spend-cap check failed OPEN — the clip is heard without a cap read: ${errText(err)}`);
    return false;
  });
  if (over) {
    await note({ heard: 0, reason: "over-cap" });
    return all("over-cap");
  }

  const record = input.record ?? recordModelCall;
  const deadlineMs = input.deadlineMs ?? VOICE_CLIPS_DEADLINE_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`the voice clips took longer than ${deadlineMs} ms`)), deadlineMs);
  const expired = new Promise<never>((_, reject) => deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), { once: true }));
  expired.catch(() => {});
  const inTime = <T>(work: Promise<T>): Promise<T> => Promise.race([work, expired]);
  const out: VoiceClipOutcome[] = [];
  const models: string[] = [];
  try {
    for (const [i, clip] of clips.entries()) {
      if (i >= MAX_VOICE_CLIPS_PER_MESSAGE) {
        out.push({ heard: false, reason: "too-many" });
        continue;
      }
      if (deadline.signal.aborted) {
        out.push({ heard: false, reason: "failed" });
        continue;
      }
      let audio: VoiceClipAudio;
      try {
        audio = await inTime(input.load(clip, MAX_VOICE_CLIP_BYTES));
      } catch (err) {
        const oversize = err instanceof Error && err.name === "AttachmentOversizeError";
        console.warn(`[open-everywhere:voice-clips] clip ${i + 1} not downloaded: ${errText(err)}`);
        out.push({ heard: false, reason: oversize ? "too-large" : "failed" });
        continue;
      }
      if (audio == null || !(audio.audio instanceof Uint8Array)) {
        out.push({ heard: false, reason: "failed" });
        continue;
      }
      if (audio.audio.byteLength > MAX_VOICE_CLIP_BYTES) {
        out.push({ heard: false, reason: "too-large" });
        continue;
      }
      let heard: VoiceClipTranscript;
      try {
        heard = await inTime(transcriber({ ...audio, abortSignal: deadline.signal }));
      } catch (err) {
        console.warn(`[open-everywhere:voice-clips] clip ${i + 1} not transcribed: ${errText(err)}`);
        out.push({ heard: false, reason: "failed" });
        continue;
      }
      if (heard == null) {
        out.push({ heard: false, reason: "failed" });
        continue;
      }
      models.push(heard.model);
      if (heard.costUsd !== undefined && Number.isFinite(heard.costUsd) && heard.costUsd >= 0) {
        await record(input.bindable, {
          usage: { costUsd: heard.costUsd },
          usdMicros: Math.round(heard.costUsd * 1_000_000),
          model: heard.model,
          what: "voice clip (transcription)",
        });
      }
      const text = typeof heard.text === "string" ? heard.text.trim() : "";
      out.push(text === "" ? { heard: false, reason: "silent" } : { heard: true, text });
    }
  } finally {
    clearTimeout(timer);
  }
  const heardCount = out.filter((o) => o.heard).length;
  await note({
    heard: heardCount,
    ...(models.length > 0 ? { models: [...new Set(models)] } : {}),
    ...(heardCount < out.length ? { missed: out.flatMap((o) => (o.heard ? [] : [o.reason])) } : {}),
  });
  return out;
}

const MISS_LINE: Record<VoiceClipMiss, string> = {
  off: "[voice clip — not transcribed: voice clips are turned off here]",
  "no-route": "[voice clip — not transcribed: no speech-to-text model is set up here]",
  "over-cap": "[voice clip — not transcribed: this conversation is over its spend cap]",
  "too-large": "[voice clip — not transcribed: the clip is too long]",
  "too-many": "[voice clip — not transcribed: too many clips in one message]",
  failed: "[voice clip — could not be transcribed]",
  silent: "[voice clip — no speech heard]",
};

export function voiceClipBody(typed: string, outcomes: readonly VoiceClipOutcome[]): string {
  if (outcomes.length === 0) return typed;
  const lines = outcomes.map((o) => (o.heard ? `[voice clip] ${o.text}` : MISS_LINE[o.reason]));
  return [typed.trim(), ...lines].filter((l) => l !== "").join("\n");
}

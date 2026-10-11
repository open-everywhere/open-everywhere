import { processRegistryMap, processRegistrySlot } from "../lib/process-registry.js";
import type { TranscriptSegment } from "./speakers.js";

export type { TranscriptSegment } from "./speakers.js";

export type TranscriptionInput =
  | { readonly kind: "audio"; readonly mediaType: string; readonly data: Uint8Array }
  | { readonly kind: "text"; readonly text: string };

export interface TranscriptionOptions {
  readonly model?: string;
  readonly scope: string;
  readonly prompt?: string;
}

export type TranscriptionResult = string | { readonly text: string; readonly segments?: readonly TranscriptSegment[] };

export interface TranscriptionRoute {
  readonly id: string;
  readonly disclosure: string;
  transcribe(input: TranscriptionInput, opts: TranscriptionOptions): Promise<TranscriptionResult>;
}

const ROUTES = processRegistryMap<TranscriptionRoute>("meeting-transcription-routes.v1");

export function registerTranscriptionRoute(route: TranscriptionRoute): void {
  ROUTES.set(route.id, route);
}

export function transcriptionRoute(id: string): TranscriptionRoute | undefined {
  return ROUTES.get(id);
}

export function resetTranscriptionRoutesForTest(): void {
  ROUTES.clear();
  registerTranscriptionRoute(BOX_ROUTE);
}

export const BOX_ROUTE: TranscriptionRoute = {
  id: "box",
  disclosure: "Audio stays inside the bot's own box: the bot transcribes it there and sends OE text only.",
  async transcribe(input) {
    if (input.kind !== "text") throw new Error("the box transcription route accepts text only — this bot sent audio");
    return input.text;
  },
};
registerTranscriptionRoute(BOX_ROUTE);

export type MeetingCompletion = (scope: string, prompt: string) => Promise<string>;

const COMPLETION = processRegistrySlot<MeetingCompletion>("meeting-recap-completion.v1");

export function registerMeetingCompletion(fn: MeetingCompletion): void {
  COMPLETION.set(fn);
}

export function meetingCompletion(): MeetingCompletion | undefined {
  return COMPLETION.get() ?? undefined;
}

export function resetMeetingCompletionForTest(): void {
  COMPLETION.set(null);
}

import { experimental_transcribe as transcribe, generateText } from "ai";
import {
  registerMeetingCompletion,
  registerTranscriptionRoute,
  registerVoiceTranscriber,
  type MeetingCompletion,
  type TranscriptionInput,
  type TranscriptionRoute,
  type VoiceTranscriber,
} from "@open-everywhere/core/agent/adapter-api.js";
import { gatewayLanguageModel, gatewayTranscriptionModel, type GatewayRoutedDefaults } from "./gateway.js";
import { resolvedDreamCallSettings } from "./dream-judge.js";
import { roleDisclosure, transcribeWithFallback, type RoleTranscript, type TranscriptionDeps, type TranscriptionRoleSpec } from "./transcription-routes.js";

export type TranscribeCall = (modelId: string, audio: Uint8Array, mediaType: string) => Promise<string>;

const defaultTranscribe: TranscribeCall = async (modelId, audio) => {
  const result = await transcribe({ model: gatewayTranscriptionModel(modelId), audio });
  return result.text;
};

export function gatewayTranscriptionRoute(call: TranscribeCall = defaultTranscribe): TranscriptionRoute {
  return {
    id: "gateway",
    disclosure: "Audio goes, one minute at a time, through this deployment's own AI Gateway to its transcription model.",
    async transcribe(input, opts) {
      if (input.kind !== "audio") throw new Error("the gateway transcription route transcribes audio — this bot sent text");
      if (opts.model === undefined) throw new Error("the gateway transcription route needs transcription.model in the meeting policy");
      return await call(opts.model, input.data, input.mediaType);
    },
  };
}

export interface TimedTranscriptionRoute extends TranscriptionRoute {
  transcribeTimed(input: TranscriptionInput, opts: { readonly scope: string; readonly prompt?: string }): Promise<RoleTranscript>;
}

export function stackTranscriptionRoute(role: TranscriptionRoleSpec, deps: TranscriptionDeps = {}): TimedTranscriptionRoute {
  const run = transcribeWithFallback(role, deps);
  const timed: TimedTranscriptionRoute["transcribeTimed"] = async (input, opts) => {
    if (input.kind !== "audio") throw new Error("the gateway transcription route transcribes audio — this bot sent text");
    return await run({ audio: input.data, mediaType: input.mediaType, ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}) });
  };
  return {
    id: "gateway",
    disclosure: roleDisclosure(role),
    transcribeTimed: timed,
    async transcribe(input, opts) {
      return (await timed(input, { scope: opts.scope })).text;
    },
  };
}

export function voiceClipTranscriber(role: TranscriptionRoleSpec, deps: TranscriptionDeps = {}): VoiceTranscriber {
  const run = transcribeWithFallback(role, deps);
  return async (clip) => {
    const r = await run({ audio: clip.audio, mediaType: clip.mediaType, ...(clip.abortSignal ? { abortSignal: clip.abortSignal } : {}) });
    return { text: r.text, model: r.route.id, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) };
  };
}

function gatewayMeetingCompletion(defaults: GatewayRoutedDefaults): MeetingCompletion {
  return async (scope, prompt) => {
    const s = resolvedDreamCallSettings(scope, defaults);
    const { text } = await generateText({
      model: gatewayLanguageModel(s.id, s.via),
      prompt,
      ...(s.reasoning !== undefined ? { reasoning: s.reasoning } : {}),
      ...(s.providerOptions !== undefined ? { providerOptions: s.providerOptions as Parameters<typeof generateText>[0]["providerOptions"] } : {}),
    });
    return text;
  };
}

export function registerGatewayMeetingModels(defaults: GatewayRoutedDefaults, transcription?: TranscriptionRoleSpec): void {
  registerTranscriptionRoute(transcription === undefined ? gatewayTranscriptionRoute() : stackTranscriptionRoute(transcription));
  if (transcription !== undefined) registerVoiceTranscriber(voiceClipTranscriber(transcription));
  registerMeetingCompletion(gatewayMeetingCompletion(defaults));
}

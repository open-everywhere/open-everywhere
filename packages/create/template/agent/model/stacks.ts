import type { ModelTier } from "@open-everywhere/core/agent/memory/domain.js";
import type { TranscriptionRoleSpec } from "@open-everywhere/adapters/agent/model/transcription-routes.js";

export type ModelRole = "primary" | "utility" | "vision" | "supervisor" | "judge";

export interface ModelRoleSpec {
  readonly id: string;
  readonly tier: ModelTier;
  readonly contextWindowTokens: number;
  readonly via?: string;
}

export type ModelStack = Readonly<Record<ModelRole, ModelRoleSpec>>;

export const STACKS = {
  "chinese-open-weights": {
    primary: { id: "deepseek/deepseek-v4.1-flash", tier: "high", contextWindowTokens: 1_000_000 },
    utility: { id: "deepseek/deepseek-v4.1-flash", tier: "low", contextWindowTokens: 1_000_000 },
    vision: { id: "alibaba/qwen3-vl-instruct", tier: "low", contextWindowTokens: 131_072 },
    supervisor: { id: "deepseek/deepseek-v4.1-flash", tier: "low", contextWindowTokens: 1_000_000 },
    judge: { id: "deepseek/deepseek-v4.1-flash", tier: "low", contextWindowTokens: 1_000_000 },
  },
  "american-closed": {
    primary: { id: "openai/gpt-6-luna", tier: "high", contextWindowTokens: 1_050_000 },
    utility: { id: "openai/gpt-6-luna", tier: "low", contextWindowTokens: 1_050_000 },
    vision: { id: "google/gemini-3.8-flash", tier: "low", contextWindowTokens: 1_000_000 },
    supervisor: { id: "openai/gpt-6-luna", tier: "low", contextWindowTokens: 1_050_000 },
    judge: { id: "openai/gpt-6-luna", tier: "low", contextWindowTokens: 1_050_000 },
  },
  "european-open-weights": {
    primary: { id: "mistral/mistral-small", tier: "high", contextWindowTokens: 262_144, via: "mistral" },
    utility: { id: "mistral/mistral-small", tier: "low", contextWindowTokens: 262_144, via: "mistral" },
    vision: { id: "mistral/mistral-small", tier: "low", contextWindowTokens: 262_144, via: "mistral" },
    supervisor: { id: "mistral/mistral-small", tier: "low", contextWindowTokens: 262_144, via: "mistral" },
    judge: { id: "mistral/mistral-small", tier: "low", contextWindowTokens: 262_144, via: "mistral" },
  },
} as const satisfies Record<string, ModelStack>;

export type StackAlias = keyof typeof STACKS;

export const STACK_ALIASES: readonly StackAlias[] = (Object.keys(STACKS) as StackAlias[]).sort();

export function compactionThresholdTokens(contextWindowTokens: number, thresholdPercent: number): number {
  return Math.max(1, Math.floor(contextWindowTokens * thresholdPercent));
}

export type StackOverrides = {
  readonly [R in ModelRole]?: Partial<ModelRoleSpec>;
};

export function isStackAlias(alias: string): alias is StackAlias {
  return Object.prototype.hasOwnProperty.call(STACKS, alias);
}

export function resolveStack(alias: string, overrides: StackOverrides = {}): ModelStack {
  if (!isStackAlias(alias)) {
    throw new Error(
      `open-everywhere: unknown model stack "${alias}" — the stacks are ${STACK_ALIASES.map((a) => `"${a}"`).join(", ")}. ` +
        `Add one in agent/model/stacks.ts, or set models.stack to one of them.`,
    );
  }
  const base = STACKS[alias];
  const out = {} as { -readonly [R in ModelRole]: ModelRoleSpec };
  for (const role of Object.keys(base) as ModelRole[]) {
    out[role] = { ...base[role], ...overrides[role] };
  }
  return out;
}

export const TRANSCRIPTION = {
  "chinese-open-weights": {
    primary: { via: "deepinfra", id: "Qwen/Qwen3-ASR-1.7B" },
    fallback: { via: "self-hosted", id: "Qwen/Qwen3-ASR-1.7B", baseUrl: "http://qwen3-asr:8000/v1" },
  },
  "american-closed": {
    primary: { via: "gateway", id: "microsoft/mai-transcribe-2" },
    fallback: { via: "gateway", id: "spacexai/grok-stt" },
  },
  "european-open-weights": {
    primary: { via: "self-hosted", id: "mistralai/Voxtral-Mini-3B-2507", baseUrl: "http://voxtral:8000/v1" },
    fallback: { via: "self-hosted", id: "Qwen/Qwen3-ASR-1.7B", baseUrl: "http://qwen3-asr:8000/v1" },
  },
} as const satisfies Record<StackAlias, TranscriptionRoleSpec>;

export const LOCAL_TRANSCRIPTION = {
  primary: { via: "self-hosted", id: "Qwen/Qwen3-ASR-1.7B", baseUrl: "http://qwen3-asr:8000/v1" },
} as const satisfies TranscriptionRoleSpec;

export const TRANSCRIPTION_PLACEMENT: "stack" | "local" = "stack";

export function resolveTranscription(alias: string, placement: "stack" | "local" = TRANSCRIPTION_PLACEMENT): TranscriptionRoleSpec {
  if (placement === "local") return LOCAL_TRANSCRIPTION;
  if (!isStackAlias(alias)) throw new Error(`open-everywhere: unknown model stack "${alias}" — no transcription role`);
  return TRANSCRIPTION[alias];
}

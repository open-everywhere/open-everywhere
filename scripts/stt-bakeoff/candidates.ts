import { readFileSync } from "node:fs";
import { generateText, gateway } from "ai";
import { routeTransport, type TimedTranscript, type TranscriptionRouteSpec } from "@open-everywhere/adapters/agent/model/transcription-routes.js";
import { TRANSCRIPTION } from "../../agent/model/stacks.js";

export const CATALOGUE_PATH = new URL("../fixtures/stt-bakeoff/catalogue.json", import.meta.url);

export interface Catalogue {
  readonly gateway: readonly { id: string; type: string; zdr: string; pricing: Record<string, string> }[];
  readonly deepinfra: readonly { id: string; usdPerMinute: number }[];
}

export function loadCatalogue(): Catalogue {
  return JSON.parse(readFileSync(CATALOGUE_PATH, "utf8")) as Catalogue;
}

export interface Candidate {
  readonly name: string;
  readonly role: string;
  readonly route?: TranscriptionRouteSpec;
  readonly languageModel?: string;
}

export const GEMINI_AUDIO_PROMPT =
  "Transcribe this meeting audio verbatim, in the language spoken. Output only the transcript text, with no speaker labels, no timestamps and no commentary.";

export function candidates(selfHostedUrl?: string): Candidate[] {
  const ac = TRANSCRIPTION["american-closed"];
  const cow = TRANSCRIPTION["chinese-open-weights"];
  const out: Candidate[] = [
    { name: "mai", role: "american-closed primary", route: ac.primary },
    { name: "grok", role: "american-closed fallback", route: ac.fallback },
    { name: "qwen3-asr-deepinfra", role: "chinese-open-weights primary", route: cow.primary },
    { name: "gemini-3.8-flash", role: "baseline (audio as a file)", languageModel: "google/gemini-3.8-flash" },
    { name: "gpt-4o-transcribe", role: "baseline (no ZDR route)", route: { via: "gateway", id: "openai/gpt-4o-transcribe" } },
  ];
  if (selfHostedUrl !== undefined) out.push({ name: "qwen3-asr-self-hosted", role: "chinese-open-weights fallback / fully local", route: { ...cow.fallback, baseUrl: selfHostedUrl } });
  return out;
}

export function candidateCall(c: Candidate, deepinfraKey: string | undefined): (wav: Uint8Array) => Promise<TimedTranscript> {
  if (c.languageModel !== undefined) {
    const id = c.languageModel;
    return async (wav) => {
      const r = await generateText({
        model: gateway(id),
        messages: [{ role: "user", content: [{ type: "text", text: GEMINI_AUDIO_PROMPT }, { type: "file", mediaType: "audio/wav", data: wav }] }],
      });
      const cost = Number((r.providerMetadata?.gateway as Record<string, unknown> | undefined)?.cost);
      return { text: r.text.trim(), segments: [], words: [], ...(Number.isFinite(cost) ? { costUsd: cost } : {}) };
    };
  }
  const route = c.route!;
  const run = routeTransport(route, {
    secret: async () => {
      if (deepinfraKey === undefined) throw new Error("no DeepInfra key (set DEEPINFRA_API_KEY in the shell that runs the bake-off)");
      return deepinfraKey;
    },
  });
  return (wav) => run({ audio: wav, mediaType: "audio/wav" });
}

export function listPriceUsd(c: Candidate, seconds: number, cat: Catalogue = loadCatalogue()): number | undefined {
  const route = c.route;
  if (route?.via === "gateway") {
    const per = Number(cat.gateway.find((g) => g.id === route.id)?.pricing.transcription_duration_cost_per_second);
    return Number.isFinite(per) ? per * seconds : undefined;
  }
  if (route?.via === "deepinfra") {
    const pm = cat.deepinfra.find((g) => g.id === route.id)?.usdPerMinute;
    return pm === undefined ? undefined : (pm * seconds) / 60;
  }
  return undefined;
}

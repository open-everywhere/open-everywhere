import { getConfig } from "../access/config.js";
import { registeredWebhookVerifierSources } from "./verifier.js";
import { registeredEventSources } from "../routines/event-model.js";
import type { WebhookPosture } from "./runtime-hook.js";

export function runtimeHookSourceVocabulary(deps: {
  readonly verifiers?: () => readonly string[];
  readonly normalizers?: () => readonly string[];
  readonly declared?: () => readonly string[] | undefined;
} = {}): readonly string[] {
  const verifiers = new Set((deps.verifiers ?? registeredWebhookVerifierSources)());
  const normalizers = new Set((deps.normalizers ?? registeredEventSources)());
  const declared = (deps.declared ?? (() => getConfig().loadWebhookSources?.()))();
  const narrowing = declared === undefined ? undefined : new Set(declared);
  const out: string[] = [];
  for (const s of verifiers) {
    if (!normalizers.has(s)) continue;
    if (narrowing && !narrowing.has(s)) continue;
    out.push(s);
  }
  return out.sort();
}

export function unknownSourceRefusal(source: string, vocabulary: readonly string[]): string {
  return (
    `"${source}" isn't a webhook source this deployment can accept. ` +
    (vocabulary.length > 0 ? `Available right now: ${vocabulary.join(", ")}. ` : `No sources are available on this deployment yet. `) +
    `Adding one isn't something I can do from here — it needs a code change an admin merges: the source needs a ` +
    `signature verifier (so deliveries can be authenticated) and an event normalizer (so routines can subscribe to it), ` +
    `and for a vendor we already support that usually just means selecting its provider bundle. Ask an admin to open that PR.`
  );
}

export function runtimeHookTier(_posture: WebhookPosture): "member" | "admin" {
  return "member";
}

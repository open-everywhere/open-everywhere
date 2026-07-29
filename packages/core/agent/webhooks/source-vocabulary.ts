import { getConfig } from "../access/config.js";
import { acceptsMintedSecret, registeredWebhookVerifiers, type WebhookVerifier } from "./verifier.js";
import { registeredEventSources } from "../routines/event-model.js";

export interface SourceVocabularyDeps {
  readonly verifiers?: () => readonly WebhookVerifier[];
  readonly normalizers?: () => readonly string[];
  readonly declared?: () => readonly string[] | undefined;
}

function admissibleSchemes(deps: SourceVocabularyDeps): readonly string[] {
  const verifiers = (deps.verifiers ?? registeredWebhookVerifiers)();
  const normalizers = new Set((deps.normalizers ?? registeredEventSources)());
  const declared = (deps.declared ?? (() => getConfig().loadWebhookSources?.()))();
  const narrowing = declared === undefined ? undefined : new Set(declared);
  const out = new Set<string>();
  for (const v of verifiers) {
    if (!acceptsMintedSecret(v)) continue;
    if (!normalizers.has(v.source)) continue;
    if (narrowing && !narrowing.has(v.source)) continue;
    out.add(v.source);
  }
  return [...out].sort();
}

export function mintableSourceVocabulary(deps: SourceVocabularyDeps = {}): readonly string[] {
  return admissibleSchemes(deps);
}

export function unknownSourceRefusal(source: string, vocabulary: readonly string[]): string {
  return (
    `"${source}" isn't a webhook source this deployment can accept. ` +
    (vocabulary.length > 0 ? `Available right now: ${vocabulary.join(", ")}. ` : `No sources are available on this deployment yet. `) +
    `Adding one isn't something I can do from here — it needs a code change an admin merges: the source needs a ` +
    `signature verifier (so deliveries can be authenticated) and an event normalizer (so routines can subscribe to it), ` +
    `and for a vendor we already support that usually just means selecting its provider bundle. ` +
    `Some systems sign with a secret THEY generate rather than one we choose — none of those can be set up this way, ` +
    `so an operator has to declare the hook in configuration instead. Ask an admin to open that PR.`
  );
}

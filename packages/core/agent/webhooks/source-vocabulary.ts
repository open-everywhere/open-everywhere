import { getConfig } from "../access/config.js";
import { acceptsMintedSecret, registeredWebhookVerifiers, type WebhookVerifier } from "./verifier.js";
import { registeredEventSources } from "../routines/event-model.js";

export interface SourceVocabularyDeps {
  readonly verifiers?: () => readonly WebhookVerifier[];
  readonly normalizers?: () => readonly string[];
  readonly declared?: () => readonly string[] | undefined;
}

function admissibleSchemes(deps: SourceVocabularyDeps, requireMintable: boolean): readonly string[] {
  const verifiers = (deps.verifiers ?? registeredWebhookVerifiers)();
  const normalizers = new Set((deps.normalizers ?? registeredEventSources)());
  const declared = (deps.declared ?? (() => getConfig().loadWebhookSources?.()))();
  const narrowing = declared === undefined ? undefined : new Set(declared);
  const out = new Set<string>();
  for (const v of verifiers) {
    if (requireMintable && !acceptsMintedSecret(v)) continue;
    if (!normalizers.has(v.source)) continue;
    if (narrowing && !narrowing.has(v.source)) continue;
    out.add(v.source);
  }
  return [...out].sort();
}

export function declarableSourceVocabulary(deps: SourceVocabularyDeps = {}): readonly string[] {
  return admissibleSchemes(deps, false);
}

export function generalPurposeSchemes(deps: SourceVocabularyDeps = {}): readonly string[] {
  const byName = new Map((deps.verifiers ?? registeredWebhookVerifiers)().map((v) => [v.source, v]));
  return declarableSourceVocabulary(deps).filter((s) => byName.get(s)?.provider === undefined);
}

export function mintableSourceVocabulary(deps: SourceVocabularyDeps = {}): readonly string[] {
  return admissibleSchemes(deps, true);
}

export function unknownSourceRefusal(source: string, vocabulary: readonly string[]): string {
  return (
    `"${source}" isn't a webhook source this deployment can accept. ` +
    (vocabulary.length > 0 ? `Available right now: ${vocabulary.join(", ")}. ` : `No sources are available on this deployment yet. `) +
    `Adding one isn't something I can do from here — it needs a code change an admin merges: the source needs a ` +
    `signature verifier (so deliveries can be authenticated) and an event normalizer (so routines can subscribe to it), ` +
    `and for a vendor we already support that usually just means selecting its provider bundle. ` +
    `Some systems sign with a secret THEY generate rather than one we choose — once one of those has both halves it can be declared ` +
    `normally, but its secret has to be set by an operator (\`secretHome: "env"\`) because I can never issue that kind myself. ` +
    `Ask an admin to open that PR.`
  );
}

export function unmintableSourceRefusal(source: string, envRef: string): string {
  return (
    `I can declare a "${source}" webhook, but not with \`secretHome: "db"\`. ` +
    `"${source}" signs with a secret IT generates and hands to you, so a secret minted here would never verify a single delivery — ` +
    `the hook would be approved, its secret revealed, and then every delivery would 401 forever with nothing saying why. ` +
    `Ask me again with \`secretHome: "env"\` and this works: the declaration names the variable \`${envRef}\`, an operator puts ` +
    `the value "${source}" gave them into it and redeploys, and the hook authenticates. Nothing else about the request has to change.`
  );
}

export function unmintableRotationRefusal(hookId: string, source: string, ref: string): string {
  return (
    `I can't issue a secret for "${hookId}" — it declares \`source: "${source}"\`, and "${source}" signs with a secret IT generates ` +
    `and hands to you. Anything minted here would be a value "${source}" has never seen, so the secret would be revealed once and then ` +
    `every delivery would 401 forever with nothing saying why. Nothing was minted and nothing changed. ` +
    `The fix is one line in the declaration, by PR: give it \`broker: "env"\` with \`secretRef\` naming an environment variable ` +
    `(it names \`${ref}\` today), then an operator sets that variable to the value "${source}" gave them and redeploys, and the hook ` +
    `authenticates. If the value already lives in a home this deployment can read, name THAT home as the \`broker\` instead — ` +
    `what I can never do is choose the value myself.`
  );
}

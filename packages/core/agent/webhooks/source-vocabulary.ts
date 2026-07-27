import { getConfig } from "../access/config.js";
import { acceptsMintedSecret, registeredWebhookVerifiers, type WebhookVerifier } from "./verifier.js";
import { registeredEventSources } from "../routines/event-model.js";
import { webhookProvisioning, type WebhookProvisioning } from "./provisioning.js";
import type { WebhookPosture } from "./runtime-hook.js";

export interface SourceVocabularyDeps {
  readonly verifiers?: () => readonly WebhookVerifier[];
  readonly normalizers?: () => readonly string[];
  readonly declared?: () => readonly string[] | undefined;
  readonly provisioning?: (source: string) => WebhookProvisioning | undefined;
}

function admissibleSchemes(
  deps: SourceVocabularyDeps,
  admit: (v: WebhookVerifier, p: WebhookProvisioning | undefined) => boolean,
): readonly string[] {
  const verifiers = (deps.verifiers ?? registeredWebhookVerifiers)();
  const normalizers = new Set((deps.normalizers ?? registeredEventSources)());
  const declared = (deps.declared ?? (() => getConfig().loadWebhookSources?.()))();
  const narrowing = declared === undefined ? undefined : new Set(declared);
  const provisioningOf = deps.provisioning ?? webhookProvisioning;
  const out = new Set<string>();
  for (const v of verifiers) {
    if (!admit(v, provisioningOf(v.source))) continue;
    if (!normalizers.has(v.source)) continue;
    if (narrowing && !narrowing.has(v.source)) continue;
    out.add(v.source);
  }
  return [...out].sort();
}

export function runtimeHookSourceVocabulary(deps: SourceVocabularyDeps = {}): readonly string[] {
  return admissibleSchemes(deps, (v) => acceptsMintedSecret(v));
}

export function runtimeHookCollectVocabulary(deps: SourceVocabularyDeps = {}): readonly string[] {
  return admissibleSchemes(
    deps,
    (v, p) =>
      v.keyKind === "shared-secret" && v.keyOrigin === "vendor-issued" && p?.acquisition === "collect",
  );
}

export function unknownSourceRefusal(source: string, vocabulary: readonly string[], collectVocabulary: readonly string[]): string {
  const vendorIssued =
    collectVocabulary.length > 0
      ? `Some systems sign with a secret THEY generate rather than one we choose. A few of those can still be set up from here — ` +
        `instead of me minting a key, you paste in the one they show you, through a private one-time page: ${collectVocabulary.join(", ")}. ` +
        `Anything else in that family can't be set up this way, and an operator has to declare the hook in configuration instead. Ask an admin to open that PR.`
      : `Some systems sign with a secret THEY generate rather than one we choose — none of those can be set up this way on this deployment, ` +
        `so an operator has to declare the hook in configuration instead. Ask an admin to open that PR.`;
  return (
    `"${source}" isn't a webhook source this deployment can accept. ` +
    (vocabulary.length > 0 ? `Available right now: ${vocabulary.join(", ")}. ` : `No sources are available on this deployment yet. `) +
    `Adding one isn't something I can do from here — it needs a code change an admin merges: the source needs a ` +
    `signature verifier (so deliveries can be authenticated) and an event normalizer (so routines can subscribe to it), ` +
    `and for a vendor we already support that usually just means selecting its provider bundle. ` +
    vendorIssued
  );
}

export function runtimeHookTier(_posture: WebhookPosture): "member" | "admin" {
  return "member";
}

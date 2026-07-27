import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SELECTED_PROVIDERS, SELECTED_PROVIDER_IDS } from "../agent/lib/providers.js";
import { declareProviderSelection } from "@open-everywhere/core/agent/adapter-api.js";
import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import {
  acceptsMintedSecret,
  registeredWebhookVerifiers,
  webhookVerifier,
} from "@open-everywhere/core/agent/webhooks/verifier.js";
import { declaredDeliveryId, eventNormalizer, registeredEventSources } from "@open-everywhere/core/agent/routines/event-model.js";
import { runtimeHookSourceVocabulary, unknownSourceRefusal } from "@open-everywhere/core/agent/webhooks/source-vocabulary.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

declareProviderSelection(SELECTED_PROVIDER_IDS);
for (const provider of SELECTED_PROVIDERS) provider.register();

await import("@open-everywhere/core/agent/webhooks/oe-hmac.js");

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const vocabulary = runtimeHookSourceVocabulary();
const verifiers = registeredWebhookVerifiers();
const normalizers = registeredEventSources();
console.log(`  live registries: verifiers=[${verifiers.map((v) => v.source).sort().join(", ")}] normalizers=[${normalizers.join(", ")}]`);
console.log(`  live vocabulary: [${vocabulary.join(", ")}]`);

ok(verifiers.length > 0, "the live VERIFIER registry is non-empty (otherwise every check below is vacuous)");
ok(normalizers.length > 0, "the live NORMALIZER registry is non-empty (otherwise every check below is vacuous)");

ok(
  vocabulary.length > 0,
  `🔴 the live vocabulary is EMPTY — create_webhook would refuse EVERY source on this deployment and look like a user error. ` +
    `verifiers=[${verifiers.map((v) => v.source).sort().join(", ")}] normalizers=[${normalizers.join(", ")}]`,
);

for (const source of vocabulary) {
  ok(webhookVerifier(source) !== undefined, `"${source}" has a registered VERIFIER (without one every delivery 401s)`);
  ok(eventNormalizer(source) !== undefined, `"${source}" has a registered NORMALIZER (without one no routine can ever subscribe)`);
}

for (const source of vocabulary) {
  const v = webhookVerifier(source)!;
  ok(
    acceptsMintedSecret(v),
    `🔴 "${source}" is chat-mintable but its verifier does not accept an OE-MINTED secret ` +
      `(keyOrigin=${v.keyOrigin}, keyKind=${v.keyKind}) — every delivery to a hook on this source would 401, forever`,
  );
}

{
  const unmintable = verifiers.filter((v) => !acceptsMintedSecret(v));
  ok(
    unmintable.length > 0,
    "at least one registered verifier is NOT OE-mintable — the invariant above discriminates, it is not a tautology. " +
      "If every verifier in the tree is now legitimately receiver-minted, re-express this leg against a synthetic entry; do NOT just delete it.",
  );
  for (const v of unmintable) {
    ok(!vocabulary.includes(v.source), `"${v.source}" (keyOrigin=${v.keyOrigin}) is registered but EXCLUDED from the vocabulary`);
  }
}

{
  const verifierOnly = verifiers.map((v) => v.source).filter((s) => !normalizers.includes(s));
  const normalizerOnly = normalizers.filter((s) => !verifiers.some((v) => v.source === s));
  ok(
    verifierOnly.length + normalizerOnly.length > 0,
    "this deployment really does carry HALF-registered sources (so the intersection is doing work). " +
      "If every registered source ever gains both halves, re-express this leg rather than deleting it — the intersection is the point.",
  );
  for (const s of [...verifierOnly, ...normalizerOnly]) ok(!vocabulary.includes(s), `half-registered "${s}" is NOT in the vocabulary`);
}

{
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(REPO_ROOT, "packages", "core", "agent", "tools", "create_webhook.ts"), "utf8");
  const describeBlock = /source:\s*z\s*[\s\S]*?\.describe\(\s*([\s\S]*?)\)\s*,\s*\n\s*posture:/.exec(src);
  ok(describeBlock !== null, "found create_webhook's `source` parameter description (if this fails the tool was restructured — re-anchor, do not delete)");
  const examples = [...(describeBlock?.[1] ?? "").matchAll(/"([a-z0-9][a-z0-9-]*)"/g)].map((m) => m[1]!);
  ok(examples.length > 0, "…and it names at least one worked example (an example is what the model reaches for first)");
  for (const example of examples) {
    ok(
      vocabulary.includes(example),
      `🔴 create_webhook offers "${example}" as an example source, but it is NOT in the live vocabulary [${vocabulary.join(", ")}] — the model would be pointed at a value that always refuses`,
    );
  }
}

{
  const refusal = unknownSourceRefusal("definitely-not-a-registered-source", vocabulary);
  for (const source of vocabulary) ok(refusal.includes(source), `the refusal names the live member "${source}"`);
  ok(/PR|merge/i.test(refusal), "the refusal names the PR path (an 'ask an admin' with no WHAT is a dead end)");
}

{
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  for (const source of vocabulary) {
    const norm = eventNormalizer(source)!;
    ok(
      typeof norm.deliveryIdHeader === "string" && norm.deliveryIdHeader.length > 0,
      `🔴 "${source}" is chat-mintable but its normalizer declares NO deliveryIdHeader — the durable delivery dedupe cannot run for it, ` +
        `and its verifier's signedTimestamp=${webhookVerifier(source)!.signedTimestamp} decides the other layer. A source with neither has ZERO replay defence (OPE-201).`,
    );
  }
  for (const source of vocabulary) {
    const header = eventNormalizer(source)!.deliveryIdHeader!;
    ok(
      declaredDeliveryId(source, { [header]: "SENTINEL-DELIVERY-ID" }) === "SENTINEL-DELIVERY-ID",
      `"${source}"'s declared header is actually READ by declaredDeliveryId (the seam every ingress uses)`,
    );
    ok(declaredDeliveryId(source, {}) === undefined, `"${source}" with the header ABSENT yields no id (not deduped, never synthesised)`);
  }

  const signed = vocabulary.filter((s) => webhookVerifier(s)!.signedTimestamp);
  ok(
    signed.length === 0,
    `🔴 source-vocabulary.ts's replay paragraph says NO chat-mintable source carries the signed single-use bound, but [${signed.join(", ")}] now does. ` +
      `That is GOOD NEWS and a REQUIRED EDIT: rewrite the paragraph to say which sources have layer 2, then re-express this assertion. Do not just delete it.`,
  );

  ok(vocabSrc.includes("deliveryIdHeader"), "the replay paragraph names the layer-1 condition (the normalizer's declared delivery-id header)");
  ok(vocabSrc.includes("signedTimestamp: true"), "the replay paragraph names the layer-2 condition (the verifier's signedTimestamp declaration)");
  ok(
    /best-effort bound and NOT the signed one/.test(vocabSrc),
    "the replay paragraph still states the measured conclusion verbatim — if you reword it, re-anchor this assertion rather than deleting it",
  );
  ok(
    !/inherit a best-effort replay bound/.test(vocabSrc),
    "🔴 the OPE-201 false sentence ('chat-created hooks inherit a best-effort replay bound') has NOT returned",
  );
}

console.log(`✓ webhook-source-vocabulary-live: ${n} assertions (the LIVE vocabulary is non-empty, doubly-registered, OE-mintable, replay-posture-measured, and matches what create_webhook advertises)`);

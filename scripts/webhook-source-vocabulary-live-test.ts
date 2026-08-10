import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SELECTED_PROVIDERS, SELECTED_PROVIDER_IDS } from "../agent/lib/providers.generated.js";
import { declareProviderSelection } from "@open-everywhere/core/agent/adapter-api.js";
import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import {
  acceptsMintedSecret,
  registeredWebhookVerifiers,
  webhookAuthCeiling,
  webhookVerifier,
} from "@open-everywhere/core/agent/webhooks/verifier.js";
import { declaredDeliveryId, eventNormalizer, registeredEventSources } from "@open-everywhere/core/agent/routines/event-model.js";
import { declarableSourceVocabulary, generalPurposeSchemes, mintableSourceVocabulary, unknownSourceRefusal, unmintableSourceRefusal } from "@open-everywhere/core/agent/webhooks/source-vocabulary.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

declareProviderSelection(SELECTED_PROVIDER_IDS);
for (const provider of SELECTED_PROVIDERS) provider.register();

await import("@open-everywhere/core/agent/webhooks/oe-standard-webhook.js");

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const vocabulary = mintableSourceVocabulary();
const declarable = declarableSourceVocabulary();
const verifiers = registeredWebhookVerifiers();
const normalizers = registeredEventSources();
console.log(`  live registries: verifiers=[${verifiers.map((v) => v.source).sort().join(", ")}] normalizers=[${normalizers.join(", ")}]`);
console.log(`  live DECLARABLE vocabulary: [${declarable.join(", ")}]`);
console.log(`  live MINTABLE   vocabulary: [${vocabulary.join(", ")}]`);

ok(verifiers.length > 0, "the live VERIFIER registry is non-empty (otherwise every check below is vacuous)");
ok(normalizers.length > 0, "the live NORMALIZER registry is non-empty (otherwise every check below is vacuous)");

ok(
  vocabulary.length > 0,
  `🔴 the live vocabulary is EMPTY — declare_webhook would refuse EVERY source on this deployment and look like a user error. ` +
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
  for (const s of [...verifiers.map((v) => v.source), ...normalizers]) {
    const bothHalves = verifiers.some((v) => v.source === s) && normalizers.includes(s);
    if (!bothHalves) ok(!vocabulary.includes(s), `half-registered "${s}" is NOT in the vocabulary`);
  }

  const probeVerifier = { source: "probe-verifier-only", keyKind: "shared-secret", keyOrigin: "receiver-minted", signedTimestamp: true, verify: () => ({ ok: false, failure: "missing-signature" }) } as const;
  const withProbes = mintableSourceVocabulary({
    verifiers: () => [...verifiers, probeVerifier as unknown as (typeof verifiers)[number]],
    normalizers: () => [...normalizers, "probe-normalizer-only"],
    declared: () => undefined,
  });
  ok(!withProbes.includes("probe-verifier-only"), "🔴 a source with a VERIFIER and no normalizer is excluded — it would authenticate and then route nowhere");
  ok(!withProbes.includes("probe-normalizer-only"), "🔴 a source with a NORMALIZER and no verifier is excluded — nothing could authenticate a delivery to it");
  ok(
    withProbes.join(",") === vocabulary.join(","),
    "…and neither probe changed the live answer, so the intersection is what decides membership rather than either list alone",
  );
}

{
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(REPO_ROOT, "packages", "core", "agent", "tools", "declare_webhook.ts"), "utf8");
  const describeBlock = /source:\s*z\s*[\s\S]*?\.describe\(\s*([\s\S]*?)\)\s*,\s*\n\s*target:/.exec(src);
  ok(describeBlock !== null, "found declare_webhook's `source` parameter description (if this fails the tool was restructured — re-anchor, do not delete)");
  const examples = [...(describeBlock?.[1] ?? "").matchAll(/"([a-z0-9][a-z0-9-]*)"/g)].map((m) => m[1]!);
  ok(examples.length > 0, "…and it names at least one worked example (an example is what the model reaches for first)");
  for (const example of examples) {
    ok(
      declarable.includes(example),
      `🔴 declare_webhook offers "${example}" as an example source, but it is NOT in the live DECLARABLE vocabulary [${declarable.join(", ")}] — the model would be pointed at a value that always refuses`,
    );
  }
  ok(
    examples.some((e) => vocabulary.includes(e)),
    `🔴 NO example source is chat-MINTABLE [mintable=${vocabulary.join(", ")}] — the \`secretHome: "db"\` recipe would have no worked example the model could reach for`,
  );
  ok(
    examples.some((e) => vocabulary.includes(e) && e !== "github"),
    "…and at least one of them is a contract that is not a named vendor — the category-(b) path the parameter exists for",
  );
}

{
  const refusal = unknownSourceRefusal("definitely-not-a-registered-source", declarable);
  for (const source of declarable) ok(refusal.includes(source), `the refusal names the live declarable member "${source}"`);
  ok(/PR|merge/i.test(refusal), "the refusal names the PR path (an 'ask an admin' with no WHAT is a dead end)");

  ok(
    !refusal.includes("none of those can be set up this way"),
    "🔴 the pre-OPE-238 dead end has NOT returned — a vendor-issued source IS declarable, it just cannot have its secret minted here",
  );
  ok(
    !refusal.includes("an operator has to declare the hook in configuration instead"),
    "🔴 …nor the sentence that sent the caller to have an operator declare the hook in config — declare_webhook IS that path, so the refusal was pointing at itself",
  );
  ok(/secretHome: "env"/.test(refusal), "the refusal names the arm that DOES work for a vendor-issued secret, by parameter");
  for (const source of vocabulary) {
    ok(acceptsMintedSecret(webhookVerifier(source)!), `live mintable member "${source}" accepts an OE-MINTED key — which is what makes the refusal's vendor-issued sentence true`);
  }
}

{
  ok(declarable.length > 0, "the live DECLARABLE vocabulary is non-empty (otherwise every check below is vacuous)");
  for (const source of vocabulary) ok(declarable.includes(source), `🔴 mintable member "${source}" is also declarable — mintable ⊆ declarable, always`);

  const envOnly = declarable.filter((s) => !vocabulary.includes(s));
  console.log(`  env-only (declarable, NOT mintable): [${envOnly.join(", ")}]`);
  ok(
    envOnly.length > 0,
    "🔴 NOTHING is declarable-but-not-mintable on this tree, so the split measures nothing. If every registered source is now legitimately receiver-minted, re-express this leg against a synthetic entry; do NOT just delete it.",
  );
  for (const source of envOnly) {
    const v = webhookVerifier(source)!;
    ok(v !== undefined, `env-only "${source}" has a registered VERIFIER — the condition that was NOT waived`);
    ok(eventNormalizer(source) !== undefined, `env-only "${source}" has a registered NORMALIZER — the other condition that was NOT waived`);
    ok(!acceptsMintedSecret(v), `env-only "${source}" is excluded from MINTABLE on key provenance alone (keyOrigin=${v.keyOrigin}, keyKind=${v.keyKind}) — which is the whole reason the two sets differ`);
  }
  for (const v of verifiers) {
    if (normalizers.includes(v.source)) continue;
    ok(!declarable.includes(v.source), `🔴 "${v.source}" has a verifier but NO normalizer, so it is absent from the DECLARABLE set too — the env arm waived key provenance, nothing else`);
    ok(!vocabulary.includes(v.source), `…and from the mintable set`);
  }

  for (const source of envOnly) {
    const um = unmintableSourceRefusal(source, `OE_WEBHOOK_${source.toUpperCase()}_SECRET`);
    ok(/secretHome: "env"/.test(um), `the db refusal for "${source}" names the parameter that makes the request work`);
    ok(um.includes(`OE_WEBHOOK_${source.toUpperCase()}_SECRET`), `…and the exact variable an operator sets for "${source}"`);
  }

  const general = generalPurposeSchemes();
  console.log(`  general-purpose contracts: [${general.join(", ")}]`);
  ok(general.length > 0, "🔴 at least one general-purpose contract is registered — it is the ONLY route for a sender with no adapter, and declare_webhook's hint points at it");
  for (const s of general) {
    ok(declarable.includes(s), `general-purpose "${s}" is declarable`);
    ok(webhookVerifier(s)!.provider === undefined, `…and carries no \`provider\`, which is what makes it general-purpose rather than a vendor's scheme`);
  }
  for (const v of verifiers) {
    if (v.provider === undefined) continue;
    ok(!general.includes(v.source), `🔴 vendor-bundled "${v.source}" (provider=${v.provider}) is NOT offered as a general-purpose contract — advising a CI job to sign that way would be false`);
  }
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
  const unsigned = vocabulary.filter((s) => !webhookVerifier(s)!.signedTimestamp);
  console.log(`  layer-2 (signed single-use) mintable sources: [${signed.join(", ")}]; layer-1 only: [${unsigned.join(", ")}]`);
  ok(
    signed.length > 0,
    `🔴 NO chat-mintable source carries the signed single-use bound any more — [${vocabulary.join(", ")}]. That is a REGRESSION of OPE-196: ` +
      `the category-(b) contract was the first source to have it, so either its registration stopped happening or its verifier stopped declaring signedTimestamp.`,
  );
  for (const source of signed) {
    ok(acceptsMintedSecret(webhookVerifier(source)!), `"${source}" carries layer 2 AND is OE-mintable (a layer-2 source that is not mintable is not in this class at all)`);
  }
}

{
  console.log("\n7. the authentication-strength ladder, measured against the live registry:");
  const verifiers = registeredWebhookVerifiers();
  const byGrade = new Map<string, string[]>();
  for (const v of verifiers) byGrade.set(webhookAuthCeiling(v), [...(byGrade.get(webhookAuthCeiling(v)) ?? []), v.source]);
  for (const [grade, sources] of [...byGrade].sort()) console.log(`  ceiling "${grade}": [${sources.sort().join(", ")}]`);

  ok(verifiers.length > 0, "the live registry has verifiers at all (otherwise everything below is vacuous)");
  ok(
    (byGrade.get("signed-fresh") ?? []).length > 0,
    `🔴 NO registered source can reach the "signed-fresh" floor — a hook declaring it would 401 forever on every source. ` +
      `Either the category-(b) contract stopped registering, or its verifier stopped declaring signedTimestamp.`,
  );
  ok(
    (byGrade.get("signed") ?? []).length > 0,
    `🔴 NO registered source sits at "signed" — every source reaching the top rung makes a declared floor decoration, ` +
      `since nothing could ever be refused by one. The ladder must PARTITION the live set to be worth declaring.`,
  );
  ok(!byGrade.has("unverified"), '🔴 no registered scheme has an "unverified" CEILING — that grade is an ATTAINMENT (the dev hatch), never a property a scheme can offer');
  for (const v of verifiers) {
    ok(
      webhookAuthCeiling(v) === (v.signedTimestamp ? "signed-fresh" : "signed"),
      `"${v.source}"'s ceiling follows its OWN signedTimestamp declaration (signedTimestamp=${v.signedTimestamp}) — the gate reads the same function`,
    );
  }
  for (const v of verifiers) {
    ok(
      (webhookAuthCeiling(v) === "signed-fresh") === v.signedTimestamp,
      `"${v.source}" is at the "signed-fresh" ceiling exactly when it carries the signed single-use replay bound — the floor cannot promise a defence the source lacks`,
    );
  }
}

console.log(
  `✓ webhook-source-vocabulary-live: ${n} assertions (the LIVE vocabulary is non-empty, doubly-registered, OE-mintable, replay-posture-measured, strength-ladder-partitioned, and matches what declare_webhook advertises)`,
);

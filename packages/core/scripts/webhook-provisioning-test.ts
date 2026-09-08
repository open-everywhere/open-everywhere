import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

const dir = join(tmpdir(), `oe-webhook-prov-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });
const ORG = "default";
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.OE_INTAKE_PAGE_SIGNING_KEY = randomBytes(32).toString("base64");
process.env.OE_PUBLIC_BASE_URL = "https://oe.example.test";

await import("./_register-test-config.js");
const { registerConfig: registerTestConfig, getConfig: getTestConfig } = await import("../agent/access/config.js");
const bootstrapped = getTestConfig();
let domainlessDeployment = false;
registerTestConfig({
  ...bootstrapped,
  domainsForSurface: ({ workspaceKey, surface }) => (domainlessDeployment || `${workspaceKey}/${surface}` !== "slack/T1/C1" ? [] : ["eng"]),
});
const vocab = await import("../agent/webhooks/source-vocabulary.js");
const verifierMod = await import("../agent/webhooks/verifier.js");
type WebhookVerifier = import("../agent/webhooks/verifier.js").WebhookVerifier;
const revealMod = await import("../agent/webhooks/reveal-page.js");
const { hasPrivateDeliveryPath } = await import("../agent/tools/rotate_webhook.js");
const { hasApprovalCardPath } = await import("../agent/tools/set_spend_limit.js");
const { registerCardPoster } = await import("../agent/approvals/flow.js");
const { setRevealDeliveryDepsForTest } = await import("../agent/approvals/webhook.js");
const { actionKind } = await import("../agent/approvals/actions.js");
await import("../agent/approvals/flow.js");
const { encryptedKvVault } = await import("../agent/credentials/kv-vault.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { TOOL_CONSEQUENCE } = await import("../agent/access/consequence.js");
const { WINDOW_UNGATED_TOOLS, JOB_WAKE_TOOLS } = await import("../agent/access/window-gate-manifest.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const store = getOperationalStore();
const vault = encryptedKvVault();
const SURFACE = "slack/T1/C1";
const REQUESTER = "U-ASKER";
const DECIDER = "U-ADMIN";

const delivered: { channelId: string; userId: string; text: string }[] = [];
setRevealDeliveryDepsForTest({
  postPrivate: async (channelId, userId, text) => {
    delivered.push({ channelId, userId, text });
    return true;
  },
});

const rotateKind = actionKind("webhook.rotate")!;

{
  console.log("\n1. source vocabulary (OPE-159):");
  const fake = (source: string, keyOrigin: "receiver-minted" | "vendor-issued" = "receiver-minted", keyKind: "shared-secret" | "public-key" = "shared-secret"): WebhookVerifier => ({
    source,
    keyKind,
    keyOrigin,
    signedTimestamp: false,
    verify: () => ({ ok: false, failure: "signature-mismatch" }),
  });
  const V = () => [fake("github"), fake("notion"), fake("verifier-only")];
  const N = () => ["github", "notion", "linear"];
  eq(vocab.mintableSourceVocabulary({ verifiers: V, normalizers: N, declared: () => undefined }), ["github", "notion"], "the vocabulary is the INTERSECTION of verifiers ∩ normalizers");
  ok(!vocab.mintableSourceVocabulary({ verifiers: V, normalizers: N, declared: () => undefined }).includes("verifier-only"), "a source with a verifier but NO normalizer is not mintable (nothing could subscribe)");
  ok(!vocab.mintableSourceVocabulary({ verifiers: V, normalizers: N, declared: () => undefined }).includes("linear"), "a source with a normalizer but NO verifier is not mintable (it would 401 forever)");
  eq(vocab.mintableSourceVocabulary({ verifiers: V, normalizers: N, declared: () => ["notion"] }), ["notion"], "the operator's declared list NARROWS the intersection");
  eq(vocab.mintableSourceVocabulary({ verifiers: V, normalizers: N, declared: () => ["stripe"] }), [], "the declared list can NEVER ADD a source with no verifier (narrowing-only)");
  eq(vocab.mintableSourceVocabulary({ verifiers: () => [], normalizers: N, declared: () => undefined }), [], "no verifiers ⇒ nothing is mintable");

  const VK = () => [fake("github"), fake("vendor-token", "vendor-issued"), fake("asym", "receiver-minted", "public-key")];
  const NK = () => ["github", "vendor-token", "asym"];
  eq(
    vocab.mintableSourceVocabulary({ verifiers: VK, normalizers: NK, declared: () => undefined }),
    ["github"],
    "🔴 a source with BOTH halves is still NOT mintable when its verifier can't take an OE-minted secret",
  );
  ok(verifierMod.acceptsMintedSecret(fake("x")) === true, "acceptsMintedSecret: a receiver-minted shared secret qualifies");
  ok(verifierMod.acceptsMintedSecret(fake("x", "vendor-issued")) === false, "acceptsMintedSecret: a vendor-ISSUED shared secret does not (we cannot choose the value)");
  ok(verifierMod.acceptsMintedSecret(fake("x", "receiver-minted", "public-key")) === false, "acceptsMintedSecret: an ASYMMETRIC scheme does not (there is no shared secret to mint)");

  {
    const declarable = vocab.declarableSourceVocabulary({ verifiers: VK, normalizers: NK, declared: () => undefined });
    const mintable = vocab.mintableSourceVocabulary({ verifiers: VK, normalizers: NK, declared: () => undefined });
    eq(declarable, ["asym", "github", "vendor-token"], "🔴 a vendor-issued or asymmetric source with BOTH halves IS declarable — its secret is just one an operator sets");
    ok(
      mintable.every((s) => declarable.includes(s)),
      "🔴 mintable ⊆ declarable — the ONE invariant that makes this a NARROWING of where a check applies rather than a relaxation of what it decides",
    );
    ok(mintable.length < declarable.length, "…and the containment is STRICT here, so the assertion above is not vacuous");

    ok(!declarable.includes("verifier-only"), "🔴 a source with a verifier and NO normalizer is NOT declarable either — it would authenticate and route nowhere");
    ok(
      !vocab.declarableSourceVocabulary({ verifiers: V, normalizers: N, declared: () => undefined }).includes("linear"),
      "🔴 a source with a normalizer and NO verifier is NOT declarable either — every delivery would 401",
    );
    eq(
      vocab.declarableSourceVocabulary({ verifiers: VK, normalizers: NK, declared: () => ["vendor-token"] }),
      ["vendor-token"],
      "🔴 the operator's declared list narrows the DECLARABLE set too (it is a rule about what may be named, not about who holds the key)",
    );
    eq(vocab.declarableSourceVocabulary({ verifiers: VK, normalizers: NK, declared: () => [] }), [], "…and an EMPTY operator list means nothing is declarable, not everything");

    const withProvider = { ...fake("github"), provider: "github" } as WebhookVerifier;
    eq(
      vocab.generalPurposeSchemes({ verifiers: () => [withProvider, fake("oe-standard-webhook")], normalizers: () => ["github", "oe-standard-webhook"], declared: () => undefined }),
      ["oe-standard-webhook"],
      "🔴 a vendor bundle's verifier is NOT offered as a general-purpose contract — only an entry with no `provider`",
    );
  }

  const refusal = vocab.unknownSourceRefusal("stripe", ["github", "notion"]);
  ok(refusal.includes("github, notion"), "🔴 the refusal NAMES the legal set — the error message IS the vocabulary");
  ok(/PR|merge/i.test(refusal), "…and names the PR path (an 'ask an admin' with no WHAT is a dead end)");
  ok(vocab.unknownSourceRefusal("stripe", []).includes("No sources are available"), "an empty vocabulary refuses honestly rather than naming an empty list");
  ok(!/none of those can be set up this way/.test(refusal), "🔴 the pre-OPE-238 dead end ('none of those can be set up this way') is GONE — it stopped being true when declare_webhook shipped an env default");
  ok(/secretHome: "env"/.test(refusal), "…and the vendor-issued sentence names the arm that DOES work, by parameter");
  ok(/can never issue that kind myself/.test(refusal), "…while still stating plainly that WE never issue a vendor's secret (the OPE-186 fact, undiminished)");
  ok(!/an operator has to declare the hook in configuration instead/.test(refusal), "🔴 the refusal no longer sends the caller to 'have an operator declare it in configuration' — that IS this tool, so it pointed at itself (OPE-238)");

  {
    const um = vocab.unmintableSourceRefusal("notion", "OE_WEBHOOK_NOTION_EVENTS_SECRET");
    ok(/secretHome: "env"/.test(um), '🔴 it names the ONE parameter that makes the request work — `secretHome: "env"`');
    ok(um.includes("OE_WEBHOOK_NOTION_EVENTS_SECRET"), "…and the exact variable an operator sets, so the follow-up step needs no second conversation");
    ok(/I can declare a "notion" webhook/.test(um), "…and opens by saying the hook IS declarable, so the caller does not read it as a flat no");
    ok(/401 forever/.test(um), "…and states WHY db is refused — OPE-186's argument, in the one place its antecedent holds");
    ok(!/\bPRs?\b|\bmerges?\b|\badmins?\b/i.test(um), "🔴 it does NOT send the caller for a code change or a second person — the escape is one field away in this same call");
  }

  {
    const ur = vocab.unmintableRotationRefusal("notion-events", "notion", "db:webhook:notion-events");
    ok(/\bPR\b/.test(ur), '🔴 it names the PR, because a declaration is config and config only changes by merged diff');
    ok(/`broker: "env"`/.test(ur), "…and the exact field to change, so the next step needs no second conversation");
    ok(ur.includes("db:webhook:notion-events"), "…and the ref the declaration names today, so the operator can find the line");
    ok(/Nothing was minted and nothing changed/.test(ur), "…and states plainly that the click had no effect — the house sentence every rotate refusal ends on");
    ok(/401 forever/.test(ur), "…and WHY, which is OPE-186's argument at the one site whose antecedent it is about");
    ok(!/secretHome/.test(ur), "🔴 it does NOT offer `secretHome` — that is a `declare_webhook` parameter, and the reader is not making that call");
    ok(/can never do is choose the value/.test(ur), "🔴 it refuses to CHOOSE the value, and does not claim a db-homed vendor-issued hook is meaningless");
  }

}

{
  console.log("\n2. tiers + manifests:");
  eq(rotateKind.policy, "member", "webhook.rotate is MEMBER (OPE-159 supersedes the OPE-150 flat admin tier)");
  eq(actionKind("webhook.declare")?.policy, "member", "webhook.declare is MEMBER — the card's tap is the injection gate, the MERGE is the privilege gate");

  for (const [tool, kind] of [
    ["declare_webhook", "webhook.declare"],
    ["rotate_webhook", "webhook.rotate"],
  ] as const) {
    const entry = TOOL_CONSEQUENCE[tool]!;
    eq(entry.tier, "gate:member", `${tool} declares gate:member`);
    eq(entry.via.kind, "action-kind", `🔴 …through an ACTION-KIND mechanism, which is what subjects it to the cross-plane check`);
    eq(entry.via.kind === "action-kind" ? entry.via.action : undefined, kind, `🔴 …naming "${kind}" specifically, so consequence.ts and the ActionKind cannot drift unnoticed`);
  }

  for (const kind of ["webhook.rotate", "webhook.declare", "routine.create", "memory.purge"]) {
    const def = actionKind(kind);
    ok(def !== undefined && typeof def.policy === "string", `🔴 ${kind}'s approver tier is a per-KIND constant, not a function of the frozen args`);
  }

  ok(actionKind("webhook.create") === undefined, "🔴 there is no `webhook.create` kind — a hook is created by a merged PR, never by a click");
  ok(actionKind("webhook.revoke") === undefined, "🔴 …and no `webhook.revoke` — a hook is removed by another PR");
  for (const t of ["create_webhook", "revoke_webhook"]) {
    ok(TOOL_CONSEQUENCE[t] === undefined, `🔴 ${t} has NO consequence row — the tool is gone, and a row describing a tool that does not exist is how a deleted capability quietly comes back`);
    ok(!WINDOW_UNGATED_TOOLS.has(t), `🔴 ${t} is mounted on no grain`);
  }

  ok(TOOL_CONSEQUENCE["rotate_webhook"] !== undefined, "rotate_webhook has a consequence row");
  ok(WINDOW_UNGATED_TOOLS.has("rotate_webhook"), "rotate_webhook mounts on every grain (its control is consequence, not hands)");
  ok(!JOB_WAKE_TOOLS.has("rotate_webhook"), "🔴 rotate_webhook is NOT in the job-wake kit — an unattended wake has nobody to hand a secret to");
  ok(TOOL_CONSEQUENCE["list_webhooks"] !== undefined, "list_webhooks has a consequence row");
  ok(WINDOW_UNGATED_TOOLS.has("list_webhooks") && JOB_WAKE_TOOLS.has("list_webhooks"), "list_webhooks is a read and is available everywhere");
}

{
  console.log("\n3. private-delivery precondition:");
  ok(hasPrivateDeliveryPath("slack"), "Slack has a private delivery path (chat.postEphemeral)");
  ok(!hasPrivateDeliveryPath("discord"), "🔴 Discord does NOT — its ephemeral needs an interaction token core cannot reach");
  for (const p of ["teams", "github", "linear", "notion"]) ok(!hasPrivateDeliveryPath(p), `${p} has no private delivery path`);
  registerCardPoster("discord", async () => undefined);
  ok(hasApprovalCardPath("discord") && !hasPrivateDeliveryPath("discord"), "🔴 the two predicates already DISAGREE, so neither can be silently reused for the other");
  ok(revealMod.revealPageAvailable(), "the reveal page is armed in this test deployment");
}

{
  console.log("\n6b. webhook.rotate — arming and rotating a declared hook's secret:");
  const configRef = "db:webhook:ci-status";
  const declared = {
    id: "ci-status",
    source: "oe-standard-webhook",
    secretRef: configRef,
    broker: "db",
    readableBy: [{ level: "domain" as const, domain: "eng" }],
  };
  const envHook = { ...declared, id: "env-status", secretRef: "OE_WEBHOOK_ENV_STATUS_SECRET", broker: "env" };
  const twinA = { ...declared, id: "twin-a" };
  const twinB = { ...declared, id: "twin-b" };
  const withHooks = (hooks: readonly unknown[]) => {
    const cur = getTestConfig();
    registerTestConfig({ ...cur, loadWebhooks: () => hooks as never });
  };
  const rotateArgs = (id: string) => ({
    org: ORG,
    hookId: id,
    posture: "content-bearing" as const,
    surfaceKey: SURFACE,
    requestedBy: REQUESTER,
    platform: "slack",
    channelId: "C1",
  });

  const card = rotateKind.summarize(rotateArgs("ci-status")).join("\n");
  ok(!/24h/.test(card) && !/grace period/i.test(card), "🔴 the card promises NO timed grace period — a declared hook's overlap is a second `secretRef` in a config file, not a clock we own");
  ok(/second `secretRef`/.test(card), "…it names what the overlap actually is, so the human can tell whether they have one");
  ok(/never had one/.test(card), "…and covers the ARM case, because a `broker: \"db\"` hook has no value at all until this runs");

  withHooks([declared, envHook]);
  delivered.length = 0;
  const armed = await rotateKind.execute(rotateArgs("ci-status"), DECIDER);
  const first = await vault.read(configRef);
  ok(typeof first === "string" && first.length > 0, "arming stored a secret at the DECLARED ref");
  ok(!armed.includes(first!), "🔴 the public outcome line does not contain the secret");
  ok(/nothing needed redeploying/i.test(armed), "…and says the property the db home exists for");
  eq(delivered.length, 1, "one private one-time link was delivered");
  ok(!delivered[0]!.text.includes(first!), "…carrying only the link, never the value");

  const { resolveHookKeys } = await import("../agent/webhooks/secrets.js");
  const { registerDbCredentialBroker } = await import("../agent/credentials/db-broker.js");
  registerDbCredentialBroker();
  eq(await resolveHookKeys(declared as never), [first], "🔴 the gate resolves exactly the armed value through the hook's declared broker — no redeploy, no env var");

  const rotated = await rotateKind.execute(rotateArgs("ci-status"), DECIDER);
  const second = await vault.read(configRef);
  ok(second !== first, "rotating replaced the value");
  ok(/stopped being accepted just now/.test(rotated), "🔴 with one declared ref the outcome says the old value is dead NOW — a card that implied an overlap it does not have would strand a live sender");

  const refusedEnv = await rotateKind.execute(rotateArgs("env-status"), DECIDER);
  ok(/can't issue a secret/.test(refusedEnv) && /redeploys/.test(refusedEnv), "🔴 a `broker: \"env\"` hook is refused by name, and the refusal states the operator's actual next step");
  ok(await vault.read("OE_WEBHOOK_ENV_STATUS_SECRET") === null, "…and nothing was written anywhere");

  withHooks([twinA, twinB]);
  const before = await vault.read(configRef);
  const refusedShare = await rotateKind.execute(rotateArgs("twin-a"), DECIDER);
  ok(/twin-b/.test(refusedShare), "🔴 a ref another declaration also names is refused, naming the hook that would have broken");
  eq(await vault.read(configRef), before, "…and NOTHING was written — the refusal is before every write, not after the first");

  {
    const scheme = (source: string, keyOrigin: "receiver-minted" | "vendor-issued", keyKind: "shared-secret" | "public-key"): WebhookVerifier => ({
      source,
      keyKind,
      keyOrigin,
      signedTimestamp: false,
      verify: () => ({ ok: false, failure: "signature-mismatch" }),
    });
    verifierMod.registerWebhookVerifier(scheme("vendor-signed", "vendor-issued", "shared-secret"));
    verifierMod.registerWebhookVerifier(scheme("asym-signed", "receiver-minted", "public-key"));
    verifierMod.registerWebhookVerifier(scheme("receiver-signed", "receiver-minted", "shared-secret"));

    const handWritten = (id: string, source: string) => ({ ...declared, id, source, secretRef: `db:webhook:${id}` });
    const vendorHook = handWritten("vendor-hook", "vendor-signed");
    const asymHook = handWritten("asym-hook", "asym-signed");
    const okHook = handWritten("ok-hook", "receiver-signed");
    const unknownHook = handWritten("unknown-hook", "no-verifier-in-this-process");
    withHooks([vendorHook, asymHook, okHook, unknownHook]);
    delivered.length = 0;

    const refusedVendor = await rotateKind.execute(rotateArgs("vendor-hook"), DECIDER);
    ok(/can't issue a secret for "vendor-hook"/.test(refusedVendor), '🔴 a `{ source: <vendor-issued>, broker: "db" }` hook is refused BY NAME at the mint — the broker was checked, key provenance was not (OPE-244)');
    ok(/`broker: "env"`/.test(refusedVendor) && /\bPR\b/.test(refusedVendor), "…and the refusal names the config change and who makes it, rather than pointing at a dead end (OPE-238's lesson)");
    eq(await vault.read("db:webhook:vendor-hook"), null, "🔴 …and NOTHING was written — the refusal is before every write, like the shared-ref one");
    eq(delivered.length, 0, "…and no one-time reveal link was minted or delivered, so nothing disclosed a useless secret");

    const refusedAsym = await rotateKind.execute(rotateArgs("asym-hook"), DECIDER);
    ok(/can't issue a secret for "asym-hook"/.test(refusedAsym), "🔴 an ASYMMETRIC scheme is refused too — the guard reads `acceptsMintedSecret`, whose OTHER clause this is");
    eq(await vault.read("db:webhook:asym-hook"), null, "…writing nothing there either");

    await rotateKind.execute(rotateArgs("ok-hook"), DECIDER);
    ok(typeof (await vault.read("db:webhook:ok-hook")) === "string", '🔴 a REGISTERED receiver-minted shared-secret source still mints — the guard refuses a scheme, never `broker: "db"`');
    eq(delivered.length, 1, "…and that one still gets its private one-time link");

    await rotateKind.execute(rotateArgs("unknown-hook"), DECIDER);
    ok(typeof (await vault.read("db:webhook:unknown-hook")) === "string", "🔴 an UNREGISTERED source still mints — the guard fires on a scheme we can SEE is incompatible, not on registry arming");
  }

  withHooks([]);
  const gone = await rotateKind.execute(rotateArgs("ci-status"), DECIDER);
  ok(/no longer|any more/.test(gone), "a hook whose declaration was removed while the card waited declines rather than throwing");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n✅ webhook-provisioning: ${n} checks passed`);

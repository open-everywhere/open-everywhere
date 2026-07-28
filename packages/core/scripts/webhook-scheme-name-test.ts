import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.OE_OPERATIONAL_PROVIDER;
delete process.env.DATABASE_URL;
const TMP = mkdtempSync(join(tmpdir(), "oe-scheme-name-"));
process.env.OE_SQLITE_PATH = join(TMP, "ops.sqlite3");

const {
  webhookScheme,
  webhookName,
  webhookIdentity,
  isSingleStringIdentity,
} = await import("../agent/routines/scheme-name.js");
type WebhookHook = import("../agent/webhooks/config.js").WebhookHook;
type SchemeNamed = import("../agent/routines/scheme-name.js").SchemeNamed;

const { normalizeDelivery, registerEventNormalizer, resetEventNormalizersForTest, declaredDeliveryId } = await import("../agent/routines/event-model.js");
type EventNormalizer = import("../agent/routines/event-model.js").EventNormalizer;
type NormalizedEvent = import("../agent/routines/event-model.js").NormalizedEvent;
type TriggerDelivery = import("../agent/routines/event-model.js").TriggerDelivery;

const { evaluateSubscription } = await import("../agent/routines/event-match.js");
const { checkEventReadGrant, registerEventScopeGrant, resetEventScopeGrantsForTest } = await import("../agent/routines/event-authz.js");
const { routinePartition } = await import("../agent/routines/partition.js");
type Routine = import("../agent/routines/routine.js").Routine;

const { gateWebhookDelivery } = await import("../agent/webhooks/gate.js");
const { registerWebhookVerifier, resetWebhookVerifiersForTest } = await import("../agent/webhooks/verifier.js");
type WebhookVerifier = import("../agent/webhooks/verifier.js").WebhookVerifier;

const { resolveAccess } = await import("../agent/access/resolver.js");
const { getOperationalStore, registerOperationalStore, resetOperationalStore } = await import("../agent/operational/provider.js");
const { registerOperationalPglite } = await import("../agent/operational/pglite-client.js");
type OperationalStore = import("../agent/operational/store.js").OperationalStore;

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const OLD_registryKey = (x: SchemeNamed): string => x.source;
const OLD_handle = (x: SchemeNamed): string => x.source;

const DECLARED_IMPLICIT: WebhookHook = {
  id: "github",
  source: "github",
  secretRef: "OE_WEBHOOK_GITHUB_SECRET",
  broker: "env",
  readableBy: [{ level: "domain", domain: "eng" }],
  posture: "trigger-only",
};
const DECLARED_EMIT_ONLY: WebhookHook = {
  id: "deploy-status",
  source: "oe-standard-webhook",
  secretRef: "db:webhook:deploy-status",
  broker: "db",
  readableBy: [{ level: "org" }],
  posture: "content-bearing",
};

const CORPUS: readonly { readonly note: string; readonly value: SchemeNamed }[] = [
  { note: "WebhookHook (declared, implicit scheme)", value: DECLARED_IMPLICIT },
  { note: "WebhookHook (declared, emit-only, db-homed secret)", value: DECLARED_EMIT_ONLY },
  { note: "GateableHook (runtime, resolveRuntimeHook)", value: { source: "github", scheme: "github" } },
  { note: "config WebhookHook (a scheme with no normalizer of its own)", value: { source: "verifier-only" } },
  { note: "config WebhookHook (github)", value: { source: "github" } },
  { note: "config WebhookHook (notion)", value: { source: "notion" } },
  { note: "TriggerDelivery (github-fanout.ts, the NATIVE ingress)", value: { source: "github" } },
  { note: "TriggerDelivery (emitConfigHookEvent — NAME=hook id, SCHEME=declared source)", value: { source: "deploy-status", scheme: "deploy-status" } },
  { note: "NormalizedEvent (github-normalizer.ts)", value: { source: "github" } },
];

for (const { note, value } of CORPUS) {
  eq(webhookScheme(value), OLD_registryKey(value), `golden — ${note}: the REGISTRY KEY is byte-identical to the pre-split \`x.source\``);
  eq(webhookName(value), OLD_handle(value), `golden — ${note}: the HANDLE is byte-identical to the pre-split \`x.source\``);
  ok(isSingleStringIdentity(value), `golden — ${note}: still has the one-string property (scheme === name), i.e. the split is a NO-OP here`);
  eq(webhookIdentity(value), { name: OLD_handle(value), scheme: OLD_registryKey(value) }, `golden — ${note}: both halves at once agree with both oracles`);
}
ok(CORPUS.every((c) => isSingleStringIdentity(c.value)), "golden: EVERY shape shipping today has scheme === name — nothing observable changes for anything deployed");

{
  const b: SchemeNamed = { source: "my-ci", scheme: "oe-standard-webhook" };
  eq(webhookName(b), "my-ci", "divergence: the HANDLE is the name, and still agrees with the old handle oracle");
  eq(OLD_handle(b), "my-ci", "divergence: …which is why nothing that addresses a hook by handle had to move");
  ok(webhookScheme(b) !== OLD_registryKey(b), "divergence: the REGISTRY KEY diverges from the old oracle — EXPECTED, this is the whole capability");
  eq(webhookScheme(b), "oe-standard-webhook", "divergence: the registry key is the declared scheme");
  ok(!isSingleStringIdentity(b), "divergence: the one-string property is FALSE here — a measurement, never an invariant to branch on");
}

{
  eq(webhookScheme({ source: "a", scheme: "b" }), "b", "precedence 1: a present scheme wins over the name");
  eq(webhookScheme({ source: "a" }), "a", "precedence 2: an absent scheme falls back to the name");
  eq(webhookScheme({ source: "a", scheme: undefined }), "a", "precedence 2: an explicitly-undefined scheme is the same as absent (a JSON round-trip drops it either way)");
  eq(webhookScheme({ source: "a", scheme: "" }), "", "precedence 3: an EMPTY scheme stays empty (?? not ||) — malformed rows fail closed, they do not inherit the name's contract");
  eq(webhookName({ source: "a", scheme: "b" }), "a", "precedence: the handle never consults the scheme");
}

const SCHEME = "acme-scheme";

const ID = (c: string) => `hook-${c}`;

const acmeNormalizer: EventNormalizer = {
  source: SCHEME,
  matchKeys: ["event", "status"],
  scopeKeys: ["job"],
  scopeKinds: ["tenant", "container"],
  resolvesActor: false,
  deliveryIdHeader: "x-acme-delivery",
  normalize(d) {
    const body = JSON.parse(d.body) as { event?: string; status?: string; job?: string };
    if (!body.event) return null;
    return {
      source: SCHEME,
      event: body.event,
      scope: [
        { kind: "tenant", id: "acme" },
        { kind: "container", id: body.job ?? "j1" },
      ],
      fields: { event: body.event, ...(body.status ? { status: body.status } : {}) },
      summary: `acme ${body.event}`,
    };
  },
};

resetEventNormalizersForTest();
registerEventNormalizer(acmeNormalizer);

const delivery = (over: Partial<TriggerDelivery>): TriggerDelivery => ({
  source: "ci-a",
  scheme: SCHEME,
  headers: {},
  body: JSON.stringify({ event: "build", status: "failed" }),
  receivedAt: "2026-07-27T00:00:00.000Z",
  ...over,
});

{
  const ev = normalizeDelivery(delivery({}));
  ok(ev !== null, "routing: a delivery whose SCHEME has a normalizer normalizes, even though its NAME has none");
  eq(ev?.source, "ci-a", "routing: the emitted event carries the HOOK'S NAME in `source` — stamped over whatever the normalizer wrote");
  eq(ev?.scheme, SCHEME, "routing: …and the SCHEME it was interpreted under, for the grant to resolve through");

  const legacy = normalizeDelivery(delivery({ source: SCHEME, scheme: undefined }));
  eq(legacy?.source, SCHEME, "routing: a pre-split delivery (source only) is unchanged — the source both resolves the normalizer and names the event");
  eq(legacy?.scheme, SCHEME, "routing: …and its scheme is derived from its source");

  eq(normalizeDelivery(delivery({ source: SCHEME, scheme: "nope" })), null, "routing: resolution is by SCHEME and fails closed — a delivery whose name happens to be a registered scheme does not sneak through");

  eq(declaredDeliveryId(SCHEME, { "x-acme-delivery": "d1" }), "d1", "delivery id: the header name is looked up by SCHEME");
  eq(declaredDeliveryId("ci-a", { "x-acme-delivery": "d1" }), undefined, "delivery id: …and the NAME resolves nothing, which is why deliverRuntimeHook had to pass the scheme");
}

const routine = (source: string): Routine =>
  ({
    org: "acme",
    id: `r-${source}`,
    surfaceKey: "slack/T1/C1",
    status: "active",
    trigger: { kind: "event", source, jq: '(.fields.status | IN("failed"))' },
  }) as unknown as Routine;

{
  const ev = normalizeDelivery(delivery({}))!;
  const mine = await evaluateSubscription(routine("ci-a"), ev);
  const theirs = await evaluateSubscription(routine("ci-b"), ev);
  const wrong = await evaluateSubscription(routine(SCHEME), ev);

  ok(mine.match, "match: the routine subscribed to THIS hook's name matches");
  ok(!("invalid" in mine), `match: …and is NOT reported invalid, even though no normalizer is registered under "ci-a" — the fire-time registration re-check resolves by SCHEME`);
  ok(!theirs.match, "match: a routine subscribed to a SIBLING hook on the SAME SCHEME does NOT match — one scheme, many senders, each independently subscribable");
  ok(!wrong.match, "match: a routine subscribed to the SCHEME ITSELF does not match either — subscriptions name hooks, not contracts");

  const ev2 = normalizeDelivery(delivery({ body: JSON.stringify({ event: "build", status: "ok" }) }))!;
  ok(!(await evaluateSubscription(routine("ci-a"), ev2)).match, "match: the filter still decides — same hook, non-matching status, no fire");
}

{
  resetEventScopeGrantsForTest();
  registerEventScopeGrant({ source: SCHEME, grantsRead: () => true });

  const ev = normalizeDelivery(delivery({}))!;
  const partitions = [routinePartition(routine("ci-a"))];
  const resolve = () => ({ repos: [], domains: [] }) as never;

  ok(checkEventReadGrant(ev, partitions, { resolve }).ok, "grant: resolved by SCHEME — a hook named `ci-a` speaking `acme-scheme` finds that scheme's adapter");

  const noScheme = { ...ev, scheme: undefined } as NormalizedEvent;
  const verdict = checkEventReadGrant(noScheme, partitions, { resolve });
  ok(!verdict.ok && verdict.reason === "no-grant-adapter", "grant: FAIL CLOSED — strip the scheme and the name resolves no adapter, so the fire is refused rather than defaulted");
}

{
  resetWebhookVerifiersForTest();
  const verifier: WebhookVerifier = {
    source: SCHEME,
    keyKind: "shared-secret",
    keyOrigin: "receiver-minted",
    signedTimestamp: false,
    verify: () => ({ ok: true, keyIndex: 0 }),
  };
  registerWebhookVerifier(verifier);

  const base = { rawBody: "{}", bodyBytes: 2, headers: new Headers(), nowMs: 0, allowUnverified: false, maxBodyBytes: 1_000_000 };
  const accepted = await gateWebhookDelivery({
    ...base,
    hook: { id: ID("a"), source: "ci-a", scheme: SCHEME, secretRef: "OE_X_SECRET", broker: "env" },
    secretValues: ["k"],
  });
  ok(accepted.ok, "gate: the verifier is resolved by SCHEME — a hook named `ci-a` authenticates under `acme-scheme`");

  const refused = await gateWebhookDelivery({
    ...base,
    hook: { id: ID("a"), source: "ci-a", secretRef: "OE_X_SECRET", broker: "env" },
    secretValues: ["k"],
  });
  ok(!refused.ok && refused.rejection.status === 401, "gate: FAIL CLOSED — with no scheme the NAME is the key, nothing is registered under it, and the delivery 401s");
  ok(!refused.ok && refused.rejection.reason.includes('"ci-a"'), "gate: …and the refusal names the key it actually tried, so an operator is not sent after the wrong string");

  const legacy = await gateWebhookDelivery({ ...base, hook: { id: ID("a"), source: SCHEME, secretRef: "OE_X_SECRET", broker: "env" }, secretValues: ["k"] });
  ok(legacy.ok, "gate: a pre-split hook (name === scheme, no `scheme` field) resolves exactly as it always did");
}

{
  const req = { mode: "channel", platform: "slack", workspace: "T1", channel: "C1", domains: ["payments", "ops"] } as const;
  const access = resolveAccess(req, [], []);
  eq(access.domains, req.domains, "domains: EffectiveAccess.domains === ResolveRequest.domains, exactly — it is an echo of an input, not a computed grant");
  eq(access.domains.slice(), ["payments", "ops"], "domains: …carried in order, unfiltered, un-deduped — nothing in the resolver may narrow it");

  const none = resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel: "C1" }, [], []);
  eq(none.domains.slice(), [], "domains: absent on the request ⇒ EMPTY, never a wildcard — a membership test over it refuses rather than admits");

  eq(access.repos.slice(), [], "domains: adding the field changed no other resolved surface (repos)");
  eq(access.warnings.slice(), [], "domains: …and contributed no warning of its own — it is not a grant, so `access/lint.ts` has nothing to say about it");
}

rmSync(TMP, { recursive: true, force: true });
console.log(`webhook-scheme-name-test: ${n} assertions passed (corpus size ${CORPUS.length})`);

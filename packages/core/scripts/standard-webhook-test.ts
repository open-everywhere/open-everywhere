import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const dir = join(tmpdir(), `oe-standard-webhook-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_ORG;
const ORG = "default";
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
delete process.env.OE_WEBHOOK_MAX_SKEW_SECONDS;
delete process.env.OE_EVENT_MAX_FANOUT;

const { registerSlackTestBridge } = await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");

const DOMAIN_OF: Readonly<Record<string, string>> = {
  "slack/T1/C-ENG": "eng",
  "slack/T1/C-OPS": "ops",
};
registerConfig({
  loadBundles: () => [defineBundle({ name: "org-default", domains: [] })],
  loadBindings: () => [defineBinding({ bundle: "org-default", scope: { level: "org" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: ({ workspaceKey, surface }) => {
    const d = DOMAIN_OF[`${workspaceKey}/${surface}`];
    return d ? [d] : [];
  },
});

const sw = await import("../agent/webhooks/oe-standard-webhook.js");
const { gateWebhookDelivery, webhookMaxBodyBytes } = await import("../agent/webhooks/gate.js");
const { firstSightingOfWebhookDelivery, webhookReplayStoreKey } = await import("../agent/webhooks/replay-dedupe.js");
const { webhookMaxSkewSeconds } = await import("../agent/webhooks/gate.js");
const { resolveHookKeys } = await import("../agent/webhooks/secrets.js");
const { configHookDisclosure } = await import("../agent/webhooks/config.js");
const { declaredDeliveryId } = await import("../agent/routines/event-model.js");
const { registerDbCredentialBroker } = await import("../agent/credentials/db-broker.js");
registerDbCredentialBroker();
const { encryptedKvVault } = await import("../agent/credentials/kv-vault.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { normalizeDelivery } = await import("../agent/routines/event-model.js");
const { checkEventReadGrant, eventGrantPartitions, eventScopeGrant } = await import("../agent/routines/event-authz.js");
const { scopeGrantsRead, readableByDefects, describeReadableBy } = await import("../agent/access/read-grant.js");
const { validateSubscription, evaluateSubscription } = await import("../agent/routines/event-match.js");
const { probeFilter } = await import("../agent/routines/jq-filter.js");
const { admitTrigger, deliveryDedupeKey } = await import("../agent/routines/ingress.js");
await import("../agent/routines/github-normalizer.js");

type Routine = import("../agent/routines/routine.js").Routine;
type AuditInput = import("../agent/operational/store.js").AuditInput;
type TriggerDelivery = import("../agent/routines/event-model.js").TriggerDelivery;
type WebhookHook = import("../agent/webhooks/config.js").WebhookHook;

const DECLARED = new Map<string, WebhookHook>();

const SLACK_CHANNEL = { __fixture: "slack" } as never;
registerSlackTestBridge({ channel: SLACK_CHANNEL, confirmChannelInternal: async () => true });

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};
const throws = async (fn: () => unknown | Promise<unknown>, match: RegExp, label: string) => {
  try {
    await fn();
  } catch (err) {
    assert.match(String(err instanceof Error ? err.message : err), match, label);
    n++;
    return;
  }
  assert.fail(`${label} — expected a throw, got none`);
};

const store = getOperationalStore();
const vault = encryptedKvVault();
const nowSec = () => Math.floor(Date.now() / 1000);

{
  console.log("\n1. spec interop (independent vector):");
  const independentSignature = (secret: string, id: string, ts: string, body: string): string =>
    "v1," + createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${ts}.${body}`, "utf8").digest("base64");

  const secret = "s3cr3t-not-a-real-key";
  const id = "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W";
  const ts = "1674087231";
  const body = '{"event":"contact.created"}';
  eq(sw.standardWebhookSignature(secret, id, ts, body), independentSignature(secret, id, ts, body), "our signer reproduces an independently-computed spec signature byte for byte");
  eq(sw.standardWebhookSignedContent(id, ts, body), `${id}.${ts}.${body}`, "the signed content is exactly `<id>.<timestamp>.<payload>`");
  ok(sw.standardWebhookSignature(secret, id, ts, body).startsWith("v1,"), "the header value carries the spec's v1 version tag");
  eq(
    sw.standardWebhookSignature("oe-test-secret-not-real", "msg_p5jXN8AQM9LWM0D4loKWxJek", "1614265330", '{"test": 2432232314}'),
    "v1,ivB/auqhr1UpMTaHkqOEJghICrBl92+cTyo14jRDcQQ=",
    "an openssl-produced vector verifies on the RAW-KEY branch (the documented curl + openssl recipe)",
  );
  eq(
    sw.standardWebhookSignature("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", "1614265330", '{"test": 2432232314}'),
    "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    "an openssl-produced vector over the reference library's own fixture verifies on the whsec_ branch",
  );
  ok(
    sw.standardWebhookSignature("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "m", "1", "b") !==
      sw.standardWebhookSignature("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "m", "1", "b"),
    "the whsec_ branch base64-DECODES the key rather than stripping a prefix (the two readings differ)",
  );
  eq(sw.standardWebhookKey("plain-secret").toString("utf8"), "plain-secret", "a non-whsec_ secret is used as its own UTF-8 bytes (the openssl -hmac one-liner path)");
}

const SECRET = randomBytes(32).toString("base64url");
const OLD_SECRET = randomBytes(32).toString("base64url");

function headersFor(over: Partial<Record<string, string>>, body: string, secret = SECRET, id = "msg_abc123", ts = String(nowSec())): Headers {
  const h = new Headers({
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": sw.standardWebhookSignature(secret, id, ts, body),
    "content-type": "application/json",
  });
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) h.delete(k);
    else h.set(k, v);
  }
  return h;
}

{
  console.log("\n2. the verifier:");
  const body = '{"event":"build","action":"failed"}';
  const verify = (h: Headers, keys: readonly string[] = [SECRET], atMs = Date.now()) => sw.standardWebhookVerifier.verify({ rawBody: body, headers: h, keys, nowMs: atMs });

  eq((await verify(headersFor({}, body))).ok, true, "a well-formed signed delivery verifies");
  eq(await verify(headersFor({ "webhook-signature": undefined }, body)), { ok: false, failure: "missing-signature" }, "no signature header ⇒ missing-signature");
  eq(await verify(headersFor({ "webhook-id": undefined }, body)), { ok: false, failure: "missing-signature" }, "no webhook-id ⇒ missing-signature (the id is COVERED BY the signature, so it is part of it)");
  eq(await verify(headersFor({ "webhook-timestamp": undefined }, body)), { ok: false, failure: "missing-timestamp" }, "no timestamp ⇒ missing-timestamp");
  eq(await verify(headersFor({ "webhook-timestamp": "1.67e9" }, body)), { ok: false, failure: "malformed-timestamp" }, "an exponent-notation timestamp is MALFORMED, never Number()-coerced into a basestring nobody signed");
  eq(await verify(headersFor({ "webhook-timestamp": "0x63cf1f3f" }, body)), { ok: false, failure: "malformed-timestamp" }, "…and neither is a hex one");
  eq(await verify(headersFor({ "webhook-id": "has:a:colon" }, body)), { ok: false, failure: "malformed-signature" }, "a webhook-id carrying ':' is refused — it lands in deliveryDedupeKey's unescaped join (OPE-179)");
  eq(await verify(headersFor({ "webhook-signature": "v9,abcd" }, body)), { ok: false, failure: "unsupported-scheme" }, "a header carrying only an unknown version ⇒ unsupported-scheme (never a silent accept)");
  eq(await verify(headersFor({ "webhook-signature": "v1,not-the-right-mac" }, body)), { ok: false, failure: "signature-mismatch" }, "a wrong signature ⇒ signature-mismatch");
  eq(await verify(headersFor({}, '{"event":"tampered"}')), { ok: false, failure: "signature-mismatch" }, "signing one body and sending another ⇒ mismatch (the body is covered)");

  const stale = String(nowSec() - webhookMaxSkewSeconds() - 60);
  eq(await verify(headersFor({}, body, SECRET, "msg_abc123", stale)), { ok: false, failure: "stale-timestamp" }, "a timestamp outside the skew window ⇒ stale-timestamp");

  const signedWithOld = headersFor({}, body, OLD_SECRET);
  const rotated = await verify(signedWithOld, [SECRET, OLD_SECRET]);
  eq(rotated.ok && rotated.keyIndex, 1, "a delivery signed with the PREVIOUS key verifies at keyIndex 1 during a rotation overlap");
  eq((await verify(signedWithOld, [SECRET])).ok, false, "…and stops verifying once the overlap is dropped");

  const both = headersFor({}, body);
  both.set("webhook-signature", `v1,AAAAdefinitelyNotIt= ${sw.standardWebhookSignature(SECRET, "msg_abc123", both.get("webhook-timestamp")!, body)}`);
  eq((await verify(both)).ok, true, "a space-delimited list verifies when ANY listed v1 signature matches (sender-side rotation)");
  const mixedVersions = headersFor({}, body);
  mixedVersions.set(
    "webhook-signature",
    `v1a,someFutureAsymmetricThing ${sw.standardWebhookSignature(SECRET, "msg_abc123", mixedVersions.get("webhook-timestamp")!, body)}`,
  );
  eq((await verify(mixedVersions)).ok, true, "an UNKNOWN version tag alongside a valid v1 is SKIPPED, not fatal — which is what lets the spec add v1a without breaking receivers");

  const accepted = await verify(headersFor({}, body));
  ok(accepted.ok && typeof accepted.replayKey === "string" && accepted.replayKey.length === 64, "an accepted verdict carries a replayKey (a sha256 hex) — without it the 409 never fires");
  eq(accepted.ok ? accepted.replayKey : null, sw.standardWebhookReplayKey("msg_abc123"), "…and it is derived from the message id alone");
  ok(sw.standardWebhookReplayKey("msg_a") !== sw.standardWebhookReplayKey("msg_b"), "two distinct message ids ⇒ distinct nonces (identical payloads in one second do NOT collide)");
  eq(sw.standardWebhookReplayKey("msg_a"), sw.standardWebhookReplayKey("msg_a"), "…and the same message id always reproduces the same nonce, however it was re-signed");

  eq(sw.standardWebhookVerifier.keyOrigin, "receiver-minted", "keyOrigin: receiver-minted — the precondition for being chat-mintable");
  eq(sw.standardWebhookVerifier.keyKind, "shared-secret", "keyKind: shared-secret");
  eq(sw.standardWebhookVerifier.signedTimestamp, true, "signedTimestamp: true — what makes gate.ts keep the replayKey and the 409 fire");
  eq(sw.standardWebhookNormalizer.deliveryIdHeader, "webhook-id", "the normalizer declares the SIGNED id as its delivery-id header, so the durable dedupe engages too");
}

function delivery(over: Partial<TriggerDelivery> & { readonly body: string }): TriggerDelivery {
  return {
    source: "my-ci",
    scheme: sw.OE_STANDARD_WEBHOOK_SCHEME,
    headers: {},
    receivedAt: "2026-07-27T00:00:00.000Z",
    readableBy: [{ level: "domain", domain: "eng" }],
    ...over,
  };
}

{
  console.log("\n3. the envelope:");
  const ev = normalizeDelivery(delivery({ body: JSON.stringify({ event: "build", action: "failed", fields: { status: "failed", branch: "main", attempt: 3, flaky: false }, occurredAt: "2026-07-27T09:00:00.000Z" }) }));
  ok(ev !== null, "a well-formed envelope normalizes");
  eq(ev!.event, "build", "`event` is carried verbatim");
  eq(ev!.action, "failed", "`action` is carried verbatim");
  eq(ev!.fields["status"], "failed", "a sender-named field is matchable");
  eq(ev!.fields["attempt"], "3", "a number is coerced to its string form");
  eq(ev!.fields["flaky"], "false", "a boolean is coerced");
  eq(ev!.occurredAt, "2026-07-27T09:00:00.000Z", "occurredAt is the SENDER's clock, kept distinct from our receive time");
  eq(ev!.pointer, undefined, "there is NO pointer — nothing to re-fetch, which is what keeps ingress out of its hydration arm entirely");

  const grown = normalizeDelivery(delivery({ body: JSON.stringify({ event: "build", somethingNew: { deeply: "nested" }, alsoNew: [1, 2, 3] }) }));
  ok(grown !== null, "an envelope carrying unknown top-level fields still normalizes");
  eq(grown!.fields, { event: "build" }, "…and contributes nothing to the match fields");

  const nonScalar = normalizeDelivery(delivery({ body: JSON.stringify({ event: "build", fields: { nested: { a: 1 }, list: [1], nil: null, good: "yes" } }) }));
  eq(nonScalar!.fields["good"], "yes", "a scalar field survives");
  ok(!("nested" in nonScalar!.fields) && !("list" in nonScalar!.fields) && !("nil" in nonScalar!.fields), "objects, arrays and null are DROPPED rather than stringified — '[object Object]' matching itself is a match that means nothing");

  const shadow = normalizeDelivery(delivery({ body: JSON.stringify({ event: "build", action: "failed", fields: { event: "deploy", action: "succeeded" } }) }));
  eq(shadow!.fields["event"], "build", "`fields.event` cannot shadow the envelope's own event");
  eq(shadow!.fields["action"], "failed", "`fields.action` cannot shadow the envelope's own action");

  eq(normalizeDelivery(delivery({ body: "not json at all" })), null, "an unparseable body is unroutable (200-and-ignore, never a 500)");
  eq(normalizeDelivery(delivery({ body: "[1,2,3]" })), null, "a JSON ARRAY is not an envelope");
  eq(normalizeDelivery(delivery({ body: '{"action":"failed"}' })), null, "no `event` ⇒ NOT MODELLED — the ping analogue, so a sender probing the endpoint gets a clean ack");
  const manyFields: Record<string, string> = {};
  for (let i = 0; i < 40; i++) manyFields[`f${i}`] = String(i);
  const truncated = normalizeDelivery(delivery({ body: JSON.stringify({ event: "build", fields: manyFields }) }));
  ok(truncated !== null, "an over-eager sender's 40-field payload is not DROPPED…");
  ok(Object.keys(truncated!.fields).length <= 16, "…it is truncated to the matcher's cap (losing the 17th field, not the whole delivery)");
}

{
  console.log("\n4. the scope path (payload cannot touch it):");
  const hostile = JSON.stringify({
    event: "build",
    tenant: "attacker-domain",
    container: "attacker-hook",
    scope: [
      { kind: "tenant", id: "attacker-domain" },
      { kind: "container", id: "attacker-hook" },
    ],
    ownerDomain: "attacker-domain",
    readableBy: [{ level: "org" }],
    source: "attacker-hook",
    repository: { full_name: "attacker/repo" },
    fields: { tenant: "attacker-domain", container: "attacker-hook" },
  });
  const ev = normalizeDelivery(delivery({ body: hostile }))!;
  eq(
    ev.scope,
    [{ kind: "container", id: "my-ci" }],
    "🔴 a payload declaring its own tenant/container/scope changes NOTHING — the path is the ROW's hook name and nothing else",
  );
  eq(ev.source, "my-ci", "…and the event names the hook it arrived on, not the `source` the body claimed");
  eq(ev.readableBy, [{ level: "domain", domain: "eng" }], "🔴 a payload declaring `readableBy: [{level:'org'}]` changes NOTHING — the grant is the INGRESS's, stamped, never the body's");

  eq(sw.standardWebhookScope({ source: "my-ci" }), ev.scope, "the scope builder takes ONLY the delivery's declared name — there is no body parameter, and since OPE-209 no authorization input either");
  eq(sw.standardWebhookNormalizer.scopeHookConstant, true, "the normalizer DECLARES its scope is hook-constant, which is what event-match.ts reads to skip mandatory narrowing");

  const a = normalizeDelivery(delivery({ body: '{"event":"a","fields":{"x":"1"}}' }))!;
  const b = normalizeDelivery(delivery({ body: hostile }))!;
  eq(a.scope, b.scope, "two unrelated payloads on one hook prove the identical scope path");
}

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: ORG,
    surfaceKey: "slack/T1/C-ENG",
    target: { channelId: "C-ENG" },
    trigger: { kind: "event", source: "my-ci", filter: { all: [{ key: "status", in: ["failed"] }] } },
    prompt: "Tell the channel the build failed.",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    ...over,
  };
}

{
  console.log("\n5. the read grant (readableBy — OPE-209):");
  eq(eventScopeGrant(sw.OE_STANDARD_WEBHOOK_SCHEME), undefined, "🔴 no grant adapter is registered for the contract any more — the hook's own `readableBy` is the whole decision");

  const engAccess = { domains: ["eng"], tenantKey: "slack/T1", surfaceKey: "slack/T1/C-ENG" } as never;
  const opsAccess = { domains: ["ops"], tenantKey: "slack/T1", surfaceKey: "slack/T1/C-OPS" } as never;
  const noDomain = { domains: [], tenantKey: "slack/T1", surfaceKey: "slack/T1/C-X" } as never;
  ok(scopeGrantsRead([{ level: "domain", domain: "eng" }], engAccess), "a named domain grants read");
  ok(!scopeGrantsRead([{ level: "domain", domain: "eng" }], opsAccess), "🔴 a DIFFERENT domain does not — the check refuses something real");
  ok(!scopeGrantsRead([{ level: "domain", domain: "eng" }], noDomain), "a partition in NO domain does not");
  ok(!scopeGrantsRead([], engAccess), "an EMPTY grant refuses everyone — the fail-closed floor, asserted standalone rather than trusted to the validator");
  ok(!scopeGrantsRead(undefined, engAccess), "…and so does an absent one");
  ok(
    scopeGrantsRead([{ level: "domain", domain: "eng" }, { level: "domain", domain: "ops" }], engAccess) &&
      scopeGrantsRead([{ level: "domain", domain: "eng" }, { level: "domain", domain: "ops" }], opsAccess),
    "🔴 MANY domains may read ONE hook — the union the single frozen owning domain could not express",
  );
  ok(scopeGrantsRead([{ level: "org" }, { level: "domain", domain: "eng" }], opsAccess), "a broad entry is NOT revoked by a narrower sibling — this is a union, never narrowest-wins");
  ok(scopeGrantsRead([{ level: "org" }], noDomain), '{ level: "org" } means EVERY domain — the sentinel `ALL_DOMAINS` is dissolved into a level that already meant it');
  ok(scopeGrantsRead([{ level: "tenant", tenant: "slack/T1" }], opsAccess), "a tenant-level grant covers every domain in that tenant");
  ok(!scopeGrantsRead([{ level: "tenant", tenant: "slack/T9" }], opsAccess), "…and not another tenant's");
  ok(scopeGrantsRead([{ level: "surface", surface: "slack/T1/C-OPS" }], opsAccess), "a surface-level grant matches its own surface");
  ok(!scopeGrantsRead([{ level: "principal", principal: "U1" }], engAccess), "🔴 a principal (DM) entry NEVER grants — a DM is a separate connector universe, refused structurally");
  ok(
    scopeGrantsRead([{ level: "domain", domain: "eng" }], engAccess) !== scopeGrantsRead([{ level: "domain", domain: "eng" }], opsAccess),
    "the grant DISCRIMINATES between two real domains — it is not a documented absence of a boundary",
  );

  ok(/EVERY domain in the org/.test(describeReadableBy([{ level: "org" }])), '🔴 `{level:"org"}` renders as "EVERY domain in the org" — three tokens that mean everything must never read as the narrowest thing on the card');
  ok(/NOBODY/.test(describeReadableBy([])), "…and an empty grant says NOBODY out loud rather than rendering blank");
  ok(readableByDefects([]).length > 0, "🔴 an EMPTY readableBy is a validation DEFECT — this is the zero-domain trap (OPE-206) made unconstructable rather than merely fail-closed");
  ok(readableByDefects([{ level: "domain", domain: "a/b" }]).length > 0, "a tenant-qualified domain name is refused — domains are bare, org-global names (OPE-219)");
  ok(readableByDefects([{ level: "tenant", tenant: "T1" }]).length > 0, "a BARE tenant id is refused — tenant keys are platform-qualified");
  eq(readableByDefects([{ level: "domain", domain: "eng" }]), [], "a well-formed grant has no defects");

  const evEng = normalizeDelivery(delivery({ body: '{"event":"build","fields":{"status":"failed"}}' }))!;
  const inEng = checkEventReadGrant(evEng, eventGrantPartitions(routine({ id: "r-eng" })));
  eq(inEng, { ok: true }, "a routine in a GRANTED domain is granted");
  const inOps = checkEventReadGrant(evEng, eventGrantPartitions(routine({ id: "r-ops", surfaceKey: "slack/T1/C-OPS", target: { channelId: "C-OPS" } })));
  eq(inOps, { ok: false, reason: "refused", partition: "slack/T1/C-OPS" }, "🔴 a routine in a NON-granted domain is refused `refused` (NOT `no-grant-adapter`) and names the partition");

  const evEmptyGrant = normalizeDelivery({ source: "my-ci", scheme: sw.OE_STANDARD_WEBHOOK_SCHEME, headers: {}, receivedAt: "2026-07-27T00:00:00.000Z", body: '{"event":"build"}', readableBy: [] })!;
  eq(
    checkEventReadGrant(evEmptyGrant, eventGrantPartitions(routine({ id: "r-eng" }))),
    { ok: false, reason: "refused", partition: "slack/T1/C-ENG" },
    "🔴 an EMPTY declared grant refuses BY NAME rather than falling through to a per-scheme adapter — the refusal is recordable, which is what the zero-domain trap never was",
  );
}

{
  const routeSrc = readFileSync(join(REPO, "packages/core/agent/channels/webhooks.ts"), "utf8");
  ok(/if \(outcome\.replayKey\)/.test(routeSrc), "the live route still gates its 409 on the gate's replayKey — the branch this file's helper mirrors");
  ok(/status: 409/.test(routeSrc), "…and still answers a duplicate with 409");
  ok(/oe-standard-webhook\.js/.test(routeSrc), "…and side-effect-imports the (b) adapter, so a live deployment actually has it registered");
}

interface Posted {
  readonly message: string;
  readonly target: unknown;
}

function makeHook(over: Partial<WebhookHook> = {}): WebhookHook {
  const id = over.id ?? "my-ci";
  const hook: WebhookHook = {
    source: sw.OE_STANDARD_WEBHOOK_SCHEME,
    posture: "content-bearing",
    readableBy: [{ level: "domain", domain: "eng" }],
    ...over,
    id,
    secretRef: `db:webhook:${id}`,
    broker: "db",
  };
  DECLARED.set(hook.id, hook);
  return hook;
}

async function armSecret(hook: WebhookHook): Promise<void> {
  const ref = typeof hook.secretRef === "string" ? hook.secretRef : hook.secretRef[0]!;
  await vault.write(ref, SECRET, { provider: "webhook", domain: hook.id, createdBy: "U-DECIDER" });
}

async function post(
  hook: WebhookHook,
  body: string,
  headers: Headers,
  routines: readonly Routine[],
  sink: Posted[],
  audited: AuditInput[],
): Promise<{ status: number; report?: Awaited<ReturnType<typeof admitTrigger>> }> {
  if (!DECLARED.has(hook.id)) return { status: 404 };
  const keys = await resolveHookKeys(hook);
  const outcome = await gateWebhookDelivery({
    hook,
    secretValues: keys,
    rawBody: body,
    bodyBytes: Buffer.byteLength(body, "utf8"),
    headers,
    nowMs: Date.now(),
    allowUnverified: false,
    maxBodyBytes: webhookMaxBodyBytes(),
  });
  if (!outcome.ok) return { status: outcome.rejection.status };
  if (outcome.replayKey) {
    const first = await firstSightingOfWebhookDelivery(ORG, hook.id, outcome.replayKey);
    if (!first) return { status: 409 };
  }
  const flat: Record<string, string> = {};
  headers.forEach((v, k) => {
    flat[k.toLowerCase()] = v;
  });
  const deliveryId = declaredDeliveryId(hook.source, flat);
  const report = await admitTrigger(
    {
      source: hook.id,
      scheme: hook.source,
      headers: flat,
      body,
      ...(deliveryId ? { deliveryId } : {}),
      receivedAt: new Date().toISOString(),
      readableBy: hook.readableBy,
      ...configHookDisclosure(hook),
    },
    {
      to: ((_channel: unknown, target: unknown) => ({
        send: (message: string) => {
          sink.push({ message, target });
          return Promise.resolve();
        },
      })) as never,
      org: ORG,
      listRoutines: async () => [...routines],
      audit: async (e: AuditInput) => {
        audited.push(e);
      },
    },
  );
  return { status: 200, report };
}

{
  console.log("\n6. end to end (real store, real fire):");
  const hook = makeHook();
  await armSecret(hook);
  const failedRoutine = routine({ id: "r-failed" });
  const okRoutine = routine({ id: "r-ok", trigger: { kind: "event", source: "my-ci", filter: { all: [{ key: "status", in: ["ok"] }] } } });

  const body = JSON.stringify({ event: "build", action: "failed", fields: { status: "failed", branch: "main" } });
  const sink: Posted[] = [];
  const audited: AuditInput[] = [];
  const res = await post(hook, body, headersFor({}, body, SECRET, "msg_e2e_1"), [failedRoutine, okRoutine], sink, audited);

  eq(res.status, 200, "a signed delivery to a declared (b) hook is accepted");
  eq(res.report?.accepted, true, "…and enters the routing plane");
  eq(res.report?.matched, 1, "🔴 exactly ONE of the two routines matched — `status: failed` did, `status: ok` did not");
  eq(res.report?.fired, 1, "…and it fired");
  eq(sink.length, 1, "the fire REACHED THE RECEIVE SINK (a counter is not evidence a room saw anything — OPE-181)");
  ok(sink[0]!.message.includes("build"), "…and the message carries the event");
  ok(/failed/.test(sink[0]!.message), "…and the payload the routine filtered on");

  const sink2: Posted[] = [];
  const res2 = await post(hook, body, headersFor({}, body, SECRET, "msg_e2e_2"), [okRoutine], sink2, []);
  eq(res2.report?.matched, 0, "the `status: ok` routine alone matches nothing on a failed build");
  eq(sink2.length, 0, "…and nothing reaches the room");

  const sink3: Posted[] = [];
  const audited3: AuditInput[] = [];
  const opsRoutine = routine({ id: "r-ops-e2e", surfaceKey: "slack/T1/C-OPS", target: { channelId: "C-OPS" } });
  const res3 = await post(hook, body, headersFor({}, body, SECRET, "msg_e2e_3"), [opsRoutine], sink3, audited3);
  eq(res3.report?.matched, 1, "a non-owning domain's routine still MATCHES the filter…");
  eq(res3.report?.fired, 0, "…and does not fire");
  eq(sink3.length, 0, "…nothing reaches its room");
  ok(
    audited3.some((a) => a.action === "routine.skip" && /grant|refus/i.test(JSON.stringify(a.detail ?? {}))),
    "…and the refusal is AUDITED rather than silent",
  );
}

{
  console.log("\n7. replay (real stores, both layers):");
  const hook = makeHook({ id: "ci-replay" });
  await armSecret(hook);
  const r = routine({ id: "r-replay", trigger: { kind: "event", source: "ci-replay", filter: { all: [{ key: "status", in: ["failed"] }] } } });
  const body = JSON.stringify({ event: "build", fields: { status: "failed" } });
  const headers = headersFor({}, body, SECRET, "msg_replay_1");

  const sink: Posted[] = [];
  const first = await post(hook, body, headers, [r], sink, []);
  eq(first.status, 200, "the first presentation is accepted");
  eq(sink.length, 1, "…and fires");

  const sink2: Posted[] = [];
  const second = await post(hook, body, headers, [r], sink2, []);
  eq(second.status, 409, "🔴 the IDENTICAL signed delivery re-POSTed inside the skew window is refused 409");
  eq(sink2.length, 0, "…and nothing fires the second time");

  const marked = await store.markEventSeen(ORG, webhookReplayStoreKey(hook.id, sw.standardWebhookReplayKey("msg_replay_1")), new Date().toISOString(), 60_000);
  eq(marked, false, "the nonce is durably marked under `webhook-replay:<hookId>:<nonce>` (a third mark also fails)");
  const otherHookKey = await store.markEventSeen(ORG, webhookReplayStoreKey("hk_someotherhook", sw.standardWebhookReplayKey("msg_replay_1")), new Date().toISOString(), 60_000);
  eq(otherHookKey, true, "…and the SAME nonce on a DIFFERENT hook is untouched (per-hook single-use, not global)");

  const layer1 = await store.markEventSeen(ORG, deliveryDedupeKey("ci-replay", "msg_replay_1"), new Date().toISOString(), 60_000);
  eq(layer1, false, "🔴 layer 1 ALSO engaged — admitTrigger marked the signed webhook-id in `trigger:<name>:<id>`");

  const sink3: Posted[] = [];
  const distinct = await post(hook, body, headersFor({}, body, SECRET, "msg_replay_2"), [r], sink3, []);
  eq(distinct.status, 200, "a DIFFERENT message id carrying the IDENTICAL payload in the same second is accepted…");
  eq(sink3.length, 1, "…and fires — the collision a signature-derived nonce cannot avoid");
}

{
  console.log("\n8. two hooks on one contract:");
  const ciA = makeHook({ id: "ci-alpha" });
  await armSecret(ciA);
  const rAlpha = routine({ id: "r-alpha", trigger: { kind: "event", source: "ci-alpha", filter: { all: [{ key: "status", in: ["failed"] }] } } });
  const rBeta = routine({ id: "r-beta", trigger: { kind: "event", source: "ci-beta", filter: { all: [{ key: "status", in: ["failed"] }] } } });
  const body = JSON.stringify({ event: "build", fields: { status: "failed" } });

  const sink: Posted[] = [];
  const res = await post(ciA, body, headersFor({}, body, SECRET, "msg_alpha_1"), [rAlpha, rBeta], sink, []);
  eq(res.report?.matched, 1, "🔴 a delivery on `ci-alpha` matches only `ci-alpha`'s routine — one contract, many senders, each independently subscribable");
  eq(sink.length, 1, "…and exactly one fire lands");

  const evAlpha = normalizeDelivery(delivery({ source: "ci-alpha", body }))!;
  eq(evAlpha.scheme, sw.OE_STANDARD_WEBHOOK_SCHEME, "the event carries the CONTRACT in `scheme`…");
  eq(evAlpha.source, "ci-alpha", "…and the HOOK in `source`");
  eq((await evaluateSubscription(rAlpha, evAlpha)).match, true, "the matching subscription matches");
  eq((await evaluateSubscription(rBeta, evAlpha)).match, false, "the sibling on the SAME contract does not");
  ok(!("invalid" in (await evaluateSubscription(rBeta, evAlpha))), "…and it is a clean non-match, NOT a fire-time `invalid` (which would mean the contract was resolved by the name)");
}

{
  console.log("\n9. authoring a (b) subscription:");
  const SCHEME = sw.OE_STANDARD_WEBHOOK_SCHEME;

  const FILTER = '(.fields.status | IN("failed"))';
  await throws(() => validateSubscription("my-ci", FILTER), /Unknown event source/, "resolving by the NAME alone refuses a perfectly valid (b) subscription…");
  validateSubscription("my-ci", FILTER, SCHEME);
  n++;
  console.log("   ✓ …and passing the SCHEME makes it creatable (the create_routine fix)");

  validateSubscription("my-ci", '(.fields.branch | IN("main") | not)', SCHEME);
  n++;
  eq(sw.standardWebhookNormalizer.matchKeysOpen, true, "the normalizer DECLARES its key space is the sender's");
  eq(sw.standardWebhookNormalizer.matchKeys, ["event", "action"], "…and still names the RESERVED keys it always emits, for the tool description and the probe document");
  await throws(() => probeFilter(".fields.status ==", "my-ci", sw.standardWebhookNormalizer.matchKeys), /isn't a usable jq predicate/, "an expression that will not parse is refused");
  await throws(() => probeFilter(".fields.status", "my-ci", sw.standardWebhookNormalizer.matchKeys), /isn't a usable jq predicate/, "an expression that yields a STRING rather than a boolean is refused — it could never fire");
  await throws(() => validateSubscription("my-ci", "", SCHEME), /non-empty jq expression/, "an empty expression is refused");

  validateSubscription("my-ci", undefined, SCHEME);
  n++;
  console.log("   ✓ a filterless (b) subscription is allowed — naming the hook IS the narrowing");
  await throws(() => validateSubscription("github", undefined), /must narrow its scope/, "…while a vendor source spanning many containers still MUST narrow");
}

{
  console.log("\n10. the unknown-source refusal names the (b) escape:");
  const { generalPurposeSchemeHint } = await import("../agent/tools/declare_webhook.js");
  const contracts = [sw.OE_STANDARD_WEBHOOK_SCHEME];

  const hint = generalPurposeSchemeHint("jenkins", contracts);
  ok(hint.includes(sw.OE_STANDARD_WEBHOOK_SCHEME), "a caller who typed a system name is pointed at the general-purpose contract by name");
  ok(/does NOT need an adapter/.test(hint), "…and told explicitly that no adapter is needed — the PR the refusal above suggests is not the only road");

  ok(hint.includes('Put "jenkins" in the hook\'s `id`'), "…and told their word stays as the LABEL (the hook's `id`), not as the contract");
  ok(/set `source` to a general-purpose contract/.test(hint), "…and that `source` is the field carrying the contract");
  ok(!/`scheme`/.test(hint), "🔴 the hint does NOT name a `scheme` parameter — declare_webhook has never had one (OPE-224 collapsed the pair), so advice to set it is a dead end");

  eq(generalPurposeSchemeHint("jenkins", []), "", "a deployment with NO registered contract offers no alternative rather than pointing at nothing");
  eq(generalPurposeSchemeHint("jenkins", ["jenkins"]), "", "…and never offers the very string that was just refused");
}

{
  console.log("\n11. minted secret format + sender guidance:");

  const minted = sw.mintStandardWebhookSecret();
  ok(minted.startsWith(sw.SW_SECRET_PREFIX), "a minted secret carries the spec's whsec_ prefix");
  const encoded = minted.slice(sw.SW_SECRET_PREFIX.length);
  eq(encoded.length, 44, "…followed by exactly 44 base64 characters");
  ok(!encoded.includes("="), "🔴 …with NO `=` padding — 33 bytes is a multiple of 3, which is the one form strict and lenient base64 decoders read identically");
  ok(!/[-_]/.test(encoded), "🔴 …in the STANDARD base64 alphabet, never base64url (the spec's reference libraries decode strictly and would produce different key bytes)");
  eq(sw.standardWebhookKey(minted).length, 33, "…decoding to 33 key bytes (264 bits)");
  ok(sw.mintStandardWebhookSecret() !== sw.mintStandardWebhookSecret(), "each mint is fresh — it is a KEY, not an identifier");
  eq(sw.mintStandardWebhookSecret(Buffer.from("0123456789abcdefghijklmnopqrstuvw")).slice(sw.SW_SECRET_PREFIX.length), Buffer.from("0123456789abcdefghijklmnopqrstuvw").toString("base64"), "the encoding is plain base64 over the given bytes — pinned against a fixed input so a re-spelling cannot hide");

  {
    const body = '{"event":"deploy"}';
    const ts = String(nowSec());
    const h = new Headers({
      "webhook-id": "msg_mintcheck",
      "webhook-timestamp": ts,
      "webhook-signature": sw.standardWebhookSignature(minted, "msg_mintcheck", ts, body),
    });
    eq((await sw.standardWebhookVerifier.verify({ rawBody: body, headers: h, keys: [minted], nowMs: Date.now() })).ok, true, "🔴 a delivery signed with a FRESHLY MINTED secret verifies — the mint format and the key rule agree");
    const legacy = randomBytes(32).toString("base64url");
    const h2 = new Headers({
      "webhook-id": "msg_legacycheck",
      "webhook-timestamp": ts,
      "webhook-signature": sw.standardWebhookSignature(legacy, "msg_legacycheck", ts, body),
    });
    eq((await sw.standardWebhookVerifier.verify({ rawBody: body, headers: h2, keys: [legacy], nowMs: Date.now() })).ok, true, "🔴 …and a PRE-PREFIX raw secret still verifies — the change is not wire-breaking");
  }

  eq(typeof sw.standardWebhookVerifier.mintSecret, "function", "the scheme declares its own minter on its verifier, where the mint site resolves it");
  ok(sw.standardWebhookVerifier.mintSecret!().startsWith(sw.SW_SECRET_PREFIX), "…and the declared minter is the prefixed one");

  {
    const generic = randomBytes(32).toString("base64url");
    ok(!generic.startsWith(sw.SW_SECRET_PREFIX), "the generic mint carries no prefix (the fixture is not vacuous)");
    const ts2 = String(nowSec());
    const h3 = new Headers({
      "webhook-id": "msg_genericmint",
      "webhook-timestamp": ts2,
      "webhook-signature": sw.standardWebhookSignature(generic, "msg_genericmint", ts2, '{"event":"deploy"}'),
    });
    eq(
      (await sw.standardWebhookVerifier.verify({ rawBody: '{"event":"deploy"}', headers: h3, keys: [generic], nowMs: Date.now() })).ok,
      true,
      "🔴 an UNPREFIXED secret still verifies — an unarmed registry costs a convention, never a working hook",
    );
  }

  eq(
    sw.standardWebhookSignature("whsec_MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3", "msg_abc123", "1614265330", '{"event":"build"}'),
    "v1,5hHn6U/z/A/EbSUbbmrZZL1ZLHts/O12/QJyBrnv3wI=",
    "the documented `base64 -d | od | -macopt hexkey:` shell recipe reaches our verifier byte for byte",
  );

  const g = sw.standardWebhookSenderGuidance();
  eq(g.headers.map((h) => h.name), [sw.SW_ID_HEADER, sw.SW_TIMESTAMP_HEADER, sw.SW_SIGNATURE_HEADER], "the guidance names exactly the three headers the verifier reads");
  ok(g.headers[2]!.value.startsWith(`${sw.SW_SIGNATURE_VERSION},`), "…and shows the signature header's version tag as the verifier requires it");
  eq(
    g.signedContent,
    sw.standardWebhookSignedContent(`<${sw.SW_ID_HEADER}>`, `<${sw.SW_TIMESTAMP_HEADER}>`, "<the raw request body, byte for byte>"),
    "🔴 the guidance's basestring IS the builder's output — one definition, not a second spelling of it",
  );
  ok(g.notes.some((t) => t.includes(String(webhookMaxSkewSeconds()))), "…and states the LIVE skew window rather than a hardcoded number");
  ok(g.notes.some((t) => t.includes(sw.SW_SECRET_PREFIX)), "…and states the TOTAL key rule, so a reader holding a pre-prefix secret is not told to decode it");
  ok(!JSON.stringify(g).includes(minted), "🔴 the guidance carries no live value — every string in it is a template");

}

console.log(`\n✅ standard-webhook (OPE-196 / S3): ${n} checks passed`);

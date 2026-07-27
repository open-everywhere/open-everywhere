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
const { webhookMaxSkewSeconds } = await import("../agent/webhooks/oe-hmac.js");
const rh = await import("../agent/webhooks/runtime-hook.js");
const ri = await import("../agent/webhooks/runtime-ingress.js");
const { encryptedKvVault } = await import("../agent/credentials/kv-vault.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { normalizeDelivery } = await import("../agent/routines/event-model.js");
const { checkEventReadGrant, eventGrantPartitions, eventScopeGrant } = await import("../agent/routines/event-authz.js");
const { validateSubscription, evaluateSubscription } = await import("../agent/routines/event-match.js");
const { admitTrigger, deliveryDedupeKey } = await import("../agent/routines/ingress.js");
await import("../agent/routines/github-normalizer.js");

type Routine = import("../agent/routines/routine.js").Routine;
type AuditInput = import("../agent/operational/store.js").AuditInput;
type TriggerDelivery = import("../agent/routines/event-model.js").TriggerDelivery;
type RuntimeWebhookHook = import("../agent/webhooks/runtime-hook.js").RuntimeWebhookHook;

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
    ownerDomain: "eng",
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
    source: "attacker-hook",
    repository: { full_name: "attacker/repo" },
    fields: { tenant: "attacker-domain", container: "attacker-hook" },
  });
  const ev = normalizeDelivery(delivery({ body: hostile }))!;
  eq(
    ev.scope,
    [
      { kind: "tenant", id: "eng" },
      { kind: "container", id: "my-ci" },
    ],
    "🔴 a payload declaring its own tenant/container/scope/ownerDomain changes NOTHING — the path is the ROW's owning domain and the ROW's hook name",
  );
  eq(ev.source, "my-ci", "…and the event names the hook it arrived on, not the `source` the body claimed");

  eq(sw.standardWebhookScope({ source: "my-ci", ownerDomain: "eng" }), ev.scope, "the scope builder takes ONLY the delivery's declared name + owning domain — there is no body parameter");
  eq(sw.standardWebhookScope({ source: "my-ci" }), [{ kind: "container", id: "my-ci" }], "no owning domain ⇒ NO tenant step (which the grant below then refuses — fail closed, never 'any domain')");
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
  console.log("\n5. the read grant:");
  const grant = eventScopeGrant(sw.OE_STANDARD_WEBHOOK_SCHEME);
  ok(grant !== undefined, "a grant adapter IS registered for the contract — without one every (b) event is refused `no-grant-adapter`");

  const scopeEng = sw.standardWebhookScope({ source: "my-ci", ownerDomain: "eng" });
  ok(grant!.grantsRead(scopeEng, { domains: ["eng"] } as never), "the OWNING domain grants read");
  ok(!grant!.grantsRead(scopeEng, { domains: ["ops"] } as never), "🔴 a DIFFERENT domain does not — the check refuses something real");
  ok(!grant!.grantsRead(scopeEng, { domains: [] } as never), "a partition in NO domain does not");
  ok(!grant!.grantsRead(sw.standardWebhookScope({ source: "my-ci" }), { domains: ["eng"] } as never), "a hook with NO owning domain is refused by every domain — absence fails CLOSED, never 'any'");
  ok(
    grant!.grantsRead(scopeEng, { domains: ["eng"] } as never) !== grant!.grantsRead(scopeEng, { domains: ["ops"] } as never),
    "the grant DISCRIMINATES between two real domains — it is not a documented absence of a boundary",
  );

  const evEng = normalizeDelivery(delivery({ body: '{"event":"build","fields":{"status":"failed"}}' }))!;
  const inEng = checkEventReadGrant(evEng, eventGrantPartitions(routine({ id: "r-eng" })));
  eq(inEng, { ok: true }, "a routine in the OWNING domain is granted");
  const inOps = checkEventReadGrant(evEng, eventGrantPartitions(routine({ id: "r-ops", surfaceKey: "slack/T1/C-OPS", target: { channelId: "C-OPS" } })));
  eq(inOps, { ok: false, reason: "refused", partition: "slack/T1/C-OPS" }, "🔴 a routine in a NON-OWNING domain is refused `refused` (NOT `no-grant-adapter`) and names the partition");

  const evNoDomain = normalizeDelivery({ source: "my-ci", scheme: sw.OE_STANDARD_WEBHOOK_SCHEME, headers: {}, receivedAt: "2026-07-27T00:00:00.000Z", body: '{"event":"build"}' })!;
  eq(checkEventReadGrant(evNoDomain, eventGrantPartitions(routine({ id: "r-eng" }))).ok, false, "a hook with no owning domain authorizes nothing at all");

  const adapterSrc = readFileSync(join(REPO, "packages/core/agent/webhooks/oe-standard-webhook.ts"), "utf8")
    .replace(/\n\s*(\*|\/\/)\s?/g, " ")
    .replace(/\s+/g, " ");
  ok(/swappable seam/.test(adapterSrc), "the adapter still names `loadDomains` as a SWAPPABLE SEAM — the assumption most likely to shift");
  ok(/collapses to `true` in effect/.test(adapterSrc), "…and still states the honest one-domain limitation rather than implying a boundary it does not have there");
  ok(/LATENCY OPTIMISATION ON AN ALREADY-GRANTED POLL/.test(adapterSrc), "…and still records WHY the shipped read-grant justification has no referent here, rather than silently reusing it");
  ok(/no `\(\) => true` precedent/.test(adapterSrc), "…and still says out loud that this must not become the tree's first unconditional grant");
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

async function makeHook(over: Partial<RuntimeWebhookHook> = {}): Promise<RuntimeWebhookHook> {
  const id = rh.mintRuntimeHookId();
  const hook: RuntimeWebhookHook = {
    org: ORG,
    id,
    source: "my-ci",
    scheme: sw.OE_STANDARD_WEBHOOK_SCHEME,
    posture: "content-bearing",
    secretRef: rh.runtimeHookSecretRef(id),
    status: "active",
    createdBy: "U-DECIDER",
    createdIn: "slack/T1/C-ENG",
    ownerDomain: "eng",
    createdAt: "2026-07-27T00:00:00.000Z",
    ...over,
  };
  await store.addWebhookHook(hook);
  await vault.write(hook.secretRef, SECRET, { provider: "webhook", domain: hook.source, createdBy: "U-DECIDER" });
  return hook;
}

async function post(
  hook: RuntimeWebhookHook,
  body: string,
  headers: Headers,
  routines: readonly Routine[],
  sink: Posted[],
  audited: AuditInput[],
): Promise<{ status: number; report?: Awaited<ReturnType<typeof admitTrigger>> }> {
  const resolved = await ri.resolveRuntimeHook(hook.id);
  if (!resolved) return { status: 404 };
  const keys = await ri.resolveRuntimeHookKeys(resolved);
  const outcome = await gateWebhookDelivery({
    hook: resolved.gateable,
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
  const report = await ri.deliverRuntimeHook(resolved, body, headers, {
    receive: ((_channel: unknown, opts: { message: string; target?: unknown }) => {
      sink.push({ message: opts.message, target: opts.target });
      return Promise.resolve();
    }) as never,
    org: ORG,
    listRoutines: async () => [...routines],
    audit: async (e: AuditInput) => {
      audited.push(e);
    },
  });
  return { status: 200, report };
}

{
  console.log("\n6. end to end (real store, real fire):");
  const hook = await makeHook();
  const failedRoutine = routine({ id: "r-failed" });
  const okRoutine = routine({ id: "r-ok", trigger: { kind: "event", source: "my-ci", filter: { all: [{ key: "status", in: ["ok"] }] } } });

  const body = JSON.stringify({ event: "build", action: "failed", fields: { status: "failed", branch: "main" } });
  const sink: Posted[] = [];
  const audited: AuditInput[] = [];
  const res = await post(hook, body, headersFor({}, body, SECRET, "msg_e2e_1"), [failedRoutine, okRoutine], sink, audited);

  eq(res.status, 200, "a signed delivery to a chat-created (b) hook is accepted");
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
  const hook = await makeHook({ source: "ci-replay" });
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
  eq(sink3.length, 1, "…and fires — the collision `oe-hmac`'s signature-derived nonce cannot avoid");
}

{
  console.log("\n8. two hooks on one contract:");
  const ciA = await makeHook({ source: "ci-alpha" });
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
  eq(evaluateSubscription(rAlpha, evAlpha).match, true, "the matching subscription matches");
  eq(evaluateSubscription(rBeta, evAlpha).match, false, "the sibling on the SAME contract does not");
  ok(!("invalid" in evaluateSubscription(rBeta, evAlpha)), "…and it is a clean non-match, NOT a fire-time `invalid` (which would mean the vocabulary was resolved by the name)");
}

{
  console.log("\n9. authoring a (b) subscription:");
  const SCHEME = sw.OE_STANDARD_WEBHOOK_SCHEME;

  await throws(() => validateSubscription("my-ci", { all: [{ key: "status", in: ["failed"] }] }), /Unknown event source/, "resolving by the NAME alone refuses a perfectly valid (b) subscription…");
  validateSubscription("my-ci", { all: [{ key: "status", in: ["failed"] }] }, SCHEME);
  n++;
  console.log("   ✓ …and passing the SCHEME makes it creatable (the create_routine fix)");

  validateSubscription("my-ci", { all: [{ key: "branch", notIn: ["main"] }] }, SCHEME);
  n++;
  eq(sw.standardWebhookNormalizer.matchKeysOpen, true, "the normalizer DECLARES its key space is the sender's");
  eq(sw.standardWebhookNormalizer.matchKeys, ["event", "action"], "…and still names the RESERVED keys it always emits, for the refusal copy");
  await throws(() => validateSubscription("my-ci", { all: [{ key: "not a key!", in: ["x"] }] }, SCHEME), /isn't a usable field name/, "a key that could never be a JSON key is still refused");
  await throws(() => validateSubscription("my-ci", { all: [{ key: "status", in: [] }] }, SCHEME), /empty value list/, "an empty value list is still refused");
  await throws(
    () => validateSubscription("my-ci", { all: [{ key: "status", in: ["a"], notIn: ["b"] }] as never }, SCHEME),
    /exactly one of/,
    "a clause carrying both `in` and `notIn` is still refused — no made-up precedence",
  );
  await throws(() => validateSubscription("my-ci", { under: [{ kind: "entity", id: "x" }] }, SCHEME), /never proves a "entity" scope/, "an `under` on a scope kind the contract never proves is still refused");

  validateSubscription("my-ci", undefined, SCHEME);
  n++;
  console.log("   ✓ a filterless (b) subscription is allowed — naming the hook IS the narrowing");
  await throws(() => validateSubscription("github", undefined), /must narrow its scope/, "…while a vendor source spanning many containers still MUST narrow");
}

{
  console.log("\n10. the unknown-source refusal names the (b) escape:");
  const { generalPurposeSchemeHint } = await import("../agent/tools/create_webhook.js");
  const vocab = ["github", sw.OE_STANDARD_WEBHOOK_SCHEME];

  const hint = generalPurposeSchemeHint("jenkins", "jenkins", vocab, false);
  ok(hint.includes(sw.OE_STANDARD_WEBHOOK_SCHEME), "a caller who typed a system name is pointed at the general-purpose contract by name");
  ok(!hint.includes('"jenkins" as the `scheme`') && hint.includes('Keep "jenkins" as the `source`'), "…and told their word stays as the LABEL, not as the contract");
  ok(/does NOT need an adapter/.test(hint), "…and told explicitly that no adapter is needed — the PR the refusal above suggests is not the only road");

  eq(generalPurposeSchemeHint("jenkins", "jenkins", vocab, true), "", "a caller who ALREADY named a scheme gets no hint (they know the parameter exists)");
  eq(generalPurposeSchemeHint("jenkins", "jenkins", [], false), "", "a deployment with NO registered contract offers no alternative rather than pointing at nothing");
  eq(generalPurposeSchemeHint("jenkins", "jenkins", ["jenkins"], false), "", "…and never offers the very string that was just refused");
}

console.log(`\n✅ standard-webhook (OPE-196 / S3): ${n} checks passed`);

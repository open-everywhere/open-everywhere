import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const HERE = dirname(fileURLToPath(import.meta.url));

const { registerWebhookVerifier, webhookVerifier, registeredWebhookVerifierSources, registeredWebhookVerifiers, resetWebhookVerifiersForTest } =
  await import("../agent/webhooks/verifier.js");
const { standardWebhookVerifier, standardWebhookSignedContent, standardWebhookSignature, OE_STANDARD_WEBHOOK_SCHEME, SW_ID_HEADER, SW_SIGNATURE_HEADER, SW_TIMESTAMP_HEADER } =
  await import("../agent/webhooks/oe-standard-webhook.js");
const { gateWebhookDelivery, webhookMaxSkewSeconds } = await import("../agent/webhooks/gate.js");
const { defineWebhook } = await import("../agent/webhooks/config.js");
const { signWebhookBody, webhookTimestamp } = await import("./e2e/webhook.js");

const MSG_ID = "msg_verifier_test";

type Verifier = import("../agent/webhooks/verifier.js").WebhookVerifier;
type Verdict = import("../agent/webhooks/verifier.js").WebhookVerdict;
type GateOutcome = import("../agent/webhooks/gate.js").WebhookGateOutcome;

const SECRET = "s3cr3t";
const NOW_MS = Date.parse("2026-03-30T11:30:00.000Z");
const NOW_TS = String(Math.floor(NOW_MS / 1000));

const hook = defineWebhook({
  id: "deploy-status",
  source: OE_STANDARD_WEBHOOK_SCHEME,
  secretRef: "DEPLOY_STATUS_WEBHOOK_SECRET",
  broker: "env",
  target: "slack/T1/C1",
  readableBy: [{ level: "domain", domain: "eng" }],
  instruction: "A deploy just finished. Summarise it.",
});

function gateArgs(over: Partial<Parameters<typeof gateWebhookDelivery>[0]> = {}): Parameters<typeof gateWebhookDelivery>[0] {
  const rawBody = over.rawBody ?? JSON.stringify({ ok: true });
  return {
    hook,
    secretValues: [SECRET],
    rawBody,
    bodyBytes: Buffer.byteLength(rawBody, "utf8"),
    headers: new Headers(),
    nowMs: NOW_MS,
    allowUnverified: false,
    maxBodyBytes: 256 * 1024,
    ...over,
  };
}

function signedHeaders(secret: string, rawBody: string, ts: string = NOW_TS, messageId: string = MSG_ID): Headers {
  return new Headers({
    [SW_ID_HEADER]: messageId,
    [SW_TIMESTAMP_HEADER]: ts,
    [SW_SIGNATURE_HEADER]: standardWebhookSignature(secret, messageId, ts, rawBody),
  });
}

async function failureOf(outcome: GateOutcome): Promise<string> {
  return outcome.ok ? "(accepted)" : outcome.rejection.reason;
}

ok(webhookVerifier(OE_STANDARD_WEBHOOK_SCHEME) === standardWebhookVerifier, "importing webhooks/oe-standard-webhook.js REGISTERS our own scheme (module-load registration)");
ok(webhookVerifier("no-such-source") === undefined, "an unregistered source resolves to undefined — the registry REFUSES, it does not throw or substitute");
ok(webhookVerifier(undefined) === undefined, "an undefined source resolves to undefined (never a default scheme)");
ok(registeredWebhookVerifierSources().includes(OE_STANDARD_WEBHOOK_SCHEME), "registeredWebhookVerifierSources names our scheme");
ok(
  registeredWebhookVerifierSources().join(",") === [...registeredWebhookVerifierSources()].sort().join(","),
  "registeredWebhookVerifierSources is sorted (a stable refusal message, not registration-order-dependent)",
);
ok(standardWebhookVerifier.provider === undefined, "core's own verifier declares NO provider — it must never be gated by the deployment's provider selection");

{
  const rawBody = JSON.stringify({ ok: true });
  const strangeHook = { ...hook, source: "stripe" };
  const outcome = await gateWebhookDelivery(gateArgs({ hook: strangeHook, rawBody, headers: signedHeaders(SECRET, rawBody) }));
  ok(!outcome.ok && outcome.rejection.status === 401, "a hook whose source has NO registered verifier is 401 (not 404 — the hook id exists)");
  const reason = await failureOf(outcome);
  ok(reason.includes('"stripe"'), "the refusal names the source that could not be resolved");
  ok(reason.includes(OE_STANDARD_WEBHOOK_SCHEME), "the refusal names the REGISTERED set (brokerFor-grade: loud, named, no substitution)");
  ok(/fail closed/i.test(reason), "the refusal says it is failing closed");
  ok(!outcome.ok, "a validly signed body is STILL refused for an unregistered source (no cross-scheme fallback)");
}

{
  const outcome = await gateWebhookDelivery(gateArgs({ hook: { ...hook, source: "stripe" }, allowUnverified: true, secretValues: [] }));
  ok(!outcome.ok && outcome.rejection.status === 401, "OE_ALLOW_UNVERIFIED_WEBHOOK does NOT waive verifier resolution — an unknown source is still 401");
  ok((await failureOf(outcome)).includes("no verifier registered"), "…and the reason is the resolution refusal, not the missing-secret one");
  const waived = await gateWebhookDelivery(gateArgs({ allowUnverified: true, secretValues: [] }));
  ok(waived.ok && waived.keyIndex === null, "the hatch still waives the missing-KEY case (keyIndex null — nothing verified it)");
}

{
  const otherVerifier: Verifier = {
    source: "test-other",
    keyKind: "shared-secret",
    keyOrigin: "receiver-minted",
    signedTimestamp: false,
    verify({ rawBody, headers, keys }): Verdict {
      const sig = headers.get("x-other-signature-256");
      if (!sig) return { ok: false, failure: "missing-signature" };
      for (const [i, k] of keys.entries()) {
        if (sig === "sha256=" + createHmac("sha256", k).update(rawBody, "utf8").digest("hex")) return { ok: true, keyIndex: i };
      }
      return { ok: false, failure: "signature-mismatch" };
    },
  };
  registerWebhookVerifier(otherVerifier);

  const rawBody = JSON.stringify({ ok: true });
  const otherSig = "sha256=" + createHmac("sha256", SECRET).update(rawBody, "utf8").digest("hex");
  const headers = new Headers({ "x-other-signature-256": otherSig });

  const outcome = await gateWebhookDelivery(gateArgs({ rawBody, headers }));
  ok(!outcome.ok && outcome.rejection.status === 401, "a body signed under ANOTHER registered scheme, sent to a hook declaring ours, is REFUSED");
  ok((await failureOf(outcome)).includes("missing-signature"), "…as missing-signature — our verifier never saw its own header (no sniffing)");

  const declared = await gateWebhookDelivery(gateArgs({ hook: { ...hook, source: "test-other" }, rawBody, headers }));
  ok(declared.ok, "the SAME bytes verify when the hook declares that source — resolution is by declaration");

  ok(otherVerifier.signedTimestamp === false && standardWebhookVerifier.signedTimestamp === true, "the two registered verifiers DIFFER in strength (the downgrade sniffing would have enabled)");
}

{
  const rawBody = '{ "b":1, "a":1.0, "u":"é", "n":1e3 }';
  const reserialised = JSON.stringify(JSON.parse(rawBody));
  ok(reserialised !== rawBody, "the fixture body really IS round-trip-unstable (the assertion below is not vacuous)");

  const headers = signedHeaders(SECRET, rawBody);
  const accepted = await gateWebhookDelivery(gateArgs({ rawBody, headers }));
  ok(accepted.ok, "the RAW bytes verify");
  const reparsed = await gateWebhookDelivery(gateArgs({ rawBody: reserialised, bodyBytes: Buffer.byteLength(reserialised), headers }));
  ok(!reparsed.ok, "the RESERIALISED bytes do NOT verify — any parse-then-reserialise refactor turns this red");

  let seenKeys: string[] = [];
  registerWebhookVerifier({
    source: "test-shape",
    keyKind: "shared-secret",
    keyOrigin: "receiver-minted",
    signedTimestamp: false,
    verify(input): Verdict {
      seenKeys = Object.keys(input).sort();
      return { ok: true, keyIndex: 0 };
    },
  });
  await gateWebhookDelivery(gateArgs({ hook: { ...hook, source: "test-shape" }, rawBody, headers }));
  ok(seenKeys.join(",") === "headers,keys,nowMs,rawBody", `verify() input key set is exactly headers,keys,nowMs,rawBody (got ${seenKeys.join(",")})`);

  const routeSrc = readFileSync(join(HERE, "../agent/channels/webhooks.ts"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  const textCalls = routeSrc.match(/req\.text\(\)/g) ?? [];
  ok(textCalls.length === 1, `channels/webhooks.ts calls req.text() exactly once (got ${textCalls.length})`);
  ok(!/req\.json\(/.test(routeSrc), "channels/webhooks.ts never calls req.json()");
  ok(!/JSON\.parse\(/.test(routeSrc), "channels/webhooks.ts never JSON.parses the request body");
}

{
  const rawBody = JSON.stringify({ ok: true });
  ok(webhookMaxSkewSeconds() === 300, "default skew window is 300s (Slack/Stripe/Discord's five minutes, not eve's Linear 60s)");

  const at = (offsetSeconds: number): Headers => signedHeaders(SECRET, rawBody, String(Math.floor(NOW_MS / 1000) + offsetSeconds));
  ok((await gateWebhookDelivery(gateArgs({ rawBody, headers: at(299) }))).ok, "a delivery 299s in the future is accepted");
  ok((await gateWebhookDelivery(gateArgs({ rawBody, headers: at(-299) }))).ok, "a delivery 299s in the past is accepted");
  ok((await failureOf(await gateWebhookDelivery(gateArgs({ rawBody, headers: at(301) })))).includes("stale-timestamp"), "a delivery 301s in the FUTURE is stale-timestamp");
  ok((await failureOf(await gateWebhookDelivery(gateArgs({ rawBody, headers: at(-301) })))).includes("stale-timestamp"), "a delivery 301s in the PAST is stale-timestamp (the replay case)");

  const noTs = new Headers({ [SW_ID_HEADER]: MSG_ID, [SW_SIGNATURE_HEADER]: standardWebhookSignature(SECRET, MSG_ID, NOW_TS, rawBody) });
  ok((await failureOf(await gateWebhookDelivery(gateArgs({ rawBody, headers: noTs })))).includes("missing-timestamp"), "a POST with NO timestamp header is missing-timestamp (no compat flag)");
  const badTs = new Headers({ [SW_ID_HEADER]: MSG_ID, [SW_TIMESTAMP_HEADER]: "abc", [SW_SIGNATURE_HEADER]: standardWebhookSignature(SECRET, MSG_ID, "abc", rawBody) });
  ok((await failureOf(await gateWebhookDelivery(gateArgs({ rawBody, headers: badTs })))).includes("malformed-timestamp"), "a non-numeric timestamp is malformed-timestamp");
  for (const weird of ["1e3", "+" + NOW_TS, "0x7b", `${NOW_TS}.0`]) {
    const h = new Headers({ [SW_ID_HEADER]: MSG_ID, [SW_TIMESTAMP_HEADER]: weird, [SW_SIGNATURE_HEADER]: standardWebhookSignature(SECRET, MSG_ID, weird, rawBody) });
    const got = await failureOf(await gateWebhookDelivery(gateArgs({ rawBody, headers: h })));
    ok(got.includes("malformed-timestamp"), `a non-wire-form timestamp (${JSON.stringify(weird)}) is malformed-timestamp, never coerced (got: ${got})`);
  }
  const noSig = new Headers({ [SW_ID_HEADER]: MSG_ID, [SW_TIMESTAMP_HEADER]: NOW_TS });
  ok((await failureOf(await gateWebhookDelivery(gateArgs({ rawBody, headers: noSig })))).includes("missing-signature"), "no signature header at all is missing-signature");

  const boomKeys: readonly string[] = new Proxy(["k"], {
    get(target, prop, recv) {
      if (prop === "entries") throw new Error("HMAC loop was entered — skew was NOT checked first");
      return Reflect.get(target, prop, recv);
    },
  }) as unknown as readonly string[];
  const staleOutcome = await gateWebhookDelivery(gateArgs({ rawBody, headers: at(-301), secretValues: boomKeys }));
  ok((await failureOf(staleOutcome)).includes("stale-timestamp"), "a stale delivery is rejected WITHOUT entering the key/HMAC loop (a throwing key never fires)");
}

{
  const rawBody = JSON.stringify({ ok: true });
  const previous = "old-s3cr3t";
  const signedWithPrevious = signedHeaders(previous, rawBody);
  const signedWithCurrent = signedHeaders(SECRET, rawBody);

  const cur = await gateWebhookDelivery(gateArgs({ rawBody, headers: signedWithCurrent, secretValues: [SECRET, previous] }));
  ok(cur.ok && cur.keyIndex === 0, "the CURRENT key verifies at keyIndex 0");
  const prev = await gateWebhookDelivery(gateArgs({ rawBody, headers: signedWithPrevious, secretValues: [SECRET, previous] }));
  ok(prev.ok && prev.keyIndex === 1, "a PREVIOUS key verifies at keyIndex 1 — the signal the route audits as previousKey:true");
  const ended = await gateWebhookDelivery(gateArgs({ rawBody, headers: signedWithPrevious, secretValues: [SECRET] }));
  ok(!ended.ok && (await failureOf(ended)).includes("signature-mismatch"), "once the overlap ends the retired key is a signature-mismatch 401");
  const single = await gateWebhookDelivery(gateArgs({ rawBody, headers: signedWithCurrent, secretValues: [SECRET] }));
  ok(single.ok && single.keyIndex === 0, "N=1 reports keyIndex 0 through the identical code path");
}

{
  registerWebhookVerifier({
    source: "test-broken",
    keyKind: "shared-secret",
    keyOrigin: "receiver-minted",
    signedTimestamp: false,
    verify(): Verdict {
      throw new Error("verifier is broken");
    },
  });
  const outcome = await gateWebhookDelivery(gateArgs({ hook: { ...hook, source: "test-broken" } }));
  ok(!outcome.ok && outcome.rejection.status === 401, "a verifier that THROWS is a 401, not a 500 — a broken verifier still fails closed");
  ok((await failureOf(outcome)).includes("THREW"), "…and says so loudly enough to find in the route log");
}

{
  registerWebhookVerifier({
    source: "test-async",
    keyKind: "public-key",
    keyOrigin: "vendor-issued",
    signedTimestamp: true,
    async verify(): Promise<Verdict> {
      await Promise.resolve();
      return { ok: true, keyIndex: 0 };
    },
  });
  const outcome = await gateWebhookDelivery(gateArgs({ hook: { ...hook, source: "test-async" } }));
  ok(outcome.ok, "an ASYNC verifier is awaited (Teams-class JWT/JWKS verification stays expressible)");
}

{
  const unknown = await gateWebhookDelivery(gateArgs({ hook: undefined }));
  ok(!unknown.ok && unknown.rejection.status === 404, "an unknown hook id is still 404 (checked before everything)");
  const oversized = await gateWebhookDelivery(gateArgs({ hook: { ...hook, source: "no-such-source" }, bodyBytes: 999_999 }));
  ok(!oversized.ok && oversized.rejection.status === 413, "an OVERSIZED body is 413 BEFORE verifier resolution — no crypto, and no registry lookup, for megabytes we are rejecting");
  const noKeys = await gateWebhookDelivery(gateArgs({ secretValues: [] }));
  ok(!noKeys.ok && noKeys.rejection.status === 401 && noKeys.rejection.reason.includes("DEPLOY_STATUS_WEBHOOK_SECRET"), "no resolvable key is still the 401 naming the CURRENT ref (a pointer, never a value)");
  const blank = await gateWebhookDelivery(gateArgs({ secretValues: [""] }));
  ok(!blank.ok, "an empty-string key is treated as unset");
}

{
  const rawBody = JSON.stringify({ note: "hello-e2e" });
  const ts = webhookTimestamp(NOW_MS);
  ok(ts === NOW_TS, "the forge's timestamp helper emits unix SECONDS");
  const forged = signWebhookBody(SECRET, rawBody, ts, MSG_ID);
  ok(forged === standardWebhookSignature(SECRET, MSG_ID, ts, rawBody), "the e2e forge's signature is byte-identical to the real verifier's (the two independent implementations agree)");
  ok(standardWebhookSignedContent(MSG_ID, ts, rawBody) === `${MSG_ID}.${ts}.${rawBody}`, "the signed content is <id>.<ts>.<rawBody> (a scheme change is a SIGNED-CONTENT change, not a header change)");
  const prefixed = "whsec_MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3";
  ok(
    signWebhookBody(prefixed, rawBody, ts, MSG_ID) === standardWebhookSignature(prefixed, MSG_ID, ts, rawBody),
    "🔴 the forge applies the SAME whsec_ key rule as the verifier (a UTF-8-bytes forge would 401 on every delivery with no stated reason)",
  );
  const headersFor = (signature: string): Headers => new Headers({ [SW_ID_HEADER]: MSG_ID, [SW_TIMESTAMP_HEADER]: ts, [SW_SIGNATURE_HEADER]: signature });
  const outcome = await gateWebhookDelivery(gateArgs({ rawBody, headers: headersFor(forged) }));
  ok(outcome.ok, "a body signed by the e2e forge verifies through the live gate");
  ok(!(await gateWebhookDelivery(gateArgs({ rawBody: rawBody + "x", bodyBytes: rawBody.length + 1, headers: headersFor(forged) }))).ok, "a tampered body fails");
  ok(!(await gateWebhookDelivery(gateArgs({ rawBody, secretValues: ["wrong"], headers: headersFor(forged) }))).ok, "the wrong secret fails");
}

{
  const UNDEFENDED_REPLAY_SOURCES = ["test-broken", "test-other", "test-shape"];
  const undefended = registeredWebhookVerifiers()
    .filter((v) => !v.signedTimestamp)
    .map((v) => v.source)
    .sort();
  ok(
    undefended.join(",") === UNDEFENDED_REPLAY_SOURCES.join(","),
    `every signedTimestamp:false verifier is on the reviewed allowlist (expected ${UNDEFENDED_REPLAY_SOURCES.join(",")}, got ${undefended.join(",")})`,
  );
  ok(!undefended.includes(OE_STANDARD_WEBHOOK_SCHEME), "OUR OWN scheme is NOT on the undefended-replay allowlist — it signs a timestamp AND a delivery id, which is what OPE-213 kept it for");
}

{
  resetWebhookVerifiersForTest();
  ok(registeredWebhookVerifierSources().length === 0, "resetWebhookVerifiersForTest clears the registry");
  const outcome = await gateWebhookDelivery(gateArgs({ headers: signedHeaders(SECRET, JSON.stringify({ ok: true })) }));
  ok(!outcome.ok && outcome.rejection.status === 401, "with an EMPTY registry every delivery 401s — an unarmed registry dispatches nothing");
  ok((await failureOf(outcome)).includes("(none)"), "…and the refusal says the registered set is empty rather than printing a bare list");
}

console.log(`✓ webhook-verifier: ${passed} assertions passed`);

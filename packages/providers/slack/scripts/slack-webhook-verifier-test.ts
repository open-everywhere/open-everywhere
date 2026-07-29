let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const { slackWebhookVerifier, SLACK_WEBHOOK_SOURCE } = await import("../agent/channels/slack-webhook-verifier.js");
const { slackSignature, SLACK_SIGNATURE_HEADER, SLACK_TIMESTAMP_HEADER } = await import("../agent/channels/slack-signature.js");
const { verifySlackSignature } = await import("../agent/channels/slack-front.js");
const { registerWebhookVerifier, webhookVerifier, registeredWebhookVerifierSources, resetWebhookVerifiersForTest, declareProviderSelection } =
  await import("@open-everywhere/core/agent/adapter-api.js");

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const TS = "1531420618";
const BODY =
  "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V" +
  "&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=" +
  "&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN" +
  "&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
const PUBLISHED = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";

const NOW_MS = Number(TS) * 1000;

function headers(over: Record<string, string> = {}): Headers {
  return new Headers({ [SLACK_TIMESTAMP_HEADER]: TS, [SLACK_SIGNATURE_HEADER]: PUBLISHED, ...over });
}

{
  ok(slackSignature(SECRET, TS, BODY) === PUBLISHED, "the shared primitive reproduces SLACK'S PUBLISHED signature byte-for-byte");

  const verdict = await slackWebhookVerifier.verify({ rawBody: BODY, headers: headers(), keys: [SECRET], nowMs: NOW_MS });
  ok(verdict.ok && verdict.keyIndex === 0, "Slack's PUBLISHED test vector verifies through the registered slack verifier");

  ok(verifySlackSignature(BODY, headers(), SECRET, NOW_MS), "…and through the front door's verifySlackSignature (one basestring, two callers)");
}

{
  const tamperedBody = await slackWebhookVerifier.verify({ rawBody: BODY + " ", headers: headers(), keys: [SECRET], nowMs: NOW_MS });
  ok(!tamperedBody.ok && tamperedBody.failure === "signature-mismatch", "one extra byte in the RAW body fails — the digest covers the exact bytes");

  const flipped = PUBLISHED.slice(0, -1) + (PUBLISHED.endsWith("3") ? "4" : "3");
  const mutated = await slackWebhookVerifier.verify({ rawBody: BODY, headers: headers({ [SLACK_SIGNATURE_HEADER]: flipped }), keys: [SECRET], nowMs: NOW_MS });
  ok(!mutated.ok && mutated.failure === "signature-mismatch", "a ONE-CHARACTER mutation of a valid signature is REJECTED (signature-mismatch)");
  ok(!verifySlackSignature(BODY, headers({ [SLACK_SIGNATURE_HEADER]: flipped }), SECRET, NOW_MS), "…and the front door rejects the same mutation");

  const wrongKey = await slackWebhookVerifier.verify({ rawBody: BODY, headers: headers(), keys: ["wrong"], nowMs: NOW_MS });
  ok(!wrongKey.ok && wrongKey.failure === "signature-mismatch", "the wrong signing secret fails");

  const noSig = await slackWebhookVerifier.verify({ rawBody: BODY, headers: new Headers({ [SLACK_TIMESTAMP_HEADER]: TS }), keys: [SECRET], nowMs: NOW_MS });
  ok(!noSig.ok && noSig.failure === "missing-signature", "no x-slack-signature header is missing-signature");

  const noTs = await slackWebhookVerifier.verify({ rawBody: BODY, headers: new Headers({ [SLACK_SIGNATURE_HEADER]: PUBLISHED }), keys: [SECRET], nowMs: NOW_MS });
  ok(!noTs.ok && noTs.failure === "missing-timestamp", "the timestamp is SIGNED CONTENT, so its absence is missing-timestamp (not missing-signature)");

  for (const bad of ["1e9", "1531420618.0", "-1531420618", "", "0x5B4B5F4A"]) {
    const v = await slackWebhookVerifier.verify({ rawBody: BODY, headers: headers({ [SLACK_TIMESTAMP_HEADER]: bad }), keys: [SECRET], nowMs: NOW_MS });
    ok(!v.ok && v.failure === "malformed-timestamp", `timestamp ${JSON.stringify(bad)} is malformed-timestamp — never coerced into a passing window`);
  }
  {
    const padded = await slackWebhookVerifier.verify({ rawBody: BODY, headers: headers({ [SLACK_TIMESTAMP_HEADER]: ` ${TS} ` }), keys: [SECRET], nowMs: NOW_MS });
    ok(padded.ok, "a timestamp header with surrounding whitespace VERIFIES — Headers trims it before the verifier ever sees it");
  }

  const otherVersion = await slackWebhookVerifier.verify({
    rawBody: BODY,
    headers: headers({ [SLACK_SIGNATURE_HEADER]: PUBLISHED.replace(/^v0=/, "v1=") }),
    keys: [SECRET],
    nowMs: NOW_MS,
  });
  ok(!otherVersion.ok && otherVersion.failure === "unsupported-scheme", "a signature tagged with an unimplemented version is unsupported-scheme, never a match attempt");

  const { webhookMaxSkewSeconds } = await import("@open-everywhere/core/agent/adapter-api.js");
  const stale = await slackWebhookVerifier.verify({
    rawBody: BODY,
    headers: headers(),
    keys: [SECRET],
    nowMs: NOW_MS + (webhookMaxSkewSeconds() + 1) * 1000,
  });
  ok(!stale.ok && stale.failure === "stale-timestamp", "a VALIDLY SIGNED delivery past the deployment skew window is stale-timestamp");
  const fresh = await slackWebhookVerifier.verify({
    rawBody: BODY,
    headers: headers(),
    keys: [SECRET],
    nowMs: NOW_MS + (webhookMaxSkewSeconds() - 1) * 1000,
  });
  ok(fresh.ok, "…and one second INSIDE it still verifies (the window is the bound, not an off-by-one)");

  const rotating = await slackWebhookVerifier.verify({ rawBody: BODY, headers: headers(), keys: ["new-secret", SECRET], nowMs: NOW_MS });
  ok(rotating.ok && rotating.keyIndex === 1, "a delivery still signed with the PREVIOUS key verifies at keyIndex 1 (our self-managed overlap)");
}

{
  const a = await slackWebhookVerifier.verify({ rawBody: BODY, headers: headers(), keys: [SECRET], nowMs: NOW_MS });
  ok(a.ok && typeof a.replayKey === "string" && /^[0-9a-f]{64}$/.test(a.replayKey), "an accepted verdict carries a replayKey (a signedTimestamp:true verifier that forgets one loses the 409 silently)");
  const again = await slackWebhookVerifier.verify({ rawBody: BODY, headers: headers(), keys: [SECRET], nowMs: NOW_MS });
  ok(again.ok && a.ok && again.replayKey === a.replayKey, "the SAME signed content yields the SAME replayKey — which is what makes the durable single-use mark work");
  const viaPrevious = await slackWebhookVerifier.verify({ rawBody: BODY, headers: headers(), keys: ["new-secret", SECRET], nowMs: NOW_MS });
  ok(viaPrevious.ok && a.ok && viaPrevious.replayKey === a.replayKey, "…and it does NOT change across a rotation overlap (it is derived from the SIGNED CONTENT, not the signature)");
  ok(a.ok && !a.replayKey!.includes(SECRET) && !a.replayKey!.includes(BODY.slice(0, 16)), "…and it is a hash, not the material itself");
}

{
  ok(slackWebhookVerifier.source === SLACK_WEBHOOK_SOURCE && SLACK_WEBHOOK_SOURCE === "slack", "the registry key is the vendor's source name");
  ok(slackWebhookVerifier.provider === "slack", "the entry is PROVIDER-owned, so its registration is routed through the selection gate");
  ok(slackWebhookVerifier.keyKind === "shared-secret", "slack's scheme is a shared-secret HMAC");
  ok(slackWebhookVerifier.keyOrigin === "vendor-issued", "slack declares keyOrigin:vendor-issued — the Signing Secret is Slack's to generate, so a secret WE minted could never verify");
  ok(slackWebhookVerifier.signedTimestamp === true, "slack declares signedTimestamp:true — the timestamp is inside the basestring and this verifier enforces a window over it");
}

{
  resetWebhookVerifiersForTest();
  declareProviderSelection(["notion"]);
  const landed = registerWebhookVerifier(slackWebhookVerifier);
  ok(landed === false, "an UNSELECTED provider's verifier registration is REFUSED (returns false, does not throw)");
  ok(webhookVerifier("slack") === undefined, "…and writes ZERO registry rows, so a `source: \"slack\"` hook fails closed at the gate");
  ok(registeredWebhookVerifierSources().length === 0, "the registry stays empty");

  declareProviderSelection(["notion", "slack"]);
  ok(registerWebhookVerifier(slackWebhookVerifier) === true, "a SELECTED provider's verifier registers");
  ok(webhookVerifier("slack") === slackWebhookVerifier, "…and resolves by its source");
}

console.log(`✓ slack-webhook-verifier: ${passed} assertions passed`);

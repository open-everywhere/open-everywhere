// proves: ROUT-70

import { createHmac } from "node:crypto";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const { notionWebhookVerifier, NOTION_WEBHOOK_SOURCE } = await import("../agent/channels/notion-webhook-verifier.js");
const { registerWebhookVerifier, webhookVerifier, resetWebhookVerifiersForTest, declareProviderSelection } = await import(
  "@open-everywhere/core/agent/adapter-api.js"
);

const NOW_MS = Date.parse("2026-07-26T12:00:00.000Z");
const TOKEN = "secret_verification_token";
const RAW = '{"type":"page.content_updated","entity":{"id":"abc"}}';
const SIGNATURE = "sha256=" + createHmac("sha256", TOKEN).update(RAW, "utf8").digest("hex");

{
  const headers = new Headers({ "x-notion-signature": SIGNATURE });
  const verdict = await notionWebhookVerifier.verify({ rawBody: RAW, headers, keys: [TOKEN], nowMs: NOW_MS });
  ok(verdict.ok && verdict.keyIndex === 0, "a Notion-signed body verifies (x-notion-signature: sha256=<hex> over the RAW body, keyed by the verification_token)");

  const spaced = RAW.replace(/","/g, '", "');
  ok(spaced !== RAW, "the whitespace-shifted body really differs (not a vacuous assertion)");
  const shifted = await notionWebhookVerifier.verify({ rawBody: spaced, headers, keys: [TOKEN], nowMs: NOW_MS });
  ok(!shifted.ok && shifted.failure === "signature-mismatch", "a whitespace-shifted body fails — the digest covers the exact bytes as received");

  const noHeader = await notionWebhookVerifier.verify({ rawBody: RAW, headers: new Headers(), keys: [TOKEN], nowMs: NOW_MS });
  ok(!noHeader.ok && noHeader.failure === "missing-signature", "no x-notion-signature header is missing-signature");
  const wrongKey = await notionWebhookVerifier.verify({ rawBody: RAW, headers, keys: ["not-the-token"], nowMs: NOW_MS });
  ok(!wrongKey.ok && wrongKey.failure === "signature-mismatch", "the wrong verification_token fails");

  const rotating = await notionWebhookVerifier.verify({ rawBody: RAW, headers, keys: ["rotated-token", TOKEN], nowMs: NOW_MS });
  ok(rotating.ok && rotating.keyIndex === 1, "a delivery on the PREVIOUS token verifies at keyIndex 1 (Notion documents no overlap — keys[] is how we get one)");
}

{
  ok(notionWebhookVerifier.source === NOTION_WEBHOOK_SOURCE && NOTION_WEBHOOK_SOURCE === "notion", "the registry key is the vendor's source name");
  ok(notionWebhookVerifier.provider === "notion", "the entry is PROVIDER-owned, so its registration is routed through the selection gate");
  ok(notionWebhookVerifier.keyKind === "shared-secret", "notion's scheme is a shared-secret HMAC (the one-time verification_token)");
  ok(notionWebhookVerifier.signedTimestamp === false, "notion declares signedTimestamp:false — replay against this source is UNDEFENDED, on the record");
}

{
  resetWebhookVerifiersForTest();
  declareProviderSelection(["github"]);
  ok(registerWebhookVerifier(notionWebhookVerifier) === false, "an UNSELECTED provider's verifier registration is REFUSED (returns false, does not throw)");
  ok(webhookVerifier("notion") === undefined, "…and writes ZERO rows, so a `source: \"notion\"` hook fails closed at the gate");

  declareProviderSelection(["github", "notion"]);
  ok(registerWebhookVerifier(notionWebhookVerifier) === true, "a SELECTED provider's verifier registers");
  ok(webhookVerifier("notion") === notionWebhookVerifier, "…and resolves by its source");
}

console.log(`✓ notion-webhook-verifier: ${passed} assertions passed`);

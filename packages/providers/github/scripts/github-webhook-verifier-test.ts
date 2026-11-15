let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const { githubWebhookVerifier, GITHUB_WEBHOOK_SOURCE } = await import("../agent/channels/github-webhook-verifier.js");
const { registerWebhookVerifier, webhookVerifier, registeredWebhookVerifierSources, resetWebhookVerifiersForTest, declareProviderSelection } =
  await import("@open-everywhere/core/agent/adapter-api.js");

const NOW_MS = Date.parse("2026-07-26T12:00:00.000Z");

{
  const secret = "It's a Secret to Everybody";
  const rawBody = "Hello, World!";
  const published = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  const headers = new Headers({ "x-hub-signature-256": published });
  const verdict = await githubWebhookVerifier.verify({ rawBody, headers, keys: [secret], nowMs: NOW_MS });
  ok(verdict.ok && verdict.keyIndex === 0, "GitHub's PUBLISHED test vector verifies through the registered github verifier");

  const tampered = await githubWebhookVerifier.verify({ rawBody: rawBody + " ", headers, keys: [secret], nowMs: NOW_MS });
  ok(!tampered.ok && tampered.failure === "signature-mismatch", "one extra byte in the RAW body fails — the digest covers the exact bytes");
  const wrongKey = await githubWebhookVerifier.verify({ rawBody, headers, keys: ["wrong"], nowMs: NOW_MS });
  ok(!wrongKey.ok && wrongKey.failure === "signature-mismatch", "the wrong secret fails");
  const noHeader = await githubWebhookVerifier.verify({ rawBody, headers: new Headers(), keys: [secret], nowMs: NOW_MS });
  ok(!noHeader.ok && noHeader.failure === "missing-signature", "no x-hub-signature-256 header is missing-signature");

  const sha1Only = await githubWebhookVerifier.verify({ rawBody, headers: new Headers({ "x-hub-signature": published }), keys: [secret], nowMs: NOW_MS });
  ok(!sha1Only.ok && sha1Only.failure === "missing-signature", "the legacy SHA-1 header alone is NOT accepted (no downgrade the sender can pick)");

  const rotating = await githubWebhookVerifier.verify({ rawBody, headers, keys: ["new-key", secret], nowMs: NOW_MS });
  ok(rotating.ok && rotating.keyIndex === 1, "a delivery still signed with the PREVIOUS key verifies at keyIndex 1 (our self-managed overlap; GitHub documents none)");
}

{
  ok(githubWebhookVerifier.source === GITHUB_WEBHOOK_SOURCE && GITHUB_WEBHOOK_SOURCE === "github", "the registry key is the vendor's source name");
  ok(githubWebhookVerifier.provider === "github", "the entry is PROVIDER-owned, so its registration is routed through the selection gate");
  ok(githubWebhookVerifier.keyKind === "shared-secret", "github's scheme is a shared-secret HMAC");
  ok(githubWebhookVerifier.signedTimestamp === false, "github declares signedTimestamp:false — replay against this source is UNDEFENDED, on the record");
}

{
  resetWebhookVerifiersForTest();
  declareProviderSelection(["notion"]);
  const landed = registerWebhookVerifier(githubWebhookVerifier);
  ok(landed === false, "an UNSELECTED provider's verifier registration is REFUSED (returns false, does not throw)");
  ok(webhookVerifier("github") === undefined, "…and writes ZERO registry rows, so a `source: \"github\"` hook fails closed at the gate");
  ok(registeredWebhookVerifierSources().length === 0, "the registry stays empty");

  declareProviderSelection(["notion", "github"]);
  ok(registerWebhookVerifier(githubWebhookVerifier) === true, "a SELECTED provider's verifier registers");
  ok(webhookVerifier("github") === githubWebhookVerifier, "…and resolves by its source");
}

console.log(`✓ github-webhook-verifier: ${passed} assertions passed`);

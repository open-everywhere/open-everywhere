import { verifyGithubSignature, type WebhookVerifier } from "@open-everywhere/core/agent/adapter-api.js";

export const GITHUB_WEBHOOK_SOURCE = "github";

const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";

export const githubWebhookVerifier: WebhookVerifier = {
  source: GITHUB_WEBHOOK_SOURCE,
  provider: "github",
  keyKind: "shared-secret",
  keyOrigin: "receiver-minted",
  signedTimestamp: false,
  verify({ rawBody, headers, keys }) {
    const signature = headers.get(GITHUB_SIGNATURE_HEADER);
    if (!signature) return { ok: false, failure: "missing-signature" };
    for (const [i, key] of keys.entries()) {
      if (verifyGithubSignature(key, rawBody, signature)) return { ok: true, keyIndex: i };
    }
    return { ok: false, failure: "signature-mismatch" };
  },
};

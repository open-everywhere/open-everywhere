import { verifyNotionSignature } from "./notion-api.js";
import type { WebhookVerifier } from "@open-everywhere/core/agent/adapter-api.js";

export const NOTION_WEBHOOK_SOURCE = "notion";

const NOTION_SIGNATURE_HEADER = "x-notion-signature";

export const notionWebhookVerifier: WebhookVerifier = {
  source: NOTION_WEBHOOK_SOURCE,
  provider: "notion",
  keyKind: "shared-secret",
  signedTimestamp: false,
  verify({ rawBody, headers, keys }) {
    const signature = headers.get(NOTION_SIGNATURE_HEADER);
    if (!signature) return { ok: false, failure: "missing-signature" };
    for (const [i, key] of keys.entries()) {
      if (verifyNotionSignature(key, rawBody, signature)) return { ok: true, keyIndex: i };
    }
    return { ok: false, failure: "signature-mismatch" };
  },
};

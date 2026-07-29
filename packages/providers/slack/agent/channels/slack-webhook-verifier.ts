import { createHash } from "node:crypto";
import {
  SLACK_SIGNATURE_HEADER,
  SLACK_SIGNATURE_VERSION,
  SLACK_TIMESTAMP_HEADER,
  slackSignatureMatches,
} from "./slack-signature.js";
import { webhookMaxSkewSeconds, type WebhookVerifier } from "@open-everywhere/core/agent/adapter-api.js";

export const SLACK_WEBHOOK_SOURCE = "slack";

const TIMESTAMP_RE = /^[0-9]{1,15}$/;

function slackReplayKey(timestamp: string, rawBody: string): string {
  return createHash("sha256").update(`${SLACK_WEBHOOK_SOURCE}:${timestamp}:${rawBody}`).digest("hex");
}

export const slackWebhookVerifier: WebhookVerifier = {
  source: SLACK_WEBHOOK_SOURCE,
  provider: "slack",
  keyKind: "shared-secret",
  keyOrigin: "vendor-issued",
  signedTimestamp: true,
  verify({ rawBody, headers, keys, nowMs }) {
    const signature = headers.get(SLACK_SIGNATURE_HEADER);
    if (!signature) return { ok: false, failure: "missing-signature" };
    const timestamp = headers.get(SLACK_TIMESTAMP_HEADER);
    if (timestamp === null) return { ok: false, failure: "missing-timestamp" };
    if (!TIMESTAMP_RE.test(timestamp)) return { ok: false, failure: "malformed-timestamp" };
    if (Math.abs(nowMs / 1000 - Number(timestamp)) > webhookMaxSkewSeconds()) return { ok: false, failure: "stale-timestamp" };
    if (!signature.startsWith(`${SLACK_SIGNATURE_VERSION}=`)) return { ok: false, failure: "unsupported-scheme" };
    for (const [i, key] of keys.entries()) {
      if (slackSignatureMatches(key, timestamp, rawBody, signature)) {
        return { ok: true, keyIndex: i, replayKey: slackReplayKey(timestamp, rawBody) };
      }
    }
    return { ok: false, failure: "signature-mismatch" };
  },
};

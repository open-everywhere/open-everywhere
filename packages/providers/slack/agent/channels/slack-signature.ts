import { createHmac, timingSafeEqual } from "node:crypto";

export const SLACK_SIGNATURE_HEADER = "x-slack-signature";
export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
export const SLACK_SIGNATURE_VERSION = "v0";

export function slackSignature(secret: string, timestamp: string, rawBody: string): string {
  return `${SLACK_SIGNATURE_VERSION}=${createHmac("sha256", secret).update(`${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody}`).digest("hex")}`;
}

export function slackSignatureMatches(secret: string, timestamp: string, rawBody: string, presented: string): boolean {
  const a = Buffer.from(slackSignature(secret, timestamp, rawBody));
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

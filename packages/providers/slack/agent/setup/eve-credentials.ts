import { slackSignatureMatches, SLACK_SIGNATURE_HEADER, SLACK_TIMESTAMP_HEADER } from "../channels/slack-signature.js";
import { slackBotToken, slackSigningSecret } from "./credentials.js";

const MAX_SKEW_SECONDS = 60 * 5;

export async function verifySlackInboundForEve(request: Request, body: string): Promise<void> {
  const secret = await slackSigningSecret();
  if (!secret) {
    throw new Error(
      "SLACK_SIGNING_SECRET is not set and no signing secret is stored — this deployment cannot verify a Slack request. " +
        "Run /setup, or set SLACK_SIGNING_SECRET.",
    );
  }
  const timestamp = request.headers.get(SLACK_TIMESTAMP_HEADER);
  const signature = request.headers.get(SLACK_SIGNATURE_HEADER);
  if (!timestamp || !signature) throw new Error("slack inbound: the request carries no signature headers.");

  const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_SECONDS) throw new Error("slack inbound: the signed timestamp is outside the accepted window.");

  if (!slackSignatureMatches(secret, timestamp, body, signature)) throw new Error("slack inbound: the signature does not match.");
}

export async function slackBotTokenForEve(): Promise<string> {
  const token = await slackBotToken();
  if (!token) throw new Error("SLACK_BOT_TOKEN is required.");
  return token;
}

export const SLACK_EVE_CREDENTIALS = {
  webhookVerifier: verifySlackInboundForEve,
  botToken: slackBotTokenForEve,
} as const;

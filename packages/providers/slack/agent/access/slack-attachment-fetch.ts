import {
  assertSafeFetchUrl,
  auditToolAction,
  hostCallAuditFields,
  type BindableContext,
  type EgressDispatch,
  type EgressRefusalCause,
} from "@open-everywhere/core/agent/adapter-api.js";

const SLACK_BOT_TOKEN_REF = "SLACK_BOT_TOKEN";

const ATTACHMENT_VERB = "GET";

const SLACK_FILE_HOSTS: ReadonlySet<string> = new Set(["files.slack.com"]);

function isSlackFileHost(hostname: string): boolean {
  return SLACK_FILE_HOSTS.has(hostname.toLowerCase());
}

export interface TrustedSlackAttachment {
  readonly urlPrivate: string;
  readonly id?: string;
}

export async function fetchSlackAttachment(ctx: BindableContext, ref: TrustedSlackAttachment): Promise<Response> {
  let url: URL;
  try {
    url = new URL(ref.urlPrivate);
  } catch {
    throw new Error("describe_image: the Slack attachment URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error(`describe_image: refusing to send the Slack bot token over a non-HTTPS URL ("${url.protocol}").`);
  }
  if (!isSlackFileHost(url.hostname)) {
    await auditToolAction(ctx, "slack.attachment.deny", {
      ...hostCallAuditFields({ host: url.hostname, verb: ATTACHMENT_VERB, outcome: "denied" }),
      reason: "not-slack-file-host",
      id: ref.id,
    });
    throw new Error(`describe_image: refusing to send the Slack bot token to non-Slack host "${url.hostname}".`);
  }
  let safe: EgressDispatch;
  try {
    safe = await assertSafeFetchUrl(ref.urlPrivate);
  } catch (err) {
    const resolveFailed = (err as { oeEgressCause?: EgressRefusalCause })?.oeEgressCause === "resolve-failed";
    await auditToolAction(ctx, "slack.attachment.deny", {
      ...hostCallAuditFields({ host: url.hostname, verb: ATTACHMENT_VERB, outcome: resolveFailed ? "failed" : "denied" }),
      reason: resolveFailed ? "resolve-failed" : "ssrf",
      id: ref.id,
    });
    throw err;
  }
  if (!isSlackFileHost(safe.url.hostname)) {
    await auditToolAction(ctx, "slack.attachment.deny", {
      ...hostCallAuditFields({ host: safe.url.hostname, verb: ATTACHMENT_VERB, outcome: "denied" }),
      reason: "not-slack-file-host",
      id: ref.id,
    });
    throw new Error(`describe_image: refusing to send the Slack bot token to non-Slack host "${safe.url.hostname}".`);
  }
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("describe_image: SLACK_BOT_TOKEN is not set — the bot token is required to download a Slack attachment.");
  }
  const row = (outcome: "allowed" | "failed", extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...hostCallAuditFields({
      host: safe.url.hostname,
      verb: ATTACHMENT_VERB,
      outcome,
      credential: SLACK_BOT_TOKEN_REF,
    }),
    id: ref.id,
    route: safe.via,
    antiRebind: safe.antiRebind,
    ...extra,
  });
  let response: Response;
  try {
    response = await fetch(safe.url, {
      dispatcher: safe.dispatcher,
      redirect: "error",
      headers: { authorization: `Bearer ${token}` },
    } as unknown as RequestInit);
  } catch (err) {
    await auditToolAction(ctx, "slack.attachment.allow", row("failed"));
    throw err;
  }
  await auditToolAction(ctx, "slack.attachment.allow", row("allowed", { status: response.status }));
  return response;
}

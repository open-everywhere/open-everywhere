import { Agent } from "undici";
import { assertSafeFetchUrl } from "./host-egress.js";
import type { BindableContext } from "../identity/binding.js";
import { auditToolAction } from "../audit/tool-action.js";

const SLACK_FILE_HOSTS: ReadonlySet<string> = new Set(["files.slack.com"]);

export function isSlackFileHost(hostname: string): boolean {
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
    await auditToolAction(ctx, "slack.attachment.deny", { host: url.hostname, reason: "not-slack-file-host", id: ref.id });
    throw new Error(`describe_image: refusing to send the Slack bot token to non-Slack host "${url.hostname}".`);
  }
  let safe: { url: URL; dispatcher: Agent };
  try {
    safe = await assertSafeFetchUrl(ref.urlPrivate);
  } catch (err) {
    await auditToolAction(ctx, "slack.attachment.deny", { host: url.hostname, reason: "ssrf", id: ref.id });
    throw err;
  }
  if (!isSlackFileHost(safe.url.hostname)) {
    await auditToolAction(ctx, "slack.attachment.deny", { host: safe.url.hostname, reason: "not-slack-file-host", id: ref.id });
    throw new Error(`describe_image: refusing to send the Slack bot token to non-Slack host "${safe.url.hostname}".`);
  }
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("describe_image: SLACK_BOT_TOKEN is not set — the bot token is required to download a Slack attachment.");
  }
  await auditToolAction(ctx, "slack.attachment.allow", { host: safe.url.hostname, id: ref.id });
  return fetch(safe.url, {
    dispatcher: safe.dispatcher,
    redirect: "error",
    headers: { authorization: `Bearer ${token}` },
  } as unknown as RequestInit);
}

import { ingestUntrusted } from "../access/untrusted.js";

export type WakeReason = "channel-activity" | "dispatch" | "message-edited";

export type WakeTrust = "principal" | "peer" | "relay";

export type WakeMessageSender = "human" | "agent";

export interface WakeChannelMeta {
  readonly id: string;
  readonly type?: string;
  readonly memberCount?: number;
}

export interface WakeThreadMeta {
  readonly ts: string;
  readonly sessionOwner?: string;
}

export interface WakeAttachment {
  readonly kind: "image" | "file";
  readonly id?: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly url?: string;
}

export interface WakeMessageInput {
  readonly from: WakeMessageSender;
  readonly author: string;
  readonly authorId?: string;
  readonly id: string;
  readonly sentAt: string;
  readonly trust: WakeTrust;
  readonly trigger?: boolean;
  readonly mention?: boolean;
  readonly edited?: boolean;
  readonly previousBody?: string;
  readonly ownerToken?: string;
  readonly attachments?: readonly WakeAttachment[];
  readonly body: string;
}

export interface WakeEnvelopeInput {
  readonly reason: WakeReason;
  readonly currentTime: string;
  readonly channel: WakeChannelMeta;
  readonly thread?: WakeThreadMeta;
  readonly messages: readonly WakeMessageInput[];
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function attr(name: string, value: string | undefined): string {
  return value === undefined ? "" : ` ${name}="${escapeXml(value)}"`;
}

function boolAttr(name: string, value: boolean | undefined): string {
  return value ? ` ${name}="true"` : "";
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((line) => (line.length ? pad + line : line))
    .join("\n");
}

function renderMessage(m: WakeMessageInput): string {
  const edited = Boolean(m.edited || m.previousBody);
  const attrs =
    boolAttr("trigger", m.trigger) +
    attr("from", m.from) +
    attr("trust", m.trust) +
    boolAttr("mention", m.mention) +
    boolAttr("edited", edited) +
    attr("author", m.author) +
    attr("author-id", m.authorId) +
    attr("id", m.id) +
    attr("sent-at", m.sentAt) +
    attr("thread-session-id", m.ownerToken);

  const body = ingestUntrusted(escapeXml(m.body), { source: "slack-message" });
  const previousBody = m.previousBody
    ? `\n<previous-body>\n${indent(ingestUntrusted(escapeXml(m.previousBody), { source: "slack-message-previous" }), 2)}\n</previous-body>`
    : "";
  const attachments = (m.attachments ?? [])
    .map((a) => `\n<attachment${attr("kind", a.kind)}${attr("id", a.id)}${attr("name", a.name)}${attr("mimetype", a.mimeType)}${attr("url", a.url)}/>`)
    .join("");

  return `<message${attrs}>\n${indent(body, 2)}${previousBody}${attachments}\n</message>`;
}

function renderChannelOpen(c: WakeChannelMeta): string {
  const memberCount = c.memberCount === undefined ? undefined : String(c.memberCount);
  return `<channel${attr("id", c.id)}${attr("type", c.type)}${attr("member-count", memberCount)}>`;
}

function renderThreadOpen(t: WakeThreadMeta): string {
  return `<thread${attr("ts", t.ts)}${attr("session-owner", t.sessionOwner)}>`;
}

export function renderWakeEnvelope(input: WakeEnvelopeInput): string {
  if (input.messages.length === 0) {
    throw new Error("renderWakeEnvelope: at least one message is required");
  }
  const triggerCount = input.messages.filter((m) => m.trigger).length;
  if (triggerCount !== 1) {
    throw new Error(`renderWakeEnvelope: exactly one message must carry trigger=true (got ${triggerCount})`);
  }
  if (input.messages.length > 1 && !input.messages[input.messages.length - 1].trigger) {
    throw new Error("renderWakeEnvelope: the trigger message must be last (backscroll ends at the trigger)");
  }

  const messagesXml = input.messages.map((m) => renderMessage(m)).join("\n");
  const channelOpen = renderChannelOpen(input.channel);

  const channelBody = input.thread
    ? `${indent(renderThreadOpen(input.thread), 2)}\n${indent(messagesXml, 4)}\n${indent("</thread>", 2)}`
    : indent(messagesXml, 2);

  const lines = [
    `<wake${attr("reason", input.reason)}${attr("current-time", input.currentTime)}>`,
    indent(channelOpen, 2),
    channelBody,
    indent("</channel>", 2),
    `</wake>`,
  ];
  return lines.join("\n");
}

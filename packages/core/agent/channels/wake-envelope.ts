import { ingestUntrusted } from "../access/untrusted.js";

export type WakeReason =
  | "channel-activity"
  | "thread-activity"
  | "mention"
  | "dm"
  | "dispatch"
  | "message-edited";

export type WakeTrust = "principal" | "peer" | "relay";

export type WakeMessageSender = "human" | "agent" | "self" | "system";

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
  readonly handle?: string;
  readonly id: string;
  readonly sentAt: string;
  readonly trust: WakeTrust;
  readonly trigger?: boolean;
  readonly mention?: boolean;
  readonly edited?: boolean;
  readonly previousBody?: string;
  readonly ownerToken?: string;
  readonly type?: "channel" | "thread";
  readonly threadRoot?: string;
  readonly sessionId?: string;
  readonly attachments?: readonly WakeAttachment[];
  readonly body: string;
}

export interface WakeHandoff {
  readonly note: string;
  readonly fromGeneration: number;
}

export interface WakeParticipant {
  readonly id: string;
  readonly name?: string;
  readonly handle?: string;
}

export interface WakeEnvelopeInput {
  readonly reason: WakeReason;
  readonly currentTime: string;
  readonly channel: WakeChannelMeta;
  readonly participants?: readonly WakeParticipant[];
  readonly thread?: WakeThreadMeta;
  readonly handoff?: WakeHandoff;
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
    attr("handle", m.handle) +
    attr("id", m.id) +
    attr("sent-at", m.sentAt) +
    attr("type", m.type) +
    attr("thread", m.threadRoot) +
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

function renderSession(group: readonly WakeMessageInput[]): string {
  const start = group[0]?.sentAt;
  const end = group[group.length - 1]?.sentAt;
  const inner = group.map((m) => renderMessage(m)).join("\n");
  return `<session${attr("start", start)}${attr("end", end)}${attr("messages", String(group.length))}>\n${indent(inner, 2)}\n</session>`;
}

function renderMessages(messages: readonly WakeMessageInput[]): string {
  const blocks: string[] = [];
  let i = 0;
  while (i < messages.length) {
    const sid = messages[i].sessionId;
    if (sid === undefined) {
      blocks.push(renderMessage(messages[i]));
      i += 1;
      continue;
    }
    const group: WakeMessageInput[] = [];
    while (i < messages.length && messages[i].sessionId === sid) {
      group.push(messages[i]);
      i += 1;
    }
    blocks.push(renderSession(group));
  }
  return blocks.join("\n");
}

function renderParticipants(ps: readonly WakeParticipant[]): string {
  const rows = ps.map((p) => `<participant${attr("id", p.id)}${attr("name", p.name)}${attr("handle", p.handle)}/>`).join("\n");
  return `<participants>\n${indent(rows, 2)}\n</participants>`;
}

function renderChannelOpen(c: WakeChannelMeta): string {
  const memberCount = c.memberCount === undefined ? undefined : String(c.memberCount);
  return `<channel${attr("id", c.id)}${attr("type", c.type)}${attr("member-count", memberCount)}>`;
}

function renderThreadOpen(t: WakeThreadMeta): string {
  return `<thread${attr("ts", t.ts)}${attr("session-owner", t.sessionOwner)}>`;
}

function renderHandoff(h: WakeHandoff): string {
  const body = ingestUntrusted(escapeXml(h.note), { source: "rotation-handoff" });
  return `<handoff-note${attr("from-generation", String(h.fromGeneration))}>\n${indent(body, 2)}\n</handoff-note>`;
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

  const messagesXml = renderMessages(input.messages);
  const channelOpen = renderChannelOpen(input.channel);

  const participantsXml =
    input.participants && input.participants.length > 0 ? indent(renderParticipants(input.participants), 2) + "\n" : "";
  const handoffXml = input.handoff ? indent(renderHandoff(input.handoff), 2) + "\n" : "";
  const channelBody = input.thread
    ? `${participantsXml}${handoffXml}${indent(renderThreadOpen(input.thread), 2)}\n${indent(messagesXml, 4)}\n${indent("</thread>", 2)}`
    : `${participantsXml}${handoffXml}${indent(messagesXml, 2)}`;

  const lines = [
    `<wake${attr("reason", input.reason)}${attr("current-time", input.currentTime)}>`,
    indent(channelOpen, 2),
    channelBody,
    indent("</channel>", 2),
    `</wake>`,
  ];
  return lines.join("\n");
}

// Adapted from eve 1.0.0-rc.18 (Copyright 2026 Vercel, Inc. and contributors, Apache-2.0),
// `src/public/channels/teams/inbound` and the answer detector in `.../teams/hitl`. The Open
// Everywhere authors changed it: eve 1.0 keeps these helpers internal, so the Teams front owns
// its copy. Keep the parse identical to eve's: the front reads an activity BEFORE eve's own Teams
// channel reads the same body, and both must agree on its type, scope, text and answer status.
import type {
  TeamsActivity,
  TeamsAttachment,
  TeamsChannelAccount,
  TeamsConversationAccount,
  TeamsConversationScope,
  TeamsConversationUpdateActivity,
  TeamsInvokeActivity,
  TeamsMention,
  TeamsMessageActivity,
} from "eve/channels/teams";
import { convertHtmlToMarkdown } from "./teams-html-markdown.js";

type JsonRecord = Record<string, unknown>;

/** The hidden data key that eve's question and approval cards carry on every submit action. */
export const TEAMS_HITL_DATA_KEY = "eve_input";

const HTML_ENTITY_MAP: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&gt;": ">",
  "&lt;": "<",
  "&nbsp;": " ",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
};
const HTML_ENTITY_PATTERN = new RegExp(Object.keys(HTML_ENTITY_MAP).join("|"), "gi");

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Parses one JSON-decoded Teams activity. Returns null for an unsupported type or a malformed base. */
export function parseTeamsActivity(value: unknown): TeamsActivity | null {
  if (!isRecord(value)) return null;
  if (value.type === "message") return parseMessageActivity(value);
  if (value.type === "invoke") return parseInvokeActivity(value);
  if (value.type === "conversationUpdate") return parseConversationUpdateActivity(value);
  return null;
}

/** The activity id that anchors a Teams thread: none in a personal chat, else the reply root or the activity itself. */
export function teamsThreadRootActivityId(activity: TeamsMessageActivity | TeamsInvokeActivity): string | null {
  return activity.scope === "personal" ? null : (activity.replyToId ?? activity.id);
}

/**
 * True when the activity answers one of eve's question or approval cards: its submit data carries
 * `eve_input` with a non-empty `requestId`. eve's own Teams channel routes such an activity to its
 * answer path, not to a new turn.
 */
export function isTeamsAnswerActivity(activity: TeamsActivity): boolean {
  const value = readActivityValue(activity);
  if (!value) return false;
  const payload = readHitlPayload(value);
  return payload !== null && typeof payload.requestId === "string" && payload.requestId.length > 0;
}

function readActivityValue(activity: TeamsActivity): JsonRecord | null {
  if (activity.type === "message") return activity.value ?? null;
  if (activity.type === "invoke") {
    const value = activity.value;
    if (!value) return null;
    const action = isRecord(value.action) ? value.action : null;
    return (action && isRecord(action.data) ? action.data : null) ?? value;
  }
  return null;
}

function readHitlPayload(value: JsonRecord): JsonRecord | null {
  const direct = value[TEAMS_HITL_DATA_KEY];
  if (isRecord(direct)) return direct;
  const action = isRecord(value.action) ? value.action : null;
  const nested = (action && isRecord(action.data) ? action.data : null)?.[TEAMS_HITL_DATA_KEY];
  return isRecord(nested) ? nested : null;
}

type TeamsActivityBaseFields = Omit<TeamsConversationUpdateActivity, "type">;

function parseMessageActivity(raw: JsonRecord): TeamsMessageActivity | null {
  const base = parseActivityBase(raw);
  if (!base) return null;
  const mentions = parseMentions(raw.entities);
  const text = normalizeTeamsText(stripBotMention(typeof raw.text === "string" ? raw.text : "", mentions, base.recipient.id));
  return {
    ...base,
    attachments: parseAttachments(raw.attachments),
    isBotMentioned: mentions.some((m) => m.mentioned.id === base.recipient.id),
    mentions,
    replyToId: isNonEmptyString(raw.replyToId) ? raw.replyToId : undefined,
    scope: inferScope(base.conversation),
    text,
    textFormat: isNonEmptyString(raw.textFormat) ? raw.textFormat : undefined,
    type: "message",
    value: isRecord(raw.value) ? raw.value : undefined,
  };
}

function parseInvokeActivity(raw: JsonRecord): TeamsInvokeActivity | null {
  const base = parseActivityBase(raw);
  if (!base || !isNonEmptyString(raw.name)) return null;
  return {
    ...base,
    name: raw.name,
    replyToId: isNonEmptyString(raw.replyToId) ? raw.replyToId : undefined,
    scope: inferScope(base.conversation),
    type: "invoke",
    value: isRecord(raw.value) ? raw.value : undefined,
  };
}

function parseConversationUpdateActivity(raw: JsonRecord): TeamsConversationUpdateActivity | null {
  const base = parseActivityBase(raw);
  return base ? { ...base, type: "conversationUpdate" } : null;
}

function parseActivityBase(raw: JsonRecord): TeamsActivityBaseFields | null {
  if (!isNonEmptyString(raw.serviceUrl)) return null;
  const conversation = parseConversation(raw.conversation);
  const from = parseChannelAccount(raw.from);
  const recipient = parseChannelAccount(raw.recipient);
  if (!conversation || !from || !recipient) return null;
  const channelData = isRecord(raw.channelData) ? raw.channelData : {};
  return {
    channelData,
    conversation,
    conversationType: conversation.conversationType,
    from,
    id: isNonEmptyString(raw.id) ? raw.id : "",
    raw,
    recipient,
    serviceUrl: raw.serviceUrl,
    tenantId: readNestedString(channelData, ["tenant", "id"]) ?? conversation.tenantId,
    teamId: readNestedString(channelData, ["team", "id"]),
    teamsChannelId: readNestedString(channelData, ["channel", "id"]),
  };
}

function parseConversation(value: unknown): TeamsConversationAccount | null {
  if (!isRecord(value) || !isNonEmptyString(value.id)) return null;
  return {
    conversationType: isNonEmptyString(value.conversationType) ? value.conversationType : undefined,
    id: value.id,
    isGroup: typeof value.isGroup === "boolean" ? value.isGroup : undefined,
    name: isNonEmptyString(value.name) ? value.name : undefined,
    tenantId: isNonEmptyString(value.tenantId) ? value.tenantId : undefined,
  };
}

function parseChannelAccount(value: unknown): TeamsChannelAccount | null {
  if (!isRecord(value) || !isNonEmptyString(value.id)) return null;
  return {
    aadObjectId: isNonEmptyString(value.aadObjectId) ? value.aadObjectId : undefined,
    id: value.id,
    name: isNonEmptyString(value.name) ? value.name : undefined,
    role: isNonEmptyString(value.role) ? value.role : undefined,
  };
}

function parseMentions(value: unknown): TeamsMention[] {
  if (!Array.isArray(value)) return [];
  const out: TeamsMention[] = [];
  for (const entity of value) {
    if (!isRecord(entity) || entity.type !== "mention" || !isNonEmptyString(entity.text)) continue;
    const mentioned = parseChannelAccount(entity.mentioned);
    if (mentioned) out.push({ mentioned, text: entity.text, type: "mention" });
  }
  return out;
}

function parseAttachments(value: unknown): TeamsAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: TeamsAttachment[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isNonEmptyString(item.contentType)) continue;
    out.push({
      content: isRecord(item.content) ? (structuredClone(item.content) as TeamsAttachment["content"]) : undefined,
      contentType: item.contentType,
      contentUrl: isNonEmptyString(item.contentUrl) ? item.contentUrl : undefined,
      name: isNonEmptyString(item.name) ? item.name : undefined,
    });
  }
  return out;
}

function inferScope(conversation: TeamsConversationAccount): TeamsConversationScope {
  const type = conversation.conversationType;
  if (type === "personal" || type === "groupChat" || type === "channel") return type;
  if (conversation.isGroup === true) return "groupChat";
  if (conversation.isGroup === false) return "personal";
  return "unknown";
}

function stripBotMention(text: string, mentions: readonly TeamsMention[], botId: string): string {
  let out = text;
  for (const mention of mentions) if (mention.mentioned.id === botId) out = out.replace(mention.text, "");
  return out.trim();
}

function normalizeTeamsText(text: string): string {
  const trimmed = text.trim();
  return /<\/?[a-z][\s\S]*>/i.test(trimmed) ? convertHtmlToMarkdown(trimmed.replace(/<at>(.*?)<\/at>/gi, "@$1")) : decodeHtmlEntities(trimmed);
}

function decodeHtmlEntities(text: string): string {
  return text.replace(HTML_ENTITY_PATTERN, (entity) => HTML_ENTITY_MAP[entity.toLowerCase()] ?? entity);
}

function readNestedString(value: JsonRecord, path: readonly string[]): string | undefined {
  let cursor: unknown = value;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return isNonEmptyString(cursor) ? cursor : undefined;
}

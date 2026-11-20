import type {
  LinearAgentActivityRef,
  LinearAgentSessionEvent,
  LinearAgentSessionRef,
  LinearDelivery,
  LinearInboundEvent,
  LinearIssueRef,
  LinearUser,
} from "eve/channels/linear";

export function parseLinearWebhookEvent(input: { readonly body: string; readonly headers: Headers }): LinearInboundEvent | null {
  const raw: unknown = JSON.parse(input.body);
  if (!isObject(raw)) throw new TypeError("Expected a JSON object.");
  const delivery: LinearDelivery = {
    event: input.headers.get("linear-event") ?? undefined,
    id: input.headers.get("linear-delivery") ?? undefined,
  };
  const type = nonEmpty(raw.type);
  if (type === undefined) return null;
  const json = raw as LinearAgentSessionEvent["raw"];
  if (type === "AgentSessionEvent") {
    const agentSession = readAgentSession(raw.agentSession);
    if (agentSession === null) return null;
    return {
      action: nonEmpty(raw.action) ?? "created",
      agentActivity: readAgentActivity(raw.agentActivity),
      agentSession,
      appUserId: nonEmpty(raw.appUserId),
      createdAt: nonEmpty(raw.createdAt),
      delivery,
      guidance: nonEmpty(raw.guidance),
      kind: "agent_session",
      oauthClientId: nonEmpty(raw.oauthClientId),
      organizationId: nonEmpty(raw.organizationId),
      previousComments: readPreviousComments(raw.previousComments),
      promptContext: nonEmpty(raw.promptContext),
      raw: json,
    };
  }
  return { action: nonEmpty(raw.action), delivery, kind: "data", organizationId: nonEmpty(raw.organizationId), raw: json, type };
}

type Obj = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function readUser(value: unknown): LinearUser | undefined {
  if (!isObject(value) || typeof value.id !== "string") return undefined;
  const user: { -readonly [K in keyof LinearUser]: LinearUser[K] } = { id: value.id };
  if (typeof value.displayName === "string") user.displayName = value.displayName;
  if (typeof value.name === "string") user.name = value.name;
  if (typeof value.email === "string") user.email = value.email;
  if (typeof value.url === "string") user.url = value.url;
  return user;
}

function readIssue(value: unknown): LinearIssueRef | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || typeof value.id !== "string") return undefined;
  const issue: { -readonly [K in keyof LinearIssueRef]: LinearIssueRef[K] } = { id: value.id };
  if (typeof value.identifier === "string") issue.identifier = value.identifier;
  if (typeof value.title === "string") issue.title = value.title;
  if (typeof value.url === "string") issue.url = value.url;
  return issue;
}

function readAgentSession(value: unknown): LinearAgentSessionRef | null {
  if (!isObject(value) || typeof value.id !== "string") return null;
  const s: { -readonly [K in keyof LinearAgentSessionRef]: LinearAgentSessionRef[K] } = { id: value.id };
  if (typeof value.appUserId === "string") s.appUserId = value.appUserId;
  if (stringOrNull(value.commentId)) s.commentId = value.commentId;
  s.creator = readUser(value.creator);
  if (stringOrNull(value.creatorId)) s.creatorId = value.creatorId;
  const issue = readIssue(value.issue);
  if (issue !== undefined) s.issue = issue;
  if (stringOrNull(value.issueId)) s.issueId = value.issueId;
  if (typeof value.organizationId === "string") s.organizationId = value.organizationId;
  if (stringOrNull(value.sourceCommentId)) s.sourceCommentId = value.sourceCommentId;
  if (typeof value.status === "string") s.status = value.status;
  if (stringOrNull(value.summary)) s.summary = value.summary;
  if (stringOrNull(value.url)) s.url = value.url;
  return s;
}

function readAgentActivity(value: unknown): LinearAgentActivityRef | undefined {
  if (!isObject(value) || typeof value.id !== "string") return undefined;
  const content = (isObject(value.content) ? value.content : {}) as LinearAgentActivityRef["content"];
  const a: { -readonly [K in keyof LinearAgentActivityRef]: LinearAgentActivityRef[K] } = {
    body: isObject(value.content) ? nonEmpty(value.content.body) : undefined,
    content,
    id: value.id,
  };
  if (stringOrNull(value.signal)) a.signal = value.signal;
  if (isObject(value.signalMetadata)) a.signalMetadata = value.signalMetadata as LinearAgentActivityRef["content"];
  if (value.signalMetadata === null) a.signalMetadata = null;
  if (stringOrNull(value.sourceCommentId)) a.sourceCommentId = value.sourceCommentId;
  a.user = readUser(value.user);
  if (stringOrNull(value.userId)) a.userId = value.userId;
  return a;
}

function readPreviousComments(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((c: unknown) => (typeof c === "string" ? [c] : isObject(c) && typeof c.body === "string" ? [c.body] : []));
}

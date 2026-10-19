import {
  cancelAnchoredTurn,
  resolvePartition,
  STATUS_REACTION,
  swallowRoomOp,
  turnAnchorKey,
  turnChannelKey,
  type AttachSessionForCancel,
  type CancelResult,
  type SurfaceSessionPinner,
  type SurfaceSessionSetter,
} from "@open-everywhere/core/agent/adapter-api.js";
import { bindableForSlackIds, slackForm, type SlackEventEnvelope } from "./slack-events.js";

export const AGENT_SESSION_STOPPED_EVENT = "agent_session_stopped";

export const SLACK_SESSION_TITLE_MAX = 60;

export type SlackSessionStatus = "processing" | "active" | "suspended";

const AGENT_SESSION_TS_ATTRIBUTE = "agent_session_ts";

const SESSION_PIN_ATTRIBUTE = "oe_session_pin";

export type SlackFormCall = (method: string, body: string) => Promise<Record<string, unknown> | undefined>;

function decodeSlackEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function slackSessionTitle(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const rendered = text
    .replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, " ")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<#[A-Z0-9]+>/g, " ")
    .replace(/<![^>]*>/g, " ")
    .replace(/<[^>|]+\|([^>]+)>/g, "$1")
    .replace(/<([^>]+)>/g, "$1");
  const line = decodeSlackEntities(rendered)
    .split(/\r?\n/)
    .map((l) => l.replace(/[*~`]+/g, "").replace(/\s+/g, " ").trim())
    .find((l) => l.length > 0);
  if (line === undefined) return undefined;
  if (line.length <= SLACK_SESSION_TITLE_MAX) return line;
  const head = line.slice(0, SLACK_SESSION_TITLE_MAX - 1);
  const cut = head.lastIndexOf(" ");
  return `${(cut >= SLACK_SESSION_TITLE_MAX / 2 ? head.slice(0, cut) : head).trimEnd()}…`;
}

export interface SlackSessionStatusCall {
  readonly channelId: string;
  readonly threadTs: string;
  readonly status: SlackSessionStatus;
  readonly title?: string;
}

export function slackSessionStatusForm(call: SlackSessionStatusCall): string {
  const body = new URLSearchParams({ channel_id: call.channelId, thread_ts: call.threadTs, status: call.status });
  if (call.title !== undefined && call.title.length > 0) body.set("title", call.title);
  return body.toString();
}

export async function setSlackSessionStatus(call: SlackSessionStatusCall, form: SlackFormCall = slackForm): Promise<boolean> {
  try {
    const res = await form("agents.sessions.setStatus", slackSessionStatusForm(call));
    if (res?.ok === true) return true;
    console.warn(`[open-everywhere:slack-session] agents.sessions.setStatus ${call.status} was not applied (${call.channelId}/${call.threadTs}): ${String(res?.error ?? "no answer")}`);
    return false;
  } catch (err) {
    console.warn(`[open-everywhere:slack-session] agents.sessions.setStatus ${call.status} failed (${call.channelId}/${call.threadTs}): ${String(err)}`);
    return false;
  }
}

export function slackAgentSessionOf(attributes: Readonly<Record<string, unknown>>): { readonly channelId: string; readonly threadTs: string } | undefined {
  if (attributes.channel_type !== "im") return undefined;
  const channelId = attributes.channel_id;
  const stamped = attributes[AGENT_SESSION_TS_ATTRIBUTE];
  if (typeof channelId !== "string" || channelId.length === 0 || typeof stamped !== "string" || stamped.length === 0) return undefined;
  return { channelId, threadTs: stamped };
}

export const slackSurfaceSessionPin: SurfaceSessionPinner = (attributes) => {
  const session = slackAgentSessionOf(attributes);
  if (!session) return undefined;
  return {
    id: `${session.channelId}:${session.threadTs}`,
    attributes: { channel_id: session.channelId, channel_type: "im", [AGENT_SESSION_TS_ATTRIBUTE]: session.threadTs, [SESSION_PIN_ATTRIBUTE]: "1" },
  };
};

export const SLACK_DM_WORKING_STATUS = "Working...";

const WORKING_REACTION = STATUS_REACTION.working;

const SIGN_SETUP_FIX: Readonly<Record<string, string>> = {
  "reactions.add": "the 👀 needs the reactions:write bot scope",
  "reactions.remove": "the 👀 needs the reactions:write bot scope",
  "assistant.threads.setStatus": "the DM status line needs the assistant:write bot scope and the agent view (features.agent_view)",
};
const SIGN_SETUP_ERRORS = new Set(["missing_scope", "feature_disabled", "not_allowed_token_type", "not_allowed", "access_denied"]);
const SIGN_NO_OP_ERRORS = new Set(["already_reacted", "no_reaction"]);
const warnedSignErrors = new Set<string>();

async function sendSign(form: SlackFormCall, method: string, body: URLSearchParams): Promise<void> {
  let error: string;
  try {
    const res = await form(method, body.toString());
    if (res?.ok === true) return;
    error = String(res?.error ?? "no answer");
  } catch (err) {
    error = String(err);
  }
  if (SIGN_NO_OP_ERRORS.has(error)) return;
  const key = `${method}:${error}`;
  if (warnedSignErrors.has(key)) return;
  warnedSignErrors.add(key);
  const fix = SIGN_SETUP_ERRORS.has(error)
    ? `${SIGN_SETUP_FIX[method] ?? "this sign needs a manifest scope"}. Fix: paste the app manifest again (App Manifest → Save Changes) and reinstall if Slack asks`
    : "the sign is best-effort and the turn goes on";
  console.warn(`[open-everywhere:slack-session] ${method} failed (${error}) — ${fix}. Logged once per process.`);
}

export function _resetSignWarningsForTest(): void {
  warnedSignErrors.clear();
}

async function setSlackDmWorkingSigns(session: { readonly channelId: string; readonly threadTs: string }, working: boolean, form: SlackFormCall = slackForm): Promise<void> {
  if (swallowRoomOp(`a slack DM working sign ${working ? "add" : "remove"}`)) return;
  const reaction = new URLSearchParams({ channel: session.channelId, name: WORKING_REACTION, timestamp: session.threadTs });
  const status = new URLSearchParams({ channel_id: session.channelId, thread_ts: session.threadTs, status: working ? SLACK_DM_WORKING_STATUS : "" });
  await Promise.all([sendSign(form, working ? "reactions.add" : "reactions.remove", reaction), sendSign(form, "assistant.threads.setStatus", status)]);
}

export function slackSurfaceSessionSetter(form: SlackFormCall = slackForm): SurfaceSessionSetter {
  return async (attributes, status) => {
    const session = slackAgentSessionOf(attributes);
    if (!session) return undefined;
    const fromTurn = attributes[SESSION_PIN_ATTRIBUTE] === undefined;
    await Promise.all([setSlackSessionStatus({ ...session, status }, form), ...(fromTurn ? [setSlackDmWorkingSigns(session, status === "processing", form)] : [])]);
    return `${session.channelId}:${session.threadTs}`;
  };
}

export interface ParsedSessionStop {
  readonly channelId: string;
  readonly threadTs: string;
  readonly userId: string;
  readonly teamId?: string;
  readonly eventTs?: string;
}

export function parseAgentSessionStopped(envelope: SlackEventEnvelope): ParsedSessionStop | null {
  if (envelope?.type !== "event_callback") return null;
  const e = envelope.event as Record<string, unknown> | undefined;
  if (!e || e.type !== AGENT_SESSION_STOPPED_EVENT) return null;
  const channelId = typeof e.channel === "string" ? e.channel : "";
  const threadTs = typeof e.thread_ts === "string" ? e.thread_ts : "";
  const userId = typeof e.user === "string" ? e.user : "";
  if (!channelId || !threadTs || !userId) return null;
  const teamId = typeof envelope.team_id === "string" && envelope.team_id.length > 0 ? envelope.team_id : undefined;
  return {
    channelId,
    threadTs,
    userId,
    ...(teamId ? { teamId } : {}),
    ...(typeof e.event_ts === "string" ? { eventTs: e.event_ts } : {}),
  };
}

function isDmChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

export interface SessionStopDeps {
  readonly attachSession: AttachSessionForCancel;
  readonly cancel?: typeof cancelAnchoredTurn;
  readonly setStatus?: (call: SlackSessionStatusCall) => Promise<boolean>;
}

export async function routeAgentSessionStop(ev: ParsedSessionStop, deps: SessionStopDeps): Promise<CancelResult> {
  const p = resolvePartition(bindableForSlackIds({ teamId: ev.teamId, channelId: ev.channelId, userId: ev.userId }));
  const anchorKey = turnAnchorKey("slack", ev.channelId, ev.threadTs);
  const channelKey = isDmChannel(ev.channelId) ? turnChannelKey("slack", ev.channelId) : undefined;
  let result: CancelResult;
  try {
    result = await (deps.cancel ?? cancelAnchoredTurn)({
      org: p.org,
      platform: "slack",
      workspace: p.workspace,
      requestedBy: ev.userId,
      via: "stop-button",
      query: { ...(anchorKey ? { anchorKey } : {}), ...(channelKey ? { channelKey } : {}) },
      attachSession: deps.attachSession,
    });
  } catch (err) {
    result = { outcome: "error", message: `stop failed: ${String(err)}` };
  }
  await (deps.setStatus ?? setSlackSessionStatus)({ channelId: ev.channelId, threadTs: ev.threadTs, status: "active" }).catch(() => false);
  return result;
}

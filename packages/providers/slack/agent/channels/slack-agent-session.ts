import {
  cancelAnchoredTurn,
  resolvePartition,
  turnAnchorKey,
  turnChannelKey,
  type AttachSessionForCancel,
  type CancelResult,
  type SurfaceSessionAnswerer,
  type SurfaceSessionSetter,
  type SurfaceSessionStatus,
  type SurfaceTurnEnd,
} from "@open-everywhere/core/agent/adapter-api.js";
import { bindableForSlackIds, slackForm, type SlackEventEnvelope } from "./slack-events.js";
import { setSlackStatusReaction, type SlackSignRequest } from "./slack-working-signs.js";

export const AGENT_SESSION_STOPPED_EVENT = "agent_session_stopped";

export type SlackFormCall = (method: string, body: string) => Promise<Record<string, unknown> | undefined>;

const WORKING_SIGNS_TS_ATTRIBUTE = "working_signs_ts";

const SIGN_SETUP_FIX: Readonly<Record<string, string>> = {
  "reactions.add": "the 👀 and the 🛑 need the reactions:write bot scope",
  "reactions.remove": "the 👀 and the 🛑 need the reactions:write bot scope",
};
const SIGN_SETUP_ERRORS = new Set(["missing_scope", "feature_disabled", "not_allowed_token_type", "not_allowed", "access_denied"]);
const SIGN_NO_OP_ERRORS = new Set(["already_reacted", "no_reaction"]);
const warnedSignErrors = new Set<string>();

function formSignRequest(form: SlackFormCall): SlackSignRequest {
  return async (method, params) => {
    let error: string;
    try {
      const res = await form(method, new URLSearchParams({ ...params }).toString());
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
  };
}

export function _resetSignWarningsForTest(): void {
  warnedSignErrors.clear();
}

export function slackWorkingSignsOf(attributes: Readonly<Record<string, unknown>>): { readonly channelId: string; readonly threadTs: string; readonly teamId?: string } | undefined {
  if (attributes.channel_type !== "im" && attributes.channel_type !== "mpim") return undefined;
  const channelId = attributes.channel_id;
  const stamped = attributes[WORKING_SIGNS_TS_ATTRIBUTE];
  if (typeof channelId !== "string" || channelId.length === 0 || typeof stamped !== "string" || stamped.length === 0) return undefined;
  return { channelId, threadTs: stamped, ...(typeof attributes.team_id === "string" ? { teamId: attributes.team_id } : {}) };
}

async function setSlackDmWorkingSign(root: { readonly channelId: string; readonly threadTs: string }, status: SurfaceSessionStatus, end: SurfaceTurnEnd | undefined, request: SlackSignRequest): Promise<void> {
  const working = status === "processing";
  await setSlackStatusReaction(request, { channel: root.channelId, timestamp: root.threadTs }, working ? "working" : end?.failed === true ? "blocked" : "none");
}

export function slackSurfaceSessionSetter(form: SlackFormCall = slackForm): SurfaceSessionSetter {
  const request = formSignRequest(form);
  return async (attributes, status, end) => {
    const signs = slackWorkingSignsOf(attributes);
    if (!signs) return undefined;
    await setSlackDmWorkingSign(signs, status, end, request);
    return `${signs.channelId}:${signs.threadTs}`;
  };
}

export function slackSurfaceSessionAnswerer(form: SlackFormCall = slackForm): SurfaceSessionAnswerer {
  const request = formSignRequest(form);
  return async (attributes) => {
    const signs = slackWorkingSignsOf(attributes);
    if (!signs) return undefined;
    await setSlackStatusReaction(request, { channel: signs.channelId, timestamp: signs.threadTs }, "none");
    return `${signs.channelId}:${signs.threadTs}`;
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
  return result;
}

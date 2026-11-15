import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { beginTaintTurn, markUntrustedIngestedThisTurn, registerTaintFlipObserver, untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { beginTaintVerdictTurn, registerTaintVerdictSink, taintEnabled, taintMode, type TaintVerdictRow } from "../access/taint-enforcement.js";
import { OE_CHAT_NONMEMBER_ATTR } from "../identity/non-member.js";
import { appendAudit } from "../audit/audit.js";
import { currentTurnId, deploymentOrg, isSubagentChildContext, turnOriginPlatform, type BindableContext } from "../identity/binding.js";
import { READ_ADAPTERS } from "../channels/channel-read.js";
import { turnLocusCarriesMeetingPost } from "../meetings/provenance.js";
import { delegatingParentLink } from "../channels/delegated-provenance.js";

const turnIdentity = defineState<{ org: string; sessionId: string; turnId: string; parentSessionId?: string } | null>(
  "open-everywhere.taint-turn.identity",
  () => null,
);

function rememberTurnIdentity(ctx: HookContext): void {
  try {
    const c = ctx as unknown as BindableContext;
    const sessionId = (c as { session?: { id?: string } }).session?.id;
    const turnId = currentTurnId(c);
    const parent = isSubagentChildContext(c) ? delegatingParentLink(ctx)?.sessionId : undefined;
    turnIdentity.update(() =>
      typeof sessionId === "string" && sessionId.length > 0 && typeof turnId === "string" && turnId.length > 0
        ? { org: deploymentOrg(), sessionId, turnId, ...(parent !== undefined ? { parentSessionId: parent } : {}) }
        : null,
    );
  } catch {
  }
}

const TAINT_VERDICT_ACTION = "taint.verdict";

export function taintVerdictIdentityDetail(
  turn: { readonly sessionId?: string; readonly turnId?: string } | null | undefined,
  subagent: { readonly parent: { readonly sessionId?: string } | null } | null | undefined,
): { sessionId?: string; turnId?: string; parentSessionId?: string } {
  const out: { sessionId?: string; turnId?: string; parentSessionId?: string } = {};
  if (turn?.sessionId) out.sessionId = turn.sessionId;
  if (turn?.turnId) out.turnId = turn.turnId;
  const parent = subagent?.parent?.sessionId;
  if (parent && parent !== turn?.sessionId) out.parentSessionId = parent;
  return out;
}

function liveTaintVerdictIdentity(): { sessionId?: string; turnId?: string; parentSessionId?: string } {
  try {
    const turn = turnIdentity.get();
    return taintVerdictIdentityDetail(turn, { parent: turn?.parentSessionId !== undefined ? { sessionId: turn.parentSessionId } : null });
  } catch {
    return {};
  }
}

registerTaintVerdictSink((row: TaintVerdictRow) => {
  void appendAudit({
    org: deploymentOrg(),
    platform: "ingest",
    workspace: row.kind,
    action: TAINT_VERDICT_ACTION,
    detail: { ...row, ...liveTaintVerdictIdentity() },
  }).catch(() => undefined);
});

const TAINT_FORWARD_ACTION = "taint.forward";

const turnMarkRecorded = defineState<string | null>("open-everywhere.taint-turn.mark-recorded", () => null);

function recordTurnMark(): boolean {
  try {
    if (!untrustedIngestedThisTurn()) return false;
    const who = turnIdentity.get();
    if (who === null) return false;
    let first = false;
    turnMarkRecorded.update((cur) => {
      if (cur === who.turnId) return cur;
      first = true;
      return who.turnId;
    });
    if (!first) return false;
    void appendAudit({
      org: who.org,
      platform: "ingest",
      workspace: "taint",
      action: TAINT_FORWARD_ACTION,
      detail: { leg: "mark", session: who.sessionId, turn: who.turnId },
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

registerTaintFlipObserver(() => {
  recordTurnMark();
});

function stampedTrue(v: unknown): boolean {
  const first = Array.isArray(v) ? v[0] : v;
  return first === "true" || first === true;
}

function seedIfNonMemberWake(ctx: HookContext): void {
  try {
    const attrs = (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } | null } } }).session?.auth?.current?.attributes;
    if (stampedTrue(attrs?.[OE_CHAT_NONMEMBER_ATTR])) markUntrustedIngestedThisTurn("chat-message");
  } catch {
  }
}

export function openTaintTurn(ctx: HookContext): void {
  rememberTurnIdentity(ctx);
  let turnId: string | undefined;
  try {
    turnId = currentTurnId(ctx as unknown as BindableContext);
  } catch {
    turnId = undefined;
  }
  beginTaintTurn(turnId);
  beginTaintVerdictTurn(turnId);
  seedIfNonMemberWake(ctx);
  announceTaintOff(ctx);
}

const TAINT_MODE_ACTION = "taint.mode";

const taintModeAnnounced = defineState<boolean>("open-everywhere.taint-mode-announced", () => false);

export function announceTaintOff(ctx: HookContext): boolean {
  try {
    if (taintEnabled()) return false;
    let first = false;
    taintModeAnnounced.update((cur) => {
      if (cur === true) return true;
      first = true;
      return true;
    });
    if (!first) return false;
    const sessionId = (ctx as { session?: { id?: string } }).session?.id;
    void appendAudit({
      org: deploymentOrg(),
      platform: "ingest",
      workspace: "taint",
      action: TAINT_MODE_ACTION,
      detail: {
        mode: taintMode(),
        ...(typeof sessionId === "string" && sessionId.length > 0 ? { session: sessionId } : {}),
        marking: "disabled",
        fencing: "unchanged",
      },
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

const LOCUS_CHECKED_MAX = 512;
const locusCheckedTurns = new Set<string>();

export async function markIfTurnLocusCarriesMeetingPost(bind: BindableContext, sessionId: string | undefined, turnId: string | undefined): Promise<void> {
  if (untrustedIngestedThisTurn()) return;
  const turnKey = sessionId !== undefined && sessionId.length > 0 && turnId !== undefined && turnId.length > 0 ? `${sessionId}:${turnId}` : undefined;
  if (turnKey !== undefined && locusCheckedTurns.has(turnKey)) return;
  let locus: { platform: string; container: string; threadRoot?: string } | undefined;
  try {
    const platform = turnOriginPlatform(bind);
    const address = platform === undefined ? undefined : READ_ADAPTERS[platform]?.wakeAddress(bind);
    if (platform !== undefined && address !== undefined) locus = { platform, ...address };
  } catch {
    locus = undefined;
  }
  if (locus === undefined) return;
  if (await turnLocusCarriesMeetingPost(deploymentOrg(), locus, Date.now(), turnKey)) {
    markUntrustedIngestedThisTurn("chat-message");
    return;
  }
  if (turnKey === undefined) return;
  locusCheckedTurns.add(turnKey);
  if (locusCheckedTurns.size > LOCUS_CHECKED_MAX) locusCheckedTurns.delete(locusCheckedTurns.values().next().value as string);
}

export default defineHook({
  events: {
    "turn.started": (_event, ctx) => {
      openTaintTurn(ctx);
    },
    "actions.requested": async (_event, ctx) => {
      try {
        const bind = ctx as unknown as BindableContext;
        if (isSubagentChildContext(bind)) return;
        const sessionId = (ctx as { session?: { id?: string } }).session?.id;
        if (typeof sessionId !== "string" || sessionId.length === 0) return;
        await markIfTurnLocusCarriesMeetingPost(bind, sessionId, currentTurnId(bind));
      } catch {
      }
    },
  },
});

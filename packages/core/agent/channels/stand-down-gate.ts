import { bindFrom, currentSessionId, currentTurnId, type BindableContext } from "../identity/binding.js";
import { resolvePartition, type Partition } from "../memory/partition.js";
import { isThreadStopped, readStandDownAck, roomEngagementAddress, spendStandDownAck, STAND_DOWN_ACK_TTL_MS } from "./engagement.js";
import { getOperationalStore } from "../operational/provider.js";
import { durableTurnKey, noteStoppedAck, stoppedAckSpent } from "../model/turn-state.js";
import { noteTurnCloseoutRefusal } from "../model/turn-closeout.js";
import {
  REPLY_STOPPED_REFUSAL_REASON,
  markStoppedAckThisTurn,
  wasStoppedAckSpentThisTurn,
  wasStoodDownThisTurn,
} from "./reply-signal.js";
import { markStandDownSilenceThisTurn, REPLY_STAND_DOWN_ACK_ACTION } from "./stand-down-silence.js";
import { END_TURN_WITH_SENTINEL_INSTRUCTION } from "./normalized-wake.js";
import { auditToolAction } from "../audit/tool-action.js";

export interface StandDownState {
  readonly stopped: boolean;
  readonly refuse: boolean;
  readonly spentHere: boolean;
  readonly holdsAck: boolean;
}

const STAND_DOWN_CLEAR: StandDownState = { stopped: false, refuse: false, spentHere: false, holdsAck: false };

export const STAND_DOWN_VERB_REFUSED_ACTION = "stand_down.verb_refused";

export function stoppedRefusalText(spentHere: boolean): string {
  const why = spentHere
    ? "You have already posted here once this turn; anything further is exactly what the person asked you to stop doing. "
    : "The one acknowledgement belongs to the turn that stood down, so nothing else posts here — not this turn, not a worker, not a later session. ";
  return (
    "You were asked to stand down in this conversation and that stop is recorded, so nothing was posted. " +
    why +
    `${END_TURN_WITH_SENTINEL_INSTRUCTION} Someone @mentioning you is what brings you back.`
  );
}

function ackOnlyRefusalText(verb: string): string {
  return (
    `You were asked to stand down in this conversation and that stop is recorded, so this \`${verb}\` did nothing. ` +
    `A \`${verb}\` is never the stand-down acknowledgement. The one acknowledgement is a short \`reply\`, and it is still yours to post. ` +
    "Post it with `reply`, and do nothing else here."
  );
}

const STAND_DOWN_VERDICT_PREFIX = "stand-down-verdict:";

/**
 * The gate's verdict for ONE tool call. eve runs a tool body again when its step retries, and the
 * call keeps its `callId` across the retry (eve's `ToolContext.callId`). So the first evaluation
 * writes its verdict under `session id + turn id + callId`, and a retry of that call reads the
 * recorded verdict instead of the live store. The turn id is in the key because a model can reuse a
 * tool-call id in a later turn of the same session. A retry after a stop therefore never refuses a verb whose
 * first run was allowed, and a retry after a re-invitation never allows a verb whose first run
 * was refused. A new call has a new `callId`, so it reads the live state. A context with no
 * `callId`, no turn id or no session id records nothing and reads the live state.
 */
export async function standDownState(
  bind: BindableContext,
  turnId: string | undefined,
  namesBoundConversation?: () => Promise<boolean>,
): Promise<StandDownState> {
  const recorded = verdictAddress(bind, turnId);
  if (recorded === undefined) return liveStandDownState(bind, turnId, namesBoundConversation);
  const prior = await readVerdict(recorded);
  if (prior !== undefined) return prior;
  const live = await liveStandDownState(bind, turnId, namesBoundConversation);
  try {
    const won = await getOperationalStore().putTaskResultIfAbsent(
      recorded.org,
      recorded.rowKey,
      JSON.stringify(live),
      new Date().toISOString(),
      STAND_DOWN_ACK_TTL_MS,
    );
    if (!won) return (await readVerdict(recorded)) ?? live;
  } catch {
  }
  return live;
}

interface VerdictAddress {
  readonly org: string;
  readonly rowKey: string;
}

function verdictAddress(bind: BindableContext, turnId: string | undefined): VerdictAddress | undefined {
  try {
    if (turnId === undefined || turnId.length === 0) return undefined;
    const callId = (bind as { readonly callId?: unknown }).callId;
    if (typeof callId !== "string" || callId.length === 0) return undefined;
    const sessionId = currentSessionId(bind);
    if (sessionId === undefined) return undefined;
    return { org: resolvePartition(bind).org, rowKey: `${STAND_DOWN_VERDICT_PREFIX}${sessionId}\n${turnId}\n${callId}` };
  } catch {
    return undefined;
  }
}

async function readVerdict(address: VerdictAddress): Promise<StandDownState | undefined> {
  try {
    const raw = await getOperationalStore().getTaskResult(address.org, address.rowKey);
    if (raw === null) return undefined;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const flags = [v["stopped"], v["refuse"], v["spentHere"], v["holdsAck"]];
    if (!flags.every((f) => typeof f === "boolean")) return undefined;
    return { stopped: v["stopped"] as boolean, refuse: v["refuse"] as boolean, spentHere: v["spentHere"] as boolean, holdsAck: v["holdsAck"] as boolean };
  } catch {
    return undefined;
  }
}

async function liveStandDownState(
  bind: BindableContext,
  turnId: string | undefined,
  namesBoundConversation?: () => Promise<boolean>,
): Promise<StandDownState> {
  try {
    const binding = bindFrom(bind);
    const address = await stoppedAddress(bind, binding);
    if (address === undefined) return STAND_DOWN_CLEAR;
    const stopped = true;
    if (namesBoundConversation !== undefined && !(await namesBoundConversation())) return STAND_DOWN_CLEAR;
    if (wasStoppedAckSpentThisTurn(turnId)) return { stopped, refuse: true, spentHere: true, holdsAck: false };
    const rowKey = standDownRowKey(bind, turnId);
    const turnSpent = rowKey !== undefined && (await stoppedAckSpent(rowKey));
    const ack = await readStandDownAck(address.partition, address.anchor);
    const stoodDownHere = wasStoodDownThisTurn(turnId);
    if (ack.kind === "unreadable") return { stopped, refuse: turnSpent, spentHere: turnSpent, holdsAck: !turnSpent && stoodDownHere };
    if (ack.kind === "absent") {
      const refuse = turnSpent || !stoodDownHere;
      return { stopped, refuse, spentHere: turnSpent, holdsAck: !refuse };
    }
    const holds = (ack.holder !== null && ack.holder === rowKey) || (ack.holder === null && stoodDownHere);
    if (!holds) return { stopped, refuse: true, spentHere: false, holdsAck: false };
    const spentHere = ack.spent || turnSpent;
    return { stopped, refuse: spentHere, spentHere, holdsAck: !spentHere };
  } catch {
    return STAND_DOWN_CLEAR;
  }
}

interface StoppedAddress {
  readonly partition: Partition;
  readonly anchor: string;
}

async function stoppedAddress(bind: BindableContext, binding: ReturnType<typeof bindFrom>): Promise<StoppedAddress | undefined> {
  const partition = resolvePartition(bind);
  const anchor = binding.engagementKey ?? binding.threadTs;
  if (anchor !== undefined && anchor.length > 0 && (await isThreadStopped(partition, anchor))) return { partition, anchor };
  if (binding.roomEngagementKey === undefined) return undefined;
  const room = roomEngagementAddress(partition);
  return (await isThreadStopped(room.partition, room.anchor)) ? room : undefined;
}

function standDownRowKey(bind: BindableContext, turnId: string | undefined): string | undefined {
  if (turnId === undefined || turnId.length === 0) return undefined;
  try {
    return durableTurnKey(currentSessionId(bind), turnId);
  } catch {
    return undefined;
  }
}

export async function spendStoppedAck(bind: BindableContext, turnId: string | undefined, arm: "unified" | "per-surface"): Promise<void> {
  markStoppedAckThisTurn(turnId);
  markStandDownSilenceThisTurn(turnId);
  const rowKey = standDownRowKey(bind, turnId);
  if (rowKey !== undefined) await noteStoppedAck(rowKey);
  let anchor: string | undefined;
  let sessionId: string | undefined;
  try {
    const binding = bindFrom(bind);
    anchor = binding.engagementKey ?? binding.threadTs;
    sessionId = currentSessionId(bind);
  } catch {
  }
  try {
    const address = await stoppedAddress(bind, bindFrom(bind));
    if (address !== undefined) await spendStandDownAck(address.partition, address.anchor, rowKey);
  } catch {
  }
  await auditToolAction(bind, REPLY_STAND_DOWN_ACK_ACTION, {
    arm,
    ...(anchor !== undefined ? { anchor } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export const STAND_DOWN_ACK_STILL_OWED =
  " Your one stand-down acknowledgement is still yours: post it with `reply`, and nothing else.";

async function boundStandDownState(bind: BindableContext): Promise<StandDownState> {
  let turnId: string | undefined;
  try {
    turnId = currentTurnId(bind);
  } catch {
    turnId = undefined;
  }
  return standDownState(bind, turnId);
}

export async function withholdIfStoodDown(bind: BindableContext, verb: string): Promise<StandDownState> {
  const state = await boundStandDownState(bind);
  if (state.stopped) {
    await auditToolAction(bind, STAND_DOWN_VERB_REFUSED_ACTION, { verb, reason: REPLY_STOPPED_REFUSAL_REASON, withheld: true }).catch(() => undefined);
  }
  return state;
}

export interface VerbGateOptions {
  readonly namesBoundConversation?: () => Promise<boolean>;
  readonly auditRefused?: (reason: string) => Promise<void>;
}

export async function refuseVerbIfStoodDown(bind: BindableContext, verb: string, opts: VerbGateOptions = {}): Promise<void> {
  let turnId: string | undefined;
  try {
    turnId = currentTurnId(bind);
  } catch {
    turnId = undefined;
  }
  const state = await standDownState(bind, turnId, opts.namesBoundConversation);
  if (!state.stopped) return;
  if (!state.holdsAck) await noteTurnCloseoutRefusal(bind, REPLY_STOPPED_REFUSAL_REASON);
  if (opts.auditRefused !== undefined) {
    await opts.auditRefused(REPLY_STOPPED_REFUSAL_REASON).catch(() => undefined);
  } else {
    await auditToolAction(bind, STAND_DOWN_VERB_REFUSED_ACTION, { verb, reason: REPLY_STOPPED_REFUSAL_REASON });
  }
  throw new Error(state.holdsAck ? ackOnlyRefusalText(verb) : stoppedRefusalText(state.spentHere));
}

export async function refuseTargetIfStopped(bind: BindableContext, verb: string, anchor: string): Promise<void> {
  let stopped = false;
  try {
    stopped = await isThreadStopped(resolvePartition(bind), anchor);
  } catch {
    stopped = false;
  }
  if (!stopped) return;
  await auditToolAction(bind, STAND_DOWN_VERB_REFUSED_ACTION, { verb, reason: REPLY_STOPPED_REFUSAL_REASON, target: "explicit" });
  throw new Error(
    `The thread you named was asked to stand down, so this \`${verb}\` did nothing there. ` +
      "Your own conversation is not affected: carry on here, and leave that thread alone.",
  );
}

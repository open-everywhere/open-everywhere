import { claimWorkCall, peekWorkCallJoin, releaseWorkCall, retireWorkRequest, workCallClaimed, workRequestNamesTask, workRequestStarted, WORK_REQUEST_ALREADY_STARTED_MESSAGE, WORK_REQUEST_UNJOINABLE_MESSAGE } from "./work-request-turn.js";
import { gateWorkCallStamp, liveWorkRequestStamp, workStampVerdict, WORK_CALL_NEEDS_REISSUE_MESSAGE } from "./work-step-stamp.js";
import { asSchema, jsonSchema } from "ai";
import { defineState } from "eve/context";
import { parseWakeAttachments, withDelegatedAttachments, type BriefAttachment } from "../channels/attachments.js";
import { isWakeEnvelopeShaped, wakeIdsFromEnvelope } from "../channels/wake-envelope.js";
import { auditTaskContinuation, checkTaskContinuation, commitTaskContinuation, TASK_CONTINUATION_REFUSAL_MESSAGE, taskContinuationRefusalMessage, type TaskContinuationRefusal, type TaskContinuationVerdict } from "../channels/task-provenance.js";
import { registeredContinuationRefusalNotifier, WORK_CONTINUATION_RETURNED_MESSAGE } from "./work-refusal-notice.js";
import { deploymentOrg } from "../identity/binding.js";
import { currentContinuationTurn, type ContinuationTurn } from "./continuation-turn-state.js";
import { settlementDispatchAuthorityThisTurn } from "./settlement-dispatch-signal.js";
import { taskWakeThisTurn, uningressedTurn } from "./task-wake-signal.js";
import { addressedWakeThisTurn, exactDispatchWakeThisTurn } from "./dispatch-origin-signal.js";
import { nativeAgentRefusal } from "./native-delegation-gate.js";
import { seatCutCallRefusal } from "./seat-cut.js";

const DELEGATION_TOOL_NAME = "agent";

const TASK_ID_FIELD = "taskId";

const STOP_ONLY_TASK_TOOLS: ReadonlySet<string> = new Set(["eve__task_cancel", "cancel_work"]);

const SELF_FENCED_TASK_TOOLS: ReadonlySet<string> = new Set(["work"]);

const CALLER_OUTPUT_SCHEMA_FIELD = "outputSchema";

export { TASK_CONTINUATION_REFUSAL_MESSAGE };

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

/** The attachments of one wake-shaped user message, keyed by the wake id its envelope names. */
interface WakeAttachmentEntry {
  readonly wakeId?: string;
  readonly attachments: readonly BriefAttachment[];
}

/** How many of the newest wakes a model call read the slot keeps. */
const MAX_NOTED_WAKES = 8;

interface NotedWakeAttachments {
  /** The attachments of the last user message, when it is a wake. */
  readonly last: readonly BriefAttachment[];
  /** Each wake-shaped user message's attachments, oldest first, by the wake id it names. */
  readonly wakes: readonly WakeAttachmentEntry[];
}

const wakeAttachmentSlot = defineState<NotedWakeAttachments>("open-everywhere.wake-attachments.v2", () => ({ last: [], wakes: [] }));

const DELEGATION_BRIEF_FIELD = "message";

function userText(like: MessageLike): string | undefined {
  if (typeof like.content === "string") return like.content;
  if (!Array.isArray(like.content)) return undefined;
  const text = like.content
    .map((part) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .join("\n");
  return text.length > 0 ? text : undefined;
}

/** Every user message's text, oldest first. A user message with no text gives `undefined`. */
function userTexts(messages: readonly unknown[]): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  for (const m of messages) {
    if (m === null || typeof m !== "object") continue;
    const like = m as MessageLike;
    if (like.role !== "user") continue;
    out.push(userText(like));
  }
  return out;
}

function wakeEntryOf(text: string | undefined): WakeAttachmentEntry | undefined {
  if (text === undefined || !isWakeEnvelopeShaped(text)) return undefined;
  const ids = wakeIdsFromEnvelope(text);
  return { ...(ids.length === 1 ? { wakeId: ids[0] } : {}), attachments: parseWakeAttachments(text) };
}

/**
 * Notes the wake attachments from a model call's context. eve's dynamic context exposes the
 * conversation as `messages()`, a function that assembles it on call; an older context carried
 * the array itself. A read that throws notes none.
 */
export async function noteWakeAttachmentsFrom(ctx: unknown): Promise<number> {
  let messages: unknown;
  try {
    const raw = (ctx as { messages?: unknown } | undefined)?.messages;
    messages = typeof raw === "function" ? await (raw as () => unknown).call(ctx) : raw;
  } catch {
    messages = undefined;
  }
  return noteWakeAttachments(messages);
}

export function noteWakeAttachments(messages: unknown): number {
  let noted: NotedWakeAttachments = { last: [], wakes: [] };
  try {
    const entries = (Array.isArray(messages) ? userTexts(messages) : []).map(wakeEntryOf);
    const wakes = entries.filter((e): e is WakeAttachmentEntry => e !== undefined && e.wakeId !== undefined).slice(-MAX_NOTED_WAKES);
    noted = { last: entries.at(-1)?.attachments ?? [], wakes };
  } catch {
    noted = { last: [], wakes: [] };
  }
  try {
    wakeAttachmentSlot.update(() => noted);
  } catch {
  }
  return noted.last.length;
}

function readNoted(): NotedWakeAttachments {
  try {
    const v = wakeAttachmentSlot.get() as Partial<NotedWakeAttachments> | undefined;
    return { last: Array.isArray(v?.last) ? v.last : [], wakes: Array.isArray(v?.wakes) ? v.wakes : [] };
  } catch {
    return { last: [], wakes: [] };
  }
}

function currentWakeAttachments(): readonly BriefAttachment[] {
  return readNoted().last;
}

/**
 * The attachments of ONE wake, by its id: the wake the requester's message arrived in. The last
 * model call of this session noted them from its messages. They are every `<attachment/>` in that
 * wake's envelope, so a backscroll message's file in the same envelope counts too. A wake the call
 * did not read, a message whose envelope names no single wake id, and every other wake (an earlier
 * wake, another room) give none.
 */
export function wakeAttachmentsFor(wakeId: string | undefined): readonly BriefAttachment[] {
  if (wakeId === undefined || wakeId.length === 0) return [];
  const wakes = readNoted().wakes;
  for (let i = wakes.length - 1; i >= 0; i--) if (wakes[i]?.wakeId === wakeId) return wakes[i]?.attachments ?? [];
  return [];
}

function carryAttachmentsIntoBrief(candidate: unknown): unknown {
  try {
    const attachments = currentWakeAttachments();
    if (attachments.length === 0) return candidate;
    if (candidate === null || typeof candidate !== "object") return candidate;
    const message = (candidate as Record<string, unknown>)[DELEGATION_BRIEF_FIELD];
    if (typeof message !== "string" || message.length === 0) return candidate;
    return { ...(candidate as Record<string, unknown>), [DELEGATION_BRIEF_FIELD]: withDelegatedAttachments(message, attachments) };
  } catch {
    return candidate;
  }
}

function continuingWakeForTurn(turnId: string): string | undefined {
  const settlement = settlementDispatchAuthorityThisTurn(turnId);
  const settlementTurn = uningressedTurn(turnId) && (settlement.kind !== "none" || taskWakeThisTurn(turnId) !== undefined);
  if (settlementTurn) return settlement.kind === "single" ? settlement.authority.wakeId : undefined;
  return addressedWakeThisTurn(turnId) ?? exactDispatchWakeThisTurn(turnId);
}

function continuingWakeForCall(turnId: string, taskId: string, joinedRequestId: string | undefined): string | undefined {
  if (workRequestNamesTask(turnId, joinedRequestId, taskId)) return joinedRequestId;
  return continuingWakeForTurn(turnId);
}

export async function decideTaskContinuation(
  turn: ContinuationTurn | null,
  taskId: string,
  toolName: string = DELEGATION_TOOL_NAME,
  org: string = deploymentOrg(),
  validated: () => Promise<boolean> = async () => true,
  joinedRequestId?: string,
): Promise<TaskContinuationVerdict | { readonly admit: false; readonly reason: "eve-refused" }> {
  if (turn === null) return { admit: false, reason: "no-turn" };
  if (!turn.unified) return { admit: false, reason: "not-unified" };
  const continuingWakeId = continuingWakeForCall(turn.turnId, taskId, joinedRequestId);
  const checked = await checkTaskContinuation({ org, parentSessionId: turn.sessionId, taskId, toolName, continuingWakeId, continuingTurnId: turn.turnId });
  if (!checked.admit) return checked;
  if (!(await validated())) return { admit: false, reason: "eve-refused" };
  return await commitTaskContinuation({ org, parentSessionId: turn.sessionId, taskId, continuingTurnId: turn.turnId, check: checked.check });
}

async function returnRefusedJob(turnId: string | undefined, requestId: string, taskId: string, reason: TaskContinuationRefusal): Promise<boolean> {
  const notify = registeredContinuationRefusalNotifier();
  if (notify === undefined) {
    console.error(`[open-everywhere:work] request ${requestId}: the continuation of task ${taskId} was refused (${reason}), and NO refusal notice is registered (channels/work-loss.ts did not load), so the seat is not told`);
    return false;
  }
  retireWorkRequest(turnId, requestId);
  console.warn(`[open-everywhere:work] request ${requestId}: the continuation of task ${taskId} was refused (${reason}) — the job goes back to the seat as failed`);
  await notify({ requestId, taskId, reason }).catch(() => false);
  return true;
}

function continuationTaskId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : value;
}

type GuardOutcome = { readonly success: true; readonly value: unknown } | { readonly success: false; readonly error: Error };

type EvesOwnValidation = (input: unknown) => Promise<{ readonly success: true; readonly value: unknown } | { readonly success: false; readonly error: Error }>;

function withoutCallerOutputSchema(value: unknown): unknown {
  if (value === null || typeof value !== "object" || !(CALLER_OUTPUT_SCHEMA_FIELD in value)) return value;
  const { [CALLER_OUTPUT_SCHEMA_FIELD]: _shape, ...rest } = value as Record<string, unknown>;
  return rest;
}

async function guardedCallOutcome(value: unknown, name: string, delegation: boolean, evesOwn: EvesOwnValidation): Promise<GuardOutcome> {
  const turnId = currentContinuationTurn()?.turnId;
  const message = value !== null && typeof value === "object" ? (value as Record<string, unknown>)["message"] : undefined;
  const heldBefore = delegation && workCallClaimed(turnId, message);
  const outcome = await guardedCallVerdict(value, name, delegation, evesOwn);
  if (delegation && !heldBefore && outcome.success === false) releaseWorkCall(turnId, message);
  return outcome;
}

async function guardedCallVerdict(value: unknown, name: string, delegation: boolean, evesOwn: EvesOwnValidation): Promise<GuardOutcome> {
    let candidate = value;
    const taskId = candidate !== null && typeof candidate === "object" ? continuationTaskId((candidate as Record<string, unknown>)[TASK_ID_FIELD]) : undefined;
    let joinedRequestId: string | undefined;
    let joinedBefore = false;
    if (delegation) {
      const turnNow = currentContinuationTurn();
      const callMessage = candidate !== null && typeof candidate === "object" ? (candidate as Record<string, unknown>)["message"] : undefined;
      const stamp = liveWorkRequestStamp();
      const repeat = workCallClaimed(turnNow?.turnId, callMessage);
      const join = claimWorkCall(turnNow?.turnId, callMessage, stamp);
      if (join.kind === "refused") return { success: false as const, error: new Error(WORK_REQUEST_UNJOINABLE_MESSAGE) };
      if (join.kind === "joined") {
        if (workRequestStarted(turnNow?.turnId, join.requestId)) {
          return { success: false as const, error: new Error(WORK_REQUEST_ALREADY_STARTED_MESSAGE) };
        }
        if (repeat && workStampVerdict(join.requestId, stamp).kind === "needs-reissue") {
          return { success: false as const, error: new Error(WORK_REQUEST_UNJOINABLE_MESSAGE) };
        }
        const verdict = await gateWorkCallStamp(join.requestId, stamp);
        if (verdict.kind === "needs-reissue") {
          retireWorkRequest(turnNow?.turnId, join.requestId);
          return { success: false as const, error: new Error(WORK_CALL_NEEDS_REISSUE_MESSAGE) };
        }
        joinedRequestId = join.requestId;
        joinedBefore = repeat;
      }
    }
    if (delegation) candidate = carryAttachmentsIntoBrief(candidate);
    if (taskId === undefined) return await evesOwn(candidate);
    const turn = currentContinuationTurn();
    let eveResult: Awaited<ReturnType<typeof evesOwn>> | undefined;
    const verdict = await decideTaskContinuation(turn, taskId, name, deploymentOrg(), async () => {
      eveResult = await evesOwn(candidate);
      return eveResult.success === true;
    }, joinedRequestId);
    if (!verdict.admit && verdict.reason === "eve-refused" && eveResult !== undefined) return eveResult;
    auditTaskContinuation({ org: deploymentOrg(), parentSessionId: turn?.sessionId ?? "", turnId: turn?.turnId, taskId, verdict: verdict as TaskContinuationVerdict });
    if (!verdict.admit) {
      const reason = verdict.reason as Exclude<typeof verdict.reason, "eve-refused">;
      if (
        joinedRequestId !== undefined &&
        !joinedBefore &&
        workRequestNamesTask(turn?.turnId, joinedRequestId, taskId) &&
        (await returnRefusedJob(turn?.turnId, joinedRequestId, taskId, reason))
      ) {
        return { success: false as const, error: new Error(WORK_CONTINUATION_RETURNED_MESSAGE) };
      }
      return { success: false as const, error: new Error(taskContinuationRefusalMessage(reason)) };
    }
    return eveResult ?? (await evesOwn(candidate));
}

interface ToolWithInputSchema {
  inputSchema?: unknown;
}

type JsonSchemaObject = {
  properties?: Record<string, unknown>;
  required?: readonly string[];
  [k: string]: unknown;
};

const replacements = new WeakMap<object, unknown>();

const unguardable = new WeakSet<object>();

function guardTool(tool: ToolWithInputSchema, name: string, delegation: boolean): boolean {
  const current = tool.inputSchema;
  if (current === null || typeof current !== "object") return false;

  const cached = replacements.get(current as object);
  if (cached !== undefined) {
    tool.inputSchema = cached;
    return true;
  }
  if (unguardable.has(current as object)) return false;

  const original = asSchema(current as never);
  const source = original.jsonSchema as JsonSchemaObject | undefined;
  const properties = source?.properties;
  if (source === undefined || properties === undefined || !(TASK_ID_FIELD in properties)) {
    unguardable.add(current as object);
    return false;
  }

  const replacement = jsonSchema(source as never, {
    validate: async (value: unknown) => {
      const candidate = delegation ? withoutCallerOutputSchema(value) : value;
      const evesOwn = async (input: unknown) =>
        typeof original.validate !== "function" ? { success: true as const, value: input } : await original.validate(input);
      return await guardedCallOutcome(candidate, name, delegation, evesOwn);
    },
  });

  replacements.set(current as object, replacement);
  tool.inputSchema = replacement;
  return true;
}

export function guardTaskContinuations(toolset: Record<string, unknown>): string[] {
  const guarded: string[] = [];
  for (const [name, raw] of Object.entries(toolset)) {
    if (raw === null || typeof raw !== "object") continue;
    if (STOP_ONLY_TASK_TOOLS.has(name) || SELF_FENCED_TASK_TOOLS.has(name)) continue;
    if (guardTool(raw as ToolWithInputSchema, name, name === DELEGATION_TOOL_NAME)) guarded.push(name);
  }
  return guarded.sort();
}

/**
 * The continuation fence on eve 1.x. eve runs the root agent's `approval` policy on each call to
 * every tool entry except its `frameworkAction` task tools and `interactionOnly` entries, before the call runs or starts a task
 * (`harness/call-executor.js#decideDeferredCall`). A `denied` status settles the call as an error
 * that names the reason, and no task starts or continues. So this policy is the eve 1.x caller of
 * the continuation verdict that `guardTaskContinuations` put on an input schema on eve 0.x: the
 * same refusals, and the same `delegation.continuation_admitted` / `delegation.continuation_refused`
 * rows.
 *
 * It judges only a call that carries a non-blank `taskId`, to any tool whose name has no `__` other
 * than `work` and `cancel_work`: eve's `agent`, a named subagent, and any app tool with a `taskId`
 * input. eve also keeps the policy off an `interactionOnly` entry. On eve 1.x the `call.requested`
 * hook claims the forwarded job a work session's `agent` call joins, so this policy computes the
 * same join without a claim (`peekWorkCallJoin`). The joined job's wake continues the task only when
 * that job names the task; it never takes another job's room. A policy cannot change a call's input,
 * so the brief gets no attachment ids here: the seat's `work` forward adds the forwarding wake's
 * files to the brief (`wakeAttachmentsFor`). eve validated the input against the tool's schema before
 * it asks the policy.
 */
export function continuationGuardedTool(toolName: string, toolInput: unknown): "delegation" | "task" | undefined {
  if (toolName.includes("__") || STOP_ONLY_TASK_TOOLS.has(toolName) || SELF_FENCED_TASK_TOOLS.has(toolName)) return undefined;
  if (toolInput === null || typeof toolInput !== "object") return undefined;
  if (continuationTaskId((toolInput as Record<string, unknown>)[TASK_ID_FIELD]) === undefined) return undefined;
  return toolName === DELEGATION_TOOL_NAME ? "delegation" : "task";
}

export type TaskContinuationApprovalStatus = undefined | { readonly type: "denied"; readonly reason: string };

async function continuationVerdict(toolName: string, taskId: string, message: unknown, delegation: boolean): Promise<string | undefined> {
  const turn = currentContinuationTurn();
  const join = delegation ? peekWorkCallJoin(turn?.turnId, message, liveWorkRequestStamp()) : undefined;
  const joinedRequestId = join?.kind === "joined" ? join.requestId : undefined;
  if (joinedRequestId !== undefined && workRequestStarted(turn?.turnId, joinedRequestId)) return WORK_REQUEST_ALREADY_STARTED_MESSAGE;
  const verdict = await decideTaskContinuation(turn, taskId, toolName, deploymentOrg(), async () => true, joinedRequestId);
  auditTaskContinuation({ org: deploymentOrg(), parentSessionId: turn?.sessionId ?? "", turnId: turn?.turnId, taskId, verdict: verdict as TaskContinuationVerdict });
  if (verdict.admit) return undefined;
  const reason = verdict.reason as Exclude<typeof verdict.reason, "eve-refused">;
  if (
    joinedRequestId !== undefined &&
    workRequestNamesTask(turn?.turnId, joinedRequestId, taskId) &&
    (await returnRefusedJob(turn?.turnId, joinedRequestId, taskId, reason))
  ) {
    return WORK_CONTINUATION_RETURNED_MESSAGE;
  }
  return taskContinuationRefusalMessage(reason);
}

/**
 * The same-step stamp gate on eve 1.x. A worker inherits the auth of the work-session step that
 * starts it, and one step carries ONE `oe_work_request` stamp. Two forwards that join one open turn
 * share that step, so the `agent` call for the second job runs under the first job's stamp. On eve
 * 0.x the input-schema validator refused that call before the worker started
 * (`guardTaskContinuations`). eve 1.x calls no validator OE owns, so the root `approval` policy is
 * the last edge before the worker starts, and it runs the same gate: the job the call joins
 * (`peekWorkCallJoin`, the join `call.requested` claimed) must be the job the step's stamp names.
 * A refused job is retired for this turn and re-sent once (`gateWorkCallStamp`), so it starts in a
 * later step under its own stamp. It also runs the two join refusals that eve 0.x ran first: a call
 * whose message joins no open job, or ties two (a retry of a retired job, a paraphrase in a turn
 * with two or more jobs), and a call for a job whose task already started this turn. Both are
 * refused before the stamp is judged, so neither re-sends a job. A turn that holds no forwarded job
 * (a seat session, a non-work turn) is not judged here.
 */
/** The refusal when the stamp gate itself fails: the call is not started, and nothing is re-sent. */
const WORK_STAMP_GATE_FAILED_MESSAGE =
  "agent: the host could not check this call against the job it forwarded, so the call was NOT started and the job was NOT re-sent. Do not retry it in this step.";

export async function workStampApproval(toolName: string, toolInput: unknown): Promise<string | undefined> {
  if (toolName !== DELEGATION_TOOL_NAME) return undefined;
  const message = toolInput !== null && typeof toolInput === "object" ? (toolInput as Record<string, unknown>)["message"] : undefined;
  const turnId = currentContinuationTurn()?.turnId;
  const stamp = liveWorkRequestStamp();
  const join = peekWorkCallJoin(turnId, message, stamp);
  if (join.kind === "none-open") return undefined;
  if (join.kind === "refused") return WORK_REQUEST_UNJOINABLE_MESSAGE;
  if (workRequestStarted(turnId, join.requestId)) return WORK_REQUEST_ALREADY_STARTED_MESSAGE;
  const verdict = await gateWorkCallStamp(join.requestId, stamp);
  if (verdict.kind === "keyed") return undefined;
  retireWorkRequest(turnId, join.requestId);
  return WORK_CALL_NEEDS_REISSUE_MESSAGE;
}

export async function taskContinuationApproval(ctx: { readonly toolName: string; readonly toolInput?: unknown }): Promise<TaskContinuationApprovalStatus> {
  const nativeRefusal = nativeAgentRefusal(ctx.toolName);
  if (nativeRefusal !== undefined) return { type: "denied", reason: nativeRefusal };
  const cutRefusal = seatCutCallRefusal(ctx.toolName);
  if (cutRefusal !== undefined) return { type: "denied", reason: cutRefusal };
  let stampRefusal: string | undefined;
  try {
    stampRefusal = await workStampApproval(ctx.toolName, ctx.toolInput);
  } catch (err) {
    console.error(`[open-everywhere:work] the same-step stamp gate threw on a ${ctx.toolName} call — refusing it: ${String(err).slice(0, 160)}`);
    stampRefusal = WORK_STAMP_GATE_FAILED_MESSAGE;
  }
  if (stampRefusal !== undefined) return { type: "denied", reason: stampRefusal };
  const kind = continuationGuardedTool(ctx.toolName, ctx.toolInput);
  if (kind === undefined) return undefined;
  const taskId = continuationTaskId((ctx.toolInput as Record<string, unknown>)[TASK_ID_FIELD]) as string;
  let refusal: string | undefined;
  try {
    refusal = await continuationVerdict(ctx.toolName, taskId, (ctx.toolInput as Record<string, unknown>)["message"], kind === "delegation");
  } catch (err) {
    console.error(`[open-everywhere:work] the continuation fence threw on a ${ctx.toolName} call — refusing it: ${String(err).slice(0, 160)}`);
    refusal = taskContinuationRefusalMessage("no-turn");
  }
  return refusal === undefined ? undefined : { type: "denied", reason: refusal };
}

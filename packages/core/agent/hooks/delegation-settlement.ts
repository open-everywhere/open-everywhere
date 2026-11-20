import { defineHook, type HookContext } from "eve/hooks";
import { outboundKey, postOnce } from "../operational/post-once.js";
import { call, calls, task, type SessionView } from "eve/events";
import { dispatchWorkResult } from "../channels/unified.js";
import { OE_WORK_REQUEST_ATTR, OE_WORK_RESULT_ATTR, WORK_RESULT_DEDUPE_TTL_MS, OE_WORK_RESULT_OWED_ATTR, OE_WORK_RESULT_QUIET_ATTR, OE_WORK_RESULT_READS_ATTR, WORK_RESULT_WAKE_ACTION, postWorkResultOnce, readWorkBrief, spendWorkReportPromise, workReportPromised, readWorkCall, readWorkRequest, rememberWorkCall, workLedgerId, readWorkTaskRequest, rememberWorkResult, rememberWorkTask, workResultCarryOf, renderWorkResultWake, workResultText, workTokenForSeat, workCancelRedeemed, type WorkRequestRow } from "../channels/work.js";
import { fireFoldOutcome, foldWorkFire } from "../routines/fire-work-fold.js";
import { answerA2aInboundTask } from "../a2a/inbound/answer.js";
import { noteWorkJobSettled, noteWorkJobStarted, readAnchoredWorkJobs, readWorkJobStatus, settledWorkJobStateFor } from "./work-status.js";
import { currentWorkSessionToken } from "../access/lean-seat-state.js";
import { forgetWorkStop, readWorkStop } from "../channels/work-stop-note.js";
import { forgetSignInMarkers, forgetWorkSignIn, readWorkSignIn } from "../channels/work-sign-in-note.js";
import { forgetWorkAsked, noteJobSettledWait, readWorkAsked, settledJobWaitReason } from "../channels/work-surface-wait.js";
import { settleSignIn } from "../channels/work-sign-in-resume.js";
import { claimWorkCall, noteWorkRequestStarted, workRequestsThisTurn } from "../access/work-request-turn.js";
import { keyWorkTask, readWorkTaskKey, wakeSeatNeedsReissue, workTaskKeyKey } from "./work-task-key.js";
import { bareTokenFromEveContext, stripUnifiedSendPrefix } from "../channels/window-key.js";
import { isWorkSessionContext } from "../access/work-session.js";
import { getOperationalStore } from "../operational/provider.js";
import { mintWakeId } from "../channels/unified-window.js";
import { OE_CHAT_NONMEMBER_ATTR } from "../identity/non-member.js";
import { rememberTaskCall, taskCallLink, type TaskCallLink } from "../access/task-call-link.js";
import {
  readAgentStarted,
  readDelegationFailure,
  readTaskSettled,
  readTaskStarted,
  settledTaskSummary,
  taskSettledFailure,
  type AgentStarted,
  type DelegationFailure,
  type TaskSettled,
  type TaskSettledFailure,
  type TaskStarted,
  type TaskSummary,
} from "../access/background-tasks.js";
import { appendAudit } from "../audit/audit.js";
import { auditErrorDetail, auditErrorFrames } from "../audit/tool-action.js";
import {
  bindFrom,
  currentSessionId,
  currentTurnId,
  currentWakeId,
  deliveryStampOf,
  deploymentOrg,
  inheritedWakeStampOf,
  isSubagentChildContext,
  isUnifiedWindowContext,
  type BindableContext,
} from "../identity/binding.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { advanceDelegatedTaskWake, delegatedTaskDispatchAuthority, installTaskWake, openTaskWake, rememberDelegatedTaskBinding, rememberDelegatedTaskWake, startedTaskWake } from "../channels/task-wake.js";
import { noteStepDelivery, noteTurnBoundary, taskWakeThisTurn, uningressedTurn } from "../access/task-wake-signal.js";
import { liveAuthIsAnotherPrincipal, noteTurnOpeningPrincipal } from "../access/turn-opening-principal.js";
import { noteContinuationTurn } from "../access/continuation-turn-state.js";
import { noteTaskClaimDispatched, noteTaskProvenanceSettled, readTaskOpening, recordTaskOpening, repairTaskClaimDispatched } from "../channels/task-provenance.js";
import { clearStreamDropRetries, streamDropRetriesThisTurn } from "../model/stream-drop-retry.js";
import { addressedWakeThisTurn, exactDispatchWakeThisTurn, noteTaskDispatchedThisTurn } from "../access/dispatch-origin-signal.js";
import { requesterThisTurn } from "../access/requester-identity.js";
import { noteSettlementDispatchAuthority, settlementDispatchAuthorityThisTurn } from "../access/settlement-dispatch-signal.js";
import { claimPromisedReport, noteDelegationRequested, notePendingDelegation, noteDelegationSettled, noteSettlementReportOwed, settlementReportOwedOn } from "../access/pending-delegation-signal.js";
import { clearGenerationDelegation, generationOfTask, noteGenerationDelegation } from "../channels/generation-retirement.js";
import { delegatedSecondAddress, heldTurnWakeProvable, settleDelegatedReads } from "../channels/delegated-provenance.js";
import { stampReadReach } from "../channels/read-reach.js";
import { resolvePartition } from "../memory/partition.js";
import { adoptCarriedWrites, factWritesThisTurn, OE_WORK_RESULT_WRITES_ATTR } from "../memory/write-evidence.js";
import { flushDirtyTreeAtTurnEnd, flushSettledMemory, noteTaskDispatched, noteTaskSettled } from "./settlement-flush.js";
import { flushWorkSettlement } from "./work-flush.js";
import { currentSeatToken, isSameWorkSession, workSessionLedgerId, workTokenHoldingTask } from "../channels/work-generation.js";
import type { MemoryPersistContext } from "./memory.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";
import { optional } from "./control-refusal.js";

export const TASK_STARTED_ACTION = "delegation.task_started";

export const TASK_SETTLED_ACTION = "delegation.task_settled";

export const TASK_UNREADABLE_ACTION = "delegation.task_unreadable";

export const DELEGATED_PROVENANCE_ACTION = "delegation.provenance_carried";

export const TASK_FAILED_ACTION = "delegation.task_failed";

type DelegationFailureEdge = "task-settled" | "settlement" | "result";

type DelegationFailureParse = TaskSettledFailure["parse"] | "result";

async function noteDelegationFailure(
  failure: Partial<DelegationFailure> & { readonly status: string },
  taskId: string,
  ownSessionId: string,
  turnId: string | undefined,
  edge: DelegationFailureEdge,
  parse: DelegationFailureParse,
): Promise<void> {
  await appendAudit({
    org: deploymentOrg(),
    platform: "ingest",
    workspace: "delegation",
    action: TASK_FAILED_ACTION,
    detail: {
      task: taskId,
      call: failure.callId ?? "",
      tool: failure.tool ?? "",
      error: auditErrorDetail(failure.errorText ?? "").error,
      errorClass: auditErrorDetail(failure.errorClass ?? "").error,
      parse,
      outcome: edge,
      status: failure.status,
      ...(ownSessionId.length > 0 ? { session: ownSessionId } : {}),
      ...(turnId !== undefined && turnId.length > 0 ? { turn: turnId } : {}),
    },
  }).catch(() => undefined);
}

const WORKER_TURN_FAILED_ACTION = "delegation.worker_turn_failed";

export function taskStartedData(data: { readonly taskId: string; readonly startedBy: { readonly callId: string }; readonly kind: string; readonly name: string }, turnId: string | undefined): Record<string, unknown> {
  return { taskId: data.taskId, callId: data.startedBy.callId, kind: data.kind, name: data.name, ...(turnId !== undefined ? { turnId } : {}) };
}

export function taskEndedData(
  data: { readonly taskId: string; readonly outcome: string; readonly reason?: string; readonly error?: { readonly message?: string } },
  view: SessionView | undefined,
  turnId: string | undefined,
): Record<string, unknown> {
  const observed = view === undefined ? undefined : task(view, data.taskId);
  return {
    taskId: data.taskId,
    status: data.outcome,
    ...(observed !== undefined ? { callId: observed.callId, kind: observed.kind, name: observed.name } : {}),
    ...(data.reason !== undefined ? { cancel: { reason: data.reason } } : {}),
    ...(data.error !== undefined ? { error: { message: data.error.message } } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
  };
}

const TASK_STATUS_OF_CALL_OUTCOME: Readonly<Record<string, string>> = {
  completed: "completed",
  failed: "failed",
  interrupted: "cancelled",
  abandoned: "cancelled",
};

export function taskCallSettledData(
  data: { readonly callId: string; readonly outcome: string; readonly reason?: string; readonly error?: { readonly message?: string } },
  view: SessionView | undefined,
  turnId: string | undefined,
): Record<string, unknown> | undefined {
  if (view === undefined) return undefined;
  const served = call(view, data.callId);
  const taskId = served?.taskId;
  if (served === undefined || taskId === undefined) return undefined;
  const status = TASK_STATUS_OF_CALL_OUTCOME[data.outcome];
  if (status === undefined) return undefined;
  const observed = task(view, taskId);
  return {
    taskId,
    callId: data.callId,
    status,
    kind: observed?.kind ?? served.kind,
    name: observed?.name ?? served.name,
    ...(status === "cancelled" && data.reason !== undefined ? { cancel: { reason: data.reason } } : {}),
    ...(data.error !== undefined ? { error: { message: data.error.message } } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
  };
}

export function settledCallOutput(view: SessionView | undefined, data: { readonly output?: unknown; readonly outputOf?: { readonly callId: string } }): unknown {
  if (data.output !== undefined) return data.output;
  if (data.outputOf === undefined || view === undefined) return undefined;
  return call(view, data.outputOf.callId)?.output;
}

export function taskContinuedData(
  data: { readonly callId: string; readonly taskId?: string },
  view: SessionView | undefined,
  turnId: string | undefined,
): Record<string, unknown> | undefined {
  if (data.taskId === undefined || view === undefined) return undefined;
  const observed = task(view, data.taskId);
  if (observed === undefined || observed.callId === data.callId) return undefined;
  return { taskId: data.taskId, callId: data.callId, kind: observed.kind, name: observed.name, ...(turnId !== undefined ? { turnId } : {}) };
}

export function childOpenedData(
  data: { readonly sessionId: string; readonly owner: { readonly callId: string } | { readonly taskId: string }; readonly name: string },
  view: SessionView | undefined,
  turnId: string | undefined,
): Record<string, unknown> {
  const owner = data.owner as { readonly callId?: string; readonly taskId?: string };
  const callId = owner.callId ?? (owner.taskId !== undefined && view !== undefined ? task(view, owner.taskId)?.callId : undefined);
  const taskId = owner.taskId ?? (callId !== undefined && view !== undefined ? call(view, callId)?.taskId : undefined);
  return {
    sessionId: data.sessionId,
    name: data.name,
    ...(callId !== undefined ? { callId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
  };
}

const DELEGATING_TOOLS: ReadonlySet<string> = new Set(["agent", "work"]);

export function requestedAction(data: { readonly callId: string; readonly capability: { readonly kind: string; readonly name: string }; readonly input?: unknown }): {
  readonly kind: string;
  readonly callId: string;
  readonly toolName: string;
  readonly input: unknown;
} {
  return { kind: data.capability.kind === "agent" ? "subagent-call" : "tool-call", callId: data.callId, toolName: data.capability.name, input: data.input };
}

async function auditWorkerTurnFailed(ctx: HookContext, error: { readonly code?: string; readonly message?: string } | undefined): Promise<void> {
  const bind = ctx as unknown as BindableContext;
  if (!isSubagentChildContext(bind)) return;
  const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
  const turnId = currentTurnId(bind);
  await appendAudit({
    org: deploymentOrg(),
    platform: "ingest",
    workspace: "delegation",
    action: WORKER_TURN_FAILED_ACTION,
    detail: {
      code: auditErrorDetail(typeof error?.code === "string" ? error.code : "").error,
      error: auditErrorDetail(typeof error?.message === "string" ? error.message : "").error,
      frames: auditErrorFrames(undefined),
      ...(typeof ownSessionId === "string" && ownSessionId.length > 0 ? { session: ownSessionId } : {}),
      ...(turnId !== undefined && turnId.length > 0 ? { turn: turnId } : {}),
      ...(streamDropRetriesThisTurn() > 0 ? { retried: streamDropRetriesThisTurn() } : {}),
    },
  }).catch(() => undefined);
}

export function delegationResultOf(view: SessionView | undefined, data: { readonly callId: string; readonly outcome: string; readonly error?: { readonly code?: string; readonly message?: string } }): Record<string, unknown> | undefined {
  const observed = view === undefined ? undefined : call(view, data.callId);
  if (observed === undefined || observed.kind !== "agent") return undefined;
  const taskBacked = observed.taskId !== undefined;
  return {
    kind: "subagent-result",
    callId: data.callId,
    subagentName: observed.name,
    isError: data.outcome !== "completed" && !taskBacked,
    ...(data.error !== undefined ? { output: { code: data.error.code, message: data.error.message } } : {}),
    outcome: { result: { kind: data.outcome } },
  };
}

export async function noteTaskStarted(receipt: TaskStarted, ownSessionId: string, workRequestId?: string): Promise<TaskCallLink | null> {
  const org = deploymentOrg();
  let link: TaskCallLink | null = null;
  let continuation = false;
  let replay = false;
  try {
    if (ownSessionId.length > 0) {
      const already = await taskCallLink(org, receipt.taskId);
      if (already !== undefined) {
        replay = already.callId === receipt.callId;
        continuation = !replay;
        link = already;
      } else {
        link = {
          callId: receipt.callId,
          childToken: `subagent:${ownSessionId}:${receipt.callId}`,
          parentSessionId: ownSessionId,
          kind: receipt.kind,
          ...(receipt.tool.length > 0 ? { tool: receipt.tool } : {}),
        };
        await rememberTaskCall(org, receipt.taskId, link);
      }
    }
  } catch {
  }
  if (replay) return link;
  void appendAudit({
    org,
    platform: "ingest",
    workspace: "delegation",
    action: TASK_STARTED_ACTION,
    detail: {
      task: receipt.taskId,
      call: receipt.callId,
      kind: receipt.kind,
      tool: receipt.tool,
      ...(ownSessionId.length > 0 ? { session: ownSessionId } : {}),
      continuation,
      ...(workRequestId !== undefined ? { request: workRequestId } : {}),
    },
  }).catch(() => undefined);
  return link;
}

export async function noteAgentStarted(opened: AgentStarted, ownSessionId: string): Promise<void> {
  try {
    if (ownSessionId.length === 0 || opened.taskId === null) return;
    const org = deploymentOrg();
    const link = await taskCallLink(org, opened.taskId);
    if (link === undefined || link.agentId !== undefined) return;
    await rememberTaskCall(org, opened.taskId, { ...link, agentId: opened.sessionId });
  } catch {
  }
}

function noteUnreadableTaskEvent(edge: "task.started" | "task.ended" | "call.settled", data: unknown, ownSessionId: string): void {
  const raw = data as { taskId?: unknown; status?: unknown; kind?: unknown } | null;
  const bounded = (v: unknown): string => (typeof v === "string" ? auditErrorDetail(v).error : "");
  void appendAudit({
    org: deploymentOrg(),
    platform: "ingest",
    workspace: "delegation",
    action: TASK_UNREADABLE_ACTION,
    detail: {
      edge,
      task: bounded(raw?.taskId),
      status: bounded(raw?.status),
      kind: bounded(raw?.kind),
      ...(ownSessionId.length > 0 ? { session: ownSessionId } : {}),
    },
  }).catch(() => undefined);
}

export const DISPATCH_UNAUTHORIZED_ACTION = "delegation.dispatch_unauthorized";

function noteDispatchAuthorityLost(
  edge: "call.requested" | "task.started",
  taskId: string,
  callId: string,
  ownSessionId: string,
  reason: string,
): void {
  console.warn(
    `[open-everywhere:delegation-settlement] delegated dispatch has NO exact wake at ${edge} (${reason}) — ` +
      `no dispatch-authority row is written, so no task wake is minted and this settlement will ` +
      `install no reply address: the reply fence refuses it under \`task-wake-unread\`. The child ` +
      `still launches: eve 0.70 offers this seat no edge that can refuse it.`,
  );
  void appendAudit({
    org: deploymentOrg(),
    platform: "ingest",
    workspace: "delegation",
    action: DISPATCH_UNAUTHORIZED_ACTION,
    detail: {
      edge,
      reason,
      ...(taskId.length > 0 ? { task: taskId } : {}),
      call: callId,
      ...(ownSessionId.length > 0 ? { session: ownSessionId } : {}),
    },
  }).catch(() => undefined);
}

function noteTaskSettledRow(view: TaskSummary, ownSessionId: string): void {
  void appendAudit({
    org: deploymentOrg(),
    platform: "ingest",
    workspace: "delegation",
    action: TASK_SETTLED_ACTION,
    detail: {
      task: view.taskId,
      status: view.status,
      ...(ownSessionId.length > 0 ? { session: ownSessionId } : {}),
      agent: view.agentId ?? "",
    },
  }).catch(() => undefined);
}

export type SettlementFromEvent = {
  readonly failure?: TaskSettledFailure;
  readonly link?: TaskCallLink;
  readonly links?: ReadonlyMap<string, TaskCallLink | undefined>;
  readonly taskSettled?: boolean;
  readonly authorizeRedispatch?: boolean;
};

export async function applyTaskSettlement(
  views: readonly TaskSummary[],
  ownSessionId: string,
  ctx: HookContext,
  settlement: SettlementFromEvent = {},
): Promise<void> {
  if (views.length === 0) return;
  const failure = views.length === 1 ? settlement.failure : undefined;
  const edge: DelegationFailureEdge = settlement.taskSettled === true || failure !== undefined ? "task-settled" : "settlement";
  const settlementLink = views.length === 1 ? settlement.link : undefined;
  const bind = ctx as unknown as BindableContext;
  const inheritedWakeId = inheritedWakeStampOf(bind);
  const wakeTurnId = currentTurnId(bind);
  for (const view of views) noteDelegationSettled(wakeTurnId, view.taskId);
  for (const view of views) await clearGenerationDelegation(deploymentOrg(), view.taskId);
  let seatSurfaceKey: string | undefined;
  try {
    seatSurfaceKey = resolvePartition(bind).surfaceKey;
  } catch {
    seatSurfaceKey = undefined;
  }
  for (const view of views) {
    const link = settlement.links?.has(view.taskId)
      ? settlement.links.get(view.taskId)
      : settlementLink !== undefined
        ? settlementLink
        : await taskCallLink(deploymentOrg(), view.taskId);
    const install = await installTaskWake({
      org: deploymentOrg(),
      taskId: view.taskId,
      status: view.status,
      sessionId: ownSessionId,
      turnId: wakeTurnId,
      inheritedWakeId,
    });
    if (edge === "task-settled" && settlement.authorizeRedispatch === true) {
      noteSettlementDispatchAuthority(
        wakeTurnId,
        view.taskId,
        install.outcome === "installed" || install.outcome === "already" ? install.dispatchAuthority : undefined,
      );
    }
    const armsReport =
      install.outcome === "installed" ||
      (install.outcome === "ingressed" && install.sameSession === true && settlementReportOwedOn(wakeTurnId) === undefined);
    if (armsReport && claimPromisedReport(view.taskId)) {
      noteSettlementReportOwed(wakeTurnId, view.taskId, install.wakeId ?? undefined);
    }
    const carriedBySeat = view.status === "completed" && isWorkSessionContext(bind);
    if (link !== undefined && !carriedBySeat) {
      const reach = stampReadReach(bind, wakeTurnId, seatSurfaceKey);
      const wakeProvable =
        reach.proof !== "wake" ||
        (install.wakeId !== null && reach.wakeId === install.wakeId) ||
        (await heldTurnWakeProvable({
          org: deploymentOrg(),
          outcome: install.outcome,
          sameSession: install.sameSession,
          taskWakeId: install.wakeId,
          turnWakeId: reach.wakeId,
        }));
      const provable = view.status === "completed" && wakeProvable;
      const alsoWakeId =
        provable && reach.proof === "wake"
          ? await delegatedSecondAddress({
              org: deploymentOrg(),
              taskWakeId: install.wakeId,
              inheritedWakeId,
              outcome: install.outcome,
            })
          : undefined;
      const spend = await settleDelegatedReads({
        org: deploymentOrg(),
        childToken: link.childToken,
        sessionId: currentSessionId(bind),
        turnId: wakeTurnId,
        reach: provable ? { ...reach, ...(alsoWakeId !== undefined ? { alsoWakeId } : {}) } : undefined,
      });
      if (spend.found > 0) {
        void appendAudit({
          org: deploymentOrg(),
          platform: "ingest",
          workspace: "delegation",
          action: DELEGATED_PROVENANCE_ACTION,
          detail: {
            task: view.taskId,
            call: link.callId,
            reads: spend.carried,
            found: spend.found,
            outcome: provable ? "carried" : view.status !== "completed" ? "not-completed" : "wake-unprovable",
            proof: reach.proof,
            ...(ownSessionId.length > 0 ? { session: ownSessionId } : {}),
            ...(wakeTurnId !== undefined && wakeTurnId.length > 0 ? { turn: wakeTurnId } : {}),
          },
        }).catch(() => undefined);
      }
    }
    if (view.status === "failed") {
      await noteDelegationFailure(
        {
          status: view.status,
          errorText: failure?.errorText ?? "",
          errorClass: failure?.errorClass ?? "",
          ...(link !== undefined ? { callId: link.callId, tool: link.tool ?? "" } : {}),
        },
        view.taskId,
        ownSessionId,
        wakeTurnId,
        edge,
        failure?.parse ?? "none",
      );
    }
  }
  for (const view of views) noteTaskSettledRow(view, ownSessionId);
}

export async function settleFromTaskSettled(settled: TaskSettled, ownSessionId: string, ctx: HookContext): Promise<void> {
  let view = settledTaskSummary(settled);
  const links = new Map<string, TaskCallLink | undefined>();
  try {
    links.set(view.taskId, await taskCallLink(deploymentOrg(), view.taskId));
  } catch {
    links.set(view.taskId, undefined);
  }
  const link = links.get(view.taskId);
  if (link?.agentId !== undefined) view = { ...view, agentId: link.agentId };
  noteTaskSettled(view);
  await applyTaskSettlement([view], ownSessionId, ctx, {
    taskSettled: true,
    links,
    authorizeRedispatch: true,
    failure: taskSettledFailure(settled),
  });
}

/**
 * The start edge of one task call: `task.started` for the opening call, and `call.started` for a
 * continuation call. The edge runs once per task start: `startTaskEdge` claims the key
 * `<task id>:<call id>` before it runs, as the settlement edges claim the reply (`onceFor`).
 * A task start has exactly one such key: the opening call's `task.started`, or one continuation
 * call's `call.started` (`taskContinuedData` drops a `call.started` of the opening call).
 *
 * The claim closes a window that eve does not close. On a step that eve marks as retried (the host's
 * step attempt is above 1), eve reads the interrupted attempt's lines back and runs no hook on them
 * (`scripts/eve-hook-replay-test.ts`). But the workflow runtime can start a step body before its
 * `step_started` event persists (`forceOptimisticStart`). A process that dies in that gap can see the
 * step again at attempt 1, and eve then writes the lines and runs this edge again. Without the claim, that
 * re-run mints a second task wake, points the task's wake row at it, and runs the work-join writes again.
 * (`noteTaskStarted` already writes no second `delegation.task_started` row for a re-run of the opening
 * call. For a continuation call it writes a second row, and the claim stops it.)
 *
 * The claim has the limits of every `postOnce` claim. A run that throws releases the key, so a later
 * re-run can start the task again. A process that dies inside the edge, after the claim, leaves the edge
 * part-written, and a re-run skips it. An operational store that cannot record the claim fails open, and
 * the edge runs unguarded.
 *
 * The edge also writes turn state in eve session slots (`armTaskStartTurn`). The dead attempt's writes to
 * that state are lost with it, so a re-run that skips the claimed edge re-arms it (`rearmTaskStartTurn`):
 * it reads the work join and the call's start-wake row back, and it writes the same turn state again.
 * Without it, the re-run turn holds no pending delegation, and its reply gate, its turn-end closeout and
 * its settlement see no task. The re-arm does not help a re-run that eve marks as retried, because eve
 * runs no hook on that re-run.
 *
 * A first run that died inside the claimed edge also left its durable rows part-written. So the re-arm
 * repairs each durable row that the edge owes and that a later edge reads (`repairTaskStartRows`,
 * `repairTaskOwedRows`): the task's call link, the job's work rows, the task's opening, a continuation's
 * claim row, and the record that the seat's generation owes the task (`noteGenerationDelegation`). Each
 * repair reads its row back first and writes only when the row does not hold what the first run writes
 * (the gates are on `repairTaskStartRows` and `repairTaskOwedRows`), so a re-run after a clean first run
 * writes none of these rows again. The read-backs are not
 * atomic: a first run that is still alive can pass the same read-back as the re-run, and both then write
 * the same value (and the audit rows of `noteTaskStarted` and `keyWorkTask` twice). The re-arm does not
 * repair the minted task wake: a second mint is the hazard the claim exists to stop.
 *
 * The re-arm has the limits of the read-back. A first run that died after the claim and before it
 * advanced the call's authority row left no start-wake row, so the re-arm arms the pending delegation
 * under the dispatch wake that the authority row still names, and notes no minted wake. A first run on a
 * build that wrote no start-wake row also leaves none, and the authority row then names the minted wake.
 */
async function startTaskEdge(started: TaskStarted, ownSessionId: string, ctx: HookContext): Promise<void> {
  let ran = false;
  await onceFor(deploymentOrg(), TASK_START_CLAIM_ACTION, `${started.taskId}:${started.callId}`, ownSessionId, () => {
    ran = true;
    return runTaskStartEdge(started, ownSessionId, ctx);
  });
  if (!ran) await rearmTaskStartTurn(started, ownSessionId, ctx);
}

/** The claim action of the start edge. One key per task start: see `startTaskEdge`. */
const TASK_START_CLAIM_ACTION = "task.start";

/**
 * The job a task start serves in a work session: the call's work join, else the step's request stamp
 * when the turn holds no open job. Reads only, so the claimed edge and its re-arm resolve the same job.
 */
async function startedWorkRequest(started: TaskStarted, ownSessionId: string, bind: BindableContext): Promise<{ readonly joinedRequest: string | undefined; readonly workRequestId: string | undefined }> {
  if (!isWorkSessionContext(bind)) return { joinedRequest: undefined, workRequestId: undefined };
  const joinedRequest = await readWorkCall(getOperationalStore(), deploymentOrg(), ownSessionId, started.callId);
  const workRequestId = joinedRequest ?? (workRequestsThisTurn(currentTurnId(bind)).length === 0 ? deliveryAttr(bind, OE_WORK_REQUEST_ATTR) : undefined);
  return { joinedRequest, workRequestId };
}

/**
 * The turn state of one task start, in eve session slots: the pending delegation the reply gate and the
 * turn-end closeout read, the task wake the addressed wake retargets, and the live task the settlement
 * flush holds. `runTaskStartEdge` writes it once, and `rearmTaskStartTurn` writes it again on a re-run that
 * skips the claimed edge. Each write is idempotent within a turn.
 */
function armTaskStartTurn(turnId: string | undefined, taskId: string, dispatchWakeId: string | undefined, minted: string | null): void {
  if (minted !== null) noteTaskDispatchedThisTurn(turnId, taskId, minted);
  notePendingDelegation(turnId, taskId, dispatchWakeId);
  noteTaskDispatched(taskId);
}

/**
 * Re-arms the turn state of a task start whose claimed edge an earlier attempt of this step already ran
 * (see `startTaskEdge`). It also repairs the durable rows that a dead first run did not write. A repair
 * that writes a row again writes the value that the first run writes. The call's start-wake row
 * (`startedTaskWake`) names the minted wake and its dispatch wake once the first run reached the advance
 * of the call's authority. Without that row, the advance did not run for this call, so the authority row
 * still names the dispatch wake, and the first run minted no wake that the task uses. A read of the row
 * that fails proves neither case, so the re-arm then arms no pending delegation (the result before the
 * re-arm existed) rather than one under a wake it cannot prove. It then repairs no row that comes after
 * the authority check either.
 */
async function rearmTaskStartTurn(started: TaskStarted, ownSessionId: string, ctx: HookContext): Promise<void> {
  const bind = ctx as unknown as BindableContext;
  const turnId = currentTurnId(bind);
  const work = await startedWorkRequest(started, ownSessionId, bind).catch(() => ({ joinedRequest: undefined, workRequestId: undefined }));
  if (work.workRequestId !== undefined) noteWorkRequestStarted(turnId, work.workRequestId);
  await repairTaskStartRows(started, ownSessionId, bind, work);
  let written: Awaited<ReturnType<typeof startedTaskWake>>;
  try {
    written = await startedTaskWake(deploymentOrg(), started.taskId, ownSessionId, started.callId);
  } catch (err) {
    console.warn(`[open-everywhere:delegation] task ${started.taskId}: the start-wake row is unreadable, so the re-run re-arms no pending delegation: ${String(err).slice(0, 160)}`);
    return;
  }
  if (written !== undefined) {
    await repairTaskOwedRows(started, ownSessionId, bind, undefined);
    armTaskStartTurn(turnId, started.taskId, written.parentWakeId, written.wakeId);
    return;
  }
  const authority = await delegatedTaskDispatchAuthority(deploymentOrg(), ownSessionId, started.callId).catch(() => undefined);
  if (isUnifiedWindowContext(bind) && authority === undefined) return;
  await repairTaskOwedRows(started, ownSessionId, bind, authority?.wakeId);
  armTaskStartTurn(turnId, started.taskId, authority?.wakeId, null);
}

/**
 * Repairs the durable rows that the claimed start edge writes BEFORE its authority check, on a re-run that
 * skips the edge (see `startTaskEdge`): the task's call link and start row (`noteTaskStarted`), and in a
 * work session the job's call join, task row, key row and start status. The settlement reads each of
 * them: without the key row it withholds the job's result, and without the call link it reads no child
 * session. Each write runs only when its row does not hold what the first run writes, so a re-run after a
 * clean first run writes nothing:
 * - The task row names the LATEST job that started or continued the task. The repair writes it when it is
 *   absent, or when it names another job whose request is not newer than this one (a continuation whose
 *   first run died before the write). It never writes over a newer job.
 * - The status row names the job's task, and its start also adds the job to the anchor's list of jobs
 *   (the stop hand). The repair runs the start again when the status row is absent, or when it is this
 *   task's working row and the anchor's list lacks the job (a first run that died between the two writes).
 * A continuation call's start row is an audit row with no read-back (the call link names the opening
 * call), so the repair does not write it again. Each row has its own failure scope. After a write, the
 * repair reads the row back, and it logs a row that is still not written.
 */
async function repairTaskStartRows(
  started: TaskStarted,
  ownSessionId: string,
  bind: BindableContext,
  work: { readonly joinedRequest: string | undefined; readonly workRequestId: string | undefined },
): Promise<void> {
  const org = deploymentOrg();
  const store = getOperationalStore();
  const repaired: string[] = [];
  const repair = async (row: string, absent: () => Promise<boolean>, write: () => Promise<unknown>): Promise<void> => {
    try {
      if (!(await absent())) return;
      await write();
      if (await absent()) console.warn(`[open-everywhere:delegation] task ${started.taskId}: the re-run wrote the ${row} row, and it still does not read back`);
      else repaired.push(row);
    } catch (err) {
      console.warn(`[open-everywhere:delegation] task ${started.taskId}: the re-run could not repair the ${row} row: ${String(err).slice(0, 160)}`);
    }
  };
  if (ownSessionId.length > 0) {
    await repair("call-link", async () => (await taskCallLink(org, started.taskId)) === undefined, () => noteTaskStarted(started, ownSessionId, work.workRequestId));
  }
  const requestId = work.workRequestId;
  if (requestId !== undefined) {
    const at = new Date().toISOString();
    await repair("work-call", async () => (await readWorkCall(store, org, ownSessionId, started.callId)) === undefined, () => rememberWorkCall(store, org, ownSessionId, started.callId, requestId, at));
    await repair("work-task", () => workTaskRowOwed(store, org, started.taskId, requestId), () => rememberWorkTask(store, org, started.taskId, requestId, at));
    await repair(
      "work-key",
      async () => (await store.getTaskResult(org, workTaskKeyKey(started.taskId, started.callId))) === null,
      () => keyWorkTask({ taskId: started.taskId, callId: started.callId, workSessionId: ownSessionId, joined: requestId, stamped: deliveryAttr(bind, OE_WORK_REQUEST_ATTR) }),
    );
    await repair(
      "work-status",
      async () => {
        const status = await readWorkJobStatus(store, org, requestId);
        if (status === undefined) return true;
        if (status.taskId !== started.taskId || status.state !== "working" || status.anchorKey === undefined) return false;
        return !(await readAnchoredWorkJobs(store, org, status.anchorKey)).some((j) => j.requestId === requestId);
      },
      () => noteWorkJobStarted({ requestId, taskId: started.taskId }),
    );
  }
  if (repaired.length > 0) console.warn(`[open-everywhere:delegation] task ${started.taskId}: the re-run repaired the start rows a dead first run did not write: ${repaired.join(", ")}`);
}

/**
 * Whether the task row still owes this job: the row is absent, or it names another job whose request is
 * not newer than this one. A request row that does not read back proves nothing, so the row is then not owed.
 */
async function workTaskRowOwed(store: ReturnType<typeof getOperationalStore>, org: string, taskId: string, requestId: string): Promise<boolean> {
  const current = await readWorkTaskRequest(store, org, taskId);
  if (current === undefined) return true;
  if (current === requestId) return false;
  const [theirs, mine] = await Promise.all([readWorkRequest(store, org, current), readWorkRequest(store, org, requestId)]);
  return theirs !== undefined && mine !== undefined && theirs.atIso <= mine.atIso;
}

/**
 * Repairs the durable rows that the claimed start edge writes AFTER its authority check, on a re-run that
 * skips the edge: the task's opening (when the advance did not run, `dispatchWakeId` names the dispatch
 * wake, and the write is put-if-absent; when it ran, the opening came before it and `dispatchWakeId` is
 * `undefined`), a continuation call's claim row (`repairTaskClaimDispatched`: only this turn's own claim
 * that names no call yet), and the record that the seat's generation owes the task. Without that record,
 * the OPE-1620 guard can retire the generation while it still owes the task. The record is written only
 * when no generation names the task, so a re-run after a clean first run does not write it a second time.
 * Each row has its own failure scope.
 */
async function repairTaskOwedRows(started: TaskStarted, ownSessionId: string, bind: BindableContext, dispatchWakeId: string | undefined): Promise<void> {
  const org = deploymentOrg();
  const warn = (row: string) => (err: unknown): void =>
    console.warn(`[open-everywhere:delegation] task ${started.taskId}: the re-run could not repair the ${row} row: ${String(err).slice(0, 160)}`);
  if (dispatchWakeId !== undefined) {
    await recordTaskOpening({ org, parentSessionId: ownSessionId, taskId: started.taskId, callId: started.callId, tool: started.tool, wakeId: dispatchWakeId }).catch(warn("opening"));
    if ((await readTaskOpening(org, ownSessionId, started.taskId).catch(() => undefined)) === undefined) warn("opening")("the opening does not read back");
  }
  await repairTaskClaimDispatched(org, ownSessionId, started.taskId, started.callId, currentTurnId(bind)).catch(warn("claim"));
  try {
    if ((await generationOfTask(org, started.taskId)) === undefined) await noteGenerationDelegation(org, resolveOwnWindowToken(bind), started.taskId);
  } catch (err) {
    warn("owed-generation")(err);
  }
}

async function runTaskStartEdge(started: TaskStarted, ownSessionId: string, ctx: HookContext): Promise<void> {
  const { joinedRequest, workRequestId } = await startedWorkRequest(started, ownSessionId, ctx as unknown as BindableContext);
  await noteTaskStarted(started, ownSessionId, workRequestId);
  if (workRequestId !== undefined) {
    noteWorkRequestStarted(currentTurnId(ctx as unknown as BindableContext), workRequestId);
    if (joinedRequest === undefined) await rememberWorkCall(getOperationalStore(), deploymentOrg(), ownSessionId, started.callId, workRequestId, new Date().toISOString());
    await rememberWorkTask(getOperationalStore(), deploymentOrg(), started.taskId, workRequestId, new Date().toISOString());
    await keyWorkTask({ taskId: started.taskId, callId: started.callId, workSessionId: ownSessionId, joined: workRequestId, stamped: deliveryAttr(ctx as unknown as BindableContext, OE_WORK_REQUEST_ATTR) });
    await noteWorkJobStarted({ requestId: workRequestId, taskId: started.taskId });
  }
  const bind = ctx as unknown as BindableContext;
  const dispatchTurnId = currentTurnId(bind);
  const prelaunchAuthority = await delegatedTaskDispatchAuthority(deploymentOrg(), ownSessionId, started.callId);
  if (isUnifiedWindowContext(bind) && prelaunchAuthority === undefined) {
    noteDispatchAuthorityLost("task.started", started.taskId, started.callId, ownSessionId, "authority-row-absent-at-task-started");
    return;
  }
  const dispatchWakeId = prelaunchAuthority?.wakeId;
  await recordTaskOpening({ org: deploymentOrg(), parentSessionId: ownSessionId, taskId: started.taskId, callId: started.callId, tool: started.tool, wakeId: dispatchWakeId });
  const ownWindowToken = resolveOwnWindowToken(bind);
  const minted = await openTaskWake({
    org: deploymentOrg(),
    taskId: started.taskId,
    parentWakeId: dispatchWakeId,
    windowToken: ownWindowToken,
  });
  if (minted !== null && prelaunchAuthority !== undefined) {
    await advanceDelegatedTaskWake(deploymentOrg(), ownSessionId, started.callId, started.taskId, minted, prelaunchAuthority);
    const opening = await readTaskOpening(deploymentOrg(), ownSessionId, started.taskId);
    if (opening !== undefined && opening.openingCallId !== started.callId) {
      await rememberDelegatedTaskWake(deploymentOrg(), ownSessionId, opening.openingCallId, minted);
    }
  }
  {
    const opening = await readTaskOpening(deploymentOrg(), ownSessionId, started.taskId);
    if (opening !== undefined && opening.openingCallId !== started.callId) {
      await noteTaskClaimDispatched(deploymentOrg(), ownSessionId, started.taskId, started.callId, dispatchTurnId);
    }
  }
  await noteGenerationDelegation(deploymentOrg(), ownWindowToken, started.taskId);
  armTaskStartTurn(dispatchTurnId, started.taskId, dispatchWakeId, minted);
}

/**
 * The settlement identity of one reply of a task on eve 1.x. eve's `settleTask` settles every call a
 * reply serves in ONE commit: one `call.settled` per call. On a completed reply the first carries
 * `output` and each later one carries `outputOf`. A commit is one line of the session stream, so its facts share `position.line`.
 * The `task.ended` that closes a task body is written in the same commit as the `call.settled` facts
 * of the calls it settles (`settleRemainingTaskCalls`, then `endTask`). So the line names the reply,
 * and the edges of one commit share it. On a step that eve marks as retried, eve runs no hook again on a line
 * (`scripts/eve-hook-replay-test.ts`). No position, no reply key: the edge then runs unguarded.
 */
export function settlementReplyKey(position: { readonly line?: unknown } | undefined): string | undefined {
  const line = position?.line;
  return typeof line === "number" && Number.isFinite(line) ? `L${line}` : undefined;
}

/**
 * Runs `run` once per key. A run that throws, or that returns `false` (its work did not land), releases
 * its key, so a later edge of the same reply can settle again.
 */
async function onceFor(org: string, action: string, stableId: string | undefined, payload: string, run: () => Promise<boolean | void>): Promise<void> {
  if (stableId === undefined) {
    await run();
    return;
  }
  const key = outboundKey({ surface: "delegation", action, stableId, payload });
  const landed = await postOnce({ org, key, ttlMs: WORK_RESULT_DEDUPE_TTL_MS, releaseKeyOnFailure: () => true, run });
  if (landed === false) await getOperationalStore().forgetEventSeen(org, key).catch(() => undefined);
}

/**
 * The job a settled call served. `call.requested` joins each `agent` call of a work session to ONE
 * job (`rememberWorkCall`), and `task.started` writes the same join for a call it keys off the step
 * stamp. The task-wide row (`rememberWorkTask`) names only the LATEST job that started or continued
 * the task, so it is read only for a call with no join row.
 */
async function workRequestOfCall(org: string, ownSessionId: string, settled: TaskSettled): Promise<string | undefined> {
  const store = getOperationalStore();
  return (await readWorkCall(store, org, ownSessionId, settled.callId).catch(() => undefined)) ?? (await readWorkTaskRequest(store, org, settled.taskId).catch(() => undefined));
}

/**
 * Settles one call a task served. The task-level bookkeeping (provenance, the `delegation.task_settled`
 * row, the task wake) runs once per reply of the task. The job-level settlement (the result wake to
 * the seat and the `work.status` row) runs once per job per reply: two calls of one job settle it
 * once, and two calls of two jobs settle each job once.
 */
async function settleTaskEdge(settled: TaskSettled, ownSessionId: string, ctx: HookContext, output: unknown, replyKey: string | undefined): Promise<void> {
  const org = deploymentOrg();
  const reply = replyKey === undefined ? undefined : `${settled.taskId}:${replyKey}`;
  await onceFor(org, "task.reply_settled", reply, ownSessionId, async () => {
    await noteTaskProvenanceSettled(org, ownSessionId, settled.taskId);
    await settleFromTaskSettled(settled, ownSessionId, ctx);
  });
  if (!isWorkSessionContext(ctx as unknown as BindableContext)) return;
  const requestId = await workRequestOfCall(org, ownSessionId, settled);
  await onceFor(org, "work.job_settled", reply, requestId ?? `call:${settled.callId}`, async () => {
    try {
      await wakeSeatWithWorkResult(settled, requestId, { output, settlementSeq: replyKey ?? settled.callId }, ctx);
    } finally {
      if (requestId !== undefined && !(await settleWorkJobStatus(settled, requestId))) {
        console.warn(`[open-everywhere:work] request ${requestId}: the settled status row of task ${settled.taskId} was not written — the settlement is released for a retry`);
        return false;
      }
    }
    return true;
  });
}

/**
 * The calls a task serves that are still open in the view. eve 1.x settles a task's open calls before
 * it ends the task, in the same commit, so a `task.ended` normally finds none. A call it finds open
 * is one eve never settled, and the `task.ended` fallback settles that call's job.
 */
export function openTaskCalls(view: SessionView | undefined, taskId: string, openingCallId: string | undefined): readonly string[] {
  if (view === undefined) return openingCallId === undefined ? [] : [openingCallId];
  const serving = new Set<string>();
  try {
    for (const c of calls(view, { taskId })) if (c.outcome === undefined) serving.add(c.callId);
  } catch {
  }
  if (openingCallId !== undefined && call(view, openingCallId)?.outcome === undefined) serving.add(openingCallId);
  return [...serving];
}

function deliveryAttr(ctx: BindableContext, key: string): string | undefined {
  const v = (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } } } }).session?.auth?.current?.attributes?.[key];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

function adoptWorkResultWrites(bind: BindableContext): void {
  try {
    if (isSubagentChildContext(bind) || isWorkSessionContext(bind)) return;
    if (deliveryAttr(bind, OE_WORK_RESULT_ATTR) === undefined) return;
    adoptCarriedWrites(currentTurnId(bind), deliveryAttr(bind, OE_WORK_RESULT_WRITES_ATTR));
  } catch {
  }
}

function noteWorkResultReportOwed(bind: BindableContext): void {
  try {
    if (isSubagentChildContext(bind) || isWorkSessionContext(bind)) return;
    const requestId = deliveryAttr(bind, OE_WORK_RESULT_ATTR);
    if (requestId === undefined) return;
    const promisedHere = claimPromisedReport(workLedgerId(requestId));
    if (deliveryAttr(bind, OE_WORK_RESULT_QUIET_ATTR) === "true") return;
    const stamped = deliveryAttr(bind, OE_WORK_RESULT_OWED_ATTR) === "true";
    if (promisedHere || stamped) noteSettlementReportOwed(currentTurnId(bind), workLedgerId(requestId), currentWakeId(bind));
  } catch {
  }
}

async function spendWorkResultReads(bind: BindableContext, childToken: string, requestId: string): Promise<void> {
  const org = deploymentOrg();
  if (!/^subagent:[^:]+:[^:]+$/.test(childToken)) return;
  const turnId = currentTurnId(bind);
  const row = await readWorkRequest(getOperationalStore(), org, requestId).catch(() => undefined);
  if (row === undefined) return;
  const ownToken = resolveOwnWindowToken(bind);
  const ownWork = ownToken === undefined ? undefined : workTokenForSeat(ownToken);
  if (ownWork === undefined || workTokenForSeat(row.seatToken) !== ownWork) return;
  const reach = stampReadReach(bind, turnId, undefined);
  const alsoWakeId = reach.proof === "wake" && reach.wakeId !== row.wakeId ? row.wakeId : undefined;
  const sessionId = currentSessionId(bind);
  const spend = await settleDelegatedReads({
    org,
    childToken,
    sessionId,
    turnId,
    reach: reach.proof === "none" ? undefined : { ...reach, ...(alsoWakeId !== undefined ? { alsoWakeId } : {}) },
    ...(sessionId !== undefined && turnId !== undefined && turnId.length > 0 ? { replayKey: `${sessionId}:${turnId}` } : {}),
  });
  if (spend.found > 0) {
    void appendAudit({
      org,
      platform: "ingest",
      workspace: "delegation",
      action: DELEGATED_PROVENANCE_ACTION,
      detail: {
        request: requestId,
        reads: spend.carried,
        found: spend.found,
        outcome: spend.carried > 0 ? "carried" : "wake-unprovable",
        proof: reach.proof,
        ...(turnId !== undefined && turnId.length > 0 ? { turn: turnId } : {}),
      },
    }).catch(() => undefined);
  }
}

/**
 * Writes the job's settled status row. It returns `false` when the row does not read back as settled
 * for this task, so the once-claim of the job's settlement is released and a later edge of the same reply can retry it.
 * The status write itself is idempotent (the first settled state wins), and the result wake keeps its
 * own dedupe, so a retry posts no second wake.
 */
async function settleWorkJobStatus(settled: TaskSettled, requestId: string): Promise<boolean> {
  const org = deploymentOrg();
  const store = getOperationalStore();
  try {
    const row = await readWorkRequest(store, org, requestId).catch(() => undefined);
    const redeemed = await workCancelTicketRedeemed(org, store, row, settled);
    await noteWorkJobSettled({ requestId, taskId: settled.taskId, status: settledWorkJobStateFor(settled.status, redeemed) });
  } catch {
  }
  const written = await readWorkJobStatus(store, org, requestId);
  return written !== undefined && written.taskId === settled.taskId && written.state !== "working";
}

async function workCancelTicketRedeemed(org: string, store: ReturnType<typeof getOperationalStore>, row: WorkRequestRow | undefined, settled: TaskSettled): Promise<boolean> {
  if (settled.status !== "completed") return false;
  const holding = row === undefined ? undefined : await workTokenHoldingTask(org, row.seatToken, settled.taskId, store).catch(() => undefined);
  const tokens = [...new Set([currentWorkSessionToken(), holding, row === undefined ? undefined : workTokenForSeat(row.seatToken)])].filter((t): t is string => t !== undefined);
  for (const t of tokens) if (await workCancelRedeemed(store, org, t, settled.taskId)) return true;
  return false;
}

async function wakeSeatWithWorkResult(settled: TaskSettled, requestId: string | undefined, reply: { readonly output: unknown; readonly settlementSeq: string }, ctx: HookContext): Promise<void> {
  const org = deploymentOrg();
  const store = getOperationalStore();
  const row = requestId === undefined ? undefined : await readWorkRequest(store, org, requestId);
  const audit = (detail: AuditDetail) =>
    appendAudit({ org, platform: "unified", workspace: "delegation", action: WORK_RESULT_WAKE_ACTION, detail: { taskId: settled.taskId, ...(requestId !== undefined ? { requestId } : {}), status: settled.status, ...detail } }).catch(() => undefined);
  if (requestId === undefined || row === undefined) {
    await audit({ outcome: "skipped", reason: requestId === undefined ? "no-request-for-task" : "request-row-missing" });
    return;
  }
  const key = await readWorkTaskKey(store, org, settled.taskId, settled.callId);
  if (key === undefined || key.verdict !== "keyed" || key.requestId !== requestId) {
    await flushWorkSettlement(ctx, settled.taskId);
    await wakeSeatNeedsReissue({ requestId, edge: "task.started", reason: key?.reason ?? "stamp-absent", taskId: settled.taskId });
    await clearGenerationDelegation(org, workSessionLedgerId(requestId), store).catch(() => undefined);
    await audit({ outcome: "withheld", reason: key === undefined ? "task-unkeyed" : (key.reason ?? "key-mismatch") });
    return;
  }
  const status = settled.status === "completed" ? "completed" : settled.status === "cancelled" ? "cancelled" : "failed";
  console.log(`[open-everywhere:work] task ${settled.taskId} settled ${settled.status}${settled.cancelReason ? ` (cancel: ${settled.cancelReason.slice(0, 160)})` : ""}${settled.errorText ? ` — ${settled.errorText.slice(0, 160)}` : ""} → result wake for request ${requestId}`);
  const output = reply.output;
  const settlementSeq = reply.settlementSeq;
  const childToken = (await taskCallLink(org, settled.taskId).catch(() => undefined))?.childToken;
  const stop = childToken === undefined ? undefined : await readWorkStop(org, childToken, settled.callId);
  const signInRow = childToken === undefined ? undefined : await readWorkSignIn(org, childToken, settled.callId);
  const signInCancelled = signInRow !== undefined && (status === "cancelled" || (await workCancelTicketRedeemed(org, store, row, settled)));
  const signIn = stop === undefined && signInRow?.delivered === true && signInRow.detourId !== undefined && !signInCancelled && row.fire === undefined ? signInRow : undefined;
  if (signInCancelled && signInRow?.detourId !== undefined) await forgetSignInMarkers(org, signInRow.detourId);
  const quietSignIn = signIn !== undefined && signIn.sameConversation;
  const asked = childToken === undefined ? false : await readWorkAsked(org, childToken);
  const readsToken = status === "completed" && stop === undefined ? childToken : undefined;
  const wakeId = row.fire !== undefined ? row.wakeId : mintWakeId();
  const seatToken = await currentSeatToken(org, row.seatToken, store);
  const bareToken = (t: string): string => stripUnifiedSendPrefix(t);
  const seatRotated = row.fire === undefined && bareToken(seatToken) !== bareToken(row.seatToken);
  const rotatedBrief = seatRotated ? await readWorkBrief(store, org, requestId) : undefined;
  await flushWorkSettlement(ctx, settled.taskId);
  const memoryWrites = factWritesThisTurn(currentTurnId(ctx as unknown as BindableContext));
  const silentFire = row.fire !== undefined && !row.fire.owesRoom;
  const a2aFire = row.fire?.a2a;
  let a2aWrite: "written" | "gone" | "error" | undefined;
  let delivered = false;
  let reportOwed = false;
  const ran = await postWorkResultOnce({
    org,
    taskId: settled.taskId,
    settlementSeq,
    requestId,
    run: async () => {
      const foldAs = row.fire === undefined ? undefined : fireFoldOutcome(status, stop !== undefined, await workCancelTicketRedeemed(org, store, row, settled));
      if (foldAs !== undefined) await foldWorkFire(row, foldAs, { org, sessionId: (ctx as { session?: { id?: string } }).session?.id ?? "" });
      if (a2aFire !== undefined) {
        a2aWrite = await answerA2aInboundTask({
          org,
          store,
          caller: a2aFire.caller,
          taskId: a2aFire.taskId,
          requestId,
          status: status === "completed" && (await workCancelTicketRedeemed(org, store, row, settled)) ? "cancelled" : status,
          stopped: stop !== undefined,
          resultText: workResultText(output, settled.errorText),
        });
        return;
      }
      if (silentFire) return;
      if (row.fire === undefined) {
        const waits = settledJobWaitReason({
          signInResumable: signIn !== undefined,
          asked,
          status,
          stopped: stop !== undefined,
          cancelRedeemed: asked && status === "completed" && (await workCancelTicketRedeemed(org, store, row, settled)),
        });
        await noteJobSettledWait({ requestId, taskId: settled.taskId, waits });
      }
      reportOwed = row.fire === undefined && !quietSignIn && (await workReportPromised(store, org, requestId));
      const resultText = stop === undefined ? workResultText(output, settled.errorText) : "[the host stopped the worker before it ran, so it reported nothing]";
      delivered = await dispatchWorkResult({
        seatToken,
        wakeId,
        message: renderWorkResultWake({
          wakeId,
          origin: row.origin,
          requestId,
          taskId: settled.taskId,
          status,
          text: resultText,
          nowIso: new Date().toISOString(),
          dispatchWakeId: row.wakeId,
          ...(stop !== undefined ? { stopRefusal: stop.refusal } : {}),
          ...(row.fire !== undefined ? { fire: true as const } : {}),
          ...(seatRotated ? { rotated: { forwardedAtIso: row.atIso, ...(rotatedBrief !== undefined ? { brief: rotatedBrief } : {}) } } : {}),
          ...(signIn !== undefined && row.fire === undefined ? { signIn: { connector: signIn.connector, sameConversation: signIn.sameConversation } } : {}),
        }),
        origin: row.origin,
        surfaceKey: row.surfaceKey,
        binding: row.binding,
        requester: row.requester,
        nonMemberWake: row.nonMemberWake,
        requestId,
        ...(readsToken !== undefined && readsToken.length > 0 ? { readsToken } : {}),
        ...(row.fire?.posture !== undefined ? { invokerPosture: row.fire.posture } : {}),
        ...(row.fire?.creator !== undefined ? { fireCreator: row.fire.creator } : {}),
        ...(row.fire?.marker !== undefined ? { fireRoutine: { id: row.fire.marker.id, surfaceKey: row.fire.marker.surfaceKey } } : {}),
        ...(memoryWrites.length > 0 ? { memoryWrites } : {}),
        ...(reportOwed ? { reportOwed: true } : {}),
        ...(quietSignIn && row.fire === undefined ? { quiet: true } : {}),
      });
      // The task's latest result, kept for a follow-up that starts as a NEW job after a rotation: its
      // worker reads what this conversation already got (`renderFreshFollowUpBrief`). Only a delivered
      // wake that is not quiet, for a worker the host did not stop, writes it (`workResultCarryOf`). A
      // failed write costs only that carry, so it never fails the wake.
      const carried = workResultCarryOf({ delivered, quiet: quietSignIn, stopped: stop !== undefined, status, text: resultText });
      if (carried !== undefined) await rememberWorkResult(store, org, settled.taskId, carried, new Date().toISOString()).catch(() => undefined);
    },
  });
  if (ran && delivered && reportOwed) await spendWorkReportPromise(store, org, requestId, new Date().toISOString()).catch(() => undefined);
  if (ran && delivered) await clearGenerationDelegation(org, workLedgerId(requestId), store);
  if (ran) await clearGenerationDelegation(org, workSessionLedgerId(requestId), store);
  if (ran && delivered && stop !== undefined && childToken !== undefined) await forgetWorkStop(org, childToken);
  if (ran && signInRow !== undefined && childToken !== undefined) await forgetWorkSignIn(org, childToken);
  await settleSignIn({
    org,
    ran,
    detourId: signInRow?.detourId,
    file: signIn?.detourId !== undefined ? { requestId, taskId: settled.taskId, connector: signIn.connector } : undefined,
  });
  if (ran && childToken !== undefined && asked) await forgetWorkAsked(org, childToken);
  await audit(
    !ran
      ? { outcome: "replay-skipped" }
      : a2aFire !== undefined
        ? { outcome: a2aWrite === "written" ? "a2a-answered" : a2aWrite === "gone" ? "a2a-task-gone" : "a2a-answer-failed", fire: true }
        : silentFire
        ? { outcome: "silent-fire", fire: true }
        : { outcome: delivered ? "delivered" : "failed", wakeId, reportOwed, seatRotated, ...(row.fire !== undefined ? { fire: true } : {}), ...(stop !== undefined ? { stoppedBy: "egress-own-account", connector: stop.connector } : {}), ...(signIn !== undefined ? { signIn: quietSignIn ? "quiet" : "said", connector: signIn.connector } : {}) },
  );
}

export default defineHook({
  events: {
    "turn.started": optional("delegation-settlement", (_event, ctx) => {
      noteContinuationTurn(ctx as unknown as BindableContext);
      const bind = ctx as unknown as BindableContext;
      noteTurnBoundary(currentTurnId(bind), deliveryStampOf(bind));
      noteTurnOpeningPrincipal(bind);
      noteWorkResultReportOwed(bind);
      adoptWorkResultWrites(bind);
      clearStreamDropRetries();
    }),

    "model.requested": optional("delegation-settlement", (_event, ctx) => {
      const bind = ctx as unknown as BindableContext;
      noteStepDelivery(currentTurnId(bind), deliveryStampOf(bind));
    }),

    "task.started": optional("delegation-settlement", async (event, ctx) => {
      if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
      const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
      if (typeof ownSessionId !== "string" || ownSessionId.length === 0) return;
      const startedData = taskStartedData(event.data, event.scope?.turnId);
      const started = readTaskStarted(startedData);
      if (started === null) {
        noteUnreadableTaskEvent("task.started", startedData, ownSessionId);
        return;
      }
      await startTaskEdge(started, ownSessionId, ctx);
    }),

    "call.started": optional("delegation-settlement", async (event, ctx) => {
      if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
      const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
      if (typeof ownSessionId !== "string" || ownSessionId.length === 0) return;
      const continuedData = taskContinuedData(event.data, ctx.view, event.scope?.turnId);
      if (continuedData === undefined) return;
      const started = readTaskStarted(continuedData);
      if (started === null) {
        noteUnreadableTaskEvent("task.started", continuedData, ownSessionId);
        return;
      }
      await startTaskEdge(started, ownSessionId, ctx);
    }),

    "child.opened": optional("delegation-settlement", async (event, ctx) => {
      if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
      const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
      if (typeof ownSessionId !== "string" || ownSessionId.length === 0) return;
      const opened = readAgentStarted(childOpenedData(event.data, ctx.view, event.scope?.turnId));
      if (opened === null || opened.taskId === null) return;
      await noteAgentStarted(opened, ownSessionId);
    }),

    "task.ended": optional("delegation-settlement", async (event, ctx) => {
      if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
      const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
      if (typeof ownSessionId !== "string" || ownSessionId.length === 0) return;
      const endedData = taskEndedData(event.data, ctx.view, event.scope?.turnId);
      const settled = readTaskSettled(endedData);
      if (settled === null) {
        noteUnreadableTaskEvent("task.ended", endedData, ownSessionId);
        return;
      }
      const replyKey = settlementReplyKey((ctx as { position?: { line?: unknown } }).position);
      for (const callId of openTaskCalls(ctx.view, settled.taskId, settled.callId)) {
        // One call's failure must not leave the task's other open calls unsettled.
        await settleTaskEdge({ ...settled, callId }, ownSessionId, ctx, call(ctx.view, callId)?.output, replyKey).catch((err: unknown) => {
          console.warn(`[open-everywhere:work] task ${settled.taskId}: the task.ended settlement of call ${callId} failed: ${String(err).slice(0, 160)}`);
        });
      }
    }),

    "turn.settled": optional("delegation-settlement", async (event, ctx) => {
      switch (event.data.outcome) {
        case "completed":
          await flushDirtyTreeAtTurnEnd(ctx as unknown as MemoryPersistContext);
          return;
        case "failed":
          await auditWorkerTurnFailed(ctx, event.data.error);
          return;
        default:
          return;
      }
    }),

    "call.requested": optional("delegation-settlement", async (event, ctx) => {
      if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
      const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
      if (typeof ownSessionId !== "string" || ownSessionId.length === 0) return;
      const bind = ctx as unknown as BindableContext;
      const turnId = currentTurnId(bind);
      if (!isWorkSessionContext(bind)) {
        const readsToken = deliveryAttr(bind, OE_WORK_RESULT_READS_ATTR);
        const resultRequest = deliveryAttr(bind, OE_WORK_RESULT_ATTR);
        if (readsToken !== undefined && resultRequest !== undefined) {
          await spendWorkResultReads(bind, readsToken, resultRequest).catch(() => undefined);
        }
      }
      const actions = [requestedAction(event.data)];
      const validInput = event.data.inputError === undefined;
      if (validInput && actions.some((a) => a.kind === "subagent-call" || (a.kind === "tool-call" && DELEGATING_TOOLS.has(a.toolName)))) noteDelegationRequested(turnId);
      for (const action of actions) {
        const delegated = action.kind === "subagent-call" || (action.kind === "tool-call" && action.toolName === "agent");
        if (delegated && typeof action.callId === "string" && action.callId.length > 0 && isWorkSessionContext(bind)) {
          const open = workRequestsThisTurn(turnId);
          if (open.length > 0) {
            const message = action.input !== null && typeof action.input === "object" ? (action.input as Record<string, unknown>)["message"] : undefined;
            const join = claimWorkCall(turnId, message, deliveryAttr(bind, OE_WORK_REQUEST_ATTR));
            if (join.kind !== "joined") {
              noteDispatchAuthorityLost("call.requested", "", action.callId, ownSessionId, "work-request-unjoinable");
              continue;
            }
            const ownWorkToken = resolveOwnWindowToken(bind);
            const ownWorkBare = ownWorkToken === undefined ? undefined : (bareTokenFromEveContext(ownWorkToken) ?? ownWorkToken);
            const owned = await readWorkRequest(getOperationalStore(), deploymentOrg(), join.requestId).catch(() => undefined);
            if (owned === undefined || ownWorkBare === undefined || !isSameWorkSession(workTokenForSeat(owned.seatToken), ownWorkBare)) {
              noteDispatchAuthorityLost("call.requested", "", action.callId, ownSessionId, "work-request-unowned");
              continue;
            }
            try {
              await rememberDelegatedTaskWake(deploymentOrg(), ownSessionId, action.callId, join.requestId);
              await rememberWorkCall(getOperationalStore(), deploymentOrg(), ownSessionId, action.callId, join.requestId, new Date().toISOString());
            } catch {
              noteDispatchAuthorityLost("call.requested", "", action.callId, ownSessionId, "dispatch-wake-not-durable");
            }
            continue;
          }
        }
        if (delegated && typeof action.callId === "string" && action.callId.length > 0) {
          const settlement = settlementDispatchAuthorityThisTurn(turnId);
          const uningressedUnifiedTurn = isUnifiedWindowContext(bind) && uningressedTurn(turnId);
          const settlementTurn =
            uningressedUnifiedTurn && (settlement.kind !== "none" || taskWakeThisTurn(turnId) !== undefined);
          if (settlementTurn && settlement.kind !== "single") {
            noteDispatchAuthorityLost("call.requested", "", action.callId, ownSessionId, settlement.kind === "none" ? "settlement-turn-no-authority" : "settlement-turn-ambiguous-authority");
            continue;
          }
          const settlementAuthority = settlement.kind === "single" ? settlement.authority : undefined;
          const wakeId = settlementTurn
            ? settlementAuthority?.wakeId
            : addressedWakeThisTurn(turnId) ?? exactDispatchWakeThisTurn(turnId);
          if (wakeId !== undefined) {
            try {
              await rememberDelegatedTaskWake(deploymentOrg(), ownSessionId, action.callId, wakeId);
            } catch {
              noteDispatchAuthorityLost("call.requested", "", action.callId, ownSessionId, "dispatch-wake-not-durable");
              continue;
            }
          }
          else if (!isUnifiedWindowContext(bind)) {
            if (liveAuthIsAnotherPrincipal(bind)) {
              noteDispatchAuthorityLost("call.requested", "", action.callId, ownSessionId, "in-turn-principal-swap");
              continue;
            }
            const requester = requesterThisTurn(turnId);
            const nonMemberWake = (bind as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } } } }).session?.auth?.current?.attributes?.[OE_CHAT_NONMEMBER_ATTR] === "true";
            await rememberDelegatedTaskBinding(deploymentOrg(), ownSessionId, action.callId, bindFrom(bind), requester, nonMemberWake);
          }
          else {
            noteDispatchAuthorityLost("call.requested", "", action.callId, ownSessionId, "unified-turn-no-wake");
            continue;
          }
        }
      }
    }),

    "call.settled": optional("delegation-settlement", async (event, ctx) => {
      if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
      const result = delegationResultOf(ctx.view, event.data);
      const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
      if (typeof ownSessionId !== "string" || ownSessionId.length === 0) return;

      const failure = readDelegationFailure(result);
      if (failure !== null) {
        await noteDelegationFailure(failure, "", ownSessionId, currentTurnId(ctx as unknown as BindableContext), "result", "result");
      }

      const taskCall = taskCallSettledData(event.data, ctx.view, event.scope?.turnId);
      if (taskCall === undefined) {
        if (result !== undefined) await flushSettledMemory(ctx as unknown as MemoryPersistContext, "delegation-returned");
        return;
      }
      const settled = readTaskSettled(taskCall);
      if (settled === null) noteUnreadableTaskEvent("call.settled", taskCall, ownSessionId);
      else await settleTaskEdge(settled, ownSessionId, ctx, settledCallOutput(ctx.view, event.data), settlementReplyKey((ctx as { position?: { line?: unknown } }).position));
    }),
  },
});

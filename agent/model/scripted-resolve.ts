import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";
import { runs, type SessionView } from "eve/events";
import { onVercel } from "@open-everywhere/core/agent/access/platform.js";
import { currentTurnId, isSubagentChildContext, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { isWorkSessionContext } from "@open-everywhere/core/agent/access/work-session.js";
import { parseWorkCancels, parseWorkRequests } from "@open-everywhere/core/agent/channels/work.js";
import { classifySessionId } from "@open-everywhere/core/agent/channels/window-key.js";
import { NO_REPLY_SENTINEL, REDRIVE_TRIGGER_ID_PREFIX } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { stampModelCall } from "@open-everywhere/core/agent/model/model-stamp.js";
import { noteWakeAttachmentsFrom } from "@open-everywhere/core/agent/access/worker-continuation.js";
import { boundaryStopReply, isTurnEndingTier, noteTurnStep, reportStepBoundary } from "@open-everywhere/core/agent/model/step-boundary.js";
import { withEmptyStopReissue } from "@open-everywhere/core/agent/model/empty-stop-reissue.js";
import { withWorkerToolsetEvidenceModel } from "@open-everywhere/core/agent/model/worker-toolset-evidence.js";
import { withSeatToolCut } from "@open-everywhere/core/agent/model/seat-tool-cut.js";
import { withWorkSessionCancelFence } from "@open-everywhere/core/agent/access/work-cancel-fence.js";
import type { RoutableModel } from "@open-everywhere/core/agent/model/routing.js";
import {
  compactionSummaryResponse,
  isCompactionSummaryRequest,
  isEmptyResponseReissue,
  ANY_SESSION,
  SCRIPTED_MODEL_VALVE,
  SCRIPTED_MODEL_ID,
  claimWakeOwner,
  clearIncompleteParentTurn,
  fillReportWakePlaceholder,
  fillTaskPlaceholder,
  fillWakePlaceholder,
  holdScriptedCall,
  incompleteParentTurnFor,
  isForeignWakeStraggler,
  noteForeignWakeSilence,
  noteWorkSessionCall,
  noteStaleHoldExpiry,
  nextScriptedRequestSequence,
  scriptedModelArmed,
  scriptedRegistrationSeq,
  scriptedStore,
  staleTurnParkMs,
  taskIdFromPrompt,
  taskResultDeliveryCount,
  unresolvedReportWakePlaceholderFault,
  unresolvedTaskPlaceholderFault,
  unresolvedWakePlaceholderFault,
  legWakeIdFromPrompt,
  wakeIdFromPrompt,
  wakeIdFromReport,
  wakeOwnerSeq,
  type RecordedRequest,
  type ResolveObservation,
  type ScriptedEntry,
  type ScriptedRole,
  type ScriptedStep,
} from "./scripted-model.js";

export function frameStepIndex(ctx: unknown, turnId: string | undefined): number {
  if (turnId === undefined) return 0;
  const view = (ctx as { view?: unknown } | undefined)?.view;
  if (view === null || typeof view !== "object") return 0;
  let own: readonly { readonly status: string }[];
  try {
    own = runs(view as SessionView, { turnId });
  } catch {
    return 0;
  }
  return own.some((run) => run.status !== "settled") ? own.length - 1 : own.length;
}

export function frameFacts(ctx: unknown): { readonly turnId: string | undefined; readonly stepIndex: number } {
  let turnId: string | undefined;
  try {
    turnId = currentTurnId(ctx as BindableContext);
  } catch {
    turnId = undefined;
  }
  return { turnId, stepIndex: frameStepIndex(ctx, turnId) };
}

export async function scriptedModelFor(event: unknown, ctx: unknown): Promise<ReturnType<typeof mockModel> | null> {
  const model = await scriptedModelForStep(event, ctx);
  return model === null
    ? null
    : (withSeatToolCut(withWorkSessionCancelFence(withEmptyStopReissue(withWorkerToolsetEvidenceModel(model as unknown as RoutableModel, ctx)))) as unknown as ReturnType<typeof mockModel>);
}

async function scriptedModelForStep(event: unknown, ctx: unknown): Promise<ReturnType<typeof mockModel> | null> {
  if (!scriptedModelArmed()) return null;
  if (onVercel()) {
    throw new Error(
      `open-everywhere: the ${SCRIPTED_MODEL_VALVE} test valve is a local test seam — refusing on Vercel. ` +
        "A hosted deployment must never answer from a scripted model.",
    );
  }

  const bindable = ctx as BindableContext;

  stampModelCall(SCRIPTED_MODEL_ID);

  const boundary = await noteTurnStep(bindable, event);
  await noteWakeAttachmentsFrom(ctx);
  if (isTurnEndingTier(boundary.tier)) {
    reportStepBoundary(bindable, boundary);
    if (isWorkSessionContext(bindable)) {
      const wSession = (ctx as { session?: { id?: unknown } } | undefined)?.session?.id;
      const wId = typeof wSession === "string" ? wSession : undefined;
      const wStore = scriptedStore();
      const named = (wId !== undefined ? wStore.get(wId) : undefined)?.script.work !== undefined || wStore.get(ANY_SESSION)?.script.work !== undefined;
      if (!named) noteWorkSessionCall({ sessionId: wId, turnId: frameFacts(ctx).turnId });
    }
    return mockModel({
      modelId: SCRIPTED_MODEL_ID,
      provider: "open-everywhere-scripted",
      respond: () => ({ text: boundaryStopReply(boundary) }),
    });
  }
  if (boundary.tier === "soft") reportStepBoundary(bindable, boundary);

  const rawSession = (ctx as { session?: { id?: unknown } } | undefined)?.session;
  const sessionId = typeof rawSession?.id === "string" ? rawSession.id : undefined;
  const store = scriptedStore();
  const ownEntry = sessionId !== undefined ? store.get(sessionId) : undefined;
  const usedFallback = ownEntry === undefined;
  if (isWorkSessionContext(bindable)) {
    const named = ownEntry?.script.work !== undefined ? ownEntry : store.get(ANY_SESSION)?.script.work !== undefined ? store.get(ANY_SESSION) : undefined;
    if (named === undefined) {
      noteWorkSessionCall({ sessionId, turnId: frameFacts(ctx).turnId });
      return defaultWorkStepModel();
    }
  }
  const entry = ownEntry ?? store.get(ANY_SESSION);
  if (entry === undefined) {
    throw new Error(
      `open-everywhere: the ${SCRIPTED_MODEL_VALVE} test valve is armed but no script is registered for session ` +
        `"${String(sessionId)}" (and none under "${ANY_SESSION}"). Refusing to fall through to the ` +
        "gateway — an armed process is a test process and must never buy inference.",
    );
  }
  const seqAtResolve = scriptedRegistrationSeq();

  const { turnId, stepIndex } = frameFacts(ctx);
  const role: ScriptedRole = isSubagentChildContext(bindable) ? "child" : isWorkSessionContext(bindable) ? "work" : "parent";

  const observation: ResolveObservation = {
    role,
    sessionId,
    turnId,
    stepIndex,
    pid: process.pid,
    channelKind: typeof bindable?.channel?.kind === "string" ? bindable.channel.kind : undefined,
    classifiedKind: classifySessionId(bindable?.channel?.continuationToken).kind,
    hasSessionParent: bindable?.session?.parent !== undefined,
  };

  if (usedFallback && role === "parent" && sessionId !== undefined && turnId !== undefined) {
    const incomplete = incompleteParentTurnFor(sessionId);
    if (incomplete !== undefined && incomplete.turnId === turnId) {
      clearIncompleteParentTurn(sessionId);
      const fault =
        `stray call (OPE-995): session "${sessionId}" turn "${turnId}" is a straggler from a script ` +
        `disposed after serving only ${incomplete.servedThrough + 1}/${incomplete.totalSteps} of its ` +
        `parent steps (registered at ${incomplete.registeredAt}). Refusing to answer it from the ` +
        `now-live "${ANY_SESSION}" entry (registered at ${entry.registeredAt}) — that script belongs to ` +
        "a different registration and must not be spent on this turn.";
      observation.fault = fault;
      entry.resolves.push(observation);
      return mockModel({
        modelId: SCRIPTED_MODEL_ID,
        provider: "open-everywhere-scripted",
        respond: async (request) => {
          entry.requests.push({
            sequence: nextScriptedRequestSequence(),
            role,
            sessionId,
            turnId,
            stepIndex: -1,
            pid: process.pid,
            ...promptShapeFields(request),
            fault,
          });
          return { text: "scripted-model fault: see the record" };
        },
      });
    }
  }

  entry.resolves.push(observation);
  return buildStepModel(entry, observation, seqAtResolve, usedFallback);
}

function defaultWorkStepModel(): ReturnType<typeof mockModel> {
  return signalAwareMockModel({
    respond: async (request) => {
      const prompt = request.messages.map((m) => m.text).join("\n");
      const cancelledCount = request.toolResults.filter((r) => r.name === "eve__task_cancel").length;
      const cancel = parseWorkCancels(prompt)[cancelledCount];
      // The work session's model calls only what its model call offers, as a real model does. A
      // work session that loses `agent` or `eve__task_cancel` to the model-call cut then stalls
      // here, and every forward flow of the integration tier goes red.
      const unoffered = (name: string) => !request.tools.some((t) => t.name === name);
      if (cancel !== undefined) {
        if (unoffered("eve__task_cancel")) return workStepFault("eve__task_cancel");
        return { toolCalls: [{ name: "eve__task_cancel", input: { taskId: cancel.taskId }, id: `work-${cancel.cancelId}` }] };
      }
      const blocks = parseWorkRequests(prompt);
      const results = request.toolResults.filter((r) => r.name === "agent");
      const resultsFor = (requestId: string) => results.filter((r) => r.id === workCallId(requestId) || r.id.startsWith(`${workCallId(requestId)}-`));
      for (let i = blocks.length - 1; i >= 0; i--) {
        const next = blocks[i]!;
        const tried = resultsFor(next.requestId);
        if (tried.some((r) => !r.isError)) continue;
        const delivered = blocks.filter((b) => b.requestId === next.requestId).length;
        if (tried.length >= delivered) continue;
        if (unoffered("agent")) return workStepFault("agent");
        return { toolCalls: [{ name: "agent", input: { message: next.brief, ...(next.taskId !== undefined ? { taskId: next.taskId } : {}) }, id: `${workCallId(next.requestId)}-${tried.length + 1}` }] };
      }
      return { text: "Started the forwarded job; its result goes back to the conversation when it settles." };
    },
  });
}

function workStepFault(name: string): MockModelResponse {
  console.error(`[open-everywhere:scripted-model] the work session's model call does not offer \`${name}\`, so the scripted work step cannot call it`);
  return { text: `scripted-model fault: the work session is not offered ${name}` };
}

function workCallId(requestId: string): string {
  return `work-${requestId}`;
}

function snapshotSchema(schema: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(schema)) as unknown;
  } catch {
    return schema;
  }
}

function promptShapeFields(
  request: Pick<MockModelRequest, "tools" | "toolResults" | "messages">,
): Pick<RecordedRequest, "tools" | "toolDefinitions" | "toolResults" | "messages"> {
  return {
    tools: request.tools.map((t) => t.name),
    toolDefinitions: request.tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.inputSchema !== undefined ? { inputSchema: snapshotSchema(t.inputSchema) } : {}),
    })),
    toolResults: request.toolResults.map((r) => ({ id: r.id, name: r.name, isError: r.isError, output: r.output })),
    messages: request.messages.map((m) => ({ role: m.role, text: m.text })),
  };
}

function stepIndexFor(arm: readonly ScriptedStep[], answered: number): number | string {
  let before = 0;
  for (let i = 0; i < arm.length; i++) {
    if (before === answered) return i;
    const calls = arm[i].calls?.length ?? 0;
    before += calls > 0 ? calls : 1;
  }
  if (before === answered) return `script exhausted: all ${arm.length} step(s) already served`;
  return `unmappable answered-step count ${answered} (script accounts for ${before})`;
}

function promptIsRedriveCorrection(messages: readonly { readonly text: string }[]): boolean {
  const prompt = messages.map((m) => m.text).join("\n");
  const lastEnvelope = prompt.lastIndexOf("<wake ");
  if (lastEnvelope === -1) return false;
  for (const tag of prompt.slice(lastEnvelope).matchAll(/<message\b[^>]*>/g)) {
    if (tag[0].includes('trigger="true"') && tag[0].includes(`id="${REDRIVE_TRIGGER_ID_PREFIX}`)) return true;
  }
  return false;
}

interface PromptFacts {
  readonly redriveCorrection: boolean;
  readonly wakeId: string | undefined;
  readonly legWakeId: string | undefined;
  readonly taskResultDeliveries: number;
}

interface StepVerdict {
  readonly fault?: string;
  readonly served: number;
  readonly step: ScriptedStep;
  readonly stale: boolean;
  readonly redriveSilence?: boolean;
  readonly foreignWakeSilence?: boolean;
}

function serveStep(
  entry: ScriptedEntry,
  at: ResolveObservation,
  toolResultCount: number,
  prompt: PromptFacts,
  wildcard: boolean,
): StepVerdict {
  const arm = at.role === "child" ? entry.script.child : at.role === "work" ? entry.script.work : entry.script.parent;
  const baselineKey = `${at.sessionId ?? "?"}/${at.turnId ?? "?"}/${at.role}`;
  const baseline = (entry.baselines[baselineKey] ??= toolResultCount);
  const deliveryBaseline = (entry.deliveryBaselines[baselineKey] ??= prompt.taskResultDeliveries);
  const nothing: ScriptedStep = { say: "scripted-model fault: see the record" };

  if (arm === undefined) return { fault: "no child script registered", served: -1, step: nothing, stale: false };
  const answered = toolResultCount - baseline + (prompt.taskResultDeliveries - deliveryBaseline);
  const index = stepIndexFor(arm, answered);
  if (typeof index === "string") return { fault: index, served: -1, step: nothing, stale: false };

  const candidate = arm[index];
  const turnKey = at.turnId ?? "?";

  const wakeOwner = prompt.legWakeId === undefined ? undefined : wakeOwnerSeq(prompt.legWakeId);
  if (
    isForeignWakeStraggler({
      role: at.role,
      wildcard,
      callBearing: candidate.calls !== undefined,
      absorbsStragglers: entry.absorbsStragglers,
      wakeId: prompt.legWakeId,
      ownerSeq: wakeOwner,
      seq: entry.seq,
    })
  ) {
    noteForeignWakeSilence({
      sessionId: String(at.sessionId),
      turnId: turnKey,
      wakeId: String(prompt.legWakeId),
      ownerSeq: Number(wakeOwner),
      registeredAt: entry.registeredAt,
    });
    return { served: -1, step: { say: NO_REPLY_SENTINEL }, stale: false, foreignWakeSilence: true };
  }

  const firstCallTurn = entry.firstCallTurnByRole[at.role];
  if (candidate.calls !== undefined && firstCallTurn !== undefined && firstCallTurn !== turnKey) {
    const firstCallWake = entry.firstCallWakeByRole[at.role];
    if (prompt.redriveCorrection && firstCallWake !== undefined && prompt.wakeId === firstCallWake) {
      return { served: -1, step: { say: NO_REPLY_SENTINEL }, stale: false, redriveSilence: true };
    }
    return {
      fault:
        `stale script: role "${at.role}" already served a call-bearing step for turn "${firstCallTurn}"; ` +
        `turn "${turnKey}" is a DIFFERENT turn hitting the same still-registered entry — dispose and ` +
        "re-register a fresh script per turn (see the delegation choreography seam in harness.ts).",
      served: -1,
      step: nothing,
      stale: true,
    };
  }
  if (candidate.calls !== undefined && firstCallTurn === undefined) {
    entry.firstCallTurnByRole[at.role] = turnKey;
    if (prompt.wakeId !== undefined) entry.firstCallWakeByRole[at.role] = prompt.wakeId;
  }
  if (at.role === "parent" && prompt.legWakeId !== undefined) claimWakeOwner(prompt.legWakeId, entry.seq);
  return { served: index, step: candidate, stale: false };
}

async function awaitScriptSwap(
  current: ScriptedEntry,
  sessionId: string | undefined,
  seqAtResolve: number,
): Promise<{ readonly entry?: ScriptedEntry; readonly expired: boolean; readonly viaWildcard: boolean }> {
  if (sessionId === undefined || sessionId === ANY_SESSION) return { expired: false, viaWildcard: false };
  const store = scriptedStore();
  const deadline = Date.now() + staleTurnParkMs();
  for (;;) {
    const keyed = store.get(sessionId);
    if (keyed !== undefined && keyed !== current) return { entry: keyed, expired: false, viaWildcard: false };
    const wildcard = store.get(ANY_SESSION);
    if (wildcard !== undefined && wildcard !== current && wildcard.epoch === current.epoch && wildcard.seq > seqAtResolve) {
      return { entry: wildcard, expired: false, viaWildcard: true };
    }
    let stillRegistered = false;
    for (const live of store.values()) if (live === current) stillRegistered = true;
    if (!stillRegistered) return { expired: false, viaWildcard: false };
    if (Date.now() >= deadline) return { expired: true, viaWildcard: false };
    await new Promise((r) => setTimeout(r, 100));
  }
}

function buildStepModel(
  entry: ScriptedEntry,
  at: ResolveObservation,
  seqAtResolve: number,
  usedFallback: boolean,
): ReturnType<typeof mockModel> {
  return signalAwareMockModel({
    respond: async (request, signal) => {
      let target = entry;
      let observation = at;
      const promptWakeId = wakeIdFromPrompt(request.messages);
      const promptFacts: PromptFacts = {
        redriveCorrection: promptIsRedriveCorrection(request.messages),
        wakeId: promptWakeId,
        legWakeId: legWakeIdFromPrompt(request.messages),
        taskResultDeliveries: taskResultDeliveryCount(request.messages),
      };
      let verdict = serveStep(target, observation, request.toolResults.length, promptFacts, usedFallback);

      if (verdict.stale) {
        const swap = await awaitScriptSwap(target, observation.sessionId, seqAtResolve);
        if (swap.expired) {
          noteStaleHoldExpiry({
            sessionId: String(observation.sessionId),
            heldTurnId: String(observation.turnId),
            scriptTurnId: String(target.firstCallTurnByRole[observation.role]),
            registeredAt: target.registeredAt,
            parkMs: staleTurnParkMs(),
          });
        }
        const next = swap.entry;
        if (next !== undefined) {
          const pushed = target.resolves.indexOf(observation);
          if (pushed !== -1) target.resolves.splice(pushed, 1);
          observation = { ...observation };
          next.resolves.push(observation);
          target = next;
          verdict = serveStep(target, observation, request.toolResults.length, promptFacts, swap.viaWildcard);
        }
      }
      const { fault: stepFault, served, redriveSilence, foreignWakeSilence } = verdict;
      const emptyReissue = isEmptyResponseReissue(request.messages);
      const step = emptyReissue && verdict.step.onEmptyReissue !== undefined ? verdict.step.onEmptyReissue : verdict.step;

      const promptTaskId = taskIdFromPrompt(request.messages);
      const filled = (step.calls ?? []).map((c) => {
        const envelope = fillWakePlaceholder(c.input, promptWakeId);
        const report = fillReportWakePlaceholder(envelope.value, wakeIdFromReport(request.messages));
        const task = fillTaskPlaceholder(report.value, promptTaskId);
        return {
          call: c,
          value: task.value,
          unresolved: envelope.unresolved || report.unresolved || task.unresolved,
          reportUnresolved: report.unresolved,
          taskUnresolved: task.unresolved,
        };
      });
      const unresolvedCall = filled.find((f) => f.unresolved);
      const saidReport = fillReportWakePlaceholder(step.say, wakeIdFromReport(request.messages));
      const wakeFault = unresolvedCall
        ? (unresolvedCall.taskUnresolved
            ? unresolvedTaskPlaceholderFault
            : unresolvedCall.reportUnresolved
              ? unresolvedReportWakePlaceholderFault
              : unresolvedWakePlaceholderFault)(unresolvedCall.call.tool)
        : saidReport.unresolved
          ? unresolvedReportWakePlaceholderFault("say")
          : undefined;
      const fault = stepFault ?? wakeFault;

      observation.fault = fault;

      target.requests.push({
        sequence: nextScriptedRequestSequence(),
        role: observation.role,
        sessionId: observation.sessionId,
        turnId: observation.turnId,
        stepIndex: served,
        pid: process.pid,
        ...promptShapeFields(request),
        ...(fault !== undefined ? { fault } : {}),
        ...(redriveSilence === true ? { redriveSilence: true } : {}),
        ...(foreignWakeSilence === true ? { foreignWakeSilence: true } : {}),
        ...(emptyReissue ? { emptyReissue: true } : {}),
      });

      await holdScriptedCall(target.holds, step, signal);

      if (wakeFault !== undefined) return { text: wakeFault };

      if (step.failsForGood === true) throw Object.assign(new Error("scripted model: a terminal model failure (failsForGood)"), { statusCode: 400 });

      if (step.say === undefined && step.calls === undefined) return { text: "", ...(step.usage !== undefined ? { usage: step.usage } : {}) };
      return {
        ...(step.say !== undefined ? { text: typeof saidReport.value === "string" ? saidReport.value : step.say } : {}),
        ...(step.calls !== undefined
          ? { toolCalls: filled.map((f) => ({ name: f.call.tool, ...(f.call.input !== undefined ? { input: f.value } : {}), ...(f.call.id !== undefined ? { id: f.call.id } : {}) })) }
          : {}),
        ...(step.usage !== undefined ? { usage: step.usage } : {}),
      };
    },
  });
}

export function signalAwareMockModel(opts: {
  readonly respond: (request: MockModelRequest, signal: AbortSignal | undefined) => Promise<MockModelResponse>;
}): ReturnType<typeof mockModel> {
  let callSignal: AbortSignal | undefined;
  const model = mockModel({
    modelId: SCRIPTED_MODEL_ID,
    provider: "open-everywhere-scripted",
    respond: (request) => (isCompactionSummaryRequest(request) ? compactionSummaryResponse(request) : opts.respond(request, callSignal)),
  });
  const calls = callableModel(model);
  const doStream = calls.doStream.bind(calls);
  const doGenerate = calls.doGenerate.bind(calls);
  calls.doStream = (options) => {
    callSignal = options.abortSignal;
    return doStream(options);
  };
  calls.doGenerate = (options) => {
    callSignal = options.abortSignal;
    return doGenerate(options);
  };
  return model;
}

interface CallableModel {
  doStream: (options: { readonly abortSignal?: AbortSignal }) => unknown;
  doGenerate: (options: { readonly abortSignal?: AbortSignal }) => unknown;
}

function callableModel(model: unknown): CallableModel {
  const m = model as Partial<CallableModel> | null;
  if (typeof m !== "object" || m === null || typeof m.doStream !== "function" || typeof m.doGenerate !== "function") {
    throw new Error("open-everywhere: eve's mockModel no longer returns a model object with doStream/doGenerate (OPE-2310).");
  }
  return m as CallableModel;
}

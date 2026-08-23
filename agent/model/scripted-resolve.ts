import { mockModel, type MockModelRequest } from "eve/evals";
import { onVercel } from "@open-everywhere/core/agent/access/platform.js";
import { isSubagentChildContext, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { classifySessionId } from "@open-everywhere/core/agent/channels/window-key.js";
import { stampModelCall } from "@open-everywhere/core/agent/model/model-stamp.js";
import { backstopReply, noteTurnStep, reportStepBoundary } from "@open-everywhere/core/agent/model/step-boundary.js";
import { suppressAgentsListing } from "@open-everywhere/core/agent/access/worker-continuation.js";
import {
  ANY_SESSION,
  SCRIPTED_MODEL_ENV,
  SCRIPTED_MODEL_ID,
  clearIncompleteParentTurn,
  incompleteParentTurnFor,
  noteStaleHoldExpiry,
  scriptedModelArmed,
  scriptedRegistrationSeq,
  scriptedStore,
  staleTurnParkMs,
  type RecordedRequest,
  type ResolveObservation,
  type ScriptedEntry,
  type ScriptedRole,
  type ScriptedStep,
} from "./scripted-model.js";

function eventData(event: unknown): { turnId?: string; stepIndex?: number } {
  const data = (event as { data?: { turnId?: unknown; stepIndex?: unknown } } | undefined)?.data;
  return {
    turnId: typeof data?.turnId === "string" ? data.turnId : undefined,
    stepIndex: typeof data?.stepIndex === "number" ? data.stepIndex : undefined,
  };
}

function safeEcho(event: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(event ?? null));
  } catch {
    return "unserializable";
  }
}

export function scriptedModelFor(event: unknown, ctx: unknown): ReturnType<typeof mockModel> | null {
  if (!scriptedModelArmed()) return null;
  if (onVercel()) {
    throw new Error(
      `open-everywhere: ${SCRIPTED_MODEL_ENV} is a local test flag — refusing on Vercel. ` +
        "A hosted deployment must never answer from a scripted model.",
    );
  }

  const bindable = ctx as BindableContext;

  stampModelCall(SCRIPTED_MODEL_ID);

  suppressAgentsListing((ctx as { messages?: unknown } | undefined)?.messages);
  const boundary = noteTurnStep(bindable, event);
  if (boundary.tier === "hard") {
    reportStepBoundary(bindable, boundary);
    return mockModel({
      modelId: SCRIPTED_MODEL_ID,
      provider: "open-everywhere-scripted",
      respond: () => ({ text: backstopReply(boundary) }),
    });
  }
  if (boundary.tier === "soft") reportStepBoundary(bindable, boundary);

  const rawSession = (ctx as { session?: { id?: unknown } } | undefined)?.session;
  const sessionId = typeof rawSession?.id === "string" ? rawSession.id : undefined;
  const store = scriptedStore();
  const ownEntry = sessionId !== undefined ? store.get(sessionId) : undefined;
  const usedFallback = ownEntry === undefined;
  const entry = ownEntry ?? store.get(ANY_SESSION);
  if (entry === undefined) {
    throw new Error(
      `open-everywhere: ${SCRIPTED_MODEL_ENV}=1 but no script is registered for session ` +
        `"${String(sessionId)}" (and none under "${ANY_SESSION}"). Refusing to fall through to the ` +
        "gateway — an armed process is a test process and must never buy inference.",
    );
  }
  const seqAtResolve = scriptedRegistrationSeq();

  const { turnId, stepIndex } = eventData(event);
  const role: ScriptedRole = isSubagentChildContext(bindable) ? "child" : "parent";

  const observation: ResolveObservation = {
    role,
    sessionId,
    turnId,
    stepIndex: stepIndex ?? 0,
    pid: process.pid,
    channelKind: typeof bindable?.channel?.kind === "string" ? bindable.channel.kind : undefined,
    classifiedKind: classifySessionId(bindable?.channel?.continuationToken).kind,
    hasSessionParent: bindable?.session?.parent !== undefined,
    eventEcho: safeEcho(event),
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
  return buildStepModel(entry, observation, seqAtResolve);
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
    before += arm[i].calls?.length ?? 0;
  }
  if (before === answered) return `script exhausted: all ${arm.length} step(s) already served`;
  return `unmappable tool-result count ${answered} (script emits ${before} call(s) in total)`;
}

interface StepVerdict {
  readonly fault?: string;
  readonly served: number;
  readonly step: ScriptedStep;
  readonly stale: boolean;
}

function serveStep(entry: ScriptedEntry, at: ResolveObservation, toolResultCount: number): StepVerdict {
  const arm = at.role === "child" ? entry.script.child : entry.script.parent;
  const baselineKey = `${at.sessionId ?? "?"}/${at.turnId ?? "?"}/${at.role}`;
  const baseline = (entry.baselines[baselineKey] ??= toolResultCount);
  const nothing: ScriptedStep = { say: "scripted-model fault: see the record" };

  if (arm === undefined) return { fault: "no child script registered", served: -1, step: nothing, stale: false };
  const index = stepIndexFor(arm, toolResultCount - baseline);
  if (typeof index === "string") return { fault: index, served: -1, step: nothing, stale: false };

  const candidate = arm[index];
  const turnKey = at.turnId ?? "?";
  const firstCallTurn = entry.firstCallTurnByRole[at.role];
  if (candidate.calls !== undefined && firstCallTurn !== undefined && firstCallTurn !== turnKey) {
    return {
      fault:
        `stale script: role "${at.role}" already served a call-bearing step for turn "${firstCallTurn}"; ` +
        `turn "${turnKey}" is a DIFFERENT turn hitting the same still-registered entry — dispose and ` +
        "re-register a fresh script per turn (see harness.ts's awaitTaskSettlement doc).",
      served: -1,
      step: nothing,
      stale: true,
    };
  }
  if (candidate.calls !== undefined && firstCallTurn === undefined) entry.firstCallTurnByRole[at.role] = turnKey;
  return { served: index, step: candidate, stale: false };
}

async function awaitScriptSwap(
  current: ScriptedEntry,
  sessionId: string | undefined,
  seqAtResolve: number,
): Promise<{ readonly entry?: ScriptedEntry; readonly expired: boolean }> {
  if (sessionId === undefined || sessionId === ANY_SESSION) return { expired: false };
  const store = scriptedStore();
  const deadline = Date.now() + staleTurnParkMs();
  for (;;) {
    const keyed = store.get(sessionId);
    if (keyed !== undefined && keyed !== current) return { entry: keyed, expired: false };
    const wildcard = store.get(ANY_SESSION);
    if (wildcard !== undefined && wildcard !== current && wildcard.epoch === current.epoch && wildcard.seq > seqAtResolve) {
      return { entry: wildcard, expired: false };
    }
    let stillRegistered = false;
    for (const live of store.values()) if (live === current) stillRegistered = true;
    if (!stillRegistered) return { expired: false };
    if (Date.now() >= deadline) return { expired: true };
    await new Promise((r) => setTimeout(r, 100));
  }
}

function buildStepModel(entry: ScriptedEntry, at: ResolveObservation, seqAtResolve: number): ReturnType<typeof mockModel> {
  return mockModel({
    modelId: SCRIPTED_MODEL_ID,
    provider: "open-everywhere-scripted",
    respond: async (request) => {
      let target = entry;
      let observation = at;
      let verdict = serveStep(target, observation, request.toolResults.length);

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
          verdict = serveStep(target, observation, request.toolResults.length);
        }
      }
      const { fault, served, step } = verdict;

      observation.fault = fault;

      target.requests.push({
        role: observation.role,
        sessionId: observation.sessionId,
        turnId: observation.turnId,
        stepIndex: served,
        pid: process.pid,
        ...promptShapeFields(request),
        ...(fault !== undefined ? { fault } : {}),
      });

      if (typeof step.delayMs === "number" && step.delayMs > 0) {
        const deadline = Date.now() + step.delayMs;
        while (!target.holds.released && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        if (target.holds.released) target.holds.cutShort += 1;
      }

      return {
        ...(step.say !== undefined ? { text: step.say } : {}),
        ...(step.calls !== undefined
          ? { toolCalls: step.calls.map((c) => ({ name: c.tool, ...(c.input !== undefined ? { input: c.input } : {}), ...(c.id !== undefined ? { id: c.id } : {}) })) }
          : {}),
        ...(step.usage !== undefined ? { usage: step.usage } : {}),
      };
    },
  });
}

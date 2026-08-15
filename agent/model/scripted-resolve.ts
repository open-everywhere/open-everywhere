import { mockModel } from "eve/evals";
import { onVercel } from "@open-everywhere/core/agent/access/platform.js";
import { isSubagentChildContext, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { classifySessionId } from "@open-everywhere/core/agent/channels/window-key.js";
import { stampModelCall } from "@open-everywhere/core/agent/model/model-stamp.js";
import { backstopReply, noteTurnStep, reportStepBoundary } from "@open-everywhere/core/agent/model/step-boundary.js";
import {
  ANY_SESSION,
  SCRIPTED_MODEL_ENV,
  SCRIPTED_MODEL_ID,
  scriptedModelArmed,
  scriptedStore,
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
  const entry = (sessionId !== undefined ? store.get(sessionId) : undefined) ?? store.get(ANY_SESSION);
  if (entry === undefined) {
    throw new Error(
      `open-everywhere: ${SCRIPTED_MODEL_ENV}=1 but no script is registered for session ` +
        `"${String(sessionId)}" (and none under "${ANY_SESSION}"). Refusing to fall through to the ` +
        "gateway — an armed process is a test process and must never buy inference.",
    );
  }

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
  entry.resolves.push(observation);

  return buildStepModel(entry, observation);
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

function buildStepModel(entry: ScriptedEntry, at: ResolveObservation): ReturnType<typeof mockModel> {
  return mockModel({
    modelId: SCRIPTED_MODEL_ID,
    provider: "open-everywhere-scripted",
    respond: (request) => {
      const arm = at.role === "child" ? entry.script.child : entry.script.parent;
      const baselineKey = `${at.sessionId ?? "?"}/${at.turnId ?? "?"}/${at.role}`;
      const baseline = (entry.baselines[baselineKey] ??= request.toolResults.length);

      let fault: string | undefined;
      let served = -1;
      let step: ScriptedStep = { say: "scripted-model fault: see the record" };
      if (arm === undefined) {
        fault = "no child script registered";
      } else {
        const index = stepIndexFor(arm, request.toolResults.length - baseline);
        if (typeof index === "string") fault = index;
        else {
          served = index;
          step = arm[index];
        }
      }

      entry.requests.push({
        role: at.role,
        sessionId: at.sessionId,
        turnId: at.turnId,
        stepIndex: served,
        pid: process.pid,
        tools: request.tools.map((t) => t.name),
        toolResults: request.toolResults.map((r) => ({ name: r.name, isError: r.isError, output: r.output })),
        messages: request.messages.map((m) => ({ role: m.role, text: m.text })),
        ...(fault !== undefined ? { fault } : {}),
      });

      return {
        ...(step.say !== undefined ? { text: step.say } : {}),
        ...(step.calls !== undefined
          ? { toolCalls: step.calls.map((c) => ({ name: c.tool, ...(c.input !== undefined ? { input: c.input } : {}), ...(c.id !== undefined ? { id: c.id } : {}) })) }
          : {}),
      };
    },
  });
}

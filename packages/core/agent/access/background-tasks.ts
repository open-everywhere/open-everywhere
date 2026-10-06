export const TASK_TOOL_NAMES: readonly string[] = ["task_wait", "task_cancel"];

export const TASK_PARENT_TOOL_NAMES: readonly string[] = ["task_wait", "task_cancel"];

export const TERMINAL_TASK_STATUSES: readonly string[] = ["completed", "failed", "cancelled"];

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const TASK_KINDS: ReadonlySet<string> = new Set(["agent", "tool"]);

export type TaskStarted = {
  readonly taskId: string;
  readonly callId: string;
  readonly turnId: string;
  readonly kind: "agent" | "tool";
  readonly tool: string;
};

export function readTaskStarted(data: unknown): TaskStarted | null {
  try {
    const d = data as { callId?: unknown; kind?: unknown; name?: unknown; taskId?: unknown; turnId?: unknown } | null;
    if (d === null || typeof d !== "object") return null;
    const taskId = d.taskId;
    if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) return null;
    const callId = d.callId;
    if (typeof callId !== "string" || callId.length === 0) return null;
    const kind = d.kind;
    if (typeof kind !== "string" || !TASK_KINDS.has(kind)) return null;
    return {
      taskId,
      callId,
      turnId: typeof d.turnId === "string" ? d.turnId : "",
      kind: kind as "agent" | "tool",
      tool: typeof d.name === "string" ? d.name : "",
    };
  } catch {
    return null;
  }
}

export type TaskSettled = {
  readonly taskId: string;
  readonly callId: string;
  readonly turnId: string;
  readonly status: string;
  readonly kind: "agent" | "tool" | null;
  readonly tool: string;
  readonly cancelReason: string;
  readonly errorText: string;
};

export function readTaskSettled(data: unknown): TaskSettled | null {
  try {
    const d = data as
      | {
          callId?: unknown;
          cancel?: { reason?: unknown } | null;
          error?: { message?: unknown } | null;
          kind?: unknown;
          name?: unknown;
          status?: unknown;
          taskId?: unknown;
          turnId?: unknown;
        }
      | null;
    if (d === null || typeof d !== "object") return null;
    const taskId = d.taskId;
    if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) return null;
    const callId = d.callId;
    if (typeof callId !== "string" || callId.length === 0) return null;
    const status = d.status;
    if (typeof status !== "string" || !TERMINAL_TASK_STATUSES.includes(status)) return null;
    const kind = typeof d.kind === "string" && TASK_KINDS.has(d.kind) ? (d.kind as "agent" | "tool") : null;
    const reason = d.cancel?.reason;
    const message = d.error?.message;
    return {
      taskId,
      callId,
      turnId: typeof d.turnId === "string" ? d.turnId : "",
      status,
      kind,
      tool: typeof d.name === "string" ? d.name : "",
      cancelReason: typeof reason === "string" ? reason : "",
      errorText: typeof message === "string" ? message : "",
    };
  } catch {
    return null;
  }
}

export type AgentStarted = {
  readonly callId: string;
  readonly turnId: string;
  readonly taskId: string | null;
  readonly sessionId: string;
  readonly tool: string;
};

export function readAgentStarted(data: unknown): AgentStarted | null {
  try {
    const d = data as { callId?: unknown; name?: unknown; sessionId?: unknown; taskId?: unknown; turnId?: unknown } | null;
    if (d === null || typeof d !== "object") return null;
    const sessionId = d.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    const callId = d.callId;
    if (typeof callId !== "string" || callId.length === 0) return null;
    const taskId = d.taskId;
    return {
      callId,
      turnId: typeof d.turnId === "string" ? d.turnId : "",
      taskId: typeof taskId === "string" && TASK_ID_RE.test(taskId) ? taskId : null,
      sessionId,
      tool: typeof d.name === "string" ? d.name : "",
    };
  } catch {
    return null;
  }
}

export type TaskSummary = {
  readonly taskId: string;
  readonly status: string;
  readonly agentId: string | null;
};

export function settledTaskSummary(settled: TaskSettled): TaskSummary {
  return { taskId: settled.taskId, status: settled.status, agentId: null };
}

export type DelegationFailure = {
  readonly callId: string;
  readonly errorClass: string;
  readonly errorText: string;
  readonly tool: string;
  readonly status: string;
};

export function readDelegationFailure(result: unknown): DelegationFailure | null {
  try {
    const r = result as
      | {
          kind?: unknown;
          callId?: unknown;
          isError?: unknown;
          subagentName?: unknown;
          outcome?: { result?: { kind?: unknown; error?: { message?: unknown } } };
          output?: unknown;
        }
      | null;
    if (r === null || typeof r !== "object") return null;
    if (r.kind !== "subagent-result") return null;
    if (r.isError !== true) return null;
    const callId = r.callId;
    if (typeof callId !== "string" || callId.length === 0) return null;
    const out = r.output as { code?: unknown; message?: unknown } | null | undefined;
    const code = out?.code;
    const outcome = r.outcome?.result?.kind;
    const nested = r.outcome?.result?.error?.message;
    const message = typeof out?.message === "string" && out.message.length > 0 ? out.message : nested;
    return {
      callId,
      errorClass: typeof code === "string" && code.length > 0 ? code : "",
      errorText: typeof message === "string" ? message : "",
      tool: typeof r.subagentName === "string" ? r.subagentName : "",
      status: typeof outcome === "string" && outcome.length > 0 ? outcome : "failed",
    };
  } catch {
    return null;
  }
}

const FAILURE_TEXT_MAX_CHARS = 600;

export type TaskSettledFailure = {
  readonly errorClass: string;
  readonly errorText: string;
  readonly parse: "event" | "status" | "none";
};

const NO_SETTLED_FAILURE: TaskSettledFailure = { errorClass: "", errorText: "", parse: "none" };

export function taskSettledFailure(settled: TaskSettled | null): TaskSettledFailure {
  if (settled === null || settled.status === "completed") return NO_SETTLED_FAILURE;
  const cap = (s: string): string => (s.length <= FAILURE_TEXT_MAX_CHARS ? s : `${s.slice(0, FAILURE_TEXT_MAX_CHARS)}…`);
  if (settled.status === "failed" && settled.errorText.length > 0) {
    return { errorClass: "", errorText: cap(settled.errorText), parse: "event" };
  }
  if (settled.status === "cancelled" && settled.cancelReason.length > 0) {
    return { errorClass: settled.cancelReason, errorText: settled.cancelReason, parse: "event" };
  }
  return { errorClass: "", errorText: settled.status, parse: "status" };
}

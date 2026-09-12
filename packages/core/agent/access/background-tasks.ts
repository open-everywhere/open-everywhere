export const TASK_TOOL_NAMES: readonly string[] = ["task_peek", "task_cancel", "task_sleep", "task_update"];

export const TASK_PARENT_TOOL_NAMES: readonly string[] = ["task_peek", "task_cancel", "task_sleep"];

export const TASK_CHILD_TOOL_NAME = "task_update";

const TASK_PEEK_TOOL = "task_peek";
const TASK_CANCEL_TOOL = "task_cancel";
const TASK_VIEW_TOOLS: ReadonlySet<string> = new Set([TASK_PEEK_TOOL, TASK_CANCEL_TOOL]);

export type TaskReceipt = {
  readonly taskId: string;
  readonly callId: string;
  readonly agentId: string | null;
  readonly tool: string;
};

const TASK_ID_PREFIX = "task_";

export function readTaskReceipt(result: unknown): TaskReceipt | null {
  try {
    const r = result as
      | { kind?: unknown; callId?: unknown; backgroundTask?: { taskId?: unknown }; output?: unknown; subagentName?: unknown; toolName?: unknown }
      | null;
    if (r === null || typeof r !== "object") return null;
    const callId = r.callId;
    if (typeof callId !== "string" || callId.length === 0) return null;
    const agentId = (r.output as { agentId?: unknown } | null | undefined)?.agentId;
    const handle = typeof agentId === "string" && agentId.length > 0 ? agentId : null;

    if (r.kind === "subagent-result") {
      const taskId = r.backgroundTask?.taskId;
      if (typeof taskId !== "string" || taskId.length === 0) return null;
      return { taskId, callId, agentId: handle, tool: typeof r.subagentName === "string" ? r.subagentName : "" };
    }

    if (r.kind === "tool-result") {
      const output = r.output as { status?: unknown; taskId?: unknown } | null | undefined;
      if (output === null || typeof output !== "object") return null;
      if (output.status !== "working") return null;
      const taskId = output.taskId;
      if (typeof taskId !== "string" || !taskId.startsWith(TASK_ID_PREFIX) || taskId.length <= TASK_ID_PREFIX.length) return null;
      if (handle === null) return null;
      return { taskId, callId, agentId: handle, tool: typeof r.toolName === "string" ? r.toolName : "" };
    }

    return null;
  } catch {
    return null;
  }
}

export type DelegationFailure = {
  readonly callId: string;
  readonly errorClass: string;
  readonly errorText: string;
  readonly tool: string;
  readonly outcome: string;
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
      outcome: typeof outcome === "string" && outcome.length > 0 ? outcome : "failed",
    };
  } catch {
    return null;
  }
}

export const TERMINAL_TASK_STATUSES: readonly string[] = ["completed", "failed", "cancelled"];

export type TaskSummary = {
  readonly taskId: string;
  readonly status: string;
  readonly agentId: string | null;
};

export function taskViewsOf(result: unknown): readonly TaskSummary[] {
  try {
    const r = result as { kind?: unknown; toolName?: unknown; output?: { tasks?: unknown } } | null;
    if (r === null || typeof r !== "object") return [];
    if (r.kind !== "tool-result" || typeof r.toolName !== "string" || !TASK_VIEW_TOOLS.has(r.toolName)) return [];
    const tasks = r.output?.tasks;
    if (!Array.isArray(tasks)) return [];
    const out: TaskSummary[] = [];
    for (const raw of tasks) {
      const t = raw as { taskId?: unknown; status?: unknown; metadata?: { agentId?: unknown } } | null;
      if (t === null || typeof t !== "object") continue;
      if (typeof t.taskId !== "string" || t.taskId.length === 0) continue;
      if (typeof t.status !== "string" || t.status.length === 0) continue;
      const agentId = t.metadata?.agentId;
      out.push({ taskId: t.taskId, status: t.status, agentId: typeof agentId === "string" && agentId.length > 0 ? agentId : null });
    }
    return out;
  } catch {
    return [];
  }
}

export function terminalTaskViewsOf(result: unknown): readonly TaskSummary[] {
  return taskViewsOf(result).filter((v) => TERMINAL_TASK_STATUSES.includes(v.status));
}

export type TaskNotification = {
  readonly taskId: string;
  readonly status: string;
};

const TASK_NOTIFICATION_RE =
  /^Background task (\S+) \([^)]*\) (?:needs input\.|(?:is )?([a-z_]+)\.)/m;

const TASK_ID_RE = /^task_[A-Za-z0-9_-]{8,}$/;

export function readTaskNotification(message: unknown): TaskNotification | null {
  try {
    if (typeof message !== "string" || message.length === 0) return null;
    const m = TASK_NOTIFICATION_RE.exec(message.trimStart());
    if (m === null) return null;
    const taskId = m[1] ?? "";
    if (!TASK_ID_RE.test(taskId)) return null;
    const status = m[2] ?? "input_required";
    return { taskId, status };
  } catch {
    return null;
  }
}

const TASK_FAILURE_ERROR_LABEL = "\n\nError:\n";

export type TaskNotificationFailure = {
  readonly errorClass: string;
  readonly errorText: string;
};

const NO_NOTIFICATION_FAILURE: TaskNotificationFailure = { errorClass: "", errorText: "" };

export function taskNotificationFailure(message: unknown): TaskNotificationFailure {
  try {
    if (typeof message !== "string" || message.length === 0) return NO_NOTIFICATION_FAILURE;
    const text = message.trimStart();
    const m = TASK_NOTIFICATION_RE.exec(text);
    if (m === null) return NO_NOTIFICATION_FAILURE;
    if (m[2] !== "failed") return NO_NOTIFICATION_FAILURE;
    if (!TASK_ID_RE.test(m[1] ?? "")) return NO_NOTIFICATION_FAILURE;
    const tail = text.slice(m.index + m[0].length);
    if (!tail.startsWith(TASK_FAILURE_ERROR_LABEL)) return NO_NOTIFICATION_FAILURE;
    const body = tail.slice(TASK_FAILURE_ERROR_LABEL.length);
    const end = body.indexOf("\n\n");
    const payload = end < 0 ? body : body.slice(0, end);
    if (payload.length === 0) return NO_NOTIFICATION_FAILURE;
    return splitFailurePayload(payload);
  } catch {
    return NO_NOTIFICATION_FAILURE;
  }
}

function splitFailurePayload(payload: string): TaskNotificationFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { errorClass: "", errorText: payload };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { errorClass: "", errorText: payload };
  const o = parsed as { code?: unknown; message?: unknown };
  const errorClass = typeof o.code === "string" ? o.code : "";
  const errorText = typeof o.message === "string" ? o.message : "";
  if (errorClass.length === 0 && errorText.length === 0) return { errorClass: "", errorText: payload };
  return { errorClass, errorText };
}

export function terminalTaskNotification(message: unknown): TaskSummary | null {
  const note = readTaskNotification(message);
  if (note === null) return null;
  if (!TERMINAL_TASK_STATUSES.includes(note.status)) return null;
  return { taskId: note.taskId, status: note.status, agentId: null };
}

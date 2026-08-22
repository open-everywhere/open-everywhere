export const TASK_TOOL_NAMES: readonly string[] = ["task_peek", "task_cancel", "task_sleep", "task_update"];

export const TASK_PARENT_TOOL_NAMES: readonly string[] = ["task_peek", "task_cancel", "task_sleep"];

export const TASK_CHILD_TOOL_NAME = "task_update";

export const TASK_PEEK_TOOL = "task_peek";
export const TASK_CANCEL_TOOL = "task_cancel";
const TASK_VIEW_TOOLS: ReadonlySet<string> = new Set([TASK_PEEK_TOOL, TASK_CANCEL_TOOL]);

export type TaskReceipt = {
  readonly taskId: string;
  readonly callId: string;
  readonly agentId: string | null;
};

const TASK_ID_PREFIX = "task_";

export function readTaskReceipt(result: unknown): TaskReceipt | null {
  try {
    const r = result as { kind?: unknown; callId?: unknown; backgroundTask?: { taskId?: unknown }; output?: unknown } | null;
    if (r === null || typeof r !== "object") return null;
    const callId = r.callId;
    if (typeof callId !== "string" || callId.length === 0) return null;
    const agentId = (r.output as { agentId?: unknown } | null | undefined)?.agentId;
    const handle = typeof agentId === "string" && agentId.length > 0 ? agentId : null;

    if (r.kind === "subagent-result") {
      const taskId = r.backgroundTask?.taskId;
      if (typeof taskId !== "string" || taskId.length === 0) return null;
      return { taskId, callId, agentId: handle };
    }

    if (r.kind === "tool-result") {
      const output = r.output as { status?: unknown; taskId?: unknown } | null | undefined;
      if (output === null || typeof output !== "object") return null;
      if (output.status !== "working") return null;
      const taskId = output.taskId;
      if (typeof taskId !== "string" || !taskId.startsWith(TASK_ID_PREFIX) || taskId.length <= TASK_ID_PREFIX.length) return null;
      if (handle === null) return null;
      return { taskId, callId, agentId: handle };
    }

    return null;
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

export function terminalTaskNotification(message: unknown): TaskSummary | null {
  const note = readTaskNotification(message);
  if (note === null) return null;
  if (!TERMINAL_TASK_STATUSES.includes(note.status)) return null;
  return { taskId: note.taskId, status: note.status, agentId: null };
}

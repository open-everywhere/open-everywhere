import { Role, Task, TaskState, type Task as TaskShape } from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import type { WorkRowStore } from "../../channels/work.js";

const A2A_INBOUND_TASK_TTL_MS = 24 * 60 * 60 * 1000;

const KEY_PREFIX = "oe-a2a-inbound-task:";

const A2A_INBOUND_MAX_ANSWER_CHARS = 20_000;

function taskKey(caller: string, taskId: string): string {
  return `${KEY_PREFIX}${caller}:${taskId}`;
}

const TERMINAL: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

function isTerminalTask(task: TaskShape | undefined): boolean {
  return task?.status !== undefined && TERMINAL.has(task.status.state);
}

function callerOfContext(context: ServerCallContext): string | undefined {
  const user = context.user;
  if (user === undefined || !user.isAuthenticated) return undefined;
  const name = user.userName;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

export async function readA2aInboundTask(store: WorkRowStore, org: string, caller: string, taskId: string): Promise<TaskShape | undefined> {
  const raw = await store.getTaskResult(org, taskKey(caller, taskId));
  if (raw === null) return undefined;
  try {
    const task = Task.fromJSON(JSON.parse(raw));
    return task.id === taskId ? task : undefined;
  } catch {
    return undefined;
  }
}

export async function writeA2aInboundTask(store: WorkRowStore, org: string, caller: string, task: TaskShape, nowIso: string): Promise<void> {
  if (!isTerminalTask(task)) {
    const existing = await readA2aInboundTask(store, org, caller, task.id);
    if (isTerminalTask(existing)) return;
  }
  await store.putTaskResult(org, taskKey(caller, task.id), JSON.stringify(Task.toJSON(task)), nowIso, A2A_INBOUND_TASK_TTL_MS);
}

export class OperationalA2aTaskStore implements TaskStore {
  constructor(
    private readonly store: WorkRowStore,
    private readonly org: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async save(task: TaskShape, context: ServerCallContext): Promise<void> {
    const caller = callerOfContext(context);
    if (caller === undefined) throw new Error("a2a inbound: refusing to save a task for an unauthenticated call");
    await writeA2aInboundTask(this.store, this.org, caller, { ...task, history: [] }, this.now());
  }

  async load(taskId: string, context: ServerCallContext): Promise<TaskShape | undefined> {
    const caller = callerOfContext(context);
    if (caller === undefined) return undefined;
    return readA2aInboundTask(this.store, this.org, caller, taskId);
  }

  async list(): Promise<{ tasks: TaskShape[]; nextPageToken: string; pageSize: number; totalSize: number }> {
    return { tasks: [], nextPageToken: "", pageSize: 0, totalSize: 0 };
  }
}

function textPart(value: string): TaskShape["artifacts"][number]["parts"][number] {
  return { content: { $case: "text", value }, metadata: undefined, filename: "", mediaType: "text/plain" };
}

function capInboundAnswer(text: string): string {
  if (text.length <= A2A_INBOUND_MAX_ANSWER_CHARS) return text;
  return `${text.slice(0, A2A_INBOUND_MAX_ANSWER_CHARS)}\n\n[the answer was cut at ${A2A_INBOUND_MAX_ANSWER_CHARS} characters]`;
}

export async function settleA2aInboundTask(
  store: WorkRowStore,
  org: string,
  input: { readonly caller: string; readonly taskId: string; readonly outcome: "completed" | "failed" | "canceled"; readonly text: string; readonly nowIso: string },
): Promise<boolean> {
  const existing = await readA2aInboundTask(store, org, input.caller, input.taskId);
  if (existing === undefined) return false;
  if (isTerminalTask(existing)) return true;
  const state = input.outcome === "completed" ? TaskState.TASK_STATE_COMPLETED : input.outcome === "canceled" ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED;
  const answer = capInboundAnswer(input.text);
  const settled: TaskShape = {
    ...existing,
    status: {
      state,
      timestamp: input.nowIso,
      message:
        input.outcome === "completed"
          ? undefined
          : {
              messageId: `${input.taskId}-status`,
              contextId: existing.contextId,
              taskId: input.taskId,
              role: Role.ROLE_AGENT,
              parts: [textPart(answer)],
              metadata: undefined,
              extensions: [],
              referenceTaskIds: [],
            },
    },
    artifacts:
      input.outcome === "completed"
        ? [{ artifactId: `${input.taskId}-result`, name: "Result", description: "The agent's answer.", parts: [textPart(answer)], metadata: undefined, extensions: [] }]
        : existing.artifacts,
  };
  await writeA2aInboundTask(store, org, input.caller, settled, input.nowIso);
  return true;
}

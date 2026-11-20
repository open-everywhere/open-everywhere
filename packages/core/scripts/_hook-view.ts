import { emptySessionView, foldEvents, type SessionView } from "eve/events";

export interface SyntheticEvent {
  readonly type: string;
  readonly data: unknown;
  readonly scope?: { readonly turnId?: string; readonly runId?: string; readonly taskId?: string; readonly changeId?: string };
}

export function ev(type: string, data: unknown, scope?: SyntheticEvent["scope"]): SyntheticEvent {
  return { type, data, ...(scope !== undefined ? { scope } : {}) };
}

export function viewOf(events: readonly SyntheticEvent[]): SessionView {
  const at = "2000-01-01T00:00:00.000Z";
  return foldEvents(
    emptySessionView(),
    events.map((e, line) => ({ ...e, meta: { position: { line, index: 0 }, at, endOfLine: true } })) as never,
  );
}

export interface SyntheticCall {
  readonly callId: string;
  readonly name: string;
  readonly kind?: "tool" | "agent" | "skill" | "control";
  readonly turnId?: string;
  readonly runId?: string;
  readonly input?: unknown;
  readonly outcome?: "completed" | "failed" | "rejected" | "interrupted" | "abandoned";
  readonly output?: unknown;
  readonly taskId?: string;
}

export function turnEvents(turnId: string): SyntheticEvent[] {
  return [ev("turn.started", { turnId, cause: { policy: "test" }, follows: null }, { turnId })];
}

export function runEvents(turnId: string, runId: string): SyntheticEvent[] {
  return [ev("model.requested", { runId, owner: { turnId } }, { turnId, runId })];
}

export function callEvents(c: SyntheticCall): SyntheticEvent[] {
  const turnId = c.turnId ?? "t1";
  const runId = c.runId ?? "r1";
  const out: SyntheticEvent[] = [
    ev("call.requested", { callId: c.callId, owner: { runId }, capability: { kind: c.kind ?? "tool", name: c.name }, ...(c.input !== undefined ? { input: c.input } : {}) }, { turnId, runId }),
    ev("call.started", { callId: c.callId, ...(c.taskId !== undefined ? { taskId: c.taskId } : {}) }, { turnId }),
  ];
  if (c.taskId !== undefined) out.push(ev("task.started", { taskId: c.taskId, startedBy: { callId: c.callId }, kind: c.kind === "agent" ? "agent" : "tool", name: c.name }, { turnId }));
  if (c.outcome !== undefined) out.push(ev("call.settled", { callId: c.callId, outcome: c.outcome, ...(c.output !== undefined ? { output: c.output } : {}) }, { turnId }));
  return out;
}

export function callView(...calls: readonly SyntheticCall[]): SessionView {
  return callViewWith([], ...calls);
}

export function usageEvent(turnId: string, runId: string, usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens?: number }): SyntheticEvent {
  return ev("usage.recorded", { kind: "model", owner: { runId }, usage: { cacheReadTokens: 0, cacheWriteTokens: 0, ...usage } }, { turnId, runId });
}

export function callViewWith(extra: readonly SyntheticEvent[], ...calls: readonly SyntheticCall[]): SessionView {
  const turns = [...new Set(calls.map((c) => c.turnId ?? "t1"))];
  const runs = [...new Set(calls.map((c) => `${c.turnId ?? "t1"}\u0000${c.runId ?? "r1"}`))];
  return viewOf([
    ev("session.started", {}),
    ...turns.flatMap((t) => turnEvents(t)),
    ...runs.flatMap((r) => {
      const [t, run] = r.split("\u0000") as [string, string];
      return runEvents(t, run);
    }),
    ...calls.flatMap((c) => callEvents(c)),
    ...extra,
  ]);
}

export function idleView(): SessionView {
  return viewOf([ev("session.started", {})]);
}

export function busyView(turnId = "t1"): SessionView {
  return viewOf([ev("session.started", {}), ...turnEvents(turnId)]);
}

export function callSettled(callId: string, outcome: SyntheticCall["outcome"] = "completed", turnId = "t1", output?: unknown): { readonly type: "call.settled"; readonly data: unknown; readonly scope: { readonly turnId: string } } {
  return { type: "call.settled", data: { callId, outcome, ...(output !== undefined ? { output } : {}) }, scope: { turnId } };
}

export interface LegacyToolResult {
  readonly data?: { readonly status?: unknown; readonly turnId?: unknown; readonly result?: unknown };
}

let legacyCalls = 0;

export function settledFromToolResult(legacy: LegacyToolResult): { readonly event: ReturnType<typeof callSettled>; readonly view: SessionView } {
  const result = legacy.data?.result as { readonly kind?: unknown; readonly toolName?: unknown; readonly isError?: unknown; readonly callId?: unknown } | undefined;
  const status = legacy.data?.status;
  const turnId = typeof legacy.data?.turnId === "string" ? legacy.data.turnId : "t1";
  const callId = typeof result?.callId === "string" ? result.callId : `legacy-${++legacyCalls}`;
  const isTool = result?.kind === "tool-result";
  const subagent = (result as { readonly subagentName?: unknown } | undefined)?.subagentName;
  const name = isTool && typeof result?.toolName === "string" ? result.toolName : result?.kind === "subagent-result" && typeof subagent === "string" ? subagent : String(result?.kind ?? "unknown");
  const outcome = status === "rejected" ? "rejected" : result?.isError === true || status === "error" || status === "failed" ? "failed" : "completed";
  // A failed call carries eve's `ErrorInfo` on `call.settled`; a result's `{ code, message }` output is that pair.
  const failure = (result as { readonly output?: { readonly code?: unknown; readonly message?: unknown } } | undefined)?.output;
  const error =
    outcome === "failed" && typeof failure?.code === "string" ? { code: failure.code, message: typeof failure.message === "string" ? failure.message : "" } : undefined;
  const settled = callSettled(callId, outcome, turnId);
  return {
    event: error === undefined ? settled : { ...settled, data: { ...(settled.data as object), error } },
    view: callView({ callId, name, kind: isTool ? "tool" : result?.kind === "subagent-result" ? "agent" : "skill", turnId, outcome }),
  };
}

export function callSettledHandler(
  hook: unknown,
): (legacy: LegacyToolResult, ctx: Record<string, unknown>) => Promise<void> {
  const handler = (hook as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["call.settled"]!;
  return async (legacy, ctx) => {
    const { event, view } = settledFromToolResult(legacy);
    await handler(event, { ...ctx, view });
  };
}

export function callRequested(callId: string, name: string, kind: "tool" | "agent" | "skill" | "control" = "tool", input?: unknown): { readonly type: "call.requested"; readonly data: unknown } {
  return { type: "call.requested", data: { callId, owner: { runId: "r1" }, capability: { kind, name }, ...(input !== undefined ? { input } : {}) } };
}

export function interactionView(kind: string, interactionId: string, outcome?: string, turnId = "t1"): SessionView {
  const v27Kind = kind === "tool-approval" ? "approval" : kind;
  return viewOf([
    ev("session.started", {}),
    ...turnEvents(turnId),
    ev("interaction.opened", { interactionId, subject: { turnId }, request: { kind: v27Kind, prompt: "?" } }, { turnId }),
    ...(outcome !== undefined ? [ev("interaction.settled", { interactionId, outcome }, { turnId })] : []),
  ]);
}

/** The v27 event for a handler key. `turn.settled` and `session.ended` carry `outcome` (default `completed`). */
export function v27EndOf(event: string, outcome = "completed"): { readonly key: string; readonly event: { readonly type: string; readonly data?: unknown } } {
  if (event === "turn.settled") return { key: event, event: { type: event, data: { turnId: "t1", outcome } } };
  if (event === "session.ended") return { key: event, event: { type: event, data: { outcome } } };
  return { key: event, event: { type: event } };
}

type Handler = (event: unknown, ctx?: unknown) => unknown;

function withView(ctx: unknown, view: SessionView): unknown {
  if (ctx === undefined || ctx === null) return { view };
  return Object.assign(Object.create(Object.getPrototypeOf(ctx) as object) as object, ctx as object, { view });
}

function outcomeOfStatus(status: unknown, isError?: unknown): "completed" | "failed" | "rejected" | "interrupted" {
  if (status === "rejected") return "rejected";
  if (status === "cancelled") return "interrupted";
  if (isError === true || status === "failed" || status === "error") return "failed";
  return "completed";
}

/**
 * Drives a hook through the eve 1.x (v27) events it binds. Each method is named for the v27 event it
 * emits, and it calls the hook's own handler for that event, so a test drives the real code path. A
 * method takes a short flat payload (a call id, a task id, a status word) and builds the v27 event and
 * the session view the handler reads. A hook that binds no handler for the event throws.
 */
export interface V27Driver {
  /** The hook's own handler for an event it binds, called as eve calls it. Throws for an event it does not bind. */
  bound(key: string): Handler;
  readonly turnStarted: Handler;
  /** `turn.settled` with this outcome. */
  turnSettled(outcome: "completed" | "failed" | "cancelled"): Handler;
  /** `session.ended` with this outcome. A `code` on the payload becomes the event's `error`. */
  sessionEnded(outcome: "completed" | "failed"): Handler;
  /** `delivery.settled`, over a view with no open turn: the session waits for its next delivery. */
  readonly deliverySettled: Handler;
  readonly modelRequested: Handler;
  readonly modelSettled: Handler;
  /** `call.settled` for one tool, agent or skill result: `{ data: { status, turnId?, result: { kind, toolName?, isError?, callId? } } }`. */
  readonly callSettled: Handler;
  /** One `call.requested` per action: `{ data: { turnId?, actions: [{ kind, callId?, toolName?, subagentName?, input? }] } }`. */
  readonly callRequested: Handler;
  /** `task.started`: `{ data: { taskId, callId, kind, name, turnId? } }`. */
  readonly taskStarted: Handler;
  /** `call.settled` for the call that serves a task, over a view that holds the task: `{ data: { taskId, callId, kind?, name?, status, output?, cancel?, error?, turnId? } }`. */
  readonly taskCallSettled: Handler;
  /** `task.ended` over a view that holds the task and its open call. Same payload as `taskCallSettled`. */
  readonly taskEnded: Handler;
  /** `child.opened` for the call that opened the child session: `{ data: { sessionId, callId, name?, taskId?, turnId? } }`. */
  readonly childOpened: Handler;
  /** One `interaction.opened` per request: `{ data: { requests: [{ kind, requestId?, prompt?, options?, action?: { toolName?, input? } }] } }`. */
  readonly interactionOpened: Handler;
}

export function v27Hooks(hook: unknown): V27Driver {
  const events = (hook as { events: Record<string, Handler> }).events;
  const call = (key: string, event: unknown, ctx?: unknown): unknown => {
    const handler = events[key];
    if (handler === undefined) throw new TypeError(`the hook binds no ${key} handler`);
    return handler(event, ctx);
  };
  const data = (e: unknown): Record<string, unknown> => ((e as { data?: Record<string, unknown> } | undefined)?.data ?? {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.length > 0 ? v : fallback);
  let n = 0;
  const taskView = (d: Record<string, unknown>, settled: boolean): SessionView => {
    const status = str(d.status, "completed");
    return callView({
      callId: str(d.callId, "c1"),
      name: str(d.name, "agent"),
      kind: d.kind === "tool" ? "tool" : "agent",
      taskId: str(d.taskId, "task_1"),
      turnId: str(d.turnId, "t1"),
      ...(settled ? { outcome: outcomeOfStatus(status) } : {}),
      ...(d.output !== undefined ? { output: d.output } : {}),
    });
  };
  return {
    bound: (key) => {
      if (events[key] === undefined) throw new TypeError(`the hook binds no ${key} handler`);
      return (e, ctx) => call(key, e, ctx);
    },
    turnStarted: (e, ctx) => call("turn.started", e, ctx),
    turnSettled: (outcome) => (e, ctx) => call("turn.settled", { type: "turn.settled", data: { turnId: str(data(e).turnId, "t1"), outcome } }, ctx),
    sessionEnded: (outcome) => (e, ctx) =>
      call("session.ended", { type: "session.ended", data: { outcome, ...(data(e).code !== undefined ? { error: { code: data(e).code, message: str(data(e).message, "") } } : {}) } }, ctx),
    deliverySettled: (_e, ctx) => call("delivery.settled", { type: "delivery.settled", data: { deliveryId: "d1", outcome: "handled" } }, withView(ctx, idleView())),
    modelRequested: (_e, ctx) => call("model.requested", { type: "model.requested", data: { runId: `r${++n}`, owner: { turnId: "t1" } } }, ctx),
    modelSettled: (_e, ctx) => call("model.settled", { type: "model.settled", data: { runId: `r${++n}`, outcome: "completed" }, scope: { turnId: "t1" } }, ctx),
    callSettled: (e, ctx) => {
      const { event, view } = settledFromToolResult(e as LegacyToolResult);
      return call("call.settled", event, withView(ctx, view));
    },
    callRequested: async (e, ctx) => {
      const actions = (data(e).actions ?? []) as readonly { kind?: string; callId?: string; toolName?: string; subagentName?: string; input?: unknown }[];
      for (const a of actions) {
        const agent = a.kind === "subagent-call";
        await call(
          "call.requested",
          {
            type: "call.requested",
            data: { callId: str(a.callId, `call-${++n}`), owner: { runId: "r1" }, capability: { kind: agent ? "agent" : "tool", name: str(agent ? a.subagentName : a.toolName, "unknown") }, ...(a.input !== undefined ? { input: a.input } : {}) },
            scope: { turnId: str(data(e).turnId, "t1") },
          },
          ctx,
        );
      }
    },
    taskStarted: (e, ctx) => {
      const d = data(e);
      return call("task.started", { type: "task.started", data: { taskId: d.taskId, startedBy: { callId: d.callId }, kind: d.kind, name: d.name }, scope: { turnId: str(d.turnId, "t1") } }, ctx);
    },
    taskCallSettled: (e, ctx) => {
      const d = data(e);
      const status = str(d.status, "completed");
      const reason = (d.cancel as { reason?: unknown } | null | undefined)?.reason;
      const message = (d.error as { message?: unknown } | null | undefined)?.message;
      return call(
        "call.settled",
        {
          type: "call.settled",
          data: {
            callId: str(d.callId, "c1"),
            outcome: outcomeOfStatus(status),
            ...(d.output !== undefined ? { output: d.output } : {}),
            ...(typeof reason === "string" ? { reason } : {}),
            ...(typeof message === "string" ? { error: { code: "TASK_FAILED", message } } : {}),
          },
          scope: { turnId: str(d.turnId, "t1") },
        },
        withView(ctx, taskView(d, true)),
      );
    },
    taskEnded: (e, ctx) => {
      const d = data(e);
      const reason = (d.cancel as { reason?: unknown } | null | undefined)?.reason;
      const message = (d.error as { message?: unknown } | null | undefined)?.message;
      return call(
        "task.ended",
        {
          type: "task.ended",
          data: { taskId: d.taskId, outcome: d.status, ...(typeof reason === "string" ? { reason } : {}), ...(typeof message === "string" ? { error: { code: "TASK_FAILED", message } } : {}) },
          scope: { turnId: str(d.turnId, "t1") },
        },
        withView(ctx, taskView(d, false)),
      );
    },
    childOpened: (e, ctx) => {
      const d = data(e);
      const view = callView({ callId: str(d.callId, "c1"), name: str(d.name, "agent"), kind: "agent", ...(typeof d.taskId === "string" ? { taskId: d.taskId } : {}), turnId: str(d.turnId, "t1") });
      return call("child.opened", { type: "child.opened", data: { sessionId: d.sessionId, owner: { callId: str(d.callId, "c1") }, name: str(d.name, "agent"), stream: "" }, scope: { turnId: str(d.turnId, "t1") } }, withView(ctx, view));
    },
    interactionOpened: async (e, ctx) => {
      const requests = (data(e).requests ?? []) as readonly { kind?: string; requestId?: string; prompt?: string; options?: unknown; action?: { toolName?: string; input?: unknown } }[];
      for (const r of requests) {
        const park = r.action?.toolName === "session_limit_continuation";
        const kind = park ? "budget" : r.kind === "tool-approval" ? "approval" : str(r.kind, "question");
        const callId = `asked-${++n}`;
        const view = callView({ callId, name: str(r.action?.toolName, "none"), ...(r.action?.input !== undefined ? { input: r.action.input } : {}) });
        await call(
          "interaction.opened",
          { type: "interaction.opened", data: { interactionId: str(r.requestId, callId), subject: kind === "approval" ? { callId } : { turnId: "t1" }, request: { kind, prompt: str(r.prompt, ""), ...(Array.isArray(r.options) ? { options: r.options } : {}) } } },
          withView(ctx, view),
        );
      }
    },
  };
}

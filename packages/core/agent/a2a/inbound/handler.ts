import { randomUUID } from "node:crypto";
import { Role, TaskState, type Message, type Task } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type User,
} from "@a2a-js/sdk/server";
import { LegacyJsonRpcTransportHandler } from "@a2a-js/sdk/compat/v0_3/server";
import type { WorkRowStore } from "../../channels/work.js";
import { readCappedBody } from "../../channels/self-dispatch.js";
import { authenticateA2aInbound, type A2aInboundAuthDeps, type A2aInboundAuthRefusal } from "./auth.js";
import { inboundAgentCardJson, buildInboundAgentCard } from "./card.js";
import type { A2aInboundCaller, A2aInboundDeclaration } from "./declaration.js";
import { inboundLandRefusalMessage, type A2aInboundLandOutcome } from "./land.js";
import { OperationalA2aTaskStore, writeA2aInboundTask } from "./task-store.js";

const A2A_INBOUND_MAX_BODY_BYTES = 256 * 1024;

export const A2A_INBOUND_REFUSED_ACTION = "a2a.inbound_refused";
const A2A_INBOUND_ACCEPTED_ACTION = "a2a.inbound_accepted";

export interface A2aInboundAuditRow {
  readonly action: typeof A2A_INBOUND_REFUSED_ACTION | typeof A2A_INBOUND_ACCEPTED_ACTION;
  readonly caller?: string;
  readonly detail: Record<string, unknown>;
}

export interface A2aInboundHttpDeps {
  readonly enabled: () => boolean;
  readonly declaration: () => A2aInboundDeclaration;
  readonly auth?: A2aInboundAuthDeps;
  readonly store: WorkRowStore;
  readonly org: string;
  readonly land: (input: { readonly caller: A2aInboundCaller; readonly taskId: string; readonly text: string; readonly wakeId: string }) => Promise<A2aInboundLandOutcome>;
  readonly audit: (row: A2aInboundAuditRow) => Promise<void>;
  readonly baseUrl: (req: Request) => string;
  readonly now?: () => Date;
}

const NOT_FOUND = (): Response => new Response("not found", { status: 404 });

function a2aInboundIngressOpen(deps: Pick<A2aInboundHttpDeps, "enabled" | "declaration">): boolean {
  return deps.enabled() && deps.declaration().callers.length > 0;
}

export function handleA2aInboundCard(req: Request, deps: A2aInboundHttpDeps): Response {
  if (!a2aInboundIngressOpen(deps)) return NOT_FOUND();
  return new Response(JSON.stringify(inboundAgentCardJson(deps.declaration(), deps.baseUrl(req))), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

class InboundCaller implements User {
  constructor(private readonly name: string) {}
  get isAuthenticated(): boolean {
    return true;
  }
  get userName(): string {
    return this.name;
  }
}

function inboundMessageText(message: Message): string {
  return message.parts
    .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
    .filter((t) => t.length > 0)
    .join("\n")
    .trim();
}

function statusMessage(taskId: string, contextId: string, text: string): Message {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

class InboundExecutor implements AgentExecutor {
  constructor(
    private readonly caller: A2aInboundCaller,
    private readonly deps: A2aInboundHttpDeps,
  ) {}

  cancelTask = async (): Promise<void> => {
    throw new Error("an inbound A2A task cannot be cancelled by its caller");
  };

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = ctx;
    const now = (): string => (this.deps.now?.() ?? new Date()).toISOString();
    const submitted: Task = {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: now(), message: undefined },
      artifacts: [],
      history: [],
      metadata: {},
    };
    await writeA2aInboundTask(this.deps.store, this.deps.org, this.caller.name, submitted, now());
    bus.publish(AgentEvent.task(submitted));
    const text = inboundMessageText(userMessage);
    const finish = (state: TaskState, message?: string): void => {
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: { state, timestamp: now(), message: message === undefined ? undefined : statusMessage(taskId, contextId, message) },
          metadata: undefined,
        }),
      );
    };
    if (text.length === 0) {
      await this.deps.audit({ action: A2A_INBOUND_ACCEPTED_ACTION, caller: this.caller.name, detail: { caller: this.caller.name, taskId, landed: false, reason: "empty-message" } });
      finish(TaskState.TASK_STATE_REJECTED, "The message carried no text. Send the task as a text part.");
      return;
    }
    const wakeId = randomUUID();
    let outcome: A2aInboundLandOutcome;
    try {
      outcome = await this.deps.land({ caller: this.caller, taskId, text, wakeId });
    } catch (err) {
      await this.deps.audit({ action: A2A_INBOUND_ACCEPTED_ACTION, caller: this.caller.name, detail: { caller: this.caller.name, taskId, wakeId, landed: false, reason: "forward-failed", error: err instanceof Error ? err.name : "error" } });
      finish(TaskState.TASK_STATE_FAILED, "The task could not be started. It may or may not run; do not resend it without checking with the operator.");
      return;
    }
    await this.deps.audit({
      action: A2A_INBOUND_ACCEPTED_ACTION,
      caller: this.caller.name,
      detail: { caller: this.caller.name, taskId, wakeId, landed: outcome.landed, surface: outcome.surfaceKey, chars: text.length, ...(outcome.landed ? {} : { reason: outcome.reason }) },
    });
    if (!outcome.landed) {
      finish(TaskState.TASK_STATE_REJECTED, inboundLandRefusalMessage(outcome.reason));
      return;
    }
    finish(TaskState.TASK_STATE_WORKING);
  }
}

function jsonRpcError(id: unknown, code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }), { status, headers: { "content-type": "application/json" } });
}

function sendMessageOf(body: { method?: unknown; params?: unknown }): { readonly taskId?: unknown; readonly task_id?: unknown } | undefined {
  if (body.method !== "SendMessage" && body.method !== "message/send") return undefined;
  const params = body.params as { message?: unknown } | undefined;
  const message = params?.message;
  return typeof message === "object" && message !== null ? (message as { taskId?: unknown; task_id?: unknown }) : undefined;
}

const SERVED_METHODS: ReadonlySet<string> = new Set(["SendMessage", "GetTask", "message/send", "tasks/get"]);

export async function handleA2aInboundRpc(req: Request, deps: A2aInboundHttpDeps): Promise<Response> {
  if (!a2aInboundIngressOpen(deps)) return NOT_FOUND();
  const declaration = deps.declaration();
  const auth = await authenticateA2aInbound(req.headers.get("authorization"), declaration, deps.auth ?? {});
  if (!auth.ok) {
    await deps.audit({ action: A2A_INBOUND_REFUSED_ACTION, detail: { reason: auth.reason satisfies A2aInboundAuthRefusal } });
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="a2a"' },
    });
  }
  const caller = auth.caller;
  const read = await readCappedBody(req, A2A_INBOUND_MAX_BODY_BYTES);
  if ("tooLarge" in read) return new Response("payload too large", { status: 413 });
  const raw = read.body;
  let body: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }
  if (typeof body !== "object" || body === null || typeof body.method !== "string") return jsonRpcError(null, -32600, "Invalid Request");
  if (!SERVED_METHODS.has(body.method)) return jsonRpcError(body.id, -32601, `Method not served: ${body.method.slice(0, 64)}`);
  const send = sendMessageOf(body);
  const followUp = send?.taskId ?? send?.task_id;
  if (typeof followUp === "string" && followUp.length > 0) {
    return jsonRpcError(body.id, -32602, "An inbound task takes no follow-up message. Send a new message without a taskId to start a new task.");
  }
  const handler = new DefaultRequestHandler(buildInboundAgentCard(declaration, deps.baseUrl(req)), new OperationalA2aTaskStore(deps.store, deps.org), new InboundExecutor(caller, deps));
  const context = new ServerCallContext({ user: new InboundCaller(caller.name), requestedVersion: req.headers.get("a2a-version") ?? undefined });
  const legacy = body.method.includes("/");
  const answer = legacy ? await new LegacyJsonRpcTransportHandler(handler).handle(body as Record<string, unknown>, context) : await new JsonRpcTransportHandler(handler).handle(body as Record<string, unknown>, context);
  if (typeof (answer as AsyncGenerator<unknown>)[Symbol.asyncIterator] === "function") {
    return jsonRpcError(body.id, -32601, "Streaming is not served.");
  }
  return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
}

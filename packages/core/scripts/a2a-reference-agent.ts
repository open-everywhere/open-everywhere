import http from "node:http";
import { randomUUID } from "node:crypto";
import { A2A_PROTOCOL_VERSION, Role, TaskState, type AgentCard, type Message, type Task } from "@a2a-js/sdk";
import { LegacyJsonRpcTransportHandler } from "@a2a-js/sdk/compat/v0_3/server";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  UnauthenticatedUser,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";

export const REFERENCE_CARD_PATH = "/.well-known/agent-card.json";
export const REFERENCE_RPC_PATH = "/a2a/jsonrpc";

export interface ReferenceAgentOptions {
  readonly origin: string;
  readonly slowMs?: number;
  readonly bearerToken?: string;
  readonly interfaceUrl?: string;
  readonly legacyV03?: boolean;
}

export interface ReceivedMessage {
  readonly text: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly authorization: string | undefined;
}

export interface ReferenceAgent {
  readonly card: AgentCard;
  readonly cardUrl: string;
  readonly received: readonly ReceivedMessage[];
  handle(request: Request): Promise<Response>;
}

function textOf(message: Message): string {
  const part = message.parts.find((p) => p.content?.$case === "text");
  return part?.content?.$case === "text" ? part.content.value.trim() : "";
}

function textPart(value: string): Message["parts"][number] {
  return { content: { $case: "text", value }, metadata: undefined, filename: "", mediaType: "text/plain" };
}

class ReferenceExecutor implements AgentExecutor {
  constructor(private readonly slowMs: number) {}

  cancelTask = async (_taskId: string, _bus: ExecutionEventBus): Promise<void> => {};

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = ctx;
    const now = (): string => new Date().toISOString();
    const snapshot: Task = ctx.task ?? {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: now(), message: undefined },
      artifacts: [],
      history: [userMessage],
      metadata: userMessage.metadata,
    };
    bus.publish(AgentEvent.task(snapshot));
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_WORKING, timestamp: now(), message: undefined },
        metadata: {},
      }),
    );
    const query = textOf(userMessage);
    const lower = query.toLowerCase();
    await new Promise((resolve) => setTimeout(resolve, lower.includes("slow") ? this.slowMs : 10));
    if (lower.includes("fail")) {
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_FAILED,
            timestamp: now(),
            message: {
              role: Role.ROLE_AGENT,
              messageId: randomUUID(),
              parts: [textPart("The reference agent was asked to fail.")],
              taskId,
              contextId,
              extensions: [],
              metadata: {},
              referenceTaskIds: [],
            },
          },
          metadata: undefined,
        }),
      );
      return;
    }
    bus.publish(
      AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact: {
          artifactId: randomUUID(),
          name: "Result",
          description: "The final result from the agent.",
          parts: [textPart(query === "" ? "Hello! Please provide a message for me to respond to." : `Hello World! You said: '${query}'. Thanks for your message!`)],
          metadata: undefined,
          extensions: [],
        },
        lastChunk: true,
        append: false,
        metadata: undefined,
      }),
    );
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: now(), message: undefined },
        metadata: undefined,
      }),
    );
  }
}

function referenceCard(origin: string, interfaceUrl: string | undefined): AgentCard {
  return {
    name: "Sample Agent",
    description: "The A2A project's sample agent: it answers a greeting, and simulates the flow of task states.",
    supportedInterfaces: [
      { url: interfaceUrl ?? `${origin}${REFERENCE_RPC_PATH}`, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION },
    ],
    provider: { organization: "A2A Samples", url: "https://example.com/a2a-samples" },
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "sample_agent",
        name: "Sample Agent",
        description: "Answer a message.",
        tags: ["sample"],
        examples: ["hi", "hello world"],
        inputModes: ["text"],
        outputModes: ["text"],
        securityRequirements: [],
      },
    ],
    documentationUrl: "",
    signatures: [],
  };
}

function legacyCard(card: AgentCard): Record<string, unknown> {
  return {
    protocolVersion: "0.3.0",
    name: card.name,
    description: card.description,
    url: card.supportedInterfaces[0]?.url ?? "",
    preferredTransport: "JSONRPC",
    version: card.version,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: card.defaultInputModes,
    defaultOutputModes: card.defaultOutputModes,
    skills: card.skills.map((k) => ({ id: k.id, name: k.name, description: k.description, tags: k.tags, examples: k.examples })),
  };
}

export function createReferenceAgent(options: ReferenceAgentOptions): ReferenceAgent {
  const card = referenceCard(options.origin, options.interfaceUrl);
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new ReferenceExecutor(options.slowMs ?? 1_500));
  const rpc = new JsonRpcTransportHandler(requestHandler);
  const legacyRpc = new LegacyJsonRpcTransportHandler(requestHandler);
  const received: ReceivedMessage[] = [];

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization") ?? undefined;
    if (options.bearerToken !== undefined && authorization !== `Bearer ${options.bearerToken}`) {
      return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    if (request.method === "GET" && url.pathname === REFERENCE_CARD_PATH) {
      const served = options.legacyV03 === true ? legacyCard(card) : await requestHandler.getAgentCard();
      return new Response(JSON.stringify(served), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (request.method === "POST" && url.pathname === REFERENCE_RPC_PATH) {
      const body = (await request.json()) as { method?: string; params?: { message?: Message } };
      if ((body.method === "SendMessage" || body.method === "message/send") && body.params?.message !== undefined) {
        const message = body.params.message as unknown as { parts?: { text?: string }[]; metadata?: Record<string, unknown> };
        received.push({
          text: (message.parts ?? []).map((p) => p.text ?? "").join(""),
          metadata: message.metadata ?? {},
          authorization,
        });
      }
      const context = new ServerCallContext({ user: new UnauthenticatedUser(), requestedVersion: request.headers.get("a2a-version") ?? undefined });
      const answer = options.legacyV03 === true ? await legacyRpc.handle(body as Record<string, unknown>, context) : await rpc.handle(body as Record<string, unknown>, context);
      if (typeof (answer as AsyncGenerator<unknown>)[Symbol.asyncIterator] === "function") {
        return new Response(JSON.stringify({ error: "streaming is not served by this reference agent" }), { status: 400 });
      }
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }

  return { card, cardUrl: `${options.origin}${REFERENCE_CARD_PATH}`, received, handle };
}

export async function serveReferenceAgent(options: Omit<ReferenceAgentOptions, "origin"> = {}): Promise<{ readonly agent: ReferenceAgent; close(): Promise<void> }> {
  let agent: ReferenceAgent | undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const request = new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, {
        method: req.method,
        headers,
        ...(body !== undefined && req.method !== "GET" ? { body } : {}),
      });
      agent!
        .handle(request)
        .then(async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch((err: unknown) => {
          res.writeHead(500);
          res.end(String(err));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  agent = createReferenceAgent({ ...options, origin: `http://127.0.0.1:${port}` });
  return { agent, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

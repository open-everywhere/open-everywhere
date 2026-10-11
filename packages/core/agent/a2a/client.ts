import { Role, TaskState, type AgentCard, type Message, type Part, type Task } from "@a2a-js/sdk";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
} from "@a2a-js/sdk/client";
import { randomUUID } from "node:crypto";

export const A2A_CALLER_METADATA_KEY = "open-everywhere/caller";

export interface A2aCaller {
  readonly platform: string;
  readonly workspace: string;
  readonly principalId: string;
  readonly approvedBy?: string;
  readonly approvedByPolicy?: string;
}

const A2A_RESULT_MAX_CHARS = 20_000;

export type A2aTaskState = "submitted" | "working" | "completed" | "failed" | "canceled" | "rejected" | "input-required" | "auth-required" | "unknown";

const TERMINAL_STATES: ReadonlySet<A2aTaskState> = new Set(["completed", "failed", "canceled", "rejected"]);
const INTERRUPTED_STATES: ReadonlySet<A2aTaskState> = new Set(["input-required", "auth-required"]);

export type A2aOutcome =
  | { readonly kind: "message"; readonly text: string }
  | {
      readonly kind: "task";
      readonly taskId: string;
      readonly contextId: string;
      readonly state: A2aTaskState;
      readonly terminal: boolean;
      readonly interrupted: boolean;
      readonly text: string;
    };

function a2aTaskStateName(state: TaskState | undefined): A2aTaskState {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return "submitted";
    case TaskState.TASK_STATE_WORKING:
      return "working";
    case TaskState.TASK_STATE_COMPLETED:
      return "completed";
    case TaskState.TASK_STATE_FAILED:
      return "failed";
    case TaskState.TASK_STATE_CANCELED:
      return "canceled";
    case TaskState.TASK_STATE_REJECTED:
      return "rejected";
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return "input-required";
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return "auth-required";
    default:
      return "unknown";
  }
}

function partText(part: Part): string {
  const content = part.content;
  if (content === undefined) return "";
  switch (content.$case) {
    case "text":
      return content.value;
    case "data":
      return JSON.stringify(content.value);
    case "url":
      return `[file${part.filename ? ` ${part.filename}` : ""}: ${content.value}]`;
    case "raw":
      return `[file${part.filename ? ` ${part.filename}` : ""}: ${content.value.length} bytes, not shown]`;
    default:
      return "";
  }
}

function partsText(parts: readonly Part[]): string {
  return parts.map(partText).filter((t) => t.length > 0).join("\n");
}

function capped(text: string): string {
  return text.length <= A2A_RESULT_MAX_CHARS ? text : `${text.slice(0, A2A_RESULT_MAX_CHARS)}\n[cut: the agent's result ran past ${A2A_RESULT_MAX_CHARS} characters]`;
}

function taskText(task: Task): string {
  const artifacts = task.artifacts.map((a) => partsText(a.parts)).filter((t) => t.length > 0);
  const status = task.status?.message !== undefined ? partsText(task.status.message.parts) : "";
  return capped([...artifacts, ...(status.length > 0 ? [status] : [])].join("\n\n"));
}

function a2aOutcomeOf(result: Message | Task): A2aOutcome {
  if ("messageId" in result) return { kind: "message", text: capped(partsText(result.parts)) };
  const state = a2aTaskStateName(result.status?.state);
  return {
    kind: "task",
    taskId: result.id,
    contextId: result.contextId,
    state,
    terminal: TERMINAL_STATES.has(state),
    interrupted: INTERRUPTED_STATES.has(state),
    text: taskText(result),
  };
}

export function a2aCardPinRefusal(cardUrl: string, card: AgentCard): string | undefined {
  const declared = new URL(cardUrl);
  const interfaces = card.supportedInterfaces ?? [];
  if (interfaces.length === 0) return `The agent card at ${declared.origin} names no endpoint.`;
  for (const iface of interfaces) {
    let url: URL;
    try {
      url = new URL(iface.url);
    } catch {
      return `The agent card at ${declared.origin} names an endpoint that is not a URL.`;
    }
    if (url.origin !== declared.origin) {
      return (
        `The agent card at ${declared.origin} names an endpoint on ${url.origin}, which is not the declared origin. ` +
        "The client reaches only the origin (scheme, host and port) of the declared card URL; change the declaration by pull request if the agent really moved."
      );
    }
  }
  return undefined;
}

export interface A2aClientTarget {
  readonly name: string;
  readonly cardUrl: string;
}

export interface A2aConnection {
  readonly client: Client;
  readonly card: AgentCard;
}

export async function connectA2aAgent(target: A2aClientTarget, fetchImpl: typeof fetch): Promise<A2aConnection> {
  const card = await new DefaultAgentCardResolver({ fetchImpl, legacyCompat: { enabled: true } }).resolve(target.cardUrl, "");
  const refusal = a2aCardPinRefusal(target.cardUrl, card);
  if (refusal !== undefined) throw new Error(refusal);
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl, legacyCompat: { enabled: true } }), new RestTransportFactory({ fetchImpl, legacyCompat: { enabled: true } })],
    }),
  );
  return { client: await factory.createFromAgentCard(card), card };
}

function a2aTaskMessage(text: string, caller: A2aCaller, messageId?: string): Message {
  return {
    messageId: messageId ?? randomUUID(),
    role: Role.ROLE_USER,
    parts: [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" }],
    taskId: "",
    contextId: "",
    extensions: [],
    metadata: {
      [A2A_CALLER_METADATA_KEY]: {
        platform: caller.platform,
        workspace: caller.workspace,
        principalId: caller.principalId,
        ...(caller.approvedBy !== undefined ? { approvedBy: caller.approvedBy } : {}),
        ...(caller.approvedByPolicy !== undefined ? { approvedByPolicy: caller.approvedByPolicy } : {}),
      },
    },
    referenceTaskIds: [],
  };
}

export interface A2aFollowOptions {
  readonly waitMs: number;
  readonly pollMs?: number;
  readonly maxPollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export const A2A_DEFAULT_WAIT_MS = 60_000;

export async function followA2aTask(client: Client, taskId: string, options: A2aFollowOptions): Promise<A2aOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + options.waitMs;
  let gap = options.pollMs ?? 500;
  const maxGap = options.maxPollMs ?? 5_000;
  for (;;) {
    const outcome = a2aOutcomeOf(await client.getTask({ tenant: "", id: taskId, historyLength: 0 }));
    if (outcome.kind === "message" || outcome.terminal || outcome.interrupted) return outcome;
    const left = deadline - now();
    if (left <= 0) return outcome;
    await sleep(Math.min(gap, left));
    gap = Math.min(gap * 2, maxGap);
  }
}

export async function delegateA2aTask(client: Client, text: string, caller: A2aCaller, options: A2aFollowOptions & { readonly messageId?: string }): Promise<A2aOutcome> {
  const sent = a2aOutcomeOf(
    await client.sendMessage({
      tenant: "",
      message: a2aTaskMessage(text, caller, options.messageId),
      configuration: { acceptedOutputModes: ["text", "text/plain", "application/json"], taskPushNotificationConfig: undefined, historyLength: 0, returnImmediately: true },
      metadata: {},
    }),
  );
  if (sent.kind === "message" || sent.terminal || sent.interrupted) return sent;
  try {
    return await followA2aTask(client, sent.taskId, options);
  } catch {
    return sent;
  }
}

export function renderA2aOutcome(agentName: string, outcome: A2aOutcome): string {
  if (outcome.kind === "message") return `Agent "${agentName}" answered:\n${outcome.text || "(no text)"}`;
  const head = `Agent "${agentName}", task ${outcome.taskId}: ${outcome.state}.`;
  if (outcome.terminal) return `${head}\n${outcome.text || "(no text)"}`;
  if (outcome.interrupted) {
    return `${head} The agent waits on its caller (${outcome.state}); this client cannot answer that.${outcome.text ? `\n${outcome.text}` : ""}`;
  }
  return `${head} The task is still running. Follow it again later with check_agent_task, agent "${agentName}", agentTaskId "${outcome.taskId}".${outcome.text ? `\n${outcome.text}` : ""}`;
}

import { defineState } from "eve/context";
import { redactOutboundPreview } from "@open-everywhere/core/agent/adapter-api.js";
import type {
  SlackCardMessage,
  SlackEventContext,
  SlackRenderer,
  SlackRendererEvents,
  TaskCard,
} from "eve/channels/slack";

export type TaskCardCall = TaskCard["calls"][number];

export interface TaskCardTaskFacts {
  readonly kind: string;
  readonly name: string;
}

export type TaskCardRoom = "direct-message" | "shared";

export const GENERIC_SELF_TASK_LABEL = "Delegated task";

const AGENT_SELF_TOOL_NAME = "agent";

export interface TaskCardRoomFacts {
  readonly state: { readonly channelId?: string | null; readonly audience?: string | null };
  readonly attributes?: Readonly<Record<string, unknown>> | null;
}

export function taskCardRoomOf(facts: TaskCardRoomFacts | null | undefined): TaskCardRoom {
  const channelId = facts?.state?.channelId;
  const attrs = facts?.attributes;
  if (typeof channelId !== "string" || channelId === "" || attrs === null || attrs === undefined) return "shared";
  if (attrs.channel_type !== "im") return "shared";
  if (attrs.channel_id !== channelId) return "shared";
  if (facts?.state?.audience === "public") return "shared";
  return "direct-message";
}

export function genericTaskLabel(task: TaskCardTaskFacts): string {
  if (task.kind === "agent" && task.name === AGENT_SELF_TOOL_NAME) return GENERIC_SELF_TASK_LABEL;
  const segment = task.name.split("__").findLast((s) => s !== "") ?? task.name;
  const words = segment
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[\s_-]+/u)
    .filter((w) => w !== "")
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()));
  if (words.length === 0) return GENERIC_SELF_TASK_LABEL;
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function slackTaskRowId(callId: string): string {
  return callId.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(-200);
}

const EARLIER_ROW_ID = "earlier";

const WAITING_TEXTS = ["Waiting for approval", "Waiting for sign-in", "Waiting for a response"] as const;
const DEFAULT_WAITING_TEXT = "Waiting for a response";

export function sharedWaitingText(detail: unknown): string {
  const text = richTextOf(detail);
  return WAITING_TEXTS.find((w) => text === w || text.startsWith(`${w}:`)) ?? DEFAULT_WAITING_TEXT;
}

function richTextOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richTextOf).join("");
  if (typeof value !== "object" || value === null) return "";
  const node = value as { readonly text?: unknown; readonly elements?: unknown };
  return (typeof node.text === "string" ? node.text : "") + richTextOf(node.elements);
}

function richText(text: string): Record<string, unknown> {
  return { elements: [{ elements: [{ text, type: "text" }], type: "rich_text_section" }], type: "rich_text" };
}

type CardRow = Readonly<Record<string, unknown>>;

const SHARED_TITLE_MAX = 80;
const SHARED_ROW_KEYS = ["type", "block_id", "task_id", "status"] as const;
const SHARED_PLAN_KEYS = ["type", "block_id"] as const;

function pick(source: CardRow, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function countTasks(n: number): string {
  return n === 1 ? "1 task" : `${String(n)} tasks`;
}

function earlierRowTitle(title: unknown): string {
  const n = typeof title === "string" ? /^(\d+) tasks? finished earlier$/u.exec(title)?.[1] : undefined;
  return n === undefined ? "Earlier tasks finished" : `${countTasks(Number(n))} finished earlier`;
}

function sharedPlanTitle(card: Pick<TaskCard, "calls" | "state">, rows: readonly CardRow[]): string {
  if (card.state === "blocked") return sharedWaitingText(rows.find((r) => r.details !== undefined)?.details);
  const n = countTasks(card.calls.filter((c) => c.taskId !== undefined).length);
  return card.state === "finished" ? `Finished ${n}` : `Working on ${n}`;
}

function redactRow(row: CardRow, calls: ReadonlyMap<string, TaskCardCall>, room: TaskCardRoom): CardRow {
  const { output: _output, details, title, ...rest } = row;
  const id = typeof row.task_id === "string" ? row.task_id : "";
  if (room === "direct-message") {
    const struck: Record<string, unknown> = { ...rest, title: redactOutboundPreview(typeof title === "string" ? title : "") };
    if (details !== undefined) struck.details = richText(redactOutboundPreview(richTextOf(details)));
    return struck;
  }
  const call = calls.get(id);
  const label = call !== undefined ? genericTaskLabel({ kind: call.kind, name: call.name }) : id === EARLIER_ROW_ID ? earlierRowTitle(title) : GENERIC_SELF_TASK_LABEL;
  const redacted: Record<string, unknown> = { ...pick(row, SHARED_ROW_KEYS), title: label.slice(0, SHARED_TITLE_MAX) };
  if (details !== undefined) redacted.details = richText(sharedWaitingText(details));
  return redacted;
}

export function confidentialTaskCardMessage(message: SlackCardMessage | null, card: Pick<TaskCard, "calls" | "state">, room: TaskCardRoom): SlackCardMessage | null {
  if (message === null) return null;
  const calls = new Map<string, TaskCardCall>(card.calls.map((c) => [slackTaskRowId(c.callId), c]));
  const titles: string[] = [];
  const blocks: SlackCardMessage["blocks"][number][] = [];
  let planTitle: string | undefined;
  for (const block of message.blocks) {
    const b = block as CardRow;
    if (b.type === "task_card") {
      const row = redactRow(b, calls, room);
      titles.push(String(row.title));
      blocks.push(row as SlackCardMessage["blocks"][number]);
    } else if (b.type === "plan" && Array.isArray(b.tasks)) {
      const tasks = (b.tasks as CardRow[]).map((t) => redactRow(t, calls, room));
      for (const t of tasks) titles.push(String(t.title));
      const title = room === "direct-message" ? (typeof b.title === "string" ? redactOutboundPreview(b.title) : undefined) : sharedPlanTitle(card, tasks);
      if (title !== undefined) planTitle = title;
      const { title: _title, tasks: _tasks, ...planRest } = b;
      const kept = room === "direct-message" ? planRest : pick(b, SHARED_PLAN_KEYS);
      blocks.push({ ...kept, tasks, ...(title === undefined ? {} : { title }) } as SlackCardMessage["blocks"][number]);
    } else if (room === "direct-message") {
      blocks.push(block);
    }
  }
  if (blocks.length === 0) return null;
  const list = titles.join(", ");
  const text = planTitle === undefined ? list : `${planTitle}: ${list}`;
  return { blocks, text: room === "direct-message" ? redactOutboundPreview(text) : text };
}

const roomSlot = defineState<TaskCardRoom | null>("open-everywhere.slack-task-card-room", () => null);

function recordTaskCardRoom(channel: Pick<SlackEventContext, "state">, ctx: unknown): void {
  const attributes = (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } | null } } } | undefined)
    ?.session?.auth?.current?.attributes;
  const state = channel.state as unknown as TaskCardRoomFacts["state"];
  const room = taskCardRoomOf({ attributes, state });
  try {
    roomSlot.update(() => room);
  } catch {
  }
}

function readTaskCardRoom(): TaskCardRoom {
  try {
    return roomSlot.get() ?? "shared";
  } catch {
    return "shared";
  }
}

export function confidentialTaskCard(
  card: TaskCard,
  next: (card: TaskCard) => SlackCardMessage | null,
  room: TaskCardRoom = readTaskCardRoom(),
): SlackCardMessage | null {
  return confidentialTaskCardMessage(next(card), card, room);
}

const RECORDING_EVENTS = [
  "interaction.opened",
  "call.requested",
  "call.settled",
  "task.started",
  "task.ended",
  "interaction.settled",
  "turn.settled",
] as const;

function recordingEvents(): SlackRendererEvents {
  const events: Record<string, unknown> = {};
  for (const name of RECORDING_EVENTS) {
    events[name] = async (_event: unknown, ctx: { readonly channel: SlackEventContext; readonly session?: unknown }, next: () => Promise<void>) => {
      recordTaskCardRoom(ctx.channel, ctx);
      await next();
    };
  }
  return events as SlackRendererEvents;
}

export const taskCardConfidentiality: SlackRenderer = {
  events: recordingEvents(),
  taskCard: (card, next) => confidentialTaskCard(card, next),
};

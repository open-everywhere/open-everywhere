import { defineState } from "eve/context";
import type {
  SlackEventContext,
  SlackRenderer,
  SlackRendererEvents,
  SlackTaskCard,
  TaskCardTask,
  TaskCardView,
} from "eve/channels/slack";

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

export function genericTaskLabel(task: Pick<TaskCardTask, "kind" | "name">): string {
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

export function confidentialTaskCardView(view: TaskCardView, room: TaskCardRoom): TaskCardView {
  const tasks = view.tasks.map((task): TaskCardTask => {
    const { summary: _summary, blockedOn, ...rest } = task;
    if (room === "direct-message") return blockedOn === undefined ? rest : { ...rest, blockedOn };
    const redacted: TaskCardTask = { ...rest, title: genericTaskLabel(task) };
    return blockedOn === undefined ? redacted : { ...redacted, blockedOn: { kind: blockedOn.kind } };
  });
  return { ...view, tasks };
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
  view: TaskCardView,
  next: (view: TaskCardView) => SlackTaskCard | null,
  room: TaskCardRoom = readTaskCardRoom(),
): SlackTaskCard | null {
  return next(confidentialTaskCardView(view, room));
}

const RECORDING_EVENTS = [
  "authorization.required",
  "actions.requested",
  "action.result",
  "task.started",
  "task.settled",
  "input.requested",
  "input.resolved",
  "authorization.completed",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
] as const;

function recordingEvents(): SlackRendererEvents {
  const events: Record<string, unknown> = {};
  for (const name of RECORDING_EVENTS) {
    events[name] = async (_data: unknown, channel: SlackEventContext, ctx: unknown, next: () => Promise<void>) => {
      recordTaskCardRoom(channel, ctx);
      await next();
    };
  }
  return events as SlackRendererEvents;
}

export const taskCardConfidentiality: SlackRenderer = {
  events: recordingEvents(),
  taskCard: (view, next) => confidentialTaskCard(view, next),
};

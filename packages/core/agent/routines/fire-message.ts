import { isJobRoutine, type Routine } from "./routine.js";
import { renderScheduledMessage, renderWatchMessage } from "./watch.js";
import { renderJobMessage } from "./job.js";

export type FireMessageInput = Pick<
  Routine,
  | "id"
  | "prompt"
  | "createdAt"
  | "lastRunAt"
  | "report"
  | "trigger"
  | "sessionMode"
  | "lastStateHash"
  | "jobState"
  | "jobTainted"
  | "policy"
>;

export function renderFireMessage(r: FireMessageInput): string {
  if (isJobRoutine(r)) return renderJobMessage(r);
  return r.trigger.kind === "watch" ? renderWatchMessage(r) : renderScheduledMessage(r);
}

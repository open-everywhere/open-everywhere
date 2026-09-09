import { isJobRoutine, type Routine } from "./routine.js";
import { renderScheduledMessage, renderWatchMessage } from "./watch.js";
import { renderJobMessage } from "./job.js";
import type { CollectedInput } from "./collector.js";

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
  | "followUps"
>;

export function renderFireMessage(r: FireMessageInput, collected: readonly CollectedInput[] = []): string {
  if (isJobRoutine(r)) return renderJobMessage(r, collected);
  return r.trigger.kind === "watch" ? renderWatchMessage(r, collected) : renderScheduledMessage(r, collected);
}

import type { TaskContinuationRefusal } from "../channels/task-provenance.js";

export type ContinuationRefusalNotifier = (input: { readonly requestId: string; readonly taskId: string; readonly reason: TaskContinuationRefusal }) => Promise<boolean>;

let registered: ContinuationRefusalNotifier | undefined;

export function registerContinuationRefusalNotifier(notify: ContinuationRefusalNotifier | undefined): void {
  registered = notify;
}

export function registeredContinuationRefusalNotifier(): ContinuationRefusalNotifier | undefined {
  return registered;
}

export const WORK_CONTINUATION_RETURNED_MESSAGE =
  "agent: this job continues a task that cannot be continued here, so it was NOT started. OE has returned the job " +
  "to the conversation as failed, and the conversation tells the people who asked. Do not retry it, and do not start it as a new task.";

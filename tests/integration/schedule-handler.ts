import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function scheduleTaskName(logicalPath: string): string {
  return `eve.schedule.${Buffer.from(logicalPath, "utf8").toString("base64url")}`;
}

export interface ScheduleHandlerLookup {
  readonly file: string | undefined;
  readonly candidates: readonly string[];
}

/**
 * Finds the compiled virtual handler that dispatches one eve schedule task. eve 1.x writes each
 * handler as `<hash>.mjs` under `server/_virtual` (eve 0.x wrote `<name>.schedule.mjs`), so the file
 * name says nothing. The handler source calls `dispatchScheduleTask("<task name>", …)`, and the
 * lookup matches that quoted name exactly, so a task whose name is a prefix of another never
 * matches the longer one.
 */
export function findScheduleHandler(virtualDir: string, taskName: string): ScheduleHandlerLookup {
  const candidates = readdirSync(virtualDir).filter((f) => f.endsWith(".mjs"));
  const quoted = JSON.stringify(taskName);
  const file = candidates.find((f) => readFileSync(join(virtualDir, f), "utf8").includes(`dispatchScheduleTask(${quoted}`));
  return { file, candidates };
}

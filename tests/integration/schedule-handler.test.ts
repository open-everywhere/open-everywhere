import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { findScheduleHandler, scheduleTaskName } from "./schedule-handler";

function handlerSource(taskName: string): string {
  return [
    'import { dispatchScheduleTask } from "../_libs/eve.mjs";',
    'import { route_config_default } from "./route-config.mjs";',
    "var handler_default = {",
    "  async run(event) {",
    `    return { result: await dispatchScheduleTask(${JSON.stringify(taskName)}, route_config_default) };`,
    "  }",
    "};",
    "export { handler_default as default };",
    "",
  ].join("\n");
}

test("the lookup finds an eve 1.x handler by the task name in its source, not by its file name", () => {
  const dir = mkdtempSync(join(tmpdir(), "oe-it-schedule-handler-"));
  const dispatch = scheduleTaskName("schedules/dispatch.ts");
  writeFileSync(join(dir, "e302188f4b044c94.mjs"), handlerSource(dispatch));
  writeFileSync(join(dir, "9b4a54be9f51c220.mjs"), handlerSource(scheduleTaskName("schedules/tidy.ts")));
  writeFileSync(join(dir, "route-config.mjs"), "export const route_config_default = {};\n");

  expect(findScheduleHandler(dir, dispatch).file).toBe("e302188f4b044c94.mjs");
  expect(findScheduleHandler(dir, scheduleTaskName("schedules/tidy.ts")).file).toBe("9b4a54be9f51c220.mjs");
  expect(findScheduleHandler(dir, scheduleTaskName("schedules/absent.ts")).file).toBeUndefined();
});

test("NEGATIVE CONTROL — a task name that is a prefix of another task's name does not match the longer one", () => {
  const dir = mkdtempSync(join(tmpdir(), "oe-it-schedule-handler-"));
  const long = scheduleTaskName("schedules/dispatch.ts");
  writeFileSync(join(dir, "0000000000000001.mjs"), handlerSource(long));
  const prefix = long.slice(0, -4);
  expect(long.startsWith(prefix)).toBe(true);
  expect(findScheduleHandler(dir, prefix).file).toBeUndefined();
});

test("every app schedule has a compiled handler in the built tree the tier boots", () => {
  const virtualDir = join(process.cwd(), ".output", "server", "_virtual");
  const schedules = readdirSync(join(process.cwd(), "agent", "schedules")).filter((f) => f.endsWith(".ts"));
  expect(schedules.length, "the app declares schedules").toBeGreaterThan(0);
  const missing = schedules.filter((f) => findScheduleHandler(virtualDir, scheduleTaskName(`schedules/${f}`)).file === undefined);
  expect(missing, `schedules with no compiled handler in ${virtualDir}`).toEqual([]);
});

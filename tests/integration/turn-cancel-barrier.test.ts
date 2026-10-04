import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { isTurnCancelHookToken } from "./harness";

const EVE_EXECUTION = join(process.cwd(), "node_modules", "eve", "dist", "src", "execution");

test("the barrier's token shape is the one eve's session driver and cancel hook build", async () => {
  const { turnCancellationHookToken } = (await import(pathToFileURL(join(EVE_EXECUTION, "turn-cancellation-token.js")).href)) as {
    turnCancellationHookToken: (controlToken: string) => string;
  };
  const driver = readFileSync(join(EVE_EXECUTION, "workflow-entry.js"), "utf8");
  expect(driver, "eve's session driver no longer builds `<sessionId>:turn-control:<n>` — update isTurnCancelHookToken").toContain(
    "sessionId}:turn-control:${String(",
  );

  const sessionId = "wrun_example66";
  for (const n of [0, 1, 17]) {
    expect(isTurnCancelHookToken(turnCancellationHookToken(`${sessionId}:turn-control:${n}`), sessionId)).toBe(true);
  }
});

test("NEGATIVE CONTROLS — the barrier never matches another session's cancel or another hook", () => {
  const sessionId = "wrun_example66";
  expect(isTurnCancelHookToken("wrun_OTHER:turn-control:0:cancel", sessionId)).toBe(false);
  expect(isTurnCancelHookToken(`${sessionId}X:turn-control:0:cancel`, sessionId)).toBe(false);
  expect(isTurnCancelHookToken(`${sessionId}:turn-control:0`, sessionId)).toBe(false);
  expect(isTurnCancelHookToken(`eve:session:${sessionId}:inbox`, sessionId)).toBe(false);
  expect(isTurnCancelHookToken(`${sessionId}:turn-control:x:cancel`, sessionId)).toBe(false);
  expect(isTurnCancelHookToken(`${sessionId}:turn-control::cancel`, sessionId)).toBe(false);
  expect(isTurnCancelHookToken(undefined, sessionId)).toBe(false);
});

import { expect, test } from "vitest";

import { GLOBAL_SETUP_PID_ENV, INTEGRATION_SANDBOX_BACKEND } from "./global-setup-contract";

const AT_LOAD = {
  memoryDir: process.env.OE_MEMORY_DIR,
  pgliteDir: process.env.OE_PGLITE_DIR,
  sandboxBackend: process.env.OE_SANDBOX_BACKEND,
  setupPid: process.env[GLOBAL_SETUP_PID_ENV],
  skipBuild: process.env.OE_IT_SKIP_BUILD,
} as const;

const MODE = AT_LOAD.skipBuild === "1" ? "OE_IT_SKIP_BUILD=1" : "full run";

test("a fork really does inherit the global setup's environment — the positive control", () => {
  expect(AT_LOAD.setupPid).toBe(String(process.ppid));
});

test("both run modes hand the forks the SAME sandbox backend", () => {
  expect(`${MODE}: ${AT_LOAD.sandboxBackend}`).toBe(`${MODE}: ${INTEGRATION_SANDBOX_BACKEND}`);
});

test("the global setup leaks NO state directory into the forks (OPE-582)", () => {
  expect(AT_LOAD.memoryDir).toBeUndefined();
  expect(AT_LOAD.pgliteDir).toBeUndefined();
});

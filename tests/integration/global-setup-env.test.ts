import { expect, test } from "vitest";

const AT_LOAD = {
  memoryDir: process.env.OE_MEMORY_DIR,
  pgliteDir: process.env.OE_PGLITE_DIR,
  sandboxBackend: process.env.OE_SANDBOX_BACKEND,
  skipBuild: process.env.OE_IT_SKIP_BUILD,
} as const;

test("a fork really does inherit the global setup's environment — the positive control", () => {
  if (AT_LOAD.skipBuild === "1") {
    expect(AT_LOAD.sandboxBackend).toBeUndefined();
    return;
  }
  expect(AT_LOAD.sandboxBackend).toBe("justbash");
});

test("the global setup leaks NO state directory into the forks (OPE-582)", () => {
  expect(AT_LOAD.memoryDir).toBeUndefined();
  expect(AT_LOAD.pgliteDir).toBeUndefined();
});

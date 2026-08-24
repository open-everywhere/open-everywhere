import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    isolate: true,
    env: { NODE_ENV: "" },
    sequence: { concurrent: false },
    testTimeout: 480_000,
    hookTimeout: 300_000,
    maxWorkers: 2,
    globalSetup: ["tests/integration/global-setup.ts"],
    setupFiles: ["tests/integration/setup-fork-app-root.ts"],
    onUnhandledError(error: unknown): boolean | void {
      const e = error as { message?: string; stack?: string };
      if (e?.message === "e is not a function" && (e.stack ?? "").includes("eve+zod.mjs")) return false;
    },
  },
});

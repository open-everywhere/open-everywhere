import { defineConfig } from "vitest/config";

import { integrationMaxWorkers } from "./scripts/ci-max-workers.js";
import { INTEGRATION_INCLUDE_GLOBS } from "./scripts/it-shards.js";

export default defineConfig({
  test: {
    include: [...INTEGRATION_INCLUDE_GLOBS],
    pool: "forks",
    fileParallelism: true,
    isolate: true,
    env: { NODE_ENV: "" },
    sequence: { concurrent: false },
    testTimeout: 480_000,
    hookTimeout: 300_000,
    maxWorkers: integrationMaxWorkers(),
    execArgv: ["--max-old-space-size=1536"],
    disableConsoleIntercept: true,
    server: {
      deps: {
        external: [/\.output\/server\//, /\/packages\/(?:[^/]+\/)*dist\//],
      },
    },
    globalSetup: ["tests/integration/global-setup.ts"],
    setupFiles: ["tests/integration/setup-fork-app-root.ts"],
    onUnhandledError(error: unknown): boolean | void {
      const e = error as { message?: string; stack?: string };
      if (e?.message === "e is not a function" && (e.stack ?? "").includes("eve+zod.mjs")) return false;
    },
  },
});

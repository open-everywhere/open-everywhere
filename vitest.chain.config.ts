import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/chain/*.spec.ts"],
    pool: "forks",
    isolate: true,
    sequence: { concurrent: false },
    env: { NODE_NO_WARNINGS: "1" },
    setupFiles: ["./scripts/chain/_setup.ts"],
    server: { deps: { inline: [/@open-everywhere\//] } },
    maxWorkers: 4,
    minWorkers: 1,
    silent: "passed-only",
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});

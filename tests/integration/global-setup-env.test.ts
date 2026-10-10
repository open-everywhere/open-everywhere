import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { GLOBAL_SETUP_PID_ENV, INTEGRATION_SANDBOX_BACKEND, PGLITE_TEMPLATE_DIR_ENV, PREPARED_PGLITE_TEMPLATE_PARENT } from "./global-setup-contract";
import { PGLITE_TEMPLATE_DIR_NAME } from "./pglite-template.js";

const AT_LOAD = {
  memoryDir: process.env.OE_MEMORY_DIR,
  pgliteDir: process.env.OE_PGLITE_DIR,
  setupPid: process.env[GLOBAL_SETUP_PID_ENV],
  skipBuild: process.env.OE_IT_SKIP_BUILD,
  pgliteTemplate: process.env[PGLITE_TEMPLATE_DIR_ENV],
} as const;

const MODE = AT_LOAD.skipBuild === "1" ? "OE_IT_SKIP_BUILD=1" : "full run";

test("a fork really does inherit the global setup's environment — the positive control", () => {
  expect(AT_LOAD.setupPid).toBe(String(process.ppid));
});

test(`${MODE}: both run modes boot the SAME sandbox backend — the app's committed declaration`, async () => {
  const { SETTINGS_OVERRIDES } = await import("../../agent/settings/settings.js");
  expect(SETTINGS_OVERRIDES.sandbox?.selfHostBackend).toBe(INTEGRATION_SANDBOX_BACKEND);
});

test("the global setup leaks NO state directory into the forks (OPE-582)", () => {
  expect(AT_LOAD.memoryDir).toBeUndefined();
  expect(AT_LOAD.pgliteDir).toBeUndefined();
});

test("a shard reuses the prepare step's PGlite template and never mints its own (OPE-2235)", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const prepared = join(repoRoot, PREPARED_PGLITE_TEMPLATE_PARENT, PGLITE_TEMPLATE_DIR_NAME);
  const handed = AT_LOAD.pgliteTemplate as string;
  expect(handed, `${MODE}: the template path reached this fork`).toBeDefined();
  if (existsSync(join(prepared, "PG_VERSION"))) {
    expect(handed, `${MODE}: the fork was handed the PREPARED template, not a per-shard mint`).toBe(prepared);
  } else {
    expect(handed.startsWith(prepared), `${MODE}: with no prepared template, this process minted its own`).toBe(false);
    expect(existsSync(join(handed, "PG_VERSION")), `${MODE}: …and that mint is a real bootstrapped cluster`).toBe(true);
  }
});

test("the global setup hands every fork its migrated PGlite template (OPE-2239)", () => {
  expect(AT_LOAD.pgliteTemplate, `${MODE}: the template path reached this fork`).toBeDefined();
  const template = AT_LOAD.pgliteTemplate as string;
  expect(basename(template), "it is the template directory, not the state dir around it").toBe(PGLITE_TEMPLATE_DIR_NAME);
  expect(existsSync(template), `${MODE}: ${template} exists`).toBe(true);
  expect(existsSync(join(template, "PG_VERSION")), `${template} holds a bootstrapped cluster`).toBe(true);
});

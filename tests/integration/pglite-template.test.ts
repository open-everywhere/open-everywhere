import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { bootAgent, pgliteFloorSeededFromTemplateForTest } from "./harness";
import { PGLITE_TEMPLATE_DIR_ENV } from "./global-setup-contract";
import { copyPgliteTemplateInto } from "./pglite-template";
import { FIXTURE_DIR_PREFIX, scratchDir } from "./temp-dir-fixtures";

test("a copy of the template opens without initdb and already holds the operational schema", async () => {
  const dest = join(scratchDir(`${FIXTURE_DIR_PREFIX}pglite-tmpl-`), "pglite");

  expect(copyPgliteTemplateInto(dest), "the template was there and was copied").toBe(true);
  expect(existsSync(join(dest, "PG_VERSION")), "the copy carries a bootstrapped cluster").toBe(true);

  expect(existsSync(`${dest}.lock`), "the copy brought no single-writer lock with it").toBe(false);

  const { openOperationalPglite } = await import("@open-everywhere/core/agent/operational/pglite-client.js");
  const open = await openOperationalPglite(dest);
  try {
    expect(existsSync(`${dest}.lock`), "the open takes its lock at the SIBLING path — which is why the copy carried none").toBe(true);
    const { rows } = await open.client.query(`SELECT to_regclass('audit_entry') IS NOT NULL AS present`);
    expect((rows[0] as { present: boolean } | undefined)?.present, "`audit_entry` exists on the copy before any schema init").toBe(true);
  } finally {
    await open.close();
  }
}, 120_000);

test("a template that is not there copies nothing and says so", () => {
  const dest = join(scratchDir(`${FIXTURE_DIR_PREFIX}pglite-absent-`), "pglite");
  const before = process.env[PGLITE_TEMPLATE_DIR_ENV];
  process.env[PGLITE_TEMPLATE_DIR_ENV] = join(dest, "..", "no-such-template");
  try {
    expect(copyPgliteTemplateInto(dest), "an absent template is not a copy").toBe(false);
    expect(existsSync(dest), "and it created nothing at the destination").toBe(false);
  } finally {
    if (before === undefined) delete process.env[PGLITE_TEMPLATE_DIR_ENV];
    else process.env[PGLITE_TEMPLATE_DIR_ENV] = before;
  }
});

test("a real boot seeds its PGlite floor from the template, not from an empty directory", async () => {
  expect(pgliteFloorSeededFromTemplateForTest(), "nothing has booted in this fork yet").toBeUndefined();
  await bootAgent();
  expect(pgliteFloorSeededFromTemplateForTest(), "🔴 the boot copied the template into its own state dir").toBe(true);
  const booted = process.env.OE_PGLITE_DIR;
  expect(booted, "the boot published its PGlite dir").toBeDefined();
  expect(existsSync(join(booted as string, "PG_VERSION")), `${booted} holds a bootstrapped cluster`).toBe(true);
}, 300_000);

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { expect, test } from "vitest";

import { bootAgent, pgliteFloorSeededFromTemplateForTest } from "./harness";
import { PGLITE_TEMPLATE_DIR_ENV } from "./global-setup-contract";
import { copyPgliteTemplateInto } from "./pglite-template";
import { STATE_DIR_MARKER, STATE_DIR_PREFIX, sweepAbandonedStateDirs } from "./state-dir";
import { aPidThatHasExited, FIXTURE_DIR_MARKER, FIXTURE_DIR_PREFIX, scratchDir } from "./temp-dir-fixtures";

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

function plantStateDir(scratch: string, name: string, pid: number): string {
  const dir = join(scratch, `${STATE_DIR_PREFIX}${name}`);
  mkdirSync(join(dir, "pglite"), { recursive: true });
  writeFileSync(join(dir, "pglite", "base.db"), "rows", "utf8");
  writeFileSync(join(dir, STATE_DIR_MARKER), `${pid}\n`, "utf8");
  return dir;
}

test("a booted fork's PGlite and memory stores sit in a MARKED state directory this fork owns", async () => {
  await bootAgent();
  const pgliteDir = process.env.OE_PGLITE_DIR;
  expect(pgliteDir).toBeDefined();
  const stateDir = dirname(pgliteDir as string);
  expect(basename(stateDir).startsWith(STATE_DIR_PREFIX)).toBe(true);

  const marker = join(stateDir, STATE_DIR_MARKER);
  expect(lstatSync(marker).isFile()).toBe(true);
  expect(Number.parseInt(readFileSync(marker, "utf8").trim(), 10)).toBe(process.pid);
  expect(process.env.OE_MEMORY_DIR).toBe(join(stateDir, "memory"));
});

test("the sweep reclaims an abandoned run's state directory and spares a LIVE run's (OPE-1165)", () => {
  const scratch = scratchDir("oe-it-fixture-state-sweep-");
  const live = plantStateDir(scratch, "live", process.pid);
  const abandoned = plantStateDir(scratch, "abandoned", aPidThatHasExited());

  expect(sweepAbandonedStateDirs(scratch)).toBe(1);
  expect(existsSync(abandoned)).toBe(false);
  expect(existsSync(join(live, "pglite", "base.db"))).toBe(true);

  writeFileSync(join(live, STATE_DIR_MARKER), `${aPidThatHasExited()}\n`, "utf8");
  expect(sweepAbandonedStateDirs(scratch)).toBe(1);
  expect(existsSync(live)).toBe(false);
  expect(sweepAbandonedStateDirs(scratch)).toBe(0);
});

test("a marker that names no PID keeps the directory — every uncertain answer is 'still running'", () => {
  const scratch = scratchDir("oe-it-fixture-state-unreadable-");
  const unparseable = plantStateDir(scratch, "unparseable", aPidThatHasExited());
  writeFileSync(join(unparseable, STATE_DIR_MARKER), "", "utf8");
  const garbled = plantStateDir(scratch, "garbled", aPidThatHasExited());
  writeFileSync(join(garbled, STATE_DIR_MARKER), "not-a-pid\n", "utf8");

  expect(sweepAbandonedStateDirs(scratch)).toBe(0);
  expect(existsSync(unparseable)).toBe(true);
  expect(existsSync(garbled)).toBe(true);

  const retired = `${aPidThatHasExited()}\n`;
  writeFileSync(join(unparseable, STATE_DIR_MARKER), retired, "utf8");
  writeFileSync(join(garbled, STATE_DIR_MARKER), retired, "utf8");
  expect(sweepAbandonedStateDirs(scratch)).toBe(2);
  expect(existsSync(unparseable)).toBe(false);
  expect(existsSync(garbled)).toBe(false);
});

test("a scratch fixture tree is marked and sweepable too — no unmarked temp directory is left", () => {
  const scratch = scratchDir("oe-it-fixture-state-marked-");
  expect(lstatSync(join(scratch, FIXTURE_DIR_MARKER)).isFile()).toBe(true);
  expect(Number.parseInt(readFileSync(join(scratch, FIXTURE_DIR_MARKER), "utf8").trim(), 10)).toBe(process.pid);
  expect(() => scratchDir("oe-it-not-a-fixture-")).toThrow(/must start with/);
});

test("the sweep identifies by MARKER, never by name — the shared temp directory is not ours", () => {
  const scratch = scratchDir("oe-it-fixture-state-marker-");
  const unmarked = join(scratch, `${STATE_DIR_PREFIX}not-ours`);
  mkdirSync(unmarked);
  writeFileSync(join(unmarked, "someone-elses.txt"), "keep", "utf8");
  const differentName = join(scratch, "unrelated-dir");
  mkdirSync(differentName);
  writeFileSync(join(differentName, "keep.txt"), "keep", "utf8");
  const abandoned = plantStateDir(scratch, "abandoned", aPidThatHasExited());

  expect(sweepAbandonedStateDirs(scratch)).toBe(1);

  expect(existsSync(abandoned)).toBe(false);
  expect(existsSync(join(unmarked, "someone-elses.txt"))).toBe(true);
  expect(existsSync(join(differentName, "keep.txt"))).toBe(true);
});

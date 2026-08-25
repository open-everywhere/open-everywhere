import { chmodSync, existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { JUST_BASH_SESSIONS_RELPATH, sweepStaleSandboxSessions } from "./sandbox-session-sweep";

test("sweepStaleSandboxSessions collects a stale session, leaves the current run and templates/ alone", () => {
  const root = mkdtempSync(join(tmpdir(), "oe-it-fixture-sandbox-sweep-"));
  const sessionsDir = join(root, JUST_BASH_SESSIONS_RELPATH);
  mkdirSync(sessionsDir, { recursive: true });

  const stale = join(sessionsDir, "eve-sbx-ses-just-bash-aaa-bbb-wrun_01STALEXXXXXXXXXXXXXXXXXXX-__root__");
  mkdirSync(stale);
  writeFileSync(join(stale, "workspace.txt"), "an earlier run's workspace", "utf8");
  const past = (Date.now() - 60_000) / 1000;
  utimesSync(stale, past, past);

  const now = Date.now();

  const current = join(sessionsDir, "eve-sbx-ses-just-bash-ccc-ddd-wrun_01CURRENTXXXXXXXXXXXXXXX-__root__");
  mkdirSync(current);
  writeFileSync(join(current, "workspace.txt"), "the in-flight run's workspace", "utf8");
  const future = (now + 60_000) / 1000;
  utimesSync(current, future, future);

  const templatesDir = join(root, ".eve", "sandbox-cache", "just-bash", "templates");
  const templateEntry = join(templatesDir, "some-template-key");
  mkdirSync(templateEntry, { recursive: true });
  writeFileSync(join(templateEntry, "seed.txt"), "the prewarmed template — never a sweep target", "utf8");

  expect(existsSync(stale)).toBe(true);

  expect(sweepStaleSandboxSessions(root, now)).toBe(1);

  expect(existsSync(stale)).toBe(false);
  expect(existsSync(current)).toBe(true);
  expect(existsSync(join(current, "workspace.txt"))).toBe(true);
  expect(existsSync(templateEntry)).toBe(true);
  expect(existsSync(join(templateEntry, "seed.txt"))).toBe(true);

  expect(sweepStaleSandboxSessions(root, now)).toBe(0);
});

test.skipIf(process.getuid?.() === 0)("sweepStaleSandboxSessions clears a stale session even when it ships a read-only subtree", () => {
  const root = mkdtempSync(join(tmpdir(), "oe-it-fixture-sandbox-sweep-readonly-"));
  const sessionsDir = join(root, JUST_BASH_SESSIONS_RELPATH);
  mkdirSync(sessionsDir, { recursive: true });

  const stale = join(sessionsDir, "eve-sbx-ses-just-bash-eee-fff-wrun_01STALERODIRXXXXXXXXXXXX-__root__");
  const lockedSubdir = join(stale, "fs", "workspace", "memory");
  mkdirSync(lockedSubdir, { recursive: true });
  writeFileSync(join(lockedSubdir, "MEMORY.md"), "a locked-down fixture file", "utf8");
  chmodSync(join(lockedSubdir, "MEMORY.md"), 0o444);
  chmodSync(lockedSubdir, 0o555);
  const past = (Date.now() - 60_000) / 1000;
  utimesSync(stale, past, past);

  const now = Date.now();

  expect(existsSync(stale)).toBe(true);
  expect(sweepStaleSandboxSessions(root, now)).toBe(1);
  expect(existsSync(stale)).toBe(false);
});

test("sweepStaleSandboxSessions returns 0, without throwing, when sessions/ was never minted", () => {
  const root = mkdtempSync(join(tmpdir(), "oe-it-fixture-sandbox-sweep-empty-"));
  expect(sweepStaleSandboxSessions(root, Date.now())).toBe(0);
  expect(existsSync(join(root, JUST_BASH_SESSIONS_RELPATH))).toBe(false);
});

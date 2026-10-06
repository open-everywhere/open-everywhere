import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WIN32_EXIT_ABORT_ASSERTION,
  WIN32_EXIT_ABORT_LEGS,
  WIN32_EXIT_ABORT_TICKET,
  win32ExitAbortSkipLine,
} from "./win32-exit-abort.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LEG_FILES: Record<(typeof WIN32_EXIT_ABORT_LEGS)[number], string> = {
  "test:deploy": "scripts/deploy-test.ts",
  "test:egress-proxy-boot": "deploy/egress-proxy/control/server-boot-test.ts",
};

const lf = (text: string): string => text.replace(/\r\n/g, "\n");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

for (const leg of WIN32_EXIT_ABORT_LEGS) {
  ok(win32ExitAbortSkipLine(leg, "linux") === null, `${leg}: the skip line is null on linux, so the leg runs and gates`);
  ok(win32ExitAbortSkipLine(leg, "darwin") === null, `${leg}: the skip line is null on darwin`);
  if (process.platform !== "win32") {
    ok(win32ExitAbortSkipLine(leg) === null, `${leg}: the default reads this host (${process.platform}), so the skip line is null here`);
  }
}

for (const leg of WIN32_EXIT_ABORT_LEGS) {
  const line = win32ExitAbortSkipLine(leg, "win32");
  ok(line !== null, `${leg}: win32 gets a skip line`);
  ok(line!.includes(WIN32_EXIT_ABORT_ASSERTION), `${leg}: the win32 skip line names the libuv assertion`);
  ok(line!.includes("UV_HANDLE_CLOSING") && line!.includes("async.c:94"), `${leg}: the assertion text is the one OPE-2287 measured`);
  ok(line!.includes(WIN32_EXIT_ABORT_TICKET), `${leg}: the win32 skip line names ${WIN32_EXIT_ABORT_TICKET}`);
  ok(line!.includes(leg), `${leg}: the win32 skip line names the leg`);
}

function checkLeg(leg: (typeof WIN32_EXIT_ABORT_LEGS)[number], label: string, raw: string): void {
  const src = lf(raw);
  const call = `win32ExitAbortSkipLine("${leg}")`;
  ok(src.includes(call), `${label} calls ${call} — its own leg name, no platform argument`);
  ok(!/win32ExitAbortSkipLine\([^)]*,/.test(src), `${label} passes no platform argument, so the host decides`);
  const guard = `const win32Skip = ${call};\nif (win32Skip) {\n  console.log(win32Skip);\n  process.exit(0);\n}\n`;
  const guardAt = src.indexOf(guard);
  ok(guardAt >= 0, `${label} carries the exact guard block: bind the line, and exit only when it is not null`);
  ok(src.split("win32Skip").length - 1 === 3, `${label} names win32Skip exactly three times — the guard block only`);
  const before = src
    .slice(0, guardAt)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/^import\s[^;]*;/gm, "");
  ok(before.trim() === "", `${label}: only imports and comments come before the guard, so no statement runs first`);
}

for (const leg of WIN32_EXIT_ABORT_LEGS) {
  const file = LEG_FILES[leg];
  const raw = readFileSync(join(ROOT, file), "utf8");
  checkLeg(leg, file, raw);
  checkLeg(leg, `${file} (CRLF checkout)`, lf(raw).replace(/\n/g, "\r\n"));
}

const SPECIFIER = `(from|import\\(|require\\()\\s*["'][^"']*/win32-exit-abort(\\.js|\\.ts)?["']`;
const importers = execFileSync("git", ["grep", "-l", "-E", SPECIFIER], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => f !== "scripts/win32-exit-abort-test.ts")
  .sort();
assert.deepEqual(importers, Object.values(LEG_FILES).sort(), "only test:deploy and test:egress-proxy-boot may skip on win32 (OPE-2287)");
n++;

console.log(`✓ win32 exit-abort skip: ${n} assertions passed (null off win32, the win32 line names the libuv defect and ${WIN32_EXIT_ABORT_TICKET}, both legs keyed on the host platform, no third caller)`);

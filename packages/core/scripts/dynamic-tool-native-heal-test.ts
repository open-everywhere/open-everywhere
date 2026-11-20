import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-native-heal-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import { WINDOW_GATED_TOOLS } from "../agent/access/window-gate-manifest.js";
import { offeredSeat, type SavedMemos, type SeatResult } from "./_dynamic-heal-seat.js";
import type { WindowGrain } from "../agent/identity/binding.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = join(here, "../agent/tools");
const scratch = mkdtempSync(join(tmpdir(), "oe-native-heal-req-"));

const FRAMEWORK_GATED = new Set(["agent"]);
const MOUNT_GATED = new Set(["cancel_work", "checkout_repo", "open_pull_request", "spawn_thread_session", "work"]);

const gatedFiles = readdirSync(toolsDir)
  .filter((f) => f.endsWith(".ts") && /\bwindowGated(?:Kit)?\s*\(/.test(readFileSync(join(toolsDir, f), "utf8")))
  .sort();

console.log("0. the inventory:");
{
  const mountGatedFiles = gatedFiles.filter((f) => /\}\),\s*\w+\s*,?\s*\);\s*$/m.test(readFileSync(join(toolsDir, f), "utf8"))).map((f) => f.replace(/\.ts$/, ""));
  eq(mountGatedFiles.sort(), [...MOUNT_GATED].sort(), "exactly the declared tools carry a mount gate beyond the grain row (a new gate needs a row here)");
  ok(gatedFiles.length > 0, `the scan found the window-gated tool files (${gatedFiles.length})`);
}

function expectedOn(grain: WindowGrain): string[] {
  return Object.keys(WINDOW_GATED_TOOLS)
    .filter((name) => !FRAMEWORK_GATED.has(name) && !MOUNT_GATED.has(name) && WINDOW_GATED_TOOLS[name].includes(grain))
    .sort();
}

function freshProcess(grain: WindowGrain, sessionId: string, memos: SavedMemos): SeatResult {
  const path = join(scratch, `${grain}-${sessionId}.json`);
  writeFileSync(path, JSON.stringify({ files: gatedFiles, grain, memos, sessionId, toolsDir }));
  const out = execFileSync(process.execPath, ["--import", "tsx", join(here, "_dynamic-heal-seat.ts"), "--child", path], {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  const line = out.split("\n").find((l) => l.startsWith("SEAT "));
  assert.ok(line !== undefined, `the fresh process printed its seat (${grain})`);
  return JSON.parse(line.slice("SEAT ".length)) as SeatResult;
}

const GRAINS: readonly WindowGrain[] = ["task", "standing", "thread"];

console.log("1. a fresh process offers the same window-gated tools on its first model call:");
for (const grain of GRAINS) {
  const sessionId = `sess-heal-${grain}`;
  const first = await offeredSeat(toolsDir, { files: gatedFiles, grain, memos: {}, sessionId });
  eq(first.offered.filter((name) => !MOUNT_GATED.has(name)), expectedOn(grain), `[${grain}] the first process offers every manifest tool for this grain`);
  ok(first.offered.every((name) => WINDOW_GATED_TOOLS[name]?.includes(grain) === true), `🔴 [${grain}] …and nothing off this grain's rows: a mount gate can only narrow the seat`);
  const fresh = freshProcess(grain, sessionId, first.memos);
  eq(fresh.offered, first.offered, `🔴 [${grain}] a FRESH process, given only the saved memos, offers the same tools on its first model call`);
  eq(fresh.memos, first.memos, `[${grain}] …and it reads the saved seat decisions without writing new ones`);
}

console.log("2. the saved seat decides, not the fresh process's own context:");
{
  const taskSeat = await offeredSeat(toolsDir, { files: gatedFiles, grain: "task", memos: {}, sessionId: "sess-heal-pinned" });
  const fresh = freshProcess("standing", "sess-heal-pinned", taskSeat.memos);
  eq(fresh.offered, taskSeat.offered, "a fresh process whose context reads as a standing seat still offers the TASK seat the session started with");
  const cold = freshProcess("standing", "sess-heal-cold", {});
  eq(cold.offered.filter((name) => !MOUNT_GATED.has(name)), expectedOn("standing"), "NEGATIVE CONTROL: with no saved memo the fresh process derives the standing seat, and the wide hands stay withheld");
  ok(!cold.offered.includes("bash") && !cold.offered.includes("read_file"), "…so a standing seat never gains a sandbox tool");
}

console.log(`\n✓ dynamic-tool-native-heal: ${n} assertions passed.`);

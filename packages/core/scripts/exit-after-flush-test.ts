import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const CORE = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = pathToFileURL(join(CORE, "scripts", "exit-after-flush.ts")).href;
const LAST = "THE-LAST-LINE";
const BYTES = 2 * 1024 * 1024;

function lateReader(dir: string, exit: "flush" | "bare"): Promise<{ code: number | null; out: string }> {
  const file = join(dir, `child-${exit}.mts`);
  writeFileSync(
    file,
    `import { exitAfterFlush } from ${JSON.stringify(MODULE)};\n` +
      `process.stdout.write("x".repeat(${BYTES}) + "\\n");\n` +
      `console.log(${JSON.stringify(LAST)});\n` +
      (exit === "flush" ? "await exitAfterFlush(3);\n" : "process.exit(3);\n"),
  );
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", file], { cwd: CORE, stdio: ["ignore", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stdout.pause();
    const start = exit === "flush" ? setTimeout(() => child.stdout.resume(), 1_500) : undefined;
    child.on("exit", () => {
      clearTimeout(start);
      child.stdout.resume();
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code, out: Buffer.concat(chunks).toString("utf8") }));
  });
}

const dir = mkdtempSync(join(tmpdir(), "exit-after-flush-test-"));
try {
  const bare = await lateReader(dir, "bare");
  ok(bare.code === 3, `the bare-exit child exits 3 — got ${bare.code}`);
  ok(
    !bare.out.includes(LAST) && bare.out.length < BYTES,
    `🔴 negative control: a bare process.exit drops the queued tail — got ${bare.out.length} bytes, last line ${bare.out.includes(LAST) ? "present" : "absent"}`,
  );

  const flushed = await lateReader(dir, "flush");
  ok(flushed.code === 3, `exitAfterFlush(3) exits with its own code — got ${flushed.code}`);
  ok(flushed.out.length === BYTES + 1 + LAST.length + 1, `exitAfterFlush keeps every byte for a late reader — got ${flushed.out.length} of ${BYTES + LAST.length + 2}`);
  ok(flushed.out.endsWith(`${LAST}\n`), "…and the last line arrives last");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const runner = readFileSync(join(CORE, "scripts", "e2e", "runner.ts"), "utf8");
ok(runner.includes('import { exitAfterFlush } from "../exit-after-flush.js";'), "the e2e runner imports exitAfterFlush");
ok(!/\bprocess\.exit\(/.test(runner), "🔴 the e2e runner has no bare process.exit — it prints its board last, so a bare exit can drop the board's tail");
const cli = readFileSync(join(CORE, "scripts", "oe-cli.ts"), "utf8");
ok(cli.includes('import { exitAfterFlush } from "./exit-after-flush.js";'), "oe-cli.ts uses the shared exitAfterFlush, not a copy");

console.log(`✓ exit-after-flush-test: ${n} assertions passed`);

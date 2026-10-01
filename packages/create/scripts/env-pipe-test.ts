import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const SCRIPT = fileURLToPath(new URL("../template/scripts/env-pipe.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "oe-env-pipe-"));
const SECRET = "s3cr3t-fixture-value";
writeFileSync(
  join(dir, ".env.local"),
  [
    `PLAIN=${SECRET}`,
    `DOUBLE="${SECRET}"`,
    `SINGLE='${SECRET}'`,
    `COMMENTED=${SECRET} # a note`,
    `export EXPORTED=${SECRET}`,
    `QUOTED_HASH="${SECRET} #kept"`,
    "EMPTY=",
    "",
  ].join("\n"),
);

const piped = (arg: string) => spawnSync(process.execPath, [SCRIPT, arg], { cwd: dir, encoding: "utf8" });

try {
  for (const name of ["PLAIN", "DOUBLE", "SINGLE", "COMMENTED", "EXPORTED"]) {
    const r = piped(name);
    ok(r.status === 0 && r.stdout === SECRET, `${name}: the pipe carries exactly the bare value, as eve reads it (got ${JSON.stringify(r.stdout)})`);
  }
  if (process.platform !== "win32") {
    const viaShell = spawnSync("/bin/sh", ["-c", `"${process.execPath}" "${SCRIPT}" PLAIN | cat`], { cwd: dir, encoding: "utf8" });
    ok(viaShell.status === 0 && viaShell.stdout === SECRET, `a shell pipe (a FIFO) carries the value (got ${JSON.stringify(viaShell.stdout)}, stderr ${JSON.stringify(viaShell.stderr)})`);
  }
  ok(piped("QUOTED_HASH").stdout === `${SECRET} #kept`, "a # inside quotes is part of the value");
  const literal = piped("OE_MEMORY_PROVIDER=postgres");
  ok(literal.status === 0 && literal.stdout === "postgres", "NAME=value sends the literal value with no newline");
  ok(piped("EMPTY").status !== 0 && piped("MISSING").status !== 0, "an empty or absent name exits non-zero");
  ok(piped("lower").status !== 0, "a name that is not an env var name is refused");

  const outPath = join(dir, "out.txt");
  const fd = openSync(outPath, "w");
  let bare;
  try {
    bare = spawnSync(process.execPath, [SCRIPT, "PLAIN"], { cwd: dir, encoding: "utf8", stdio: ["ignore", fd, "pipe"] });
  } finally {
    closeSync(fd);
  }
  ok(bare.status !== 0, "stdout on a regular file: refused with a non-zero exit");
  ok(readFileSync(outPath, "utf8") === "", "…and no byte of the value is written");
  ok(!bare.stderr.includes(SECRET) && /pipe/.test(bare.stderr), "…and the refusal names the pipe, not the value");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`✓ env-pipe: ${n} assertions passed (pipe-only, parseEnv-exact values)`);

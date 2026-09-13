#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

let tsxCli;
try {
  const tsxPkgPath = require.resolve("tsx/package.json");
  const tsxPkg = JSON.parse(readFileSync(tsxPkgPath, "utf8"));
  const tsxBin = typeof tsxPkg.bin === "string" ? tsxPkg.bin : tsxPkg.bin?.tsx;
  if (typeof tsxBin !== "string") throw new Error(`tsx@${tsxPkg.version} declares no usable "bin" entry`);
  tsxCli = join(dirname(tsxPkgPath), tsxBin);
} catch (err) {
  console.error("create-open-everywhere: could not resolve its `tsx` dependency — try `npm install` in this package first.");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const cliEntry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const child = spawn(process.execPath, [tsxCli, cliEntry, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error("create-open-everywhere: failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});

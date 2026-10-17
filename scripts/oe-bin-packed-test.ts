import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finishedRun, npmCommand } from "./npm-command.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_DIR = join(REPO, "packages", "core");
const CORE = "@open-everywhere/core";
const OLD = "0.1.3";

const TSX_SHIM_BIN = [
  "#!/usr/bin/env node",
  'const { register } = await import("tsx/esm/api");',
  "register();",
  'await import("../scripts/oe-cli.ts");',
  "",
].join("\n");

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed++;
}

const coreManifest = JSON.parse(readFileSync(join(CORE_DIR, "package.json"), "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};
const PACKED = coreManifest.version;
const EVE = coreManifest.peerDependencies.eve ?? "0.0.0";

const scratch = mkdtempSync(join(tmpdir(), "oe-bin-packed-"));
const keep = process.argv.includes("--keep");

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number; output: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.on("error", fail);
    child.on("close", (code, signal) => {
      try {
        done({ status: finishedRun({ status: code, signal, stdout: output }, `${command} ${args.join(" ")}`).status, output });
      } catch (err) {
        fail(err);
      }
    });
  });
}

function npxCacheWith(packedCore: string, name: string, bin?: string): string {
  const root = join(scratch, name);
  const core = join(root, "node_modules", "@open-everywhere", "core");
  mkdirSync(dirname(core), { recursive: true });
  cpSync(packedCore, core, { recursive: true });
  if (bin !== undefined) writeFileSync(join(core, "bin", "oe.js"), bin);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name, private: true, dependencies: { [CORE]: PACKED } }, null, 2)}\n`);
  for (const dep of ["eve", ...Object.keys(coreManifest.dependencies)]) {
    const from = join(REPO, "node_modules", ...dep.split("/"));
    if (!existsSync(from)) continue;
    const to = join(root, "node_modules", ...dep.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
  }
  return join(core, "bin", "oe.js");
}

function appOn013(): string {
  const app = join(scratch, "app-013");
  const core = join(app, "node_modules", "@open-everywhere", "core");
  mkdirSync(join(core, "bin"), { recursive: true });
  writeFileSync(join(app, "roster.config.ts"), "export default {};\n");
  writeFileSync(
    join(app, "package.json"),
    `${JSON.stringify({ name: "app-013", private: true, type: "module", dependencies: { [CORE]: OLD, eve: EVE } }, null, 2)}\n`,
  );
  writeFileSync(join(core, "package.json"), `${JSON.stringify({ name: CORE, version: OLD, bin: { oe: "./bin/oe.js" } }, null, 2)}\n`);
  writeFileSync(join(core, "bin", "oe.js"), TSX_SHIM_BIN);
  return app;
}

const registry = createServer((req, res) => {
  const path = decodeURIComponent(req.url ?? "").toLowerCase();
  if (path !== `/${CORE}`) {
    res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
    return;
  }
  const packument = {
    name: CORE,
    "dist-tags": { latest: PACKED },
    versions: { [PACKED]: { name: CORE, version: PACKED, peerDependencies: { eve: EVE } } },
  };
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(packument));
});

try {
  const [packCmd, packArgs] = npmCommand(["pack", "--workspace", CORE, "--pack-destination", scratch, "--loglevel", "error", "--ignore-scripts"]);
  const tarballName = execFileSync(packCmd, packArgs, { cwd: REPO, encoding: "utf8" }).trim().split("\n").pop()!.trim();
  const tarball = join(scratch, tarballName);
  ok(existsSync(tarball) && tarball.endsWith(".tgz"), `packed core ${PACKED}`);
  mkdirSync(join(scratch, "x"), { recursive: true });
  execFileSync("tar", ["-xzf", tarballName, "-C", "x"], { cwd: scratch });
  const packed = join(scratch, "x", "package");
  ok(existsSync(join(packed, "dist", "scripts", "oe-cli.js")), "the tarball ships the compiled dispatcher dist/scripts/oe-cli.js");
  ok(!existsSync(join(packed, "scripts", "oe-cli.ts")), "…and no raw scripts/oe-cli.ts that a consumer could not run anyway");
  const binSource = readFileSync(join(packed, "bin", "oe.js"), "utf8");
  ok(!/["']tsx/.test(binSource), "🔴 the packed bin imports no `tsx`");

  const bin = npxCacheWith(packed, "npx-cache");
  ok(!lstatSync(dirname(dirname(bin))).isSymbolicLink(), "the packed core is a REAL directory, not a workspace symlink");
  let tsxResolves = true;
  try {
    createRequire(bin).resolve("tsx");
  } catch {
    tsxResolves = false;
  }
  ok(!tsxResolves, "🔴 `tsx` does NOT resolve from the packed bin — no `tsx` anywhere on its resolution path");

  const app = appOn013();
  const manifestBefore = readFileSync(join(app, "package.json"), "utf8");
  await new Promise<void>((done) => registry.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`;
  const userconfig = join(scratch, "empty.npmrc");
  writeFileSync(userconfig, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_registry: url,
    npm_config_userconfig: userconfig,
    npm_config_noproxy: "127.0.0.1,localhost",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    NODE_NO_WARNINGS: "1",
  };

  const plan = await run(process.execPath, [bin, "upgrade", "--plan"], app, env);
  const say = `\n--- oe upgrade --plan ---\n${plan.output}`;
  if (keep) console.log(say);
  ok(plan.status === 0, `🔴 \`oe upgrade --plan\` from the packed bin exits 0 in a ${OLD} app — got ${plan.status}${say}`);
  ok(plan.output.includes(`oe upgrade: ${OLD} → ${PACKED} (eve ${EVE})`), `…and plans ${OLD} → ${PACKED} from the registry's answers${say}`);
  ok(plan.output.includes(`pin  dependencies.${CORE}: ${OLD} → ${PACKED}`), `…and plans the core pin change${say}`);
  ok(plan.output.includes("✓ oe upgrade --plan: nothing was written."), `…and says it wrote nothing${say}`);
  ok(readFileSync(join(app, "package.json"), "utf8") === manifestBefore, "…and the app's package.json is unchanged");
  ok(!existsSync(join(app, ".open-everywhere")), "…and no resume marker was written");

  const shimBin = npxCacheWith(packed, "npx-cache-tsx-shim", TSX_SHIM_BIN);
  const shim = await run(process.execPath, [shimBin, "upgrade", "--plan"], app, env);
  const sayShim = `\n--- the tsx shim ---\n${shim.output}`;
  ok(shim.status !== 0, `🔴 the pre-OPE-2296 \`tsx\` shim FAILS in the same layout — got ${shim.status}${sayShim}`);
  ok(/ERR_MODULE_NOT_FOUND/.test(shim.output) && /'tsx'|"tsx"|tsx\/esm/.test(shim.output), `…on a missing \`tsx\`${sayShim}`);
} finally {
  registry.close();
  if (keep) console.log(`kept ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}

console.log(`✓ oe bin (packed, no tsx): ${passed} assertions.`);

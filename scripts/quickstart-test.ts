import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmCommand } from "./npm-command.js";
import { packPublishablePackages } from "./publish-pack.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
  console.log(`  ✓ ${label}`);
};
const eq = <T>(actual: T, expected: T, label: string): void => {
  assert.deepEqual(actual, expected, label);
  n++;
  console.log(`  ✓ ${label}`);
};

const REPO_ROOT = process.cwd();
const keep = process.argv.includes("--keep");

const CHILD_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/AI_GATEWAY_API_KEY|AI_GATEWAY_KEY/.test(k) && k !== "VERCEL"),
);

function run(cmd: string, args: readonly string[], cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, [...args], { cwd, env: CHILD_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: typeof e.status === "number" ? e.status : 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
const npm = (args: readonly string[], cwd: string) => run(...npmCommand(args), cwd);
const tail = (out: string, lines = 40): string => out.trim().split("\n").slice(-lines).join("\n");

function binOf(root: string, pkg: string, bin: string): string {
  const manifest = join(root, "node_modules", ...pkg.split("/"), "package.json");
  const declared = (JSON.parse(readFileSync(manifest, "utf8")) as { bin?: string | Record<string, string> }).bin;
  const rel = typeof declared === "string" ? declared : declared?.[bin];
  assert.ok(rel, `${pkg} declares a \`${bin}\` bin`);
  return join(root, "node_modules", ...pkg.split("/"), rel);
}

function listMcpTools(cwd: string, args: readonly string[]): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...args], { cwd, env: CHILD_ENV, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let settled = false;
    const finish = (err: Error | undefined, names?: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolvePromise(names ?? []);
    };
    const timer = setTimeout(() => finish(new Error(`no tools/list answer within 90 s. stderr:\n${tail(stderr)}`)), 90_000);
    const send = (msg: object): void => {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    };
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("exit", (code) => finish(new Error(`the ops MCP server exited (code ${code}) before answering. stderr:\n${tail(stderr)}`)));
    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] }; error?: unknown };
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          if (msg.error) finish(new Error(`tools/list failed: ${JSON.stringify(msg.error)}`));
          else finish(undefined, (msg.result?.tools ?? []).map((t) => t.name));
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oe-quickstart-test", version: "1.0.0" } },
    });
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const createManifest = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "create", "package.json"), "utf8")) as { version: string };
const VERSION = createManifest.version;
assert.ok(
  existsSync(join(REPO_ROOT, "packages", "core", "dist", "agent")),
  "packages/core/dist is missing — run `npm run build:packages` first: a pack ships whatever dist/ is on disk",
);

const scratch = mkdtempSync(join(tmpdir(), "oe-quickstart-"));
const app = join(scratch, "app");
try {
  console.log("1. pack the nine publishable packages");
  const packed = packPublishablePackages(REPO_ROOT, join(scratch, "tarballs"));
  eq(packed.length, 9, "packed all nine publishable packages");
  const tarballOf = new Map(packed.map((p) => [p.name, p.tarball]));
  const fileSpec = (name: string): string => `file:${(tarballOf.get(name) ?? "").split("\\").join("/")}`;

  console.log("2. install the packed CLI and scaffold app/");
  const cliDir = join(scratch, "cli");
  mkdirSync(cliDir);
  writeFileSync(join(cliDir, "package.json"), `${JSON.stringify({ name: "oe-quickstart-host", version: "1.0.0", private: true }, null, 2)}\n`);
  const cliInstall = npm(
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--loglevel",
      "error",
      fileSpec("@open-everywhere/create"),
      fileSpec("@open-everywhere/core"),
      fileSpec("@open-everywhere/provider-slack"),
    ],
    cliDir,
  );
  assert.equal(cliInstall.code, 0, `installing the packed CLI failed:\n${tail(cliInstall.out)}`);
  const cliBin = binOf(cliDir, "@open-everywhere/create", "create-open-everywhere");
  const scaffold = run(process.execPath, [cliBin, "app"], scratch);
  assert.equal(scaffold.code, 0, `@open-everywhere/create app failed:\n${tail(scaffold.out)}`);
  ok(existsSync(join(app, "agent", "agent.ts")), "the packed CLI scaffolded app/ (agent/agent.ts present)");
  ok(existsSync(join(app, "roster.config.ts")) && existsSync(join(app, "roster.lock.json")), "app/ carries roster.config.ts and roster.lock.json");
  ok(existsSync(join(app, ".gitignore")) && !existsSync(join(app, "gitignore")), "the tarball carried the template's gitignore, renamed to .gitignore");
  ok(existsSync(join(app, ".env.example")), "the tarball carried .env.example");
  for (const rel of [".mcp.json", ".claude/skills/quickstart-open-everywhere/SKILL.md", "AGENTS.md", "CLAUDE.md", "scripts/ops-mcp.ts"]) {
    ok(existsSync(join(app, ...rel.split("/"))), `the tarball carried the agent route: ${rel}`);
  }

  const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  const pinned = packed.map(({ name }) => manifest.dependencies[name] ?? manifest.devDependencies[name]);
  eq(pinned, packed.map(() => VERSION), `the scaffold pinned all nine lockstep packages to the CLI's version (${VERSION})`);
  eq(manifest.scripts.postinstall, "oe-eve-patch", "the app's postinstall is `oe-eve-patch`");

  console.log("3. npm install the app against the tarballs (postinstall runs)");
  for (const { name } of packed) {
    if (name in manifest.dependencies) manifest.dependencies[name] = fileSpec(name);
    else manifest.devDependencies[name] = fileSpec(name);
  }
  writeFileSync(join(app, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const install = npm(["install", "--no-audit", "--no-fund", "--loglevel", "error", "--foreground-scripts"], app);
  assert.equal(install.code, 0, `npm install in the scaffolded app failed:\n${tail(install.out)}`);
  n++;

  console.log("4. inspect the installed tree");
  const probeScript = join(app, "probe-eve-patch.mjs");
  writeFileSync(
    probeScript,
    'import { probeEvePatch } from "@open-everywhere/core/agent/access/eve-patch-probe.js";\n' +
      "const r = await probeEvePatch();\n" +
      "console.log(JSON.stringify({ status: r.status, missing: r.missing.map((p) => p.marker) }));\n",
  );
  const probe = run(process.execPath, [probeScript], app);
  rmSync(probeScript);
  assert.equal(probe.code, 0, `the eve patch probe failed to run:\n${tail(probe.out)}`);
  const probeResult = JSON.parse(probe.out.trim().split("\n").pop() ?? "{}") as { status?: string; missing?: string[] };
  eq(probeResult.status, "patched", "core's eve patch probe reads `patched` in the scaffolded app");
  eq(probeResult.missing, [], "the probe reports no missing patch part");

  const installedCore = JSON.parse(readFileSync(join(app, "node_modules", "@open-everywhere", "core", "package.json"), "utf8")) as { version: string };
  eq(installedCore.version, VERSION, "the app resolved @open-everywhere/core at the packed version");
  const lockfile = JSON.parse(readFileSync(join(app, "package-lock.json"), "utf8")) as { packages: Record<string, { resolved?: string }> };
  const oeEntries = Object.entries(lockfile.packages).filter(([path]) => /node_modules\/@open-everywhere\/[^/]+$/.test(path));
  eq(
    oeEntries.map(([path]) => path).sort(),
    packed.map(({ name }) => `node_modules/${name}`).sort(),
    "exactly one copy of each lockstep package, all hoisted (no nested registry copy)",
  );
  ok(oeEntries.every(([, entry]) => (entry.resolved ?? "").includes(".tgz")), "every lockstep package resolved from a tarball, not the registry");
  const zod = npm(["ls", "zod", "--all", "--parseable"], app);
  eq(zod.code, 0, "`npm ls zod` exits 0 (no invalid or conflicting zod)");
  const zodVersions = new Set(
    zod.out
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((dir) => (JSON.parse(readFileSync(join(dir.trim(), "package.json"), "utf8")) as { version: string }).version),
  );
  eq([...zodVersions], [(JSON.parse(readFileSync(join(REPO_ROOT, "packages", "core", "package.json"), "utf8")) as { dependencies: { zod: string } }).dependencies.zod], "one zod version in the tree, and it is the version core pins");

  console.log("5. oe build");
  const oe = binOf(app, "@open-everywhere/core", "oe");
  const before = run(process.execPath, [oe, "build", "--check"], app);
  ok(before.code !== 0, "NEGATIVE CONTROL: `oe build --check` fails before `oe build` (no slot tree yet)");
  const build = run(process.execPath, [oe, "build"], app);
  assert.equal(build.code, 0, `oe build failed — the template's roster.lock.json no longer matches the packed manifests?\n${tail(build.out)}`);
  n++;
  const after = run(process.execPath, [oe, "build", "--check"], app);
  eq(after.code, 0, "`oe build --check` passes after `oe build`");
  ok(existsSync(join(app, "agent", "lib", "providers.generated.ts")), "oe build wrote agent/lib/providers.generated.ts");
  const providers = readFileSync(join(app, "agent", "lib", "providers.generated.ts"), "utf8");
  ok(["provider-slack", "provider-notion", "provider-github"].every((p) => providers.includes(`@open-everywhere/${p}`)), "the roster selects slack, notion and github");
  ok(!["provider-discord", "provider-teams", "provider-linear"].some((p) => providers.includes(`@open-everywhere/${p}`)), "the roster selects no other provider (negative control)");

  console.log("5b. the ops MCP server answers initialize and tools/list");
  const mcp = JSON.parse(readFileSync(join(app, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
  const ops = mcp.mcpServers["open-everywhere-ops"];
  assert.ok(ops, ".mcp.json registers open-everywhere-ops");
  eq(ops.command, "node", ".mcp.json starts the ops server with plain `node` (an npx or .cmd shim cannot be spawned everywhere)");
  const toolNames = await listMcpTools(app, ops.args);
  for (const tool of ["preflight", "surface_manifest", "scaffold_env", "scaffold_credential_key", "secret_set", "secret_list"]) {
    ok(toolNames.includes(tool), `the ops MCP server lists \`${tool}\``);
  }
  ok(!toolNames.includes("quickstart"), "the ops MCP server does NOT list the retired `quickstart` plan tool");

  console.log("6. typecheck");
  const tsc = run(process.execPath, [binOf(app, "typescript", "tsc"), "--noEmit", "-p", "tsconfig.json"], app);
  eq(tsc.code, 0, `the scaffolded app typechecks${tsc.code === 0 ? "" : `:\n${tail(tsc.out)}`}`);

  console.log("7. eve build (minutes)");
  const eve = run(process.execPath, [binOf(app, "eve", "eve"), "build"], app);
  eq(eve.code, 0, `\`eve build\` succeeds in the scaffolded app${eve.code === 0 ? "" : `:\n${tail(eve.out)}`}`);
  const serverDir = join(app, ".output", "server");
  ok(existsSync(serverDir), "eve build wrote .output/server (the non-Vercel output directory eve 0.54.3 uses)");
  const serverModules = walk(serverDir).filter((f) => f.endsWith(".mjs"));
  ok(serverModules.length > 0, `.output/server holds compiled modules (${serverModules.length} .mjs file(s))`);
  const bareImports = serverModules.filter((f) => /from\s*"@open-everywhere\//.test(readFileSync(f, "utf8")));
  eq(bareImports, [], "no bare `@open-everywhere/*` import survives into .output/server (consuming-as-packages § Verifying an install)");
} finally {
  if (keep) console.log(`\n(--keep) the scaffolded app is at ${app}`);
  else rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n✓ quickstart: ${n} assertions passed — the packed CLI scaffolds an app that installs, patches, builds its roster, typechecks and builds\n`);

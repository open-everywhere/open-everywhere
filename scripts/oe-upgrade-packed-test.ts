import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ChildResult, finishedRun, IncompleteChildRun, npmCommand } from "./npm-command.js";
import { BOOTSTRAP_PREFIX, bootstrapCommands, compareVersions } from "../packages/core/scripts/upgrade-notes.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_DIR = join(REPO, "packages", "core");
const CODEMOD = "ope-2238-proof";
const STAMP = "loaded-from-the-new-core";

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
const OLD = coreManifest.version;
const [major, minor, patch] = OLD.split(".").map((p) => Number.parseInt(p, 10));
const NEW = `${major}.${minor}.${(patch ?? 0) + 1}`;
const EVE = coreManifest.peerDependencies.eve ?? "0.0.0";

const scratch = mkdtempSync(join(tmpdir(), "oe-upgrade-packed-"));
const keep = process.argv.includes("--keep");

function run(command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): { status: number; output: string } {
  try {
    const output = execFileSync(command, [...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    return { status: 0, output };
  } catch (err) {
    const e = err as ChildResult & { stdout?: string; stderr?: string };
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    const status = finishedRun(e, `${command} ${args.join(" ")}`).status;
    if (output.includes("INCOMPLETE RUN —")) throw new IncompleteChildRun(`${command} ${args.join(" ")} reported a step that did not finish`, output);
    return { status, output };
  }
}

function extract(tarball: string, dest: string): string {
  mkdirSync(dest, { recursive: true });
  const r = run("tar", ["-xzf", relative(dest, tarball).split(sep).join("/")], dest);
  assert.equal(r.status, 0, `tar -xzf failed:\n${r.output}`);
  return join(dest, "package");
}

function makeNew(pkg: string, options: { readonly codemodId?: string; readonly noteIds: readonly string[] }): void {
  const manifestPath = join(pkg, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = NEW;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const notesPath = join(pkg, "dist", "scripts", "upgrade-notes.js");
  writeFileSync(notesPath, `${readFileSync(notesPath, "utf8")}\nexport const OPE_2238_STAMP = ${JSON.stringify(STAMP)};\n`);

  if (options.codemodId !== undefined) {
    const registryPath = join(pkg, "dist", "scripts", "upgrade-codemods.js");
    const before = readFileSync(registryPath, "utf8");
    const empty = "export const CODEMODS = [];";
    assert.ok(before.includes(empty), `the packed registry still declares \`${empty}\` — update this test's fixture`);
    const entry = [
      "export const CODEMODS = [",
      "  {",
      `    id: ${JSON.stringify(options.codemodId)},`,
      '    describe: "the OPE-2238 proof codemod, registered only in the NEW core",',
      "    run: (appRoot) => {",
      `      __writeFileSync(__join(appRoot, "codemod-proof.json"), JSON.stringify({ stamp: OPE_2238_STAMP, version: ${JSON.stringify(NEW)} }));`,
      '      return ["wrote codemod-proof.json"];',
      "    },",
      "  },",
      "];",
    ].join("\n");
    const header = [
      'import { writeFileSync as __writeFileSync } from "node:fs";',
      'import { join as __join } from "node:path";',
      'import { OPE_2238_STAMP } from "./upgrade-notes.js";',
      "",
    ].join("\n");
    writeFileSync(registryPath, header + before.replace(empty, entry));
  }

  const notesJsonPath = join(pkg, "upgrading.json");
  const notes = JSON.parse(readFileSync(notesJsonPath, "utf8")) as { schemaVersion: number; releases: Record<string, unknown>[] };
  notes.releases = notes.releases.filter((r) => r.version !== NEW);
  notes.releases.unshift({
    version: NEW,
    date: "2026-10-03",
    summary: "The OPE-2238 proof release.",
    evePeer: EVE,
    breaking: [],
    configMigrations: options.noteIds.map((codemod) => ({ description: `the proof migration ${codemod}`, codemod })),
    env: { added: [], removed: [] },
    manualSteps: [],
  });
  writeFileSync(notesJsonPath, `${JSON.stringify(notes, null, 2)}\n`);
}

const DRIVER = `
const { spawnSync } = await import("node:child_process");
const { cpSync, rmSync } = await import("node:fs");
const { join } = await import("node:path");
const [newPkg, target, eve] = process.argv.slice(2);
const core = join(process.cwd(), "node_modules", "@open-everywhere", "core");
const oldUpgrade = await import("./node_modules/@open-everywhere/core/dist/scripts/oe-upgrade.js");
const oldRegistry = await import("./node_modules/@open-everywhere/core/dist/scripts/upgrade-codemods.js");
console.log("DRIVER old-registry-holds-${CODEMOD}=" + String(oldRegistry.codemodById("${CODEMOD}") !== undefined));
const io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  registry: { latestVersion: async () => target, evePeer: async () => eve },
  run(command, args, cwd) {
    if (args[args.length - 1] === "install") {
      rmSync(core, { recursive: true, force: true });
      cpSync(newPkg, core, { recursive: true });
      console.log("DRIVER install: the NEW core replaced the OLD one");
      return 0;
    }
    if (args.includes("upgrade-codemods")) {
      const r = spawnSync(command, args, { cwd, stdio: "inherit" });
      // A step that did not finish is not a failed step (OPE-2509): say so, rather than hand the upgrade an exit code.
      if (r.status === null || (r.status >= 129 && r.status <= 143)) throw new Error("INCOMPLETE RUN — oe upgrade-codemods did not finish (exit " + r.status + ", signal " + r.signal + (r.error ? ", " + r.error.message : "") + ")");
      return r.status;
    }
    console.log("DRIVER skipped: " + args.join(" "));
    return 0;
  },
};
process.exit(await oldUpgrade.runUpgradeCommand(["--to", target], io, process.cwd()));
`;

const CORE_RUNTIME = ["eve", ...Object.keys(coreManifest.dependencies)];

function linkDeps(root: string, names: readonly string[] = ["tsx", ...CORE_RUNTIME]): void {
  for (const dep of names) {
    const from = join(REPO, "node_modules", ...dep.split("/"));
    if (!existsSync(from)) continue;
    const to = join(root, "node_modules", ...dep.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
  }
}

function appOn(oldPkg: string, name: string): string {
  const app = join(scratch, name);
  mkdirSync(join(app, "node_modules", "@open-everywhere"), { recursive: true });
  writeFileSync(join(app, "roster.config.ts"), "export default {};\n");
  writeFileSync(
    join(app, "package.json"),
    `${JSON.stringify({ name, private: true, type: "module", dependencies: { "@open-everywhere/core": OLD, eve: EVE } }, null, 2)}\n`,
  );
  cpSync(oldPkg, join(app, "node_modules", "@open-everywhere", "core"), { recursive: true });
  linkDeps(app, CORE_RUNTIME);
  writeFileSync(join(app, "drive.mjs"), DRIVER);
  return app;
}

const RECORDER = (label: string): string =>
  `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.OE_FAKE_LOG, ${JSON.stringify(`${label} `)} + process.argv.slice(2).join(" ") + "\\n");\n`;

const FAKE_NPM = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const command = args.filter((a) => a !== "--json").join(" ");
fs.appendFileSync(process.env.OE_FAKE_LOG, "npm " + (args[0] === "view" ? args.slice(0, 3).join(" ") : command) + "\\n");
if (args[0] === "view" && args[2] === "version") process.stdout.write(JSON.stringify(process.env.OE_FAKE_LATEST));
else if (args[0] === "view" && args[2] === "peerDependencies.eve") process.stdout.write(JSON.stringify(process.env.OE_FAKE_EVE));
else if (command === "install") {
  const core = path.join(process.cwd(), "node_modules", "@open-everywhere", "core");
  fs.rmSync(core, { recursive: true, force: true });
  fs.cpSync(process.env.OE_FAKE_INSTALL_FROM, core, { recursive: true });
} else if (args[0] !== "run") process.exit(1);
`;

function runAsync(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number; output: string }> {
  return new Promise((done) => {
    execFile(command, [...args], { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const status = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1;
      done({ status, output: `${stdout}${stderr}` });
    });
  });
}

const LOCK_FROM = "0.1.4";
const LOCK_TO = "0.2.1";
const EVE_FROM = "0.54.3";
const EVE_TO = "0.71.0";

function standInPackages(): readonly Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [
    { name: "eve", version: EVE_FROM },
    { name: "eve", version: EVE_TO },
    { name: "@agent-browser/eve", version: "0.32.4", peerDependencies: { eve: ">=0.25.1" } },
    { name: "oe-lock-bystander", version: "1.0.0" },
  ];
  for (const [v, e] of [
    [LOCK_FROM, EVE_FROM],
    [LOCK_TO, EVE_TO],
  ] as const) {
    const later = v === LOCK_TO;
    const notes = {
      schemaVersion: 1,
      releases: [
        ...(later ? [{ version: LOCK_TO, date: "2026-10-08", summary: "the stand-in target.", evePeer: EVE_TO, breaking: [], configMigrations: [], env: { added: [], removed: [] }, manualSteps: [] }] : []),
        { version: LOCK_FROM, date: "2026-10-03", summary: "the stand-in start.", evePeer: EVE_FROM, breaking: [], configMigrations: [], env: { added: [], removed: [] }, manualSteps: [] },
      ],
    };
    out.push({ name: "@open-everywhere/core", version: v, bin: { oe: "bin/oe.js" }, peerDependencies: { eve: e }, __files: { "upgrading.json": JSON.stringify(notes), "bin/oe.js": "process.exit(0);\n" } });
    out.push({
      name: "@open-everywhere/adapters",
      version: v,
      dependencies: { "@open-everywhere/core": v },
      peerDependencies: later ? { eve: e, "@agent-browser/eve": "0.32.4" } : { eve: e },
    });
    out.push({ name: "@open-everywhere/provider-slack", version: v, dependencies: { "@open-everywhere/core": v }, peerDependencies: { eve: e } });
    out.push({ name: "@open-everywhere/create", version: v, dependencies: { "@open-everywhere/core": v, "@open-everywhere/provider-slack": v } });
  }
  return out;
}

async function standInRegistry(root: string, unpublished?: string): Promise<{ readonly url: string; readonly release: string; close(): Promise<void> }> {
  const packuments = new Map<string, { name: string; "dist-tags": Record<string, string>; versions: Record<string, unknown> }>();
  const tarballs = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!.slice(1));
    const tarball = path.startsWith("-/t/") ? tarballs.get(path.slice("-/t/".length)) : undefined;
    if (tarball !== undefined) {
      res.setHeader("content-type", "application/octet-stream");
      res.end(tarball);
      return;
    }
    const packument = packuments.get(path);
    res.statusCode = packument === undefined ? 404 : 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(packument ?? {}));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  for (const spec of standInPackages()) {
    const { __files, ...manifest } = spec as { __files?: Record<string, string> } & Record<string, unknown>;
    const name = manifest.name as string;
    const version = manifest.version as string;
    const dir = join(root, `${name.replace("/", "+")}@${version}`);
    mkdirSync(join(dir, "package"), { recursive: true });
    writeFileSync(join(dir, "package", "package.json"), JSON.stringify(manifest));
    for (const [rel, body] of Object.entries(__files ?? {})) {
      mkdirSync(dirname(join(dir, "package", rel)), { recursive: true });
      writeFileSync(join(dir, "package", rel), body);
    }
    const r = run("tar", ["-czf", "p.tgz", "package"], dir);
    assert.equal(r.status, 0, `tar -czf failed:\n${r.output}`);
    const bytes = readFileSync(join(dir, "p.tgz"));
    if (version === unpublished && name.startsWith("@open-everywhere/")) {
      mkdirSync(join(root, "release"), { recursive: true });
      writeFileSync(join(root, "release", `${name.slice(1).replace("/", "-")}-${version}.tgz`), bytes);
      continue;
    }
    const key = `${name.replace("/", "+")}-${version}.tgz`;
    tarballs.set(key, bytes);
    const packument = packuments.get(name) ?? { name, "dist-tags": {}, versions: {} };
    packument.versions[version] = {
      ...manifest,
      dist: {
        tarball: `${url}-/t/${key}`,
        shasum: createHash("sha1").update(bytes).digest("hex"),
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      },
    };
    packument["dist-tags"].latest = version;
    packuments.set(name, packument);
  }
  return { url, release: join(root, "release"), close: () => new Promise<void>((closed) => server.close(() => closed())) };
}

const LOCK_DRIVER = `
const { spawnSync } = await import("node:child_process");
const [upgradeModule, app, target, eve] = process.argv.slice(2);
const { runUpgradeCommand } = await import(upgradeModule);
const io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  registry: { latestVersion: async () => target, evePeer: async () => eve },
  run: (command, args, cwd) => {
    const r = spawnSync(command, args, { cwd, stdio: "inherit" });
    // A step that did not finish is not a failed step (OPE-2509): say so, rather than hand the upgrade an exit code.
    if (r.status === null || (r.status >= 129 && r.status <= 143)) throw new Error("INCOMPLETE RUN — " + command + " " + args.join(" ") + " did not finish (exit " + r.status + ", signal " + r.signal + (r.error ? ", " + r.error.message : "") + ")");
    return r.status;
  },
};
process.exit(await runUpgradeCommand(["--to", target], io, app));
`;

const REHEARSAL_DRIVER = `
const [upgradeModule, app, edge, ...args] = process.argv.slice(2);
const { runUpgradeCommand, realUpgradeIo } = await import(upgradeModule);
const real = realUpgradeIo();
const refuse = async () => { throw new Error("REHEARSAL-DRIVER: the registry was read"); };
const io = { ...real, registry: edge === "registry" ? real.registry : { latestVersion: refuse, evePeer: refuse, templateDir: refuse } };
process.exit(await runUpgradeCommand(args, io, app));
`;

async function lockfileLeg(packedCore: string, rehearse = false): Promise<void> {
  const root = join(scratch, rehearse ? "rehearsal" : "lockfile");
  const registry = await standInRegistry(join(root, "registry"), rehearse ? LOCK_TO : undefined);
  try {
    const userconfig = join(root, "npmrc");
    mkdirSync(root, { recursive: true });
    writeFileSync(userconfig, "");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      npm_config_registry: registry.url,
      npm_config_userconfig: userconfig,
      npm_config_cache: join(root, "npm-cache"),
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      NO_PROXY: "127.0.0.1",
      no_proxy: "127.0.0.1",
    };
    const appAt014 = async (name: string): Promise<string> => {
      const app = join(root, name);
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, "roster.config.ts"), "export default {};\n");
      const pins = { "@open-everywhere/adapters": LOCK_FROM, "@open-everywhere/core": LOCK_FROM, "@open-everywhere/provider-slack": LOCK_FROM, eve: EVE_FROM, "oe-lock-bystander": "^1.0.0" };
      const manifest = { name, private: true, scripts: { typecheck: "node -e 0", build: "node -e 0" }, dependencies: pins, devDependencies: { "@open-everywhere/create": LOCK_FROM } };
      writeFileSync(join(app, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      const [cmd, args] = npmCommand(["install"]);
      const r = await runAsync(cmd, args, app, env);
      assert.equal(r.status, 0, `the fixture install at ${LOCK_FROM} failed:\n${r.output}`);
      return app;
    };
    const lockOf = (app: string): Record<string, { version?: string; resolved?: string; integrity?: string }> =>
      (JSON.parse(readFileSync(join(app, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> }).packages;

    if (rehearse) {
      await rehearsalLeg(packedCore, root, registry.release, env, appAt014, lockOf);
      return;
    }
    const control = await appAt014("app-lock-control");
    ok(lockOf(control)["node_modules/@open-everywhere/adapters"]?.version === LOCK_FROM, `the fixture: the lockfile locks adapters at ${LOCK_FROM}`);
    const bumped = readFileSync(join(control, "package.json"), "utf8").split(`"${LOCK_FROM}"`).join(`"${LOCK_TO}"`).split(`"${EVE_FROM}"`).join(`"${EVE_TO}"`);
    writeFileSync(join(control, "package.json"), bumped);
    const [cmd, args] = npmCommand(["install"]);
    const bare = await runAsync(cmd, args, control, env);
    ok(bare.status !== 0 && bare.output.includes("ERESOLVE"), `🔴 the control: a bare npm install of the new pins over the old lockfile exits ERESOLVE — got ${bare.status}\n${bare.output}`);

    const app = await appAt014("app-lock");
    const bystander = lockOf(app)["node_modules/oe-lock-bystander"];
    const runner = join(root, "runner");
    mkdirSync(join(runner, "node_modules", "@open-everywhere"), { recursive: true });
    cpSync(packedCore, join(runner, "node_modules", "@open-everywhere", "core"), { recursive: true });
    linkDeps(runner, CORE_RUNTIME);
    writeFileSync(join(runner, "drive.mjs"), LOCK_DRIVER);
    const upgradeModule = pathToFileURL(join(runner, "node_modules", "@open-everywhere", "core", "dist", "scripts", "oe-upgrade.js")).href;
    const up = await runAsync(process.execPath, ["drive.mjs", upgradeModule, app, LOCK_TO, EVE_TO], runner, env);
    const say = `\n--- oe upgrade output ---\n${up.output}`;
    ok(up.status === 0, `🔴 \`oe upgrade --to ${LOCK_TO}\` over the ${LOCK_FROM} lockfile exits 0, with the real npm install — got ${up.status}${say}`);
    ok(existsSync(join(app, "package-lock.json")), "…and the app still has its lockfile");
    const after = lockOf(app);
    ok(
      after["node_modules/@open-everywhere/adapters"]?.version === LOCK_TO && after["node_modules/@open-everywhere/core"]?.version === LOCK_TO && after["node_modules/eve"]?.version === EVE_TO,
      `🔴 …and the lockfile now locks the ${LOCK_TO} set and eve ${EVE_TO}${say}`,
    );
    ok(after["node_modules/@agent-browser/eve"]?.version === "0.32.4", "…and npm placed the new peer the target's adapters declare");
    const installedEve = JSON.parse(readFileSync(join(app, "node_modules", "eve", "package.json"), "utf8")) as { version: string };
    ok(installedEve.version === EVE_TO, `…and node_modules holds eve ${EVE_TO} — got ${installedEve.version}`);
    ok(JSON.stringify(after["node_modules/oe-lock-bystander"]) === JSON.stringify(bystander), "…and an unrelated locked entry is exactly as it was");
    ok(up.output.includes(`✓ oe upgrade: ${LOCK_FROM} → ${LOCK_TO}.`), `…and the run reports ${LOCK_FROM} → ${LOCK_TO}${say}`);
  } finally {
    await registry.close();
  }
}

async function rehearsalLeg(
  packedCore: string,
  root: string,
  release: string,
  env: NodeJS.ProcessEnv,
  appAt014: (name: string) => Promise<string>,
  lockOf: (app: string) => Record<string, { version?: string; resolved?: string }>,
): Promise<void> {
  const runner = join(root, "runner");
  mkdirSync(join(runner, "node_modules", "@open-everywhere"), { recursive: true });
  cpSync(packedCore, join(runner, "node_modules", "@open-everywhere", "core"), { recursive: true });
  linkDeps(runner, CORE_RUNTIME);
  writeFileSync(join(runner, "drive.mjs"), REHEARSAL_DRIVER);
  const upgradeModule = pathToFileURL(join(runner, "node_modules", "@open-everywhere", "core", "dist", "scripts", "oe-upgrade.js")).href;
  const drive = (app: string, edge: "registry" | "local", args: readonly string[]) => runAsync(process.execPath, ["drive.mjs", upgradeModule, app, edge, ...args], runner, env);
  const tarballOf = (n: string): string => join(release, `open-everywhere-${n}-${LOCK_TO}.tgz`);

  const control = await appAt014("app-rehearsal-control");
  const controlManifest = readFileSync(join(control, "package.json"), "utf8");
  const viaRegistry = await drive(control, "registry", ["--to", LOCK_TO]);
  ok(
    viaRegistry.status === 1 && viaRegistry.output.includes(`cannot read the \`eve\` peer @open-everywhere/core@${LOCK_TO}`),
    `🔴 the control: \`oe upgrade --to ${LOCK_TO}\` through the registry refuses an unpublished target — got ${viaRegistry.status}\n${viaRegistry.output}`,
  );
  ok(readFileSync(join(control, "package.json"), "utf8") === controlManifest, "…and it wrote nothing");

  const app = await appAt014("app-rehearsal");
  const manifestBefore = readFileSync(join(app, "package.json"), "utf8");
  const planned = await drive(app, "local", ["--plan", "--from", release]);
  const sayPlan = `\n--- oe upgrade --plan output ---\n${planned.output}`;
  ok(planned.status === 0 && planned.output.includes(`oe upgrade: ${LOCK_FROM} → ${LOCK_TO} (eve ${EVE_TO})`), `🔴 \`oe upgrade --plan --from <dir>\` reads the target and its eve peer from the tarballs${sayPlan}`);
  ok(planned.output.includes(`@open-everywhere/core: ${LOCK_FROM} → file:${tarballOf("core")}`), `…and plans a file: pin on the core tarball${sayPlan}`);
  ok(readFileSync(join(app, "package.json"), "utf8") === manifestBefore, "…and --plan wrote nothing");

  const up = await drive(app, "local", ["--from", release]);
  const say = `\n--- oe upgrade --from output ---\n${up.output}`;
  ok(up.status === 0, `🔴 \`oe upgrade --from <dir>\` takes the ${LOCK_FROM} app to the unpublished ${LOCK_TO}, with the real npm install — got ${up.status}${say}`);
  ok(!up.output.includes("REHEARSAL-DRIVER"), `…and it never read the registry edge${say}`);
  const pins = JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const all = { ...pins.dependencies, ...pins.devDependencies };
  ok(
    ["core", "adapters", "provider-slack", "create"].every((n) => all[`@open-everywhere/${n}`] === `file:${tarballOf(n)}`) && all.eve === EVE_TO,
    `…and it pins every @open-everywhere/* package to its tarball and eve to ${EVE_TO} — got ${JSON.stringify(all)}`,
  );
  const lock = lockOf(app);
  for (const n of ["core", "adapters", "provider-slack", "create"]) {
    const installed = JSON.parse(readFileSync(join(app, "node_modules", "@open-everywhere", n, "package.json"), "utf8")) as { version: string };
    ok(installed.version === LOCK_TO, `🔴 …and node_modules holds @open-everywhere/${n} at ${LOCK_TO} — got ${installed.version}`);
    ok(lock[`node_modules/@open-everywhere/${n}`]?.resolved?.startsWith("file:") === true, `…and the lockfile resolves @open-everywhere/${n} from its tarball — got ${JSON.stringify(lock[`node_modules/@open-everywhere/${n}`])}`);
  }
  ok(up.output.includes(`Release notes (${LOCK_TO}'s own copy):`), `…and it reads the target's own release record after the install${say}`);
  ok(up.output.includes(`✓ oe upgrade: ${LOCK_FROM} → ${LOCK_TO}.`) && up.output.includes("REHEARSAL: package.json pins"), `…and it reports the upgrade and says the pins are a rehearsal${say}`);

  const again = await drive(app, "local", ["--from", release]);
  ok(again.status === 0 && again.output.includes(`already on ${LOCK_TO}. Nothing to do.`), `…and a second run reads the file: pin as ${LOCK_TO} and has nothing to do — got ${again.status}\n${again.output}`);
}

try {
  const [packCmd, packArgs] = npmCommand(["pack", "--workspace", "@open-everywhere/core", "--pack-destination", scratch, "--loglevel", "error", "--ignore-scripts"]);
  const packed = run(packCmd, packArgs, REPO);
  assert.equal(packed.status, 0, `npm pack @open-everywhere/core failed:\n${packed.output}`);
  const tarball = join(scratch, packed.output.trim().split("\n").pop()!.trim());
  ok(existsSync(tarball) && tarball.endsWith(".tgz"), `packed core ${OLD}`);

  const oldPkg = extract(tarball, join(scratch, "old"));
  const newPkg = extract(tarball, join(scratch, "new"));
  makeNew(newPkg, { codemodId: CODEMOD, noteIds: [CODEMOD] });
  const brokenPkg = extract(tarball, join(scratch, "new-broken"));
  makeNew(brokenPkg, { noteIds: ["ope-2238-nobody-shipped-this"] });
  const mixedPkg = extract(tarball, join(scratch, "new-mixed"));
  makeNew(mixedPkg, { codemodId: CODEMOD, noteIds: [CODEMOD, "ope-2238-nobody-shipped-this"] });
  for (const rel of ["bin/oe.js", "dist/scripts/oe-cli.js", "dist/scripts/oe-upgrade.js", "dist/scripts/upgrade-codemods.js", "dist/scripts/upgrade-notes.js", "upgrading.json"]) {
    ok(existsSync(join(oldPkg, ...rel.split("/"))), `the tarball ships ${rel}`);
  }

  const app = appOn(oldPkg, "app");
  const installed = join(app, "node_modules", "@open-everywhere", "core");
  ok(!lstatSync(installed).isSymbolicLink(), "🔴 the app's core is a REAL directory under node_modules, not a workspace symlink");
  const up = run(process.execPath, ["drive.mjs", newPkg, NEW, EVE], app);
  const say = `\n--- driver output ---\n${up.output}`;
  ok(up.output.includes(`DRIVER old-registry-holds-${CODEMOD}=false`), `the precondition: the OLD core's registry does not hold ${CODEMOD}${say}`);
  ok(up.output.includes("DRIVER install: the NEW core replaced the OLD one"), `the install step ran${say}`);
  ok(up.status === 0, `🔴 \`oe upgrade --to ${NEW}\` from ${OLD} exits 0 — got ${up.status}${say}`);
  ok(up.output.includes(`→ codemod ${CODEMOD}`), `🔴 …and the codemod only ${NEW} registers ran${say}`);
  const proofPath = join(app, "codemod-proof.json");
  ok(existsSync(proofPath), `🔴 …and it changed the app${say}`);
  const proof = JSON.parse(readFileSync(proofPath, "utf8")) as { stamp?: string; version?: string };
  ok(proof.stamp === STAMP && proof.version === NEW, `🔴 …with the NEW core's module graph (stamp from the new upgrade-notes.js) — got ${JSON.stringify(proof)}`);
  const skipped = up.output.split("\n").filter((l) => l.startsWith("DRIVER skipped: ")).map((l) => l.slice("DRIVER skipped: ".length));
  ok(
    skipped.length === 3 && skipped[0]!.endsWith("build --accept") && up.output.indexOf(`→ codemod ${CODEMOD}`) < up.output.indexOf("DRIVER skipped: "),
    `…and \`oe build --accept\` comes AFTER the codemod — got ${JSON.stringify(skipped)}`,
  );
  ok(!existsSync(join(app, ".open-everywhere", "upgrade-resume.json")), "…and the resume marker is cleared on success");

  const refused = appOn(oldPkg, "app-refused");
  const no = run(process.execPath, ["drive.mjs", brokenPkg, NEW, EVE], refused);
  const sayNo = `\n--- driver output ---\n${no.output}`;
  ok(no.status === 1, `🔴 a codemod the NEW registry does not hold refuses — got ${no.status}${sayNo}`);
  ok(no.output.includes("ope-2238-nobody-shipped-this") && no.output.includes("no codemod ran"), `…and names it, and says no codemod ran${sayNo}`);
  ok(!no.output.includes("DRIVER skipped: "), `…and \`oe build --accept\` never ran${sayNo}`);
  ok(existsSync(join(refused, ".open-everywhere", "upgrade-resume.json")), "…and the resume marker stays for the retry");

  const mixed = appOn(oldPkg, "app-mixed");
  const half = run(process.execPath, ["drive.mjs", mixedPkg, NEW, EVE], mixed);
  const sayHalf = `\n--- driver output ---\n${half.output}`;
  ok(half.status === 1, `🔴 notes that name a known AND an unknown codemod refuse — got ${half.status}${sayHalf}`);
  ok(!existsSync(join(mixed, "codemod-proof.json")), `🔴 …and the KNOWN codemod did not run either: every id resolves before the first one runs${sayHalf}`);
  ok(!half.output.includes(`→ codemod ${CODEMOD}`), `…and no codemod line was printed${sayHalf}`);
  ok(!half.output.includes("DRIVER skipped: "), `…and \`oe build --accept\` never ran${sayHalf}`);

  if (process.platform !== "win32") {
    const PRE = "0.1.3";
    ok(compareVersions(PRE, OLD) < 0, `the fixture: ${PRE} is older than the packed core ${OLD}`);

    const prePkg = extract(tarball, join(scratch, "pre"));
    const preManifest = JSON.parse(readFileSync(join(prePkg, "package.json"), "utf8")) as Record<string, unknown>;
    preManifest.version = PRE;
    writeFileSync(join(prePkg, "package.json"), `${JSON.stringify(preManifest, null, 2)}\n`);
    rmSync(join(prePkg, "upgrading.json"));
    rmSync(join(prePkg, "UPGRADING.md"));
    writeFileSync(join(prePkg, "bin", "oe.js"), RECORDER("pre-oe"));

    const installedPkg = extract(tarball, join(scratch, "installed"));
    writeFileSync(join(installedPkg, "bin", "oe.js"), RECORDER("installed-oe"));

    const cache = join(scratch, "npx-cache");
    const cachedCore = join(cache, "node_modules", "@open-everywhere", "core");
    mkdirSync(dirname(cachedCore), { recursive: true });
    cpSync(extract(tarball, join(scratch, "cached")), cachedCore, { recursive: true });
    linkDeps(cache, CORE_RUNTIME);

    const [installLine, runLine] = bootstrapCommands(OLD);
    ok(
      installLine === `npm install --prefix ${BOOTSTRAP_PREFIX} @open-everywhere/core@${OLD} tsx@4`,
      `the rendered install names the prefix, the target core and tsx — got ${installLine}`,
    );

    const preApp = (name: string): string => {
      const app = join(scratch, name);
      mkdirSync(join(app, "node_modules", "@open-everywhere"), { recursive: true });
      writeFileSync(join(app, "roster.config.ts"), "export default {};\n");
      writeFileSync(
        join(app, "package.json"),
        `${JSON.stringify(
          {
            name,
            private: true,
            type: "module",
            dependencies: { "@open-everywhere/adapters": PRE, "@open-everywhere/core": PRE, eve: EVE },
            devDependencies: { "create-open-everywhere": PRE, tsx: "^4.23.9" },
          },
          null,
          2,
        )}\n`,
      );
      cpSync(prePkg, join(app, "node_modules", "@open-everywhere", "core"), { recursive: true });
      linkDeps(app, CORE_RUNTIME);

      const prefix = join(app, ...BOOTSTRAP_PREFIX.split("/"));
      const prefixCore = join(prefix, "node_modules", "@open-everywhere", "core");
      mkdirSync(dirname(prefixCore), { recursive: true });
      cpSync(extract(tarball, join(scratch, `bootstrap-${name}`)), prefixCore, { recursive: true });
      linkDeps(prefix);
      return app;
    };
    const app = preApp("app-pre");

    const fakeBin = join(scratch, "fake-npm-bin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "npm"), FAKE_NPM, { mode: 0o755 });
    const log = join(scratch, "bootstrap.log");
    writeFileSync(log, "");
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      OE_FAKE_LOG: log,
      OE_FAKE_EVE: EVE,
      OE_FAKE_LATEST: OLD,
      OE_FAKE_INSTALL_FROM: installedPkg,
    };
    const viaNpx = run(process.execPath, [join(cachedCore, "bin", "oe.js"), "upgrade", "--plan", "--to", OLD], app, env);
    ok(
      viaNpx.status === 0 && viaNpx.output.includes("✓ oe upgrade --plan: nothing was written."),
      `🔴 from the npx-cache layout (no tsx) the compiled bin plans the upgrade — got ${viaNpx.status}\n${viaNpx.output}`,
    );
    ok(!readFileSync(log, "utf8").includes("npm install"), "…and it installed nothing");
    writeFileSync(log, "");

    const argv = runLine.split(" ");
    ok(argv[0] === "node", `the rendered run line starts with node — got ${runLine}`);
    const boot = run(process.execPath, argv.slice(1), app, env);
    const calls = readFileSync(log, "utf8").split("\n").filter((l) => l !== "");
    const sayBoot = `\n--- oe output ---\n${boot.output}\n--- calls ---\n${calls.join("\n")}`;
    ok(boot.status === 0, `🔴 the rendered bootstrap \`${runLine}\` exits 0 in a ${PRE} app — got ${boot.status}${sayBoot}`);
    ok(boot.output.includes("ships no readable upgrading.json"), `…and it reads the ABSENT installed record as a release before the record, not as a refusal${sayBoot}`);
    ok(!calls.some((c) => c.startsWith("pre-oe")), `🔴 …and it never calls the installed ${PRE} core's \`oe\`${sayBoot}`);
    const after = JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    ok(
      after.dependencies["@open-everywhere/core"] === OLD && after.dependencies["@open-everywhere/adapters"] === OLD && after.dependencies.eve === EVE,
      `…and it bumps every @open-everywhere/* pin to ${OLD} and keeps eve on the peer — got ${JSON.stringify(after.dependencies)}`,
    );
    ok(
      after.devDependencies["create-open-everywhere"] === undefined && after.devDependencies["@open-everywhere/create"] === OLD,
      `🔴 …and it RENAMES create-open-everywhere to @open-everywhere/create — got ${JSON.stringify(after.devDependencies)}`,
    );
    ok(
      boot.output.includes(`Release notes (${OLD}'s own copy):`) && boot.output.includes(`── ${OLD} (`),
      `🔴 …and after the install it reads the TARGET's own record, which holds ${OLD}'s entry${sayBoot}`,
    );
    const order = ["npm install", "installed-oe build --accept", "npm run typecheck", "npm run build"].map((c) => calls.indexOf(c));
    ok(
      order.every((i) => i >= 0) && order.every((i, n) => n === 0 || i > order[n - 1]!),
      `…and it installs, then runs the INSTALLED target's \`oe build --accept\`, then typecheck and build, in that order${sayBoot}`,
    );
    ok(boot.output.includes(`✓ oe upgrade: ${PRE} → ${OLD}.`), `…and it reports ${PRE} → ${OLD}${sayBoot}`);
    ok(!existsSync(join(app, ".open-everywhere", "upgrade-resume.json")), "…and the resume marker is cleared on success");

    const stopped = preApp("app-pre-stopped");
    const stoppedManifest = JSON.parse(readFileSync(join(stopped, "package.json"), "utf8")) as Record<string, unknown>;
    stoppedManifest.dependencies = { "@open-everywhere/adapters": OLD, "@open-everywhere/core": OLD, eve: EVE };
    stoppedManifest.devDependencies = { "@open-everywhere/create": OLD, tsx: "^4.23.9" };
    writeFileSync(join(stopped, "package.json"), `${JSON.stringify(stoppedManifest, null, 2)}\n`);
    mkdirSync(join(stopped, ".open-everywhere"), { recursive: true });
    writeFileSync(join(stopped, ".open-everywhere", "upgrade-resume.json"), `${JSON.stringify({ from: PRE, target: OLD })}\n`);
    writeFileSync(log, "");
    const again = run(process.execPath, argv.slice(1), stopped, env);
    const sayAgain = `\n--- oe output ---\n${again.output}`;
    ok(again.status === 0, `🔴 the second command, run again after a stop before the install, exits 0 — got ${again.status}${sayAgain}`);
    ok(
      again.output.includes(`Resuming from ${PRE}.`) && again.output.includes(`✓ oe upgrade: ${PRE} → ${OLD}.`),
      `…and it resumes from the version the stopped run started from${sayAgain}`,
    );
    const callsAgain = readFileSync(log, "utf8").split("\n").filter((l) => l !== "");
    ok(again.output.includes("left untouched"), `…and it leaves the already-written pins as they are${sayAgain}`);
    ok(!callsAgain.some((c) => c.startsWith("pre-oe")), `…and it never calls the installed ${PRE} core's \`oe\`${sayAgain}`);
    const resumedOrder = ["npm install", "installed-oe build --accept"].map((c) => callsAgain.indexOf(c));
    ok(
      resumedOrder[0]! >= 0 && resumedOrder[1]! > resumedOrder[0]!,
      `…and it installs before the installed target's \`oe build --accept\` — got ${callsAgain.join(", ")}`,
    );
  }

  await lockfileLeg(oldPkg);
  await lockfileLeg(oldPkg, true);
} finally {
  if (keep) console.log(`kept ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}

console.log(`✓ oe upgrade (packed): ${passed} assertions.`);

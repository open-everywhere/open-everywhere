import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCommand } from "./npm-command.js";
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
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function extract(tarball: string, dest: string): string {
  mkdirSync(dest, { recursive: true });
  const r = run("tar", ["-xzf", tarball, "-C", dest], dest);
  assert.equal(r.status, 0, `tar -xzf failed:\n${r.output}`);
  return join(dest, "package");
}

function makeNew(pkg: string, options: { readonly codemodId?: string; readonly noteIds: readonly string[] }): void {
  const manifestPath = join(pkg, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = NEW;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const notesPath = join(pkg, "scripts", "upgrade-notes.ts");
  writeFileSync(notesPath, `${readFileSync(notesPath, "utf8")}\nexport const OPE_2238_STAMP = ${JSON.stringify(STAMP)};\n`);

  if (options.codemodId !== undefined) {
    const registryPath = join(pkg, "scripts", "upgrade-codemods.ts");
    const before = readFileSync(registryPath, "utf8");
    const empty = "export const CODEMODS: readonly Codemod[] = [];";
    assert.ok(before.includes(empty), `the packed registry still declares \`${empty}\` — update this test's fixture`);
    const entry = [
      "export const CODEMODS: readonly Codemod[] = [",
      "  {",
      `    id: ${JSON.stringify(options.codemodId)},`,
      '    describe: "the OPE-2238 proof codemod, registered only in the NEW core",',
      "    run: (appRoot: string) => {",
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
const { register } = await import("tsx/esm/api");
register();
const { spawnSync } = await import("node:child_process");
const { cpSync, rmSync } = await import("node:fs");
const { join } = await import("node:path");
const [newPkg, target, eve] = process.argv.slice(2);
const core = join(process.cwd(), "node_modules", "@open-everywhere", "core");
const oldUpgrade = await import("./node_modules/@open-everywhere/core/scripts/oe-upgrade.ts");
const oldRegistry = await import("./node_modules/@open-everywhere/core/scripts/upgrade-codemods.ts");
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
    if (args.includes("upgrade-codemods")) return spawnSync(command, args, { cwd, stdio: "inherit" }).status ?? 1;
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
    `${JSON.stringify({ name, private: true, type: "module", dependencies: { "@open-everywhere/core": OLD, eve: EVE }, devDependencies: { tsx: "^4" } }, null, 2)}\n`,
  );
  cpSync(oldPkg, join(app, "node_modules", "@open-everywhere", "core"), { recursive: true });
  linkDeps(app);
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
  for (const rel of ["bin/oe.js", "scripts/oe-cli.ts", "scripts/oe-upgrade.ts", "scripts/upgrade-codemods.ts", "scripts/upgrade-notes.ts", "upgrading.json"]) {
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
  ok(proof.stamp === STAMP && proof.version === NEW, `🔴 …with the NEW core's module graph (stamp from the new upgrade-notes.ts) — got ${JSON.stringify(proof)}`);
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
      viaNpx.status !== 0 && viaNpx.output.includes("Cannot find package 'tsx'"),
      `🔴 the CONTROL: from the npx-cache layout the bin fails on the missing tsx — got ${viaNpx.status}\n${viaNpx.output}`,
    );
    ok(readFileSync(log, "utf8") === "", "…and it reached no npm call");

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
} finally {
  if (keep) console.log(`kept ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}

console.log(`✓ oe upgrade (packed): ${passed} assertions.`);

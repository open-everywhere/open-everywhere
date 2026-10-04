#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  checkEveResolution,
  checkPristineEve,
  evePatchedFilesInstalled,
  evePatchFileName,
  evePatchRecovery,
  evePatchSharedTargets,
  packageManagerOf,
  evePatchTargets,
  missingEveMarkers,
  patchDirArgument,
} from "../dist/agent/publish/eve-patch-pack.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);

function refuse(problems) {
  console.error(`✗ oe-eve-patch: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

function realOrUndefined(path) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
const pin = manifest.peerDependencies?.eve;
if (typeof pin !== "string") {
  refuse([`${manifest.name ?? "@open-everywhere/core"} declares no eve peer dependency — this install is not usable`]);
}

const consumerRoot = realpathSync(process.cwd());
const fromConsumer = createRequire(pathToFileURL(join(consumerRoot, "package.json")).href);
let resolvedManifest;
try {
  resolvedManifest = realpathSync(fromConsumer.resolve("eve/package.json"));
} catch {
  resolvedManifest = undefined;
}
const addressableManifest = realOrUndefined(join(consumerRoot, "node_modules", "eve", "package.json"));
const installedVersion =
  resolvedManifest === undefined ? undefined : JSON.parse(readFileSync(resolvedManifest, "utf8")).version;

const resolutionProblems = checkEveResolution({
  consumerRoot,
  resolvedManifest,
  addressableManifest,
  installedVersion,
  pin,
});
if (resolutionProblems.length > 0) refuse(resolutionProblems);

const eveRoot = dirname(resolvedManifest);
const patchFile = evePatchFileName(pin);
const packedPatchDir = realOrUndefined(join(PACKAGE_ROOT, "patches"));
if (packedPatchDir === undefined || !existsSync(join(packedPatchDir, patchFile))) {
  refuse([
    `this @open-everywhere/core install carries no patches/${patchFile}. The tarball ships it (the publish gate asserts ` +
      `that), so a copy without it is an incomplete install — reinstall @open-everywhere/core`,
  ]);
}
const extra = readdirSync(packedPatchDir).filter((f) => f.endsWith(".patch") && f !== patchFile);
if (extra.length > 0) {
  refuse([
    `patches/ in this install holds ${extra.join(", ")} beside ${patchFile}. patch-package applies EVERY patch in the ` +
      `directory it is pointed at, so the applier refuses rather than change a package nobody asked it to`,
  ]);
}

const patchDir = patchDirArgument({ consumerRoot, packedPatchDir });
if (!patchDir.ok) refuse([patchDir.problem]);

const patchBody = readFileSync(join(packedPatchDir, patchFile), "utf8");
const targets = evePatchTargets(patchBody);
if (targets.length === 0) {
  refuse([`patches/${patchFile} declares no target files (no "+++ b/…" header) — it cannot be applied`]);
}

let patchPackageBin;
try {
  const patchPackageManifest = createRequire(import.meta.url).resolve("patch-package/package.json");
  const { bin } = JSON.parse(readFileSync(patchPackageManifest, "utf8"));
  const entry = typeof bin === "string" ? bin : bin?.["patch-package"];
  if (typeof entry !== "string") throw new Error(`its manifest declares no patch-package bin (bin: ${JSON.stringify(bin)})`);
  patchPackageBin = join(dirname(patchPackageManifest), entry);
} catch (err) {
  refuse([
    `patch-package could not be resolved from this install: ${err instanceof Error ? err.message : String(err)}. It is a ` +
      `dependency of @open-everywhere/core, so a tree without it is incomplete — reinstall @open-everywhere/core`,
  ]);
}

console.log(
  `oe-eve-patch: eve@${installedVersion} at ${consumerRoot}/node_modules/eve — applying ${patchFile} ` +
    `(${targets.length} file(s))`,
);

const linkCounts = new Map();
for (const target of targets) {
  if (target.insidePackage === "") continue;
  const file = join(eveRoot, target.insidePackage);
  if (existsSync(file)) linkCounts.set(target.insidePackage, statSync(file).nlink);
}
const shared = evePatchSharedTargets(targets, linkCounts);
for (const rel of shared) {
  const file = join(eveRoot, rel);
  const detached = `${file}.oe-detach`;
  copyFileSync(file, detached);
  renameSync(detached, file);
}
if (shared.length > 0) {
  console.log(
    `  · detached ${shared.length} file(s) from a shared package store before patching — pnpm and bun ` +
      `hardlink from a store, and patching in place would have rewritten eve for every project on this machine`,
  );
}

function applyPatch() {
  const run = spawnSync(process.execPath, [patchPackageBin, "--patch-dir", patchDir.value, "--error-on-fail"], {
    cwd: consumerRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.error !== undefined) refuse([`patch-package could not be started: ${run.error.message}`]);
  return run;
}

function echo(run) {
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
}

function readTargets() {
  const contents = new Map();
  for (const target of targets) {
    if (target.insidePackage === "") continue;
    const file = join(eveRoot, target.insidePackage);
    contents.set(target.insidePackage, existsSync(file) ? readFileSync(file, "utf8") : undefined);
  }
  return contents;
}

function npmCommand(args) {
  const cli = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")].find(
    (p) => typeof p === "string" && /npm-cli\.js$/.test(p) && existsSync(p),
  );
  if (cli !== undefined) return [process.execPath, [cli, ...args]];
  return ["npm", args];
}

function listFiles(dir, prefix = "") {
  const files = [];
  const entries = readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(dir, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

function discard(copy) {
  try {
    rmSync(copy, { force: true });
  } catch {
  }
}

function restorePristineEve() {
  let work;
  try {
    work = mkdtempSync(join(tmpdir(), "oe-eve-pristine-"));
    const [command, args] = npmCommand(["pack", `eve@${pin}`, "--prefer-offline", "--pack-destination", work]);
    const packed = spawnSync(command, args, { cwd: consumerRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const tarball = packed.status === 0 ? readdirSync(work).find((f) => f.endsWith(".tgz")) : undefined;
    if (tarball === undefined) {
      const why = packed.error?.message ?? (packed.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
      return { ok: false, problem: `npm could not fetch the pristine eve@${pin} tarball (${why || `exit ${packed.status}`})` };
    }
    const unpacked = join(work, "unpacked");
    mkdirSync(unpacked);
    const extracted = spawnSync("tar", ["-xzf", tarball, "-C", "unpacked"], { cwd: work, encoding: "utf8" });
    if (extracted.status !== 0) {
      const why = extracted.error?.message ?? (extracted.stderr ?? "").trim();
      return { ok: false, problem: `tar could not unpack the pristine eve@${pin} tarball (${why || `exit ${extracted.status}`})` };
    }
    const pristineRoot = join(unpacked, "package");
    let pristineManifest;
    try {
      pristineManifest = JSON.parse(readFileSync(join(pristineRoot, "package.json"), "utf8"));
    } catch {
      pristineManifest = {};
    }
    const wrong = checkPristineEve({ name: pristineManifest.name, version: pristineManifest.version, pin });
    if (wrong.length > 0) return { ok: false, problem: wrong[0] };

    const changed = listFiles(pristineRoot).filter((rel) => {
      const installed = join(eveRoot, rel);
      return !existsSync(installed) || !readFileSync(installed).equals(readFileSync(join(pristineRoot, rel)));
    });
    const staged = [];
    try {
      for (const rel of changed) {
        mkdirSync(dirname(join(eveRoot, rel)), { recursive: true });
        const copy = `${join(eveRoot, rel)}.oe-restore`;
        copyFileSync(join(pristineRoot, rel), copy);
        staged.push(copy);
      }
    } catch (err) {
      for (const copy of staged) discard(copy);
      return { ok: false, problem: `the applier could not stage the pristine eve@${pin} files (${err instanceof Error ? err.message : String(err)})` };
    }
    let renamed = 0;
    try {
      for (const rel of changed) {
        renameSync(`${join(eveRoot, rel)}.oe-restore`, join(eveRoot, rel));
        renamed++;
      }
    } catch (err) {
      for (const copy of staged.slice(renamed)) discard(copy);
      return {
        ok: false,
        partial: true,
        problem:
          `the applier restored ${renamed} of ${changed.length} eve file(s) and then could not replace ` +
          `${changed[renamed]} (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    return { ok: true, restored: changed };
  } catch (err) {
    return { ok: false, problem: `the applier could not prepare the pristine eve@${pin} (${err instanceof Error ? err.message : String(err)})` };
  } finally {
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }
}

const packageManager = packageManagerOf(process.env.npm_config_user_agent);

let applied = applyPatch();
if (applied.status !== 0) {
  const carrying = evePatchedFilesInstalled(readTargets());
  if (carrying.length === 0) {
    echo(applied);
    refuse([
      `patch-package exited ${applied.status ?? `on signal ${applied.signal}`} — the patch did not apply. Its output above ` +
        `names the hunk. An eve whose bytes were already modified is the usual cause: reinstall eve@${pin} and try again`,
      evePatchRecovery(pin, packageManager),
    ]);
  }
  console.log(
    `  · eve@${installedVersion} already carries an older OE patch (${carrying.length} file(s)), so ${patchFile} cannot ` +
      `apply over it — restoring eve@${pin}'s pristine bytes from the npm cache or registry, then applying again`,
  );
  const restore = restorePristineEve();
  if (!restore.ok) {
    echo(applied);
    const state = restore.partial
      ? "The installed eve is PARTLY restored: it carries neither patch whole, and the boot probe refuses it"
      : "The installed eve is unchanged and still carries the older OE patch";
    refuse([`${restore.problem}. ${state}`, evePatchRecovery(pin, packageManager)]);
  }
  console.log(`  · restored ${restore.restored.length} file(s) of eve@${pin} to their pristine bytes:`);
  for (const rel of restore.restored) console.log(`      ${rel}`);
  applied = applyPatch();
  echo(applied);
  if (applied.status !== 0) {
    refuse([
      `patch-package exited ${applied.status ?? `on signal ${applied.signal}`} on the RESTORED, pristine eve@${pin} — the ` +
        `packed ${patchFile} does not apply to eve's registry bytes. eve now carries no OE patch; the boot probe refuses it`,
      evePatchRecovery(pin, packageManager),
    ]);
  }
} else {
  echo(applied);
}

const missing = missingEveMarkers(targets, readTargets());
if (missing.length > 0) refuse(missing);

for (const target of targets) {
  for (const part of target.parts) console.log(`  ✓ ${part.ticket} — ${part.title} (${target.path})`);
  if (target.parts.length > 0) continue;
  console.log(
    `  ✓ ${target.path} — applied; the patch declares no part header for this file` +
      `${target.markers.length > 0 ? `, markers: ${target.markers.join(", ")}` : " and it adds no __oe marker"}`,
  );
}

console.log(`✓ oe-eve-patch: eve@${installedVersion} carries the OE patch (${targets.length} file(s) verified)`);

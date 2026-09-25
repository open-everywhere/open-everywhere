#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  checkEveResolution,
  evePatchFileName,
  evePatchSharedTargets,
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

const applied = spawnSync(process.execPath, [patchPackageBin, "--patch-dir", patchDir.value, "--error-on-fail"], {
  cwd: consumerRoot,
  stdio: ["ignore", "inherit", "inherit"],
});
if (applied.error !== undefined) {
  refuse([`patch-package could not be started: ${applied.error.message}`]);
}
if (applied.status !== 0) {
  refuse([
    `patch-package exited ${applied.status ?? `on signal ${applied.signal}`} — the patch did not apply. Its output above ` +
      `names the hunk. An eve whose bytes were already modified is the usual cause: reinstall eve@${pin} and try again`,
  ]);
}

const contents = new Map();
for (const target of targets) {
  if (target.insidePackage === "") continue;
  const file = join(eveRoot, target.insidePackage);
  contents.set(target.insidePackage, existsSync(file) ? readFileSync(file, "utf8") : undefined);
}
const missing = missingEveMarkers(targets, contents);
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

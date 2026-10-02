import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmCommand } from "./npm-command.js";

import { evePatchFileName, evePatchTargets } from "@open-everywhere/core/agent/publish/eve-patch-pack.js";
import { ALL_PUBLISHABLE_PACKAGES } from "./publish-exports-generate.js";
import { packPublishablePackages } from "./publish-pack.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = <T>(actual: T, expected: T, label: string): void => {
  assert.deepEqual(actual, expected, label);
  n++;
};

const REPO_ROOT = process.cwd();
const keep = process.argv.includes("--keep");

function run(cmd: string, args: readonly string[], cwd: string): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(cmd, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const core = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "core", "package.json"), "utf8")) as {
  name: string;
  peerDependencies: { eve: string };
  bin: Record<string, string>;
};
const PIN = core.peerDependencies.eve;
const PATCH_FILE = evePatchFileName(PIN);
const targets = evePatchTargets(readFileSync(join(REPO_ROOT, "patches", PATCH_FILE), "utf8"));
const markers = [...new Set(targets.flatMap((t) => t.markers))].sort();
ok(targets.length > 0, `the committed patches/${PATCH_FILE} declares at least one target file`);
ok(markers.length > 0, `the committed patches/${PATCH_FILE} adds at least one __oe marker to assert`);

const scratch = mkdtempSync(join(tmpdir(), "oe-cold-install-"));
const consumer = join(scratch, "consumer");
try {
  const packed = packPublishablePackages(REPO_ROOT, join(scratch, "tarballs")).map((p) => p.tarball);
  n++;
  ok(packed.length === ALL_PUBLISHABLE_PACKAGES.length, `packed all ${ALL_PUBLISHABLE_PACKAGES.length} publishable packages`);

  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "oe-cold-install-probe", version: "1.0.0", private: true, type: "module" }, null, 2)}\n`,
  );
  const install = run(...npmCommand(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel", "error", `eve@${PIN}`, ...packed]), consumer);
  assert.equal(install.code, 0, `npm install into the cold tree failed:\n${install.out}`);
  n++;

  const eveDist = join(consumer, "node_modules", "eve", "dist");
  ok(existsSync(eveDist), "the cold tree resolved eve — it is a peer, so the consumer installs it");
  const installedEveVersion = (JSON.parse(readFileSync(join(consumer, "node_modules", "eve", "package.json"), "utf8")) as { version: string }).version;
  eq(installedEveVersion, PIN, "the cold tree's eve is the pinned version");

  const read = (target: { insidePackage: string }): string | undefined => {
    const file = join(consumer, "node_modules", "eve", target.insidePackage);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  };
  for (const marker of markers) {
    const carriers = targets.filter((t) => (read(t) ?? "").includes(marker)).map((t) => t.path);
    eq(carriers, [], `BEFORE: the registry eve carries no \`${marker}\` — the OPE-2168 premise`);
  }

  const packedCore = join(consumer, "node_modules", core.name);
  for (const bin of Object.keys(core.bin)) {
    ok(existsSync(join(consumer, "node_modules", ".bin", bin)), `npm linked the \`${bin}\` bin into the cold tree`);
  }
  eq(
    readdirSync(join(packedCore, "patches")).filter((f) => f.endsWith(".patch")),
    [PATCH_FILE],
    "the installed package carries exactly the pinned patch, and no other",
  );
  eq(
    readFileSync(join(packedCore, "patches", PATCH_FILE), "utf8"),
    readFileSync(join(REPO_ROOT, "patches", PATCH_FILE), "utf8"),
    "the installed patch is byte-identical to the repository's own",
  );

  const createVersion = (JSON.parse(readFileSync(join(REPO_ROOT, "packages", "create", "package.json"), "utf8")) as { version: string }).version;
  const scaffolder = run(...npmCommand(["exec", "--no", "--", "create-open-everywhere", "--version"]), consumer);
  assert.equal(scaffolder.code, 0, `create-open-everywhere --version failed on the unpatched cold tree:\n${scaffolder.out}`);
  n++;
  eq(scaffolder.out.trim().split("\n").pop()?.trim(), createVersion, "create-open-everywhere --version prints its own version on the unpatched tree");

  const applied = run(...npmCommand(["exec", "--no", "--", "oe-eve-patch"]), consumer);
  assert.equal(applied.code, 0, `npx oe-eve-patch failed in the cold tree:\n${applied.out}`);
  n++;
  for (const marker of markers) {
    const carriers = targets.filter((t) => (read(t) ?? "").includes(marker)).map((t) => t.path);
    ok(carriers.length > 0, `AFTER: the cold tree's eve carries \`${marker}\` (in ${carriers.join(", ") || "no file"})`);
  }
  const harness = join(eveDist, "src", "harness");
  const projectionCarriers = readdirSync(harness, { withFileTypes: true })
    .filter((e) => e.isFile() && readFileSync(join(harness, e.name), "utf8").includes("__oeProjectToolSet"))
    .map((e) => e.name);
  ok(projectionCarriers.length > 0, `AFTER: eve/dist/src/harness carries __oeProjectToolSet (${projectionCarriers.join(", ")})`);

  const again = run(...npmCommand(["exec", "--no", "--", "oe-eve-patch"]), consumer);
  assert.equal(again.code, 0, `a second npx oe-eve-patch failed:\n${again.out}`);
  n++;
  for (const marker of markers) {
    ok(targets.some((t) => (read(t) ?? "").includes(marker)), `AFTER a second run: \`${marker}\` is still there`);
  }
} finally {
  if (keep) console.log(`\n(--keep) the cold tree is at ${consumer}`);
  else rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n✓ publish-cold-install: ${n} assertions passed (${markers.length} marker(s) absent before and present after \`npx oe-eve-patch\`)\n`);

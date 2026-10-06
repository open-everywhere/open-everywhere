import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evePatchFileName, evePatchTargets, missingEveMarkers } from "../packages/core/agent/publish/eve-patch-pack.js";
import { npmCommand } from "./npm-command.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_DIR = join(REPO, "packages", "core");
const FIXTURES = join(REPO, "scripts", "fixtures");

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed++;
}

const coreManifest = JSON.parse(readFileSync(join(CORE_DIR, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};
const PIN = coreManifest.peerDependencies.eve!;
const PATCH_FILE = evePatchFileName(PIN);
const TARGETS = evePatchTargets(readFileSync(join(CORE_DIR, "patches", PATCH_FILE), "utf8"));

const RELEASES = readdirSync(FIXTURES)
  .filter((d) => d.startsWith("eve-patch-"))
  .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
ok(RELEASES.length > 0, `${FIXTURES} holds at least one eve-patch-<release>/ fixture`);
for (const release of RELEASES) {
  ok(
    readdirSync(join(FIXTURES, release)).some((f) => /^eve\+.+\.patch$/.test(f)),
    `${release}/ holds the patch file that release shipped`,
  );
}
const OLD_RELEASE = RELEASES.filter((d) => existsSync(join(FIXTURES, d, PATCH_FILE))).at(-1);
if (OLD_RELEASE === undefined) {
  const shipped = RELEASES.map((d) => `${d.slice("eve-patch-".length)} (${readdirSync(join(FIXTURES, d)).join(", ")})`).join("; ");
  console.log(
    `✓ eve patch upgrade (packed): SKIPPED, the restore and refusal routes are not driven. No older patch to upgrade from — no released OE patch exists for eve@${PIN}. ` +
      `The fixtures hold only released patches for other pins: ${shipped}. An app that moves to eve@${PIN} installs a pristine eve, so the ` +
      `restore route has nothing to restore. ${passed} assertions.`,
  );
  process.exit(0);
}
const OLD_PATCH_DIR = join(FIXTURES, OLD_RELEASE);
const OLD_VERSION = OLD_RELEASE.slice("eve-patch-".length);
const OLD_TARGETS = evePatchTargets(readFileSync(join(OLD_PATCH_DIR, PATCH_FILE), "utf8"));

const scratch = mkdtempSync(join(tmpdir(), "oe-eve-patch-upgrade-"));
const keep = process.argv.includes("--keep");

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): { status: number; output: string } {
  try {
    const output = execFileSync(command, [...args], { cwd, ...(env === undefined ? {} : { env }), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
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

function targetContents(eveDir: string): Map<string, string | undefined> {
  const contents = new Map<string, string | undefined>();
  for (const t of TARGETS) {
    const file = join(eveDir, t.insidePackage);
    contents.set(t.insidePackage, existsSync(file) ? readFileSync(file, "utf8") : undefined);
  }
  return contents;
}

function appOnOldEve(corePkg: string, evePkg: string, name: string): string {
  const app = join(scratch, name);
  mkdirSync(join(app, "node_modules", "@open-everywhere"), { recursive: true });
  const postinstall =
    process.platform === "win32" ? "node node_modules/@open-everywhere/core/bin/oe-eve-patch.js" : "oe-eve-patch";
  writeFileSync(
    join(app, "package.json"),
    `${JSON.stringify({ name, private: true, type: "module", scripts: { postinstall }, dependencies: { "@open-everywhere/core": "*", eve: PIN } }, null, 2)}\n`,
  );
  const core = join(app, "node_modules", "@open-everywhere", "core");
  cpSync(corePkg, core, { recursive: true });
  cpSync(evePkg, join(app, "node_modules", "eve"), { recursive: true });
  for (const dep of Object.keys(coreManifest.dependencies)) {
    const from = join(REPO, "node_modules", ...dep.split("/"));
    if (!existsSync(from)) continue;
    const to = join(app, "node_modules", ...dep.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
  }
  if (process.platform !== "win32") {
    chmodSync(join(core, "bin", "oe-eve-patch.js"), 0o755);
    mkdirSync(join(app, "node_modules", ".bin"));
    symlinkSync("../@open-everywhere/core/bin/oe-eve-patch.js", join(app, "node_modules", ".bin", "oe-eve-patch"));
  }

  const oldPatchDir = join(app, "old-patch");
  cpSync(OLD_PATCH_DIR, oldPatchDir, { recursive: true });
  const patchPackage = join(REPO, "node_modules", "patch-package", "index.js");
  const applied = run(process.execPath, [patchPackage, "--patch-dir", "old-patch", "--error-on-fail"], app);
  assert.equal(applied.status, 0, `the ${OLD_VERSION} patch did not apply to the pristine eve:\n${applied.output}`);
  rmSync(oldPatchDir, { recursive: true, force: true });
  return app;
}

try {
  const [packCmd, packArgs] = npmCommand(["pack", "--workspace", "@open-everywhere/core", "--pack-destination", scratch, "--loglevel", "error", "--ignore-scripts"]);
  const packedCore = run(packCmd, packArgs, REPO);
  assert.equal(packedCore.status, 0, `npm pack @open-everywhere/core failed:\n${packedCore.output}`);
  const corePkg = extract(join(scratch, packedCore.output.trim().split("\n").pop()!.trim()), join(scratch, "core"));
  ok(existsSync(join(corePkg, "patches", PATCH_FILE)), `the packed core carries patches/${PATCH_FILE}`);

  const eveTgzDir = join(scratch, "eve-tgz");
  mkdirSync(eveTgzDir);
  const [evePackCmd, evePackArgs] = npmCommand(["pack", `eve@${PIN}`, "--prefer-offline", "--pack-destination", eveTgzDir, "--loglevel", "error"]);
  const packedEve = run(evePackCmd, evePackArgs, REPO);
  assert.equal(packedEve.status, 0, `npm pack eve@${PIN} failed (the npm cache should hold it after npm ci):\n${packedEve.output}`);
  const evePkg = extract(join(eveTgzDir, readdirSync(eveTgzDir).find((f) => f.endsWith(".tgz"))!), join(scratch, "eve"));

  ok(OLD_TARGETS.length < TARGETS.length, `the ${OLD_VERSION} patch changes fewer files than the packed patch`);
  const app = appOnOldEve(corePkg, evePkg, "app");
  const eveDir = join(app, "node_modules", "eve");
  const missingBefore = missingEveMarkers(TARGETS, targetContents(eveDir));
  ok(missingBefore.length > 0, `the ${OLD_VERSION} tree lacks at least one marker the packed patch adds`);
  ok(
    OLD_TARGETS.every((t) => /__oe[A-Za-z0-9_]/.test(readFileSync(join(eveDir, t.insidePackage), "utf8")) || t.markers.length === 0),
    `the ${OLD_VERSION} tree carries the ${OLD_VERSION} patch's OE bytes`,
  );

  const [npmRunCmd, npmRunArgs] = npmCommand(["run", "postinstall"]);
  const upgraded = run(npmRunCmd, npmRunArgs, app);
  const say = `\n--- postinstall output ---\n${upgraded.output}`;
  ok(upgraded.status === 0, `🔴 postinstall exits 0 on a ${OLD_VERSION} eve — got ${upgraded.status}${say}`);
  ok(upgraded.output.includes("already carries an older OE patch"), `the applier says it found an older OE patch${say}`);
  ok(/restored \d+ file\(s\)/.test(upgraded.output), `the applier says it restored pristine bytes${say}`);
  ok(
    OLD_TARGETS.every((t) => t.markers.length === 0 || upgraded.output.includes(`      ${t.insidePackage}`)),
    `the applier names each restored file${say}`,
  );
  ok(!upgraded.output.includes("**ERROR**"), `a repaired failure prints no patch-package error block${say}`);
  const missingAfter = missingEveMarkers(TARGETS, targetContents(eveDir));
  ok(missingAfter.length === 0, `every marker the packed patch adds is in eve: ${missingAfter.join("; ")}`);
  const repoEve = join(REPO, "node_modules", "eve");
  for (const t of TARGETS) {
    ok(
      readFileSync(join(eveDir, t.insidePackage), "utf8") === readFileSync(join(repoEve, t.insidePackage), "utf8"),
      `🔴 ${t.insidePackage} is byte-identical to this repository's eve (pristine eve plus the same patch)`,
    );
  }

  const again = run(npmRunCmd, npmRunArgs, app);
  ok(again.status === 0, `a second postinstall exits 0\n${again.output}`);
  ok(!again.output.includes("older OE patch"), `a second postinstall restores nothing\n${again.output}`);

  const stuck = appOnOldEve(corePkg, evePkg, "app-offline");
  const stuckEve = join(stuck, "node_modules", "eve");
  const emptyCache = join(scratch, "empty-cache");
  mkdirSync(emptyCache);
  const offlineEnv = { ...process.env, npm_config_offline: "true", npm_config_cache: emptyCache };
  const before = targetContents(stuckEve);
  const refused = run(npmRunCmd, npmRunArgs, stuck, offlineEnv);
  const sayRefused = `\n--- postinstall output ---\n${refused.output}`;
  ok(refused.status !== 0, `🔴 postinstall fails when the pristine eve cannot be fetched — got ${refused.status}${sayRefused}`);
  ok(
    refused.output.includes(`node -e "require('fs').rmSync('node_modules/eve',{recursive:true,force:true})"`) &&
      refused.output.includes("`npm install`"),
    `the refusal prints the recovery commands${sayRefused}`,
  );
  ok(refused.output.includes("unchanged"), `the refusal says eve is unchanged${sayRefused}`);
  const after = targetContents(stuckEve);
  ok(
    TARGETS.every((t) => after.get(t.insidePackage) === before.get(t.insidePackage)),
    "🔴 the refused run left every patched file's bytes as they were — no half-patched tree",
  );

  const blocked = appOnOldEve(corePkg, evePkg, "app-blocked");
  const blockedEve = join(blocked, "node_modules", "eve");
  const lastTarget = OLD_TARGETS.map((t) => t.insidePackage).sort().at(-1)!;
  ok(OLD_TARGETS.some((t) => t.insidePackage < lastTarget), "case 3 stages at least one copy before the blocked file");
  mkdirSync(join(blockedEve, `${lastTarget}.oe-restore`));
  const blockedBefore = targetContents(blockedEve);
  const stopped = run(npmRunCmd, npmRunArgs, blocked);
  const sayStopped = `\n--- postinstall output ---\n${stopped.output}`;
  ok(stopped.status === 1, `🔴 postinstall fails when a staged copy fails — got ${stopped.status}${sayStopped}`);
  ok(stopped.output.includes("could not stage") && stopped.output.includes("unchanged"), `the refusal names the staging failure${sayStopped}`);
  ok(stopped.output.includes("`npm install`"), `the refusal prints the recovery commands${sayStopped}`);
  ok(!stopped.output.includes("    at "), `the refusal carries no stack trace${sayStopped}`);
  const blockedAfter = targetContents(blockedEve);
  ok(
    TARGETS.every((t) => blockedAfter.get(t.insidePackage) === blockedBefore.get(t.insidePackage)),
    "🔴 the failed staging left every patched file's bytes as they were",
  );
  ok(
    OLD_TARGETS.filter((t) => t.insidePackage !== lastTarget).every((t) => !existsSync(join(blockedEve, `${t.insidePackage}.oe-restore`))),
    "🔴 the copies staged before the failure were removed",
  );
} finally {
  if (keep) console.log(`kept ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}

console.log(`✓ eve patch upgrade (packed): ${passed} assertions.`);

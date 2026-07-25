import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
for (;;) {
  const pkg = join(repoRoot, "package.json");
  if (existsSync(pkg) && typeof JSON.parse(readFileSync(pkg, "utf8")).workspaces !== "undefined") break;
  const up = dirname(repoRoot);
  if (up === repoRoot) throw new Error("eve-install-integrity: could not locate the workspace root from " + here);
  repoRoot = up;
}
const rel = (p: string): string => relative(repoRoot, p) || ".";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".claude",
  ".next",
  ".vercel",
  ".output",
  ".turbo",
  "dist",
  "build",
  "coverage",
  "tmp",
]);

const manifestDirs: string[] = [];
const walkSource = (dir: string): void => {
  if (existsSync(join(dir, "package.json"))) manifestDirs.push(dir);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
    walkSource(join(dir, e.name));
  }
};
walkSource(repoRoot);

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const pins: { file: string; field: string; version: string }[] = [];
for (const dir of manifestDirs) {
  const file = join(dir, "package.json");
  const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string> | undefined>;
  for (const field of DEP_FIELDS) {
    const v = json[field]?.eve;
    if (typeof v === "string") pins.push({ file: rel(file), field, version: v });
  }
}

ok(pins.length > 0, "pins: at least one package.json in the tree depends on eve (zero would mean this gate checks nothing)");

const pinned = pins[0]!.version;
const diverged = pins.filter((p) => p.version !== pinned);
assert.ok(
  diverged.length === 0,
  `pins: every package.json must pin the SAME eve version. ${pins[0]!.file} (${pins[0]!.field}) pins "${pinned}" but ` +
    diverged
      .map((p) => `${p.file} (${p.field}) pins "${p.version}"`)
      .join("; ") +
    ". A divergent pin installs a NESTED node_modules/eve that patch-package never patches — " +
    "the OE hooks (__oeForceContinue, __oeProjectToolSet) are silently absent from it.",
);
n++;
ok(/^\d+\.\d+\.\d+$/.test(pinned), `pins: eve is pinned to an EXACT version (got "${pinned}") — a range would let the installed bytes drift off the patch`);

const patchFile = join(repoRoot, "patches", `eve+${pinned}.patch`);
ok(
  existsSync(patchFile),
  `patch: patches/eve+${pinned}.patch exists for the pinned version — a pin bump that leaves the ` +
    `patch filename behind makes patch-package silently skip the OE hooks (found: ${readdirSync(join(repoRoot, "patches")).filter((f) => f.startsWith("eve+")).join(", ") || "none"})`,
);

const copies: string[] = [];
const seen = new Set<string>();
const collectCopies = (pkgDir: string): void => {
  const nm = join(pkgDir, "node_modules");
  if (!existsSync(nm)) return;
  const eveDir = join(nm, "eve");
  if (existsSync(join(eveDir, "package.json")) && basename(dirname(eveDir)) === "node_modules") copies.push(eveDir);
  for (const e of readdirSync(nm, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (e.name.startsWith("@")) {
      for (const s of readdirSync(join(nm, e.name), { withFileTypes: true })) {
        if (s.isDirectory()) collectCopies(join(nm, e.name, s.name));
      }
      continue;
    }
    collectCopies(join(nm, e.name));
  }
};
for (const dir of [repoRoot, ...manifestDirs]) {
  const key = resolve(dir);
  if (seen.has(key)) continue;
  seen.add(key);
  collectCopies(dir);
}

ok(
  copies.length > 0,
  "copies: at least one node_modules/eve is installed — finding zero would mean this gate silently verified nothing (run `npm install` from the repo root)",
);

const TOOL_LOOP = join("dist", "src", "harness", "tool-loop.js");
for (const eveDir of copies) {
  const where = rel(eveDir);
  const version = (JSON.parse(readFileSync(join(eveDir, "package.json"), "utf8")) as { version?: string }).version;
  ok(
    version === pinned,
    `copies: ${where} is eve@${version} but the tree pins ${pinned} — a version-skewed copy is unpatched and can be resolved by anything that imports eve from inside that package`,
  );
  const toolLoop = join(eveDir, TOOL_LOOP);
  ok(existsSync(toolLoop), `copies: ${where}/${TOOL_LOOP} exists (if eve moved the harness file, the patch and every sibling test are stale)`);
  const src = readFileSync(toolLoop, "utf8");
  ok(
    src.includes("__oeForceContinue"),
    `copies: ${where} carries the __oeForceContinue hook (force-tool-turn / step-ceiling patch) — an unpatched copy means turn continuation and the step ceiling are silently absent`,
  );
  ok(
    src.includes("__oeProjectToolSet"),
    `copies: ${where} carries the __oeProjectToolSet hook (OPE-73) — an unpatched copy means authored toModelOutput is dropped on session-mounted dynamic tools, so untrusted-content envelopes never reach the model (prompt-injection containment regression)`,
  );
}

console.log(
  `\n✓ eve-install-integrity: ${n} assertions passed (${pins.length} pins all @${pinned}, patch file present, ${copies.length} installed cop${copies.length === 1 ? "y" : "ies"} patched)\n`,
);

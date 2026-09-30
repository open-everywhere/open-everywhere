import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultTemplateDir,
  listFiles,
  NAME_PLACEHOLDER,
  packageNameFor,
  scaffoldPathFor,
  scaffoldApp,
  ScaffoldRefusal,
  VERSION_PLACEHOLDER,
} from "../src/scaffold.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = <T>(actual: T, expected: T, label: string): void => {
  assert.deepEqual(actual, expected, label);
  n++;
};

const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));
const TEMPLATE = defaultTemplateDir();

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
}
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const publishable = [
  ...readdirSync(PACKAGES).map((d) => join(PACKAGES, d)),
  ...readdirSync(join(PACKAGES, "providers")).map((d) => join(PACKAGES, "providers", d)),
]
  .filter((dir) => existsSync(join(dir, "package.json")))
  .map((dir) => readJson<Manifest>(join(dir, "package.json")))
  .filter((m) => m.private !== true);
const lockstepNames = publishable.map((m) => m.name).sort();
const wizard = publishable.find((m) => m.name === "create-open-everywhere");
const core = publishable.find((m) => m.name === "@open-everywhere/core");
assert.ok(wizard && core, "the repository's packages/ holds create-open-everywhere and @open-everywhere/core");
eq(lockstepNames.length, 9, "the lockstep set is nine packages (eight libraries + this wizard)");
ok(publishable.every((m) => m.version === wizard.version), "every lockstep package carries the wizard's version — the premise the placeholder rests on");

const tpl = readJson<Manifest>(join(TEMPLATE, "package.json"));
const allDeps = { ...tpl.dependencies, ...tpl.devDependencies };
const placeholdered = Object.entries(allDeps)
  .filter(([, v]) => v === VERSION_PLACEHOLDER)
  .map(([k]) => k)
  .sort();
eq(placeholdered, lockstepNames, "template package.json: the version placeholder sits on exactly the nine lockstep packages");
ok(
  Object.entries(allDeps).every(([k, v]) => !k.startsWith("@open-everywhere/") || v === VERSION_PLACEHOLDER),
  "template package.json: no @open-everywhere/* dependency carries a hard-coded version",
);
eq(tpl.dependencies?.eve, core.peerDependencies?.eve, "template package.json: eve is pinned exactly to core's peer pin");
eq(tpl.overrides?.zod, core.dependencies?.zod, "template package.json: the zod override is the zod core pins (consuming-as-packages §3)");
eq(tpl.name, NAME_PLACEHOLDER, "template package.json: the name is the placeholder the scaffold fills");
eq((tpl as { scripts?: Record<string, string> }).scripts?.postinstall, "oe-eve-patch", "template package.json: postinstall applies the eve patch");
for (const hook of ["prebuild", "predev", "prestart"]) {
  eq((tpl as { scripts?: Record<string, string> }).scripts?.[hook], "oe build", `template package.json: ${hook} runs \`oe build\``);
}

const lock = readJson<{ packages: Record<string, { version: string }> }>(join(TEMPLATE, "roster.lock.json"));
ok(Object.keys(lock.packages).length > 0, "template roster.lock.json records at least one package");
ok(
  Object.values(lock.packages).every((p) => p.version === VERSION_PLACEHOLDER),
  "template roster.lock.json: every package version is the placeholder",
);
ok(
  Object.keys(lock.packages).every((name) => lockstepNames.includes(name)),
  "template roster.lock.json: every locked package is a lockstep package",
);

const templateFiles = listFiles(TEMPLATE);
for (const rel of templateFiles) {
  const text = readFileSync(join(TEMPLATE, ...rel.split("/")), "utf8");
  const hasPlaceholder = text.includes("{{");
  const allowed = rel === "package.json" || rel === "roster.lock.json";
  ok(!hasPlaceholder || allowed, `template ${rel}: a placeholder appears only in package.json and roster.lock.json`);
  ok(!text.includes("\r\n"), `template ${rel}: LF line endings`);
}
const REFERENCE_APP = join(PACKAGES, "..");
for (const rel of templateFiles.filter((f) => f.endsWith(".generated.ts") && !f.startsWith("agent/plugins/"))) {
  eq(
    readFileSync(join(TEMPLATE, ...rel.split("/")), "utf8"),
    readFileSync(join(REFERENCE_APP, ...rel.split("/")), "utf8"),
    `template ${rel}: byte-identical to the reference app's canonical overlay`,
  );
}
ok(!templateFiles.includes(".gitignore"), "template: no `.gitignore` (npm never packs one) — it ships as `gitignore`");
ok(templateFiles.includes("gitignore"), "template: carries `gitignore` for the scaffold to rename");
ok(
  !templateFiles.some((f) => /(^|\/)\.claude\//.test(f)),
  "template: no path under `.claude/` (the publish preview's harness-tree rule refuses one in any tarball)",
);
ok(templateFiles.includes("claude/skills/quickstart-open-everywhere/SKILL.md"), "template: carries the setup skill under `claude/` for the scaffold to rename");
ok(!templateFiles.some((f) => f === ".env" || f === ".env.local"), "template: carries no env file with values");

const scratch = mkdtempSync(join(tmpdir(), "oe-scaffold-test-"));
try {
  const version = "9.8.7";
  const target = join(scratch, "My Agent!");
  const result = scaffoldApp({ targetDir: target, version });
  eq(
    result.files,
    templateFiles.map(scaffoldPathFor).sort(),
    "scaffold: writes every template file, with `gitignore` renamed",
  );
  ok(existsSync(join(target, ".gitignore")), "scaffold: .gitignore exists in the app");
  ok(!existsSync(join(target, "gitignore")), "scaffold: no stray `gitignore` is left in the app (negative control)");
  ok(existsSync(join(target, ".claude", "skills", "quickstart-open-everywhere", "SKILL.md")), "scaffold: claude/ is renamed to .claude/ (the skill lands where Claude Code reads it)");
  ok(!existsSync(join(target, "claude")), "scaffold: no stray `claude/` is left in the app (negative control)");

  const app = readJson<Manifest>(join(target, "package.json"));
  eq(app.name, "my-agent", "scaffold: the package name derives from the directory name");
  const appDeps = { ...app.dependencies, ...app.devDependencies };
  eq(
    lockstepNames.map((name) => appDeps[name]),
    lockstepNames.map(() => version),
    "scaffold: every lockstep package is pinned to the wizard version",
  );
  for (const rel of result.files) {
    const text = readFileSync(join(target, ...rel.split("/")), "utf8");
    ok(!text.includes(VERSION_PLACEHOLDER) && !text.includes(NAME_PLACEHOLDER), `scaffold ${rel}: no placeholder survives`);
  }
  const appLock = readJson<{ packages: Record<string, { version: string }> }>(join(target, "roster.lock.json"));
  ok(Object.values(appLock.packages).every((p) => p.version === version), "scaffold: roster.lock.json records the wizard version");
  eq(
    readFileSync(join(target, "agent", "agent.ts"), "utf8"),
    readFileSync(join(TEMPLATE, "agent", "agent.ts"), "utf8"),
    "scaffold: a file with no placeholder is copied byte for byte",
  );

  const refuses = (label: string, fn: () => unknown, pattern: RegExp): void => {
    let caught: unknown;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    ok(caught instanceof ScaffoldRefusal && pattern.test(caught.message), label);
  };
  const busy = join(scratch, "busy");
  mkdirSync(busy);
  writeFileSync(join(busy, "keep.txt"), "mine\n");
  refuses("scaffold: refuses a non-empty directory", () => scaffoldApp({ targetDir: busy, version }), /not empty/);
  eq(readdirSync(busy), ["keep.txt"], "scaffold: a refused directory is left untouched");
  refuses("scaffold: refuses a second scaffold into the app it just wrote", () => scaffoldApp({ targetDir: target, version }), /not empty/);
  const file = join(scratch, "a-file");
  writeFileSync(file, "x");
  refuses("scaffold: refuses a path that is a file", () => scaffoldApp({ targetDir: file, version }), /not a directory/);
  refuses("scaffold: refuses a version that is not semver", () => scaffoldApp({ targetDir: join(scratch, "v"), version: "unknown" }), /not a release version/);
  refuses(
    "scaffold: refuses 0.0.0 — the version src/version.ts falls back to when it cannot read its manifest",
    () => scaffoldApp({ targetDir: join(scratch, "v"), version: "0.0.0" }),
    /not a release version/,
  );
  ok(!existsSync(join(scratch, "v")), "scaffold: a version refusal creates no directory");
  const empty = join(scratch, "empty");
  mkdirSync(empty);
  ok(scaffoldApp({ targetDir: empty, version }).files.length === result.files.length, "scaffold: an existing EMPTY directory is accepted");

  eq(packageNameFor("/x/.Hidden_App"), "hidden_app", "packageNameFor: strips a leading dot and lowercases");
  eq(packageNameFor("/x/---"), "open-everywhere-app", "packageNameFor: falls back when nothing usable is left");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`✓ ${n} scaffold assertions passed`);

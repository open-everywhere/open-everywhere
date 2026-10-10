import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defaultTemplateDir,
  isScaffoldableDir,
  listFiles,
  NAME_PLACEHOLDER,
  packageNameFor,
  scaffoldPathFor,
  scaffoldApp,
  ScaffoldRefusal,
  VERCEL_GITIGNORE_LINES,
  VERSION_PLACEHOLDER,
  withGitignoreEol,
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
const scaffolder = publishable.find((m) => m.name === "@open-everywhere/create");
const core = publishable.find((m) => m.name === "@open-everywhere/core");
assert.ok(scaffolder && core, "the repository's packages/ holds @open-everywhere/create and @open-everywhere/core");
eq(lockstepNames.length, 9, "the lockstep set is nine packages (eight libraries + this scaffolder)");
ok(
  lockstepNames.every((name) => name.startsWith("@open-everywhere/")),
  "🔴 every lockstep package is inside the scope, the scaffolder included (OPE-2234) — an unscoped package cannot belong to the npm org",
);
ok(publishable.every((m) => m.version === scaffolder.version), "every lockstep package carries the scaffolder's version — the premise the placeholder rests on");

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
const root = readJson<Manifest & { allowScripts?: Record<string, unknown> }>(join(PACKAGES, "..", "package.json"));
eq(tpl.overrides, root.overrides, "template package.json: the overrides equal the repository root's");
const undiciPin = (spec: unknown): number[] => String(spec).split(".").map(Number);
const eveUndici = undiciPin((tpl.overrides?.eve as Record<string, unknown> | undefined)?.undici);
const fetchUndici = undiciPin((tpl.overrides?.["guarded-fetch"] as Record<string, unknown> | undefined)?.undici);
ok(eveUndici[0] === 8 && (eveUndici[1]! > 10 || (eveUndici[1] === 10 && eveUndici[2]! >= 2)), "template package.json: eve's undici override is a patched 8.x (>= 8.10.2)");
ok(fetchUndici[0] === 7 && (fetchUndici[1]! > 29 || (fetchUndici[1] === 29 && fetchUndici[2]! >= 1)), "template package.json: guarded-fetch's undici override is a patched 7.x (>= 7.29.1)");
const allowScripts = (tpl as { allowScripts?: Record<string, unknown> }).allowScripts ?? {};
eq(allowScripts.esbuild, true, "template package.json: allowScripts allows esbuild (tsx needs its binary)");
eq(allowScripts["@mongodb-js/zstd"], true, "template package.json: allowScripts allows @mongodb-js/zstd (just-bash's zstd command)");
eq(allowScripts["left-pad"], undefined, "template package.json: allowScripts names nothing else it was not asked to (negative control)");
eq(tpl.name, NAME_PLACEHOLDER,"template package.json: the name is the placeholder the scaffold fills");
eq((tpl as { scripts?: Record<string, string> }).scripts?.postinstall, "oe-eve-patch", "template package.json: postinstall applies the eve patch");
for (const hook of ["prebuild", "predev", "prestart", "pretypecheck"]) {
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
for (const ext of [".ts", ".mts", ".js", ".mjs"]) {
  const removed = `agent/instrumentation${ext}`;
  ok(!templateFiles.includes(removed), `template ${removed}: absent — eve 0.69.0 and later refuse it in \`eve build\``);
}
for (const rel of ["agent/instrumentation/otel.ts", "agent/instrumentation/otlp.ts"]) {
  ok(templateFiles.includes(rel), `template ${rel}: present — a provider slot of eve's instrumentation directory`);
  if (templateFiles.includes(rel)) {
    eq(
      readFileSync(join(TEMPLATE, ...rel.split("/")), "utf8"),
      readFileSync(join(PACKAGES, "..", ...rel.split("/")), "utf8"),
      `template ${rel}: byte-identical to the reference app's`,
    );
  }
}
const REFERENCE_APP = join(PACKAGES, "..");
for (const rel of templateFiles.filter((f) => f.endsWith(".generated.ts") && !f.startsWith("agent/plugins/"))) {
  eq(
    readFileSync(join(TEMPLATE, ...rel.split("/")), "utf8"),
    readFileSync(join(REFERENCE_APP, ...rel.split("/")), "utf8"),
    `template ${rel}: byte-identical to the reference app's canonical overlay`,
  );
}
const INSTRUCTIONS_ALLOWANCE: readonly { readonly reference: string; readonly template: string; readonly why: string }[] = [];
{
  const rel = "agent/instructions.md";
  let expected = readFileSync(join(REFERENCE_APP, ...rel.split("/")), "utf8");
  for (const a of INSTRUCTIONS_ALLOWANCE) {
    ok(expected.includes(a.reference), `template ${rel}: allowance "${a.why}" still matches the reference prompt`);
    expected = expected.replace(a.reference, a.template);
  }
  const actual = readFileSync(join(TEMPLATE, ...rel.split("/")), "utf8");
  const firstDiff = actual.split("\n").findIndex((line, i) => line !== expected.split("\n")[i]);
  ok(actual === expected, `template ${rel}: equal to the reference app's prompt, after the declared allowance (first different line: ${firstDiff + 1})`);
}
{
  type StacksModule = { STACKS: Record<string, unknown> };
  type PricingModule = { loadModelPricing: () => unknown };
  const importFrom = async <T>(base: string, rel: string): Promise<T> => (await import(pathToFileURL(join(base, ...rel.split("/"))).href)) as T;
  const stacksRel = "agent/model/stacks.ts";
  const pricingRel = "agent/spend/model-pricing.ts";
  eq(
    (await importFrom<StacksModule>(TEMPLATE, stacksRel)).STACKS,
    (await importFrom<StacksModule>(REFERENCE_APP, stacksRel)).STACKS,
    `template ${stacksRel}: STACKS equal the reference app's (every stack, role, id, tier and window)`,
  );
  eq(
    (await importFrom<PricingModule>(TEMPLATE, pricingRel)).loadModelPricing(),
    (await importFrom<PricingModule>(REFERENCE_APP, pricingRel)).loadModelPricing(),
    `template ${pricingRel}: the rate table equals the reference app's`,
  );
}

{
  type RulesModule = { PRE_APPROVAL_RULES: readonly { id: string; rule: string }[] };
  const rulesRel = "agent/access/pre-approval-rules.ts";
  ok(templateFiles.includes(rulesRel), `template ${rulesRel}: present — the starter pre-approval rules`);
  const load = async (base: string): Promise<RulesModule> => (await import(pathToFileURL(join(base, ...rulesRel.split("/"))).href)) as RulesModule;
  const rules = (await load(TEMPLATE)).PRE_APPROVAL_RULES;
  ok(rules.length >= 4, `template ${rulesRel}: ships at least four starter rules`);
  const ids = rules.map((r) => r.id);
  eq(new Set(ids).size, ids.length, `template ${rulesRel}: every starter rule id is unique`);
  for (const want of ["pr-asked-for-here", "routine-reports-here", "access-request-asked-for", "connector-write-asked-for-here", "connector-delete-asked-for-here"]) {
    ok(ids.includes(want), `template ${rulesRel}: ships the "${want}" rule`);
  }
  ok(rules.every((r) => r.rule.trim().length > 0), `template ${rulesRel}: every starter rule has prose`);
  eq(rules, (await load(REFERENCE_APP)).PRE_APPROVAL_RULES, `template ${rulesRel}: the starter rules equal the reference app's`);

  const bundlesRel = "agent/access/bundles.ts";
  const bundlesSrc = readFileSync(join(TEMPLATE, ...bundlesRel.split("/")), "utf8");
  ok(/^import \{ PRE_APPROVAL_RULES \} from "\.\/pre-approval-rules\.js";$/m.test(bundlesSrc), `template ${bundlesRel}: imports the starter rules`);
  ok(/preApprovalRules: PRE_APPROVAL_RULES,/.test(bundlesSrc), `template ${bundlesRel}: a bundle carries them`);
  ok(/^\s*defineBinding\(\{ bundle: "approval-policy", scope: \{ level: "org" \} \}\),$/m.test(bundlesSrc), `template ${bundlesRel}: the rules bundle is bound at org scope`);
  const settingsSrc = readFileSync(join(TEMPLATE, "agent", "settings", "settings.ts"), "utf8");
  ok(!/judgeMode\s*:/.test(settingsSrc.replace(/^\s*\/\/.*$/gm, "")), "template agent/settings/settings.ts: sets no judgeMode, so a fresh app runs the shipped enforce");
}

{
  const settingsMod = (await import(pathToFileURL(join(TEMPLATE, "agent", "settings", "settings.ts")).href)) as {
    SETTINGS_OVERRIDES?: { browser?: { enabled?: unknown } };
  };
  eq(settingsMod.SETTINGS_OVERRIDES?.browser?.enabled, true, "template agent/settings/settings.ts: arms the browser (`browser.enabled: true`)");
  const { browserHostDeclarations } = await import("@open-everywhere/core/agent/access/browser-hosts.js");
  await import(pathToFileURL(join(TEMPLATE, "agent", "access", "browser-hosts.ts")).href);
  const hosts = browserHostDeclarations().map((h) => h.host);
  ok(hosts.includes("localhost"), `template agent/access/browser-hosts.ts: declares a localhost row (got ${JSON.stringify(hosts)})`);
}

{
  const templateScripts = new Set(Object.keys((tpl as { scripts?: Record<string, string> }).scripts ?? {}));
  const aboutTheRepository = (line: string): boolean => /Open Everywhere repository|clone of the repository/.test(line);
  const exemptFile = (rel: string): boolean => rel.startsWith("claude/skills/");
  const offenders: string[] = [];
  for (const rel of templateFiles) {
    if (exemptFile(rel) || !/\.(ts|md|json)$/.test(rel)) continue;
    const lines = readFileSync(join(TEMPLATE, ...rel.split("/")), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (aboutTheRepository(line)) return;
      for (const m of line.matchAll(/npm run (?:-s )?([a-z][\w:-]*)/g)) {
        if (!templateScripts.has(m[1]!)) offenders.push(`${rel}:${i + 1} names \`npm run ${m[1]}\`, which the template's package.json does not define`);
      }
      for (const m of line.matchAll(/\bpackages\/(?:core|adapters|providers|create)\/[\w./-]+/g)) {
        offenders.push(`${rel}:${i + 1} names the repository path ${m[0]} (use the package specifier, e.g. @open-everywhere/core/…)`);
      }
      for (const m of line.matchAll(/(?<![\w@/.-])scripts\/[\w.-]+\.(?:ts|mjs|js)\b/g)) {
        if (!templateFiles.includes(m[0])) offenders.push(`${rel}:${i + 1} names ${m[0]}, which the template does not ship`);
      }
    });
  }
  eq(offenders, [], "template: every npm script, repository path and script file it names exists in a scaffolded app");
}

ok(!templateFiles.includes(".gitignore"), "template: no `.gitignore` (npm never packs one) — it ships as `gitignore`");
ok(templateFiles.includes("gitignore"), "template: carries `gitignore` for the scaffold to rename");
ok(
  !templateFiles.some((f) => /(^|\/)\.claude\//.test(f)),
  "template: no path under `.claude/` (the publish preview's harness-tree rule refuses one in any tarball)",
);
ok(templateFiles.includes("claude/skills/quickstart-open-everywhere/SKILL.md"), "template: carries the setup skill under `claude/` for the scaffold to rename");
ok(templateFiles.includes("claude/skills/upgrade-open-everywhere/SKILL.md"), "template: carries the upgrade skill too — the app's second standing procedure (OPE-2232)");
ok(!templateFiles.some((f) => f === ".env" || f === ".env.local"), "template: carries no env file with values");

{
  const rel = "agent/lib/register-adapters.ts";
  const wiring = readFileSync(join(TEMPLATE, ...rel.split("/")), "utf8");
  ok(
    /^import \{ registerDefaultAdapters \} from "@open-everywhere\/adapters\/agent\/register-defaults\.js";$/m.test(wiring),
    `template ${rel}: imports registerDefaultAdapters from the adapters package`,
  );
  ok(/^await registerDefaultAdapters\(\{$/m.test(wiring), `template ${rel}: awaits registerDefaultAdapters at module top level`);
  const code = wiring
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  for (const owned of [
    "resolveOperationalSelection",
    "resolveMemoryProviderId",
    "registerNeon",
    "registerOperationalPgliteLazy",
    "declareProviderSelection",
    "OE_MEMORY_PROVIDER",
    "OE_OPERATIONAL_PROVIDER",
    "DATABASE_URL",
    ".register()",
  ]) {
    ok(!code.includes(owned), `template ${rel}: carries no ${owned} — the product's registerDefaultAdapters owns it`);
  }
  eq(wiring, readFileSync(join(REFERENCE_APP, ...rel.split("/")), "utf8"), `template ${rel}: byte-identical to the reference app's`);

  const productRel = "adapters/agent/register-defaults.ts";
  const product = readFileSync(join(PACKAGES, ...productRel.split("/")), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l))
    .join("\n");
  for (const fn of ["resolveOperationalSelection", "resolveMemoryProviderId"]) {
    ok(product.includes(`${fn}(env)`), `${productRel}: asks core's ${fn} instead of re-testing the env`);
  }
  ok(/operational\.floor === "pglite"/.test(product), `${productRel}: the PGlite floor is armed from the resolved floor, not from an absent selector`);
  for (const selector of ["OE_MEMORY_PROVIDER", "OE_OPERATIONAL_PROVIDER"]) {
    ok(!new RegExp(`\\b${selector}\\b\\s*===`).test(product), `${productRel}: does NOT gate on ${selector} === … (OPE-2230: DATABASE_URL selects both stores)`);
    ok(!new RegExp(`!\\s*(process\\.)?env\\.${selector}\\b`).test(product), `${productRel}: does NOT arm the floor on an absent ${selector} either`);
  }
}

{
  const docsRel = "agent/lib/register-docs.ts";
  const docsWiring = readFileSync(join(TEMPLATE, ...docsRel.split("/")), "utf8");
  ok(
    /import\s*\{\s*UNIVERSAL_DOCS\s*\}\s*from\s*"@open-everywhere\/core\/agent\/docs\/generated\/index\.js"/.test(docsWiring),
    `template ${docsRel}: imports UNIVERSAL_DOCS from core's shipped subpath`,
  );
  ok(/^registerDocs\(UNIVERSAL_DOCS\);$/m.test(docsWiring), `template ${docsRel}: registers UNIVERSAL_DOCS at import`);
  const configRel = "agent/lib/register-config.ts";
  const configWiring = readFileSync(join(TEMPLATE, ...configRel.split("/")), "utf8");
  ok(/^import "\.\/register-docs\.js";$/m.test(configWiring), `template ${configRel}: imports ./register-docs.js for its side effect`);
  ok(
    !templateFiles.some((f) => /(^|\/)docs\/generated\//.test(f) || f.endsWith("docs-generated.ts")),
    "template: carries no copy of the generated manual (it would freeze at scaffold time)",
  );
}

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
  ok(existsSync(join(target, ".claude", "skills", "upgrade-open-everywhere", "SKILL.md")), "scaffold: the upgrade skill lands beside it");
  ok(!existsSync(join(target, "claude")), "scaffold: no stray `claude/` is left in the app (negative control)");

  const app = readJson<Manifest>(join(target, "package.json"));
  eq(app.name, "my-agent", "scaffold: the package name derives from the directory name");
  const appDeps = { ...app.dependencies, ...app.devDependencies };
  eq(
    lockstepNames.map((name) => appDeps[name]),
    lockstepNames.map(() => version),
    "scaffold: every lockstep package is pinned to the scaffolder version",
  );
  for (const rel of result.files) {
    const text = readFileSync(join(target, ...rel.split("/")), "utf8");
    ok(!text.includes(VERSION_PLACEHOLDER) && !text.includes(NAME_PLACEHOLDER), `scaffold ${rel}: no placeholder survives`);
  }
  const appLock = readJson<{ packages: Record<string, { version: string }> }>(join(target, "roster.lock.json"));
  ok(Object.values(appLock.packages).every((p) => p.version === version), "scaffold: roster.lock.json records the scaffolder version");
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

  const clone = join(scratch, "fresh-clone");
  mkdirSync(join(clone, ".git"), { recursive: true });
  writeFileSync(join(clone, ".git", "HEAD"), "ref: refs/heads/main\n");
  const cloned = scaffoldApp({ targetDir: clone, version });
  eq(cloned.files, result.files, "scaffold: a directory that holds only `.git` is accepted, and gets every template file");
  ok(!cloned.files.some((f) => f === ".git" || f.startsWith(".git/")), "scaffold: writes nothing under `.git/`");
  eq(readFileSync(join(clone, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n", "scaffold: the clone's `.git` is left untouched");
  ok(existsSync(join(clone, ".gitignore")), "scaffold: the clone gets its `.gitignore` next to `.git`");
  const cloneBusy = join(scratch, "clone-busy");
  mkdirSync(join(cloneBusy, ".git"), { recursive: true });
  writeFileSync(join(cloneBusy, "README.md"), "mine\n");
  refuses("scaffold: refuses a directory that holds `.git` and anything else", () => scaffoldApp({ targetDir: cloneBusy, version }), /not empty/);
  eq(readdirSync(cloneBusy).sort(), [".git", "README.md"], "scaffold: a refused clone is left untouched");
  eq(isScaffoldableDir(cloneBusy), false, "isScaffoldableDir: `.git` plus a file is not empty (negative control)");
  eq(isScaffoldableDir(clone), false, "isScaffoldableDir: a scaffolded clone is no longer empty");

  const vercelAppends = (gitignore: string, line: string, osEol: string): boolean => {
    const split = gitignore.includes("\r\n") ? "\r\n" : osEol;
    return !gitignore.split(split).includes(line);
  };
  for (const platformEol of ["\n", "\r\n"]) {
    const label = platformEol === "\n" ? "LF platform" : "CRLF platform (Windows)";
    const app = join(scratch, `eol-${platformEol.length}`);
    scaffoldApp({ targetDir: app, version, eol: platformEol });
    const gitignore = readFileSync(join(app, ".gitignore"), "utf8");
    for (const line of VERCEL_GITIGNORE_LINES) {
      ok(!vercelAppends(gitignore, line, platformEol), `scaffold (${label}): the Vercel CLI finds "${line}" and appends nothing`);
    }
    ok(gitignore.split(platformEol).includes("!.env.example"), `scaffold (${label}): .env.example stays tracked after the .env* line`);
  }
  const lfTemplate = readFileSync(join(TEMPLATE, "gitignore"), "utf8");
  ok(!lfTemplate.includes("\r\n") && vercelAppends(lfTemplate, ".vercel", "\r\n"), "negative control: an LF-only file on Windows makes the Vercel CLI append .vercel (the bug)");
  ok(vercelAppends(withGitignoreEol(".env\n.env.*\n", "\n"), ".env*", "\n"), "negative control: `.env` + `.env.*` do not stop the CLI appending `.env*`");
  ok(withGitignoreEol("a\r\nb\nc", "\r\n") === "a\r\nb\r\nc", "withGitignoreEol: every line ending becomes the one asked for");

  eq(packageNameFor("/x/.Hidden_App"), "hidden_app", "packageNameFor: strips a leading dot and lowercases");
  eq(packageNameFor("/x/---"), "open-everywhere-app", "packageNameFor: falls back when nothing usable is left");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

{
  const { initGitRepo } = await import("../src/scaffold.js");
  const calls: string[][] = [];
  const fake = (answers: Record<string, number | null | "spawn-fails">) => (args: readonly string[]) => {
    calls.push([...args]);
    const a = answers[args[0]!];
    return a === "spawn-fails" ? undefined : { status: a ?? 0 };
  };

  calls.length = 0;
  const absent = initGitRepo("/nowhere", fake({ "--version": "spawn-fails" }));
  ok(!absent.initialized && /not on PATH/.test(absent.detail), "git init: git absent → skipped, and says so");
  ok(!calls.some((c) => c[0] === "init"), "git init: …and never runs `git init`");

  calls.length = 0;
  const nested = initGitRepo("/nowhere", fake({ "--version": 0, "rev-parse": 0 }));
  ok(!nested.initialized && /already inside a git work tree/.test(nested.detail), "git init: inside a work tree → skipped, and says so");
  ok(!calls.some((c) => c[0] === "init"), "git init: …and never runs `git init` (no nested repository)");

  calls.length = 0;
  const fresh = initGitRepo("/nowhere", fake({ "--version": 0, "rev-parse": 128, init: 0 }));
  ok(fresh.initialized, "git init: outside any work tree → initialised");
  ok(calls.some((c) => c[0] === "init") && !calls.some((c) => c[0] === "commit"), "git init: …runs `git init` and never commits");

  const real = mkdtempSync(join(tmpdir(), "oe-scaffold-git-"));
  try {
    const r = initGitRepo(real);
    if (r.initialized) ok(existsSync(join(real, ".git")), "git init (real git): the app directory now holds .git");
    else ok(/not on PATH|already inside/.test(r.detail), `git init (real git): skipped for a stated reason (${r.detail})`);
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
}

{
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const oeCli = join(repoRoot, "packages", "core", "scripts", "oe-cli.ts");
  const version = (JSON.parse(readFileSync(join(repoRoot, "packages", "core", "package.json"), "utf8")) as { version: string }).version;
  ok(templateFiles.includes("scripts/goldens/roster-plan.txt"), "template: ships scripts/goldens/roster-plan.txt, the roster review surface");
  const parent = mkdtempSync(join(tmpdir(), "oe-scaffold-golden-"));
  const link = join(parent, "app", "node_modules");
  try {
    const app = scaffoldApp({ targetDir: join(parent, "app"), version }).dir;
    symlinkSync(join(repoRoot, "node_modules"), link, process.platform === "win32" ? "junction" : "dir");
    const git = (...args: string[]) => spawnSync("git", args, { cwd: app, encoding: "utf8" });
    if (git("--version").status !== 0) {
      console.log("  · git is not on PATH: the clean-status half of the golden check is skipped");
    } else {
      git("init", "-q");
      git("add", "-A");
      const commit = git("-c", "user.name=oe-test", "-c", "user.email=oe-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "scaffold");
      ok(commit.status === 0, `golden: the scaffold commits (${commit.stderr.trim()})`);
      const build = spawnSync(process.execPath, [tsxCli, oeCli, "build", "--accept"], { cwd: app, encoding: "utf8", timeout: 120_000 });
      ok(build.status === 0, `golden: \`oe build --accept\` succeeds on a fresh scaffold (${(build.stdout + build.stderr).trim().split("\n").slice(-5).join(" | ")})`);
      const status = git("status", "--porcelain").stdout.trim();
      ok(
        status === "",
        `golden: \`oe build --accept\` on a fresh scaffold leaves a clean git status (got: ${status || "clean"}). ` +
          "Fix: scaffold the template, run `oe build --accept` in it, then copy its roster.lock.json (versions back to " +
          `${VERSION_PLACEHOLDER}) and scripts/goldens/roster-plan.txt into packages/create/template/, and review both diffs`,
      );
      const check = spawnSync(process.execPath, [tsxCli, oeCli, "build", "--check"], { cwd: app, encoding: "utf8", timeout: 120_000 });
      ok(check.status === 0, "golden: `oe build --check` passes on the built scaffold, golden included");
    }
  } finally {
    try {
      unlinkSync(link);
    } catch {
    }
    rmSync(parent, { recursive: true, force: true });
  }
}

console.log(`✓ ${n} scaffold assertions passed`);

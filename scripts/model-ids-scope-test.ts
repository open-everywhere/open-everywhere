import { execFileSync } from "node:child_process";
import { npxCommand } from "./npm-command.js";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRICE_TABLE, REGISTRY, ruleOneFiles, scanBareModelIds } from "./model-ids-scope.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const realFiles = ruleOneFiles(REPO_ROOT);
ok(realFiles.length > 0, "ruleOneFiles() returns a non-empty set for this repo (otherwise every assertion below is vacuous)");
ok(realFiles.includes("agent/model/models.ts"), "the set holds agent/model/models.ts — an authored app file RULE 1 must read");
ok(!realFiles.includes(REGISTRY), `the set excludes the registry ${REGISTRY}`);
ok(!realFiles.includes(PRICE_TABLE), `the set excludes the deployer price table ${PRICE_TABLE}`);

function isIgnored(rel: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", rel], { cwd: REPO_ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const ignoredInSet = realFiles.filter(isIgnored);
ok(
  ignoredInSet.length === 0,
  `no file RULE 1 reads is git-ignored — found ${ignoredInSet.length}: ${ignoredInSet.slice(0, 5).join(", ")}`,
);

function walkTsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(REPO_ROOT, rel)).isDirectory()) {
      if (entry === "generated" || entry === "node_modules") continue;
      out.push(...walkTsFilesUnder(rel));
    } else if (entry.endsWith(".ts")) out.push(rel);
  }
  return out;
}

const walked = new Set(walkTsFilesUnder("agent"));
const inSet = new Set(realFiles);
const walkedNotRead = [...walked].filter((f) => !inSet.has(f) && f !== REGISTRY && f !== PRICE_TABLE);
const unexplained = walkedNotRead.filter((f) => !isIgnored(f));
ok(
  unexplained.length === 0,
  `every .ts the filesystem walk finds but RULE 1 skips is git-ignored build output — unexplained: ${unexplained.join(", ")}`,
);
const trackedGenerated = execFileSync("git", ["ls-files", "--", "agent/docs/generated/*.ts"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).split("\n").filter((l) => l.length > 0);
ok(
  trackedGenerated.length === 0,
  `OPE-2215: this repo tracks no agent/docs/generated/*.ts (the manual moved into core) — found: ${trackedGenerated.join(", ")}`,
);

const trackedPluginGenerated = execFileSync("git", ["ls-files", "--", "agent/plugins/generated/*.ts"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).split("\n").filter((l) => l.length > 0);
ok(
  trackedPluginGenerated.length > 0,
  "this repo tracks agent/plugins/generated/*.ts (without them the next assertion could not fail)",
);
for (const file of trackedPluginGenerated) {
  ok(
    realFiles.includes(file),
    `OPE-1202: RULE 1 READS ${file} — extracted plugin code is not doc prose, and a registry entry that pinned a model id is exactly the config copy this rule catches`,
  );
}

const fixture = mkdtempSync(join(tmpdir(), "oe-model-ids-scope-"));
function write(rel: string, body: string): void {
  mkdirSync(join(fixture, dirname(rel)), { recursive: true });
  writeFileSync(join(fixture, rel), body, "utf8");
}
function git(...args: string[]): void {
  execFileSync("git", args, { cwd: fixture, stdio: "ignore" });
}

function refuses(label: string): void {
  let threw = false;
  try {
    ruleOneFiles(fixture);
  } catch {
    threw = true;
  }
  ok(threw, label);
}

git("init", "-q");
refuses("ruleOneFiles() THROWS on a repo with no tracked agent/ file, rather than reporting a set it never read");

write(REGISTRY, 'export const STACKS = { a: { primary: { id: "openai/gpt-5.6-luna" } } };\n');
write(PRICE_TABLE, 'export const RATES = { "openai/gpt-5.6-luna": { inPerMtok: 1 } };\n');
write("agent/docs/generated/deploy.ts", 'export const DOC = "the shipped stack runs openai/gpt-5.6-luna";\n');
write(".gitignore", "/agent/channels/\n/agent/hooks/\n/agent/lib/providers.generated.ts\n");
git("add", "-A");
refuses("ruleOneFiles() THROWS when git lists only exempt and docs-generated files — a filtered-empty set is still an unread tree");

write("agent/model/models.ts", 'export const PRIMARY_MODEL = "x";\n');
git("add", "--", "agent/model/models.ts");

const clean = ruleOneFiles(fixture);
ok(
  clean.join("|") === "agent/model/models.ts",
  `on a clean fixture RULE 1 reads exactly the authored app file — got: ${clean.join(", ")}`,
);
ok(
  scanBareModelIds(clean, fixture).length === 0,
  "the clean fixture has no bare model id (the registry, the price table and generated doc prose are all exempt)",
);

for (const rel of ["agent/channels/slack.ts", "agent/hooks/spend.ts", "agent/lib/providers.generated.ts"]) {
  write(rel, 'export const M = "deepseek/deepseek-v4-flash-0731";\n');
}
write("agent/scratch.ts", 'export const M = "anthropic/claude-sonnet-5";\n');

const built = ruleOneFiles(fixture);
ok(
  built.join("|") === clean.join("|"),
  `the file set is IDENTICAL before and after a build — clean: [${clean.join(", ")}] built: [${built.join(", ")}]`,
);
ok(
  scanBareModelIds(built, fixture).length === 0,
  "no generated file contributes a hit, so the gate's verdict does not move with build state",
);

write("agent/model/models.ts", ["export const A = 1;", 'export const M = "deepseek/deepseek-v4-flash-0731";', ""].join("\n"));
git("add", "--", "agent/model/models.ts");
const withRed = ruleOneFiles(fixture);
ok(withRed.join("|") === clean.join("|"), "adding the literal did not change the file set — only the hits");
const hits = scanBareModelIds(withRed, fixture);
ok(hits.length === 1, `a bare model id in a TRACKED file is found — expected 1 hit, got ${hits.length}`);
ok(hits[0]?.file === "agent/model/models.ts", `the hit names the tracked file — got ${hits[0]?.file}`);
ok(hits[0]?.id === "deepseek/deepseek-v4-flash-0731", `the hit reports the literal — got ${hits[0]?.id}`);
ok(hits[0]?.line === 2, `the hit reports the line — expected 2, got ${hits[0]?.line}`);

write("agent/model/models.ts", ["// runs deepseek/deepseek-v4-flash-0731 today", "export const A = 1;", ""].join("\n"));
git("add", "--", "agent/model/models.ts");
ok(
  scanBareModelIds(ruleOneFiles(fixture), fixture).length === 0,
  "a model id in a comment is NOT a hit (negative control — otherwise the assertion above could pass on any content)",
);

write("agent/model/models.ts", ["export const A = 1;", 'export const M = "deepseek/deepseek-v4-flash-0731";', ""].join("\n"));
git("add", "--", "agent/model/models.ts");
rmSync(join(fixture, "agent/model/models.ts"));
const absent = ruleOneFiles(fixture);
ok(
  absent.includes("agent/model/models.ts"),
  "a tracked file missing from the worktree STAYS in RULE 1's set — dropping it is how a sparse checkout goes green",
);
const absentHits = scanBareModelIds(absent, fixture);
ok(
  absentHits.length === 1 && absentHits[0]?.id === "deepseek/deepseek-v4-flash-0731",
  `the literal is still found, read from the index — got ${absentHits.length} hit(s)`,
);
write("agent/model/models.ts", "export const A = 1;\n");
ok(
  scanBareModelIds(ruleOneFiles(fixture), fixture).length === 0,
  "an uncommitted edit that removes the literal clears the hit — the worktree wins over the index when it exists",
);

{
  write("agent/plugins/generated/index.ts", 'export const GENERATED_PLUGIN_REGISTRY = { p: { model: "deepseek/deepseek-v4-flash-0731" } };\n');
  git("add", "--", "agent/plugins/generated/index.ts");
  const withPlugin = ruleOneFiles(fixture);
  ok(
    withPlugin.includes("agent/plugins/generated/index.ts"),
    `RULE 1's set includes the extracted-plugin file — got: ${withPlugin.join(", ")}`,
  );
  const hits = scanBareModelIds(withPlugin, fixture);
  ok(
    hits.some((h) => h.file === "agent/plugins/generated/index.ts" && h.id === "deepseek/deepseek-v4-flash-0731"),
    `the pinned model id in the extracted-plugin registry entry is REPORTED — got: ${JSON.stringify(hits)}`,
  );

  write("agent/plugins/generated/note.ts", '// the shipped stack runs openai/gpt-5.6-luna\nexport const N = 1;\n');
  git("add", "--", "agent/plugins/generated/note.ts");
  const withNote = scanBareModelIds(ruleOneFiles(fixture), fixture);
  ok(
    !withNote.some((h) => h.file === "agent/plugins/generated/note.ts"),
    `a model id in a COMMENT under agent/plugins/generated/ is still not a hit — got: ${JSON.stringify(withNote)}`,
  );
}

console.log(
  `✓ model-ids scope: ${passed} assertions passed — RULE 1 reads ${realFiles.length} git-tracked file(s), ` +
    `the same set before and after a build, and still reds on a bare literal in a tracked file`,
);

let lintOut = "";
let lintFailed: string | undefined;
try {
  lintOut = execFileSync(...npxCommand(["tsx", "scripts/model-ids-lint.ts"]), {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (err) {
  lintFailed = err instanceof Error ? err.message : String(err);
}
ok(lintFailed === undefined, `lint:model-ids exits 0 on this tree (this suite cannot join to a gate that is red) — ${lintFailed}`);
const reported = lintOut.match(/model-ids: (\d+) git-tracked app file\(s\)/)?.[1];
ok(
  reported === String(realFiles.length),
  `lint:model-ids reports the same count this module computes — lint said ${reported ?? "nothing"}, module says ${realFiles.length}`,
);

rmSync(fixture, { recursive: true, force: true });


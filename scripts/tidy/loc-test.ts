import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOC = join(HERE, "loc.mjs");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function eq(actual: unknown, expected: unknown, label: string): void {
  ok(actual === expected, `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

interface Row {
  area: string;
  files: number;
  code: number;
  comment: number;
  blank: number;
  ratio: number;
}
interface Report {
  areas: Row[];
  total: Row;
  commentHeaviest: { file: string; comment: number; code: number; ratio: number }[];
}

function run(args: string[]): string {
  return execFileSync(process.execPath, [LOC, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

const root = mkdtempSync(join(tmpdir(), "oe-tidy-loc-"));
const write = (rel: string, body: string): void => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
};

try {
  const counted = [
    "// a line comment",
    "",
    "/* one-liner */",
    "/**",
    " * starred continuation",
    "   a continuation with no star",
    " */",
    'const u = "//not a comment";',
    "run(); // trailing",
    "  ",
    "export const x = 1;",
  ].join("\n");

  write("packages/core/agent/counted.ts", counted);
  write("packages/providers/slack/a.ts", "export const a = 1;\n");
  write("agent/lib/b.ts", "// only a comment\n");
  write("scripts/c.mjs", "export const c = 1;\n");
  write("index.ts", "export const root = 1;\n");
  write("node_modules/pkg/skip.ts", "// ".repeat(50) + "\n");
  write("packages/core/dist/skip.js", "// ".repeat(50) + "\n");

  const report = JSON.parse(run(["--json", "--root", root])) as Report;
  const areaOf = (name: string): Row | undefined => report.areas.find((a) => a.area === name);

  eq(
    report.areas
      .map((a) => a.area)
      .sort()
      .join(","),
    "agent/lib,packages/core,packages/providers/slack,root,scripts",
    "areas are the five expected units",
  );
  ok(!areaOf("packages/providers"), "the providers container is never an area of its own");
  ok(!areaOf("node_modules") && !areaOf("dist"), "node_modules and dist contribute no area");

  const core = areaOf("packages/core");
  ok(core !== undefined, "packages/core has a row");
  eq(core!.files, 1, "packages/core counted exactly the one source file (dist/ was skipped)");
  eq(core!.comment, 6, "packages/core comment lines");
  eq(core!.code, 3, "packages/core code lines");
  eq(core!.blank, 2, "packages/core blank lines");
  eq(core!.comment + core!.code + core!.blank, counted.split("\n").length, "every line of the file is classified exactly once");
  eq(core!.ratio, 2, "packages/core ratio is comment/code");

  const slack = areaOf("packages/providers/slack");
  eq(slack!.comment, 0, "a file of pure code has no comment line — a string holding // is code");
  eq(slack!.ratio, 0, "…so its ratio is 0");
  const lib = areaOf("agent/lib");
  eq(lib!.comment, 1, "a file of one comment line counts one comment line");
  eq(lib!.code, 0, "…and no code line");
  eq(lib!.ratio, 0, "…so its ratio is 0 rather than a division by zero — the control for code === 0");

  for (const field of ["files", "code", "comment", "blank"] as const) {
    const sum = report.areas.reduce((acc, a) => acc + a[field], 0);
    eq(report.total[field], sum, `TOTAL ${field} equals the sum of the area rows`);
  }
  eq(report.total.area, "TOTAL", "the total row is labelled TOTAL");

  for (let i = 0; i < 30; i++) write(`tests/f${i}.ts`, `${"// x\n".repeat(i + 1)}export const v = ${i};\n`);
  const big = JSON.parse(run(["--json", "--root", root])) as Report;
  eq(big.commentHeaviest.length, 25, "the report names exactly 25 files");
  const comments = big.commentHeaviest.map((f) => f.comment);
  ok(
    comments.every((v, i) => i === 0 || comments[i - 1] >= v),
    "…in descending comment-line order",
  );
  eq(comments[0], 30, "…and the heaviest file is the one with the most comment lines");

  const repo = mkdtempSync(join(tmpdir(), "oe-tidy-loc-git-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "loc@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Loc Fixture"], { cwd: repo });
    writeFileSync(join(repo, ".gitignore"), "generated/\n");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    mkdirSync(join(repo, "generated"), { recursive: true });
    writeFileSync(join(repo, "scripts", "kept.ts"), "// one comment\nexport const kept = 1;\n");
    writeFileSync(join(repo, "generated", "bundle.js"), `${"// generated noise\n".repeat(500)}export const g = 1;\n`);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repo });

    const tracked = JSON.parse(run(["--json", "--root", repo])) as Report;
    eq(tracked.total.files, 1, "the checkout counts the one tracked source file");
    eq(tracked.total.comment, 1, "…and none of the 500 generated comment lines");
    ok(
      !tracked.areas.some((a) => a.area === "generated"),
      "…so the ignored directory is not an area at all",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  const table = run(["--root", root]);
  ok(/^TOTAL\s+\d+/mu.test(table), "the table prints a TOTAL row");
  ok(table.includes("Top 25 files by comment lines:"), "the table prints the comment-heavy list");
  ok(/^area\s+files\s+code\s+comment\s+blank\s+ratio$/mu.test(table), "the table prints the header row");
  ok(table.includes("packages/providers/slack"), "the table prints a per-area row");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`✓ tidy-loc: ${passed} assertions passed`);

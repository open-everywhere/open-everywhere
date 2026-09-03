import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMENTS = join(HERE, "comments.mjs");

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

interface Record_ {
  id: string;
  file: string;
  start: number;
  end: number;
  kind: "line" | "block" | "jsdoc";
  text: string;
  next_code: string;
  class: "auto-history" | "candidate";
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function tidy(cwd: string, args: string[]): Run {
  const r = spawnSync(process.execPath, [COMMENTS, ...args], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function scratchRepo(): string {
  const parent = mkdtempSync(join(tmpdir(), "oe-tidy-comments-"));
  parents.push(parent);
  const dir = join(parent, "repo");
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "tidy@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Tidy Fixture"], { cwd: dir });
  return dir;
}

const write = (root: string, rel: string, body: string): void => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
};
const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");
const commitAll = (root: string, message: string): void => {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: root });
};

function inventory(root: string, paths: string[]): Record_[] {
  const out = join(root, "inv.jsonl");
  const r = tidy(root, ["inventory", ...paths, "--out", out]);
  ok(r.status === 0, `inventory exited 0 — ${r.stderr}`);
  const body = readFileSync(out, "utf8").trim();
  return body === "" ? [] : body.split("\n").map((l) => JSON.parse(l) as Record_);
}

const decisionsFile = (root: string, name: string, rows: object[]): string => {
  const abs = join(root, name);
  writeFileSync(abs, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return abs;
};

const parents: string[] = [];
const newRepo = (): string => scratchRepo();

try {
  {
    const root = newRepo();
    write(
      root,
      "src/a.ts",
      [
        "// eslint-disable-next-line no-console",
        "console.log(1);",
        "",
        "/** A jsdoc block that a caller needs. */",
        "export function f(): void {}",
        "",
        "// Rescinded on 2026-08-01, superseded by OPE-1200.",
        "// OPE-1201, PR #42",
        "export const history = 1;",
        "",
        "/* A plain block that explains a real constraint. */",
        "export const plain = 2;",
        "",
        "// A first run of line comments.",
        "export const one = 3;",
        "// A second run, separated by a line of code.",
        "export const two = 4;",
      ].join("\n"),
    );

    const records = inventory(root, ["src/a.ts"]);

    ok(
      records.every((r) => r.class !== ("directive" as unknown)),
      "no record is classed directive",
    );
    ok(
      records.every((r) => !r.text.includes("eslint-disable")),
      "🔴 the eslint-disable block is absent from the inventory entirely",
    );
    ok(
      records.every((r) => r.start !== 1),
      "…and nothing claims the directive's line range",
    );

    ok(
      records.every((r) => r.class === "auto-history" || r.class === "candidate"),
      "every class is auto-history or candidate",
    );
    const history = records.find((r) => r.text.includes("Rescinded"));
    eq(history?.class, "auto-history", "a block whose every line is a date, a history word or a ref is auto-history");
    const jsdoc = records.find((r) => r.kind === "jsdoc");
    eq(jsdoc?.class, "candidate", "a block with real prose is a candidate — the negative control for auto-history");

    eq(jsdoc?.text, "A jsdoc block that a caller needs.", "text is the prose, with the comment markers stripped");
    eq(jsdoc?.next_code, "export function f(): void {}", "next_code is the first non-blank non-comment line after the block");
    eq(records.find((r) => r.text.startsWith("A plain block"))?.kind, "block", "a /* … */ is kind block");
    eq(
      records.filter((r) => r.kind === "line").length,
      3,
      "three line-comment blocks: the history run and the two runs a line of code separates",
    );
    eq(new Set(records.map((r) => r.id)).size, records.length, "every id is unique");
    ok(
      records.every((r) => r.file === "src/a.ts" && r.end >= r.start),
      "every record names its file and a well-ordered line range",
    );

    write(root, ".claude/skills/x/scripts/y.mjs", "// A skill script comment.\nexport const y = 1;\n");
    write(root, "node_modules/pkg/z.js", "// An installed package comment.\nexport const z = 1;\n");
    const swept = inventory(root, ["."]);
    ok(swept.length > 0, "a whole-tree inventory finds the fixture blocks");
    ok(!swept.some((r) => r.file.startsWith(".claude/")), "🔴 .claude/** is never offered to a judge");
    ok(!swept.some((r) => r.file.includes("node_modules/")), "…nor is node_modules");

    const runs = records.filter((r) => r.kind === "line" && r.text.includes("run"));
    eq(runs.length, 2, "the two // runs a line of code separates are two blocks, not one");
  }

  {
    const root = newRepo();
    const source = [
      "// eslint-disable-next-line no-console",
      "console.log(1);",
      "",
      "",
      "",
      "// Delete me.",
      "export const a = 1;",
      "",
      "/** Replace me with something shorter. */",
      "export function f(): void {}",
      "",
      "// Keep me.",
      "export const b = 2;",
    ].join("\n");
    write(root, "src/b.ts", source);
    commitAll(root, "fixture");

    const records = inventory(root, ["src/b.ts"]);
    const byText = (needle: string): Record_ => {
      const r = records.find((x) => x.text.includes(needle));
      ok(r !== undefined, `fixture has a block containing ${JSON.stringify(needle)}`);
      return r!;
    };

    const file = decisionsFile(root, "d.jsonl", [
      { id: byText("Delete me").id, action: "delete" },
      { id: byText("Replace me").id, action: "replace", text: "The one fact worth keeping." },
      { id: byText("Keep me").id, action: "keep" },
    ]);

    const first = tidy(root, ["apply", file]);
    ok(first.status === 0, `apply exited 0 — ${first.stderr}`);
    const after = read(root, "src/b.ts");

    ok(!after.includes("// Delete me."), "delete removed the block");
    ok(!after.includes("Replace me with something shorter"), "replace removed the old text");
    ok(after.includes("/** The one fact worth keeping. */"), "🔴 replace on a jsdoc keeps the /** … */ style");
    ok(after.includes("// Keep me."), "keep left the block alone");

    ok(after.includes("// eslint-disable-next-line no-console"), "🔴 the directive block survives apply");

    ok(!/\n\n\n/u.test(after), "no run of two or more blank lines survives");
    ok(after.includes("console.log(1);"), "…and no code line was lost to the collapse");

    const secondStrict = tidy(root, ["apply", file]);
    ok(secondStrict.status !== 0, "🔴 a second run without --reapply refuses the ids it cannot place");
    eq(read(root, "src/b.ts"), after, "…and writes nothing");
    const second = tidy(root, ["apply", file, "--reapply"]);
    ok(second.status === 0, `a second apply with --reapply exited 0 — ${second.stderr}`);
    eq(read(root, "src/b.ts"), after, "🔴 apply is idempotent — a second run is byte-identical");

    const ghost = tidy(root, ["apply", decisionsFile(root, "ghost.jsonl", [{ id: "src/b.ts:1:00000000", action: "delete" }])]);
    ok(ghost.status !== 0, "🔴 a delete whose hash names no block fails the run");
    ok(ghost.stderr.includes("unknown id"), "…and says so");

    const bogus = decisionsFile(root, "bogus.jsonl", [{ id: "src/nope.ts:1:deadbeef", action: "delete" }]);
    const bad = tidy(root, ["apply", bogus]);
    ok(bad.status !== 0, "an unknown id fails the run");
    ok(bad.stderr.includes("unknown id"), "…and says so");

    const directiveLine = "// eslint-disable-next-line no-console";
    const directiveId = `src/b.ts:1:${createHash("sha1").update(directiveLine).digest("hex").slice(0, 8)}`;
    const refused = tidy(root, ["apply", decisionsFile(root, "dir.jsonl", [{ id: directiveId, action: "delete" }])]);
    ok(refused.status !== 0, "🔴 a decision naming a directive block is refused");
    ok(refused.stderr.includes("DIRECTIVE"), "…and names the reason");
    ok(read(root, "src/b.ts").includes(directiveLine), "…and the directive is still there");

    writeFileSync(join(root, "..", "sibling.ts"), "// A file beside the tree.\nexport const s = 1;\n");
    const escape = tidy(root, ["apply", decisionsFile(root, "escape.jsonl", [{ id: "../sibling.ts:1:deadbeef", action: "delete" }])]);
    ok(escape.status !== 0, "🔴 an id resolving outside the tree is refused");
    ok(escape.stderr.includes("resolves outside"), "…and says why, rather than reporting a missing file");

    writeFileSync(join(root, "malformed.jsonl"), `${JSON.stringify({ id: byText("Keep me").id, action: "erase" })}\n`);
    const malformed = tidy(root, ["apply", join(root, "malformed.jsonl")]);
    ok(malformed.status !== 0, "an unknown action fails the run");
  }

  {
    const root = newRepo();
    write(root, "src/c.ts", ["function g(): void {", "  // A long block", "  // over two lines.", "  return;", "}"].join("\n"));
    const records = inventory(root, ["src/c.ts"]);
    eq(records.length, 1, "one block in the fixture");
    const r = tidy(root, ["apply", decisionsFile(root, "d.jsonl", [{ id: records[0]!.id, action: "replace", text: "One line." }])]);
    ok(r.status === 0, `apply exited 0 — ${r.stderr}`);
    ok(read(root, "src/c.ts").includes("  // One line."), "replace on a // run keeps // at the original indent");
  }

  {
    const root = newRepo();
    const original = [
      "// eslint-disable-next-line no-console",
      "console.log(1);",
      "",
      "// The original comment.",
      "export const a: string = `line one",
      "// this line only LOOKS like a comment — it is template-literal text",
      "line three`;",
      "",
      "export function f(x: string): string {",
      "  return x;",
      "}",
    ].join("\n");
    write(root, "src/d.ts", original);
    write(root, "src/keep.json", "{}\n");
    commitAll(root, "base");

    const verify = (): Run => tidy(root, ["verify", "--base", "main"]);

    write(root, "src/d.ts", original.replace("// The original comment.", "/* A rewritten comment. */"));
    const green = verify();
    ok(green.status === 0, `a comment-only change passes — ${green.stderr}`);
    ok(green.stdout.includes("1 changed source file"), "…having looked at the one source file");

    write(root, "src/keep.json", "{\"deploy\": \"changed\"}\n");
    const nonSource = verify();
    ok(nonSource.status !== 0, "🔴 a changed .json fails verify rather than being skipped");
    ok(nonSource.stderr.includes("src/keep.json"), "…and the failure names it");
    write(root, "src/keep.json", "{}\n");

    write(root, "src/d.ts", original.replace("  return x;", "  return x.trim();"));
    const codeChange = verify();
    ok(codeChange.status !== 0, "🔴 a changed code line fails verify");
    ok(codeChange.stderr.includes("src/d.ts"), "…and the failure names the file");

    write(root, "src/d.ts", original.replace("f(x: string): string", "f(x: unknown): string"));
    ok(verify().status !== 0, "🔴 a changed type annotation fails verify");

    write(root, "src/d.ts", original.replace("  return x;", "      return x;"));
    const reindent = verify();
    ok(reindent.status !== 0, "🔴 re-indenting a code line fails verify");
    ok(reindent.stderr.includes("is a code line"), "…named as a changed code line, not as a moved token");

    write(root, "src/d.ts", original.split("\n").slice(1).join("\n"));
    const directive = verify();
    ok(directive.status !== 0, "🔴 deleting an eslint-disable fails verify");

    write(root, "src/d.ts", original.split("\n").filter((l) => !l.includes("only LOOKS like a comment")).join("\n"));
    const trap = verify();
    ok(trap.status !== 0, "🔴 deleting a template-literal line that looks like a comment fails verify");
    ok(trap.stderr.includes("token stream"), "…because the token stream moved, not because a line class did");

    write(root, "src/d.ts", original);
    const tricky = [
      "export const head = `a ${1} tail`;",
      "// A real comment, sitting after a template substitution.",
      "export const afterTemplate = 1;",
      "",
      "export const re = /[/*]/u;",
      "// A comment that mentions */ in passing.",
      "export const afterRegex = 2;",
    ].join("\n");
    write(root, "src/e.ts", tricky);
    commitAll(root, "tricky");

    write(root, "src/e.ts", tricky.split("\n").filter((l) => !l.includes("A real comment")).join("\n"));
    const afterTemplate = verify();
    ok(afterTemplate.status === 0, `deleting a comment that follows a template substitution passes — ${afterTemplate.stderr}`);

    write(root, "src/e.ts", tricky.split("\n").filter((l) => !l.includes("in passing")).join("\n"));
    const afterRegex = verify();
    ok(afterRegex.status === 0, `deleting a comment beside a regular-expression literal passes — ${afterRegex.stderr}`);
    write(root, "src/e.ts", tricky);

    const clean = verify();
    ok(clean.status === 0, "an unchanged tree passes");
    ok(clean.stdout.includes("0 changed source file"), "…with nothing to look at");

    const badBase = tidy(root, ["verify", "--base", "no-such-ref"]);
    ok(badBase.status !== 0, "an unresolvable --base fails rather than passing vacuously");
  }

  {
    const root = newRepo();
    ok(tidy(root, []).status !== 0, "no subcommand is an error");
    ok(tidy(root, ["nonsense"]).status !== 0, "an unknown subcommand is an error");
    ok(tidy(root, ["inventory", "src"]).status !== 0, "inventory without --out is an error");
    ok(tidy(root, ["verify"]).status !== 0, "verify without --base is an error");
    ok(tidy(root, ["inventory", "src/missing.ts", "--out", join(root, "x.jsonl")]).status !== 0, "a path that is not there is an error");
  }
} finally {
  for (const parent of parents) rmSync(parent, { recursive: true, force: true });
}

console.log(`✓ tidy-comments: ${passed} assertions passed`);

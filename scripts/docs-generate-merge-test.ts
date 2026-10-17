import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DocEntry } from "@open-everywhere/core/agent/docs/registry.js";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const DOCS_GENERATE = join(HERE, "docs-generate.ts");

const DOC = "docs/how-it-works/agent-and-loop.md";
const EMBED = "packages/core/agent/docs/generated/how-it-works.ts";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function git(cwd: string, args: readonly string[]): { status: number; out: string } {
  const r = spawnSync(
    "git",
    ["-c", "user.name=oe-test", "-c", "user.email=oe-test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, encoding: "utf8" },
  );
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function mustGit(cwd: string, args: readonly string[]): string {
  const r = git(cwd, args);
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.out}`);
  return r.out;
}

function generate(root: string, check: boolean): { status: number; out: string } {
  const r = spawnSync(process.execPath, [TSX, DOCS_GENERATE, "--root", root, ...(check ? ["--check"] : [])], { encoding: "utf8", cwd: ROOT });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function pickLines(lines: readonly string[]): [number, number] {
  const body = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => i > lines.length / 4 && l.trim().length > 0 && !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("```"));
  assert.ok(body.length >= 4, `${DOC} has too few body lines for this suite`);
  const a = body[Math.floor(body.length / 3)].i;
  const b = body[Math.floor((2 * body.length) / 3)].i;
  assert.ok(b - a >= 3, "the two edited lines must be separated by unchanged lines");
  return [a, b];
}

function editLine(abs: string, index: number, suffix: string): void {
  const lines = readFileSync(abs, "utf8").split("\n");
  lines[index] = `${lines[index]}${suffix}`;
  writeFileSync(abs, lines.join("\n"));
}

function seedTree(dir: string): void {
  cpSync(join(ROOT, "docs"), join(dir, "docs"), { recursive: true });
  cpSync(join(ROOT, "packages", "core", "agent", "docs", "generated"), join(dir, "packages", "core", "agent", "docs", "generated"), { recursive: true });
  for (const e of readdirSync(join(ROOT, "packages", "providers"), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const from = join(ROOT, "packages", "providers", e.name, "agent");
    const to = join(dir, "packages", "providers", e.name, "agent");
    mkdirSync(to, { recursive: true });
    for (const f of ["register.ts", "docs-generated.ts"]) if (existsSync(join(from, f))) cpSync(join(from, f), join(to, f));
  }
}

const scratch = mkdtempSync(join(tmpdir(), "oe-docs-merge-"));
const cleanup = (): void => rmSync(scratch, { recursive: true, force: true });
process.on("exit", cleanup);
try {
  const sourceLines = readFileSync(join(ROOT, DOC), "utf8").split("\n");
  const [lineA, lineB] = pickLines(sourceLines);
  const heading = sourceLines.findIndex((l) => /^#\s/u.test(l));
  const opening = sourceLines.findIndex((l, i) => i > heading && l.trim().length > 0 && !/^[#>*|`-]/u.test(l.trim()));
  ok(heading >= 0 && opening - heading >= 2, `${DOC} has a heading, then an opening paragraph after an unchanged line`);

  {
    const repo = join(scratch, "real");
    mkdirSync(repo);
    seedTree(repo);
    mustGit(repo, ["init", "-q", "-b", "main"]);
    const g0 = generate(repo, false);
    ok(g0.status === 0, `the generator runs on the scratch copy (${g0.out.slice(0, 300)})`);
    mustGit(repo, ["add", "-A"]);
    mustGit(repo, ["commit", "-q", "-m", "base"]);

    const mergeCase = (label: string, first: [string, number], queued: [string, number]): void => {
      for (const [branch, line] of [first, queued]) {
        mustGit(repo, ["checkout", "-q", "-b", branch, "main"]);
        editLine(join(repo, DOC), line, ` (edit from branch ${branch})`);
        const g = generate(repo, false);
        ok(g.status === 0, `${label}: branch ${branch} regenerates (${g.out.slice(0, 300)})`);
        const changed = mustGit(repo, ["status", "--porcelain"]);
        ok(changed.includes(EMBED), `${label}: branch ${branch} changes the embed ${EMBED}, so the merge exercises it`);
        mustGit(repo, ["add", "-A"]);
        mustGit(repo, ["commit", "-q", "-m", `edit ${branch}`]);
      }
      mustGit(repo, ["checkout", "-q", queued[0]]);
      const merge = git(repo, ["merge", "--no-edit", first[0]]);
      ok(merge.status === 0, `${label}: the two-branch merge is clean, generated embed included — git said: ${merge.out.trim().slice(0, 400)}`);
      const merged = readFileSync(join(repo, DOC), "utf8");
      ok(merged.includes(`(edit from branch ${first[0]})`) && merged.includes(`(edit from branch ${queued[0]})`), `${label}: the merged doc carries both edits`);
      const check = generate(repo, true);
      ok(check.status === 0, `${label}: docs-generate --check passes on the merge result, so the merged embed equals a regeneration — ${check.out.trim().slice(0, 400)}`);
    };

    mergeCase("body lines", ["a", lineA], ["b", lineB]);
    mergeCase("heading vs opening paragraph", ["h", heading], ["p", opening]);
    const embed = readFileSync(join(repo, EMBED), "utf8");
    ok(/^ {4}title: "[^\n]*\(edit from branch h\)",$/mu.test(embed), "heading case: the merged title line carries branch h's edit");
    ok(/^ {4}summary: "[^\n]*\(edit from branch p\)[^\n]*",$/mu.test(embed), "heading case: the merged summary line carries branch p's edit");

    editLine(join(repo, DOC), lineA, " (unregenerated)");
    const stale = generate(repo, true);
    ok(stale.status !== 0 && stale.out.includes(`${EMBED} is out of date`), "docs-generate --check still fails when a doc changes without a regeneration");
  }

  {
    const repo = join(scratch, "real");
    const crlf = readFileSync(join(ROOT, DOC), "utf8").replace(/\n+$/u, "").split("\n").join("\r\n");
    ok(crlf.includes("\r\n") && !crlf.endsWith("\n"), "the synthetic doc has CRLF line ends and no trailing newline");
    writeFileSync(join(repo, DOC), crlf);
    const emptyDoc = DOC.replace(/[^/]+$/u, "zz-empty-synthetic.md");
    writeFileSync(join(repo, emptyDoc), "");
    const g = generate(repo, false);
    ok(g.status === 0, `the generator runs on the synthetic docs (${g.out.slice(0, 300)})`);
    const mod = (await import(pathToFileURL(join(repo, EMBED)).href)) as Record<string, readonly DocEntry[]>;
    const entries = Object.values(mod).flat();
    ok(entries.find((d) => d.path === DOC)?.markdown === crlf, "the CRLF doc with no trailing newline round-trips byte for byte");
    ok(entries.find((d) => d.path === emptyDoc)?.markdown === "", "the empty doc round-trips to the empty string");
  }

  {
    const repo = join(scratch, "one-line");
    mkdirSync(repo);
    const source = readFileSync(join(ROOT, DOC), "utf8");
    const write = (md: string): void => {
      writeFileSync(join(repo, DOC.split("/").pop()!), md);
      writeFileSync(join(repo, "embed.ts"), `export const DOC = {\n  path: ${JSON.stringify(DOC)},\n  markdown: ${JSON.stringify(md)},\n};\n`);
    };
    mustGit(repo, ["init", "-q", "-b", "main"]);
    write(source);
    mustGit(repo, ["add", "-A"]);
    mustGit(repo, ["commit", "-q", "-m", "base"]);
    for (const [branch, line] of [["a", lineA], ["b", lineB]] as const) {
      mustGit(repo, ["checkout", "-q", "-b", branch, "main"]);
      const lines = source.split("\n");
      lines[line] = `${lines[line]} (edit from branch ${branch})`;
      write(lines.join("\n"));
      mustGit(repo, ["commit", "-q", "-am", `edit ${branch}`]);
    }
    mustGit(repo, ["checkout", "-q", "b"]);
    const merge = git(repo, ["merge", "--no-edit", "a"]);
    ok(merge.status !== 0, "negative control: the one-line embed shape conflicts on the same two edits");
    ok(/CONFLICT[^\n]*embed\.ts/u.test(merge.out), `negative control: the conflict is on the embed (${merge.out.trim().slice(0, 300)})`);
    ok(!/CONFLICT[^\n]*\.md/u.test(merge.out), "negative control: the markdown source itself merges cleanly");
  }
} finally {
  cleanup();
  process.off("exit", cleanup);
}

const shipped: DocEntry[] = [];
const universal = (await import(pathToFileURL(join(ROOT, "packages", "core", "agent", "docs", "generated", "index.ts")).href)) as {
  UNIVERSAL_DOCS: readonly DocEntry[];
};
ok(universal.UNIVERSAL_DOCS.length > 0, "the committed generated index exports the universal docs");
shipped.push(...universal.UNIVERSAL_DOCS);
let providerModules = 0;
for (const e of readdirSync(join(ROOT, "packages", "providers"), { withFileTypes: true })) {
  const abs = join(ROOT, "packages", "providers", e.name, "agent", "docs-generated.ts");
  if (!e.isDirectory() || !existsSync(abs)) continue;
  const mod = (await import(pathToFileURL(abs).href)) as { PROVIDER_DOCS: readonly DocEntry[] };
  ok(mod.PROVIDER_DOCS.length > 0, `${e.name} ships a provider runbook`);
  shipped.push(...mod.PROVIDER_DOCS);
  providerModules++;
}
ok(providerModules > 0, "tier 3 reads the provider runbook modules");
for (const d of shipped) {
  ok(d.markdown === readFileSync(join(ROOT, d.path), "utf8"), `shipped markdown equals its source file: ${d.path}`);
}

console.log(`✓ docs-generate merge: ${passed} assertion(s) — a two-branch edit of ${DOC} merges cleanly and passes --check; the one-line shape conflicts`);

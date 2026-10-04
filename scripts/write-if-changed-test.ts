import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileIfChanged } from "./write-if-changed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const DOCS_GENERATE = join(HERE, "docs-generate.ts");
const CAPABILITY_GENERATE = join(HERE, "worker-capability-index-generate.ts");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const mtimeOf = (abs: string): number => statSync(abs).mtimeMs;

function generatedOutputs(root: string): string[] {
  const out: string[] = [];
  const universalDir = join(root, "packages", "core", "agent", "docs", "generated");
  for (const f of readdirSync(universalDir)) if (f.endsWith(".ts")) out.push(join(universalDir, f));
  const providersDir = join(root, "packages", "providers");
  for (const e of readdirSync(providersDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const abs = join(providersDir, e.name, "agent", "docs-generated.ts");
    if (existsSync(abs)) out.push(abs);
  }
  return out.sort();
}

function run(script: string, args: readonly string[] = []): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TSX, script, ...args], { encoding: "utf8", cwd: ROOT });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const TRACKED = generatedOutputs(ROOT);
const trackedBytesAtStart = TRACKED.map((abs) => readFileSync(abs, "utf8"));

{
  const dir = mkdtempSync(join(tmpdir(), "oe-write-if-changed-"));
  try {
    const file = join(dir, "nested", "deep", "generated.ts");

    ok(writeFileIfChanged(file, "alpha") === true, "a missing file is written, and reports that it wrote");
    ok(existsSync(file), "…the parent directories were created");
    assert.equal(readFileSync(file, "utf8"), "alpha");

    const aged = new Date(2020, 0, 1);
    utimesSync(file, aged, aged);
    const before = mtimeOf(file);

    ok(writeFileIfChanged(file, "alpha") === false, "identical bytes report no write");
    ok(mtimeOf(file) === before, "…and the mtime is untouched — this is the whole point of OPE-1156");
    assert.equal(readFileSync(file, "utf8"), "alpha", "…and the content is unharmed");

    writeFileSync(file, "alpha");
    ok(mtimeOf(file) !== before, "negative control: an unconditional rewrite of identical bytes DOES move the mtime on this filesystem");

    utimesSync(file, aged, aged);
    const beforeChange = mtimeOf(file);
    ok(writeFileIfChanged(file, "beta") === true, "different bytes are written, and report that they wrote");
    assert.equal(readFileSync(file, "utf8"), "beta", "…with the new content on disk");
    ok(mtimeOf(file) !== beforeChange, "…and the mtime moved, so a dist-freshness guard still sees a real edit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const scratch = mkdtempSync(join(tmpdir(), "oe-docs-generate-"));
  const cleanup = (): void => rmSync(scratch, { recursive: true, force: true });
  process.on("exit", cleanup);
  try {
    cpSync(join(ROOT, "docs"), join(scratch, "docs"), { recursive: true });
    cpSync(join(ROOT, "packages", "core", "agent", "docs", "generated"), join(scratch, "packages", "core", "agent", "docs", "generated"), { recursive: true });
    for (const e of readdirSync(join(ROOT, "packages", "providers"), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const from = join(ROOT, "packages", "providers", e.name, "agent");
      const to = join(scratch, "packages", "providers", e.name, "agent");
      mkdirSync(to, { recursive: true });
      for (const f of ["register.ts", "docs-generated.ts"]) {
        if (existsSync(join(from, f))) cpSync(join(from, f), join(to, f));
      }
    }

    const outputs = generatedOutputs(scratch);
    ok(outputs.length > 0, "the isolated copy carries the generated-docs outputs");
    ok(
      outputs.some((p) => p.includes(join("packages", "providers"))),
      "…including at least one provider runbook module — the exact file whose mtime staled provider dist",
    );

    const aged = new Date(2020, 0, 1);
    for (const abs of outputs) utimesSync(abs, aged, aged);
    const before = new Map(outputs.map((abs) => [abs, mtimeOf(abs)]));

    const unchanged = run(DOCS_GENERATE, ["--root", scratch]);
    ok(unchanged.status === 0, `docs-generate exits 0 over unchanged sources (got ${unchanged.status}: ${unchanged.stderr.slice(0, 400)})`);

    const touched = outputs.filter((abs) => mtimeOf(abs) !== before.get(abs));
    ok(
      touched.length === 0,
      `an unchanged regeneration leaves every output's mtime alone — ${touched.length} file(s) were rewritten: ${touched
        .map((p) => p.slice(scratch.length + 1))
        .join(", ")}`,
    );
    ok(unchanged.stdout.includes(`0 written, ${outputs.length} already current`), `…and it says so: ${unchanged.stdout.trim().slice(0, 160)}`);

    const victim = join(scratch, "packages", "core", "agent", "docs", "generated", "index.ts");
    const correct = readFileSync(victim, "utf8");
    writeFileSync(victim, `${correct}\n// perturbation — the generator must overwrite this line.\n`);
    utimesSync(victim, aged, aged);
    const beforeChange = mtimeOf(victim);

    const changed = run(DOCS_GENERATE, ["--root", scratch]);
    ok(changed.status === 0, `docs-generate exits 0 over a perturbed output (got ${changed.status}: ${changed.stderr.slice(0, 400)})`);
    ok(readFileSync(victim, "utf8") === correct, "a changed regeneration writes the correct bytes back");
    ok(mtimeOf(victim) !== beforeChange, "…and moves that file's mtime, so the skip never swallows a real edit");
    ok(changed.stdout.includes("1 written"), `…and it writes exactly the one file that differed: ${changed.stdout.trim().slice(0, 160)}`);

    const collateral = outputs.filter((abs) => abs !== victim && mtimeOf(abs) !== before.get(abs));
    ok(collateral.length === 0, `a single changed file does not drag the other ${outputs.length - 1} outputs with it (${collateral.length} moved)`);

    const legacy = join(scratch, "agent", "docs", "generated", "security.ts");
    mkdirSync(join(scratch, "agent", "docs", "generated"), { recursive: true });
    writeFileSync(legacy, "export const SECTION_SECURITY = [];\n");
    const legacyCheck = run(DOCS_GENERATE, ["--root", scratch, "--check"]);
    ok(
      legacyCheck.status !== 0 && legacyCheck.stderr.includes("agent/docs/generated/security.ts is stale"),
      `--check reds a module left at the pre-OPE-2215 app-tree path (got ${legacyCheck.status}: ${legacyCheck.stderr.slice(0, 300)})`,
    );
    const legacyWrite = run(DOCS_GENERATE, ["--root", scratch]);
    ok(legacyWrite.status === 0 && !existsSync(legacy), "…and a regeneration removes it");
  } finally {
    cleanup();
    process.off("exit", cleanup);
  }
}

{
  const cases = [
    { label: "docs-generate", script: DOCS_GENERATE, expect: "0 written" },
    { label: "worker-capability-index-generate", script: CAPABILITY_GENERATE, expect: "already current" },
  ] as const;

  for (const c of cases) {
    const before = new Map(TRACKED.map((abs) => [abs, mtimeOf(abs)]));
    const r = run(c.script);
    ok(r.status === 0, `${c.label} exits 0 on a current worktree (got ${r.status}: ${r.stderr.slice(0, 300)})`);
    ok(r.stdout.includes(c.expect), `${c.label} reports it wrote nothing — expected "${c.expect}", got: ${r.stdout.trim().slice(0, 160)}`);
    const moved = TRACKED.filter((abs) => mtimeOf(abs) !== before.get(abs));
    ok(moved.length === 0, `${c.label} moves no tracked output's mtime (${moved.length} moved)`);
  }
}

for (const [i, abs] of TRACKED.entries()) {
  ok(readFileSync(abs, "utf8") === trackedBytesAtStart[i], `tracked file is byte-identical to how this suite found it: ${abs.slice(ROOT.length + 1)}`);
}

console.log(`✓ write-if-changed: ${passed} assertion(s) — the helper, the real docs generator on an isolated copy, and ${TRACKED.length} tracked outputs left untouched`);

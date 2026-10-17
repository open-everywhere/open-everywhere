import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectShaPins } from "./scenario-pin-lint-lib.js";
import { finishedRun } from "./npm-command.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LINT = join(root, "scripts", "scenario-pin-lint.ts");
const TSX = join(root, "node_modules", "tsx", "dist", "cli.mjs");

let passed = 0;

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
  passed++;
}

function lint(...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [TSX, LINT, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return { code: finishedRun(r, "the scenario-pin lint").status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "oe-scenario-pins-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body, "utf8");
  }
  return dir;
}

const NO_SUCH_OBJECT = "0123456789abcdef0123456789abcdef01234567";

function main(): void {
  {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    ok(/^[0-9a-f]{40}$/.test(head), "HEAD resolved to a full 40-char sha");
    const dir = fixtureDir({ "pinned.ts": `// a pin on the most reachable commit there is\nexport const PIN = "${head}";\n` });
    try {
      const r = lint("--dir", dir);
      ok(r.code === 1, `a pin on HEAD itself fails the gate (exit ${r.code}): ${r.out.trim().slice(0, 300)}`);
      ok(r.out.includes(head.slice(0, 8)), "…naming the pin it refused");
      ok(r.out.includes("pinned.ts:2"), "…naming the file and line, counted from 1");
      ok(r.out.includes("does not survive a rewrite of the history"), "…and saying WHY a sha pin is refused");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const dir = fixtureDir({ "clean.ts": "export const X = 1;\n", "nested/deeper/pinned.ts": `export const PIN = '${NO_SUCH_OBJECT}';\n` });
    try {
      const r = lint("--dir", dir);
      ok(r.code === 1, `a pin in a nested directory fails the gate (exit ${r.code})`);
      ok(r.out.includes(join("nested", "deeper", "pinned.ts") + ":1"), "…naming the nested file");
      ok(r.out.includes("1 commit-sha pin(s) refused"), "…and counting exactly the one pin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const dir = fixtureDir({
      "prose.ts":
        `// see ${NO_SUCH_OBJECT} for the history\n` +
        `export const SHORT = "${NO_SUCH_OBJECT.slice(0, 39)}";\n` +
        `export const UPPER = "${NO_SUCH_OBJECT.toUpperCase()}";\n`,
    });
    try {
      const r = lint("--dir", dir);
      ok(r.code === 0, `a tree with no pin passes the gate (exit ${r.code}): ${r.out.trim().slice(0, 300)}`);
      ok(r.out.includes("none in"), "…and says it found none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const dir = mkdtempSync(join(tmpdir(), "oe-scenario-pins-empty-"));
    try {
      const r = lint("--dir", dir);
      ok(r.code === 1, `a tree with no .ts files fails the gate (exit ${r.code})`);
      ok(r.out.includes("wrong tree"), "…saying the gate is looking at the wrong tree");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const r = lint();
    ok(r.code === 0, `the live e2e pack holds no commit-sha pin (exit ${r.code}): ${r.out.trim().slice(-400)}`);
  }

  {
    ok(collectShaPins(`const a = "${NO_SUCH_OBJECT}";`, "f.ts").length === 1, "a double-quoted 40-hex literal is a pin");
    ok(collectShaPins(`const a = '${NO_SUCH_OBJECT}';`, "f.ts").length === 1, "a single-quoted one is too");
    ok(collectShaPins(`const a = \`${NO_SUCH_OBJECT}\`;`, "f.ts").length === 1, "and a backticked one");
    ok(collectShaPins(`// see ${NO_SUCH_OBJECT} for the fix`, "f.ts").length === 0, "a bare 40-hex run in prose is NOT a pin (it would refuse over a comment)");
    ok(collectShaPins(`const a = "${NO_SUCH_OBJECT.slice(0, 39)}";`, "f.ts").length === 0, "39 hex characters is not a sha");
    ok(collectShaPins(`const a = "${NO_SUCH_OBJECT}ff";`, "f.ts").length === 0, "42 hex characters is not a sha either");
    ok(collectShaPins(`const a = "${NO_SUCH_OBJECT.toUpperCase()}";`, "f.ts").length === 0, "uppercase hex is not matched — git writes lowercase");
    const multi = collectShaPins(`a\nconst x = "${NO_SUCH_OBJECT}";\nb\nconst y = "${NO_SUCH_OBJECT}";\n`, "f.ts");
    ok(multi.length === 2 && multi[0]!.line === 2 && multi[1]!.line === 4, "line numbers are 1-based and per-occurrence");
  }
}

try {
  main();
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  console.error(`  (${passed} assertion(s) passed before the failure)`);
  process.exit(1);
}

console.log(`\n✓ scenario pin gate: ${passed} assertions passed\n`);

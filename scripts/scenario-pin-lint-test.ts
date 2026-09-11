import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectShaPins, pinVerdict } from "./scenario-pin-lint-lib.js";
import { pinObjectAction, pinSkipCause } from "../packages/core/scripts/e2e/deployed-build.js";

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
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function fixtureDir(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oe-scenario-pins-"));
  writeFileSync(join(dir, "pinned.ts"), body, "utf8");
  return dir;
}

function danglingCommit(): string {
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
  return execFileSync("git", ["commit-tree", tree, "-m", "scenario-pin-lint fixture: unreachable by design"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "oe-test",
      GIT_AUTHOR_EMAIL: "oe-test@example.invalid",
      GIT_COMMITTER_NAME: "oe-test",
      GIT_COMMITTER_EMAIL: "oe-test@example.invalid",
    },
  }).trim();
}

const NO_SUCH_OBJECT = "0123456789abcdef0123456789abcdef01234567";

function main(): void {
  {
    const dir = fixtureDir(`export const PIN = "${NO_SUCH_OBJECT}";\n`);
    try {
      const r = lint("--dir", dir);
      ok(r.code !== 0, `a pin naming no object fails the gate (exit ${r.code})`);
      ok(r.out.includes(NO_SUCH_OBJECT.slice(0, 8)), "…naming the pin it refused");
      ok(r.out.includes("pinned.ts:1"), "…naming the file and line the pin sits on");
      ok(r.out.toLowerCase().includes("unshallow"), "…printing the remedy for the clone-depth case rather than blaming the deployment");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const sha = danglingCommit();
    ok(/^[0-9a-f]{40}$/.test(sha), "the fixture commit-tree produced a full 40-char sha");
    const dir = fixtureDir(`// a pin that exists but never landed\nexport const PIN = "${sha}";\n`);
    try {
      const r = lint("--dir", dir);
      ok(r.code !== 0, `a real commit that is not an ancestor of main fails the gate (exit ${r.code})`);
      ok(r.out.includes("NOT reachable"), "…saying the pin is unreachable, not that it names nothing");
      ok(r.out.includes("pinned.ts:2"), "…naming the file and line, counted from 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const good = execFileSync("git", ["rev-parse", "origin/main"], { cwd: root, encoding: "utf8" }).trim();
    const dir = fixtureDir(`export const PIN = "${good}";\n`);
    try {
      const r = lint("--dir", dir);
      ok(r.code === 0, `a pin reachable from main passes the gate (exit ${r.code}): ${r.out.trim().slice(0, 300)}`);
      ok(r.out.includes(good.slice(0, 8)), "…and says which pin it cleared");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const r = lint();
    ok(r.code === 0, `the live e2e pack's own pins are all reachable from main (exit ${r.code}): ${r.out.trim().slice(-400)}`);
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

  {
    ok(pinObjectAction({ objectPresent: true, shallowClone: false }) === "ready", "full clone + object present → ask the ancestry question");
    ok(pinObjectAction({ objectPresent: true, shallowClone: true }) === "deepen", "SHALLOW clone + object present → deepen anyway (graft boundary, OPE-1111)");
    ok(pinObjectAction({ objectPresent: false, shallowClone: true }) === "deepen", "shallow clone + object absent → deepen (the ship sandbox's shape, OPE-1715)");
    ok(pinObjectAction({ objectPresent: false, shallowClone: false }) === "absent", "full clone + object absent → the pin names nothing here");
  }

  {
    ok(pinVerdict("present", true) === "ok", "resolved + reachable → ok");
    ok(pinVerdict("deepened", true) === "ok", "a pin that needed a deepen is just as good once it is here");
    ok(pinVerdict("present", false) === "unreachable", "resolved + not an ancestor of main → unreachable");
    ok(pinVerdict("deepen-failed", true) === "unresolvable", "a failed deepen is unresolvable even when the stale reachability probe said true");
    ok(pinVerdict("deepen-failed", false) === "unresolvable", "…and when it said false");
    ok(pinVerdict("absent", true) === "unresolvable", "an absent object is unresolvable whatever the probe answered");
  }

  {
    const unresolvable = pinSkipCause("pin-unresolvable", NO_SUCH_OBJECT);
    ok(unresolvable.includes("NOTHING was measured"), "pin-unresolvable says nothing was measured about the deployment");
    ok(!/older|does not carry/i.test(unresolvable), "…and makes no claim about the deployed build being old");
    ok(/older/i.test(pinSkipCause("older-build", NO_SUCH_OBJECT)), "older-build DOES say the deploy is behind the pin");
    ok(pinSkipCause("no-record", NO_SUCH_OBJECT).includes("known-good.json"), "no-record names the pointer file the operator must write");
    const deployUnresolvable = pinSkipCause("deploy-unresolvable", NO_SUCH_OBJECT);
    ok(deployUnresolvable.includes("NOTHING was measured"), "deploy-unresolvable says nothing was measured about the deployed build");
    ok(!/is OLDER than/.test(deployUnresolvable), "…and never claims the deploy is older than the pin");
    ok(deployUnresolvable.includes("RECORDED DEPLOY COMMIT"), "…and names the recorded commit as the thing that could not be resolved");
    ok(pinSkipCause("carries", NO_SUCH_OBJECT).includes(NO_SUCH_OBJECT.slice(0, 8)), "carries names the pin it cleared");
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

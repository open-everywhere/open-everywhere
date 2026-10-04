import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { tsxCommand } from "../npm-command.js";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAIN_LIST_FILE, CHAIN_RUNNER, REPO_ROOT, parseChainList } from "./_legs.js";
import { runChain } from "./_run-chain-lib.js";

describe("parseChainList", () => {
  test("returns the names in file order, and skips blank and `#` lines", () => {
    const text = "# header\n\ntest:b\n  test:a  \n# note\nlint:c\n";
    expect(parseChainList(text, "x")).toEqual(["test:b", "test:a", "lint:c"]);
  });

  test("refuses the old one-line shape on a line", () => {
    expect(() => parseChainList("npm run test:a\n", "x")).toThrow(/not a bare npm script name/);
    expect(() => parseChainList("test:a && test:b\n", "x")).toThrow(/not a bare npm script name/);
  });

  test("refuses a name twice — the shape a union merge leaves when two branches add the same leg", () => {
    expect(() => parseChainList("test:a\ntest:b\ntest:a\n", "pkg/test-chain.txt")).toThrow(
      /pkg\/test-chain\.txt:3: "test:a" is on the chain list twice/,
    );
  });
});

describe("runChain", () => {
  test("runs every leg in order and returns 0 when all pass", () => {
    const ran: string[] = [];
    const code = runChain(["a", "b", "c"], (leg) => (ran.push(leg), 0), () => {});
    expect(ran).toEqual(["a", "b", "c"]);
    expect(code).toBe(0);
  });

  test("stops at the first red and returns that leg's exit code", () => {
    const ran: string[] = [];
    const lines: string[] = [];
    const code = runChain(["a", "b", "c"], (leg) => (ran.push(leg), leg === "b" ? 7 : 0), (l) => lines.push(l));
    expect(ran).toEqual(["a", "b"]);
    expect(code).toBe(7);
    expect(lines.join("\n")).toMatch(/"b" failed \(exit 7\) — leg 2 of 3/);
  });

  test("a leg killed by a signal (status null) still stops the chain, with exit 1", () => {
    const ran: string[] = [];
    expect(runChain(["a", "b"], (leg) => (ran.push(leg), null), () => {})).toBe(1);
    expect(ran).toEqual(["a"]);
  });
});

describe("the real runner, in a real process", () => {
  test("`tsx run-chain.ts` reads the cwd's list, runs it in order, and stops at the first red", () => {
    const dir = mkdtempSync(join(tmpdir(), "oe-run-chain-"));
    const log = join(dir, "ran.log");
    const step = (name: string, exit: number): string =>
      `node -e "require('fs').appendFileSync(process.argv[1], '${name}\\n'); process.exit(${exit})" ${JSON.stringify(log)}`;
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "oe-run-chain-probe", private: true, scripts: { one: step("one", 0), two: step("two", 3), three: step("three", 0) } }),
    );
    writeFileSync(join(dir, CHAIN_LIST_FILE), "# probe\none\ntwo\nthree\n");
    const r = spawnSync(...tsxCommand(REPO_ROOT, [join(REPO_ROOT, CHAIN_RUNNER)]), { cwd: dir, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(3);
    expect(readFileSync(log, "utf8")).toBe("one\ntwo\n");
    expect(r.stderr).toMatch(/"two" failed \(exit 3\) — leg 2 of 3/);
  });

  test("a runner reached through a symlinked path still runs — no main guard can miss and exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "oe-run-chain-link-"));
    const link = join(dir, "repo");
    symlinkSync(REPO_ROOT, link, "dir");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "oe-run-chain-link", private: true, scripts: { one: "exit 4" } }));
    writeFileSync(join(dir, CHAIN_LIST_FILE), "one\n");
    const r = spawnSync(...tsxCommand(REPO_ROOT, [join(link, CHAIN_RUNNER)]), { cwd: dir, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(4);
  });

  test("a package with no list is a red, not a silent pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "oe-run-chain-none-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "oe-run-chain-none", private: true }));
    const r = spawnSync(...tsxCommand(REPO_ROOT, [join(REPO_ROOT, CHAIN_RUNNER)]), { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no test-chain\.txt/);
  });
});

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accessSideEffectFindings,
  diffConfigSnapshots,
  renderConfigDiff,
  toolRosterFindings,
  type ConfigDiff,
  type ConfigSnapshot,
} from "./config-snapshot-diff.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

const baseRef = flag("base-ref");
const baseDirFlag = flag("base-dir");
if (!baseRef && !baseDirFlag) {
  console.error("usage: config-diff.ts --base-ref <ref> | --base-dir <dir>  [--out <md>] [--json <json>]");
  process.exit(2);
}

function snapshotIn(cwd: string): { snapshot?: ConfigSnapshot; failure?: string } {
  const r = spawnSync("npx", ["tsx", "scripts/config-snapshot.ts"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  if (r.error) return { failure: `could not run scripts/config-snapshot.ts in ${cwd}: ${r.error.message}` };
  if (r.status !== 0) {
    const tail = (r.stderr ?? "").trim().split("\n").slice(-8).join("\n");
    return { failure: `scripts/config-snapshot.ts exited ${r.status} in ${cwd}${tail ? ` — ${tail}` : ""}` };
  }
  try {
    const parsed = JSON.parse(r.stdout) as ConfigSnapshot;
    if (typeof parsed?.formatVersion !== "number" || !Array.isArray(parsed?.sections) || !Array.isArray(parsed?.rows)) {
      return { failure: `scripts/config-snapshot.ts in ${cwd} printed something that is not a ConfigSnapshot` };
    }
    return { snapshot: parsed };
  } catch (err) {
    return { failure: `could not parse the snapshot printed in ${cwd}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function changedFilesAgainst(ref: string): string[] | undefined {
  for (const args of [["diff", "--name-only", `${ref}...HEAD`], ["diff", "--name-only", ref, "HEAD"]]) {
    const r = spawnSync("git", args, { encoding: "utf8" });
    if (r.status === 0) {
      return r.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .sort((a, b) => a.localeCompare(b));
    }
  }
  return undefined;
}

const head = snapshotIn(process.cwd());
if (!head.snapshot) {
  console.error(`✗ config-diff: the HEAD revision's snapshot could not be built — ${head.failure}`);
  console.error("  (this means the config does not load; `npm run validate:config` is red for the same reason)");
  process.exit(1);
}

let baseDir = baseDirFlag;
let cleanup: (() => void) | undefined;
let baseFailure: string | undefined;

if (!baseDir && baseRef) {
  const tmp = mkdtempSync(join(tmpdir(), "oe-config-base-"));
  try {
    execFileSync("git", ["worktree", "add", "--detach", tmp, baseRef], { stdio: "pipe" });
    cleanup = () => {
      try {
        execFileSync("git", ["worktree", "remove", "--force", tmp], { stdio: "pipe" });
      } catch {
        rmSync(tmp, { recursive: true, force: true });
      }
    };
    baseDir = tmp;
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    baseFailure = `could not check out base ref "${baseRef}": ${err instanceof Error ? err.message.trim() : String(err)}`;
  }
}

let base: ConfigSnapshot | undefined;
if (baseDir && !baseFailure) {
  if (!existsSync(join(baseDir, "scripts", "config-snapshot.ts"))) {
    baseFailure = `the base revision has no scripts/config-snapshot.ts (it predates this gate), so it cannot describe its own config`;
  } else {
    if (baseDirFlag === undefined) {
      const ci = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: baseDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (ci.status !== 0) {
        baseFailure = `\`npm ci\` failed in the base checkout — ${(ci.stderr ?? "").trim().split("\n").slice(-4).join(" / ")}`;
      }
    }
    if (!baseFailure && !existsSync(join(baseDir, "node_modules"))) {
      baseFailure = `${join(baseDir, "node_modules")} does not exist — refusing to snapshot a checkout whose dependencies would resolve to another tree (the snapshot would silently describe that tree, not the base)`;
    }
  }
  if (!baseFailure) {
    const r = snapshotIn(baseDir);
    base = r.snapshot;
    baseFailure = r.failure;
  }
}

const changedFiles = baseRef ? changedFilesAgainst(baseRef) : undefined;

const diffed = diffConfigSnapshots(base, head.snapshot, { baseFailure });
const diff: ConfigDiff = {
  ...diffed,
  findings: [...diffed.findings, ...accessSideEffectFindings(diffed, changedFiles), ...toolRosterFindings(diffed)],
};
const markdown = renderConfigDiff(diff, { baseRef: baseRef ?? baseDirFlag, headRef: "HEAD", changedFiles });

const out = flag("out");
if (out) writeFileSync(out, markdown + "\n");
const jsonOut = flag("json");
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ base: base ?? null, baseFailure: baseFailure ?? null, head: head.snapshot, diff, changedFiles: changedFiles ?? null }, null, 2) + "\n");
}
console.log(markdown);

cleanup?.();

if (flag("expect-clean") !== undefined) {
  const blind = diff.sections.filter((s) => s.kind === "not-computable").length;
  if (blind > 0 || diff.findings.length > 0) {
    console.error(`\n✗ config-diff --expect-clean: ${blind} not-computable section(s), ${diff.findings.length} finding(s)`);
    process.exit(1);
  }
}

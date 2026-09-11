import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pinSkipCause, resolvePinObject } from "../packages/core/scripts/e2e/deployed-build.js";
import { collectShaPins, pinVerdict, type PinSite } from "./scenario-pin-lint-lib.js";

const ROOT = process.cwd();
const PACK_DIR = join("packages", "core", "scripts", "e2e");

function gitOk(args: readonly string[]): boolean {
  try {
    execFileSync("git", [...args], { cwd: ROOT, stdio: "ignore", timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

function mainRef(): string | undefined {
  for (const ref of ["origin/main", "main"]) if (gitOk(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) return ref;
  return undefined;
}

const dirFlag = process.argv.indexOf("--dir");
const scanRel = dirFlag >= 0 && process.argv[dirFlag + 1] !== undefined ? process.argv[dirFlag + 1]! : PACK_DIR;
const scanDir = isAbsolute(scanRel) ? scanRel : join(ROOT, scanRel);

function tsFilesUnder(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...tsFilesUnder(join(dir, entry.name), join(prefix, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(join(prefix, entry.name));
    }
  }
  return out;
}

const files = tsFilesUnder(scanDir);

const sites: PinSite[] = [];
for (const f of files) sites.push(...collectShaPins(readFileSync(join(scanDir, f), "utf8"), join(scanRel, f)));

if (sites.length === 0) {
  console.log(`✓ scenario pins: none found in ${scanRel}/ (${files.length} files scanned)`);
  process.exit(0);
}

const ref = mainRef();
if (ref === undefined) {
  console.error(`✗ scenario pins: neither \`origin/main\` nor \`main\` resolves in this checkout, so "reachable from main" cannot be answered for ${sites.length} pin(s).`);
  process.exit(1);
}

const problems: string[] = [];
for (const site of sites) {
  const resolution = resolvePinObject(site.sha);
  const reachable = gitOk(["merge-base", "--is-ancestor", site.sha, ref]);
  const verdict = pinVerdict(resolution, reachable);
  if (verdict === "ok") {
    console.log(`  ${site.file}:${site.line} — ${site.sha.slice(0, 8)} reachable from ${ref} (${resolution})`);
    continue;
  }
  problems.push(
    verdict === "unresolvable"
      ? `${site.file}:${site.line} — ${pinSkipCause("pin-unresolvable", site.sha)}`
      : `${site.file}:${site.line} — ${site.sha.slice(0, 8)} is NOT reachable from ${ref}. A scenario pinned to it can never arm on a deployed build: re-pin to the commit that landed the change on main.`,
  );
}

if (problems.length > 0) {
  console.error(`✗ scenario pins: ${problems.length} of ${sites.length} pin(s) refused.`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`✓ scenario pins: ${sites.length} pin(s) reachable from ${ref}`);

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { CHAIN_LIST_FILE, chainRunnerCommand, readChainList } from "./chain/_legs.js";

const ROOT = process.cwd();

interface Pkg {
  readonly label: string;
  readonly dir: string;
  readonly scripts: Record<string, string>;
}

function readPkg(dir: string, label: string): Pkg | null {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { name?: string; scripts?: Record<string, string> };
  return { label: parsed.name ?? label, dir, scripts: parsed.scripts ?? {} };
}

const packages: Pkg[] = [];
const root = readPkg(ROOT, "root");
if (!root) {
  console.error("✗ script-chain: no package.json at the repo root — this gate is looking at the wrong tree.");
  process.exit(1);
}
packages.push(root);

for (const base of ["packages", join("packages", "providers")]) {
  const dir = join(ROOT, base);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "providers") continue;
    const pkg = readPkg(join(dir, entry), `${base}/${entry}`);
    if (pkg) packages.push(pkg);
  }
}

const byName = new Map(packages.map((p) => [p.label, p]));

function legsIn(command: string): { script: string; workspace?: string }[] {
  const out: { script: string; workspace?: string }[] = [];
  const re = /npm\s+run\s+([A-Za-z0-9:_-]+)((?:\s+(?!npm\b)[^\s&|;]+)*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const tail = m[2] ?? "";
    const ws = /--workspace(?:=|\s+)(\S+)/.exec(tail);
    out.push({ script: m[1], ...(ws ? { workspace: ws[1] } : {}) });
  }
  return out;
}

const problems: string[] = [];
let checked = 0;

for (const pkg of packages) {
  for (const [name, command] of Object.entries(pkg.scripts)) {
    for (const leg of legsIn(command)) {
      checked++;
      const target = leg.workspace ? byName.get(leg.workspace) : pkg;
      if (!target) {
        problems.push(
          `${pkg.label}: script "${name}" runs \`npm run ${leg.script} --workspace ${leg.workspace}\`, but no workspace ` +
            `package is named "${leg.workspace}" — the leg cannot resolve.`,
        );
        continue;
      }
      if (!(leg.script in target.scripts)) {
        problems.push(
          `${pkg.label}: script "${name}" runs \`npm run ${leg.script}\`${leg.workspace ? ` in ${leg.workspace}` : ""}, ` +
            `but ${target.label} defines no script by that name — the chain dies here mid-run.`,
        );
      }
    }
  }
}

for (const pkg of packages) {
  let names: string[] | undefined;
  try {
    names = readChainList(pkg.dir);
  } catch (err) {
    problems.push((err as Error).message);
    continue;
  }
  const chain = pkg.scripts["test:chain"];
  if (names === undefined) {
    if (chain !== undefined) {
      problems.push(
        `${pkg.label}: script "test:chain" is defined, but the package has no ${CHAIN_LIST_FILE} — the runner has no list to run.`,
      );
    }
    continue;
  }
  const expected = chainRunnerCommand(pkg.dir);
  if (chain !== expected) {
    problems.push(
      `${pkg.label}: ${CHAIN_LIST_FILE} exists, so "test:chain" must be exactly \`${expected}\`, but it is ` +
        `${chain === undefined ? "not defined" : `\`${chain}\``}. Put the legs in ${CHAIN_LIST_FILE}, one per line, never in the script.`,
    );
  }
  for (const name of names) {
    checked++;
    if (!(name in pkg.scripts)) {
      problems.push(
        `${pkg.label}: ${CHAIN_LIST_FILE} names "${name}", but ${pkg.label} defines no script by that name — the chain dies here mid-run.`,
      );
    }
  }
}

const TSX_TARGET = /(?:^|\s)tsx\s+(\S+\.ts)(?=\s|$)/g;
const MENTIONS_TSX = /(?:^|\s)tsx(?:\s|$)/;
const byFile = new Map<string, string>();
for (const pkg of packages) {
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (!name.startsWith("test:") && !name.startsWith("lint:")) continue;
    if (name === "test:chain") continue;
    const targets = [...command.matchAll(TSX_TARGET)].map((m) => m[1]!);
    if (targets.length === 0) {
      if (MENTIONS_TSX.test(command)) {
        problems.push(
          `${pkg.label}: script "${name}" runs \`${command}\`, which invokes \`tsx\` but names no plain ` +
            `\`<file>.ts\` target this gate can read. Put the file first after \`tsx\`, unquoted — a target ` +
            `this cannot parse is a duplicate it cannot catch, and skipping it silently would hide that.`,
        );
      }
      continue;
    }
    for (const target of targets) {
      const file = relative(ROOT, join(pkg.dir, target));
      const label = `${pkg.label} ${name}`;
      const first = byFile.get(file);
      if (first !== undefined) {
        problems.push(
          `"${first}" and "${label}" both run \`tsx ${file}\` — two npm scripts naming ONE runner file. ` +
            `The batched runner would import it twice under two labels, and deleting either script leaves the ` +
            `other defined-but-unchained. Keep one script per runner file.`,
        );
        continue;
      }
      byFile.set(file, label);
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ script-chain: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

console.log(
  `✓ script-chain: ${checked} \`npm run\` and chain-list leg(s) across ${packages.length} package(s) all resolve; ` +
    `${byFile.size} \`test:*\`/\`lint:*\` runner file(s) each named by exactly one script`,
);

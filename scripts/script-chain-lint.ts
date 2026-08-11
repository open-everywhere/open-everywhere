import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

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

if (problems.length > 0) {
  console.error(`✗ script-chain: ${problems.length} unresolvable leg(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

console.log(`✓ script-chain: ${checked} \`npm run\` leg(s) across ${packages.length} package(s) all resolve`);

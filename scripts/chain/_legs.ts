import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const WORKSPACE_BASES = ["packages", join("packages", "providers")] as const;

export interface ChainLeg {
  readonly pkg: string;
  readonly dir: string;
  readonly script: string;
  readonly file: string;
}

interface Pkg {
  readonly name: string;
  readonly dir: string;
  readonly scripts: Record<string, string>;
}

export function workspacePackages(): Pkg[] {
  const out: Pkg[] = [];
  for (const base of WORKSPACE_BASES) {
    const dir = join(REPO_ROOT, base);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      if (entry === "node_modules" || entry === "providers") continue;
      const pkgDir = join(dir, entry);
      const file = join(pkgDir, "package.json");
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { name?: string; scripts?: Record<string, string> };
      out.push({ name: parsed.name ?? `${base}/${entry}`, dir: pkgDir, scripts: parsed.scripts ?? {} });
    }
  }
  return out;
}

export function chainLegNames(chain: string): string[] {
  const names: string[] = [];
  const re = /npm\s+run\s+([A-Za-z0-9:_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chain)) !== null) names.push(m[1]!);
  return names;
}

export function chainLegs(packages: Pkg[] = workspacePackages()): ChainLeg[] {
  const legs: ChainLeg[] = [];
  for (const pkg of packages) {
    const chain = pkg.scripts["test:chain"];
    if (!chain) continue;
    for (const script of chainLegNames(chain)) {
      const command = pkg.scripts[script];
      if (!command) {
        throw new Error(`${pkg.name}: test:chain names \`npm run ${script}\`, but the package defines no such script.`);
      }
      const m = /(?:^|\s)tsx\s+(\S+\.ts)(?:\s|$)/.exec(command);
      if (!m) {
        throw new Error(
          `${pkg.name}: test:chain leg "${script}" runs \`${command}\`, which is not a plain \`tsx <file>.ts\` ` +
            `command. The batched runner imports the file directly, so it cannot run this leg. Either make it a ` +
            `plain tsx invocation, or move it off \`test:chain\` onto its own gate.`,
        );
      }
      legs.push({ pkg: pkg.name, dir: pkg.dir, script, file: join(pkg.dir, m[1]!) });
    }
  }
  return legs;
}

export function legLabel(leg: ChainLeg): string {
  return `${leg.pkg} ${leg.script}`;
}

const VARIABLE_DYNAMIC_IMPORT = /\bimport\(\s*`[^`]*\$\{/u;

export function needsSubprocess(leg: ChainLeg): boolean {
  return VARIABLE_DYNAMIC_IMPORT.test(readFileSync(leg.file, "utf8"));
}

export const OFF_CHAIN_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  [
    "@open-everywhere/adapters test:sandbox-live",
    "drives the REAL Vercel Sandbox platform: needs credentials, creates 4 sandboxes, ~3 min and " +
      "~$0.02 a run. Run it by hand before a deploy that touches sandbox lifecycle.",
  ],
]);

export const SHARD_COUNT = 20;

export function legsForShard(index: number, legs: ChainLeg[] = chainLegs()): ChainLeg[] {
  if (!Number.isInteger(index) || index < 0 || index >= SHARD_COUNT) {
    throw new Error(`shard index ${index} is outside 0..${SHARD_COUNT - 1}`);
  }
  return legs.filter((_, i) => i % SHARD_COUNT === index);
}

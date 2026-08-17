import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ChainLeg {
  readonly script: string;
  readonly file: string;
}

interface CorePkg {
  readonly scripts: Record<string, string>;
}

export function readCorePkg(): CorePkg {
  return JSON.parse(readFileSync(join(CORE_ROOT, "package.json"), "utf8")) as CorePkg;
}

export function chainLegNames(pkg: CorePkg = readCorePkg()): string[] {
  const chain = pkg.scripts["test:chain"];
  if (!chain) throw new Error("packages/core/package.json defines no `test:chain` — the suite inventory is gone.");
  const names: string[] = [];
  const re = /npm\s+run\s+([A-Za-z0-9:_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chain)) !== null) names.push(m[1]!);
  return names;
}

export function chainLegs(pkg: CorePkg = readCorePkg()): ChainLeg[] {
  return chainLegNames(pkg).map((script) => {
    const command = pkg.scripts[script];
    if (!command) throw new Error(`test:chain names \`npm run ${script}\`, but package.json defines no such script.`);
    const m = /(?:^|\s)tsx\s+(\S+\.ts)(?:\s|$)/.exec(command);
    if (!m) {
      throw new Error(
        `test:chain leg "${script}" runs \`${command}\`, which is not a plain \`tsx <file>.ts\` command. ` +
          `The batched runner imports the file directly, so it cannot run this leg. Either make it a plain ` +
          `tsx invocation, or move it off \`test:chain\` onto its own gate.`,
      );
    }
    return { script, file: m[1]! };
  });
}

export const SUBPROCESS_LEGS: ReadonlySet<string> = new Set(["test:dynamic-replay", "test:fire-principal"]);

export const SHARD_COUNT = 16;

export function legsForShard(index: number, legs: ChainLeg[] = chainLegs()): ChainLeg[] {
  if (!Number.isInteger(index) || index < 0 || index >= SHARD_COUNT) {
    throw new Error(`shard index ${index} is outside 0..${SHARD_COUNT - 1}`);
  }
  return legs.filter((_, i) => i % SHARD_COUNT === index);
}

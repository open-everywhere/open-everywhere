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
  readonly args?: readonly string[];
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

export function chainLegs(packages: Pkg[] = workspacePackages(), includeRoot = true): ChainLeg[] {
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
  if (includeRoot) legs.push(...rootLegs());
  return legs;
}

export const ROOT_PKG_LABEL = "<root>";

export const ROOT_CHAIN_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "lint:script-chain",
    "the fail-fast gate that resolves every leg by NAME before any of them runs; it must go first " +
      "and serial, before the batched pool it is there to protect even exists. Run directly by the " +
      "root `test` script, ahead of `test:chain`.",
  ],
  [
    "test --workspace @open-everywhere/provider-discord",
    "an `echo` pointing at the app-tier suites (see chainLegs' doc comment above) — not a suite, " +
      "and the `--workspace` flag targets provider-discord's OWN `test` script, not the root one, " +
      "so it cannot be resolved by name against the root package the way every chain leg here is. " +
      "Run directly by the root `test` script, alongside `test:chain`.",
  ],
]);

function resolveRootScript(name: string, scripts: Record<string, string>, out: ChainLeg[], seen: Set<string>): void {
  if (seen.has(name)) {
    throw new Error(`root test chain: "${name}" is reached more than once — chained directly and via a nested chain.`);
  }
  seen.add(name);
  const command = scripts[name];
  if (!command) {
    throw new Error(`root test chain: \`npm run ${name}\` is named, but the root package defines no such script.`);
  }
  if (command.includes("&&")) {
    for (const part of command.split("&&").map((s) => s.trim())) {
      const mm = /^npm\s+run\s+([A-Za-z0-9:_-]+)$/.exec(part);
      if (!mm) {
        throw new Error(
          `root test chain: "${name}" runs \`${command}\`, whose segment "${part}" is not a plain \`npm run <name>\`. ` +
            `Give the segment its own named script first (the pattern \`lint:docs\`/\`test:egress-proxy\` use), so ` +
            `every leg has an \`npm run <name>\` that reproduces it alone.`,
        );
      }
      resolveRootScript(mm[1]!, scripts, out, seen);
    }
    return;
  }
  const m = /(?:^|\s)tsx\s+(\S+\.ts)((?:\s+\S+)*)\s*$/.exec(command);
  if (!m) {
    throw new Error(
      `root test chain: "${name}" runs \`${command}\`, which is not a plain \`tsx <file>.ts [args...]\` command. ` +
        `The batched runner imports the file directly, so it cannot run this leg. Either make it a plain tsx ` +
        `invocation, or move it off root \`test:chain\` onto its own gate in the root \`test\` script.`,
    );
  }
  const args = m[2]!.trim();
  out.push({
    pkg: ROOT_PKG_LABEL,
    dir: REPO_ROOT,
    script: name,
    file: join(REPO_ROOT, m[1]!),
    ...(args.length > 0 ? { args: args.split(/\s+/) } : {}),
  });
}

export function rootLegs(): ChainLeg[] {
  return walkRootChain().legs;
}

function walkRootChain(): { legs: ChainLeg[]; reached: Set<string> } {
  const file = join(REPO_ROOT, "package.json");
  const scripts = (JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  const chain = scripts["test:chain"];
  if (!chain) throw new Error("root test chain: the root package.json defines no `test:chain` script.");
  const legs: ChainLeg[] = [];
  const reached = new Set<string>();
  for (const name of chainLegNames(chain)) resolveRootScript(name, scripts, legs, reached);
  return { legs, reached };
}

export function rootChainScriptNames(): ReadonlySet<string> {
  return walkRootChain().reached;
}

export function legLabel(leg: ChainLeg): string {
  return `${leg.pkg} ${leg.script}`;
}

const VARIABLE_DYNAMIC_IMPORT = /\bimport\(\s*`[^`]*\$\{/u;

export const ROOT_SUBPROCESS_LEGS: ReadonlyMap<string, string> = new Map([
  [
    "test:memory-eval-fixture",
    "spawns itself via `process.execArgv` to reload agent/memory/config/domains.ts under each " +
      "OE_MEMORY_EVAL state. execArgv only carries tsx's loader flags when the leg itself was " +
      "launched by `npx tsx` — vitest's own worker process does not have them, so the self-respawn " +
      "cannot resolve a bare `.ts`-mapped import in-process.",
  ],
]);

export function needsSubprocess(leg: ChainLeg): boolean {
  if (leg.pkg === ROOT_PKG_LABEL && ROOT_SUBPROCESS_LEGS.has(leg.script)) return true;
  return VARIABLE_DYNAMIC_IMPORT.test(readFileSync(leg.file, "utf8"));
}

export const OFF_CHAIN_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  [
    "@open-everywhere/adapters test:sandbox-live",
    "drives the REAL Vercel Sandbox platform: needs credentials, creates 4 sandboxes, ~3 min and " +
      "~$0.02 a run. Run it by hand before a deploy that touches sandbox lifecycle.",
  ],
  [
    `${ROOT_PKG_LABEL} test:suites`,
    "the batched runner ITSELF — `vitest run --config vitest.chain.config.ts`, which is what EXECUTES " +
      "every chain leg. Chaining it would make the pool a leg of itself. Run by the root `test` script.",
  ],
  [
    `${ROOT_PKG_LABEL} test:integration`,
    "its own TIER, not a chain leg: a separate vitest config behind `suite-lock-run.ts`, ~1450s at one " +
      "worker, and it boots a real agent host per worker. Run as its own gate (`npm run test:integration`).",
  ],
  [
    `${ROOT_PKG_LABEL} test:dynamic-closure-bundle`,
    "a `postbuild` leg (OPE-1063): it reads the just-built `.output/server/index.mjs` to prove no " +
      "`defineTool` callback carries an undeclared capture, which no `tsx`-tier test can see. It runs " +
      "wherever `npm run build` runs, so it is already inside the `build` proof suite.",
  ],
  [
    `${ROOT_PKG_LABEL} test:e2e-driver`,
    "an argument-taking passthrough to the core workspace's `e2e:driver`, not a suite: it drives ONE " +
      "named e2e leg against a deployed instance. The batched runner imports a file and can pass no argv.",
  ],
  [
    `${ROOT_PKG_LABEL} test:pg-real`,
    "a LIVE pack: `bash scripts/test-pg-real.sh`, which needs a real Postgres. Not a `tsx <file>.ts` " +
      "command at all, so the batched runner could not import it even if the database were there.",
  ],
  [
    `${ROOT_PKG_LABEL} test:docker-smoke`,
    "a LIVE pack: `bash scripts/docker-smoke.sh`, which needs a Docker daemon. Same two reasons as " +
      "`test:pg-real` — an external dependency, and a bash command the runner cannot import.",
  ],
  [
    `${ROOT_PKG_LABEL} test:docker-sandbox-stop-live`,
    "a LIVE pack: it drives real Docker sandbox lifecycle. Run it by hand before a deploy that touches " +
      "the Docker sandbox driver.",
  ],
]);

export const SUITE_FILE_WITHOUT_SCRIPT: ReadonlyMap<string, string> = new Map([
  [
    "packages/core/scripts/wake-origin-fixtures-test.ts",
    "the FROZEN stored-data oracle. Its INVOCATION lives at the app tier — root `test:wake-origin-fixtures` " +
      "runs `scripts/wake-origin-fixtures-boot.ts`, which registers every provider bundle and then imports " +
      "this file dynamically. A core script may not import a provider package (boundary-test.ts rule 1), so " +
      "the oracle cannot own the script that runs it.",
  ],
  [
    "scripts/agent-version-seam-bundle-test.ts",
    "a `postbuild` leg: it reads the just-built bundle, which no `tsx`-tier `test:*` script can produce. It " +
      "runs wherever `npm run build` runs, so it is already inside the build proof — the same reason " +
      "`test:dynamic-closure-bundle` is in OFF_CHAIN_BY_DESIGN above.",
  ],
]);

export function suiteFilesWithARunner(): Set<string> {
  const out = new Set<string>();
  const rootScripts = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  const sources: { dir: string; scripts: Record<string, string> }[] = [
    { dir: REPO_ROOT, scripts: rootScripts },
    ...workspacePackages().map((p) => ({ dir: p.dir, scripts: p.scripts })),
  ];
  for (const { dir, scripts } of sources) {
    for (const [name, command] of Object.entries(scripts)) {
      if (!name.startsWith("test:") || name === "test:chain") continue;
      for (const m of command.matchAll(/(?:^|\s)tsx\s+(\S+\.ts)/g)) out.add(join(dir, m[1]!));
    }
  }
  return out;
}

export function suiteFilesOnDisk(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith("-test.ts")) out.add(path);
    }
  };
  const roots = [REPO_ROOT, ...workspacePackages().map((p) => p.dir)].map((d) => join(d, "scripts"));
  roots.push(join(REPO_ROOT, "deploy"));
  for (const root of roots) if (existsSync(root)) walk(root);
  return out;
}

export const SHARD_COUNT = 20;

export function legsForShard(index: number, legs: ChainLeg[] = chainLegs()): ChainLeg[] {
  if (!Number.isInteger(index) || index < 0 || index >= SHARD_COUNT) {
    throw new Error(`shard index ${index} is outside 0..${SHARD_COUNT - 1}`);
  }
  return legs.filter((_, i) => i % SHARD_COUNT === index);
}

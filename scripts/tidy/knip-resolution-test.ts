import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KNIP_TSCONFIG = "tsconfig.knip.json";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) passed++;
  else failures.push(label);
}

function readJson(path: string): Record<string, unknown> {
  const raw = readFileSync(join(REPO_ROOT, path), "utf8").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(raw) as Record<string, unknown>;
}

const rootPkg = readJson("package.json") as { scripts?: Record<string, string>; workspaces?: string[] };
const lintDead = rootPkg.scripts?.["lint:dead"] ?? "";
ok(lintDead.startsWith("knip "), `"lint:dead" runs knip — got ${JSON.stringify(lintDead)}`);
ok(
  lintDead.includes(`--tsConfig ${KNIP_TSCONFIG}`),
  `"lint:dead" passes --tsConfig ${KNIP_TSCONFIG}; without it every @open-everywhere import resolves into dist/ — got ${JSON.stringify(lintDead)}`,
);

function workspacePackages(): { name: string; dir: string }[] {
  const globs = rootPkg.workspaces ?? [];
  ok(globs.length > 0, "package.json declares workspaces globs");
  const out: { name: string; dir: string }[] = [];
  for (const glob of globs) {
    if (!glob.endsWith("/*") || glob.slice(0, -2).includes("*")) {
      ok(false, `workspaces glob "${glob}" is not the <prefix>/* shape this gate expands — teach it that shape`);
      continue;
    }
    const base = glob.slice(0, -2);
    const dir = join(REPO_ROOT, base);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      if (entry === "node_modules") continue;
      const manifest = join(dir, entry, "package.json");
      if (!existsSync(manifest)) continue;
      const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
      if (name) out.push({ name, dir: `${base}/${entry}` });
    }
  }
  return out;
}

const knipTsconfig = readJson(KNIP_TSCONFIG) as {
  extends?: string;
  compilerOptions?: { paths?: Record<string, string[]> };
};
const paths = knipTsconfig.compilerOptions?.paths ?? {};
ok(knipTsconfig.extends === "./tsconfig.json", `${KNIP_TSCONFIG} extends the root tsconfig`);

const packages = workspacePackages();
ok(packages.length >= 9, `found the workspace packages — got ${packages.length}`);
for (const pkg of packages) {
  const target = paths[`${pkg.name}/*`];
  ok(
    Array.isArray(target) && target[0] === `./${pkg.dir}/*`,
    `${KNIP_TSCONFIG} maps "${pkg.name}/*" to ./${pkg.dir}/* — got ${JSON.stringify(target)}`,
  );
}

interface KnipIssue {
  file: string;
  files?: { name?: string }[];
}
function unusedFiles(withResolution: boolean): Set<string> {
  const args = lintDead
    .trim()
    .split(/\s+/)
    .slice(1)
    .filter((arg, i, all) => withResolution || (arg !== "--tsConfig" && all[i - 1] !== "--tsConfig"));
  const raw = execFileSync(process.execPath, [join("node_modules", "knip", "bin", "knip.js"), ...args, "--reporter", "json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const issues = (JSON.parse(raw) as { issues?: KnipIssue[] }).issues ?? [];
  const out = new Set<string>();
  for (const issue of issues) for (const f of issue.files ?? []) out.add(f.name ?? issue.file);
  return out;
}

const unused = unusedFiles(true);

const crossPackage = [
  "packages/core/agent/adapter-api.ts",
  "packages/providers/discord/agent/register.ts",
  "packages/core/agent/access/wake-mapping.ts",
];
for (const file of crossPackage) {
  ok(existsSync(join(REPO_ROOT, file)), `probe file still exists: ${file}`);
  ok(!unused.has(file), `knip resolves the cross-package import of ${file} — it must not be reported unused`);
}

const unresolved = unusedFiles(false);
for (const file of crossPackage) {
  ok(
    unresolved.has(file),
    `negative control: without --tsConfig, knip must report ${file} as unused. It did not, so the absence checks above can no longer fail and prove nothing.`,
  );
}

for (const pkg of packages) {
  const contributions = `${pkg.dir}/agent/contributions.ts`;
  if (!existsSync(join(REPO_ROOT, contributions))) continue;
  ok(
    !unused.has(contributions),
    `${contributions} is loaded through a runtime-built specifier and must stay declared as a knip entry`,
  );
}
const instructions = "agent/instructions/access.ts";
ok(existsSync(join(REPO_ROOT, instructions)), `probe file still exists: ${instructions}`);
ok(
  !unused.has(instructions),
  `${instructions} is discovered by eve from its location, not by import — it must stay declared as a knip entry`,
);

const knipConfig = readJson("knip.json") as { workspaces?: Record<string, { entry?: string[] }> };
const workspaces = knipConfig.workspaces ?? {};
const blockFor = (dir: string): { key: string; entry?: string[] } | undefined => {
  if (workspaces[dir]) return { key: dir, ...workspaces[dir] };
  for (const [key, value] of Object.entries(workspaces)) {
    if (!key.endsWith("/*")) continue;
    const prefix = key.slice(0, -1);
    if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes("/")) return { key, ...value };
  }
  return undefined;
};

ok(
  (workspaces["."]?.entry ?? []).some((p) => p.startsWith("agent/instructions/")),
  `knip.json's root workspace declares agent/instructions/** as an entry — got ${JSON.stringify(workspaces["."]?.entry)}`,
);
for (const pkg of packages) {
  const block = blockFor(pkg.dir);
  ok(block !== undefined, `knip.json has a workspace block covering ${pkg.dir}`);
  if (!block) continue;
  if (!existsSync(join(REPO_ROOT, pkg.dir, "agent", "contributions.ts"))) continue;
  ok(
    (block.entry ?? []).includes("agent/contributions.ts"),
    `knip.json's "${block.key}" block declares agent/contributions.ts as an entry — got ${JSON.stringify(block.entry)}`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error(`✗ knip resolution — ${failures.length} of ${failures.length + passed} assertions failed`);
  process.exit(1);
}
console.log(`✓ knip resolution — ${passed} assertions`);

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ALL_PUBLISHABLE_PACKAGES } from "./publish-exports-generate.js";
import { RELEASE_TAG_PATTERN, sha512 } from "./release-publish.js";
import type { PlannedPackage, ReleasePlan } from "./release-publish.js";

const SCOPE = "@open-everywhere/";

export interface WorkspacePackage {
  dir: string;
  name: string;
  version: string;
  siblings: string[];
}

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export function siblingsOf(m: Manifest): string[] {
  const names = new Set<string>();
  for (const field of [m.dependencies, m.peerDependencies, m.optionalDependencies]) {
    for (const name of Object.keys(field ?? {})) if (name.startsWith(SCOPE)) names.add(name);
  }
  return [...names].sort();
}

export function readWorkspacePackages(root: string, dirs: readonly string[] = ALL_PUBLISHABLE_PACKAGES): WorkspacePackage[] {
  return dirs.map((dir) => {
    const m = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as Manifest;
    if (m.private) throw new Error(`${dir}: package.json is private, so it cannot publish`);
    return { dir, name: m.name, version: m.version, siblings: siblingsOf(m) };
  });
}

export function publishOrder(pkgs: WorkspacePackage[]): WorkspacePackage[] {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  for (const p of pkgs) {
    for (const s of p.siblings) {
      if (!byName.has(s)) throw new Error(`${p.name} depends on ${s}, which is not a publishable package`);
      if (s === p.name) throw new Error(`${p.name} depends on itself`);
    }
  }
  const done = new Set<string>();
  const order: WorkspacePackage[] = [];
  while (order.length < pkgs.length) {
    const next = pkgs.find((p) => !done.has(p.name) && p.siblings.every((s) => done.has(s)));
    if (!next) {
      const left = pkgs.filter((p) => !done.has(p.name)).map((p) => p.name);
      throw new Error(`a dependency cycle joins ${left.join(", ")}`);
    }
    done.add(next.name);
    order.push(next);
  }
  return order;
}

export function packArgs(dir: string, outDir: string): string[] {
  return ["pack", "--json", "--ignore-scripts", "--workspace", dir, "--pack-destination", outDir];
}

export function checkTag(tag: string, coreVersion: string, head: string, tagCommit: string | undefined): string[] {
  const errors: string[] = [];
  if (!RELEASE_TAG_PATTERN.test(tag)) errors.push(`"${tag}" is not a release tag (v<major>.<minor>.<patch>)`);
  else if (tag !== `v${coreVersion}`) errors.push(`the tag is ${tag}, and @open-everywhere/core is at ${coreVersion}`);
  if (!tagCommit) errors.push(`the tag ${tag} does not exist in this checkout`);
  else if (tagCommit !== head) errors.push(`HEAD is ${head}, and the tag ${tag} points at ${tagCommit}`);
  return errors;
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function main(): void {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  const tag = process.env.RELEASE_TAG ?? "";
  if (!out) {
    console.error("usage: RELEASE_TAG=v<version> tsx scripts/release-plan.ts --out <empty dir>");
    process.exit(2);
  }
  const outDir = resolve(out);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    console.error(`✗ ${outDir} is not empty`);
    process.exit(2);
  }

  const pkgs = readWorkspacePackages(root);
  const core = pkgs.find((p) => p.name === `${SCOPE}core`);
  if (!core) throw new Error("@open-everywhere/core is not in the publishable set");
  const head = git(root, ["rev-parse", "HEAD"]) ?? "(unknown)";
  const tagCommit = RELEASE_TAG_PATTERN.test(tag) ? git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]) : undefined;
  const errors = checkTag(tag, core.version, head, tagCommit);
  if (errors.length > 0) {
    for (const e of errors) console.error(`✗ ${e}`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const planned: PlannedPackage[] = [];
  for (const p of publishOrder(pkgs)) {
    const json = execFileSync("npm", packArgs(p.dir, outDir), {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const [packed] = JSON.parse(json) as { filename: string; name: string; version: string }[];
    if (!packed || packed.name !== p.name || packed.version !== p.version) {
      throw new Error(`${p.dir}: npm pack did not report ${p.name}@${p.version}`);
    }
    const tarball = packed.filename.replace(/^.*[\\/]/, "");
    planned.push({ dir: p.dir, name: p.name, version: p.version, tarball, sha512: sha512(readFileSync(join(outDir, tarball))) });
    console.log(`packed   ${p.name}@${p.version}`);
  }
  const plan: ReleasePlan = { tag, commit: head, packages: planned };
  writeFileSync(join(outDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`✓ ${tag}: ${planned.length} packages packed in dependency order into ${outDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

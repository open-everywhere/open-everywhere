import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_REPOSITORY = "open-everywhere/open-everywhere";

export const RELEASE_WORKFLOW_FILE = "npm-publish.yml";

export const MIN_NPM_VERSION = "11.5.1";

export const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const REGISTRY = "https://registry.npmjs.org";

export interface PlannedPackage {
  dir: string;
  name: string;
  version: string;
  tarball: string;
  sha512: string;
}

export interface ReleasePlan {
  tag: string;
  commit: string;
  packages: PlannedPackage[];
}

export interface RunContext {
  repository: string | undefined;
  eventName: string | undefined;
  ref: string | undefined;
  repositoryPrivate: boolean | undefined;
}

export function checkRunContext(ctx: RunContext, tag: string): string[] {
  const errors: string[] = [];
  if (ctx.repository !== RELEASE_REPOSITORY) {
    errors.push(`this run is in "${ctx.repository ?? "(none)"}", and only ${RELEASE_REPOSITORY} publishes`);
  }
  if (!RELEASE_TAG_PATTERN.test(tag)) {
    errors.push(`"${tag}" is not a release tag (v<major>.<minor>.<patch>)`);
  }
  if (ctx.eventName === "push") {
    if (ctx.ref !== `refs/tags/${tag}`) {
      errors.push(`a push run publishes only its own tag, and this push is "${ctx.ref ?? "(none)"}", not refs/tags/${tag}`);
    }
  } else if (ctx.eventName === "workflow_dispatch") {
    if (ctx.ref !== "refs/heads/main") {
      errors.push(`a manual run must start from main, and this one started from "${ctx.ref ?? "(none)"}"`);
    }
  } else {
    errors.push(`the event "${ctx.eventName ?? "(none)"}" never publishes: only a tag push or a manual run that names a tag`);
  }
  if (ctx.repositoryPrivate !== false) {
    errors.push(
      ctx.repositoryPrivate === true
        ? "the repository is private, and npm attaches provenance only to a public repository"
        : "the event payload does not say the repository is public, so provenance is not certain",
    );
  }
  return errors;
}

export function readRunContext(env: NodeJS.ProcessEnv): RunContext {
  let repositoryPrivate: boolean | undefined;
  if (env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as { repository?: { private?: unknown } };
      const flag = event.repository?.private;
      repositoryPrivate = typeof flag === "boolean" ? flag : undefined;
    } catch {
      repositoryPrivate = undefined;
    }
  }
  return { repository: env.GITHUB_REPOSITORY, eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, repositoryPrivate };
}

export function versionAtLeast(version: string, floor: string): boolean {
  const parse = (v: string): number[] => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    if (!m) return [Number.NaN];
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const a = parse(version);
  const b = parse(floor);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

export function checkPlan(plan: ReleasePlan, tag: string, head: string | undefined): string[] {
  const errors: string[] = [];
  if (plan.tag !== tag) errors.push(`the plan is for "${plan.tag}", and this run publishes "${tag}"`);
  if (!head || !/^[0-9a-f]{40}$/.test(plan.commit) || plan.commit !== head) {
    errors.push(`the pack job packed ${plan.commit || "(no commit)"}, and this checkout is ${head ?? "(unknown)"}: the tag moved, or the plan is not this run's`);
  }
  if (!Array.isArray(plan.packages) || plan.packages.length === 0) errors.push("the plan lists no package");
  const seen = new Set<string>();
  for (const p of plan.packages ?? []) {
    if (!p.name.startsWith("@open-everywhere/")) errors.push(`${p.name} is not an @open-everywhere package`);
    if (seen.has(p.name)) errors.push(`${p.name} is in the plan twice`);
    seen.add(p.name);
    if (p.tarball.includes("/") || p.tarball.includes("\\") || !p.tarball.endsWith(".tgz")) {
      errors.push(`${p.name}: "${p.tarball}" is not a bare .tgz file name`);
    }
  }
  return errors;
}

export function sha512(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("base64");
}

export interface RegistryState {
  published: boolean;
  latest: string | undefined;
}

export async function registryState(name: string, version: string, fetchImpl: typeof fetch = fetch): Promise<RegistryState> {
  const url = `${REGISTRY}/${name.replace("/", "%2f")}`;
  const res = await fetchImpl(url, { headers: { accept: "application/vnd.npm.install-v1+json" } });
  if (res.status === 404) return { published: false, latest: undefined };
  if (res.status !== 200) throw new Error(`the registry answered ${res.status} for ${name}`);
  const body = (await res.json()) as { versions?: Record<string, unknown>; "dist-tags"?: { latest?: unknown } };
  const latest = body["dist-tags"]?.latest;
  return { published: Object.hasOwn(body.versions ?? {}, version), latest: typeof latest === "string" ? latest : undefined };
}

export function publishArgs(tarballPath: string, dryRun: boolean): string[] {
  const args = ["publish", tarballPath, "--provenance", "--access", "public", "--ignore-scripts"];
  if (dryRun) args.push("--dry-run");
  return args;
}

export interface PublishDeps {
  state: (name: string, version: string) => Promise<RegistryState>;
  readTarball: (file: string) => Uint8Array;
  publish: (args: string[]) => void;
  log: (line: string) => void;
}

export async function runPlan(
  plan: ReleasePlan,
  planDir: string,
  dryRun: boolean,
  deps: PublishDeps,
): Promise<{ published: string[]; skipped: string[] }> {
  for (const p of plan.packages) {
    const actual = sha512(deps.readTarball(join(planDir, p.tarball)));
    if (actual !== p.sha512) throw new Error(`${p.name}: ${p.tarball} does not match the sha512 that the pack job recorded`);
  }
  const states: RegistryState[] = [];
  for (const p of plan.packages) {
    const state = await deps.state(p.name, p.version);
    if (!state.published && state.latest !== undefined && !versionAtLeast(p.version, state.latest)) {
      throw new Error(
        `${p.name}@${p.version} is lower than the registry's latest ${state.latest}, and a publish would move latest backwards. ` +
          "Publish it by hand with an explicit --tag, or leave it unpublished",
      );
    }
    states.push(state);
  }
  const published: string[] = [];
  const skipped: string[] = [];
  for (const [i, p] of plan.packages.entries()) {
    if (states[i]!.published) {
      deps.log(`skip     ${p.name}@${p.version} — the registry already holds it`);
      skipped.push(p.name);
      continue;
    }
    deps.log(`publish  ${p.name}@${p.version}${dryRun ? " (dry run)" : ""}`);
    deps.publish(publishArgs(join(planDir, p.tarball), dryRun));
    published.push(p.name);
  }
  return { published, skipped };
}

function gitHead(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const planFile = argValue(argv, "--plan");
  const dryRun = argv.includes("--dry-run");
  const tag = process.env.RELEASE_TAG ?? "";
  if (!planFile) {
    console.error("usage: RELEASE_TAG=v<version> node scripts/release-publish.ts --plan <dir>/plan.json [--dry-run]");
    process.exit(2);
  }

  const errors = checkRunContext(readRunContext(process.env), tag);
  const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
  if (!versionAtLeast(npmVersion, MIN_NPM_VERSION)) {
    errors.push(`npm ${npmVersion} is older than ${MIN_NPM_VERSION}, the floor for trusted publishing`);
  }
  let plan: ReleasePlan = { tag: "", commit: "", packages: [] };
  try {
    plan = JSON.parse(readFileSync(planFile, "utf8")) as ReleasePlan;
    errors.push(...checkPlan(plan, tag, gitHead()));
  } catch (err) {
    errors.push(`the plan ${planFile} is unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`✗ ${e}`);
    console.error("Nothing was published.");
    process.exit(1);
  }

  const result = await runPlan(plan, dirname(planFile), dryRun, {
    state: (name, version) => registryState(name, version),
    readTarball: (file) => readFileSync(file),
    publish: (args) => execFileSync("npm", args, { stdio: "inherit" }),
    log: (line) => console.log(line),
  });
  console.log(`✓ ${tag}: published ${result.published.length}, skipped ${result.skipped.length} already on npm.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    console.error("A package before this point may already be on npm. Run the workflow again with the same tag to finish.");
    process.exit(1);
  });
}

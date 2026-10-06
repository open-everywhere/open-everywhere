import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { posixJoin, toPosixPath } from "../../scripts/posix-path.js";

export const KEYED_TREE_PATHS: readonly string[] = [
  "agent",
  "packages",
  "package.json",
  "package-lock.json",
  "patches",
  "roster.config.ts",
  "roster.lock.json",
  "tsconfig.json",
];

export const CACHED_TREE_PATHS: readonly string[] = [".output", ".eve/sandbox-cache"];

export const CACHE_FORMAT = 3;

export const CACHE_BRANCH = "oe-it-cache/prepared-tree";

export const CACHE_ARCHIVE_NAME = "prepared-tree.tar.gz";

export const CACHE_KEY_NAME = "key";

export const CACHE_FETCH_REF = "refs/oe-it-cache/remote";

export const GIT_TRANSPORT_TIMEOUT_MS = 120_000;

export const STAMP_FILE = ".oe-it-prepared.json";

export function justBashTemplateDir(root: string): string {
  return join(root, ".eve", "sandbox-cache", "just-bash", "templates");
}

const JUST_BASH_TEMPLATES_RELPATH = toPosixPath(justBashTemplateDir(""));

export const PREPARED_ARTIFACTS: readonly string[] = [
  posixJoin(".output", "server", "index.mjs"),
  JUST_BASH_TEMPLATES_RELPATH,
  posixJoin("packages", "core", "dist"),
];

export interface CacheKeyHost {
  readonly lsTree: (paths: readonly string[]) => string;
  readonly dirtyPaths: (paths: readonly string[]) => readonly string[];
  readonly fingerprint: (path: string) => string;
  readonly eveVersion: () => string;
  readonly nodeMajor: () => string;
  readonly platform: () => string;
  readonly root: () => string;
}

export type CacheKeyVerdict =
  | { readonly kind: "key"; readonly key: string; readonly worktree: boolean }
  | { readonly kind: "refused"; readonly reason: string };

export function composeCacheKey(input: {
  readonly treeDigest: string;
  readonly eveVersion: string;
  readonly nodeMajor: string;
  readonly platform: string;
  readonly root: string;
  readonly worktree?: boolean;
}): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]/gu, "_");
  const rootDigest = createHash("sha256").update(input.root).digest("hex").slice(0, 8);
  return (
    `it-prepared-v${CACHE_FORMAT}-${input.treeDigest.slice(0, 16)}-eve${safe(input.eveVersion)}` +
    `-node${safe(input.nodeMajor)}-${safe(input.platform)}-at${rootDigest}${input.worktree === true ? "-wt" : ""}`
  );
}

export function parseDirtyPaths(raw: string): string[] {
  const records = raw.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (/[RC]/u.test(status)) {
      const original = records[i + 1];
      if (original !== undefined && original !== "") paths.push(original);
      i += 1;
    }
  }
  return paths;
}

export function prepareCacheKey(host: CacheKeyHost): CacheKeyVerdict {
  let dirty: readonly string[];
  try {
    dirty = host.dirtyPaths(KEYED_TREE_PATHS);
  } catch (err) {
    return { kind: "refused", reason: `git could not report whether the keyed paths are clean (${describe(err)})` };
  }
  let listing: string;
  try {
    listing = host.lsTree(KEYED_TREE_PATHS);
  } catch (err) {
    return { kind: "refused", reason: `git could not list the keyed paths (${describe(err)})` };
  }
  if (listing.trim() === "") return { kind: "refused", reason: "git listed no tracked file under the keyed paths" };
  let overlay = "";
  try {
    for (const path of [...new Set(dirty)].sort()) overlay += `${path}\t${host.fingerprint(path)}\n`;
  } catch (err) {
    return { kind: "refused", reason: `a working-tree file under the keyed paths could not be read (${describe(err)})` };
  }
  let eveVersion: string;
  let nodeMajor: string;
  let platform: string;
  let root: string;
  try {
    eveVersion = host.eveVersion();
    nodeMajor = host.nodeMajor();
    platform = host.platform();
    root = host.root();
  } catch (err) {
    return { kind: "refused", reason: `one of the eve version, the Node major, the platform or the root could not be read (${describe(err)})` };
  }
  if (eveVersion.trim() === "" || nodeMajor.trim() === "" || platform.trim() === "" || root.trim() === "") {
    return {
      kind: "refused",
      reason: "one of the eve version, the Node major, the platform or the root read as empty, and a key missing one would survive a change",
    };
  }
  const worktree = overlay !== "";
  const digest = createHash("sha256").update(listing);
  if (worktree) digest.update("\0worktree\0").update(overlay);
  const treeDigest = digest.digest("hex");
  return { kind: "key", key: composeCacheKey({ treeDigest, eveVersion, nodeMajor, platform, root, worktree }), worktree };
}

export function remoteCacheKey(verdict: CacheKeyVerdict): string | undefined {
  return verdict.kind === "key" && !verdict.worktree ? verdict.key : undefined;
}

export function preparedTreeState(input: {
  readonly key: string | undefined;
  readonly stampKey: string | undefined;
  readonly missingArtifacts: readonly string[];
}): "warm" | "cold" {
  if (input.key === undefined || input.stampKey === undefined) return "cold";
  if (input.key !== input.stampKey) return "cold";
  return input.missingArtifacts.length === 0 ? "warm" : "cold";
}

export function missingPreparedArtifacts(root: string, exists: (path: string) => boolean = existsSync): readonly string[] {
  return PREPARED_ARTIFACTS.filter((relative) => !exists(join(root, relative)));
}

export function readStamp(root: string): string | undefined {
  const path = join(root, STAMP_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { key?: unknown; format?: unknown };
    if (parsed.format !== CACHE_FORMAT) return undefined;
    return typeof parsed.key === "string" && parsed.key.length > 0 ? parsed.key : undefined;
  } catch {
    return undefined;
  }
}

export function writeStamp(root: string, key: string): void {
  writeFileSync(join(root, STAMP_FILE), `${JSON.stringify({ format: CACHE_FORMAT, key }, null, 2)}\n`);
}

export function clearStamp(root: string): void {
  rmSync(join(root, STAMP_FILE), { force: true });
}

export const BUILD_STAMP_FILE = ".oe-it-built.json";

export interface BuildStamp {
  readonly state: "building" | "built";
  readonly key: string;
}

export function readBuildStamp(root: string): BuildStamp | undefined {
  const path = join(root, BUILD_STAMP_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { format?: unknown; state?: unknown; key?: unknown };
    if (parsed.format !== CACHE_FORMAT) return undefined;
    if (parsed.state !== "building" && parsed.state !== "built") return undefined;
    return typeof parsed.key === "string" && parsed.key.length > 0 ? { state: parsed.state, key: parsed.key } : undefined;
  } catch {
    return undefined;
  }
}

function writeBuildStamp(root: string, stamp: BuildStamp): void {
  writeFileSync(join(root, BUILD_STAMP_FILE), `${JSON.stringify({ format: CACHE_FORMAT, ...stamp }, null, 2)}\n`);
}

export function clearBuildStamp(root: string): void {
  rmSync(join(root, BUILD_STAMP_FILE), { force: true });
}

export function beginBuildStamp(root: string, verdict: CacheKeyVerdict): string {
  clearBuildStamp(root);
  clearStamp(root);
  if (verdict.kind !== "key") return `no build stamp — ${verdict.reason}`;
  writeBuildStamp(root, { state: "building", key: verdict.key });
  return `building ${verdict.key}`;
}

export function finishBuildStamp(root: string, verdict: CacheKeyVerdict): string {
  const begun = readBuildStamp(root);
  if (begun?.state !== "building") {
    clearBuildStamp(root);
    return "no build stamp — `begin` recorded no key for this build";
  }
  if (verdict.kind !== "key" || verdict.key !== begun.key) {
    clearBuildStamp(root);
    return `no build stamp — the key moved during the build (${verdict.kind === "key" ? `now ${verdict.key}` : verdict.reason})`;
  }
  writeBuildStamp(root, { state: "built", key: verdict.key });
  return `built ${verdict.key}`;
}

export function gateBuiltBundle(input: {
  readonly state: "warm" | "cold";
  readonly stampsTrusted: boolean;
  readonly key: string | undefined;
  readonly stamp: BuildStamp | undefined;
  readonly bundlePresent: boolean;
}): boolean {
  if (input.state === "warm" || !input.stampsTrusted) return false;
  if (input.key === undefined || input.stamp === undefined) return false;
  return input.stamp.state === "built" && input.stamp.key === input.key && input.bundlePresent;
}

export function hostCacheKeyProbe(root: string): CacheKeyHost {
  const git = (args: readonly string[]): string =>
    execFileSync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_TRANSPORT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  return {
    lsTree: (paths) => git(["ls-tree", "-r", "HEAD", "--", ...paths]),
    dirtyPaths: (paths) => parseDirtyPaths(git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths])),
    fingerprint: (path) => worktreeFingerprint(root, path),
    eveVersion: () => (JSON.parse(readFileSync(join(root, "node_modules", "eve", "package.json"), "utf8")) as { version: string }).version,
    nodeMajor: () => process.versions.node.split(".")[0] ?? "",
    platform: () => process.platform,
    root: () => root,
  };
}

export function worktreeFingerprint(root: string, path: string): string {
  let stat;
  try {
    stat = lstatSync(join(root, path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw err;
  }
  if (!stat.isFile()) {
    throw new Error(
      `${path} is a ${stat.isSymbolicLink() ? "symlink" : "directory or other non-file"}, and the key reads only a regular file's bytes`,
    );
  }
  const executable = (stat.mode & 0o111) !== 0 ? "x" : "-";
  return `file ${executable} ${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] ?? err.name : String(err);
}

export type CacheMode = "local" | "remote" | "off";

export function cacheMode(env: NodeJS.ProcessEnv = process.env): CacheMode {
  const raw = (env.OE_IT_PREPARE_CACHE ?? "").trim().toLowerCase();
  if (raw === "off") return "off";
  if (raw === "remote" || raw === "on") return "remote";
  return "local";
}

export function stampCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return cacheMode(env) !== "off";
}

export function remoteRestoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return cacheMode(env) === "remote";
}

export function remoteCachePublishEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return remoteRestoreEnabled(env) && (env.OE_IT_PREPARE_CACHE_PUBLISH ?? "").trim() === "1";
}

export function cacheRemote(env: NodeJS.ProcessEnv = process.env): string {
  const named = (env.OE_IT_PREPARE_CACHE_REMOTE ?? "").trim();
  return named === "" ? "origin" : named;
}

export type RestoreOutcome =
  | { readonly kind: "restored"; readonly bytes: number }
  | { readonly kind: "miss"; readonly reason: string };

export function restorePreparedTree(input: { readonly root: string; readonly key: string; readonly remote: string }): RestoreOutcome {
  const { root, key, remote } = input;
  const git = (args: readonly string[]): Buffer =>
    execFileSync("git", [...args], {
      cwd: root,
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TRANSPORT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  try {
    git(["fetch", "--depth=1", remote, `+refs/heads/${CACHE_BRANCH}:${CACHE_FETCH_REF}`]);
  } catch (err) {
    return { kind: "miss", reason: `the cache branch ${CACHE_BRANCH} could not be fetched from ${remote} (${describe(err)})` };
  }
  let published: string;
  try {
    published = git(["cat-file", "blob", `${CACHE_FETCH_REF}:${CACHE_KEY_NAME}`]).toString("utf8").trim();
  } catch (err) {
    return { kind: "miss", reason: `the fetched cache commit carries no readable ${CACHE_KEY_NAME} (${describe(err)})` };
  }
  if (published !== key) return { kind: "miss", reason: `the published cache is for ${published}, not ${key}` };
  let archive: Buffer;
  try {
    archive = git(["cat-file", "blob", `${CACHE_FETCH_REF}:${CACHE_ARCHIVE_NAME}`]);
  } catch (err) {
    return { kind: "miss", reason: `the fetched cache commit carries no readable ${CACHE_ARCHIVE_NAME} (${describe(err)})` };
  }
  const archivePath = join(root, ".oe-it-prepare-restore.tar.gz");
  try {
    writeFileSync(archivePath, archive);
    for (const relative of CACHED_TREE_PATHS) rmSync(join(root, relative), { force: true, recursive: true });
    execFileSync("tar", ["-xzf", basename(archivePath), "-C", ".", "--", ...CACHED_TREE_PATHS], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_TRANSPORT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    return { kind: "miss", reason: `the cache archive could not be extracted (${describe(err)})` };
  } finally {
    rmSync(archivePath, { force: true });
  }
  const missing = CACHED_TREE_PATHS.filter((relative) => !existsSync(join(root, relative)));
  if (missing.length > 0) return { kind: "miss", reason: `the extracted archive is missing ${missing.join(", ")}` };
  return { kind: "restored", bytes: archive.byteLength };
}

export type PublishOutcome =
  | { readonly kind: "published"; readonly bytes: number }
  | { readonly kind: "skipped"; readonly reason: string };

export function publishPreparedTree(input: { readonly root: string; readonly key: string; readonly remote: string }): PublishOutcome {
  const { root, key, remote } = input;
  const git = (args: readonly string[], stdin?: Buffer): string =>
    execFileSync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      timeout: GIT_TRANSPORT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      ...(stdin === undefined ? {} : { input: stdin }),
    }).trim();
  const archivePath = join(root, ".oe-it-prepare-publish.tar.gz");
  try {
    execFileSync("tar", ["-czf", basename(archivePath), "-C", ".", ...CACHED_TREE_PATHS], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_TRANSPORT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const bytes = readFileSync(archivePath).byteLength;
    const archiveBlob = git(["hash-object", "-w", "--", archivePath]);
    const keyBlob = git(["hash-object", "-w", "--stdin"], Buffer.from(`${key}\n`, "utf8"));
    const tree = git(["mktree"], Buffer.from(`100644 blob ${keyBlob}\t${CACHE_KEY_NAME}\n100644 blob ${archiveBlob}\t${CACHE_ARCHIVE_NAME}\n`, "utf8"));
    const commit = git(["commit-tree", tree, "-m", `integration prepare cache ${key}`]);
    git(["push", "--quiet", remote, `+${commit}:refs/heads/${CACHE_BRANCH}`]);
    return { kind: "published", bytes };
  } catch (err) {
    return { kind: "skipped", reason: `the cache could not be published to ${remote} (${describe(err)})` };
  } finally {
    rmSync(archivePath, { force: true });
  }
}

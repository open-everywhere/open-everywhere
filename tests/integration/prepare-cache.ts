import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

const JUST_BASH_TEMPLATES_RELPATH = justBashTemplateDir("");

export const PREPARED_ARTIFACTS: readonly string[] = [
  join(".output", "server", "index.mjs"),
  JUST_BASH_TEMPLATES_RELPATH,
  join("packages", "core", "dist"),
];

export interface CacheKeyHost {
  readonly lsTree: (paths: readonly string[]) => string;
  readonly porcelain: (paths: readonly string[]) => string;
  readonly eveVersion: () => string;
  readonly nodeMajor: () => string;
  readonly platform: () => string;
  readonly root: () => string;
}

export type CacheKeyVerdict = { readonly kind: "key"; readonly key: string } | { readonly kind: "refused"; readonly reason: string };

export function composeCacheKey(input: {
  readonly treeDigest: string;
  readonly eveVersion: string;
  readonly nodeMajor: string;
  readonly platform: string;
  readonly root: string;
}): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]/gu, "_");
  const rootDigest = createHash("sha256").update(input.root).digest("hex").slice(0, 8);
  return (
    `it-prepared-v${CACHE_FORMAT}-${input.treeDigest.slice(0, 16)}-eve${safe(input.eveVersion)}` +
    `-node${safe(input.nodeMajor)}-${safe(input.platform)}-at${rootDigest}`
  );
}

export function prepareCacheKey(host: CacheKeyHost): CacheKeyVerdict {
  let dirty: string;
  try {
    dirty = host.porcelain(KEYED_TREE_PATHS);
  } catch (err) {
    return { kind: "refused", reason: `git could not report whether the keyed paths are clean (${describe(err)})` };
  }
  if (dirty.trim() !== "") {
    const first = dirty.trim().split("\n")[0] ?? "";
    return {
      kind: "refused",
      reason:
        `the working tree carries uncommitted changes under ${KEYED_TREE_PATHS.join(", ")} (for example "${first.trim()}"), ` +
        "and the key is read from the COMMIT — a key for the committed state would serve a bundle this tree did not build",
    };
  }
  let listing: string;
  try {
    listing = host.lsTree(KEYED_TREE_PATHS);
  } catch (err) {
    return { kind: "refused", reason: `git could not list the keyed paths (${describe(err)})` };
  }
  if (listing.trim() === "") return { kind: "refused", reason: "git listed no tracked file under the keyed paths" };
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
  const treeDigest = createHash("sha256").update(listing).digest("hex");
  return { kind: "key", key: composeCacheKey({ treeDigest, eveVersion, nodeMajor, platform, root }) };
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
    porcelain: (paths) => git(["status", "--porcelain", "--", ...paths]),
    eveVersion: () => (JSON.parse(readFileSync(join(root, "node_modules", "eve", "package.json"), "utf8")) as { version: string }).version,
    nodeMajor: () => process.versions.node.split(".")[0] ?? "",
    platform: () => process.platform,
    root: () => root,
  };
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
    execFileSync("tar", ["-xzf", archivePath, "-C", root, "--", ...CACHED_TREE_PATHS], {
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
    execFileSync("tar", ["-czf", archivePath, "-C", root, ...CACHED_TREE_PATHS], {
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

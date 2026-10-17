import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { npmCommand, npxCommand } from "../../scripts/npm-command.js";
import { PREPARED_PGLITE_TEMPLATE_PARENT } from "./global-setup-contract.js";
import { mintPgliteTemplate } from "./pglite-template.js";
import {
  PREPARED_ARTIFACTS,
  cacheMode,
  clearBuildStamp,
  clearStamp,
  gateBuiltBundle,
  readBuildStamp,
  cacheRemote,
  hostCacheKeyProbe,
  missingPreparedArtifacts,
  prepareCacheKey,
  preparedTreeState,
  publishPreparedTree,
  readStamp,
  remoteCacheKey,
  remoteCachePublishEnabled,
  remoteRestoreEnabled,
  stampCacheEnabled,
  restorePreparedTree,
  writeStamp,
  type CacheKeyHost,
} from "./prepare-cache.js";
import { prewarmJustBashTemplate, type PrewarmResult, type PrewarmVia } from "./prewarm.js";
import { createStateDir } from "./state-dir.js";

export const IT_SKIP_BUILD_ENV = "OE_IT_SKIP_BUILD";

export type PrepareMode = "warm" | "restored" | "built" | "cold" | "skip-build";

export interface PrepareReport {
  readonly mode: PrepareMode;
  readonly fixedSetupSeconds: number;
  readonly oeBuildSeconds: number;
  readonly eveBuildSeconds: number;
  readonly prewarmSeconds: number;
  readonly prewarmVia?: PrewarmVia;
  readonly pgliteMintSeconds: number;
  readonly key?: string;
  readonly cacheNote: string;
}

export const PREPARE_INSIDE_VITEST_MESSAGE =
  "integration prepare: this step must not run inside a vitest process — its prewarm holds the built app graph " +
  "(3 549 MB measured) and starts a listening server, which is the residue OPE-2235 hoisted OUT of the vitest main " +
  "process. Run `npm run test:integration:prepare` as its own process, or let scripts/suite-lock-run.ts run it.";

export function skipBuildRefusal(missing: readonly string[]): string {
  return (
    `integration prepare: ${IT_SKIP_BUILD_ENV}=1 but this tree is missing ${missing.join(", ")}. ` +
    "Every turn would then die on SandboxTemplateNotProvisionedError or a bare ERR_MODULE_NOT_FOUND, naming neither the " +
    `flag nor the remedy. Run \`npm run test:integration:prepare\` once without ${IT_SKIP_BUILD_ENV}.`
  );
}

function seconds(fromMs: number): number {
  return (Date.now() - fromMs) / 1000;
}

function runOeBuild(root: string): void {
  const [npm, npmArgs] = npmCommand(["run", "oe:build"]);
  execFileSync(npm, npmArgs, { cwd: root, stdio: "inherit" });
}

function runEveBuild(root: string): void {
  const inherited = process.env.NODE_OPTIONS ?? "";
  const nodeOptions = inherited.includes("--max-old-space-size") ? inherited : [inherited, "--max-old-space-size=6144"].filter(Boolean).join(" ");
  const [npx, npxArgs] = npxCommand(["eve", "build"]);
  execFileSync(npx, npxArgs, { cwd: root, stdio: "inherit", env: { ...process.env, NODE_OPTIONS: nodeOptions, EVE_TELEMETRY_DISABLED: "1" } });
}

async function mintTemplateForShards(root: string): Promise<string> {
  const parent = resolve(root, PREPARED_PGLITE_TEMPLATE_PARENT);
  const inside = relative(resolve(root), parent);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(
      `integration prepare: PREPARED_PGLITE_TEMPLATE_PARENT is ${JSON.stringify(PREPARED_PGLITE_TEMPLATE_PARENT)}, which ` +
        `resolves to ${parent} — not a directory strictly inside the repository root. Refusing to clear it. ` +
        "Fix the constant in tests/integration/global-setup-contract.ts.",
    );
  }
  rmSync(parent, { force: true, recursive: true });
  mkdirSync(parent, { recursive: true });
  return await mintPgliteTemplate(parent);
}

export interface PrepareLegs {
  readonly oeBuild: (root: string) => void;
  readonly eveBuild: (root: string) => void;
  readonly prewarm: (root: string, log: (message: string) => void) => Promise<PrewarmResult>;
  readonly mint: (root: string) => Promise<string>;
}

const HOST_PREPARE_LEGS: PrepareLegs = {
  oeBuild: runOeBuild,
  eveBuild: runEveBuild,
  prewarm: async (root, log) => {
    return await prewarmJustBashTemplate(root, createStateDir(), log);
  },
  mint: mintTemplateForShards,
};

export async function prepareIntegrationTree(
  options: {
    readonly root?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly log?: (message: string) => void;
    readonly legs?: PrepareLegs;
  } = {},
): Promise<PrepareReport> {
  const root = options.root ?? process.cwd();
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.log(message));
  const legs = options.legs ?? HOST_PREPARE_LEGS;
  if (env.VITEST !== undefined) throw new Error(PREPARE_INSIDE_VITEST_MESSAGE);
  const startedAt = Date.now();

  let oeBuildSeconds = 0;
  let eveBuildSeconds = 0;
  let prewarmSeconds = 0;
  let prewarmVia: PrewarmVia | undefined;
  let mode: PrepareMode;
  let key: string | undefined;
  let cacheNote: string;

  if (env[IT_SKIP_BUILD_ENV] === "1") {
    const missing = missingPreparedArtifacts(root);
    if (missing.length > 0) throw new Error(skipBuildRefusal(missing));
    mode = "skip-build";
    cacheNote = `off (${IT_SKIP_BUILD_ENV}=1)`;
  } else {
    const verdict = prepareCacheKey(hostCacheKeyProbe(root));
    key = verdict.kind === "key" ? verdict.key : undefined;
    const remoteKey = remoteCacheKey(verdict);
    const state = preparedTreeState({
      key,
      stampKey: stampCacheEnabled(env) ? readStamp(root) : undefined,
      missingArtifacts: missingPreparedArtifacts(root),
    });
    const gateBuilt = gateBuiltBundle({
      state,
      stampsTrusted: stampCacheEnabled(env),
      key,
      stamp: readBuildStamp(root),
      bundlePresent: existsSync(join(root, ".output", "server", "index.mjs")),
    });
    if (state !== "warm") clearStamp(root);
    if (!gateBuilt && state !== "warm" && remoteKey !== undefined && remoteRestoreEnabled(env)) clearBuildStamp(root);
    const restore =
      state === "warm" || gateBuilt || remoteKey === undefined || !remoteRestoreEnabled(env)
        ? undefined
        : restorePreparedTree({ root, key: remoteKey, remote: cacheRemote(env) });
    if (state === "warm") {
      mode = "warm";
      cacheNote = "hit (this tree, by stamp)";
    } else if (gateBuilt) {
      mode = "built";
      cacheNote = "eve build reused (the `build` gate's bundle, by build stamp)";
    } else if (restore?.kind === "restored") {
      mode = "restored";
      cacheNote = `hit (${cacheRemote(env)}, ${(restore.bytes / 1048576).toFixed(1)} MB)`;
    } else {
      mode = "cold";
      cacheNote =
        verdict.kind === "refused"
          ? `no key — ${verdict.reason}`
          : restore === undefined
            ? verdict.worktree && remoteRestoreEnabled(env)
              ? "the key reads uncommitted edits, so no remote lookup"
              : `${cacheMode(env)} (OE_IT_PREPARE_CACHE), so no remote lookup`
            : `miss — ${restore.reason}`;
    }
    const oeStartedAt = Date.now();
    legs.oeBuild(root);
    oeBuildSeconds = seconds(oeStartedAt);
    if (mode === "cold" || mode === "built") {
      if (mode === "cold") {
        clearBuildStamp(root);
        const eveStartedAt = Date.now();
        legs.eveBuild(root);
        eveBuildSeconds = seconds(eveStartedAt);
      }
      const prewarm = await legs.prewarm(root, log);
      prewarmSeconds = prewarm.seconds;
      prewarmVia = prewarm.via;
    }
    const stillMissing = missingPreparedArtifacts(root);
    if (stillMissing.length > 0) {
      throw new Error(
        `integration prepare: the build finished but this tree is still missing ${stillMissing.join(", ")}. ` +
          `Every one of ${PREPARED_ARTIFACTS.join(", ")} must exist before a fork can boot.`,
      );
    }
    if (key !== undefined) {
      const settled = prepareCacheKey(hostCacheKeyProbe(root));
      if (settled.kind === "key" && settled.key === key) {
        writeStamp(root, key);
      } else {
        log(
          "integration prepare: the cache key changed while this step ran, so no stamp is written and the next run builds — " +
            (settled.kind === "key" ? `it is now ${settled.key}, not ${key}` : settled.reason) +
            ".",
        );
      }
    }
    if ((mode === "cold" || mode === "built") && remoteKey !== undefined && remoteCachePublishEnabled(env)) {
      const publishKey = republishKey(root, remoteKey, log);
      if (publishKey !== undefined) {
        const published = publishPreparedTree({ root, key: publishKey, remote: cacheRemote(env) });
        cacheNote =
          published.kind === "published"
            ? `${cacheNote}; published ${(published.bytes / 1048576).toFixed(1)} MB`
            : `${cacheNote}; publish skipped — ${published.reason}`;
      } else {
        cacheNote = `${cacheNote}; publish skipped — the key moved while this step ran`;
      }
    }
  }

  const mintStartedAt = Date.now();
  const template = await legs.mint(root);
  const pgliteMintSeconds = seconds(mintStartedAt);

  const report: PrepareReport = {
    mode,
    fixedSetupSeconds: seconds(startedAt),
    oeBuildSeconds,
    eveBuildSeconds,
    prewarmSeconds,
    ...(prewarmVia === undefined ? {} : { prewarmVia }),
    pgliteMintSeconds,
    ...(key === undefined ? {} : { key }),
    cacheNote,
  };
  log(formatPrepareReport(report, template));
  return report;
}

export function republishKey(root: string, key: string, log: (message: string) => void, probe: CacheKeyHost = hostCacheKeyProbe(root)): string | undefined {
  const again = prepareCacheKey(probe);
  if (again.kind === "key" && again.key === key) return key;
  log(
    "integration prepare: the cache key changed while this step ran, so nothing is published — " +
      (again.kind === "key" ? `it is now ${again.key}, not ${key}` : again.reason) +
      ". A build step that rewrites a tracked generated file does this.",
  );
  return undefined;
}

export function formatPrepareReport(report: PrepareReport, templateDir: string): string {
  const fixed = (value: number): string => value.toFixed(1);
  return (
    `integration prepare: mode=${report.mode} fixed-setup=${fixed(report.fixedSetupSeconds)}s ` +
    `oe:build=${fixed(report.oeBuildSeconds)}s eve-build=${fixed(report.eveBuildSeconds)}s ` +
    `prewarm=${fixed(report.prewarmSeconds)}s${report.prewarmVia === undefined ? "" : `(${report.prewarmVia})`} ` +
    `pglite-mint=${fixed(report.pgliteMintSeconds)}s cache=[${report.cacheNote}] key=${report.key ?? "none"} ` +
    `template=${templateDir}`
  );
}

async function main(): Promise<void> {
  try {
    await prepareIntegrationTree();
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

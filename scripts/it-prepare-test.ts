import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BUILD_STAMP_FILE,
  CACHED_TREE_PATHS,
  CACHE_ARCHIVE_NAME,
  CACHE_BRANCH,
  CACHE_FORMAT,
  GIT_TRANSPORT_TIMEOUT_MS,
  KEYED_TREE_PATHS,
  PREPARED_ARTIFACTS,
  beginBuildStamp,
  cacheRemote,
  composeCacheKey,
  finishBuildStamp,
  gateBuiltBundle,
  hostCacheKeyProbe,
  missingPreparedArtifacts,
  prepareCacheKey,
  preparedTreeState,
  publishPreparedTree,
  cacheMode,
  readBuildStamp,
  readStamp,
  remoteCachePublishEnabled,
  remoteRestoreEnabled,
  restorePreparedTree,
  stampCacheEnabled,
  writeStamp,
  type CacheKeyHost,
} from "../tests/integration/prepare-cache.js";
import {
  IT_SKIP_BUILD_ENV,
  PREPARE_INSIDE_VITEST_MESSAGE,
  formatPrepareReport,
  prepareIntegrationTree,
  republishKey,
  skipBuildRefusal,
} from "../tests/integration/prepare.js";
import { PREPARED_PGLITE_TEMPLATE_PARENT } from "../tests/integration/global-setup-contract.js";
import { unpreparedTreeRefusal } from "../tests/integration/global-setup.js";
import { loadFastPathSymbols } from "../tests/integration/prewarm.js";
import { runBuildStamp } from "./eve-build-stamp.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures: string[] = [];

function test(name: string, body: () => void | Promise<void>): Promise<void> {
  const done = (err: unknown): void => {
    if (err === undefined) {
      console.log(`  ok  ${name}`);
      return;
    }
    failures.push(name);
    console.error(`  FAIL ${name}`);
    console.error(`       ${err instanceof Error ? err.message : String(err)}`);
  };
  try {
    const result = body();
    if (result instanceof Promise) return result.then(() => done(undefined), done);
    done(undefined);
  } catch (err) {
    done(err);
  }
  return Promise.resolve();
}

function host(overrides: Partial<CacheKeyHost> = {}): CacheKeyHost {
  return {
    lsTree: () => "100644 blob 1111111111111111111111111111111111111111\tagent/agent.ts\n",
    porcelain: () => "",
    eveVersion: () => "0.54.3",
    nodeMajor: () => "24",
    platform: () => "linux",
    root: () => "/repo",
    ...overrides,
  };
}

const scratch = mkdtempSync(join(tmpdir(), "oe-it-prepare-test-"));

await test("the POSITIVE control — a clean tree gets a key, so the refusals below are not vacuous", () => {
  const verdict = prepareCacheKey(host());
  assert.equal(verdict.kind, "key");
  assert.match(verdict.kind === "key" ? verdict.key : "", /^it-prepared-v\d+-[0-9a-f]{16}-eve0\.54\.3-node24-linux-at[0-9a-f]{8}$/u);
});

await test("🔴 an uncommitted edit under a keyed path REFUSES a key — the key is read from the commit", () => {
  const verdict = prepareCacheKey(host({ porcelain: () => " M packages/core/agent/operational/postgres.ts\n" }));
  assert.equal(verdict.kind, "refused");
  assert.match(verdict.kind === "refused" ? verdict.reason : "", /uncommitted/u);
  for (const path of KEYED_TREE_PATHS) assert.ok((verdict.kind === "refused" ? verdict.reason : "").includes(path), `names ${path}`);
});

await test("an UNTRACKED file under a keyed path refuses too — a new module is not in HEAD's tree", () => {
  assert.equal(prepareCacheKey(host({ porcelain: () => "?? agent/channels/new-channel.ts\n" })).kind, "refused");
});

await test("a git read that THROWS refuses rather than keying on nothing", () => {
  const thrower = (): never => {
    throw new Error("fatal: not a git repository");
  };
  assert.equal(prepareCacheKey(host({ porcelain: thrower })).kind, "refused");
  assert.equal(prepareCacheKey(host({ lsTree: thrower })).kind, "refused");
  assert.equal(prepareCacheKey(host({ eveVersion: thrower })).kind, "refused");
});

await test("an EMPTY tree listing refuses — a digest of nothing would match every other empty read", () => {
  assert.equal(prepareCacheKey(host({ lsTree: () => "   \n" })).kind, "refused");
});

await test("an empty eve version or Node major refuses — a key without either would survive a bump", () => {
  assert.equal(prepareCacheKey(host({ eveVersion: () => "" })).kind, "refused");
  assert.equal(prepareCacheKey(host({ nodeMajor: () => "" })).kind, "refused");
  assert.equal(prepareCacheKey(host({ platform: () => "" })).kind, "refused");
  assert.equal(prepareCacheKey(host({ root: () => "  " })).kind, "refused");
});

await test("🔴 the key covers every build input, including the four a first draft left out", () => {
  for (const path of ["agent", "packages", "package.json", "package-lock.json", "patches", "roster.config.ts", "roster.lock.json", "tsconfig.json"]) {
    assert.ok(KEYED_TREE_PATHS.includes(path), `${path} is a build input and must be in the key`);
  }
  assert.equal(KEYED_TREE_PATHS.length, 8, "…and nothing was dropped while adding one");
  for (const generated of ["agent/tools", "agent/channels", "agent/lib/providers.generated.ts"]) {
    assert.ok(!KEYED_TREE_PATHS.includes(generated), `${generated} is gitignored, so it is keyed transitively and never named`);
  }
});

await test("🔴 the key MOVES when any keyed input moves — the whole point of the key", () => {
  const base = prepareCacheKey(host());
  const keyOf = (verdict: ReturnType<typeof prepareCacheKey>): string => (verdict.kind === "key" ? verdict.key : "refused");
  const content = prepareCacheKey(host({ lsTree: () => "100644 blob 2222222222222222222222222222222222222222\tagent/agent.ts\n" }));
  const eve = prepareCacheKey(host({ eveVersion: () => "0.55.0" }));
  const node = prepareCacheKey(host({ nodeMajor: () => "26" }));
  const platform = prepareCacheKey(host({ platform: () => "darwin" }));
  const root = prepareCacheKey(host({ root: () => "/elsewhere/repo" }));
  const keys = new Set([keyOf(base), keyOf(content), keyOf(eve), keyOf(node), keyOf(platform), keyOf(root)]);
  assert.equal(keys.size, 6, "the tree digest, the eve version, the Node major, the platform and the checkout path each change the key");
});

await test("the key spelling is URL-and-filename safe — it is written into a file and compared by string", () => {
  assert.match(
    composeCacheKey({ treeDigest: "a".repeat(64), eveVersion: "0.54.3-beta.1+x/y", nodeMajor: "24", platform: "win32", root: "C:\\Users\\a b\\oe" }),
    /^[A-Za-z0-9._-]+$/u,
  );
});

await test("🔴 a tree is WARM only when the key, the stamp and every artefact agree", () => {
  assert.equal(preparedTreeState({ key: "k", stampKey: "k", missingArtifacts: [] }), "warm");
  assert.equal(preparedTreeState({ key: undefined, stampKey: "k", missingArtifacts: [] }), "cold", "no key (a dirty tree) is never warm");
  assert.equal(preparedTreeState({ key: "k", stampKey: undefined, missingArtifacts: [] }), "cold", "a tree with no stamp is never warm");
  assert.equal(preparedTreeState({ key: "k", stampKey: "other", missingArtifacts: [] }), "cold", "a stamp from another key is never warm");
  assert.equal(preparedTreeState({ key: "k", stampKey: "k", missingArtifacts: [".output/server/index.mjs"] }), "cold", "a missing artefact is never warm");
});

await test("the stamp round-trips, and an unreadable or older-format stamp reads as absent", () => {
  const root = mkdtempSync(join(scratch, "stamp-"));
  assert.equal(readStamp(root), undefined, "no stamp file");
  writeStamp(root, "it-prepared-v1-deadbeefdeadbeef-eve0.54.3-node24");
  assert.equal(readStamp(root), "it-prepared-v1-deadbeefdeadbeef-eve0.54.3-node24");
  writeFileSync(join(root, ".oe-it-prepared.json"), "{not json");
  assert.equal(readStamp(root), undefined, "an unparseable stamp must rebuild, never read as a hit");
  writeFileSync(join(root, ".oe-it-prepared.json"), JSON.stringify({ format: CACHE_FORMAT + 1, key: "k" }));
  assert.equal(readStamp(root), undefined, "a stamp from another artefact shape must rebuild");
});

await test("🔴 the build stamp vouches for the gate's bundle ONLY when begin and end agree and the key still matches", () => {
  const root = mkdtempSync(join(scratch, "build-stamp-"));
  const key = { kind: "key", key: "it-prepared-v3-aaaa" } as const;
  const trusted = { state: "cold", stampsTrusted: true } as const;
  writeStamp(root, "it-prepared-v3-old");
  writeFileSync(join(root, BUILD_STAMP_FILE), JSON.stringify({ format: CACHE_FORMAT, state: "built", key: "it-prepared-v3-old" }));
  beginBuildStamp(root, key);
  assert.equal(readStamp(root), undefined, "begin deletes the PREPARE stamp: its prewarm came from the bundle being replaced");
  assert.deepEqual(readBuildStamp(root), { state: "building", key: key.key }, "begin replaces an old `built` stamp with `building`");
  assert.equal(gateBuiltBundle({ ...trusted, key: key.key, stamp: readBuildStamp(root), bundlePresent: true }), false, "a build that never ended vouches for nothing");
  finishBuildStamp(root, key);
  assert.deepEqual(readBuildStamp(root), { state: "built", key: key.key }, "end with the same key marks it built");
  assert.equal(gateBuiltBundle({ ...trusted, key: key.key, stamp: readBuildStamp(root), bundlePresent: true }), true, "the POSITIVE control: a finished build under this key is reused");
  assert.equal(gateBuiltBundle({ ...trusted, key: "it-prepared-v3-bbbb", stamp: readBuildStamp(root), bundlePresent: true }), false, "another key is never reused");
  assert.equal(gateBuiltBundle({ ...trusted, key: undefined, stamp: readBuildStamp(root), bundlePresent: true }), false, "no key (a dirty tree) is never reused");
  assert.equal(gateBuiltBundle({ ...trusted, key: key.key, stamp: readBuildStamp(root), bundlePresent: false }), false, "a missing bundle is never reused");
  assert.equal(gateBuiltBundle({ ...trusted, key: key.key, stamp: undefined, bundlePresent: true }), false, "no stamp is never reused");
  assert.equal(
    gateBuiltBundle({ state: "cold", stampsTrusted: false, key: key.key, stamp: readBuildStamp(root), bundlePresent: true }),
    false,
    "🔴 OE_IT_PREPARE_CACHE=off ignores the build stamp: a cold measurement or a beyond-question proof run builds eve",
  );
  assert.equal(
    gateBuiltBundle({ state: "warm", stampsTrusted: true, key: key.key, stamp: readBuildStamp(root), bundlePresent: true }),
    false,
    "a WARM tree takes the warm path, which skips the prewarm too",
  );

  beginBuildStamp(root, key);
  finishBuildStamp(root, { kind: "key", key: "it-prepared-v3-moved" });
  assert.equal(readBuildStamp(root), undefined, "🔴 a key that MOVED during the build leaves no stamp");
  beginBuildStamp(root, key);
  finishBuildStamp(root, { kind: "refused", reason: "dirty" });
  assert.equal(readBuildStamp(root), undefined, "🔴 a key REFUSED at the end leaves no stamp");
  beginBuildStamp(root, { kind: "refused", reason: "dirty" });
  assert.equal(readBuildStamp(root), undefined, "a refused key at begin writes no stamp");
  finishBuildStamp(root, key);
  assert.equal(readBuildStamp(root), undefined, "and an end with no begun stamp writes none");
  writeFileSync(join(root, BUILD_STAMP_FILE), "{not json");
  assert.equal(readBuildStamp(root), undefined, "an unparseable build stamp reads as absent");
  writeFileSync(join(root, BUILD_STAMP_FILE), JSON.stringify({ format: CACHE_FORMAT + 1, state: "built", key: "k" }));
  assert.equal(readBuildStamp(root), undefined, "a build stamp from another format reads as absent");
});

await test("🔴 REAL GIT: the gate's stamp goes STALE the moment the tree changes after the build", () => {
  const root = join(scratch, "build-stamp-git");
  gitRepoFixture(root);
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "node_modules", "eve"), { recursive: true });
  writeFileSync(join(root, "node_modules", "eve", "package.json"), '{"version":"0.0.0-fixture"}\n');
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.oe-it-built.json\n");
  writeFileSync(join(root, "agent", "agent.ts"), "export const a = 1;\n");
  const git = (...args: string[]): void => void execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  const keyNow = (): string | undefined => {
    const verdict = prepareCacheKey(hostCacheKeyProbe(root));
    return verdict.kind === "key" ? verdict.key : undefined;
  };
  const trusted = { state: "cold", stampsTrusted: true } as const;
  const reused = (): boolean => gateBuiltBundle({ ...trusted, key: keyNow(), stamp: readBuildStamp(root), bundlePresent: true });

  assert.match(runBuildStamp("begin", root), /^building /u);
  assert.match(runBuildStamp("end", root), /^built /u);
  assert.equal(reused(), true, "the POSITIVE control: right after the gate, the prepare step reuses its bundle");

  writeFileSync(join(root, "agent", "agent.ts"), "export const a = 2;\n");
  assert.equal(reused(), false, "🔴 an UNCOMMITTED keyed edit after the build makes the stamp stale");
  git("commit", "--quiet", "-am", "edit");
  assert.equal(reused(), false, "🔴 and so does the same edit COMMITTED");

  assert.match(runBuildStamp("begin", root), /^building /u);
  writeFileSync(join(root, "agent", "agent.ts"), "export const a = 3;\n");
  assert.match(runBuildStamp("end", root), /^no build stamp — the key moved/u, "🔴 a keyed edit DURING the build leaves no stamp");
  assert.equal(reused(), false);
  assert.throws(() => runBuildStamp("finish", root), /"begin" or "end"/u, "an unknown phase is refused by name");
});

await test("🔴 the artefact paths are the LITERAL ones a fork needs, not whatever a derivation produced", () => {
  assert.deepEqual(
    [...PREPARED_ARTIFACTS],
    [".output/server/index.mjs", ".eve/sandbox-cache/just-bash/templates", "packages/core/dist"],
    "these three are what a fork opens: the served bundle, the just-bash template store and the built core dist",
  );
  assert.equal(PREPARED_PGLITE_TEMPLATE_PARENT, ".oe-it-prepare");
});

await test("the artefact check names every path a fork needs, and reports the ones that are absent", () => {
  const root = mkdtempSync(join(scratch, "artefacts-"));
  assert.deepEqual([...missingPreparedArtifacts(root)], [...PREPARED_ARTIFACTS], "an empty tree is missing all of them");
  for (const relative of PREPARED_ARTIFACTS) mkdirSync(join(root, relative), { recursive: true });
  assert.deepEqual([...missingPreparedArtifacts(root)], [], "a tree holding all of them is missing none");
  rmSync(join(root, PREPARED_ARTIFACTS[1] as string), { recursive: true });
  assert.deepEqual([...missingPreparedArtifacts(root)], [PREPARED_ARTIFACTS[1]], "and it names which one");
});

await test("🔴 the prepare step REFUSES to run inside a vitest process — that residue is what it removes", async () => {
  await assert.rejects(() => prepareIntegrationTree({ root: repoRoot, env: { VITEST: "true" }, log: () => {} }), (err: Error) => {
    assert.equal(err.message, PREPARE_INSIDE_VITEST_MESSAGE);
    return true;
  });
});

await test("🔴 an unprepared tree is refused by NAME, with the remedy — both refusals", () => {
  const setup = unpreparedTreeRefusal([".output/server/index.mjs"]);
  assert.ok(setup.includes("npm run test:integration:prepare"), "the global setup names the prepare step");
  assert.ok(setup.includes("npm run test:integration"), "…and the caller that runs it for you");
  assert.ok(setup.includes(".output/server/index.mjs"), "…and what is missing");
  for (const artefact of PREPARED_ARTIFACTS) assert.ok(setup.includes(artefact), `…and the whole required set (${artefact})`);
});

await test("🔴 OE_IT_SKIP_BUILD=1 on an unprepared tree refuses by NAME, with the remedy", async () => {
  const root = mkdtempSync(join(scratch, "skip-build-"));
  await assert.rejects(() => prepareIntegrationTree({ root, env: { [IT_SKIP_BUILD_ENV]: "1" }, log: () => {} }), (err: Error) => {
    assert.ok(err.message.includes(`${IT_SKIP_BUILD_ENV}=1`), "names the flag");
    assert.ok(err.message.includes("npm run test:integration:prepare"), "names the remedy");
    assert.ok(err.message.includes(".output/server/index.mjs"), "names what is missing");
    return true;
  });
  assert.ok(skipBuildRefusal([".output/server/index.mjs"]).includes("SandboxTemplateNotProvisionedError"));
});

await test("the receipt line carries the mode, the fixed setup, the cache note and the key", () => {
  const line = formatPrepareReport(
    {
      mode: "restored",
      fixedSetupSeconds: 17.25,
      oeBuildSeconds: 12.1,
      eveBuildSeconds: 0,
      prewarmSeconds: 0,
      pgliteMintSeconds: 3.9,
      key: "it-prepared-v1-deadbeefdeadbeef-eve0.54.3-node24",
      cacheNote: "hit (origin, 8.2 MB)",
    },
    "/repo/.oe-it-prepare/pglite-template",
  );
  assert.match(line, /mode=restored/u);
  assert.match(line, /fixed-setup=17\.3s/u);
  assert.match(line, /cache=\[hit \(origin, 8\.2 MB\)\]/u);
  assert.match(line, /key=it-prepared-v1-deadbeefdeadbeef-eve0\.54\.3-node24/u);
});

await test("🔴 a key that MOVED during the build publishes nothing, and says why", () => {
  const lines: string[] = [];
  const log = (m: string): void => void lines.push(m);
  const stable = prepareCacheKey(host());
  const key = stable.kind === "key" ? stable.key : "";
  assert.equal(republishKey("/repo", key, log, host()), key, "an unchanged key publishes under itself");
  assert.equal(lines.length, 0, "…and says nothing");
  assert.equal(republishKey("/repo", key, log, host({ porcelain: () => " M packages/core/agent/docs/generated/extending.ts\n" })), undefined);
  assert.equal(republishKey("/repo", key, log, host({ lsTree: () => "100644 blob 3333333333333333333333333333333333333333\tagent/agent.ts\n" })), undefined);
  assert.equal(lines.length, 2, "each refusal is announced, so a run that published nothing says so");
  assert.ok(lines.every((l) => l.includes("nothing is published")), `…and names the consequence — got ${JSON.stringify(lines)}`);
});

await test("🔴 the cache has THREE postures, the remote half is opt-in, and `off` means cold", () => {
  assert.equal(cacheMode({}), "local", "unset is the stamp only — no network, nothing to trust but this tree");
  assert.equal(cacheMode({ OE_IT_PREPARE_CACHE: "remote" }), "remote");
  assert.equal(cacheMode({ OE_IT_PREPARE_CACHE: "ON" }), "remote", "the switch is case-insensitive and takes `on` as `remote`");
  assert.equal(cacheMode({ OE_IT_PREPARE_CACHE: "off" }), "off");
  assert.equal(cacheMode({ OE_IT_PREPARE_CACHE: "nonsense" }), "local", "an unreadable value takes the safe default, never the remote");

  assert.equal(remoteRestoreEnabled({}), false, "the remote restore is opt-in");
  assert.equal(remoteRestoreEnabled({ OE_IT_PREPARE_CACHE: "remote" }), true);
  assert.equal(remoteCachePublishEnabled({ OE_IT_PREPARE_CACHE_PUBLISH: "1" }), false, "publishing needs the remote posture as well as the flag");
  assert.equal(remoteCachePublishEnabled({ OE_IT_PREPARE_CACHE: "remote", OE_IT_PREPARE_CACHE_PUBLISH: "1" }), true);
  assert.equal(remoteCachePublishEnabled({ OE_IT_PREPARE_CACHE: "off", OE_IT_PREPARE_CACHE_PUBLISH: "1" }), false, "off means off for both halves");

  assert.equal(stampCacheEnabled({}), true);
  assert.equal(stampCacheEnabled({ OE_IT_PREPARE_CACHE: "remote" }), true);
  assert.equal(stampCacheEnabled({ OE_IT_PREPARE_CACHE: "off" }), false, "`off` is a real cold build, not `cold except for the stamp`");

  assert.equal(cacheRemote({}), "origin");
  assert.equal(cacheRemote({ OE_IT_PREPARE_CACHE_REMOTE: "upstream" }), "upstream");
});

await test("the cache branch is ONE branch, because the sandbox credential cannot delete one", () => {
  assert.ok(CACHE_BRANCH.startsWith("oe-it-cache/"), "it is namespaced away from every code branch");
  assert.ok(!CACHE_BRANCH.includes("${"), "and carries no key, so it is force-pushed in place");
});

await test("🔴 the archive carries the two artefact trees, and NOT packages/**/dist", () => {
  assert.deepEqual([...CACHED_TREE_PATHS], [".output", ".eve/sandbox-cache"]);
  assert.ok(
    !CACHED_TREE_PATHS.some((path) => path.includes("dist")),
    "oe:build rewrites packages/**/dist in ~7 s, and a dist tree that always comes from this run's source cannot go stale",
  );
});

await test("🔴 EVERY child process the cache spawns is TIMED OUT — a stall inside the suite lock is not a miss", () => {
  assert.ok(GIT_TRANSPORT_TIMEOUT_MS > 0 && GIT_TRANSPORT_TIMEOUT_MS <= 600_000, "finite, and generous enough for an 8 MB archive");
  const source = readFileSync(join(repoRoot, "tests", "integration", "prepare-cache.ts"), "utf8");
  const sites = source.split("execFileSync(").slice(1);
  assert.equal(sites.length, 5, "the key probe, the restore's git and tar, the publish's git and tar — and nothing else");
  for (const [index, site] of sites.entries()) {
    const options = site.slice(0, 400);
    assert.ok(options.includes("timeout: GIT_TRANSPORT_TIMEOUT_MS"), `child process ${index + 1} passes the timeout`);
    assert.ok(options.includes('killSignal: "SIGKILL"'), `child process ${index + 1} kills hard — a process on a socket ignores SIGTERM`);
  }
});

function gitRepoFixture(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]): void => void execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet");
  git("config", "user.email", "it-prepare-test@example.invalid");
  git("config", "user.name", "it-prepare-test");
  git("config", "push.negotiate", "false");
}

function writeCachedTrees(root: string, marker: string): Map<string, string> {
  const files = new Map([
    [join(".output", "server", "index.mjs"), `// bundle ${marker}\n`],
    [join(".output", ".eve", "compile", "compiled-agent-manifest.json"), `{"marker":"${marker}"}\n`],
    [join(".eve", "sandbox-cache", "just-bash", "templates", `tpl-${marker}`, "seed"), `template ${marker}\n`],
  ]);
  for (const [relative, content] of files) {
    mkdirSync(join(root, dirname(relative)), { recursive: true });
    writeFileSync(join(root, relative), content);
  }
  return files;
}

await test("🔴 ROUND TRIP: a published tree restores byte-identically, and only under its own key", () => {
  const bare = join(scratch, "cache-remote.git");
  execFileSync("git", ["init", "--bare", "--quiet", bare], { stdio: ["ignore", "pipe", "pipe"] });

  const producer = join(scratch, "producer");
  gitRepoFixture(producer);
  const written = writeCachedTrees(producer, "k1");
  writeFileSync(join(producer, "package.json"), '{"name":"not-the-consumers"}\n');
  const published = publishPreparedTree({ root: producer, key: "k1", remote: bare });
  assert.equal(published.kind, "published", `the publish succeeded — got ${JSON.stringify(published)}`);
  assert.ok(published.kind === "published" && published.bytes > 0, "and it reports the archive's size");
  const refs = execFileSync("git", ["ls-remote", bare], { encoding: "utf8" });
  assert.ok(refs.includes(`refs/heads/${CACHE_BRANCH}`), `the archive is on ${CACHE_BRANCH} — got ${refs}`);
  const sha = refs.split("\t")[0] ?? "";
  const parents = execFileSync("git", ["-C", bare, "rev-list", "--parents", "-n", "1", sha], { encoding: "utf8" }).trim();
  assert.equal(parents, sha, "the cache commit has NO parent");

  const consumer = join(scratch, "consumer");
  gitRepoFixture(consumer);
  writeCachedTrees(consumer, "stale");
  const orphan = join(consumer, ".output", "server", "chunks", "from-another-build.mjs");
  mkdirSync(dirname(orphan), { recursive: true });
  writeFileSync(orphan, "// nobody built this\n");

  const wrongKey = restorePreparedTree({ root: consumer, key: "k2", remote: bare });
  assert.equal(wrongKey.kind, "miss", `a key the remote does not carry is a MISS — got ${JSON.stringify(wrongKey)}`);
  assert.ok(wrongKey.kind === "miss" && wrongKey.reason.includes("k1"), `…and the reason names what IS published — got ${JSON.stringify(wrongKey)}`);
  assert.equal(readFileSync(join(consumer, ".output", "server", "index.mjs"), "utf8"), "// bundle stale\n", "…and a miss extracts NOTHING");
  assert.equal(existsSync(orphan), true, "…and removes nothing either");

  writeFileSync(join(consumer, "package.json"), '{"name":"the-consumers-own"}\n');
  const hit = restorePreparedTree({ root: consumer, key: "k1", remote: bare });
  assert.equal(hit.kind, "restored", `the matching key restores — got ${JSON.stringify(hit)}`);
  assert.equal(
    readFileSync(join(consumer, "package.json"), "utf8"),
    '{"name":"the-consumers-own"}\n',
    "🔴 a restore touches NOTHING outside the two cached trees — the consumer's own package.json survives",
  );
  for (const [relative, content] of written) {
    assert.equal(readFileSync(join(consumer, relative), "utf8"), content, `${relative} came back byte-identical`);
  }
  assert.equal(existsSync(orphan), false, "🔴 and the stale file the archive does not carry is GONE — the cached paths are replaced, never merged");
  assert.equal(existsSync(join(consumer, ".oe-it-prepare-restore.tar.gz")), false, "the restore's staging archive is removed");
  assert.equal(existsSync(join(producer, ".oe-it-prepare-publish.tar.gz")), false, "the publish's staging archive is removed");
  assert.ok(CACHE_ARCHIVE_NAME.endsWith(".tar.gz"), "the archive is a gzipped tar, which is what the tar calls above produce");

  const unreachable = restorePreparedTree({ root: consumer, key: "k1", remote: join(scratch, "no-such-remote.git") });
  assert.equal(unreachable.kind, "miss", `an unreachable remote is a miss — got ${JSON.stringify(unreachable)}`);
});

await test("🔴 a crafted archive cannot write outside the two cached trees", () => {
  const bare = join(scratch, "poison-remote.git");
  execFileSync("git", ["init", "--bare", "--quiet", bare], { stdio: ["ignore", "pipe", "pipe"] });
  const producer = join(scratch, "poison-producer");
  gitRepoFixture(producer);
  writeCachedTrees(producer, "poison");
  writeFileSync(join(producer, "package.json"), '{"name":"from-the-archive"}\n');
  mkdirSync(join(producer, ".git", "hooks"), { recursive: true });
  writeFileSync(join(producer, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 0\n");
  const archive = join(scratch, "poison.tar.gz");
  execFileSync("tar", ["-czf", basename(archive), "-C", producer, ".output", ".eve/sandbox-cache", "package.json", ".git/hooks/post-checkout"], {
    cwd: dirname(archive),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const git = (args: readonly string[], input?: Buffer): string =>
    execFileSync("git", ["-C", producer, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...(input ? { input } : {}) }).trim();
  const archiveBlob = git(["hash-object", "-w", "--", archive]);
  const keyBlob = git(["hash-object", "-w", "--stdin"], Buffer.from("poisonkey\n", "utf8"));
  const tree = git(["mktree"], Buffer.from(`100644 blob ${keyBlob}\tkey\n100644 blob ${archiveBlob}\t${CACHE_ARCHIVE_NAME}\n`, "utf8"));
  const commit = git(["commit-tree", tree, "-m", "poison"]);
  git(["push", "--quiet", bare, `+${commit}:refs/heads/${CACHE_BRANCH}`]);

  const consumer = join(scratch, "poison-consumer");
  gitRepoFixture(consumer);
  const ownPackage = '{"name":"the-consumers-own"}\n';
  writeFileSync(join(consumer, "package.json"), ownPackage);
  const hook = join(consumer, ".git", "hooks", "post-checkout");
  assert.equal(existsSync(hook), false, "the fixture starts with no such hook, so its presence after the restore would be the archive's");

  const hit = restorePreparedTree({ root: consumer, key: "poisonkey", remote: bare });
  assert.equal(hit.kind, "restored", `the key matches, so this IS a hit — got ${JSON.stringify(hit)}`);
  assert.equal(readFileSync(join(consumer, ".output", "server", "index.mjs"), "utf8"), "// bundle poison\n", "the cached trees were extracted");
  assert.equal(readFileSync(join(consumer, "package.json"), "utf8"), ownPackage, "🔴 the archive's package.json did NOT land");
  assert.equal(existsSync(hook), false, "🔴 and neither did a member that would have executed on the next git operation");
});

await test("🔴 EVE CANARY: the fast prewarm's own symbol loader still finds every eve symbol", async () => {
  const loaded = await loadFastPathSymbols(repoRoot);
  assert.ok(
    loaded.ok,
    `the fast prewarm path cannot be taken on this tree: ${loaded.ok ? "" : loaded.missing} is gone. ` +
      "The prewarm would fall back to eve's authored-source path (147.7 s against 13.0 s). Find its new home " +
      "and update tests/integration/prewarm.ts.",
  );
  const prewarmModule = (await import(pathToFileURL(join(repoRoot, "node_modules", "eve", "dist", "src", "execution", "sandbox", "prewarm.js")).href)) as Record<
    string,
    unknown
  >;
  assert.equal(typeof prewarmModule.prewarmBuiltAppSandboxes, "function", "eve still exports the authored-source prewarm, which is the only fallback");
  const session = readFileSync(join(repoRoot, "node_modules", "eve", "dist", "src", "runtime", "sessions", "runtime-session.js"), "utf8");
  assert.ok(
    session.includes("Symbol.for(`eve.runtime-session-storage`)") || session.includes('Symbol.for("eve.runtime-session-storage")'),
    "eve no longer keeps its runtime session on a globalThis symbol, so the built bundle and node_modules/eve no longer " +
      "share one — tests/integration/prewarm.ts's fast path cannot read the bundle's compiled artifacts any more.",
  );
});

await test("🔴 this file still has every test row it had — the blunt limb, which no deletion escapes", () => {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.equal(source.match(/^await test\(/gmu)?.length, 32, "a deleted or added test row changes this count — if you added one, bump it here");
});

await test("🔴 every import in this file is USED — the finer limb, which names what a deletion took", () => {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const header = source.slice(0, source.indexOf("const repoRoot ="));
  const body = source
    .slice(source.indexOf("const repoRoot ="))
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
    .join("\n");
  const named = new Set<string>();
  for (const block of header.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/gu)) {
    for (const raw of (block[1] ?? "").split(",")) {
      const name = raw.replace(/^\s*type\s+/u, "").split(/\s+as\s+/u).pop()?.trim() ?? "";
      if (name !== "") named.add(name);
    }
  }
  assert.ok(named.size > 20, `the import scan found ${named.size} names, which is too few to be reading this file`);
  const dead = [...named].filter((name) => !new RegExp(`\\b${name}\\b`, "u").test(body));
  assert.deepEqual(dead, [], `these imports are never used — a test row was probably deleted with its block: ${dead.join(", ")}`);
});

await test("🔴 SOURCE JOIN: scripts/suite-lock-run.ts still runs the prepare step before its shards", () => {
  const source = readFileSync(join(repoRoot, "scripts", "suite-lock-run.ts"), "utf8");
  assert.ok(source.includes('"test:integration:prepare"'), "the wrapper names the prepare npm script");
  assert.ok(source.includes("options.prepare ?? (isVitestCommand(cmd)"), "and runs it for a vitest command only");
  assert.ok(!source.includes("shardReusesBuild"), "no shard builds any more, so no shard may be handed a build-reuse flag");
});

await test("🔴 SOURCE JOIN: `npm run build` writes the build stamp, and the prepare step reads it and clears it", () => {
  const scripts = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.ok(/^npm run oe:build && tsx scripts\/eve-build-stamp\.ts begin$/u.test(scripts.prebuild ?? ""), `prebuild ends with begin — got ${scripts.prebuild}`);
  assert.ok((scripts.postbuild ?? "").startsWith("tsx scripts/eve-build-stamp.ts end && "), `postbuild starts with end — got ${scripts.postbuild}`);
  const source = readFileSync(join(repoRoot, "tests", "integration", "prepare.ts"), "utf8");
  assert.ok(/gateBuiltBundle\(\{\s*state,\s*stampsTrusted: stampCacheEnabled\(env\),\s*key,\s*stamp: readBuildStamp\(root\),/u.test(source), "the prepare step decides `built` from the tree state, the cache posture and the build stamp");
  assert.equal(source.match(/clearBuildStamp\(root\)/gu)?.length, 2, "the cold build and the restore both clear the build stamp");
  const ignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  assert.ok(ignore.includes(`/${BUILD_STAMP_FILE}\n`), "the build stamp is gitignored");
});

await test("🔴 SOURCE JOIN: the prepare step still branches on the documented OE_IT_SKIP_BUILD name", () => {
  const source = readFileSync(join(repoRoot, "tests", "integration", "prepare.ts"), "utf8");
  assert.ok(source.includes('export const IT_SKIP_BUILD_ENV = "OE_IT_SKIP_BUILD";'), "the documented flag keeps its spelling");
  const setup = readFileSync(join(repoRoot, "tests", "integration", "global-setup.ts"), "utf8");
  assert.ok(!/env\s*(\.|\[\s*["'`])\s*OE_IT_SKIP_BUILD/u.test(setup), "global-setup must no longer READ the flag, only mention it");
  assert.ok(!setup.includes("execFileSync"), "and must spawn nothing at all — the build is the prepare step's");
});

rmSync(scratch, { force: true, recursive: true });

if (failures.length > 0) {
  console.error(`\nit-prepare-test: ${failures.length} failure(s): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nit-prepare-test: all rows passed.");

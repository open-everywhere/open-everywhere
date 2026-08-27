import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type GithubApiFetchLike } from "./deploy/ci-gate-lib.js";
import { type Env, type Exec, realExec } from "./deploy/lib.js";
import { extractBaseFence, FENCE_DRIVER_PATH, FENCE_MODULE_DIR, parsePullRequestSubject, realSpawnDriver, runMergeFence, type SpawnDriver } from "./deploy/merge-fence-lib.js";
import { ruleFor } from "./upgrade-fence/judge.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const problems: string[] = [];
function fail(message: string): void {
  problems.push(message);
}

function prRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 417,
    title: "OPE-999: bump eve",
    body: "oe-upgrade: releases/abc123/migration.json",
    state: "open",
    merged: false,
    user: { login: "open-everywhere[bot]", type: "Bot" },
    head: { sha: "1111111111111111111111111111111111111111" },
    base: { sha: "2222222222222222222222222222222222222222", ref: "main" },
    ...overrides,
  };
}

{
  const good = parsePullRequestSubject(prRecord());
  if (!good.ok) fail(`1: a well-formed pull-request record must parse — got: ${good.reason}`);
  else {
    if (good.subject.authorType !== "Bot") fail("1: the author TYPE must survive the parse — it is the fence's non-forgeable arming signal");
    if (good.subject.authorLogin !== "open-everywhere[bot]") fail("1: the author LOGIN must survive the parse — it arms the fence on its own when `type` is absent");
    if (good.subject.baseSha !== "2222222222222222222222222222222222222222") fail("1: the BASE sha must survive the parse — it is the ref the fence is executed from");
  }

  const required: [string, unknown][] = [
    ["not an object", "a string"],
    ["no number", { ...prRecord(), number: undefined }],
    ["no head.sha", { ...prRecord(), head: {} }],
    ["no base.sha", { ...prRecord(), base: { ref: "main" } }],
    ["no author at all", { ...prRecord(), user: {} }],
  ];
  for (const [label, body] of required) {
    const parsed = parsePullRequestSubject(body);
    if (parsed.ok) fail(`1: a record with ${label} must REFUSE — a fact the fence cannot read is never a default`);
  }

  const loginOnly = parsePullRequestSubject({ ...prRecord(), user: { login: "open-everywhere[bot]" } });
  if (!loginOnly.ok) fail("1: a record carrying only `user.login` must still parse — the `[bot]` suffix arms the fence on its own");
  const typeOnly = parsePullRequestSubject({ ...prRecord(), user: { type: "Bot" } });
  if (!typeOnly.ok) fail("1: a record carrying only `user.type` must still parse");
}

{
  const headSha = (await realExec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const extracted = await extractBaseFence({ baseSha: headSha });
  if (!extracted.ok) {
    fail(`2: extracting the fence from this repo's own HEAD must succeed — got: ${extracted.reason}`);
  } else {
    const driver = join(extracted.dir, "upgrade-diff-fence.ts");
    if (!existsSync(driver)) fail(`2: the extracted copy must contain the driver at ${driver}`);
    if (!existsSync(join(extracted.dir, "upgrade-fence", "judge.ts"))) fail("2: the extracted copy must contain upgrade-fence/judge.ts beside the driver");
    if (!existsSync(join(extracted.dir, "upgrade-fence", "manifest.ts"))) fail("2: the extracted copy must contain upgrade-fence/manifest.ts");
    if (!existsSync(join(extracted.dir, "package.json"))) fail("2: the extracted copy must carry its own `\"type\": \"module\"` manifest, or the driver cannot be transformed at all");

    const fromGit = (await realExec("git", ["show", `${headSha}:${FENCE_DRIVER_PATH}`])).stdout;
    if (readFileSync(driver, "utf8") !== fromGit) fail("2: the extracted driver must be byte-identical to `git show <base>:scripts/upgrade-diff-fence.ts`");

    const listed = (await realExec("git", ["ls-tree", "-r", "--name-only", headSha, `${FENCE_MODULE_DIR}/`])).stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (extracted.files.length !== listed.length + 1) {
      fail(`2: the extraction must copy every ${FENCE_MODULE_DIR}/ module in the base tree plus the driver — base has ${listed.length}, extracted ${extracted.files.length}`);
    }
  }

  const bare = mkdtempSync(join(tmpdir(), "oe-merge-fence-bare-"));
  const gitIn: Exec = (command, args) => realExec(command, command === "git" ? ["-C", bare, ...args] : args);
  await gitIn("git", ["init", "-q"]);
  await gitIn("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "base with no fence"]);
  const bareSha = (await gitIn("git", ["rev-parse", "HEAD"])).stdout.trim();
  const noFence = await extractBaseFence({ baseSha: bareSha, exec: gitIn });
  if (noFence.ok) fail("2: a base commit with no scripts/upgrade-fence/ must REFUSE — falling back to the head's copy is a fence the proposal rewrites");
  else if (!noFence.reason.includes("no base-ref fence")) fail(`2: the refusal must say the base has no fence — got: ${noFence.reason}`);
}

{
  const headSha = (await realExec("git", ["rev-parse", "HEAD"])).stdout.trim();

  let files: { filename: string }[] = [];
  const server = createServer((req, res) => {
    const page = Number(new URL(req.url ?? "/", "http://x").searchParams.get("page") ?? "1");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(page === 1 ? files : []));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const execStub: Exec = (command, args) =>
    command === "gh" ? Promise.resolve({ code: 1, stdout: "", stderr: "", spawnError: "ENOENT: no gh" }) : realExec(command, args);

  const fetchStub = (record: Record<string, unknown>, status = 200): GithubApiFetchLike =>
    async () => ({ status, text: () => Promise.resolve(JSON.stringify(record)) });

  const baseEnv: Env = { ...process.env, GH_TOKEN: "test-token", GITHUB_REPOSITORY: "acme/oe", GITHUB_API_URL: `http://127.0.0.1:${port}` };

  const spyRoot = mkdtempSync(join(tmpdir(), "oe-merge-fence-spy-"));
  let spawnedDriver = "";
  const spySpawn: SpawnDriver = (input) => {
    spawnedDriver = input.args[1] ?? "";
    return realSpawnDriver(input);
  };

  const judge = (changed: string[], record: Record<string, unknown>, env = baseEnv) => {
    files = changed.map((filename) => ({ filename }));
    spawnedDriver = "";
    return runMergeFence({
      prNumber: 417,
      expectedHeadSha: headSha,
      exec: execStub,
      fetchImpl: fetchStub(record),
      env,
      spawn: spySpawn,
      cwd: ROOT,
      tmpRoot: spyRoot,
    });
  };

  const live = { head: { sha: headSha }, base: { sha: headSha, ref: "main" } };

  const refused = await judge(["package.json", "packages/core/agent/approvals/session-grant.ts"], prRecord(live));
  if (refused.verdict !== "refuse") fail(`3: an agent-authored pull request touching the approvals plane must REFUSE the merge — got ${refused.verdict}`);
  if (refused.fence !== "refuse") fail(`3: the rung must report the FENCE's verdict, not just its own — got fence=${refused.fence}`);
  if (!refused.detail.includes("REFUSED")) fail(`3: the refusal must carry the base-ref driver's own report — got:\n${refused.detail}`);
  if (!refused.detail.includes("core-approvals-plane")) fail(`3: the report must name the rule that fired, so a reader can find the manifest entry — got:\n${refused.detail}`);

  if (!spawnedDriver.startsWith(spyRoot)) {
    fail(`3: the spawned driver must be the copy extracted from the BASE ref (under ${spyRoot}), not the working tree's — got ${spawnedDriver}`);
  }
  if (spawnedDriver.startsWith(ROOT)) fail(`3: the spawned driver must not live inside the repo — a fence the proposal can edit is not a fence. Got ${spawnedDriver}`);
  if (spawnedDriver && readFileSync(spawnedDriver, "utf8") !== (await realExec("git", ["show", `${headSha}:${FENCE_DRIVER_PATH}`])).stdout) {
    fail("3: the spawned driver's bytes must equal `git show <base>:scripts/upgrade-diff-fence.ts`");
  }

  const clean = await judge(["package.json", "docs/README.md"], prRecord(live));
  if (clean.verdict !== "clear") fail(`3: a clean agent-authored diff must CLEAR the merge — got ${clean.verdict}: ${clean.message}\n${clean.detail}`);
  if (clean.fence !== "pass") fail(`3: a clean diff must report fence=pass — got ${clean.fence}`);

  const warned = await judge(["agent/access/bundles.ts"], prRecord({ ...live, user: { login: "example-owner", type: "User" }, body: "hand-written config change" }));
  if (warned.verdict !== "clear") fail(`3: a person's protected-path change must WARN, not block — got ${warned.verdict}: ${warned.message}`);
  if (warned.fence !== "warn") fail(`3: a person's protected-path change must report fence=warn — got ${warned.fence}\n${warned.detail}`);

  const noToken = await judge(["package.json"], prRecord(live), { ...baseEnv, GH_TOKEN: "", GITHUB_TOKEN: "" });
  if (noToken.verdict !== "refuse") fail("3: no credential must REFUSE — a fence that cannot read the diff never reports it clean");

  const merged = await judge(["package.json"], prRecord({ ...live, merged: true }));
  if (merged.verdict !== "refuse") fail("3: an already-merged pull request must REFUSE — this rung judges a proposal, and there is nothing left to fence");

  const mismatch = await runMergeFence({
    prNumber: 417,
    expectedHeadSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    exec: execStub,
    fetchImpl: fetchStub(prRecord(live)),
    env: baseEnv,
    spawn: realSpawnDriver,
    cwd: ROOT,
  });
  if (mismatch.verdict !== "refuse") fail("3: a head sha that disagrees with the pull request's must REFUSE — clearing a sha the fence did not judge proves nothing");

  const unreadable = await runMergeFence({
    prNumber: 417,
    expectedHeadSha: headSha,
    exec: execStub,
    fetchImpl: async () => ({ status: 404, text: () => Promise.resolve("not found") }),
    env: baseEnv,
    spawn: realSpawnDriver,
    cwd: ROOT,
  });
  if (unreadable.verdict !== "refuse") fail("3: an unreadable pull request must REFUSE — refusing rather than merging unjudged");

  const neverRan = await runMergeFence({
    prNumber: 417,
    expectedHeadSha: headSha,
    exec: execStub,
    fetchImpl: fetchStub(prRecord(live)),
    env: baseEnv,
    spawn: async () => ({ code: 0, stdout: "", stderr: "", spawnError: "ENOENT: no node" }),
    cwd: ROOT,
  });
  if (neverRan.verdict !== "refuse") fail("3: a fence driver that never spawned must REFUSE even on exit 0 — a spawn failure is a config fault, never data");
  if (!neverRan.message.includes("never ran")) fail(`3: the refusal must name the spawn failure, not a verdict — got: ${neverRan.message}`);

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const script = pkg.scripts?.["deploy:merge-fence"];
  if (!script) fail("4: package.json must define `deploy:merge-fence` — the rung the builder is told to run");
  else if (!script.includes("scripts/deploy/merge-fence.ts")) fail(`4: \`deploy:merge-fence\` must run scripts/deploy/merge-fence.ts — got: ${script}`);

  const builderDef = join(ROOT, "CONTRIBUTING.md");
  if (!existsSync(builderDef)) {
    fail("4: CONTRIBUTING.md is missing — the merge conditions this rung is wired into live there");
  } else {
    const text = readFileSync(builderDef, "utf8");
    if (!text.includes("npm run deploy:merge-fence")) {
      fail(
        "4: the builder's self-merge conditions must name `npm run deploy:merge-fence`. A fence nothing invokes is the OPE-1172 defect " +
          "itself — the judgement logic was green throughout the period in which no runner called it.",
      );
    }
  }
}

{
  for (const path of ["scripts/deploy/merge-fence.ts", "scripts/deploy/merge-fence-lib.ts"]) {
    const rule = ruleFor(path);
    if (!rule) fail(`5: ${path} must be inside the protected set — a fence runner an agent may rewrite is not a fence`);
    else if (rule.id !== "merge-gate-surface") fail(`5: ${path} should be protected by merge-gate-surface — got ${rule.id}`);
  }
  const own = ruleFor("scripts/deploy-merge-fence-test.ts");
  if (!own) fail("5: this suite is what proves the rung is REACHED — unprotected, it can be deleted quietly and the rung dropped after it");
  else if (own.id !== "the-fence-itself") fail(`5: this suite should be protected by the-fence-itself — got ${own.id}`);

  for (const path of [
    "scripts/deploy-ci-gate-test.ts",
    "scripts/deploy-cloud-proof-verify-test.ts",
    "scripts/deploy-cloud-proof-post-test.ts",
  ]) {
    const sibling = ruleFor(path);
    if (!sibling) fail(`5: ${path} proves a merge-gate enforcer — unprotected, an agent may neuter it and the enforcer reads clean`);
    else if (sibling.id !== "merge-gate-surface") fail(`5: ${path} should be protected by merge-gate-surface — got ${sibling.id}`);
  }

  for (const path of ["scripts/deploy-smoke-test.ts", "scripts/deploy-test.ts"]) {
    if (ruleFor(path)) {
      fail(`5: negative control — ${path} gates a deploy, not a merge, and must stay outside merge-gate-surface`);
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ deploy:merge-fence: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  "✓ deploy:merge-fence: the pre-merge rung extracts the BASE ref's fence byte-for-byte and really spawns it — an agent-authored " +
    "protected-path diff refuses the merge, a clean one clears, a person's warns; no credential, an unreadable pull request, a " +
    "head-sha disagreement, an already-merged pull request and a driver that never started all refuse; and the builder's self-merge " +
    "conditions name the rung",
);

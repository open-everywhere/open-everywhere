import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GITHUB_API_PAGE_SIZE, type GithubApiFetchLike } from "./deploy/ci-gate-lib.js";
import { judgeDcoSignoff, parsePullRequestCommits, signOffTrailers } from "./deploy/dco-lib.js";
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

  const signedCommit = (overrides: Record<string, unknown> = {}) => ({
    sha: "3333333333333333333333333333333333333333",
    commit: { message: "OPE-999: bump eve\n\nSigned-off-by: A Contributor <contributor@example.com>" },
    parents: [{ sha: "2222222222222222222222222222222222222222" }],
    ...overrides,
  });

  const fetchStub = (record: Record<string, unknown>, commits: unknown[] = [signedCommit()], status = 200): GithubApiFetchLike =>
    async (url) => ({ status, text: () => Promise.resolve(JSON.stringify(url.includes("/commits") ? commits : record)) });

  const baseEnv: Env = { ...process.env, GH_TOKEN: "test-token", GITHUB_REPOSITORY: "acme/oe", GITHUB_API_URL: `http://127.0.0.1:${port}` };

  const spyRoot = mkdtempSync(join(tmpdir(), "oe-merge-fence-spy-"));
  let spawnedDriver = "";
  const spySpawn: SpawnDriver = (input) => {
    spawnedDriver = input.args[1] ?? "";
    return realSpawnDriver(input);
  };

  const judge = (changed: string[], record: Record<string, unknown>, env = baseEnv, commits: unknown[] = [signedCommit()]) => {
    files = changed.map((filename) => ({ filename }));
    spawnedDriver = "";
    return runMergeFence({
      prNumber: 417,
      expectedHeadSha: headSha,
      exec: execStub,
      fetchImpl: fetchStub(record, commits),
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

  const unsignedCommit = signedCommit({ commit: { message: "OPE-999: bump eve\n\nno trailer here" } });

  const unsigned = await judge(["package.json", "docs/README.md"], prRecord(live), baseEnv, [unsignedCommit]);
  if (unsigned.verdict !== "refuse") fail(`3: a pull request whose commit carries no Signed-off-by must REFUSE the merge — got ${unsigned.verdict}: ${unsigned.message}`);
  if (unsigned.dco !== "refuse") fail(`3: the rung must report dco=refuse — got dco=${unsigned.dco}`);
  if (unsigned.fence !== "pass") fail(`3: the DCO refusal must sit on top of a PASSING upgrade fence — got fence=${unsigned.fence}`);
  if (!unsigned.message.includes("Signed-off-by")) fail(`3: the refusal must name the missing trailer so the author knows what to do — got: ${unsigned.message}`);
  if (!unsigned.message.includes("rebase --signoff")) fail(`3: the refusal must carry the remedy CONTRIBUTING.md documents — got: ${unsigned.message}`);

  const signed = await judge(["package.json", "docs/README.md"], prRecord(live), baseEnv, [signedCommit()]);
  if (signed.verdict !== "clear") fail(`3: the same diff with a signed commit must CLEAR — got ${signed.verdict}: ${signed.message}`);
  if (signed.dco !== "pass") fail(`3: a signed commit must report dco=pass — got ${signed.dco}`);

  const mixed = await judge(["package.json"], prRecord(live), baseEnv, [signedCommit(), unsignedCommit]);
  if (mixed.verdict !== "refuse") fail("3: ONE unsigned commit among signed ones must refuse — the DCO is a per-commit certificate, not a per-branch one");

  const unreadableCommits = await judge(["package.json"], prRecord(live), baseEnv, { message: "Not Found" } as unknown as unknown[]);
  if (unreadableCommits.verdict !== "refuse") fail("3: a commit list that cannot be read must REFUSE — a rung that cannot see the commits never reports them signed");
  if (unreadableCommits.dco !== "unreadable") fail(`3: an unreadable commit list must report dco=unreadable, NOT dco=refuse — "sign your commits" is the wrong remedy for a failed read, and would send the author to amend commits that may already be signed. Got ${unreadableCommits.dco}`);

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
    if (!text.includes("Signed-off-by")) {
      fail(
        "4: the builder's commit convention must name the `Signed-off-by:` trailer. `deploy:merge-fence` refuses a commit without one, " +
          "so a run definition that does not require it produces branches its own last rung rejects.",
      );
    }
  }
}

{
  for (const path of ["scripts/deploy/merge-fence.ts", "scripts/deploy/merge-fence-lib.ts", "scripts/deploy/dco-lib.ts"]) {
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

{
  if (signOffTrailers("m\n\nSigned-off-by: Rowan Hale <rowan@example.com>").length !== 1) {
    fail("6: the trailer `git commit -s` writes must be recognised — it is the only shape CONTRIBUTING.md tells a contributor to produce");
  }
  if (signOffTrailers("m\n\nsigned-off-by: Rowan Hale <t@example.com>").length !== 1) fail("6: the trailer key must match case-insensitively");
  if (signOffTrailers("m\n\nCo-Authored-By: X <x@y.z>\nSigned-off-by: T <t@y.z>").length !== 1) fail("6: a sign-off beside other trailers must still be found");

  for (const [label, message] of [
    ["no trailer at all", "just a subject line"],
    ["no address", "m\n\nSigned-off-by: Rowan Hale"],
    ["an address with no @", "m\n\nSigned-off-by: Rowan Hale <nobody>"],
    ["no name before the address", "m\n\nSigned-off-by: <t@example.com>"],
    ["the words in prose, not a trailer line", "m\n\nI have signed-off-by: hand, honest <t@example.com> and more"],
    ["an INDENTED sign-off, i.e. a quoted one", "m\n\n    Signed-off-by: Someone Else <s@example.com>"],
  ] as [string, string][]) {
    if (signOffTrailers(message).length !== 0) fail(`6: ${label} must NOT count as a sign-off — a trailer that certifies nothing is not a DCO sign-off`);
  }
  if (signOffTrailers("m\n\nSigned-off-by: Someone Else <s@example.com>").length !== 1) fail("6: the same line unindented must still count — the rule is about the indent, not the signer");
  if (signOffTrailers("m\r\n\r\nSigned-off-by: T <t@example.com>\r\n").length !== 1) fail("6: a CRLF message must still match — the API is a transport, not a verdict");

  const commit = (message: string, parentCount = 1, sha = "a".repeat(40)) => ({ sha, message, parentCount, summary: message.split("\n")[0] as string });
  const SIGNED = "OPE-1: x\n\nSigned-off-by: T <t@example.com>";

  if (judgeDcoSignoff([commit(SIGNED), commit(SIGNED, 1, "b".repeat(40))]).verdict !== "pass") fail("6: all-signed commits must PASS");
  const oneBad = judgeDcoSignoff([commit(SIGNED), commit("OPE-1: y", 1, "c".repeat(40))]);
  if (oneBad.verdict !== "refuse") fail("6: one unsigned commit must REFUSE");
  if (!oneBad.unsigned.some((line) => line.startsWith("cccccccccccc"))) fail(`6: the refusal must name the offending sha — got ${JSON.stringify(oneBad.unsigned)}`);

  const merge = judgeDcoSignoff([commit(SIGNED), commit("Merge branch 'main' into claude/x", 2, "f".repeat(40))]);
  if (merge.verdict !== "pass") fail(`6: an unsigned MERGE commit must be exempt — the repo's up-to-date policy requires merging main in, and \`git merge\` writes no sign-off. Got: ${merge.message}`);
  if (merge.exempt !== 1) fail(`6: the merge commit must be COUNTED as exempt, not silently skipped — got exempt=${merge.exempt}`);
  if (merge.checked !== 1) fail(`6: an exempt commit must not be counted as checked — got checked=${merge.checked} for one ordinary commit plus one merge`);
  if (judgeDcoSignoff([commit("Merge branch 'main' into claude/x", 1)]).verdict !== "refuse") {
    fail("6: negative control — the same unsigned message with ONE parent is an ordinary commit and must REFUSE. The exemption turns on the parent count, never on the subject line");
  }

  const allMerges = judgeDcoSignoff([commit("Merge a", 2), commit("Merge b", 2, "d".repeat(40))]);
  if (allMerges.verdict !== "refuse") fail(`6: a pull request of ONLY merge commits checks nothing and must REFUSE — got ${allMerges.verdict}: ${allMerges.message}`);
  if (allMerges.message.includes("every commit carries")) fail("6: a zero-checked run must not print `every commit carries a DCO sign-off` — that is a claim about an empty set");
  if (judgeDcoSignoff([commit("Merge a", 2), commit(SIGNED, 1, "e".repeat(40))]).verdict !== "pass") {
    fail("6: one signed ordinary commit beside a merge commit must PASS — the refusal is about checking nothing, not about merges");
  }

  const badReads: [string, unknown][] = [
    ["a JSON object instead of an array", { message: "Not Found" }],
    ["an entry that is not an object", ["a string"]],
    ["an entry with no sha", [{ commit: { message: SIGNED }, parents: [] }]],
    ["an entry with no message", [{ sha: "a".repeat(40), commit: {}, parents: [] }]],
    ["an entry with no parents array", [{ sha: "a".repeat(40), commit: { message: SIGNED } }]],
    ["an EMPTY commit list", []],
  ];
  for (const [label, body] of badReads) {
    if (parsePullRequestCommits(body).ok) fail(`6: ${label} must REFUSE — a read this rung cannot trust never clears a merge`);
  }
  const good = parsePullRequestCommits([{ sha: "a".repeat(40), commit: { message: SIGNED }, parents: [{ sha: "b".repeat(40) }] }]);
  if (!good.ok) fail(`6: a well-formed commit page must parse — got: ${good.ok === false ? good.reason : ""}`);
  else if (good.commits[0]?.parentCount !== 1) fail("6: the parent COUNT must survive the parse — the merge exemption turns on it");

  const fullPage = Array.from({ length: GITHUB_API_PAGE_SIZE }, (_, i) => ({ sha: String(i).padStart(40, "0"), commit: { message: SIGNED }, parents: [] }));
  if (parsePullRequestCommits(fullPage).ok) fail("6: a commit page at the per_page bound must REFUSE — an unsigned commit on page 2 would be invisible");
  if (!parsePullRequestCommits(fullPage.slice(0, GITHUB_API_PAGE_SIZE - 1)).ok) fail("6: negative control — one commit UNDER the bound is provably complete and must parse");
}

{
  const blocksOf = (text: string): string[] => {
    const blocks: string[] = [];
    let current: string[] = [];
    const flush = () => {
      if (current.join("\n").trim().length > 0) blocks.push(current.join("\n"));
      current = [];
    };
    for (const line of text.split("\n")) {
      if (line.trim().length === 0 || /^\s*[-*+]\s/.test(line)) flush();
      current.push(line);
    }
    flush();
    return blocks;
  };

  const statesDco = (block: string) => /signed-off-by|git commit -s|\bDCO\b|Developer Certificate of Origin/i.test(block);

  for (const [file, why] of [
    ["CONTRIBUTING.md", "the contributor-facing statement of the requirement"],
    [".github/PULL_REQUEST_TEMPLATE.md", 'the checkbox that says "required to merge"'],
    ["README.md", "the DCO badge and the Contributing section"],
    ["AGENTS.md", "the agent-facing convention"],
  ] as [string, string][]) {
    const path = join(ROOT, file);
    if (!existsSync(path)) {
      fail(`7: ${file} is missing — ${why} lives there`);
      continue;
    }
    const blocks = blocksOf(readFileSync(path, "utf8"));
    const dcoBlocks = blocks.filter(statesDco);
    if (dcoBlocks.length === 0) {
      fail(`7: ${file} no longer states the DCO requirement — ${why}. Remove the rung too, or restore the statement`);
      continue;
    }
    if (!dcoBlocks.some((block) => block.includes("deploy:merge-fence"))) {
      fail(
        `7: ${file} states the DCO requirement, but no block that states it names \`deploy:merge-fence\` — the check that enforces it. ` +
          "That is the exact OPE-1226 defect: four documents claimed an enforcement that had been deleted. A claim must name its receipt, " +
          "in the same breath. A mention elsewhere in the file does not count; that is what made the file-wide version of this test vacuous.",
      );
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
    "head-sha disagreement, an already-merged pull request and a driver that never started all refuse; the DCO rung refuses a pull " +
    "request whose commit carries no `Signed-off-by:` trailer and clears the same diff once it does; and the builder's self-merge " +
    "conditions name the rung and its sign-off convention",
);

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTECTED_PATH_RULES, checkManifestPaths } from "./upgrade-fence/manifest.js";
import { OVERRIDE_REMEDY, formatUpgradeFenceReport, judgeUpgradeDiff, ruleFor } from "./upgrade-fence/judge.js";
import { FenceFetchTimeoutError, listPullRequestFiles, type FenceFetchFn } from "./upgrade-fence/pr-files.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems: string[] = [];
const fail = (msg: string) => problems.push(msg);

const CLEAN_UPGRADE_DIFF = [
  "package.json",
  "package-lock.json",
  "packages/core/package.json",
  "packages/providers/slack/package.json",
  "patches/eve+0.44.0.patch",
  "releases/1111111111111111111111111111111111111111/migration.json",
  "packages/core/agent/tools/reply.ts",
];

const MARKED_BODY = "Bumps eve.\n\noe-upgrade: 1111111111111111111111111111111111111111\n";

{
  const r = judgeUpgradeDiff({ changedFiles: [...CLEAN_UPGRADE_DIFF, "packages/core/agent/access/bundle.ts"] });
  if (r.verdict !== "refuse") fail(`1: a diff touching packages/core/agent/access/ must REFUSE — got "${r.verdict}"`);
  if (!r.hits.some((h) => h.file === "packages/core/agent/access/bundle.ts")) fail("1: the refusal must name the offending file");
  if (r.hits.length !== 1) fail(`1: only the access-plane file is a hit — got ${JSON.stringify(r.hits.map((h) => h.file))}`);
}
{
  const r = judgeUpgradeDiff({ changedFiles: CLEAN_UPGRADE_DIFF });
  if (r.verdict !== "pass") fail(`1: a clean upgrade diff must PASS — got "${r.verdict}"`);
  if ((r.verdict === "refuse") !== false) fail("1: negative control — the clean diff must not be refused");
  if (r.hits.length !== 0) fail(`1: a clean upgrade diff has no protected hits — got ${JSON.stringify(r.hits.map((h) => h.file))}`);
}

{
  const accessEdit = ["agent/access/bundles.ts"];

  const withOldSignals = judgeUpgradeDiff({
    changedFiles: accessEdit,
    authorType: "User",
    authorLogin: "example-owner",
    title: "config: grant infra the workflows capability",
    body: "",
  } as unknown as Parameters<typeof judgeUpgradeDiff>[0]);
  if (withOldSignals.verdict !== "refuse") {
    fail(`2: a person-authored protected-path diff must REFUSE — the fence reads no author since OPE-1315. Got "${withOldSignals.verdict}"`);
  }
  if (withOldSignals.hits.length !== 1) fail("2: the refusal still reports the hit — a silent refusal names nothing to review");

  const marked = judgeUpgradeDiff({ changedFiles: accessEdit, title: "upgrade", body: MARKED_BODY } as unknown as Parameters<typeof judgeUpgradeDiff>[0]);
  if (marked.verdict !== withOldSignals.verdict) fail(`2: the oe-upgrade marker must not change the verdict — got "${marked.verdict}" against "${withOldSignals.verdict}"`);

  const dressed = judgeUpgradeDiff({
    changedFiles: [...accessEdit, "releases/" + "b".repeat(40) + "/migration.json", "docs/security/security-model.md"],
  });
  if (dressed.verdict !== "refuse") fail(`2: no file in the diff may disarm the fence — got "${dressed.verdict}"`);

  const refusalText = formatUpgradeFenceReport(withOldSignals, accessEdit.length).join("\n");
  if (!refusalText.includes(OVERRIDE_REMEDY)) fail(`2: the refusal must name the remedy "${OVERRIDE_REMEDY}" — got:\n${refusalText}`);

  const passText = formatUpgradeFenceReport(judgeUpgradeDiff({ changedFiles: CLEAN_UPGRADE_DIFF }), CLEAN_UPGRADE_DIFF.length).join("\n");
  for (const [label, text] of [
    ["the refusal", refusalText],
    ["the pass", passText],
  ] as const) {
    for (const dead of ["person-authored", "agent-authored", "armed by"]) {
      if (text.toLowerCase().includes(dead)) fail(`2: ${label} report still says "${dead}" — the authorship distinction was deleted at OPE-1315:\n${text}`);
    }
  }
}

{
  const missing = checkManifestPaths(ROOT);
  if (missing.length > 0) {
    fail(`3: the manifest names ${missing.length} path(s) that do not exist — a rule pointing at a renamed file protects nothing: ${JSON.stringify(missing)}`);
  }

  for (const rule of PROTECTED_PATH_RULES) {
    for (const p of rule.paths) {
      const hit = p.endsWith("/") ? `${p}some-file.ts` : p;
      if (ruleFor(hit)?.id !== rule.id) fail(`3: ${rule.id} must match ${hit}`);

      const nearMiss = p.endsWith("/") ? `${p.slice(0, -1)}-notes/some-file.ts` : `${p}.md`;
      if (ruleFor(nearMiss) !== undefined) fail(`3: ${rule.id} must NOT match the near-miss ${nearMiss}`);
    }
  }

  if (ruleFor("packages/core/agent/Access/bundle.ts")?.id !== "core-access-plane") {
    fail("3: a re-cased protected path must still hit — a case-exact match is a bypass on a case-insensitive checkout");
  }

  const minimum = [
    "packages/core/agent/access/resolver.ts",
    "packages/core/agent/access/human-only-invariants-manifest.ts",
    "packages/core/agent/approvals/session-grant.ts",
    "packages/core/agent/audit/chain.ts",
  ];
  for (const file of minimum) {
    if (ruleFor(file) === undefined) fail(`3: ${file} is in OPE-992's minimum protected set and no rule covers it`);
  }

  for (const file of [
    "scripts/deploy/ci-gate-lib.ts",
    "scripts/deploy/cloud-proof-post-lib.ts",
    "scripts/deploy-ci-gate-test.ts",
    "scripts/deploy-cloud-proof-verify-test.ts",
    "scripts/deploy-cloud-proof-post-test.ts",
    ".github/CODEOWNERS",
  ]) {
    if (ruleFor(file)?.id !== "merge-gate-surface") {
      fail(`3: ${file} is part of the merge gate — the enforcement scripts, the tracked run definitions they enforce, those enforcers' own proving suites, and the code-owner list — and merge-gate-surface must cover it`);
    }
  }

  for (const file of ["scripts/deploy-smoke-test.ts", "scripts/deploy-census-test.ts"]) {
    if (ruleFor(file) !== undefined) {
      fail(`3: ${file} gates a deploy, not a merge — it must stay outside merge-gate-surface. Got rule ${ruleFor(file)?.id}`);
    }
  }

  for (const file of [...CLEAN_UPGRADE_DIFF, "docs/README.md", "packages/core/agent/tools/open_pull_request.ts", "scripts/release-record-lint.ts"]) {
    if (ruleFor(file) !== undefined) fail(`3: ${file} must not be protected — got rule ${ruleFor(file)?.id}`);
  }
}

{
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({ filename: `f${i}.ts` }));
  const ok = (body: unknown): ReturnType<FenceFetchFn> =>
    Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(""), json: () => Promise.resolve(body) });

  const renamed = await listPullRequestFiles({
    repo: "acme/oe",
    number: 1,
    token: "t",
    apiBase: "https://api.test",
    fetchFn: () => ok([{ filename: "docs/moved.ts", previous_filename: "packages/core/agent/access/bundle.ts" }]),
  });
  if (!renamed.includes("packages/core/agent/access/bundle.ts")) fail("4: a rename must report its previous path too");

  interface Outcome {
    readonly threw: boolean;
    readonly detail: string;
    readonly error?: Error;
  }
  const outcome = (p: Promise<string[]>): Promise<Outcome> =>
    p.then(
      (list): Outcome => ({ threw: false, detail: `resolved with ${list.length} file(s)` }),
      (err: Error): Outcome => ({ threw: true, detail: err.message, error: err }),
    );

  const truncated = await outcome(
    listPullRequestFiles({ repo: "acme/oe", number: 1, token: "t", apiBase: "https://api.test", fetchFn: () => ok(page(100)) }),
  );
  if (!truncated.threw || !truncated.detail.includes("truncates")) {
    fail(`4: a listing that never ends (GitHub's 3000-file cap) must throw — a partial diff must never read as clean. Got: ${truncated.detail}`);
  }

  const refused = await outcome(
    listPullRequestFiles({
      repo: "acme/oe",
      number: 1,
      token: "t",
      apiBase: "https://api.test",
      fetchFn: () => Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve("no"), json: () => Promise.resolve([]) }),
    }),
  );
  if (!refused.threw || !refused.detail.includes("403")) {
    fail(`4: a non-ok API response must throw, never yield an empty (clean-reading) file list. Got: ${refused.detail}`);
  }

  const never: FenceFetchFn = () => new Promise(() => {});

  const perRequest = await outcome(
    listPullRequestFiles({ repo: "acme/oe", number: 1, token: "t", apiBase: "https://api.test", fetchFn: never, requestTimeoutMs: 25, totalTimeoutMs: 5_000 }),
  );
  if (!perRequest.threw || !perRequest.detail.includes("did not answer within")) {
    fail(`4b: a request that never settles must refuse on the per-request bound, never hang. Got: ${perRequest.detail}`);
  }
  if (!(perRequest.error instanceof FenceFetchTimeoutError) || perRequest.error.reason !== "fetch-timeout") {
    fail(`4b: the per-request refusal must be the NAMED FenceFetchTimeoutError carrying reason "fetch-timeout". Got: ${perRequest.error?.constructor.name}`);
  }

  const headersThenStall: FenceFetchFn = () =>
    Promise.resolve({ ok: true, status: 200, text: () => new Promise<string>(() => {}), json: () => new Promise<unknown>(() => {}) });
  const stalledBody = await outcome(
    listPullRequestFiles({ repo: "acme/oe", number: 1, token: "t", apiBase: "https://api.test", fetchFn: headersThenStall, requestTimeoutMs: 25, totalTimeoutMs: 5_000 }),
  );
  if (!stalledBody.threw || !(stalledBody.error instanceof FenceFetchTimeoutError)) {
    fail(`4b: a response whose BODY never settles must refuse on the same bound as the request. Got: ${stalledBody.detail}`);
  }

  const readings = [0, 0, 400, 900, 1_500];
  let tick = 0;
  let pagesFetched = 0;
  const totalBudget = await outcome(
    listPullRequestFiles({
      repo: "acme/oe",
      number: 1,
      token: "t",
      apiBase: "https://api.test",
      fetchFn: () => {
        pagesFetched++;
        return ok(page(100));
      },
      totalTimeoutMs: 1_000,
      now: () => readings[Math.min(tick++, readings.length - 1)] ?? 0,
    }),
  );
  if (!totalBudget.threw || !totalBudget.detail.includes("outlasted its 1000 ms budget")) {
    fail(`4b: the pagination loop must refuse on its whole-listing budget, not only per request. Got: ${totalBudget.detail}`);
  }
  if (!totalBudget.detail.includes("at page 4") || pagesFetched !== 3) {
    fail(`4b: the budget must be spent ACROSS pages — 3 fetched, then a refusal at page 4. Got ${pagesFetched} fetched, detail: ${totalBudget.detail}`);
  }
  if (!(totalBudget.error instanceof FenceFetchTimeoutError)) {
    fail(`4b: the whole-listing refusal must also be the NAMED FenceFetchTimeoutError. Got: ${totalBudget.error?.constructor.name}`);
  }

  const healthy = await outcome(
    listPullRequestFiles({ repo: "acme/oe", number: 1, token: "t", apiBase: "https://api.test", fetchFn: () => ok([{ filename: "docs/x.md" }]) }),
  );
  if (healthy.threw) fail(`4b: a listing that answers immediately must NOT be refused by the timeout path. Got: ${healthy.detail}`);
}

{
  const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const DRIVER = join(ROOT, "scripts", "upgrade-diff-fence.ts");
  const tmp = mkdtempSync(join(tmpdir(), "oe-fence-"));

  let files: { filename: string }[] = [];
  const server = createServer((req, res) => {
    const page = Number(new URL(req.url ?? "/", "http://x").searchParams.get("page") ?? "1");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(page === 1 ? files : []));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const runDriver = (eventPath: string, token: string): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [TSX, DRIVER],
        {
          cwd: ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: "acme/oe",
            GITHUB_TOKEN: token,
            GITHUB_API_URL: `http://127.0.0.1:${port}`,
          },
        },
        (err, stdout, stderr) => {
          const code = err ? ((err as { code?: number }).code ?? -1) : 0;
          resolve({ code, out: `${stdout}${stderr}` });
        },
      );
    });

  const run = async (
    caseName: string,
    changed: string[],
    user: { login: string; type: string },
    body: string,
  ): Promise<{ code: number; out: string }> => {
    files = changed.map((filename) => ({ filename }));
    const eventPath = join(tmp, `${caseName}.json`);
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7, title: "chore: upgrade", body, user } }));
    return runDriver(eventPath, "test-token");
  };

  const BOT_USER = { login: "open-everywhere[bot]", type: "Bot" };
  const PERSON_USER = { login: "example-owner", type: "User" };

  const red = await run("refuse", [...CLEAN_UPGRADE_DIFF, "packages/core/agent/approvals/session-grant.ts"], BOT_USER, MARKED_BODY);
  if (red.code !== 1) fail(`5: the job must EXIT 1 on an access-plane diff — got exit ${red.code}\n${red.out}`);
  if (!red.out.includes("REFUSED")) fail(`5: the refusal must say so in the job log — got:\n${red.out}`);
  if (!red.out.includes("::error file=packages/core/agent/approvals/session-grant.ts::")) {
    fail(`5: the refusal must annotate the offending file — got:\n${red.out}`);
  }

  const green = await run("pass", CLEAN_UPGRADE_DIFF, BOT_USER, MARKED_BODY);
  if (green.code !== 0) fail(`5: a clean upgrade diff must EXIT 0 — got exit ${green.code}\n${green.out}`);
  if (green.out.includes("REFUSED")) fail(`5: negative control — the clean run must not print a refusal:\n${green.out}`);
  if (!green.out.includes("no protected path changed")) fail(`5: the clean run must say what it checked — got:\n${green.out}`);

  const person = await run("person-refuse", ["agent/access/bundles.ts"], PERSON_USER, "hand-written config change");
  if (person.code !== 1) fail(`5: a PERSON-authored protected-path change must EXIT 1 — the fence reads no author since OPE-1315. Got exit ${person.code}\n${person.out}`);
  if (!person.out.includes("REFUSED")) fail(`5: the person-authored refusal must say REFUSED in the job log — got:\n${person.out}`);
  if (!person.out.includes(OVERRIDE_REMEDY)) fail(`5: the person-authored refusal must name the remedy "${OVERRIDE_REMEDY}" — got:\n${person.out}`);
  if (!person.out.includes("::error file=agent/access/bundles.ts::")) fail(`5: the person-authored refusal must annotate the file as an ERROR — got:\n${person.out}`);
  if (person.out.includes("::warning file=")) fail(`5: the warn lane is deleted — no annotation may be a warning:\n${person.out}`);

  const personClean = await run("person-pass", CLEAN_UPGRADE_DIFF, PERSON_USER, "hand-written config change");
  if (personClean.code !== 0) fail(`5: a person's clean diff must still EXIT 0 — got exit ${personClean.code}\n${personClean.out}`);

  files = CLEAN_UPGRADE_DIFF.map((filename) => ({ filename }));
  const eventPath = join(tmp, "notoken.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7, title: "t", body: "", user: { login: "x", type: "User" } } }));
  const noToken = await runDriver(eventPath, "");
  if (noToken.code !== 1) fail(`5: a fence with no credential must EXIT 1, not report clean — got exit ${noToken.code}\n${noToken.out}`);

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

{
  const r = judgeUpgradeDiff({ changedFiles: ["packages/core/agent/audit/chain.ts"] });
  const text = formatUpgradeFenceReport(r, 1).join("\n");
  if (!text.includes("core-audit-chain")) fail("report: the rule id must appear so a reader can find the manifest entry");
  if (!text.includes("packages/core/agent/audit/chain.ts")) fail("report: the offending file must appear");
}

if (problems.length > 0) {
  console.error(`✗ upgrade-diff-fence: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `✓ upgrade-diff-fence: ${PROTECTED_PATH_RULES.length} protected rules all join a real path; an access-plane diff exits the job RED for a person-authored pull request as well as a bot-authored one, and a clean upgrade diff exits 0; the refusal names the orchestrator review-and-override; the listing fails closed`,
);

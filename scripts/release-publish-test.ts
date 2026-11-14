import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTag, packArgs, publishOrder, readWorkspacePackages, siblingsOf } from "./release-plan.js";
import type { WorkspacePackage } from "./release-plan.js";
import {
  MIN_NPM_VERSION,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_FILE,
  checkPlan,
  checkRunContext,
  publishArgs,
  registryState,
  runPlan,
  sha512,
  versionAtLeast,
} from "./release-publish.js";
import type { ReleasePlan, RunContext } from "./release-publish.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const tagPush: RunContext = { repository: RELEASE_REPOSITORY, eventName: "push", ref: "refs/tags/v0.8.0", repositoryPrivate: false };
const manual: RunContext = { repository: RELEASE_REPOSITORY, eventName: "workflow_dispatch", ref: "refs/heads/main", repositoryPrivate: false };

ok(checkRunContext(tagPush, "v0.8.0").length === 0, "a tag push in the public release repository may publish");
ok(checkRunContext(manual, "v0.8.0").length === 0, "a manual run from main that names a tag may publish");
ok(checkRunContext({ ...tagPush, repository: "someone/open-everywhere" }, "v0.8.0").length === 1, "🔴 a FORK never publishes");
ok(checkRunContext({ ...tagPush, repository: "example/another-repo" }, "v0.8.0").length === 1, "🔴 a repository with another name never publishes");
ok(checkRunContext({ ...tagPush, repository: undefined }, "v0.8.0").length === 1, "🔴 a run with no repository never publishes");
ok(checkRunContext({ ...tagPush, ref: "refs/heads/main" }, "v0.8.0").length === 1, "🔴 a BRANCH push never publishes");
ok(checkRunContext({ ...tagPush, ref: "refs/tags/v0.7.0" }, "v0.8.0").length === 1, "🔴 a tag push publishes only its own tag");
ok(checkRunContext({ ...manual, ref: "refs/heads/feature" }, "v0.8.0").length === 1, "🔴 a manual run from a branch other than main never publishes");
for (const eventName of ["pull_request", "pull_request_target", "schedule", "workflow_run", "workflow_call", "release", undefined]) {
  ok(checkRunContext({ ...tagPush, eventName }, "v0.8.0").length === 1, `🔴 the event ${eventName ?? "(none)"} never publishes`);
}
ok(checkRunContext({ ...tagPush, repositoryPrivate: true }, "v0.8.0").length === 1, "🔴 a PRIVATE release repository never publishes: npm gives it no provenance");
ok(checkRunContext({ ...tagPush, repositoryPrivate: undefined }, "v0.8.0").length === 1, "🔴 an unknown visibility is refused, not assumed public");
for (const bad of ["0.8.0", "v0.8", "v0.8.0-rc.1", "v08.0.0", "v0.8.0 ", "main", ""]) {
  ok(checkRunContext({ ...tagPush, ref: `refs/tags/${bad}` }, bad).length >= 1, `🔴 "${bad}" is not a release tag`);
}
ok(
  checkRunContext({ repository: "x/y", eventName: "pull_request", ref: "refs/pull/1/merge", repositoryPrivate: true }, "nope").length === 4,
  "every failed condition is reported, not only the first",
);

ok(versionAtLeast(MIN_NPM_VERSION, "11.5.1") && MIN_NPM_VERSION === "11.5.1", "the npm floor is the 11.5.1 that npm's docs state");
ok(versionAtLeast("11.5.1", MIN_NPM_VERSION), "npm 11.5.1 is enough");
ok(versionAtLeast("11.19.1", MIN_NPM_VERSION), "npm 11.19.1 is enough (a numeric compare, not a string compare)");
ok(versionAtLeast("12.0.0", MIN_NPM_VERSION), "npm 12.0.0 is enough");
ok(!versionAtLeast("11.5.0", MIN_NPM_VERSION), "🔴 npm 11.5.0 is refused");
ok(!versionAtLeast("10.9.4", MIN_NPM_VERSION), "🔴 npm 10 is refused");
ok(!versionAtLeast("eleven", MIN_NPM_VERSION), "🔴 an unreadable version is refused");

const head = "a".repeat(40);
ok(checkTag("v0.8.0", "0.8.0", head, head).length === 0, "the tag that names core's version, at HEAD, packs");
ok(checkTag("v0.8.1", "0.8.0", head, head).length === 1, "🔴 a tag that names another version than core's is refused");
ok(checkTag("v0.8.0", "0.8.0", head, undefined).length === 1, "🔴 a tag that does not exist is refused");
ok(checkTag("v0.8.0", "0.8.0", head, "b".repeat(40)).length === 1, "🔴 a checkout that is not the tag's commit is refused");
ok(checkTag("v0.8.0-rc.1", "0.8.0-rc.1", head, head).length === 1, "🔴 a prerelease tag is refused");

ok(
  JSON.stringify(siblingsOf({ name: "x", version: "1.0.0", dependencies: { "@open-everywhere/core": "1", tsx: "1" }, peerDependencies: { "@open-everywhere/adapters": "1" }, optionalDependencies: { "@open-everywhere/z": "1" } })) ===
    JSON.stringify(["@open-everywhere/adapters", "@open-everywhere/core", "@open-everywhere/z"]),
  "siblings come from dependencies, peerDependencies and optionalDependencies, and nothing else",
);
ok(
  siblingsOf({ name: "x", version: "1.0.0", devDependencies: { "@open-everywhere/core": "1" } } as never).length === 0,
  "a devDependency is not a sibling: it never reaches a consumer",
);

const real = readWorkspacePackages(root);
ok(real.length === 11, `the plan reads all eleven publishable packages (read ${real.length})`);
const order = publishOrder(real);
const pos = new Map(order.map((p, i) => [p.name, i]));
ok(order[0]!.name === "@open-everywhere/core", "core publishes first: every other package pins it");
for (const p of order) {
  for (const s of p.siblings) ok(pos.get(s)! < pos.get(p.name)!, `${p.name} publishes after ${s}`);
}
ok(pos.get("@open-everywhere/create")! > pos.get("@open-everywhere/provider-slack")!, "the scaffolder publishes after the slack provider it pins");
for (const p of real) {
  const m = JSON.parse(readFileSync(join(root, p.dir, "package.json"), "utf8")) as { repository?: { url?: string } };
  ok(
    m.repository?.url === `git+https://github.com/${RELEASE_REPOSITORY}.git`,
    `${p.name}: repository.url names ${RELEASE_REPOSITORY} exactly — npm refuses a trusted publish otherwise`,
  );
}

const pkg = (name: string, siblings: string[] = []): WorkspacePackage => ({ dir: name, name, version: "1.0.0", siblings });
ok(
  publishOrder([pkg("c", ["b"]), pkg("b", ["a"]), pkg("a")]).map((p) => p.name).join() === "a,b,c",
  "a chain listed backwards publishes forwards",
);
ok(publishOrder([pkg("a"), pkg("z"), pkg("m")]).map((p) => p.name).join() === "a,z,m", "independent packages keep their listed order");
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
ok(throws(() => publishOrder([pkg("a", ["b"]), pkg("b", ["a"])])), "🔴 a dependency cycle is refused, not guessed");
ok(throws(() => publishOrder([pkg("a", ["ghost"])])), "🔴 a sibling outside the publishable set is refused");

const bytes: Record<string, Uint8Array> = {
  "core.tgz": new TextEncoder().encode("core bytes"),
  "slack.tgz": new TextEncoder().encode("slack bytes"),
  "create.tgz": new TextEncoder().encode("create bytes"),
};
const plan: ReleasePlan = {
  tag: "v0.8.0",
  commit: head,
  packages: [
    { dir: "packages/core", name: "@open-everywhere/core", version: "0.8.0", tarball: "core.tgz", sha512: sha512(bytes["core.tgz"]!) },
    { dir: "packages/providers/slack", name: "@open-everywhere/provider-slack", version: "0.8.0", tarball: "slack.tgz", sha512: sha512(bytes["slack.tgz"]!) },
    { dir: "packages/create", name: "@open-everywhere/create", version: "0.8.0", tarball: "create.tgz", sha512: sha512(bytes["create.tgz"]!) },
  ],
};
ok(checkPlan(plan, "v0.8.0", head).length === 0, "a well-formed plan for this tag passes");
ok(checkPlan(plan, "v0.8.1", head).length === 1, "🔴 a plan for another tag is refused");
ok(checkPlan({ ...plan, packages: [] }, "v0.8.0", head).length === 1, "🔴 an empty plan is refused");
ok(checkPlan({ ...plan, packages: [{ ...plan.packages[0]!, name: "left-pad" }] }, "v0.8.0", head).length === 1, "🔴 a package outside the scope is refused");
ok(checkPlan({ ...plan, packages: [{ ...plan.packages[0]!, tarball: "../../x.tgz" }] }, "v0.8.0", head).length === 1, "🔴 a tarball path that leaves the plan directory is refused");
ok(checkPlan({ ...plan, packages: [plan.packages[0]!, plan.packages[0]!] }, "v0.8.0", head).length === 1, "🔴 a package listed twice is refused");
ok(checkPlan(plan, "v0.8.0", "b".repeat(40)).length === 1, "🔴 a publish checkout that is not the packed commit is refused: the tag moved between the jobs");
ok(checkPlan(plan, "v0.8.0", undefined).length === 1, "🔴 an unreadable publish checkout is refused, not assumed equal");
ok(checkPlan({ ...plan, commit: "" }, "v0.8.0", "").length === 1, "🔴 a plan with no commit never matches an empty checkout");

{
  const args = packArgs("packages/core", "/out");
  ok(args.includes("--ignore-scripts"), "🔴 the release packs with --ignore-scripts: the bytes that publish are the dist/ the preview scanned, not a second build");
  ok(args[0] === "pack" && args.includes("--json") && args.join(" ").includes("--workspace packages/core") && args.join(" ").includes("--pack-destination /out"), "…and packs that one workspace into the plan directory");
}

let latestOnNpm: string | undefined = "0.7.0";
async function drive(onNpm: Set<string>, tamper?: string): Promise<{ calls: string[][]; result?: { published: string[]; skipped: string[] }; error?: string }> {
  const calls: string[][] = [];
  try {
    const result = await runPlan(plan, "/plan", false, {
      state: async (name) => ({ published: onNpm.has(name), latest: latestOnNpm }),
      readTarball: (file) => (file.endsWith(tamper ?? "\0") ? new TextEncoder().encode("changed") : bytes[file.replace(/^.*\//, "")]!),
      publish: (args) => calls.push(args),
      log: () => {},
    });
    return { calls, result };
  } catch (err) {
    return { calls, error: String(err) };
  }
}

{
  const { calls, result } = await drive(new Set());
  ok(calls.length === 3, "a fresh version publishes every package");
  ok(calls.map((c) => c[1]).join() === "/plan/core.tgz,/plan/slack.tgz,/plan/create.tgz", "…in the plan's order");
  ok(calls.every((c) => c[0] === "publish" && c.includes("--provenance")), "…and every publish asks for provenance explicitly, so a run that cannot attest fails");
  ok(calls.every((c) => c.includes("--ignore-scripts")), "…and runs no lifecycle script in the job that holds the identity token");
  ok(result!.published.length === 3 && result!.skipped.length === 0, "…and reports three published");
}
{
  const { calls, result } = await drive(new Set(["@open-everywhere/core", "@open-everywhere/provider-slack"]));
  ok(calls.length === 1 && calls[0]![1] === "/plan/create.tgz", "🔴 a re-run after a partial failure publishes only what npm does not hold");
  ok(result!.skipped.join() === "@open-everywhere/core,@open-everywhere/provider-slack", "…and names what it skipped");
}
{
  const { calls } = await drive(new Set(plan.packages.map((p) => p.name)));
  ok(calls.length === 0, "a version npm already holds in full publishes nothing");
}
{
  const { calls, error } = await drive(new Set(), "create.tgz");
  ok(calls.length === 0 && /sha512/.test(error ?? ""), "🔴 a changed LAST tarball publishes NOTHING: every sha512 is checked before the first publish");
}
{
  latestOnNpm = "0.9.0";
  const { calls, error } = await drive(new Set(["@open-everywhere/core"]));
  ok(calls.length === 0 && /move latest backwards/.test(error ?? ""), "🔴 a version below the registry's latest publishes NOTHING: npm would move latest backwards");
  latestOnNpm = "0.8.0";
  const same = await drive(new Set(["@open-everywhere/core"]));
  ok(same.calls.length === 2, "a version equal to latest (a re-run that finishes it) still publishes");
  latestOnNpm = undefined;
  const fresh = await drive(new Set());
  ok(fresh.calls.length === 3, "a package with no latest yet publishes");
  latestOnNpm = "0.7.0";
}
ok(!publishArgs("x.tgz", false).includes("--dry-run") && publishArgs("x.tgz", true).includes("--dry-run"), "--dry-run reaches npm only when asked");

const fakeFetch = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const packument = { "dist-tags": { latest: "0.8.0" }, versions: { "0.7.0": {}, "0.8.0": {} } };
{
  const held = await registryState("@open-everywhere/core", "0.8.0", fakeFetch(200, packument));
  ok(held.published && held.latest === "0.8.0", "a version in the packument is published, and latest is read from dist-tags");
  const absent = await registryState("@open-everywhere/core", "0.9.0", fakeFetch(200, packument));
  ok(!absent.published && absent.latest === "0.8.0", "a version not in the packument is absent");
  const none = await registryState("@open-everywhere/core", "0.8.0", fakeFetch(404));
  ok(!none.published && none.latest === undefined, "a 404 means the registry has no such package");
}
{
  let threw = false;
  try {
    await registryState("@open-everywhere/core", "0.8.0", fakeFetch(503));
  } catch {
    threw = true;
  }
  ok(threw, "🔴 any other answer stops the run: a registry outage is not 'absent'");
}
{
  let asked = "";
  await registryState("@open-everywhere/core", "0.8.0", (async (url: string) => {
    asked = url;
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch);
  ok(asked === "https://registry.npmjs.org/@open-everywhere%2fcore", "the registry is asked for the exact scoped name");
}

const wfPath = join(root, ".github", "workflows", RELEASE_WORKFLOW_FILE);
const wf = readFileSync(wfPath, "utf8");
const code = wf
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");
const onBlock = /^on:\n([\s\S]*?)\n(?=\S)/m.exec(code)?.[1] ?? "";
const triggers = [...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
ok(triggers.join() === "push,workflow_dispatch", `the workflow has exactly two triggers, push and workflow_dispatch (has: ${triggers.join()})`);
ok(/^ {2}push:\n {4}tags:\n {6}- "v\*"\n/m.test(onBlock), "🔴 the push trigger is tags only: a branch push never starts it");
ok(!/branches/.test(onBlock), "🔴 no branch filter exists, so no branch push matches");
ok(/^ {6}tag:\n[\s\S]*?^ {8}required: true$/m.test(onBlock), "a manual run must name a tag");
ok(/^permissions: \{\}$/m.test(code), "the workflow-level token has no permission at all");
ok(
  /^concurrency:\n {2}group: npm-publish-\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref_name \}\}\n {2}cancel-in-progress: false$/m.test(code),
  "🔴 the concurrency group is keyed on the tag: a pending run for one tag never cancels another tag's run",
)

const jobs = code.split(/^jobs:\n/m)[1] ?? "";
const packJob = /^ {2}pack:\n([\s\S]*?)(?=^ {2}\S)/m.exec(jobs)?.[1] ?? "";
const publishJob = /^ {2}publish:\n([\s\S]*)$/m.exec(jobs)?.[1] ?? "";
ok(packJob.length > 0 && publishJob.length > 0, "the workflow has a pack job and a publish job");
ok([...jobs.matchAll(/^ {2}([a-z-]+):$/gm)].length === 2, "the workflow has no third job");
const guard =
  "    if: >-\n" +
  "      github.repository == 'open-everywhere/open-everywhere'\n" +
  "      && ((github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v'))\n" +
  "      || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'))\n";
ok(guard.includes(`'${RELEASE_REPOSITORY}'`), "the guard names RELEASE_REPOSITORY");
ok(packJob.includes(guard), "🔴 the pack job runs only in the release repository, on a tag push or a manual run from main");
ok(publishJob.includes(guard), "🔴 the publish job carries the same guard, so it never runs in another repository or a fork");
ok(/^ {4}needs: pack$/m.test(publishJob), "the publish job waits for the pack job");
ok(/^ {6}id-token: write$/m.test(publishJob), "the publish job may ask for the identity token that npm trusts");
ok(!/id-token/.test(packJob), "🔴 the pack job, which installs dependencies, holds NO identity token");
ok(!/contents: write/.test(code), "no job can write to the repository");
ok(!/\bnpm (ci|install|i)\b|\bnpx\b|\btsx\b/.test(publishJob), "🔴 the publish job installs and runs no dependency");
ok(/run: node scripts\/release-publish\.ts --plan "\$RUNNER_TEMP\/release\/plan\.json"$/m.test(publishJob), "the publish job runs the publish script with plain node");
ok(/run: npx tsx scripts\/release-plan\.ts --out "\$RUNNER_TEMP\/release"$/m.test(packJob), "the pack job runs the pack script");
ok(/run: npm run publish:preview$/m.test(packJob), "the pack job refuses a secret in the tarballs before it packs the plan");
ok(!/secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN/.test(code), "🔴 no token or secret appears: npm trusted publishing needs none");
function runBodies(text: string): string[] {
  const lines = text.split("\n");
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    if (!/^[|>][-+]?\s*$/.test(m[2]!)) {
      bodies.push(m[2]!);
      continue;
    }
    const block: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1]!.trim() === "" || /^\s*/.exec(lines[i + 1]!)![0].length > indent)) block.push(lines[++i]!);
    bodies.push(block.join("\n"));
  }
  return bodies;
}
const hasExpr = (body: string): boolean => /\$\{\{[\s\S]*?\}\}/.test(body);
ok(runBodies("      - run: echo ${{ inputs.tag }}\n").some(hasExpr), "the injection check sees an expression on a one-line run:");
ok(
  runBodies("      - name: x\n        run: |\n          echo start\n          echo ${{ inputs.tag }}\n      - name: y\n").some(hasExpr),
  "🔴 the injection check sees an expression INSIDE a `run: |` block, not only on the run: line",
);
ok(!runBodies("      - run: |\n          echo ok\n      - uses: x\n        with:\n          ref: ${{ env.T }}\n").some(hasExpr), "…and does not count a with: input after the block");
ok(runBodies(code).length >= 4, "the workflow's run: steps are all read");
ok(!runBodies(code).some(hasExpr), "🔴 no `run:` body expands an expression, one-line or block, so a tag input cannot inject shell");
for (const m of code.matchAll(/^\s+(?:- )?uses: (\S+)/gm)) {
  ok(/^actions\/[a-z-]+@[0-9a-f]{40}$/.test(m[1]!), `${m[1]} is a first-party action pinned to a full commit sha`);
}
ok(!/self-hosted/.test(code) && /runs-on: ubuntu-latest/.test(publishJob), "the publish job runs on a GitHub-hosted runner, the only kind npm trusts");
ok(/persist-credentials: false/.test(packJob) && /persist-credentials: false/.test(publishJob), "no checkout keeps the GitHub token on disk");

const publishSrc = readFileSync(join(root, "scripts", "release-publish.ts"), "utf8");
for (const m of publishSrc.matchAll(/^import .* from "([^"]+)";$/gm)) {
  ok(m[1]!.startsWith("node:"), `release-publish.ts imports only node: modules (found ${m[1]})`);
}

const tmp = mkdtempSync(join(tmpdir(), "oe-release-publish-"));
const eventFile = join(tmp, "event.json");
writeFileSync(eventFile, JSON.stringify({ repository: { private: false } }));
const planFile = join(tmp, "plan.json");
writeFileSync(planFile, JSON.stringify(plan));
function runNode(env: Record<string, string>): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(root, "scripts", "release-publish.ts"), "--plan", planFile], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: tmp, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
{
  const r = runNode({ GITHUB_REPOSITORY: "example/another-repo", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v0.8.0", GITHUB_EVENT_PATH: eventFile, RELEASE_TAG: "v0.8.0" });
  ok(!/ERR_|SyntaxError|Cannot find/.test(r.out), `plain node starts the script with its own type stripping (output: ${r.out.slice(0, 200)})`);
  ok(r.status === 1 && /only open-everywhere\/open-everywhere publishes/.test(r.out) && /Nothing was published/.test(r.out), "🔴 a run in another repository exits 1 and publishes nothing");
}
{
  const r = runNode({ GITHUB_REPOSITORY: RELEASE_REPOSITORY, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_PATH: eventFile, RELEASE_TAG: "v0.8.0" });
  ok(r.status === 1 && /Nothing was published/.test(r.out), "🔴 a BRANCH push in the release repository exits 1 and publishes nothing");
}
{
  const r = runNode({ GITHUB_REPOSITORY: RELEASE_REPOSITORY, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v0.8.0", RELEASE_TAG: "v0.8.0" });
  ok(r.status === 1 && /provenance is not certain/.test(r.out), "🔴 a run with no event payload exits 1: visibility unknown");
}

console.log(`✓ release-publish: ${passed} checks passed`);

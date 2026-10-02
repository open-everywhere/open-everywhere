import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAll, isSetupRoute, SETUP_ROUTES, type SetupStep, type StepContext } from "../src/engine.js";
import { SETUP_STEPS } from "../src/steps/index.js";
import { databaseStep } from "../src/steps/database.js";
import { repoStep } from "../src/steps/repo.js";
import { rosterStep } from "../src/steps/roster.js";
import { verifyStep, verifyVerdict } from "../src/steps/verify.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const ctx: StepContext = { cwd: "/fake", env: {} };

function step(parts: Partial<SetupStep> & Pick<SetupStep, "id" | "check">): SetupStep {
  return {
    title: parts.id,
    guide: () => ({ summary: "", instructions: [] }),
    ...parts,
  } as SetupStep;
}

{
  ok(JSON.stringify([...SETUP_ROUTES]) === JSON.stringify(["vercel", "docker"]), "SETUP_ROUTES is exactly vercel and docker, in that order");
  ok(isSetupRoute("vercel") && isSetupRoute("docker"), "isSetupRoute accepts both supported routes");
  ok(!isSetupRoute("local") && !isSetupRoute("hosted") && !isSetupRoute("fly"), "isSetupRoute rejects the retired goals and any other host");

  for (const s of SETUP_STEPS) {
    ok(!("automate" in s), `step ${s.id} carries no automate() — the engine is read-only`);
  }
  const engine = await import("../src/engine.js");
  for (const gone of ["runWizard", "goalOf"]) {
    ok(!(gone in engine), `engine.ts exports no ${gone} (it went with the wizard)`);
  }
  ok(!SETUP_STEPS.some((s) => s.id === "telemetry-disclosure"), "the step list carries no telemetry-disclosure step");
}

{
  let guideCalls = 0;
  const satisfiedStep = step({ id: "a", check: () => ({ satisfied: true, detail: "ok" }) });
  const unsatisfiedStep = step({
    id: "b",
    check: () => ({ satisfied: false, detail: "nope" }),
    guide: () => {
      guideCalls++;
      return { summary: "x", instructions: [] };
    },
  });

  const summary = await checkAll([satisfiedStep, unsatisfiedStep], ctx);
  ok(summary.satisfiedCount === 1, "checkAll: counts satisfied steps");
  ok(summary.total === 2, "checkAll: total is the step count");
  ok(!summary.allSatisfied, "checkAll: not all satisfied when one isn't");
  ok(guideCalls === 0, "checkAll: NEVER calls guide() — pure status only");

  const thrower = step({ id: "boom", check: () => { throw new Error("kaboom"); } });
  const withThrow = await checkAll([satisfiedStep, thrower], ctx);
  ok(withThrow.total === 2 && withThrow.satisfiedCount === 1, "checkAll: a throwing check() is one unsatisfied step, not a crash");
  ok(/check failed: kaboom/.test(withThrow.results[1]!.check.detail), "checkAll: …and the detail names the failure");
}

{
  const scratch = (projectId?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "oe-dbstep-"));
    if (projectId !== undefined) {
      mkdirSync(join(dir, ".vercel"), { recursive: true });
      writeFileSync(join(dir, ".vercel", "project.json"), JSON.stringify({ projectId }));
    }
    return dir;
  };

  const unlinked = scratch();
  try {
    for (const route of SETUP_ROUTES) {
      const res = await databaseStep.check({ cwd: unlinked, env: {}, route });
      ok(!res.satisfied, `databaseStep: the ${route} route with no database is NOT satisfied`);
      ok(/Missing from \.env\.local and this shell: DATABASE_URL/.test(res.detail), `databaseStep (${route}): …and it names the one missing variable`);
      ok(!/OE_OPERATIONAL_PROVIDER=postgres|OE_MEMORY_PROVIDER=postgres/.test(res.detail), `databaseStep (${route}): …and demands neither store selector`);
      ok(typeof res.next === "string" && res.next.length > 0, `databaseStep (${route}): …and carries a next action`);
    }
    for (const route of SETUP_ROUTES) {
      const derived = await databaseStep.check({ cwd: unlinked, env: { DATABASE_URL: "postgres://u:p@h/db" }, route });
      ok(derived.satisfied, `databaseStep: a bare DATABASE_URL satisfies the ${route} route (no selector needed)`);
      ok(/selects postgres for both stores/.test(derived.detail), `databaseStep (${route}): …and the detail says why`);
      const away = await databaseStep.check({ cwd: unlinked, env: { DATABASE_URL: "postgres://u:p@h/db", OE_MEMORY_PROVIDER: "git" }, route });
      ok(!away.satisfied && /points away from postgres: OE_MEMORY_PROVIDER/.test(away.detail), `databaseStep (${route}): a selector pointed away from postgres blocks, and is named`);
    }
    ok(/Marketplace/.test((await databaseStep.check({ cwd: unlinked, env: {} })).next ?? ""), "databaseStep: the vercel route's next action names the Vercel Marketplace Neon integration");
    const dockerNext = (await databaseStep.check({ cwd: unlinked, env: {}, route: "docker" })).next ?? "";
    ok(!/Marketplace/.test(dockerNext) && /container can reach/.test(dockerNext), "databaseStep: the docker route's next action never names the Vercel Marketplace");
    ok(/vercel env ls/.test((await databaseStep.check({ cwd: unlinked, env: {} })).detail), "databaseStep: a vercel-route miss says the value may be set on the Vercel project instead");
    ok(/docker inspect/.test((await databaseStep.check({ cwd: unlinked, env: {}, route: "docker" })).detail), "databaseStep: a docker-route miss names the container's environment instead");
  } finally {
    rmSync(unlinked, { recursive: true, force: true });
  }

  const linked = scratch("prj_abc123");
  try {
    const res = await databaseStep.check({ cwd: linked, env: {} });
    ok(!res.satisfied, "databaseStep: a Vercel-linked checkout on the embedded floor is NOT satisfied");
    ok(/ephemeral|replaced container|loses/i.test(databaseStep.guide({ cwd: linked, env: {} }).summary), "databaseStep: the guide states the consequence, not just the missing var");

    const allButDb = { prereq: true, repo: true, slack: true, database: false, build: true };
    const verdict = verifyVerdict(allButDb);
    ok(!verdict.satisfied, "verifyVerdict: everything satisfied EXCEPT the state backing is still not ready");
    ok(/durable state backing/.test(verdict.detail), "verifyVerdict: names the durable state backing among what is missing");
    ok(verifyVerdict({ ...allButDb, database: true }).satisfied, "verifyVerdict: flipping only the state backing makes it ready (the term is load-bearing)");

    const wired = await verifyStep.check({ cwd: linked, env: {} });
    ok(/durable state backing/.test(wired.detail), "verifyStep: the wired check surfaces the state backing for a linked checkout with no Postgres");
  } finally {
    rmSync(linked, { recursive: true, force: true });
  }

  const full = scratch("prj_abc123");
  try {
    const env = { OE_MEMORY_PROVIDER: "postgres", OE_OPERATIONAL_PROVIDER: "postgres", DATABASE_URL: "postgres://u:p@h/db" };
    for (const route of SETUP_ROUTES) {
      ok((await databaseStep.check({ cwd: full, env, route })).satisfied, `databaseStep: postgres + DATABASE_URL satisfies the ${route} route`);
    }
  } finally {
    rmSync(full, { recursive: true, force: true });
  }
}

{
  const app = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "oe-repostep-"));
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, body);
    }
    return dir;
  };
  const CORE_PKG = JSON.stringify({ dependencies: { "@open-everywhere/core": "^1.0.0" } });

  const thin = app({ "package.json": CORE_PKG, "agent/agent.ts": "export default {};", "node_modules/.keep": "" });
  try {
    const res = await repoStep.check({ cwd: thin, env: {} });
    ok(res.satisfied, "repoStep: a thin consumer app with no AGENTS.md is recognised");
  } finally {
    rmSync(thin, { recursive: true, force: true });
  }

  const mono = app({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "agent/agent.ts": "export default {};",
    "node_modules/.keep": "",
  });
  try {
    ok((await repoStep.check({ cwd: mono, env: {} })).satisfied, "repoStep: the workspaces monorepo shape still passes");
  } finally {
    rmSync(mono, { recursive: true, force: true });
  }

  const noEntry = app({ "package.json": CORE_PKG, "node_modules/.keep": "" });
  try {
    const res = await repoStep.check({ cwd: noEntry, env: {} });
    ok(!res.satisfied, "repoStep: a directory with no agent/agent.ts is not an OE app");
    ok(/agent\/agent\.ts/.test(res.detail), "repoStep: says which boot-critical file is missing");
  } finally {
    rmSync(noEntry, { recursive: true, force: true });
  }

  const unrelated = app({ "package.json": JSON.stringify({ dependencies: { express: "^4" } }), "agent/agent.ts": "x", "node_modules/.keep": "" });
  try {
    const res = await repoStep.check({ cwd: unrelated, env: {} });
    ok(!res.satisfied, "repoStep: a package.json that doesn't reach @open-everywhere/core is rejected");
  } finally {
    rmSync(unrelated, { recursive: true, force: true });
  }

  const noDeps = app({ "package.json": CORE_PKG, "agent/agent.ts": "export default {};" });
  try {
    const res = await repoStep.check({ cwd: noDeps, env: {} });
    ok(!res.satisfied && /npm install/.test(res.detail), "repoStep: an uninstalled app is told to run npm install");
  } finally {
    rmSync(noDeps, { recursive: true, force: true });
  }
}

{
  const scaffold = (opts: { readonly config?: boolean; readonly lock?: boolean; readonly oe?: "clean" | "drifted" }) => {
    const dir = mkdtempSync(join(tmpdir(), "oe-rosterstep-"));
    if (opts.config !== false) writeFileSync(join(dir, "roster.config.ts"), "export default {};\n");
    if (opts.lock !== false) writeFileSync(join(dir, "roster.lock.json"), "{}\n");
    if (opts.oe !== undefined) {
      const core = join(dir, "node_modules", "@open-everywhere", "core");
      const bin = join(core, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(core, "package.json"), JSON.stringify({ name: "@open-everywhere/core", bin: { oe: "bin/oe.js" } }));
      writeFileSync(
        join(bin, "oe.js"),
        opts.oe === "clean"
          ? "#!/usr/bin/env node\nconsole.log('ok');\n"
          : "#!/usr/bin/env node\nconsole.error('  - DRIFTED · agent/tools/reply.ts differs from the plan');\nprocess.exit(1);\n",
        { mode: 0o755 },
      );
    }
    return dir;
  };

  const clean = scaffold({ oe: "clean" });
  try {
    const res = await rosterStep.check({ cwd: clean, env: {} });
    ok(res.satisfied, "rosterStep: a materialised tree that matches the declaration is satisfied");
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }

  const drifted = scaffold({ oe: "drifted" });
  try {
    const before = await rosterStep.check({ cwd: drifted, env: {} });
    ok(!before.satisfied, "rosterStep: a tree that differs from the declaration leaves the step unsatisfied");
    ok(/DRIFTED/.test(before.detail), "rosterStep: the detail carries the CLI's own red");
    ok(/oe build/.test(before.next ?? ""), "rosterStep: …and the next action is the command the operator runs");
  } finally {
    rmSync(drifted, { recursive: true, force: true });
  }

  const noConfig = scaffold({ config: false, oe: "clean" });
  try {
    const res = await rosterStep.check({ cwd: noConfig, env: {} });
    ok(!res.satisfied, "rosterStep: a checkout with no roster.config.ts is UNSATISFIED, not vacuously clean");
    ok(/roster\.config\.ts/.test(res.detail), "rosterStep: says which file is missing");
  } finally {
    rmSync(noConfig, { recursive: true, force: true });
  }

  const noLock = scaffold({ lock: false, oe: "clean" });
  try {
    const res = await rosterStep.check({ cwd: noLock, env: {} });
    ok(!res.satisfied, "rosterStep: a checkout with no roster.lock.json has reviewed nothing and is UNSATISFIED");
    ok(/REVIEWED/.test(res.detail), "rosterStep: names the property that is missing, not just the file");
  } finally {
    rmSync(noLock, { recursive: true, force: true });
  }

  const noBin = scaffold({});
  try {
    const res = await rosterStep.check({ cwd: noBin, env: {} });
    ok(!res.satisfied, "rosterStep: with no `oe` CLI the step is UNKNOWN, never clean");
    ok(/npm install/.test(res.detail), "rosterStep: says what to do about it");
  } finally {
    rmSync(noBin, { recursive: true, force: true });
  }
}

{
  const { buildDeployStep } = await import("../src/steps/build-deploy.js");
  const { slackStep } = await import("../src/steps/slack.js");
  const { vercelStep } = await import("../src/steps/vercel.js");
  const { envChecklistStep } = await import("../src/steps/env-checklist.js");
  const { nodeVerdict } = await import("../src/steps/prerequisites.js");
  const { probeDeployment, normalizeHost, DEPLOY_PROBE_PATH } = await import("../src/deploy-probe.js");
  const { createServer } = await import("node:http");
  const { missNote } = await import("../src/env-file.js");

  const dir = mkdtempSync(join(tmpdir(), "oe-route-"));
  try {
    const vVercel = await vercelStep.check({ cwd: dir, env: {} });
    ok(!vVercel.satisfied && vVercel.next === "npx vercel link", "vercelStep: the vercel route + unlinked is unsatisfied, next = `npx vercel link`");
    const vDocker = await vercelStep.check({ cwd: dir, env: {}, route: "docker" });
    ok(vDocker.satisfied && /Docker route/.test(vDocker.detail), "vercelStep: the docker route needs no Vercel project, and says so");

    const sNone = await slackStep.check({ cwd: dir, env: {} });
    ok(!sNone.satisfied && /SLACK_BOT_TOKEN/.test(sNone.detail) && /SLACK_SIGNING_SECRET/.test(sNone.detail), "slackStep: names both missing variables");
    const sOne = await slackStep.check({ cwd: dir, env: { SLACK_BOT_TOKEN: "x" } });
    ok(!sOne.satisfied && /SLACK_SIGNING_SECRET/.test(sOne.detail) && !/SLACK_BOT_TOKEN/.test(sOne.detail), "slackStep: …and only the one still missing");
    ok(typeof sOne.next === "string" && sOne.next.length > 0, "slackStep: …with a next action");
    ok(!(await slackStep.check({ cwd: dir, env: {}, route: "docker" })).satisfied, "slackStep: the docker route does NOT exempt Slack");
    ok((await slackStep.check({ cwd: dir, env: { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y" } })).satisfied, "slackStep: satisfied once both are set (negative control)");
    ok(/scaffold_env/.test(sNone.next ?? ""), "slackStep: the next action hands the write to the ops tool, not to a prompt");
    ok(sNone.detail.includes(missNote("vercel")), "slackStep: a miss says the value may be set on the deployment instead");

    ok(/missing from \.env\.local and this shell/.test(sNone.detail), "slackStep: a miss names the two homes it READ, never a bare `missing`");
    ok(/credential store/.test(sNone.detail) && /status endpoint/.test(sNone.detail), "slackStep: …and names the home it cannot read, plus what can see it");
    ok(/\/setup/.test(sNone.next ?? ""), "slackStep: the next action offers /setup as the no-env-var path");
    const sBoth = await slackStep.check({ cwd: dir, env: { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y" } });
    ok(/IGNORE/.test(sBoth.detail) && /CLOSES \/setup/.test(sBoth.detail), "slackStep: a satisfied check warns that these two variables make a stored credential inert and close /setup");

    const manifestIn = (lines: readonly string[]): { display_information: { name: string } } =>
      JSON.parse(lines.find((l) => l.trimStart().startsWith("{")) ?? "{}");
    ok(manifestIn(slackStep.guide({ cwd: dir, env: {} }).instructions).display_information.name === "Open Everywhere", "slackStep guide: the default app name");
    ok(
      manifestIn(slackStep.guide({ cwd: dir, env: {}, appName: "Acme Agent" }).instructions).display_information.name === "Acme Agent",
      "slackStep guide: --app-name names the app in the printed manifest",
    );

    const envVercel = await envChecklistStep.check({ cwd: dir, env: {} });
    ok(!envVercel.satisfied && !/AI_GATEWAY_API_KEY/.test(envVercel.detail) && /deploy store: operational = postgres/.test(envVercel.detail), "envChecklist: the vercel route asks for the stores, not a gateway key");
    const envDocker = await envChecklistStep.check({ cwd: dir, env: {}, route: "docker" });
    ok(!envDocker.satisfied && /AI_GATEWAY_API_KEY/.test(envDocker.detail) && /deploy store: operational = postgres/.test(envDocker.detail), "envChecklist: the docker route asks for the stores AND a model route");
    ok(envDocker.detail.includes(missNote("docker")), "envChecklist: a docker miss carries the container-environment note");

    const LOADED_ENV = { DATABASE_URL: "postgres://u:p@h/db", AI_GATEWAY_API_KEY: "k", OE_MEMORY_PROVIDER: "postgres", OE_OPERATIONAL_PROVIDER: "postgres", SLACK_BOT_TOKEN: "x" };
    for (const s of SETUP_STEPS) {
      const a = JSON.stringify(s.guide({ cwd: dir, env: {} }));
      ok(a === JSON.stringify(s.guide({ cwd: join(dir, "nowhere"), env: {} })), `step ${s.id}: guide() does not depend on cwd (the reference page is generated from it)`);
      ok(a === JSON.stringify(s.guide({ cwd: dir, env: LOADED_ENV })), `step ${s.id}: guide() does not depend on the environment either`);
      ok(!a.includes(process.versions.node), `step ${s.id}: guide() embeds no live Node version — the page would differ per machine`);
    }

    ok(!/OE_OPERATIONAL_PROVIDER|OE_MEMORY_PROVIDER/.test(envVercel.detail), "envChecklist: the route's miss names neither store selector");

    ok(!nodeVerdict("20.11.0", ">=24").ok && nodeVerdict("24.19.0", ">=24").ok, "prerequisites: Node is judged against the engines range");
    ok(!nodeVerdict("24.19.0", undefined).ok, "prerequisites: an unreadable range is never a pass");

    for (const route of SETUP_ROUTES) {
      const unbuilt = await buildDeployStep.check({ cwd: dir, env: {}, route });
      ok(!unbuilt.satisfied && unbuilt.next === "npm run build", `buildDeploy (${route}): no build → next = \`npm run build\``);
    }
    mkdirSync(join(dir, ".output"), { recursive: true });
    writeFileSync(join(dir, ".output", "x"), "built");
    const noHost = await buildDeployStep.check({ cwd: dir, env: {} });
    ok(!noHost.satisfied, "buildDeploy: a build directory alone NEVER satisfies the step");
    ok(/--host/.test(noHost.next ?? "") && /vercel deploy --prod/.test(noHost.next ?? ""), "buildDeploy: …and the vercel route's next says deploy, then re-run with --host");
    const noHostDocker = await buildDeployStep.check({ cwd: dir, env: {}, route: "docker" });
    ok(/--host/.test(noHostDocker.next ?? "") && !/vercel deploy/.test(noHostDocker.next ?? ""), "buildDeploy: the docker route's next names the image, not `vercel deploy`");

    let mode: "slack" | "protected" | "missing" | "broken" = "slack";
    let seen: { method?: string; url?: string } = {};
    const server = createServer((req, res) => {
      seen = { method: req.method, url: req.url };
      if (mode === "slack") res.writeHead(401).end("unauthorized");
      else if (mode === "protected") res.writeHead(401, { "content-type": "text/html" }).end("<html>Authentication Required</html>");
      else if (mode === "missing") res.writeHead(404).end("not found");
      else res.writeHead(500).end("boom");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const up = await buildDeployStep.check({ cwd: dir, env: {}, host: origin });
      ok(up.satisfied, "buildDeploy: a deployment whose Slack route answers 401 unauthorized satisfies the hosted goal");
      ok(/does NOT prove the deployment holds SLACK_SIGNING_SECRET/.test(up.detail) && /Verified/.test(up.detail), "buildDeploy: …and the pass says it does not prove SLACK_SIGNING_SECRET, naming Slack's Verified as the check that does");
      ok(seen.method === "POST" && seen.url === DEPLOY_PROBE_PATH, "probe: one unsigned POST to the Slack route");
      mode = "protected";
      const prot = await probeDeployment(origin);
      ok(!prot.ok && /Deployment Protection/.test(prot.detail), "probe: a 401 that is not the Slack route's (Vercel Deployment Protection) is NOT a pass");
      mode = "missing";
      ok(!(await probeDeployment(origin)).ok, "probe: 404 is not a pass");
      mode = "broken";
      const broken = await probeDeployment(origin);
      ok(!broken.ok && /500/.test(broken.detail), "probe: 5xx is not a pass, and says so");
      const viaEnv = await buildDeployStep.check({ cwd: dir, env: { OE_PUBLIC_BASE_URL: origin } });
      ok(!viaEnv.satisfied && /500/.test(viaEnv.detail), "buildDeploy: OE_PUBLIC_BASE_URL is the host when --host is absent");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    {
      let hits = 0;
      let script: ("500" | "hang" | "401" | "404")[] = [];
      const held: import("node:http").ServerResponse[] = [];
      const cold = createServer((_req, res) => {
        const step = script[hits++] ?? "401";
        if (step === "500") res.writeHead(500).end("boom");
        else if (step === "hang") held.push(res);
        else if (step === "404") res.writeHead(404).end("not found");
        else res.writeHead(401).end("unauthorized");
      });
      await new Promise<void>((r) => cold.listen(0, "127.0.0.1", r));
      const coldOrigin = `http://127.0.0.1:${(cold.address() as { port: number }).port}`;
      const run = async (steps: typeof script) => {
        hits = 0;
        script = steps;
        return probeDeployment(coldOrigin, fetch, 300, 3000);
      };
      try {
        const after500 = await run(["500", "401"]);
        ok(after500.ok && hits === 2, "probe: a 5xx then 401 passes on the one retry");
        ok(/^cold start: the first request got 500/.test(after500.detail), "probe: …and says cold start, naming the first failure");
        const afterHang = await run(["hang", "401"]);
        ok(afterHang.ok && hits === 2 && /^cold start: the first request got no answer/.test(afterHang.detail), "probe: a timeout then 401 passes on the retry, as a cold start");
        const twice = await run(["500", "500"]);
        ok(!twice.ok && hits === 2 && /after one retry/.test(twice.detail), "probe: two 5xx fail, and say a retry ran");
        const notFound = await run(["404", "401"]);
        ok(!notFound.ok && hits === 1, "probe: a 404 is never retried (negative control: a second request cannot fix it)");
        const warm = await run(["401"]);
        ok(warm.ok && hits === 1 && !/cold start/.test(warm.detail), "probe: a first-try pass makes one request and claims no cold start");
      } finally {
        for (const r of held) r.destroy();
        cold.closeAllConnections();
        await new Promise<void>((r) => cold.close(() => r()));
      }
    }
    ok(!(await probeDeployment("http://127.0.0.1:9", fetch, 2000, 2000)).ok, "probe: an unreachable host is not a pass");
    ok(normalizeHost("my-agent.vercel.app/") === "https://my-agent.vercel.app", "normalizeHost: a bare host gets https and loses the path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const templateDir = fileURLToPath(new URL("../template/", import.meta.url));
  const readme = readFileSync(join(templateDir, "README.md"), "utf8");
  const agents = readFileSync(join(templateDir, "AGENTS.md"), "utf8");
  const skill = readFileSync(join(templateDir, "claude", "skills", "quickstart-open-everywhere", "SKILL.md"), "utf8");

  const setupSection = readme.slice(readme.indexOf("## Set it up"), readme.indexOf("## Check where you are"));
  ok(/open this folder in your coding agent/i.test(setupSection), "template README: setup hands the work to the coding agent");
  ok(/\*\*Vercel\*\*/.test(setupSection) && /\*\*Docker\*\*/.test(setupSection), "template README: setup names both routes");
  ok(/docs\/deploy\/contract\.md/.test(setupSection), "template README: setup links the deployment contract");
  ok(/docs\/deploy\/setup-steps\.md/.test(readme), "template README: links the generated setup-steps reference");
  ok(!/^\s*4\. /mu.test(setupSection), "template README: the setup section carries no numbered step list (it cannot drift if it does not exist)");
  ok(!/Deploy to Vercel with Slack/.test(readme), "template README: the retired 13-step section is gone");
  ok(/## Develop locally/.test(readme) && /not a way to\s+set the app up/.test(readme), "template README: `Develop locally` exists and says what it is NOT for");
  ok(!/interactive wizard|--goal |--decline-telemetry|--skip-wizard/.test(readme), "template README: names no retired flag or wizard");

  ok(/Step 1 is to ask which route/.test(agents), "template AGENTS.md: step 1 is to ask which route");
  ok(/Never propose a local run as a setup step/.test(agents), "template AGENTS.md: forbids proposing a local run as setup");
  ok(/Never ask the user to paste a secret into the chat/.test(agents), "template AGENTS.md: forbids a secret in the chat");
  ok(/--route docker/.test(agents) && /docs\/deploy\/setup-steps\.md/.test(agents), "template AGENTS.md: names the docker route and the reference page");
  ok(!/--goal local|interactive wizard/.test(agents), "template AGENTS.md: names no retired flag");

  ok(/## Step 1 — ask which route/.test(skill), "skill: step 1 is the route question");
  ok(/## The Vercel route/.test(skill) && /## The Docker route/.test(skill), "skill: both routes have their own section");
  ok(/Never propose a local run as a setup step/.test(skill), "skill: forbids proposing a local run as setup");
  ok(/Never ask the user to paste a secret into the chat/.test(skill), "skill: forbids a secret in the chat");
  ok(!/\bquickstart \{/.test(skill) && !/quickstart plan/i.test(skill), "skill: never calls the retired `quickstart` plan tool");
  ok(/there is no plan\s+tool/.test(skill), "skill: says so outright, so a reader does not go looking for one");
  ok(/target: "vercel"/.test(skill) && /target: "docker"/.test(skill), "skill: passes the route as the preflight target");
  const envStep = skill.slice(skill.indexOf("9. **Deployment env.**"), skill.indexOf("10. **Deploy.**"));
  for (const name of ["OE_CREDENTIAL_ENCRYPTION_KEY", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "OE_OPERATIONAL_PROVIDER", "OE_MEMORY_PROVIDER"]) {
    ok(envStep.includes(name), `skill: the Vercel route's deployment-env step names ${name}`);
  }
  ok(/vercel env add/.test(envStep), "skill: …and names the command that sets each one");
  ok(!/vercel env add AI_GATEWAY_API_KEY/.test(skill), "skill: never pushes AI_GATEWAY_API_KEY to a Vercel deployment (OIDC covers it)");
  ok(!/deploy:verify|OE_VERCEL_API_TOKEN|OE_DEPLOY_/.test(skill), "skill: names no repo-only deploy script or variable the scaffolded app does not ship");
  const templatePkg = JSON.parse(readFileSync(join(templateDir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const templateScripts = new Set(Object.keys(templatePkg.scripts ?? {}));
  for (const named of [...skill.matchAll(/npm run (?:-s )?([a-z][a-z0-9:-]*)/gu)].map((m) => m[1]!)) {
    ok(templateScripts.has(named), `skill: \`npm run ${named}\` is a script the scaffolded app actually ships`);
  }
  for (const line of skill.split("\n").filter((l) => l.includes("env:pipe --"))) {
    ok(/\|/.test(line) || /Never run it bare/.test(line), `skill: every env:pipe line is piped or is the warning itself: ${line.trim().slice(0, 48)}`);
  }
}

console.log(`✓ ${n} engine assertions passed`);

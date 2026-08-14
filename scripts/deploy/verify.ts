import { join } from "node:path";

import {
  createVercelClient,
  currentAliasTarget,
  currentCommit,
  decideAfterProbe,
  DeployConfigError,
  fileStore,
  parseArgs,
  probeHealth,
  readLocalCronCount,
  resolveControlToken,
  resolveDeployEnv,
  resolveProjectRef,
  resolveVercelApiToken,
  runCronCheck,
  runRecord,
  runRollback,
} from "./lib.js";

const args = parseArgs(process.argv.slice(2));
const log = (line: string): void => console.log(line);

try {
  const env = resolveDeployEnv(process.env);
  const token = resolveControlToken(process.env);
  const noRollback = args.flags.has("no-rollback");
  const attempts = Number(args.values.get("attempts") ?? "3") || 3;
  const delayMs = Number(args.values.get("delay-ms") ?? "5000") || 5000;

  log(`  probing ${env.baseUrl}/control/v1/audit (up to ${attempts} attempt(s))`);
  const outcome = await probeHealth({
    baseUrl: env.baseUrl,
    token,
    fetchImpl: async (url, init) => {
      const res = await fetch(url, { headers: init.headers, signal: init.signal, redirect: "manual" });
      return { status: res.status };
    },
    attempts,
    delayMs,
    log,
  });

  const decision = decideAfterProbe({ outcome, noRollback });
  if (decision.action === "pass") {
    log(`✓ deploy:verify: ${decision.message}`);

    const client = createVercelClient(env);
    const current = await currentAliasTarget(client, env.alias);

    log("  checking cron registration");
    const cronResult = await runCronCheck({
      token: resolveVercelApiToken({ env: process.env }),
      project: resolveProjectRef({
        envProject: env.project,
        envScope: env.scope,
        projectJsonPath: join(process.cwd(), ".vercel", "project.json"),
      }),
      resolvedDeploymentId: current?.id,
      deploymentCreatedAt: current?.createdAt,
      localCrons: readLocalCronCount(join(process.cwd(), ".vercel", "output", "config.json")),
      apiFetch: async (url, init) => {
        const res = await fetch(url, { headers: init.headers });
        return { status: res.status, text: () => res.text() };
      },
      log,
    });
    if (!cronResult.ok) {
      console.error("✗ deploy:verify: the cron registration check failed — see above. Not rolling back (a rollback would not fix it; redeploy instead).");
      process.exit(1);
    }

    if (args.flags.has("record")) {
      await runRecord({
        env,
        client,
        store: fileStore(env.stateFile),
        url: current?.url,
        id: current?.id,
        commit: args.values.get("commit") ?? (await currentCommit()),
        note: args.values.get("note"),
        log,
      });
    }
    process.exit(0);
  }

  if (decision.action === "fail") {
    console.error(`✗ deploy:verify: ${decision.message}`);
    process.exit(1);
  }

  console.error(`✗ deploy:verify: ${decision.message}`);
  const rolled = await runRollback({
    env,
    client: createVercelClient(env),
    store: fileStore(env.stateFile),
    log,
  });
  process.exit(rolled.ok ? 1 : 2);
} catch (err) {
  if (err instanceof DeployConfigError) {
    console.error(`✗ deploy:verify: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

import { join } from "node:path";

import {
  createVercelClient,
  currentAliasTarget,
  currentCommit,
  decideAfterProbe,
  DeployConfigError,
  deploymentKey,
  fileStore,
  parseArgs,
  probeHealth,
  readLocalCronCount,
  realApiFetch,
  resolveControlToken,
  resolveDeployEnv,
  resolveVercelApi,
  runCronCheck,
  runRecord,
  runRollback,
  teamQuery,
  unresolvedAliasFailure,
  vercelApiJson,
  type VercelApi,
} from "./lib.js";

async function deployedCommit(api: VercelApi, target: string): Promise<string | undefined> {
  try {
    const body = await vercelApiJson(api, `/v13/deployments/${encodeURIComponent(deploymentKey(target))}?${teamQuery(api.project)}`);
    const meta = (body as { meta?: unknown } | null)?.meta;
    const sha = (meta as { githubCommitSha?: unknown } | null | undefined)?.githubCommitSha;
    return typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

const args = parseArgs(process.argv.slice(2));
const log = (line: string): void => console.log(line);

try {
  const env = resolveDeployEnv(process.env);
  const token = resolveControlToken(process.env);
  const api = resolveVercelApi({ env: process.env, deployEnv: env, cwd: process.cwd(), fetchImpl: realApiFetch });
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

    const client = createVercelClient(api);
    const resolved = await currentAliasTarget(client, env.alias);
    if (resolved.kind === "unresolved") {
      console.error(`✗ ${unresolvedAliasFailure({ alias: env.alias, reason: resolved.reason, recording: args.flags.has("record") })}`);
      process.exit(1);
    }
    const current = resolved.target;

    log("  checking cron registration");
    const cronResult = await runCronCheck({
      token: api.token,
      project: api.project,
      resolvedDeploymentId: current.id,
      deploymentCreatedAt: current.createdAt,
      localCrons: readLocalCronCount(join(process.cwd(), ".vercel", "output", "config.json")),
      apiFetch: api.fetchImpl,
      ...(api.apiBase ? { apiBase: api.apiBase } : {}),
      log,
    });
    if (!cronResult.ok) {
      console.error("✗ deploy:verify: the cron registration check failed — see above. Not rolling back (a rollback would not fix it; redeploy instead).");
      process.exit(1);
    }

    if (args.flags.has("record")) {
      const recordUrl = args.values.get("url") ?? current.url;
      const recordId = args.values.get("id") ?? (args.values.get("url") ? undefined : current.id);
      const explicitCommit = args.values.get("commit");
      const commitTarget = args.values.get("id") ?? args.values.get("url") ?? current.id ?? current.url;
      const deployed = explicitCommit === undefined && commitTarget ? await deployedCommit(api, commitTarget) : undefined;
      const commit = explicitCommit ?? deployed ?? (await currentCommit());
      log(
        `  pointer commit ← ${
          explicitCommit !== undefined
            ? "--commit"
            : deployed !== undefined
              ? "the deployment's own meta.githubCommitSha"
              : commit !== undefined
                ? "this checkout's git HEAD (the deployment record carried no commit sha, or the lookup failed)"
                : "nothing — no commit recorded"
        }`,
      );
      const recorded = await runRecord({
        env,
        client,
        store: fileStore(env.stateFile),
        url: recordUrl,
        id: recordId,
        commit,
        note: args.values.get("note"),
        label: "deploy:verify --record",
        log,
      });
      if (!recorded.ok) process.exit(1);
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
    client: createVercelClient(api),
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

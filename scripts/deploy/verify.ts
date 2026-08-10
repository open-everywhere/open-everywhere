import {
  createVercelClient,
  currentCommit,
  decideAfterProbe,
  DeployConfigError,
  fileStore,
  parseArgs,
  probeHealth,
  resolveControlToken,
  resolveDeployEnv,
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
    if (args.flags.has("record")) {
      await runRecord({
        env,
        client: createVercelClient(env),
        store: fileStore(env.stateFile),
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

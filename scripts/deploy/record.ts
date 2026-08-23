import { currentCommit, DeployConfigError, fileStore, lazyVercelClient, parseArgs, realApiFetch, resolveDeployEnv, resolveVercelApi, runRecord } from "./lib.js";

const args = parseArgs(process.argv.slice(2));

try {
  const env = resolveDeployEnv(process.env);
  const client = lazyVercelClient(() => resolveVercelApi({ env: process.env, deployEnv: env, cwd: process.cwd(), fetchImpl: realApiFetch }));
  const result = await runRecord({
    env,
    client,
    store: fileStore(env.stateFile),
    url: args.values.get("url"),
    id: args.values.get("id"),
    commit: args.values.get("commit") ?? (await currentCommit()),
    note: args.values.get("note"),
    log: (line) => console.log(line),
  });
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  if (err instanceof DeployConfigError) {
    console.error(`✗ deploy:record: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

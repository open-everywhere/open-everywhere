import { createVercelClient, DeployConfigError, fileStore, parseArgs, resolveDeployEnv, runRollback } from "./lib.js";

const args = parseArgs(process.argv.slice(2));

try {
  const env = resolveDeployEnv(process.env);
  const client = createVercelClient(env);
  const result = await runRollback({
    env,
    client,
    store: fileStore(env.stateFile),
    explicitTo: args.values.get("to"),
    dryRun: args.flags.has("dry-run"),
    log: (line) => console.log(line),
  });
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  if (err instanceof DeployConfigError) {
    console.error(`✗ rollback: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

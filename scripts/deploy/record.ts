import { createVercelClient, currentCommit, DeployConfigError, fileStore, parseArgs, resolveDeployEnv, runRecord } from "./lib.js";

const args = parseArgs(process.argv.slice(2));

try {
  const env = resolveDeployEnv(process.env);
  const client = createVercelClient(env);
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

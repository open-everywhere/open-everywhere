import { spawnSync } from "node:child_process";
import { CHAIN_LIST_FILE, readChainList } from "./_legs.js";
import { runChain } from "./_run-chain-lib.js";

function npmRun(leg: string): number | null {
  return spawnSync("npm", ["run", leg], { stdio: "inherit", shell: process.platform === "win32" }).status;
}

const legs = readChainList(process.cwd());
if (!legs) {
  console.error(`✗ test:chain: no ${CHAIN_LIST_FILE} in ${process.cwd()} — this package has no chain list.`);
  process.exit(1);
}
process.exit(runChain(legs, npmRun, (line) => console.error(line)));

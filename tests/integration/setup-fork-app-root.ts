import { constructForkAppRoot, removeForkAppRoot } from "./fork-app-root";

const ENTERED = Symbol.for("open-everywhere.integration.forkAppRoot");
type Marked = typeof globalThis & { [ENTERED]?: string };

const marked = globalThis as Marked;
if (marked[ENTERED] === undefined) {
  const forkRoot = constructForkAppRoot(process.cwd());
  marked[ENTERED] = forkRoot;
  process.chdir(forkRoot);
  process.on("exit", () => removeForkAppRoot(forkRoot));
}

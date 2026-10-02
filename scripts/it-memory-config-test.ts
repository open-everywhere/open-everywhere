import { availableParallelism } from "node:os";

import { HARNESS_CONCURRENCY_CEILING, HOST_BOX_PROBE, cgroupMaxWorkersByMemoryAndCores, integrationMaxWorkers, type BoxProbe } from "./ci-max-workers.js";
import config from "../vitest.config.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const test = config.test;
ok(test !== undefined, "vitest.config.ts declares a `test` block");

const execArgv: readonly string[] = test?.execArgv ?? [];
const heapFlag = execArgv.find((a) => a.startsWith("--max-old-space-size="));
ok(heapFlag !== undefined, "🔴 every fork runs with --max-old-space-size — without it V8 reads the MACHINE's RAM, not the cgroup, and the kernel is what ends the run");
const heapMb = Number(heapFlag?.slice("--max-old-space-size=".length));
ok(Number.isInteger(heapMb) && heapMb > 0, `the heap cap is a positive integer of MB — got ${String(heapFlag)}`);
ok(heapMb >= 512, `the cap must leave a fork room to boot a host — got ${heapMb} MB`);
ok(heapMb <= 2048, `🔴 the cap must stay well under the ~8 240 MB V8 would pick on its own, or it is not a cap — got ${heapMb} MB`);

ok(test?.disableConsoleIntercept === true, "🔴 console interception is OFF — it retains every fork's output in the MAIN process for the run's life");

const external = test?.server?.deps?.external ?? [];
ok(Array.isArray(external) && external.length > 0, "the tier declares `server.deps.external` patterns");
ok(
  (external as readonly unknown[]).every((p) => p instanceof RegExp),
  "🔴 every `server.deps.external` pattern is a RegExp — vitest matches a STRING pattern only under node_modules, so a string spelling would externalise nothing",
);
function isExternal(id: string): boolean {
  return (external as readonly (string | RegExp)[]).some((p) => (typeof p === "string" ? id.includes(p) : p.test(id)));
}
ok(isExternal("/home/runner/oe/.output/server/index.mjs"), "🔴 the BUILT server bundle is external — re-transforming it through vite is the dominant cause of this tier's memory (OPE-2227)");
ok(isExternal("/home/runner/oe/.output/server/chunks/_/handler.mjs"), "…including a chunk deeper inside the built server tree");
ok(isExternal("/home/runner/oe/packages/core/dist/index.js"), "🔴 the built `packages/*/dist` copy is external too — `harness.ts` loads a 222-module barrel from it for two string constants");
ok(isExternal("/home/runner/oe/packages/providers/discord/dist/agent/approvals/discord-card.js"), "🔴 …including a PROVIDER package's dist, which nests one level deeper — `approval-click.test.ts`, `decision-wake.test.ts` and `child-binding-inheritance.test.ts` each import that built module, and the `packages/*/dist` spelling misses it");
ok(!isExternal("/home/runner/oe/tests/integration/memory/memory.test.ts"), "🔴 NEGATIVE CONTROL: a test file is NOT external — vitest must still transform the tier's own TypeScript");
ok(!isExternal("/home/runner/oe/agent/settings/settings.ts"), "🔴 NEGATIVE CONTROL: a source module is NOT external");
ok(!isExternal("/home/runner/oe/packages/core/agent/access/untrusted.ts"), "🔴 NEGATIVE CONTROL: a package's SOURCE is not external — only its built `dist` is");
ok(!isExternal("/home/runner/oe/packages/providers/discord/agent/approvals/discord-card.ts"), "🔴 NEGATIVE CONTROL: a PROVIDER's source is not external either — the any-depth pattern must still stop at `dist`");
ok(!isExternal("/home/runner/oe/packages/core/dist-src/index.js"), "🔴 NEGATIVE CONTROL: `dist-src` is not `dist` — the pattern matches a whole path segment, not a prefix");

const GB = 1024 ** 3;
const sandboxProbe: BoxProbe = {
  readFile: (path) => {
    const files: Record<string, string> = {
      "/proc/self/cgroup": "4:memory:/process_api/01a0621b/claude-code-bash\n0::/\n",
      "/sys/fs/cgroup/memory/process_api/01a0621b/claude-code-bash/memory.limit_in_bytes": "14327709696\n",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
    };
    const found = files[path];
    if (found === undefined) throw new Error(`ENOENT: ${path}`);
    return found;
  },
  totalMemoryBytes: () => 16 * GB,
  cpuCount: () => 4,
};
const sandboxWorkers = integrationMaxWorkers({}, sandboxProbe);
ok(sandboxWorkers === HARNESS_CONCURRENCY_CEILING, `🔴 the measured sandbox SCHEDULES the harness ceiling — 4 concurrent hosts red the tier on the OPE-2197 turn/script race — got ${sandboxWorkers}`);
ok(sandboxWorkers <= sandboxProbe.cpuCount(), "the scheduled count never exceeds the cores");
ok(
  cgroupMaxWorkersByMemoryAndCores(14327709696, 4) === 4,
  "🔴 memory and cores allow FOUR on the measured sandbox, which is what the three levers above bought and what a post-OPE-2197 re-measurement starts from",
);

const here = integrationMaxWorkers({}, HOST_BOX_PROBE);
ok(Number.isInteger(here) && here >= 1, `this box answers a whole worker count of at least 1 — got ${String(here)}`);
ok(cgroupMaxWorkersByMemoryAndCores(14327709696, availableParallelism()) >= 1, "the memory-and-cores derivation answers at least one worker for this box's cores under the measured cap");

console.log(
  `✓ it-memory-config: ${passed} assertions passed (each fork's V8 old space is capped at ${heapMb} MB, console interception is off, ` +
    `the built server bundle and the built package dists load natively while the tier's own sources still transform; ` +
    `memory and cores would allow 4 workers on the measured 4-core 13.3 GiB sandbox, and the harness ceiling schedules ` +
    `${sandboxWorkers} until OPE-2197's turn/script race is fixed).`,
);

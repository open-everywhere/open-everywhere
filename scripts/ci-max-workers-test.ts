import {
  CGROUP_FLOOR_MAX_WORKERS,
  CGROUP_RESERVE_MB,
  HARNESS_CONCURRENCY_CEILING,
  UNCAPPED_MAX_WORKERS,
  WORKER_BASE_MB,
  WORKER_MARGINAL_MB,
  ciMaxWorkersOverride,
  cgroupMaxWorkers,
  cgroupMaxWorkersByMemoryAndCores,
  cgroupMemoryCapBytes,
  integrationMaxWorkers,
  type BoxProbe,
} from "./ci-max-workers.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

ok(ciMaxWorkersOverride({}) === undefined, "no OE_IT_CI_MAX_WORKERS set — undefined, so the ceiling read decides");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "" }) === undefined, "an empty string is treated as unset");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "   " }) === undefined, "a blank (whitespace-only) value is treated as unset");

ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "3" }) === 3, "OE_IT_CI_MAX_WORKERS=3 overrides to 3");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "4" }) === 4, "OE_IT_CI_MAX_WORKERS=4 overrides to 4");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "1" }) === 1, "OE_IT_CI_MAX_WORKERS=1 overrides to 1 (a degenerate but valid value)");

ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "0" }) === undefined, "0 is rejected — a worker count of 0 would hang the tier");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "-1" }) === undefined, "a negative value is rejected");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "2.5" }) === undefined, "a non-integer value is rejected");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "nope" }) === undefined, "a non-numeric value is rejected, not coerced to NaN");
ok(ciMaxWorkersOverride({ OE_IT_CI_MAX_WORKERS: "3abc" }) === undefined, "a value Number() cannot fully parse is rejected");

const GB = 1024 ** 3;
const MB = 1024 ** 2;
function probe(files: Record<string, string>, total: number, cores = 4): BoxProbe {
  return {
    readFile: (path) => {
      const found = files[path];
      if (found === undefined) throw new Error(`ENOENT: ${path}`);
      return found;
    },
    totalMemoryBytes: () => total,
    cpuCount: () => cores,
  };
}

const SANDBOX_CGROUP = "4:memory:/process_api/01a0621b/claude-code-bash\n0::/\n";
const sandboxProbe = probe(
  {
    "/proc/self/cgroup": SANDBOX_CGROUP,
    "/sys/fs/cgroup/memory/process_api/01a0621b/claude-code-bash/memory.limit_in_bytes": "14327709696\n",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
  },
  16 * GB,
);
ok(cgroupMemoryCapBytes(sandboxProbe) === 14327709696, "the sandbox's own memory cgroup limit is found, not the machine's RAM");
ok(
  integrationMaxWorkers({}, sandboxProbe) === HARNESS_CONCURRENCY_CEILING,
  "🔴 OPE-2229: the measured sandbox SCHEDULES the harness ceiling, not the memory answer — 4 concurrent agent hosts red the tier on the OPE-2197 turn/script race (2 of 2 runs, 3 different files), and clean `main` is green at 1 worker, so the raise is the trigger",
);
ok(
  cgroupMaxWorkersByMemoryAndCores(14327709696, 4) === 4,
  "🔴 …and MEMORY AND CORES would allow 4 there. This row is what the ceiling withholds, kept measurable so OPE-2197's fix has a number to re-measure against (A/B: 5 833 MB of 13 680, no OOM)",
);

const sharedBoxProbe = probe(
  {
    "/proc/self/cgroup": "4:memory:/\n0::/\n",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
  },
  7 * GB,
);
ok(cgroupMemoryCapBytes(sharedBoxProbe) === undefined, "the v1 no-limit sentinel is NOT a cap — it is past MAX_SAFE_INTEGER and above RAM");
ok(integrationMaxWorkers({}, sharedBoxProbe) === UNCAPPED_MAX_WORKERS, "🔴 NEGATIVE CONTROL: an uncapped box keeps the 2 pin — without this row the cgroup read could answer 1 everywhere and nothing would notice");

const v2Probe = probe({ "/proc/self/cgroup": "0::/user.slice/session.scope\n", "/sys/fs/cgroup/user.slice/session.scope/memory.max": "4294967296\n" }, 16 * GB);
ok(cgroupMemoryCapBytes(v2Probe) === 4 * GB, "cgroup v2 (`0::<path>` + memory.max) is read");
const v2NamespacedProbe = probe({ "/proc/self/cgroup": "0::/user.slice/session.scope\n", "/sys/fs/cgroup/memory.max": "4294967296\n" }, 16 * GB);
ok(cgroupMemoryCapBytes(v2NamespacedProbe) === 4 * GB, "…including a container that namespaces the mount, where the limit sits at the mount root");
ok(cgroupMemoryCapBytes(probe({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.max": "max\n" }, 16 * GB)) === undefined, "`max` is not a cap");

const twoLimits = probe(
  {
    "/proc/self/cgroup": "4:memory:/outer/inner\n0::/outer/inner\n",
    "/sys/fs/cgroup/memory/outer/inner/memory.limit_in_bytes": "8589934592\n",
    "/sys/fs/cgroup/outer/inner/memory.max": "2147483648\n",
  },
  16 * GB,
);
ok(cgroupMemoryCapBytes(twoLimits) === 2 * GB, "the SMALLEST readable limit wins — the tightest hierarchy is the one that kills the run");

ok(cgroupMemoryCapBytes(probe({}, 16 * GB)) === undefined, "no /proc/self/cgroup at all (a non-Linux box) is not a cap");
ok(cgroupMemoryCapBytes(probe({ "/proc/self/cgroup": "4:memory:/x\n" }, 16 * GB)) === undefined, "a named cgroup whose limit file is unreadable is not a cap");
ok(cgroupMemoryCapBytes(probe({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.max": "nonsense\n" }, 16 * GB)) === undefined, "an unparseable limit is not a cap");
ok(cgroupMemoryCapBytes(probe({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.max": "0\n" }, 16 * GB)) === undefined, "a zero limit is rejected rather than believed");
ok(cgroupMemoryCapBytes(probe({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.max": String(16 * GB) }, 16 * GB)) === undefined, "a limit EQUAL to RAM is the machine restated, not a cap");

ok(integrationMaxWorkers({ OE_IT_CI_MAX_WORKERS: "4" }, sandboxProbe) === 4, "the override raises a capped process — a run that knows its box states the count");
ok(integrationMaxWorkers({ OE_IT_CI_MAX_WORKERS: "1" }, sharedBoxProbe) === 1, "…and lowers an uncapped one");
ok(integrationMaxWorkers({ OE_IT_CI_MAX_WORKERS: "bogus" }, sandboxProbe) === HARNESS_CONCURRENCY_CEILING, "a malformed override falls through to the ceiling read, never to NaN");
ok(integrationMaxWorkers({ OE_IT_CI_MAX_WORKERS: "4" }, sandboxProbe) === 4, "OE_IT_CI_MAX_WORKERS=4 overrides the harness ceiling — that is how OPE-2197's fix gets re-measured");

ok(
  HARNESS_CONCURRENCY_CEILING === 1,
  "🔴 the harness concurrency ceiling is 1 — 4 workers red the tier in 2 of 2 runs on the OPE-2197 turn/script race (measured 2026-10-03, shard 1, 3 different files), 2 and 3 workers each red 1 of 2, and clean `main` is green at 1. Raise it only against a re-measurement, and restate that measurement here",
);

const sandboxCapMb = 14327709696 / MB;
const fitsInSandbox = Math.floor((sandboxCapMb - CGROUP_RESERVE_MB - WORKER_BASE_MB) / WORKER_MARGINAL_MB);
ok(fitsInSandbox >= 8, `the measured sandbox cap fits far more workers than it has cores (${String(fitsInSandbox)}), which is why the cores are what bind it`);
ok(cgroupMaxWorkersByMemoryAndCores(14327709696, 4) === 4, "🔴 CORES BIND THE SANDBOX by memory and cores: memory fits 20 workers and the box has 4, so 4 — the A/B measured 4 returning only 2.44× on 12 files, so a 5th would buy nothing");
ok(cgroupMaxWorkersByMemoryAndCores(14327709696, 2) === 2, "…and a 2-core box with the same cap takes 2 — the minimum is a real minimum, not a cap read twice");
ok(cgroupMaxWorkersByMemoryAndCores(14327709696, 8) === 8, "…and 8 cores under the same cap take 8, which the A/B's own extrapolation put at ≈7.6 GB of 13.7 GB");
for (const cores of [2, 4, 8, 16]) {
  ok(cgroupMaxWorkers(14327709696, cores) === HARNESS_CONCURRENCY_CEILING, `the scheduled count holds at the harness ceiling whatever the cores — ${cores} cores gave ${cgroupMaxWorkers(14327709696, cores)}`);
}

ok(
  cgroupMaxWorkersByMemoryAndCores(Math.round((CGROUP_RESERVE_MB + WORKER_BASE_MB + 2 * WORKER_MARGINAL_MB) * MB), 4) === 2,
  "🔴 MEMORY BINDS A SMALL CGROUP: a cap holding exactly the reserve, the base and two workers' budget answers 2, not the 4 cores",
);
ok(
  cgroupMaxWorkersByMemoryAndCores(Math.round((CGROUP_RESERVE_MB + WORKER_BASE_MB + 2 * WORKER_MARGINAL_MB) * MB) - 1, 4) === 1,
  "…and one byte less answers 1 — the division FLOORS, so a budget that does not fully hold a worker never schedules it",
);
ok(cgroupMaxWorkersByMemoryAndCores(4 * GB, 4) === CGROUP_FLOOR_MAX_WORKERS, "a 4 GB cgroup has no room for a second host once the page-cache reserve is held back, so it keeps the serial behaviour every capped box had before OPE-2229");
ok(cgroupMaxWorkersByMemoryAndCores(256 * MB, 4) === CGROUP_FLOOR_MAX_WORKERS, "🔴 a cgroup smaller than the reserve itself answers the FLOOR, never 0 or a negative — vitest given 0 workers schedules no file and hangs with no verdict");
ok(cgroupMaxWorkersByMemoryAndCores(14327709696, 0) === CGROUP_FLOOR_MAX_WORKERS, "a zero core count is degenerate and takes the floor");
ok(cgroupMaxWorkersByMemoryAndCores(14327709696, -4) === CGROUP_FLOOR_MAX_WORKERS, "a negative core count takes the floor");
ok(cgroupMaxWorkersByMemoryAndCores(14327709696, 2.5) === CGROUP_FLOOR_MAX_WORKERS, "a non-integer core count takes the floor rather than producing a fractional worker count");
ok(cgroupMaxWorkersByMemoryAndCores(14327709696, Number.NaN) === CGROUP_FLOOR_MAX_WORKERS, "a NaN core count takes the floor, never becomes NaN workers");
ok(cgroupMaxWorkersByMemoryAndCores(Number.NaN, 4) === CGROUP_FLOOR_MAX_WORKERS, "a NaN cap takes the floor");
for (const [cap, cores] of [[14327709696, 4], [256 * MB, 4], [Number.NaN, 4], [14327709696, Number.NaN]] as [number, number][]) {
  ok(cgroupMaxWorkers(cap, cores) === CGROUP_FLOOR_MAX_WORKERS, `the scheduled count is a whole worker count for every degenerate input — cap ${String(cap)}, cores ${String(cores)}`);
}

const oneCoreSandbox = probe(
  {
    "/proc/self/cgroup": SANDBOX_CGROUP,
    "/sys/fs/cgroup/memory/process_api/01a0621b/claude-code-bash/memory.limit_in_bytes": "14327709696\n",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
  },
  16 * GB,
  1,
);
ok(cgroupMaxWorkersByMemoryAndCores(14327709696, 1) === 1, "🔴 NEGATIVE CONTROL on the core read: the same cap with ONE core answers 1 — without this row `cpuCount()` could be ignored and the memory-and-cores rows above would still pass");
ok(integrationMaxWorkers({}, oneCoreSandbox) === 1, "a one-core capped sandbox schedules 1, by both the cores and the ceiling");
ok(integrationMaxWorkers({}, probe({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.max": String(4 * GB) }, 16 * GB, 4)) === CGROUP_FLOOR_MAX_WORKERS, "🔴 NEGATIVE CONTROL on the memory read: a 4-core box under a 4 GB cap answers 1 — without this row the cores alone could decide and a small cgroup would be OOM-killed");

console.log(
  `✓ ci-max-workers: ${passed} assertions passed (unset/blank falls back to the ceiling read, valid integers pass through, ` +
    `every malformed shape — 0, negative, non-integer, non-numeric — is rejected rather than coerced; a memory cgroup ` +
    `capping the process below RAM derives min(cores, floor((cap − ${CGROUP_RESERVE_MB} − ${WORKER_BASE_MB}) / ${WORKER_MARGINAL_MB})) ` +
    `= 4 on the measured 4-core 13.3 GiB sandbox, then SCHEDULES ${HARNESS_CONCURRENCY_CEILING} because the OPE-2197 turn/script ` +
    `race reds the tier above that; an explicit OE_IT_CI_MAX_WORKERS still overrides, and an uncapped box answers ${UNCAPPED_MAX_WORKERS}).`,
);

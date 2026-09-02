import {
  CGROUP_CAPPED_MAX_WORKERS,
  UNCAPPED_MAX_WORKERS,
  ciMaxWorkersOverride,
  cgroupMemoryCapBytes,
  integrationMaxWorkers,
  type MemoryProbe,
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
function probe(files: Record<string, string>, total: number): MemoryProbe {
  return {
    readFile: (path) => {
      const found = files[path];
      if (found === undefined) throw new Error(`ENOENT: ${path}`);
      return found;
    },
    totalMemoryBytes: () => total,
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
ok(integrationMaxWorkers({}, sandboxProbe) === CGROUP_CAPPED_MAX_WORKERS, "🔴 a capped process defaults to ONE worker — two agent hosts are OOM-killed there with no vitest verdict (OPE-1369)");

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
ok(integrationMaxWorkers({ OE_IT_CI_MAX_WORKERS: "bogus" }, sandboxProbe) === CGROUP_CAPPED_MAX_WORKERS, "a malformed override falls through to the ceiling read, never to NaN");

console.log(
  `✓ ci-max-workers: ${passed} assertions passed (unset/blank falls back to the ceiling read, valid integers pass through, ` +
    `every malformed shape — 0, negative, non-integer, non-numeric — is rejected rather than coerced; a memory cgroup ` +
    `capping the process below RAM answers ${CGROUP_CAPPED_MAX_WORKERS} worker and an uncapped box answers ${UNCAPPED_MAX_WORKERS}).`,
);

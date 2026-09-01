import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire, registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { assertCoreDistFresh } from "./core-dist-freshness.js";
import {
  EAGER_SETTINGS_READ_ALLOWLIST,
  EAGER_READ_REMEDY,
  auditEagerReads,
  eagerReadKey,
  installSettingsReadProbe,
  type EagerSettingsRead,
} from "./settings-read-probe.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url));

interface BootEntry {
  readonly module: string;
  readonly why: string;
  readonly registers: boolean;
  readonly floor: number;
}

const BOOT_ENTRIES: readonly BootEntry[] = [
  {
    module: "agent/agent.js",
    why: "eve's agent definition — the module the served process loads first. register-config.js is module 15 of the 1,326 it evaluates, so its graph is almost entirely post-registration; it is here for the fourteen that precede it. That 1,326 is an EVALUATION-order measurement, which is what makes `module 15` meaningful; it is not the resolved count arm 5 reports for this entry.",
    registers: true,
    floor: 400,
  },
  {
    module: "agent/sandbox/sandbox.js",
    why: "eve's sandbox definition. Fifteen imports evaluate BEFORE its register-config.js import on line 19 — the adapters browser/sandbox subgraph, self-host-egress, egress-denial-poller — and no other entry reaches them pre-registration.",
    registers: true,
    floor: 300,
  },
  {
    module: "agent/instrumentation.js",
    why: "eve's instrumentation entry, read at server startup. Six lines that re-export the adapters instrumentation module, which reaches core's adapter-api.js barrel. It never imports register-config.js, so NOTHING in that graph is ever post-registration.",
    registers: false,
    floor: 300,
  },
];

interface ChildResult {
  readonly entry: string;
  readonly resolutions: number;
  readonly evaluatedCjs: number;
  readonly registered: boolean;
  readonly traps: number;
  readonly selfTest: string | null;
  readonly reads: EagerSettingsRead[];
}

const RESULT_MARKER = "OE_BOOT_ORDER_RESULT ";

const argv = process.argv.slice(2);

function flagValues(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`✗ settings-boot-order: ${flag} needs a value.`);
      process.exit(1);
    }
    out.push(value);
    i++;
  }
  return out;
}

const listMode = argv.includes("--list");
const registersFlag = flagValues("--registers");
if (registersFlag.some((v) => v !== "true" && v !== "false")) {
  console.error("✗ settings-boot-order: --registers takes `true` or `false`.");
  process.exit(1);
}
const floorFlag = flagValues("--floor");
if (floorFlag.some((v) => !/^\d+$/.test(v))) {
  console.error("✗ settings-boot-order: --floor takes a whole number.");
  process.exit(1);
}
const fixtures = flagValues("--fixture");
const childOf = flagValues("--child");
const entryOverrides = flagValues("--entry");

if (childOf.length > 0) {
  const entry = childOf[0];

  const probe = installSettingsReadProbe(REPO_ROOT);

  const resolved = new Set<string>();
  registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      resolved.add(result.url);
      return result;
    },
  });

  const childRequire = createRequire(import.meta.url);

  const { getSettings } = await import("@open-everywhere/core/agent/settings/settings.js");
  getSettings();
  const selfReads = probe.reads();
  const selfTest =
    selfReads.length === 1 && selfReads[0].file === SELF
      ? null
      : `the probe did not record this file's own getSettings() call — it saw ${probe.trapCount()} trap(s) and ` +
        `attributed ${JSON.stringify(selfReads.map((r) => eagerReadKey(r)))}, expected exactly ` +
        `["${SELF}::getSettings"]. The recorder is not in the settings override slot, or the stack format ` +
        "changed under scripts/settings-read-probe.ts.";
  probe.clear();

  for (const fixture of fixtures) await import(pathToFileURL(resolve(REPO_ROOT, fixture)).href);

  const before = resolved.size;
  const beforeCjs = Object.keys(childRequire.cache).length;
  await import(pathToFileURL(resolve(REPO_ROOT, entry)).href);

  const result: ChildResult = {
    entry,
    resolutions: resolved.size - before,
    evaluatedCjs: Object.keys(childRequire.cache).length - beforeCjs,
    registered: !probe.installed(),
    traps: probe.trapCount(),
    selfTest,
    reads: [...probe.reads()],
  };
  console.log(`${RESULT_MARKER}${JSON.stringify(result)}`);
  process.exit(0);
}

const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
if (!existsSync(TSX)) {
  console.error(`✗ settings-boot-order: no tsx CLI at ${relative(REPO_ROOT, TSX)} — run \`npm ci\` first.`);
  process.exit(1);
}

assertCoreDistFresh();

const entries: readonly BootEntry[] =
  entryOverrides.length > 0
    ? entryOverrides.map((module) => ({
        module,
        why: "named on the command line with --entry",
        registers: registersFlag[0] !== "false",
        floor: floorFlag.length > 0 ? Number(floorFlag[0]) : 1,
      }))
    : BOOT_ENTRIES;

for (const fixture of fixtures) {
  const path = isAbsolute(fixture) ? fixture : resolve(REPO_ROOT, fixture);
  if (existsSync(path)) continue;
  console.error(`✗ settings-boot-order: --fixture ${relative(REPO_ROOT, path)} does not exist.`);
  process.exit(1);
}

const problems: string[] = [];
const reads = new Map<string, EagerSettingsRead>();
const results: ChildResult[] = [];
let totalResolutions = 0;

for (const entry of entries) {
  const args = [TSX, fileURLToPath(import.meta.url), "--child", entry.module];
  for (const fixture of fixtures) args.push("--fixture", fixture);
  const run = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });

  const line = `${run.stdout ?? ""}`.split("\n").find((l) => l.startsWith(RESULT_MARKER));
  if (line === undefined) {
    const tail = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n      ");
    problems.push(
      `booting ${entry.module} produced no result (exit ${run.status}). A boot that cannot run is not a ` +
        `pass — this entry's graph is unwatched until it does. Last output:\n      ${tail}`,
    );
    continue;
  }

  const result = JSON.parse(line.slice(RESULT_MARKER.length)) as ChildResult;
  results.push(result);
  totalResolutions += result.resolutions;

  if (result.selfTest !== null) {
    problems.push(`booting ${entry.module}: ${result.selfTest} Every other arm is meaningless until this passes.`);
  }
  if (entry.registers && !result.registered) {
    problems.push(
      `importing ${entry.module} never reached registerSettings() — the probe is still the object the ` +
        "override slot holds. There is no registration point to be early of, so this entry's read " +
        "inventory proves nothing. Either this entry must import agent/lib/register-config.js, or it " +
        "belongs on the list as `registers: false`.",
    );
  }
  if (!entry.registers && result.registered) {
    problems.push(
      `importing ${entry.module} DID reach registerSettings(), and it is declared \`registers: false\`. ` +
        "That declaration is what makes arm ③ treat every read in this graph as eager; stale, it quietly " +
        "changes what this entry proves. Flip the declaration and say in the diff what now registers.",
    );
  }
  if (result.traps > 0 && result.reads.length === 0) {
    problems.push(
      `booting ${entry.module} trapped ${result.traps} settings read(s) and could attribute NONE of them to ` +
        "a module. The stack parser in scripts/settings-read-probe.ts has stopped understanding real " +
        "stacks, so the gate is failing OPEN — every eager read would be dropped silently.",
    );
  }
  if (result.resolutions < entry.floor) {
    problems.push(
      `booting ${entry.module} resolved ${result.resolutions} distinct module URL(s), under its declared floor ` +
        `of ${entry.floor}. This gate only sees the graph an entry walks, so an entry that stopped walking would ` +
        "report zero eager reads while covering nothing. Either that graph really shrank — then lower this " +
        "entry's floor deliberately, in a diff — or the import is no longer reaching what it used to. " +
        "This arm counts REACH, not evaluation: it cannot see a graph that still resolves and stopped " +
        "evaluating (OPE-1350).",
    );
  }
  for (const read of result.reads) reads.set(eagerReadKey(read), read);
}

if (listMode) {
  for (const result of results) {
    console.log(
      `  ${result.entry}: ${result.resolutions} module URL(s) resolved, ${result.evaluatedCjs} CommonJS module(s) ` +
        `evaluated, ${result.traps} trap(s)`,
    );
    for (const read of result.reads) console.log(`      ${read.file}:${read.line}  ${read.accessor}()`);
  }
  if (reads.size === 0) console.log("  (no settings read ran before registerSettings on any entry)");
}

problems.push(...auditEagerReads([...reads.values()]));

if (problems.length > 0) {
  console.error(`✗ settings-boot-order: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error(`\n${EAGER_READ_REMEDY}`);
  process.exit(1);
}

console.log(
  `✓ settings-boot-order: ${entries.length} entr(ies) booted, ${totalResolutions} module URL(s) resolved ` +
    `(reach, not evaluation — arm ⑤), ${reads.size} settings read(s) before registerSettings() ` +
    `(${EAGER_SETTINGS_READ_ALLOWLIST.size} allowlisted survivor(s)) — no module-level read pins a shipped ` +
    "default on any booted entry.",
);
process.exit(0);

import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { Session } from "node:inspector/promises";
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
  readonly evalFloor: number;
  readonly slotRoot?: true;
  readonly excused?: ReadonlyMap<string, string>;
}

const WINDOW_GATE_LOOKUPS: ReadonlyMap<string, string> = new Map([
  ["packages/core/agent/tools/checkout_repo.ts::windowGated", "the un-tabled-name throw; the row is re-read per session"],
  ["packages/core/agent/tools/create_skill.ts::windowGated", "the un-tabled-name throw; the row is re-read per session"],
  ["packages/core/agent/tools/delete_skill.ts::windowGated", "the un-tabled-name throw; the row is re-read per session"],
  ["packages/core/agent/tools/open_pull_request.ts::windowGated", "the un-tabled-name throw; the row is re-read per session"],
  ["packages/core/agent/tools/post_file.ts::windowGated", "the un-tabled-name throw; the row is re-read per session"],
  ["packages/core/agent/tools/sandbox_tools.ts::windowGatedKit", "the un-tabled-name throw, once per kit entry; every row is re-read per session"],
]);

const BOOT_ENTRIES: readonly BootEntry[] = [
  {
    module: "agent/agent.js",
    why: "eve's agent definition — the module the served process loads first. register-config.js is module 15 of the 1,326 it evaluates, so its graph is almost entirely post-registration; it is here for the fourteen that precede it. That 1,326 is an EVALUATION-order measurement, which is what makes `module 15` meaningful; it is not the resolved count arm 5 reports for this entry.",
    registers: true,
    floor: 400,
    evalFloor: 400,
  },
  {
    module: "agent/sandbox/sandbox.js",
    why: "eve's sandbox definition. Fifteen imports evaluate BEFORE its register-config.js import on line 19 — the adapters browser/sandbox subgraph, self-host-egress, egress-denial-poller — and no other entry reaches them pre-registration.",
    registers: true,
    floor: 300,
    evalFloor: 300,
  },
  {
    module: "agent/instrumentation.js",
    why: "eve's instrumentation entry, read at server startup. Six lines that re-export the adapters instrumentation module, which reaches core's adapter-api.js barrel. It never imports register-config.js, so NOTHING in that graph is ever post-registration.",
    registers: false,
    floor: 300,
    evalFloor: 300,
  },
  {
    module: "agent/tools",
    why: "eve's tool slot root. eve mounts a tool by SCANNING this directory, so a tool no singleton root statically imports still evaluates in the served process — and in no other child here.",
    registers: false,
    slotRoot: true,
    floor: 300,
    evalFloor: 300,
    excused: WINDOW_GATE_LOOKUPS,
  },
  {
    module: "agent/hooks",
    why: "eve's hook slot root. Same scan-mounted shape as tools/, and its modules carry the event bindings — the code most likely to want a setting at module level.",
    registers: false,
    slotRoot: true,
    floor: 300,
    evalFloor: 300,
  },
  {
    module: "agent/channels",
    why: "eve's channel slot root. Same scan-mounted shape; the surface-facing read and write seams mount from here.",
    registers: false,
    slotRoot: true,
    floor: 300,
    evalFloor: 300,
  },
  {
    module: "agent/schedules",
    why: "eve's schedule slot root. Same scan-mounted shape; a schedule module evaluates in the served process whether or not a singleton root imports it.",
    registers: false,
    slotRoot: true,
    floor: 300,
    evalFloor: 300,
  },
  {
    module: "agent/skills",
    why: "eve's skill slot root. Same scan-mounted shape. Its FLOORS are much lower than the other roots' because its graph genuinely is — one module, ~155 resolutions, against agent/tools' thousands. A floor is a reach check, not a size target: set it above what a broken import would resolve and below what this root really reaches.",
    registers: false,
    slotRoot: true,
    floor: 120,
    evalFloor: 120,
  },
  {
    module: "agent/connections",
    why: "eve's connection slot root — the sixth and last generated root (OPE-1450). Same scan-mounted shape; a connection module carries the host-side connector plane's transport and approval wiring, which is the code most likely to CAPTURE a flag into a module const. Its excuse list is deliberately EMPTY: the two reads a standalone boot found (`selectConnectorTransport()` and `connectorApprovalPolicy()` in notion.ts) both captured their answer and were fixed rather than excused, so anything this entry reports next is a genuine regression. 🔴 ITS FLOORS ARE SET LOW ON PURPOSE, AND LOWER THAN THE MEASURED REACH BY A WIDE MARGIN. This root's modules are GENERATED from roster.config.ts and re-export straight into `@open-everywhere/core` — `agent/connections/notion.ts` is one `export { default } from …` line — so what the entry REACHES is the built `packages/core/dist` graph behind that re-export, and it moves with the roster, the build state and the Node version. Measured on this tree: 516 resolutions on Node 24.20.0, 197 on Node 22 with a different dist state — a 2.6x spread, well beyond the 1.27x the resolve-hook version difference explains elsewhere in this file. The EVALUATION count is the stable half (192 and 193 across the same two runs), which is what arm 2 actually watches. So the floors are sized against a BROKEN IMPORT (a failed re-export resolves a handful), not against the healthy figure — a floor set near either measurement would red on a tree that is merely built differently, which is a false alarm on the one gate that must stay trustworthy.",
    registers: false,
    slotRoot: true,
    floor: 120,
    evalFloor: 120,
  },
];

interface ChildResult {
  readonly entry: string;
  readonly resolutions: number;
  readonly evaluated: number | null;
  readonly evaluationNote: string | null;
  readonly imported: number;
  readonly registered: boolean;
  readonly traps: number;
  readonly selfTest: string | null;
  readonly reads: EagerSettingsRead[];
}

const RESULT_MARKER = "OE_BOOT_ORDER_RESULT ";

function slotRootModules(target: string): string[] {
  if (!existsSync(target) || !statSync(target).isDirectory()) return [target];
  return readdirSync(target)
    .filter((name) => name.endsWith(".ts") && !name.endsWith("-test.ts") && !name.endsWith(".d.ts"))
    .sort()
    .map((name) => join(target, name));
}

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
const evalFloorFlag = flagValues("--eval-floor");
if (evalFloorFlag.some((v) => !/^\d+$/.test(v))) {
  console.error("✗ settings-boot-order: --eval-floor takes a whole number.");
  process.exit(1);
}
const slotRootFlag = argv.includes("--slot-root");
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

  let profiler: Session | null = null;
  let evaluationNote: string | null = null;
  try {
    const session = new Session();
    session.connect();
    await session.post("Profiler.enable");
    await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
    profiler = session;
  } catch (err) {
    evaluationNote = `the V8 profiler would not start: ${err instanceof Error ? err.message : String(err)}`;
  }

  const evaluatedScripts = async (): Promise<Set<string>> => {
    const out = new Set<string>();
    if (profiler === null) return out;
    const { result } = await profiler.post("Profiler.takePreciseCoverage");
    for (const script of result) {
      if (script.url === "" || script.url.startsWith("node:")) continue;
      if (script.functions.some((fn) => fn.ranges.some((range) => range.count > 0))) out.add(script.url);
    }
    return out;
  };

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
  const beforeEvaluated = await evaluatedScripts();
  const targets = slotRootModules(resolve(REPO_ROOT, entry));
  for (const target of targets) await import(pathToFileURL(target).href);
  const afterEvaluated = await evaluatedScripts();

  const result: ChildResult = {
    entry,
    resolutions: resolved.size - before,
    evaluated: profiler === null ? null : [...afterEvaluated].filter((url) => !beforeEvaluated.has(url)).length,
    evaluationNote,
    imported: targets.length,
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
        ...(slotRootFlag ? { slotRoot: true as const } : {}),
        floor: floorFlag.length > 0 ? Number(floorFlag[0]) : 1,
        evalFloor: evalFloorFlag.length > 0 ? Number(evalFloorFlag[0]) : 1,
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
let totalEvaluated = 0;
let eagerReadCount = 0;

for (const entry of entries) {
  if (entry.slotRoot === true && !existsSync(resolve(REPO_ROOT, entry.module))) {
    problems.push(
      `the slot root ${entry.module} does not exist. \`oe build\` materialises it from roster.config.ts — run ` +
        "`npm run oe:build` (the test chain's pre-step does) and run this gate again. An absent slot root is " +
        "not a pass: every module eve mounts from it would go unwatched.",
    );
    continue;
  }
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
  totalEvaluated += result.evaluated ?? 0;

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
        "This arm counts REACH: the evaluation half below is what sees a graph that still resolves " +
        "and stopped evaluating (OPE-1350, OPE-1353).",
    );
  }
  if (result.evaluated === null) {
    problems.push(
      `booting ${entry.module} could not count evaluated scripts — ${result.evaluationNote ?? "no reason reported"}. ` +
        "Arm ⑤'s evaluation half is what proves the graph arm ② watches actually RAN, so a child that " +
        "cannot measure it is not a pass. Do not read this as a zero.",
    );
  } else if (result.evaluated < entry.evalFloor) {
    problems.push(
      `booting ${entry.module} evaluated ${result.evaluated} script(s), under its declared evaluation floor of ` +
        `${entry.evalFloor}. This is the arm the resolve count could not carry: a graph refactored to resolve ` +
        "eagerly and import() lazily after registration keeps its resolve count up while little of it runs " +
        "pre-registration, and arm ② then watches almost nothing. Either that graph really stopped evaluating " +
        "— then lower this entry's evalFloor deliberately, in a diff — or the import is no longer running what " +
        "it used to.",
    );
  }
  if (entry.excused !== undefined) {
    for (const problem of auditEagerReads(result.reads, entry.excused)) problems.push(`booting ${entry.module}: ${problem}`);
    eagerReadCount += result.reads.length;
    continue;
  }
  for (const read of result.reads) reads.set(eagerReadKey(read), read);
}

if (listMode) {
  for (const result of results) {
    console.log(
      `  ${result.entry}: ${result.imported} module(s) imported, ${result.resolutions} module URL(s) resolved, ` +
        `${result.evaluated ?? "no"} script(s) evaluated, ${result.traps} trap(s)`,
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
    `(reach) and ${totalEvaluated} script(s) evaluated (arm ⑤), ${reads.size + eagerReadCount} settings read(s) before ` +
    `registerSettings() (${EAGER_SETTINGS_READ_ALLOWLIST.size} allowlisted survivor(s), ${eagerReadCount} excused on a ` +
    "slot-root boot) — no module-level read pins a shipped default on any booted entry.",
);
process.exit(0);

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveRegistryMountSets, readEveFrameworkTools, readReservedFrameworkToolNames, readTaskToolNames, type EveFrameworkTools } from "./eve-framework-tools.js";
import {
  checkWindowGateManifest,
  classifyFrameworkTools,
  JOB_WAKE_TOOLS,
  WINDOW_GATED_TOOLS,
  WINDOW_UNGATED_TOOLS,
  fullKit,
  type WindowToolSource,
} from "../agent/access/window-gate-manifest.js";
import { installedEveRoot, readEveSchemaHelpers } from "./eve-tool-schema.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};
function throwsWith(fn: () => unknown, needle: string, label: string): void {
  let message: string | undefined;
  try {
    fn();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  ok(message !== undefined, `${label} — it must THROW, and it did not`);
  ok(message?.includes(needle) === true, `${label} — the message names the drift (${JSON.stringify(needle)}); got ${JSON.stringify(message)}`);
}

async function throwsAsyncWith(fn: () => Promise<unknown>, needle: string, label: string): Promise<void> {
  let message: string | undefined;
  try {
    await fn();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  ok(message !== undefined, `${label} — it must THROW, and it did not`);
  ok(message?.includes(needle) === true, `${label} — the message names the drift (${JSON.stringify(needle)}); got ${JSON.stringify(message)}`);
}

interface FakeSurface {
  readonly defaultMounted: readonly string[];
  readonly rootOnly: readonly string[];
  readonly optIn: readonly string[];
  readonly reserved: readonly string[];
  readonly taskTools: readonly string[];
}

const RC_SURFACE: FakeSurface = {
  defaultMounted: ["bash", "edit_file", "read_file", "web_fetch", "web_search", "write_file"],
  rootOnly: ["agent"],
  optIn: ["ask_question", "glob", "grep"],
  reserved: ["eve__reply", "eve__search", "eve__skill", "eve__task_cancel", "eve__task_wait", "eve__tool"],
  taskTools: ["eve__task_cancel", "eve__task_wait"],
};

const fakeEveRoots: string[] = [];
function writeFakeEve(surface: FakeSurface): string {
  const root = mkdtempSync(join(tmpdir(), "oe-eve-rc-fixture-"));
  fakeEveRoots.push(root);
  const write = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  const lit = (names: readonly string[]): string => names.map((name) => "`" + name + "`").join(",");
  const modules = (names: readonly string[]): string => names.map((name) => `{logicalPath:\`tools/${name}.ts\`}`).join(",");
  write("package.json", JSON.stringify({ name: "eve", type: "module", exports: Object.fromEntries(surface.optIn.map((name) => [`./tools/${name}`, `./tools/${name}.js`])) }));
  write(
    "dist/src/framework/sources/registry.js",
    `const frameworkAgentSourceRegistry={registrations:[{applyTo:\`all-local-nodes\`,source:{modules:[{logicalPath:\`agent.ts\`},${modules(surface.defaultMounted)}]}},` +
      `{applyTo:\`root\`,source:{modules:[${modules(surface.rootOnly)},{logicalPath:\`channels/eve.ts\`}]}}]};export{frameworkAgentSourceRegistry};`,
  );
  write("dist/src/compiler/default-tool-policy.js", "function applyDefaultToolPolicy(){}export{applyDefaultToolPolicy};");
  write("dist/src/protocol/task-tools.js", `const TASK_TOOL_NAMES=[${lit(surface.taskTools)}];export{TASK_TOOL_NAMES};`);
  write("dist/src/protocol/runtime-tools.js", "function eveNamespaceReservation(e){return e===`eve`||e.startsWith(`eve__`)?`reserved`:void 0}export{eveNamespaceReservation};");
  write(
    "dist/src/protocol/catalog-tools.js",
    "const SEARCH_TOOL_NAME=`eve__search`;const CALL_TOOL_NAME=`eve__tool`;const SKILL_TOOL_NAME=`eve__skill`;export{CALL_TOOL_NAME,SEARCH_TOOL_NAME,SKILL_TOOL_NAME};",
  );
  write("dist/src/protocol/reply-tool.js", `const REPLY_TOOL_NAME=\`eve__reply\`;export{REPLY_TOOL_NAME};`);
  return root;
}

const reg = (applyTo: string, ...logicalPaths: string[]) => ({
  applyTo,
  source: { modules: logicalPaths.map((logicalPath) => ({ logicalPath })) },
});

const healthy = () => [
  reg("all-local-nodes", "agent.ts", "tools/bash.ts", "tools/read_file.ts", "channels/eve.ts"),
  reg("root", "tools/agent.ts", "tools/stop_job.ts"),
];

{
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");

  ok(existsSync(join(here, "eve-framework-tools.ts")), "the reader lives beside this test in packages/core/scripts/");
  ok(
    !existsSync(join(repoRoot, "packages", "core", "agent", "access", "eve-framework-tools.ts")),
    "🔴 and NOT under packages/core/agent/ — that path is scanned by lint:hosted-externals and published on the exports map",
  );

  const providers = join(repoRoot, "packages", "providers");
  const runtimeSrcDirs = [
    join(repoRoot, "packages", "core", "agent"),
    join(repoRoot, "packages", "adapters", "agent"),
    join(repoRoot, "agent"),
    ...(existsSync(providers)
      ? readdirSync(providers, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => join(providers, e.name, "agent"))
      : []),
  ].filter((d) => existsSync(d));
  ok(runtimeSrcDirs.length >= 3, "the runtime source dirs resolved — an empty list would make the sweep below vacuous");

  const walkTs = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkTs(p, out);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
    }
    return out;
  };
  const IMPORTS_READER = /(?:^\s*(?:import|export)[^;]*?from\s*|\bimport\s*\(\s*)["'][^"']*eve-framework-tools(?:\.js)?["']/m;
  const offenders: string[] = [];
  let scanned = 0;
  for (const dir of runtimeSrcDirs) {
    for (const file of walkTs(dir)) {
      scanned++;
      if (IMPORTS_READER.test(readFileSync(file, "utf8"))) offenders.push(file.slice(repoRoot.length + 1));
    }
  }
  ok(scanned > 100, `the sweep read the tree — ${scanned} runtime source files (a near-zero count would make the next assertion vacuous)`);
  eq(
    offenders,
    [],
    "🔴 NO runtime module imports the framework-tool reader. It reaches node_modules/eve by absolute path, and the hosted bundle ships no node_modules/eve — a runtime import is a cold-start-class crash that every source-checkout test passes (OPE-1041)",
  );

  const gateImporters = ["scripts/window-gate-lint.ts", "scripts/subagents-lint.ts", "scripts/read-mounted-tools.ts"]
    .map((rel) => join(repoRoot, rel))
    .filter((p) => existsSync(p) && IMPORTS_READER.test(readFileSync(p, "utf8")));
  eq(gateImporters.length, 3, "negative control: the same pattern DOES match the three root gates that import the reader");
}

{
  const sets = deriveRegistryMountSets(healthy());
  eq([...sets.defaultMounted].sort(), ["bash", "read_file"], "only `tools/<name>.ts` modules are tools — `agent.ts` and `channels/eve.ts` are not");
  eq([...sets.rootOnly].sort(), ["agent", "stop_job"], "the root scope yields the root-only verbs");
  eq([...sets.inRegistry].sort(), ["agent", "bash", "read_file", "stop_job"], "inRegistry is the union over every scope");
}

{
  const withThirdScope = [...healthy(), reg("leaf-nodes", "tools/edit_file.ts")];
  let sets: ReturnType<typeof deriveRegistryMountSets> | undefined;
  try {
    sets = deriveRegistryMountSets(withThirdScope);
  } catch {
  }
  const relabelled = [...healthy(), reg("root", "tools/edit_file.ts")];
  const union = deriveRegistryMountSets(relabelled).inRegistry;
  ok(union.has("edit_file"), "🔴 a tool registered under any scope reaches `inRegistry` — the totality every framework-tool lint keys on");
  ok(sets === undefined, "…and an unrecognised scope does not quietly return a shrunken set instead");
}

throwsWith(
  () => deriveRegistryMountSets([...healthy(), reg("leaf-nodes", "tools/edit_file.ts")]),
  "leaf-nodes",
  "🔴 a registration under a scope this reader cannot classify STOPS the run and names the scope",
);
{
  const sets = deriveRegistryMountSets([...healthy(), reg("leaf-nodes", "channels/home.ts")]);
  eq([...sets.defaultMounted].sort(), ["bash", "read_file"], "an unknown scope with no `tools/` module is ignored — the guard fires on tools, not on scopes");
}

throwsWith(
  () => deriveRegistryMountSets([reg("all-local-nodes", "tools/bash.ts")]),
  "root-only tools",
  "🔴 a registry with no ROOT-scoped tool throws — an empty set is the fail-open shape",
);
throwsWith(
  () => deriveRegistryMountSets([reg("root", "tools/agent.ts")]),
  "default-mounted",
  "🔴 a registry with no DEFAULT-scoped tool throws, for the same reason",
);
throwsWith(() => deriveRegistryMountSets([]), "0 default-mounted", "🔴 an empty registry throws rather than reporting an empty world");

{
  const live = await readEveFrameworkTools();
  ok(live.defaultMounted.length > 0, "the installed eve yields a non-empty default-mounted set");
  ok(live.rootOnly.length > 0, "…and a non-empty root-only set");
  ok(live.defaultMounted.includes("bash"), "`bash` is default-mounted — the premise sandbox_tools.ts's sentinels rest on");
  ok(
    live.defaultMounted.includes("edit_file"),
    "🔴 `edit_file` is DEFAULT-MOUNTED on eve 1.x — a write path every session holds unless a posture row and a sentinel say otherwise",
  );
  ok(
    !live.all.some((name) => name.startsWith("connection_")),
    "…and no `connection_*` name is a framework tool any more — connector calls reach the model through `eve__tool`",
  );
  ok(live.rootOnly.includes("agent"), "the delegation verb is ROOT-ONLY — a declared subagent never receives it");
  ok(!live.defaultMounted.includes("agent"), "…and it is therefore NOT default-mounted (the negative control on the split)");
  eq(live.optIn, ["ask_question", "glob", "grep"], "the committed opt-in snapshot still matches the installed dist — `ask_question` joined it at eve 0.65, which is why OE mounts the name itself");
  ok(!live.defaultMounted.includes("ask_question"), "…and `ask_question` really is absent from the registry, so an app that authors nothing mounts nothing under the name");
  eq(live.optInDrift, undefined, "…so nothing is degraded to `unknown`");
  for (const name of [...live.defaultMounted, ...live.rootOnly, ...(live.optIn ?? [])]) {
    ok(live.all.includes(name), `\`all\` carries every classified name — missing ${name} would make every lint blind to it`);
  }
  ok(!live.all.includes("sleep"), "🔴 `sleep` is NOT a framework tool — eve exports `./tools/sleep` and always has, but its own accessors never counted it, so the exports map is not a substitute for the registry");
  eq(
    live.reserved,
    [...RC_SURFACE.reserved],
    "🔴 the installed eve RESERVES exactly these six built-in names — its `eve__` namespace. An authored module at any of them fails `eve build`, a sentinel included. A seventh name here is a seventh model-visible tool with no slot",
  );
  ok(
    live.reserved.every((name) => !live.defaultMounted.includes(name) && !live.rootOnly.includes(name) && !(live.optIn ?? []).includes(name)),
    "…and no reserved name is also a registry or opt-in tool: a reserved name has no slot an app can author at",
  );
  eq(
    live.taskTools,
    ["eve__task_cancel", "eve__task_wait"],
    "🔴 the installed eve reserves exactly these task verbs — the pair its session injects per model call. A membership change must land in the SAME commit that moves the pin, because OE's two posture tables carry a row each",
  );
  ok(live.taskTools.every((name) => live.reserved.includes(name)), "…and each task verb is in the reserved set (the namespace rule covers it)");
  for (const name of [...live.reserved, ...live.taskTools]) {
    ok(live.all.includes(name), `\`all\` carries the reserved name ${name} — it is model-visible with no slot, so a lint that could not see it would call its posture row stale`);
  }
  ok(
    live.taskTools.every((name) => !live.defaultMounted.includes(name) && !live.rootOnly.includes(name)),
    "…and no task verb is in either registry scope (the negative control on the third class: they come from the session, not the source graph)",
  );
}

{
  const healthyRoot = (): string => writeFakeEve(RC_SURFACE);

  eq(await readReservedFrameworkToolNames(healthyRoot()), [...RC_SURFACE.reserved], "the reserved names are read off eve's protocol modules, sorted");

  {
    const root = healthyRoot();
    writeFileSync(join(root, "dist/src/protocol/catalog-tools.js"), "const SEARCH_TOOL_NAME=`eve__search`;const SKILL_TOOL_NAME=`eve__skill`;export{SEARCH_TOOL_NAME,SKILL_TOOL_NAME};");
    await throwsAsyncWith(() => readReservedFrameworkToolNames(root), "CALL_TOOL_NAME", "🔴 a protocol module that no longer exports a read name THROWS and names the export — a dropped name is a tool off every lint's surface");
  }
  {
    const root = healthyRoot();
    rmSync(join(root, "dist/src/protocol/runtime-tools.js"));
    await throwsAsyncWith(() => readReservedFrameworkToolNames(root), "runtime-tools.js", "🔴 an eve with no namespace-reservation module THROWS — the reader cannot prove the names are closed to an authored module");
  }
  {
    const root = healthyRoot();
    writeFileSync(join(root, "dist/src/protocol/runtime-tools.js"), "function eveNamespaceReservation(e){return e.startsWith(`eve__task_`)?`reserved`:void 0}export{eveNamespaceReservation};");
    await throwsAsyncWith(() => readReservedFrameworkToolNames(root), "does not reserve", "🔴 a declared built-in name that eve's own rule does NOT reserve THROWS — an unreserved name is an authorable slot");
  }
  {
    const root = healthyRoot();
    writeFileSync(join(root, "dist/src/protocol/new-tool.js"), "const NEW_TOOL_NAME=`eve__fork`;export{NEW_TOOL_NAME};");
    await throwsAsyncWith(() => readReservedFrameworkToolNames(root), "eve__fork", "🔴 a NEW `eve__` name declared in eve's protocol modules THROWS until the reader reads it — a new built-in tool cannot slip past the window gate");
  }
  {
    const root = healthyRoot();
    writeFileSync(join(root, "dist/src/compiler/default-tool-policy.js"), "const CONNECTION_TOOL_SLOTS=new Set([`tools/connection_search`]);");
    await throwsAsyncWith(() => readReservedFrameworkToolNames(root), "CONNECTION_TOOL_SLOTS", "🔴 a returned reserved-SLOT policy THROWS — that is a second reservation regime this reader does not read");
  }
  {
    const root = writeFakeEve({ ...RC_SURFACE, defaultMounted: [...RC_SURFACE.defaultMounted, "eve__tool"] });
    await throwsAsyncWith(() => readEveFrameworkTools({ eveRoot: root }), "two classes", "🔴 a reserved name that the registry ALSO mounts THROWS — one of the two reads is stale");
  }
}

{
  const fixtures: string[] = [];
  const fakeEve = (body: string | undefined): string => {
    const dir = mkdtempSync(join(tmpdir(), "oe-eve-tasktools-"));
    fixtures.push(dir);
    if (body === undefined) return dir;
    const protoDir = join(dir, "dist", "src", "protocol");
    mkdirSync(protoDir, { recursive: true });
    writeFileSync(join(protoDir, "task-tools.js"), body);
    return dir;
  };

  await throwsAsyncWith(
    () => readTaskToolNames(fakeEve(undefined)),
    "cannot read",
    "🔴 an eve with no task-tools module THROWS — an empty answer would take `eve__task_wait` and `eve__task_cancel` off every lint's surface and read as two stale rows",
  );

  eq(
    await readTaskToolNames(fakeEve("const TASK_TOOL_NAMES=[`eve__task_wait`,`eve__task_cancel`];export{TASK_TOOL_NAMES};")),
    ["eve__task_cancel", "eve__task_wait"],
    "the names are read off eve's own export, sorted",
  );

  await throwsAsyncWith(
    () => readTaskToolNames(fakeEve("const TASK_TOOL_NAMES=[];export{TASK_TOOL_NAMES};")),
    "non-empty",
    "🔴 an EMPTY array throws too — it is the fail-silent shape, not a release with no task verbs",
  );

  await throwsAsyncWith(
    () => readTaskToolNames(fakeEve("const SOMETHING_ELSE=[`eve__task_wait`];export{SOMETHING_ELSE};")),
    "non-empty",
    "🔴 …and so does a module that exports no `TASK_TOOL_NAMES` at all",
  );

  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
}

{
  const live = await readEveFrameworkTools();
  const fromFixture = await readEveFrameworkTools({ eveRoot: writeFakeEve(RC_SURFACE) });
  eq(
    fromFixture,
    live,
    "🔴 the committed rc fixture reads EXACTLY as the installed eve — when the pin moves, this fails until RC_SURFACE is regenerated from the new rc, so the fixture cannot drift from the real surface",
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const coreDir = join(here, "../agent/tools");
  const appDir = join(here, "../../../agent/tools");
  const coreTools: WindowToolSource[] = readdirSync(coreDir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    .map((f) => ({ name: f.replace(/\.ts$/u, ""), source: readFileSync(join(coreDir, f), "utf8") }));
  const appShims = new Map<string, string>();
  if (existsSync(appDir)) {
    for (const f of readdirSync(appDir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) appShims.set(f.replace(/\.ts$/u, ""), readFileSync(join(appDir, f), "utf8"));
  }
  const surfaceOf = (t: EveFrameworkTools) => classifyFrameworkTools(t.all, t.defaultMounted, t.optIn, [...t.reserved, ...t.taskTools]);
  const lint = (t: EveFrameworkTools, ungated: ReadonlySet<string>) =>
    checkWindowGateManifest(coreTools, appShims, surfaceOf(t), WINDOW_GATED_TOOLS, ungated, fullKit(), undefined, JOB_WAKE_TOOLS);

  const baseline = new Set(lint(fromFixture, WINDOW_UNGATED_TOOLS));
  for (const [label, surface] of [
    ["a new DEFAULT-MOUNTED tool", { ...RC_SURFACE, defaultMounted: [...RC_SURFACE.defaultMounted, "oe_fake_framework_tool"] }],
    ["a new ROOT-ONLY tool", { ...RC_SURFACE, rootOnly: [...RC_SURFACE.rootOnly, "oe_fake_framework_tool"] }],
  ] as const) {
    const withFake = await readEveFrameworkTools({ eveRoot: writeFakeEve(surface) });
    const fake = withFake.all.find((name) => !live.all.includes(name))!;
    ok(fake !== undefined, `${label}: the fixture reader surfaces the fake name`);
    const added = lint(withFake, WINDOW_UNGATED_TOOLS).filter((p) => !baseline.has(p));
    ok(
      added.length === 1 && added[0]!.includes(`tool "${fake}" has NO window-gate posture`),
      `🔴 ${label} in the rc fixture turns lint:window-gate RED with exactly one new problem, the unclassed name (got: ${JSON.stringify(added)})`,
    );
    const classed = lint(withFake, new Set([...WINDOW_UNGATED_TOOLS, fake])).filter((p) => !baseline.has(p));
    eq(classed, [], `…and classing "${fake}" in WINDOW_UNGATED_TOOLS clears it — the red holds only until the name is classed`);
  }
}

{
  const pub = (await import("eve/tools/agent")) as { default?: { inputSchema?: unknown }; agent?: () => { inputSchema?: unknown } };
  const schema = pub.default?.inputSchema;
  ok(schema !== undefined, "🔴 MOVED read: the public `eve/tools/agent` default export carries the built-in `agent` tool's inputSchema — the delegation tests read it here, not from eve's internal agent-contract module");
  ok(typeof pub.agent === "function" && pub.agent().inputSchema === schema, "…and `agent()` with no options returns the SAME schema, so the default export is the tool eve mounts");
  const { serializeInputSchema } = await readEveSchemaHelpers(installedEveRoot(import.meta.url));
  const emitted = serializeInputSchema(schema) as { required?: unknown; properties?: Record<string, unknown> };
  eq(emitted.required, ["message"], "🔴 the public agent schema requires exactly `message` — the input the delegation tests build their calls from. A new required field reaches every delegation call");
}

for (const root of fakeEveRoots) rmSync(root, { recursive: true, force: true });

console.log(`\n✓ eve-framework-tools: ${n} assertions passed (grammar, union totality, unknown-scope guard, empty-scope guards, reserved-name reader, task-verb reader, live premise, rc fixture, unclassed-name red)\n`);

// proves: ROSTER-reserved-slot
// proves: TOOL-glob, TOOL-grep, TOOL-eve__task_wait

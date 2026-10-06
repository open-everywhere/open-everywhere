import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveRegistryMountSets, readEveFrameworkTools, readReservedFrameworkToolSlots, readTaskToolNames } from "./eve-framework-tools.js";

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

const reg = (applyTo: string, ...logicalPaths: string[]) => ({
  applyTo,
  source: { modules: logicalPaths.map((logicalPath) => ({ logicalPath })) },
});

const healthy = () => [
  reg("all-local-nodes", "agent.ts", "tools/bash.ts", "tools/read_file.ts", "channels/eve.ts"),
  reg("root", "tools/agent.ts", "tools/task_cancel.ts"),
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
  eq([...sets.rootOnly].sort(), ["agent", "task_cancel"], "the root scope yields the root-only verbs");
  eq([...sets.inRegistry].sort(), ["agent", "bash", "read_file", "task_cancel"], "inRegistry is the union over every scope");
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
    live.defaultMounted.includes("connection_tools"),
    "🔴 `connection_tools` is DEFAULT-MOUNTED — it is the dynamic source that provides the connector verbs, and the slot the subagent lint must NOT demand a sentinel for",
  );
  ok(
    !live.defaultMounted.includes("connection_search") && !live.defaultMounted.includes("connection_execute"),
    "…and neither verb it provides is registered on its own (the negative control on that split: a sentinel for either would disable a slot with no lower-precedence source)",
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
    ["connection_execute", "connection_search", "connection_tools"],
    "🔴 the installed eve RESERVES exactly the three connector slots — an authored module at any of them fails `eve build`, a sentinel included (OPE-2247/OPE-2254). A fourth name here is a fourth slot no app may fill",
  );
  ok(
    live.reserved.some((name) => live.defaultMounted.includes(name)),
    "…and at least one reserved slot is DEFAULT-MOUNTED, which is what makes the exemption load-bearing: without it the zero-hands gates demand a sentinel eve throws on",
  );
  eq(
    live.taskTools,
    ["task_cancel", "task_wait"],
    "🔴 the installed eve reserves exactly these task verbs — the pair its session injects per model call. A membership change must land in the SAME commit that moves the pin, because OE's two posture tables carry a row each",
  );
  for (const name of [...live.reserved, ...live.taskTools]) {
    ok(live.all.includes(name), `\`all\` carries the reserved name ${name} — it is model-visible with no slot, so a lint that could not see it would call its posture row stale`);
  }
  ok(
    live.taskTools.every((name) => !live.defaultMounted.includes(name) && !live.rootOnly.includes(name)),
    "…and no task verb is in either registry scope (the negative control on the third class: they come from the session, not the source graph)",
  );
}

{
  const dir = mkdtempSync(join(tmpdir(), "oe-eve-policy-"));
  const policyDir = join(dir, "dist", "src", "compiler");
  mkdirSync(policyDir, { recursive: true });
  const policy = join(policyDir, "default-tool-policy.js");

  eq(readReservedFrameworkToolSlots(dir), [], "an eve that ships NO default-tool policy reserves nothing — every slot stays authorable, which is what such an eve accepts");

  writeFileSync(policy, "const CONNECTION_TOOL_SLOTS=new Set([`tools/connection_search`]);");
  eq(readReservedFrameworkToolSlots(dir), ["connection_search"], "one reserved slot is read off the declaration, with the `tools/` prefix stripped");

  writeFileSync(policy, 'const CONNECTION_TOOL_SLOTS=new Set(["tools/connection_search","tools/connection_execute"]);');
  eq(readReservedFrameworkToolSlots(dir), ["connection_execute", "connection_search"], "…and several are read, sorted — the case that arms the lint before eve's build throws");

  writeFileSync(
    policy,
    "const CONNECTION_TOOLS_SLOT=`tools/connection_tools`,CONNECTION_TOOL_SLOTS=new Set([CONNECTION_TOOLS_SLOT,`tools/connection_search`]);",
  );
  eq(
    readReservedFrameworkToolSlots(dir),
    ["connection_search", "connection_tools"],
    "a `tools/<name>` CONSTANT in the set resolves — eve spells its own declaration this way, so a literal-only parse would silently under-report",
  );

  writeFileSync(policy, "const CONNECTION_TOOL_SLOTS=new Set([]);");
  eq(readReservedFrameworkToolSlots(dir), [], "an explicitly EMPTY policy reserves nothing — a retired policy is not a parse failure");

  writeFileSync(policy, "const SOMETHING_ELSE_ENTIRELY=new Set([`tools/connection_search`]);");
  throwsWith(() => readReservedFrameworkToolSlots(dir), "default-tool-policy.js", "🔴 a policy module whose declaration was renamed THROWS rather than reporting `nothing reserved`");

  writeFileSync(policy, "const CONNECTION_TOOL_SLOTS=new Set([SOME_UNRESOLVABLE_CONSTANT]);");
  throwsWith(() => readReservedFrameworkToolSlots(dir), "cannot resolve", "🔴 …and so does an entry that resolves to no `tools/<name>` slot — the under-report direction, which must never pass silently");

  rmSync(dir, { recursive: true, force: true });
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
    "🔴 an eve with no task-tools module THROWS — an empty answer would take `task_wait` and `task_cancel` off every lint's surface and read as two stale rows",
  );

  eq(
    await readTaskToolNames(fakeEve("const TASK_TOOL_NAMES=[`task_wait`,`task_cancel`];export{TASK_TOOL_NAMES};")),
    ["task_cancel", "task_wait"],
    "the names are read off eve's own export, sorted",
  );

  await throwsAsyncWith(
    () => readTaskToolNames(fakeEve("const TASK_TOOL_NAMES=[];export{TASK_TOOL_NAMES};")),
    "non-empty",
    "🔴 an EMPTY array throws too — it is the fail-silent shape, not a release with no task verbs",
  );

  await throwsAsyncWith(
    () => readTaskToolNames(fakeEve("const SOMETHING_ELSE=[`task_wait`];export{SOMETHING_ELSE};")),
    "non-empty",
    "🔴 …and so does a module that exports no `TASK_TOOL_NAMES` at all",
  );

  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n✓ eve-framework-tools: ${n} assertions passed (grammar, union totality, unknown-scope guard, empty-scope guards, reserved-slot reader, task-verb reader, live premise)\n`);

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveRegistryMountSets, readEveFrameworkTools, readRequiredFrameworkToolSlots } from "./eve-framework-tools.js";

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
    live.defaultMounted.includes("connection_search"),
    "🔴 `connection_search` is DEFAULT-MOUNTED — eve 0.44.3 omitted it from every accessor, which is why the declared subagent mounted it unfenced until OPE-1258",
  );
  ok(live.rootOnly.includes("agent"), "the delegation verb is ROOT-ONLY — a declared subagent never receives it");
  ok(!live.defaultMounted.includes("agent"), "…and it is therefore NOT default-mounted (the negative control on the split)");
  eq(live.optIn, ["glob", "grep"], "the committed opt-in snapshot still matches the installed dist");
  eq(live.optInDrift, undefined, "…so nothing is degraded to `unknown`");
  for (const name of [...live.defaultMounted, ...live.rootOnly, ...(live.optIn ?? [])]) {
    ok(live.all.includes(name), `\`all\` carries every classified name — missing ${name} would make every lint blind to it`);
  }
  ok(!live.all.includes("sleep"), "🔴 `sleep` is NOT a framework tool — eve exports `./tools/sleep` and always has, but its own accessors never counted it, so the exports map is not a substitute for the registry");
  eq(
    live.required,
    ["connection_search"],
    "🔴 the installed eve REQUIRES exactly `connection_search` — the slot a `disableTool()` sentinel throws at build on (OPE-1537). A second name here means a second subagent slot needs an authored no-op replacement",
  );
  for (const name of live.required) {
    ok(live.defaultMounted.includes(name), `every REQUIRED name is also default-mounted — ${name} would otherwise be a demand for a file in a slot eve never mounts`);
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "oe-eve-policy-"));
  const policyDir = join(dir, "dist", "src", "compiler");
  mkdirSync(policyDir, { recursive: true });
  const policy = join(policyDir, "default-tool-policy.js");

  eq(readRequiredFrameworkToolSlots(dir), [], "an eve that ships NO default-tool policy requires nothing — every slot stays disableable, which is what such an eve accepts");

  writeFileSync(policy, "const REQUIRED_FRAMEWORK_TOOL_SLOTS=new Set([`tools/connection_search`]);");
  eq(readRequiredFrameworkToolSlots(dir), ["connection_search"], "one required slot is read off the declaration, with the `tools/` prefix stripped");

  writeFileSync(policy, 'const REQUIRED_FRAMEWORK_TOOL_SLOTS=new Set(["tools/connection_search","tools/read_file"]);');
  eq(readRequiredFrameworkToolSlots(dir), ["connection_search", "read_file"], "…and several are read, sorted — the case that arms the lint before eve's build throws");

  writeFileSync(policy, "const REQUIRED_FRAMEWORK_TOOL_SLOTS=new Set([]);");
  eq(readRequiredFrameworkToolSlots(dir), [], "an explicitly EMPTY policy requires nothing — a retired policy is not a parse failure");

  writeFileSync(policy, "const SOMETHING_ELSE_ENTIRELY=new Set([`tools/connection_search`]);");
  throwsWith(() => readRequiredFrameworkToolSlots(dir), "default-tool-policy.js", "🔴 a policy module whose declaration was renamed THROWS rather than reporting `nothing required`");

  writeFileSync(policy, "const REQUIRED_FRAMEWORK_TOOL_SLOTS=new Set([SOME_CONSTANT]);");
  throwsWith(() => readRequiredFrameworkToolSlots(dir), "cannot parse", "🔴 …and so does a declaration whose entries are not slot literals");

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n✓ eve-framework-tools: ${n} assertions passed (grammar, union totality, unknown-scope guard, empty-scope guards, required-slot reader, live premise)\n`);

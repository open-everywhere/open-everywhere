import assert from "node:assert/strict";

import { deriveRegistryMountSets, readEveFrameworkTools } from "../agent/access/eve-framework-tools.js";

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
}

console.log(`\n✓ eve-framework-tools: ${n} assertions passed (grammar, union totality, unknown-scope guard, empty-scope guards, live premise)\n`);

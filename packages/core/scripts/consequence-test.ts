import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkConsequenceRegistry, TOOL_CONSEQUENCE, type ConsequenceEntry, type ToolSource } from "../agent/access/consequence.js";
import { actionKind } from "../agent/approvals/actions.js";
import "../agent/approvals/flow.js";

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { getAllFrameworkToolNames } = (await import(
  pathToFileURL(join(eveRoot, "dist/src/runtime/framework-tools/index.js")).href
)) as { getAllFrameworkToolNames(): ReadonlySet<string> };
const FRAMEWORK_TOOL_NAMES = [...getAllFrameworkToolNames(), "connection_search"];

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function firesWith(problems: string[], needle: string, label: string): void {
  ok(problems.some((p) => p.includes(needle)), `${label} (got: ${JSON.stringify(problems)})`);
}

const policyOf = (action: string): "admin" | "member" | undefined =>
  ({ "test.member": "member" as const, "test.admin": "admin" as const })[action];

const chk = (
  tools: ToolSource[],
  policyOfArg: (a: string) => "admin" | "member" | undefined,
  registry: Record<string, ConsequenceEntry>,
  framework: string[] = [],
) => checkConsequenceRegistry(tools, framework, policyOfArg, registry);

const gatedSource = (kind: string) => `
  approval: never(),
  async execute() { await requestApproval({ kind: "${kind}" }); }
`;

{
  const tools: ToolSource[] = [
    { name: "a_read", source: "async execute() { return 1; }" },
    { name: "a_gate", source: gatedSource("test.member") },
  ];
  const registry: Record<string, ConsequenceEntry> = {
    a_read: { tier: "open", via: { kind: "none" }, reason: "read" },
    a_gate: { tier: "gate:member", via: { kind: "action-kind", action: "test.member" }, reason: "gated" },
  };
  ok(chk(tools, policyOf, registry).length === 0, "a total, matching registry is clean");
}

firesWith(
  chk([{ name: "mystery", source: "" }], policyOf, {}),
  'tool "mystery" has NO consequence declaration',
  "an unregistered tool FAILS (no default tier)",
);
firesWith(
  chk([], policyOf, { ghost: { tier: "open", via: { kind: "none" }, reason: "x" } }),
  'neither an authored tool file nor a mounted framework tool',
  "a stale registry row FAILS",
);

firesWith(
  chk(
    [{ name: "t", source: "async execute() { justDoIt(); }" }],
    policyOf,
    { t: { tier: "gate:member", via: { kind: "action-kind", action: "test.member" }, reason: "x" } },
  ),
  "never calls requestApproval",
  "a gate:member tool whose source never proposes FAILS (under-gated)",
);
firesWith(
  chk(
    [{ name: "t", source: "async execute() { mutate(); }" }],
    policyOf,
    { t: { tier: "gate:admin", via: { kind: "none" }, reason: "x" } },
  ),
  "NO gating mechanism",
  "a gate:* tier with mechanism none FAILS (under-gated declaration)",
);
firesWith(
  chk(
    [{ name: "t", source: "adminish\n  async execute() { mutate(); }" }],
    policyOf,
    { t: { tier: "gate:admin", via: { kind: "admin-roles" }, reason: "x" } },
  ),
  "no requireOrgAdmin/requireDomainAdminOrOrg/adminControlRoles call",
  "an admin-roles declaration with no roles call in source FAILS",
);

firesWith(
  chk(
    [{ name: "t", source: gatedSource("test.admin") }],
    policyOf,
    { t: { tier: "gate:member", via: { kind: "action-kind", action: "test.admin" }, reason: "x" } },
  ),
  'registers ApproverPolicy "admin"',
  "tier gate:member over an admin-policy kind FAILS (mismatch)",
);
firesWith(
  chk(
    [{ name: "t", source: gatedSource("test.unregistered") }],
    policyOf,
    { t: { tier: "gate:member", via: { kind: "action-kind", action: "test.unregistered" }, reason: "x" } },
  ),
  "no such kind is registered",
  "an ActionKind row pointing at an unregistered kind FAILS",
);
firesWith(
  chk(
    [{ name: "t", source: gatedSource("test.member").replace('"test.member"', '"other.kind"') }],
    policyOf,
    { t: { tier: "gate:member", via: { kind: "action-kind", action: "test.member" }, reason: "x" } },
  ),
  "never names that kind",
  "an ActionKind row whose kind string is absent from the source FAILS",
);

firesWith(
  chk(
    [{ name: "t", source: gatedSource("test.member") }],
    policyOf,
    { t: { tier: "open", via: { kind: "none" }, reason: "x" } },
  ),
  "carries a gating construct",
  "an open/none tool that actually gates FAILS (a gate change must be a registry diff)",
);
firesWith(
  chk(
    [{ name: "t", source: "export default defineTool({\n  approval: always(),\n});" }],
    policyOf,
    { t: { tier: "open", via: { kind: "none" }, reason: "x" } },
  ),
  "carries a gating construct",
  "an open/none tool with eve `approval: always()` FAILS the drift scan",
);
{
  const problems = chk(
    [{ name: "t", source: "export default defineTool({\n  approval: never(),\n});" }],
    policyOf,
    { t: { tier: "open", via: { kind: "none" }, reason: "x" } },
  );
  ok(problems.length === 0, "`approval: never()` does not trip the eve-hitl scan");
}

firesWith(
  chk(
    [{ name: "t", source: "  approval: always()," }],
    policyOf,
    { t: { tier: "gate:member", via: { kind: "eve-hitl" }, reason: "x" } },
  ),
  "cannot carry a gate:* tier",
  "eve-hitl with a gate:* tier FAILS (no approver-standing check — design §7.2)",
);

{
  firesWith(
    chk([], policyOf, {}, ["web_search"]),
    'framework tool "web_search" is mounted by eve at runtime but has NO consequence declaration',
    "an un-registered framework tool FAILS fail-closed",
  );
  firesWith(
    chk([], policyOf, { web_search: { tier: "gate:member", via: { kind: "action-kind", action: "x" }, reason: "y" } }, ["web_search"]),
    "must be open/none",
    "a framework tool declared gate:* FAILS (ship an override to gate it)",
  );
  ok(
    chk(
      [{ name: "bash", source: gatedSource("test.member") }],
      policyOf,
      { bash: { tier: "gate:member", via: { kind: "action-kind", action: "test.member" }, reason: "overridden + gated" } },
      ["bash"],
    ).length === 0,
    "an OE-overridden framework tool is scanned as an authored file (may be gated)",
  );
  ok(
    chk([], policyOf, { web_search: { tier: "open", via: { kind: "none" }, reason: "read" } }, ["web_search"]).length === 0,
    "a framework tool declared open/none is clean",
  );
}

{
  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "../agent/tools");
  const tools: ToolSource[] = readdirSync(toolsDir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    .map((f) => ({ name: f.replace(/\.ts$/u, ""), source: readFileSync(join(toolsDir, f), "utf8") }));
  const coreToolNames = new Set(tools.map((t) => t.name));
  const coreRegistry = Object.fromEntries(Object.entries(TOOL_CONSEQUENCE).filter(([name]) => coreToolNames.has(name) || name !== "extend_workspace_time"));
  const problems = checkConsequenceRegistry(tools, FRAMEWORK_TOOL_NAMES, (action) => actionKind(action)?.policy, coreRegistry);
  ok(problems.length === 0, `the REAL tool set + framework tools match the registry (problems: ${JSON.stringify(problems)})`);
  ok(tools.length >= 40, `the real scan actually covered the tools dir (saw ${tools.length})`);
  ok(FRAMEWORK_TOOL_NAMES.length >= 10, `the eve framework enumeration is populated (saw ${FRAMEWORK_TOOL_NAMES.length})`);

  for (const name of FRAMEWORK_TOOL_NAMES.filter((f) => !coreToolNames.has(f))) {
    const entry = TOOL_CONSEQUENCE[name];
    ok(entry?.tier === "open" && entry.via.kind === "none", `framework-only tool "${name}" is declared open/none`);
  }

  ok(TOOL_CONSEQUENCE.open_pull_request.tier === "gate:member", "open_pull_request is declared gate:member");
  const via = TOOL_CONSEQUENCE.open_pull_request.via;
  ok(via.kind === "action-kind" && via.action === "pr.open", "open_pull_request routes via the pr.open ActionKind");
  ok(actionKind("pr.open")?.policy === "member", "the pr.open kind is registered with member policy");
  ok(TOOL_CONSEQUENCE.set_spend_limit.tier === "gate:admin", "set_spend_limit is declared gate:admin");
  ok(TOOL_CONSEQUENCE.reply.tier === "open", "reply is declared open (same-room, fails all three rubric axes)");
}

console.log(`✓ ${n} consequence-registry assertions passed`);

import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkActionKindCoverage,
  checkActionKindRegistry,
  checkApprovalSites,
  checkConsequenceRegistry,
  findActionKindRegistrations,
  findEveApprovalSites,
  NON_TOOL_ACTION_KINDS,
  TOOL_CONSEQUENCE,
  type ConsequenceEntry,
  type ToolSource,
} from "../agent/access/consequence.js";
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
    a_gate: { tier: "gate:member", via: { kind: "action-kind", action: "test.member" }, taint: "disclose", reason: "gated" },
  };
  ok(chk(tools, policyOf, registry).length === 0, "a total, matching registry is clean");

  const untainted: Record<string, ConsequenceEntry> = {
    a_gate: { tier: "gate:member", via: { kind: "action-kind", action: "test.member" }, reason: "gated, column forgotten" },
  };
  firesWith(
    chk([{ name: "a_gate", source: gatedSource("test.member") }], policyOf, untainted),
    "declares no taint tolerance",
    "a gated row without a taint column FAILS (the tolerance is a decision, not an omission)",
  );
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
  const chkD = (
    tools: ToolSource[],
    registry: Record<string, ConsequenceEntry>,
    modules: Map<string, string>,
  ) => checkConsequenceRegistry(tools, [], policyOf, registry, [], modules);

  const toolSrc = { name: "report", source: "async execute(i, ctx) { const s = resolveScope(ctx, i.scope); }" };
  const row: ConsequenceEntry = { tier: "open", via: { kind: "delegated-roles", helper: "resolveScope", module: "pkg/scope.ts" }, reason: "x" };
  const gatedModule = new Map([["pkg/scope.ts", 'export function resolveScope(ctx) { if (s === "org") requireOrgAdmin(ctx); }']]);

  ok(chkD([toolSrc], { report: row }, gatedModule).length === 0, "delegated-roles: a tool that calls its declared helper, whose module really gates, is clean");

  firesWith(
    chkD([{ name: "report", source: "async execute() { return rows(); }" }], { report: row }, gatedModule),
    "never calls it",
    "delegated-roles: a tool that DOESN'T call its declared helper FAILS — the row would otherwise point at a gate the tool never reaches",
  );
  firesWith(
    chkD([toolSrc], { report: row }, new Map([["pkg/scope.ts", "export function resolveScope(ctx) { return { org: ctx.org }; }"]])),
    "the gate it points at is gone",
    "delegated-roles: 🔴 a module that STOPPED gating FAILS — this is the direction a per-file scan can never see, and the whole reason the delegation is declared",
  );
  firesWith(
    chkD([toolSrc], { report: row }, new Map()),
    "refusing to pass a gate nobody read",
    "delegated-roles: an unsupplied module FAILS rather than passing — 'we could not read the gate' must not produce the same green as 'the gate is there'",
  );
  firesWith(
    chkD([toolSrc], { report: { ...row, tier: "gate:member" } }, gatedModule),
    "the tier is either gate:admin",
    "delegated-roles: a gate:member tier FAILS — the delegated mechanism enforces ADMIN standing, so member would be a claim the gate cannot deliver",
  );

  firesWith(
    chkD(
      [toolSrc, { name: "sneaky", source: "async execute(ctx) { resolveScope(ctx, \"org\"); return all(); }" }],
      { report: row, sneaky: { tier: "open", via: { kind: "none" }, reason: "x" } },
      gatedModule,
    ),
    'calls "resolveScope", which "report" declares as a cross-file admin gate',
    "delegated-roles: 🔴 a SECOND tool calling the same helper while declaring open/none FAILS — otherwise the hole just reopens one file over",
  );
}

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
      { bash: { tier: "gate:member", via: { kind: "action-kind", action: "test.member" }, taint: "disclose", reason: "overridden + gated" } },
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
  const toolReg: Record<string, ConsequenceEntry> = {
    t: { tier: "gate:member", via: { kind: "action-kind", action: "test.member" }, reason: "x" },
  };
  const pinned = { "test.orphan": { tier: "gate:member" as const, reason: "raised by a hook, not a verb" } };
  const pol = (a: string) => ({ "test.member": "member" as const, "test.orphan": "member" as const })[a];

  ok(checkActionKindRegistry(["test.member", "test.orphan"], pol, toolReg, pinned).length === 0, "action-kinds: a kind proposed by a tiered tool plus a pinned orphan is clean");
  firesWith(
    checkActionKindRegistry(["test.member", "test.loose"], pol, toolReg, pinned),
    'no tool proposes it and it has no row in NON_TOOL_ACTION_KINDS',
    "action-kinds: 🔴 a registered kind nothing proposes and nothing pins FAILS — a live approval bar nobody recorded a decision about",
  );
  firesWith(
    checkActionKindRegistry(["test.member", "test.orphan"], (a) => (a === "test.orphan" ? "admin" : "member"), toolReg, pinned),
    "the declaration and the runtime bar disagree",
    "action-kinds: a pinned tier that no longer matches the kind's live ApproverPolicy FAILS — the same cross-check the tool rows get",
  );
  firesWith(
    checkActionKindRegistry(["test.member"], pol, toolReg, pinned),
    "no such kind is registered",
    "action-kinds: a STALE pin FAILS — a pin for a kind that is gone reads as coverage and is the opposite",
  );
  firesWith(
    checkActionKindRegistry(["test.member"], pol, toolReg, { "test.member": { tier: "gate:member", reason: "x" } }),
    "is declared TWICE",
    "action-kinds: a kind declared in BOTH tables FAILS — two declarations for one bar are free to drift apart",
  );
}

{
  const src = [
    'import { registerActionKind } from "./actions.js";',
    "",
    "const inlineKind: ActionKind<Args> = {",
    '  kind: "test.inline",',
    '  policy: "member",',
    "};",
    "",
    'const INDIRECT = "test.indirect";',
    "const indirectKind: ActionKind<Args> = {",
    "  kind: INDIRECT,",
    '  policy: "member",',
    "};",
    "",
    "registerActionKind(inlineKind);",
    "registerActionKind(indirectKind);",
  ].join("\n");
  const found = findActionKindRegistrations("agent/approvals/x.ts", src);
  ok(found.length === 2, "kind-coverage: both `registerActionKind(...)` statements are found");
  ok(found[0]!.kind === "test.inline" && found[0]!.line === 14, "kind-coverage: an inline `kind:` literal resolves, at the REGISTRATION's line");
  ok(found[1]!.kind === "test.indirect", "kind-coverage: a `kind:` naming a module-scope string const resolves through it");

  ok(checkActionKindCoverage(found, ["test.inline", "test.indirect"]).length === 0, "kind-coverage: every on-disk registration present in the live enumeration is clean");
  firesWith(
    checkActionKindCoverage(found, ["test.inline"]),
    "ABSENT from the live registry enumerated here",
    "kind-coverage: 🔴 a kind registered ON DISK but missing from the enumeration FAILS — this is the one check that catches it; with no pin and no tool row, checks 1-3 are entirely silent",
  );
  firesWith(
    checkActionKindCoverage([], ["test.inline"]),
    "the scan is broken",
    "kind-coverage: an EMPTY scan refuses rather than reporting clean — nothing found must never look the same as nothing wrong",
  );
  const unresolved = findActionKindRegistrations("agent/approvals/y.ts", "registerActionKind(fromElsewhere);");
  ok(unresolved.length === 1 && unresolved[0]!.kind === undefined, "kind-coverage: an unresolvable identifier is still REPORTED as a site");
  firesWith(
    checkActionKindCoverage(unresolved, ["test.inline"]),
    "cannot confirm the kind reaches the registry",
    "kind-coverage: …and an unresolved registration FAILS rather than passing as covered",
  );
  ok(
    findActionKindRegistrations("agent/approvals/actions.ts", "export function registerActionKind(k: ActionKind<any>): void {").length === 0,
    "kind-coverage: the `registerActionKind` DEFINITION is not read as a registration",
  );
}

{
  const src = 'export default defineMcpClientConnection({\n  auth: a,\n  approval: connectorApprovalPolicy(),\n});';
  const sites = findEveApprovalSites("agent/connections/x.ts", src);
  ok(sites.length === 1 && sites[0]!.line === 3, "approval-sites: an eve-native `approval:` outside a tool file is FOUND, at its line");
  ok(findEveApprovalSites("agent/connections/x.ts", "  approval: never(),").length === 0, "approval-sites: `approval: never()` is not a site — it is the explicit ABSENCE of a policy, and the tool arm agrees (same predicate)");

  firesWith(
    checkApprovalSites(sites, {}),
    "must be accounted for in NON_TOOL_APPROVAL_SITES",
    "approval-sites: 🔴 an unaccounted-for site FAILS — an eve approval has no approver-standing check, so a new one on a consequential path is exactly what must not appear silently",
  );
  ok(checkApprovalSites(sites, { "agent/connections/x.ts": "the connector plane's defence-in-depth" }).length === 0, "approval-sites: …and an accounted-for one is clean");
  firesWith(
    checkApprovalSites([], { "agent/connections/gone.ts": "was a thing" }),
    "no longer contains an `approval:` site",
    "approval-sites: a stale entry FAILS — a reason nobody will read again still reads as coverage",
  );
}

{
  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "../agent/tools");
  const tools: ToolSource[] = readdirSync(toolsDir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    .map((f) => ({ name: f.replace(/\.ts$/u, ""), source: readFileSync(join(toolsDir, f), "utf8") }));
  const NON_CORE_TOOL_ROWS = new Set([
    "extend_workspace_time",
    "read_notion_page",
    "read_notion_comments",
    "read_linear_issue",
    "read_slack_channel",
    "read_slack_thread",
  ]);
  const coreToolNames = new Set(tools.map((t) => t.name));
  const coreRegistry = Object.fromEntries(Object.entries(TOOL_CONSEQUENCE).filter(([name]) => coreToolNames.has(name) || !NON_CORE_TOOL_ROWS.has(name)));
  const subagentDir = join(dirname(fileURLToPath(import.meta.url)), "../../../agent/subagents");
  const subagentNames = existsSync(subagentDir)
    ? readdirSync(subagentDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const delegatedModules = new Map<string, string>();
  for (const entry of Object.values(TOOL_CONSEQUENCE)) {
    if (entry.via.kind === "delegated-roles" && !delegatedModules.has(entry.via.module)) {
      delegatedModules.set(entry.via.module, readFileSync(join(repoRoot, entry.via.module), "utf8"));
    }
  }
  ok(delegatedModules.size >= 2, `the registry really does declare cross-file gates (saw ${delegatedModules.size} module(s)) — zero would make the arm below vacuous`);
  const problems = checkConsequenceRegistry(tools, FRAMEWORK_TOOL_NAMES, (action) => actionKind(action)?.policy, coreRegistry, subagentNames, delegatedModules);
  ok(problems.length === 0, `the REAL tool set + framework tools match the registry (problems: ${JSON.stringify(problems)})`);
  ok(tools.length >= 37, `the real scan actually covered the tools dir (saw ${tools.length})`);
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

  for (const kind of ["session.checkpoint"]) {
    const pin = NON_TOOL_ACTION_KINDS[kind];
    ok(pin?.tier === "gate:member", `${kind} is pinned gate:member as a non-tool ActionKind`);
    ok((pin?.reason.length ?? 0) > 60, `${kind}'s pin carries a real reason, not a rubber stamp`);
  }
  ok(
    Object.keys(NON_TOOL_ACTION_KINDS).every((k) => TOOL_CONSEQUENCE[k] === undefined),
    "no non-tool ActionKind name collides with a TOOL_CONSEQUENCE tool slug — the two tables address different things and must not overlap",
  );

  const registeringFiles = [
    "packages/core/agent/approvals/actions.ts",
    "packages/core/agent/approvals/session-checkpoint.ts",
    "packages/core/agent/approvals/memory-purge.ts",
  ];
  const realRegistrations = registeringFiles.flatMap((f) => findActionKindRegistrations(f, readFileSync(join(repoRoot, f), "utf8")));
  ok(realRegistrations.length >= 6, `the real-tree registration scan is populated (saw ${realRegistrations.length})`);
  ok(
    realRegistrations.every((r) => r.kind !== undefined),
    "every real-tree `registerActionKind` site RESOLVES to a kind — an unresolvable one would report as a problem forever, and a check nobody can satisfy gets deleted",
  );
  for (const kind of ["session.checkpoint", "memory.purge"]) {
    ok(realRegistrations.some((r) => r.kind === kind), `the coverage scan resolves "${kind}" off disk — it is spelled via a module const, the shape a literal-only scan would miss`);
  }

  for (const [tool, kind] of [["delete_skill", "skill.delete"], ["cancel_routine", "routine.cancel"]] as const) {
    const entry = TOOL_CONSEQUENCE[tool];
    ok(entry.tier === "gate:member", `${tool} is declared gate:member`);
    ok(entry.via.kind === "action-kind" && entry.via.action === kind, `${tool} routes via the ${kind} ActionKind`);
    ok(actionKind(kind)?.policy === "member", `the ${kind} kind is registered with member policy`);
  }
}

console.log(`✓ ${n} consequence-registry assertions passed`);

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkActionKindCoverage,
  checkActionKindRegistry,
  checkApprovalSites,
  checkConsequenceRegistry,
  checkPostTurnSurface,
  findActionKindRegistrations,
  findEveApprovalSites,
  findPostTurnWriteSites,
  TOOL_CONSEQUENCE,
  type ActionKindRegistration,
  type ApprovalSite,
  type PostTurnWriteSite,
} from "@open-everywhere/core/agent/access/consequence.js";
import { readAuthoredTools, readFrameworkToolNames, readSubagentToolNames } from "./read-mounted-tools.js";
import { actionKind, registeredActionKinds } from "@open-everywhere/core/agent/approvals/actions.js";
import "@open-everywhere/core/agent/approvals/flow.js";
import "@open-everywhere/core/agent/approvals/session-checkpoint.js";
import { posixRelative } from "./posix-path.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tools = readAuthoredTools(root);
const frameworkToolNames = await readFrameworkToolNames();
const subagentNames = readSubagentToolNames(root);

const delegatedModules = new Map<string, string>();
for (const entry of Object.values(TOOL_CONSEQUENCE)) {
  if (entry.via.kind !== "delegated-roles" || delegatedModules.has(entry.via.module)) continue;
  try {
    delegatedModules.set(entry.via.module, readFileSync(join(root, entry.via.module), "utf8"));
  } catch {
  }
}

const problems = checkConsequenceRegistry(
  [...tools.values()],
  frameworkToolNames,
  (action) => actionKind(action)?.policy,
  undefined,
  subagentNames,
  delegatedModules,
);

const kinds = registeredActionKinds();
if (kinds.length === 0) {
  console.error("✗ consequence-lint: no ActionKinds are registered — refusing to report clean against an empty plane");
  process.exit(1);
}
problems.push(...checkActionKindRegistry(kinds, (action) => actionKind(action)?.policy));

function tsFilesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "generated") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const approvalRoots = [join(root, "packages", "core", "agent")];
try {
  for (const p of readdirSync(join(root, "packages", "providers"))) {
    const agentDir = join(root, "packages", "providers", p, "agent");
    try {
      if (statSync(agentDir).isDirectory()) approvalRoots.push(agentDir);
    } catch {
    }
  }
} catch {
}

const agentFiles = approvalRoots.flatMap((r) => tsFilesUnder(r));
const TOOLS_DIR = `${sep}${join("agent", "tools")}${sep}`;
const approvalFiles = agentFiles.filter((f) => !f.includes(TOOLS_DIR));
if (approvalFiles.length === 0) {
  console.error("✗ consequence-lint: found no non-tool sources to scan for eve-native approvals — refusing to report clean against an unread tree");
  process.exit(1);
}
const approvalSites: ApprovalSite[] = approvalFiles.flatMap((f) => findEveApprovalSites(posixRelative(root, f), readFileSync(f, "utf8")));
problems.push(...checkApprovalSites(approvalSites));

const registrations: ActionKindRegistration[] = agentFiles.flatMap((f) =>
  findActionKindRegistrations(posixRelative(root, f), readFileSync(f, "utf8")),
);
problems.push(...checkActionKindCoverage(registrations, kinds));

const writeSites: PostTurnWriteSite[] = agentFiles.flatMap((f) => findPostTurnWriteSites(posixRelative(root, f), readFileSync(f, "utf8")));
if (writeSites.length === 0) {
  console.error("✗ consequence-lint: found no post-turn write sites in the agent tree — refusing to report clean against a scan that read nothing");
  process.exit(1);
}
problems.push(...checkPostTurnSurface([...tools.values()], writeSites, registrations));

if (problems.length > 0) {
  console.error(`✗ consequence-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
const frameworkOnly = frameworkToolNames.filter((n) => !tools.has(n)).length;
console.log(
  `✓ consequence-lint: total over all mounted agent tools (${tools.size} OE-authored + ${frameworkOnly} eve-framework + ${subagentNames.length} declared subagent), every declaration matching its runtime gate; ` +
    `total over the ActionKind plane too (${kinds.length} registered kinds, each either proposed by a tiered tool or pinned in NON_TOOL_ACTION_KINDS with its bar cross-checked, and all ${registrations.length} \`registerActionKind\` site(s) on disk confirmed present in that enumeration); ` +
    `and ${approvalSites.length} eve-native \`approval:\` site(s) outside agent/tools/, every one accounted for. ` +
    `The VECTOR-1 plane is total too (OPE-419): all ${writeSites.length} durable post-turn write site(s) on disk are attributed to a tool or accounted for as non-tool, ` +
    `every tool that reaches one declares \`postTurnSurface\`, and every "arms"/"disarms" row carries the \`taint: "gate"\` floor. ` +
    `Connector/MCP operations are a separate plane (§3 grain 2 — the verb classifier plus bundles' raise-only \`connectorOps\`), not rows in this table: their names are injected at runtime.`,
);

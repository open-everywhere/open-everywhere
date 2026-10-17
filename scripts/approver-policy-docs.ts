import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoreDistFresh } from "./core-dist-freshness.js";
import { writeFileIfChanged } from "./write-if-changed.js";
import {
  checkActionKindCoverage,
  TOOL_CONSEQUENCE,
  findActionKindRegistrations,
  type ActionKindRegistration,
} from "@open-everywhere/core/agent/access/consequence.js";
import {
  checkApproverPolicyProse,
  checkApproverPolicyRule,
  renderApproverPolicyTable,
  sortApproverPolicyRows,
  spliceApproverPolicyTable,
  type ApproverPolicyRow,
} from "@open-everywhere/core/agent/docs/approver-policy.js";
import { actionKind, registeredActionKinds } from "@open-everywhere/core/agent/approvals/actions.js";
import "@open-everywhere/core/agent/approvals/flow.js";
import "@open-everywhere/core/agent/approvals/session-checkpoint.js";
import "@open-everywhere/core/agent/approvals/routine-attention.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const MANUAL = "docs/security/control-plane.md";

assertCoreDistFresh();

const proposedBy = new Map<string, string[]>();
for (const [tool, entry] of Object.entries(TOOL_CONSEQUENCE)) {
  if (entry.via.kind !== "action-kind") continue;
  const list = proposedBy.get(entry.via.action);
  if (list) list.push(tool);
  else proposedBy.set(entry.via.action, [tool]);
}

const kinds = registeredActionKinds();
const problems: string[] = [];

const rows: ApproverPolicyRow[] = sortApproverPolicyRows(
  kinds.map((kind) => {
    const tools = (proposedBy.get(kind) ?? []).sort();
    if (tools.length > 1) {
      problems.push(
        `ActionKind "${kind}" is named by ${tools.length} propose tools (${tools.join(", ")}) — the table has one cell for it, so pick the tool that owns the kind`,
      );
    }
    return { kind, policy: actionKind(kind)!.policy, proposedBy: tools[0] };
  }),
);

problems.push(...checkApproverPolicyRule(rows));

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

const scanRoots = [join(root, "packages", "core", "agent")];
try {
  for (const p of readdirSync(join(root, "packages", "providers"))) {
    const agentDir = join(root, "packages", "providers", p, "agent");
    try {
      if (statSync(agentDir).isDirectory()) scanRoots.push(agentDir);
    } catch {
    }
  }
} catch {
}

const registrations: ActionKindRegistration[] = scanRoots
  .flatMap((r) => tsFilesUnder(r))
  .flatMap((f) => findActionKindRegistrations(relative(root, f).split("\\").join("/"), readFileSync(f, "utf8")));
const coverage = checkActionKindCoverage(registrations, kinds);
if (coverage.length > 0) {
  problems.push(...coverage, `↑ this script keeps the same side-effect import list as scripts/consequence-lint.ts — add the import to BOTH`);
}

const manualPath = join(root, MANUAL);
const manual = readFileSync(manualPath, "utf8");
problems.push(...checkApproverPolicyProse(manual).map((p) => `${MANUAL}: ${p}`));

if (problems.length > 0) {
  console.error(`✗ approver-policy-docs: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

const spliced = spliceApproverPolicyTable(manual, renderApproverPolicyTable(rows));
if ("problem" in spliced) {
  console.error(`✗ approver-policy-docs: ${MANUAL}: ${spliced.problem}`);
  process.exit(1);
}

const admins = rows.filter((r) => r.policy === "admin").length;
const summary = `${rows.length} registered kind(s) — ${admins} admin, ${rows.length - admins} member — across ${registrations.length} \`registerActionKind\` site(s) on disk`;

if (check) {
  if (spliced.updated !== manual) {
    console.error(`✗ approver-policy-docs: the generated approver-policy table in ${MANUAL} is out of date with the ActionKind registry.\n  Run: npx tsx scripts/approver-policy-docs.ts`);
    process.exit(1);
  }
  console.log(`✓ approver-policy-docs: ${summary}, every one in ${MANUAL} at the policy it registers; the manual still states the rule, and still names every admin family`);
} else {
  const wrote = writeFileIfChanged(manualPath, spliced.updated);
  console.log(`✓ approver-policy-docs: ${MANUAL} ${wrote ? "updated" : "already current"} — ${summary}`);
}

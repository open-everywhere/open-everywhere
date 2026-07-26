import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConsequenceRegistry } from "@open-everywhere/core/agent/access/consequence.js";
import { readAuthoredTools, readFrameworkToolNames, readSubagentToolNames } from "./read-mounted-tools.js";
import { actionKind } from "@open-everywhere/core/agent/approvals/actions.js";
import "@open-everywhere/core/agent/approvals/flow.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tools = readAuthoredTools(root);
const frameworkToolNames = await readFrameworkToolNames();
const subagentNames = readSubagentToolNames(root);

const problems = checkConsequenceRegistry(
  [...tools.values()],
  frameworkToolNames,
  (action) => actionKind(action)?.policy,
  undefined,
  subagentNames,
);

if (problems.length > 0) {
  console.error(`✗ consequence-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
const frameworkOnly = frameworkToolNames.filter((n) => !tools.has(n)).length;
console.log(
  `✓ consequence-lint: total over all mounted agent tools (${tools.size} OE-authored + ${frameworkOnly} eve-framework + ${subagentNames.length} declared subagent), every declaration matching its runtime gate. ` +
    `Connector/MCP operations are a separate, design-deferred plane (§3 grain 2, §7 item 5).`,
);

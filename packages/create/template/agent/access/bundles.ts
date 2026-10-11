import {
  assertBindingsValid,
  assertBundlesValid,
  defineBinding,
  defineBundle,
  type Binding,
  type Bundle,
} from "@open-everywhere/core/agent/access/bundle.js";
import { mcpServerBindings, mcpServerBundles } from "@open-everywhere/core/agent/connections/mcp-servers.js";
import { domainRuleBindings, domainRuleBundles } from "@open-everywhere/core/agent/access/domain-rules.js";
import { loadGrantsOverlay } from "./grants.js";
import { MCP_SERVERS } from "./mcp-servers.js";
import { DOMAIN_RULES } from "./domain-rules.js";
import { PRE_APPROVAL_RULES } from "./pre-approval-rules.js";
import { loadAgentsOverlay } from "../memory/config/agents-overlay.js";
import { loadGroups } from "../identity/groups.js";

const bundles: Bundle[] = [
  defineBundle({
    name: "org-default",
    domains: ["raw.githubusercontent.com"],
    instructions: "Never act outside the access granted to this room.",
  }),
  defineBundle({
    name: "approval-policy",
    preApprovalRules: PRE_APPROVAL_RULES,
  }),
];

const bindings: Binding[] = [
  defineBinding({ bundle: "org-default", scope: { level: "org" } }),
  defineBinding({ bundle: "approval-policy", scope: { level: "org" } }),
];

bundles.push(...mcpServerBundles(MCP_SERVERS));
bindings.push(...mcpServerBindings(MCP_SERVERS));
bundles.push(...domainRuleBundles(DOMAIN_RULES));
bindings.push(...domainRuleBindings(DOMAIN_RULES));

const overlay = loadGrantsOverlay();
const agentsOverlay = loadAgentsOverlay();
const mergedBundles: readonly Bundle[] = [...bundles, ...overlay.bundles, ...agentsOverlay.bundles];
const mergedBindings: readonly Binding[] = [...bindings, ...overlay.bindings, ...agentsOverlay.bindings];

assertBundlesValid(mergedBundles);
assertBindingsValid(mergedBindings, mergedBundles, loadGroups());

export function loadBundles(): readonly Bundle[] {
  return mergedBundles;
}

export function loadBindings(): readonly Binding[] {
  return mergedBindings;
}

export function loadBaseBundles(): readonly Bundle[] {
  return bundles;
}

export function loadBaseBindings(): readonly Binding[] {
  return bindings;
}

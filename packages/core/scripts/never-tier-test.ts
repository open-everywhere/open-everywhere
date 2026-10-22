import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("never-tier");
import { assertBundlesValid, defineBundle, type Bundle } from "../agent/access/bundle.js";
import { classifyConnectorOpTier } from "../agent/access/consequence.js";
import {
  NEVER_TIER_DEFAULTS,
  neverTierConfigMatch,
  neverTierDefaultMatch,
  neverTierMatch,
  neverTierRefusalMessage,
} from "../agent/access/never-tier.js";
import { declaredPermissionKinds, namesBundleRaisedTool, namesUnliftableTool } from "../agent/routines/declared-permissions.js";
import { registerSettings, resetSettingsForTest } from "../agent/settings/settings.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function eq<T>(actual: T, expected: T, label: string): void {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

for (const rule of NEVER_TIER_DEFAULTS) {
  for (const tool of rule.grounding) {
    eq(neverTierDefaultMatch(tool)?.id, rule.id, `default ${rule.id}: grounding ${tool} matches it`);
  }
}
eq(neverTierDefaultMatch("stripe__sendMoney")?.id, "money.send", "a camelCase op name splits into the same tokens");
eq(neverTierDefaultMatch("pay__send-money")?.id, "money.send", "a kebab-case op name splits into the same tokens");
eq(classifyConnectorOpTier("broker__search_and_buy"), "read", "fixture: the verb classifier reads a read-led compound name as a read");
eq(neverTierDefaultMatch("broker__search_and_buy")?.id, "trading.order", "🔴 …and the never tier still refuses it: no tier test runs first");
eq(classifyConnectorOpTier("stripe__send_money"), "write", "fixture: `send_money` is only a WRITE to the classifier, so a memo or a routine permission could lift it");

const NEGATIVES = [
  "notion__search",
  "notion__create_page",
  "notion__delete_page",
  "linear__create_issue",
  "github__create_pull_request",
  "slack__send_message",
  "stripe__list_refunds",
  "stripe__list_transfers",
  "stripe__get_stripe_account_info",
  "stripe__search_stripe_documentation",
  "stripe__stripe_api_read",
  "stripe__get_balance_summary",
  "alpaca__get_orders",
  "alpaca__get_all_positions",
  "zendesk__transfer_ticket",
  "gdrive__transfer_ownership",
  "fit__log_exercise",
  "github__withdraw_review",
];
for (const tool of NEGATIVES) eq(neverTierDefaultMatch(tool), undefined, `negative: ${tool} matches no default`);
eq(neverTierMatch("post_message", []), undefined, "an authored tool (no `__`) is not a connector op, so the tier does not apply");

const configBundles: readonly Bundle[] = [
  defineBundle({ name: "ops-never", connectorOps: [{ connector: "Notion", never: ["Delete-Page"] }] }),
  defineBundle({ name: "crm-never", connectorOps: [{ connector: "crm", never: ["*"] }] }),
];
eq(neverTierConfigMatch("notion__delete_page", configBundles), "ops-never", "config: a `never` entry adds the op, after the case and separator fold");
eq(neverTierConfigMatch("notion__create_page", configBundles), undefined, "config: another op of the same connector is untouched");
eq(neverTierConfigMatch("crm__search", configBundles), "crm-never", "config: `*` adds every op of that connector, reads included");
eq(neverTierConfigMatch("linear__delete_issue", configBundles), undefined, "config: another connector is untouched");
eq(neverTierMatch("notion__delete_page", configBundles)?.source, "config", "neverTierMatch reads the config half");
eq(neverTierMatch("stripe__send_money", [])?.source, "default", "a shipped default holds with an empty config: config cannot remove it");
assertBundlesValid([defineBundle({ name: "only-never", connectorOps: [{ connector: "crm", never: ["export_all"] }] })]);
ok(true, "assertBundlesValid accepts a `connectorOps` entry that names `never` ops only");

const defaultText = neverTierRefusalMessage("stripe__send_money", neverTierMatch("stripe__send_money", [])!);
ok(defaultText.includes("never allowed"), "the refusal says the op is never allowed");
ok(defaultText.includes("no approval"), "the refusal says no approval can allow it");
ok(defaultText.includes("not waiting for approval"), "the refusal says it is not a pending approval");
ok(defaultText.includes("money.send"), "the refusal names the rule");

ok(namesUnliftableTool("tool:stripe__send_money"), "routines: a never-tier default is unliftable on a creation card");
ok(!namesUnliftableTool("tool:notion__create_page"), "routines control: an ordinary write stays liftable");
ok(!namesBundleRaisedTool("tool:notion__create_page"), "routines control: no config, no bundle raise");
let threw = "";
try {
  declaredPermissionKinds(["tool:alpaca__place_stock_order"]);
} catch (e) {
  threw = String(e);
}
ok(threw.includes("never allowed"), `routines: declaring a never-tier tool is refused and says "never allowed" (got: ${threw.slice(0, 160)})`);

const { registerConfig } = await import("../agent/access/config.js");
const baseConfig = {
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
};
registerConfig({
  ...baseConfig,
  loadBundles: () => {
    throw new Error("simulated unreadable config");
  },
});
eq(neverTierMatch("notion__search")?.source, "config-unavailable", "🔴 FAIL CLOSED: an unreadable registered config refuses even a read");
eq(neverTierMatch("stripe__send_money")?.source, "default", "a shipped default still names itself when the config is unreadable");

registerConfig({ ...baseConfig, loadBundles: () => configBundles });
eq(neverTierMatch("notion__delete_page")?.source, "config", "the live read finds the registered config's `never` entry");
ok(namesBundleRaisedTool("tool:notion__delete_page") === false, "fixture: a delete is already statically unliftable");
const configNeverWrite: readonly Bundle[] = [defineBundle({ name: "pages-never", connectorOps: [{ connector: "notion", never: ["create_page"] }] })];
registerConfig({ ...baseConfig, loadBundles: () => configNeverWrite });
ok(namesBundleRaisedTool("tool:notion__create_page"), "routines: a config `never` entry makes an ordinary write unliftable on the card");

resetSettingsForTest();
registerSettings({ connectors: { opTiering: true } });
const { connectorApprovalPolicy } = await import("../agent/connections/connector-auth.js");
const policy = connectorApprovalPolicy();
const ask = (toolName: string, approved: readonly string[] = []) =>
  policy({ toolName, approvedTools: new Set(approved), callId: `c-${toolName}`, toolInput: {} } as never);
function reasonOf(decision: unknown): string {
  return typeof decision === "object" && decision !== null && (decision as { type?: string }).type === "denied" ? String((decision as { reason?: string }).reason) : "";
}
const PENDING = /needs a member's approval/;
const control = reasonOf(await ask("notion__update_page"));
ok(PENDING.test(control), `live gate control: an ordinary write gets the card plane's refusal, which the pattern matches (got ${JSON.stringify(control.slice(0, 120))})`);
ok(!control.includes("never allowed"), "live gate control: …and the never tier did not answer it");
for (const tool of ["stripe__send_money", "alpaca__place_stock_order", "stripe__stripe_api_write"]) {
  const fresh = reasonOf(await ask(tool));
  ok(fresh.includes("never allowed"), `🔴 live gate: ${tool} is denied as never allowed (got ${JSON.stringify(fresh.slice(0, 120))})`);
  ok(!PENDING.test(fresh), `live gate: the ${tool} refusal does not read as a pending approval`);
  const memo = reasonOf(await ask(tool, [tool]));
  ok(memo.includes("never allowed"), `🔴 live gate: ${tool} stays denied when the session memo already approved it`);
}
ok(reasonOf(await ask("notion__create_page")).includes("never allowed"), "live gate: a config `never` entry is denied too");
const approved = await ask("notion__update_page", ["notion__update_page"]);
eq(approved, "not-applicable", "live gate control: the session memo lifts an ordinary approved write, so the memo assertions above are not vacuous");
eq(await ask("notion__search"), "not-applicable", "live gate control: a read is still open");
resetSettingsForTest();

console.log(`✓ never-tier: ${passed} assertions`);

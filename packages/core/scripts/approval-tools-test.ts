import { planSetSpendLimit, defaultScopeKey } from "../agent/tools/set_spend_limit.js";
import { rosterStanding } from "../agent/spend/bypass.js";
import { planClearSpendLimit } from "../agent/tools/clear_spend_limit.js";
import { planRevokeConnector } from "../agent/tools/revoke_connector.js";
import { planClearConnectorOverride } from "../agent/tools/clear_connector_override.js";
import type { SurfaceBinding } from "../agent/identity/binding.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throwsWith(fn: () => unknown, needle: string, label: string): void {
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(msg.includes(needle), `${label} (message: "${msg}")`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

function slackBinding(overrides: Partial<SurfaceBinding> = {}): SurfaceBinding {
  return {
    org: "acme",
    platform: "slack",
    workspace: "T123",
    surface: "C456",
    mode: "channel",
    visibility: "public",
    trust: "internal",
    principalId: "U999",
    target: { channelId: "C456" },
    ...overrides,
  };
}

ok(defaultScopeKey(slackBinding(), "surface") === "slack/T123/C456", "defaultScopeKey surface = platform/workspace/surface");
ok(defaultScopeKey(slackBinding(), "workspace") === "slack/T123", "defaultScopeKey workspace = platform/workspace");

const uncapped = { tokens: null, usd: null } as const;
{
  const plan = planSetSpendLimit(slackBinding(), { monthlyTokens: 5_000_000, reason: "spike" }, { tokens: 1_000_000, usd: null }, "eng");
  ok(plan.kind === "spend.set", "planSetSpendLimit kind is spend.set");
  ok(plan.args.level === "surface", "planSetSpendLimit defaults level to surface");
  ok(plan.args.scopeKey === "slack/T123/C456", "planSetSpendLimit defaults scopeKey to this surface");
  ok(plan.scopeKey === plan.args.scopeKey, "planSetSpendLimit top-level scopeKey mirrors args.scopeKey");
  ok(plan.args.monthlyTokens === 5_000_000, "planSetSpendLimit freezes monthlyTokens");
  ok(plan.args.monthlyUsd === undefined, "planSetSpendLimit leaves an unproposed USD component absent (frozen args say only what changes)");
  ok(plan.args.reason === "spike", "planSetSpendLimit freezes reason");
  ok(plan.args.currentCap === 1_000_000, "planSetSpendLimit freezes the current token cap");
  ok(plan.args.currentUsd === null, "planSetSpendLimit freezes the current USD cap (null = uncapped)");
  ok(plan.args.org === "acme", "planSetSpendLimit freezes org from the binding");
  ok(plan.domain === "eng", "planSetSpendLimit freezes the passed-in domain");
}
{
  const plan = planSetSpendLimit(slackBinding(), { monthlyUsd: 50, reason: "incident headroom" }, { tokens: null, usd: 25 }, null);
  ok(plan.args.monthlyUsd === 50 && plan.args.monthlyTokens === undefined, "planSetSpendLimit freezes a USD-only proposal");
  ok(plan.args.currentUsd === 25, "planSetSpendLimit freezes the current USD cap for the card");
}
{
  const plan = planSetSpendLimit(slackBinding(), { monthlyTokens: 9, reason: "  trim  ", level: "workspace" }, uncapped, null);
  ok(plan.args.level === "workspace", "planSetSpendLimit honours an explicit level");
  ok(plan.args.scopeKey === "slack/T123", "planSetSpendLimit defaults scopeKey to the workspace for level:workspace");
  ok(plan.args.reason === "trim", "planSetSpendLimit trims reason");
  ok(plan.domain === null, "planSetSpendLimit passes through a null domain");
}
{
  const plan = planSetSpendLimit(slackBinding(), { monthlyTokens: 1, reason: "x", scopeKey: "slack/T123/COTHER" }, uncapped, null);
  ok(plan.args.scopeKey === "slack/T123/COTHER", "planSetSpendLimit honours an explicit scopeKey override");
}
{
  const plan = planSetSpendLimit(slackBinding({ platform: "discord", workspace: "G123", surface: "C456" }), { monthlyTokens: 1, reason: "x" }, uncapped, null);
  ok(plan.args.scopeKey === "discord/G123/C456", "planSetSpendLimit accepts a Discord binding (card path exists) and scopes to the guild surface");
}
throwsWith(
  () => planSetSpendLimit(slackBinding({ platform: "telegram" }), { monthlyTokens: 1, reason: "x" }, uncapped, null),
  "approval-card path",
  "planSetSpendLimit refuses a binding with no approval-card path",
);
throwsWith(
  () => planSetSpendLimit(slackBinding({ principalId: undefined }), { monthlyTokens: 1, reason: "x" }, uncapped, null),
  "verified sender",
  "planSetSpendLimit refuses with no verified principal",
);
throwsWith(
  () => planSetSpendLimit(slackBinding(), { monthlyTokens: 1, reason: "   " }, uncapped, null),
  "non-empty reason",
  "planSetSpendLimit refuses a blank reason",
);
throwsWith(
  () => planSetSpendLimit(slackBinding(), { reason: "x" }, uncapped, null),
  "monthlyTokens and/or monthlyUsd",
  "planSetSpendLimit refuses a proposal with no cap component at all",
);

{
  const plan = planClearSpendLimit(slackBinding(), {}, { tokens: 2_000_000, usd: 75 }, null);
  ok(plan.kind === "spend.clear", "planClearSpendLimit kind is spend.clear");
  ok(plan.args.level === "surface", "planClearSpendLimit defaults level to surface");
  ok(plan.args.scopeKey === "slack/T123/C456", "planClearSpendLimit defaults scopeKey to this surface");
  ok(plan.args.currentCap === 2_000_000, "planClearSpendLimit freezes the current token cap");
  ok(plan.args.currentUsd === 75, "planClearSpendLimit freezes the current USD cap");
}
{
  const plan = planClearSpendLimit(slackBinding(), { level: "workspace" }, uncapped, "eng");
  ok(plan.args.scopeKey === "slack/T123", "planClearSpendLimit defaults scopeKey to the workspace for level:workspace");
  ok(plan.domain === "eng", "planClearSpendLimit freezes the passed-in domain");
}
{
  const plan = planClearSpendLimit(slackBinding({ platform: "discord", workspace: "G123", surface: "C456" }), {}, uncapped, null);
  ok(plan.args.scopeKey === "discord/G123/C456", "planClearSpendLimit accepts a Discord binding (card path exists)");
}
throwsWith(
  () => planClearSpendLimit(slackBinding({ platform: "teams" }), {}, uncapped, null),
  "approval-card path",
  "planClearSpendLimit refuses a binding with no approval-card path",
);
throwsWith(
  () => planClearSpendLimit(slackBinding({ principalId: undefined }), {}, uncapped, null),
  "verified sender",
  "planClearSpendLimit refuses with no verified principal",
);

{
  const plan = planRevokeConnector(slackBinding(), { connector: "notion", reason: "leaked token" }, "eng");
  ok(plan.kind === "connector.revoke", "planRevokeConnector kind is connector.revoke");
  ok(plan.args.connector === "notion", "planRevokeConnector freezes connector");
  ok(plan.args.reason === "leaked token", "planRevokeConnector freezes reason");
  ok(plan.args.scopeKey === "slack/T123/C456", "planRevokeConnector defaults scopeKey to this surface (no level concept)");
  ok(plan.domain === "eng", "planRevokeConnector freezes the passed-in domain");
}
{
  const plan = planRevokeConnector(slackBinding(), { connector: "  jira  ", reason: "x", scopeKey: "slack/T123/COTHER" }, null);
  ok(plan.args.connector === "jira", "planRevokeConnector trims connector");
  ok(plan.args.scopeKey === "slack/T123/COTHER", "planRevokeConnector honours an explicit scopeKey override");
}
throwsWith(
  () => planRevokeConnector(slackBinding({ platform: "linear" }), { connector: "notion", reason: "x" }, null),
  "Slack-only",
  "planRevokeConnector refuses a non-Slack binding",
);
throwsWith(
  () => planRevokeConnector(slackBinding({ principalId: undefined }), { connector: "notion", reason: "x" }, null),
  "verified sender",
  "planRevokeConnector refuses with no verified principal",
);
throwsWith(
  () => planRevokeConnector(slackBinding(), { connector: "  ", reason: "x" }, null),
  "non-empty connector",
  "planRevokeConnector refuses a blank connector name",
);
throwsWith(
  () => planRevokeConnector(slackBinding(), { connector: "notion", reason: "   " }, null),
  "non-empty reason",
  "planRevokeConnector refuses a blank reason",
);

{
  const plan = planClearConnectorOverride(slackBinding(), { connector: "notion" }, "eng");
  ok(plan.kind === "connector.clear", "planClearConnectorOverride kind is connector.clear");
  ok(plan.args.connector === "notion", "planClearConnectorOverride freezes connector");
  ok(plan.args.scopeKey === "slack/T123/C456", "planClearConnectorOverride defaults scopeKey to this surface");
  ok(plan.domain === "eng", "planClearConnectorOverride freezes the passed-in domain");
}
throwsWith(
  () => planClearConnectorOverride(slackBinding({ platform: "discord" }), { connector: "notion" }, null),
  "Slack-only",
  "planClearConnectorOverride refuses a non-Slack binding",
);
throwsWith(
  () => planClearConnectorOverride(slackBinding({ principalId: undefined }), { connector: "notion" }, null),
  "verified sender",
  "planClearConnectorOverride refuses with no verified principal",
);
throwsWith(
  () => planClearConnectorOverride(slackBinding(), { connector: "  " }, null),
  "non-empty connector",
  "planClearConnectorOverride refuses a blank connector name",
);

function discordDmBinding(overrides: Partial<SurfaceBinding> = {}): SurfaceBinding {
  return slackBinding({ platform: "discord", workspace: "300000000000000104", surface: "D1", mode: "dm", target: { channelId: "D1" }, ...overrides });
}
const setInput = { monthlyUsd: 0.1, reason: "test" } as const;
throwsWith(
  () => planSetSpendLimit(discordDmBinding(), { ...setInput, level: "workspace" }, uncapped, null),
  "belongs to no server",
  "planSetSpendLimit refuses a Discord-DM workspace default (would target the DM bucket, not a server)",
);
throwsWith(
  () => planSetSpendLimit(discordDmBinding(), setInput, uncapped, null),
  "never be enforced",
  "planSetSpendLimit refuses a DM surface default (the gate never enforces DM caps)",
);
throwsWith(
  () => planSetSpendLimit(slackBinding({ mode: "dm", surface: "D9" }), setInput, uncapped, null),
  "never be enforced",
  "planSetSpendLimit refuses a Slack-DM surface default too",
);
{
  const plan = planSetSpendLimit(slackBinding({ mode: "dm", surface: "D9" }), { ...setInput, level: "workspace" }, uncapped, null);
  ok(plan.args.scopeKey === "slack/T123", "planSetSpendLimit ALLOWS a Slack-DM workspace default (a Slack DM keeps its real team id)");
}
{
  const plan = planSetSpendLimit(discordDmBinding(), { ...setInput, level: "workspace", scopeKey: "discord/G777" }, uncapped, null);
  ok(plan.args.scopeKey === "discord/G777", "planSetSpendLimit ALLOWS an explicit scopeKey from a DM (the escape hatch)");
}
throwsWith(
  () => planClearSpendLimit(discordDmBinding(), { level: "workspace" }, uncapped, null),
  "belongs to no server",
  "planClearSpendLimit refuses a Discord-DM workspace default",
);
{
  const plan = planClearSpendLimit(discordDmBinding(), { level: "workspace", scopeKey: "discord/G777" }, uncapped, null);
  ok(plan.args.scopeKey === "discord/G777", "planClearSpendLimit ALLOWS an explicit scopeKey from a DM");
}

ok(rosterStanding(["admin"], null) === true, "rosterStanding: org admin bypasses everywhere (no covering domain needed)");
ok(rosterStanding(["domain:eng"], "eng") === true, "rosterStanding: a domain admin bypasses inside their own domain");
ok(rosterStanding(["domain:eng"], "sales") === false, "rosterStanding: a domain admin does NOT bypass another domain's surface");
ok(rosterStanding(["domain:eng"], null) === false, "rosterStanding: a domain admin does NOT bypass an un-domained surface");
ok(rosterStanding([], "eng") === false, "rosterStanding: FAIL-CLOSED on no roles");

console.log(`✓ ${passed} approval-tools assertions passed`);

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertCoreDistFresh } from "./core-dist-freshness.js";

assertCoreDistFresh();

await import("../agent/lib/register-config.js");

const { getConfig } = await import("@open-everywhere/core/agent/access/config.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const config = getConfig();

ok(typeof config.loadBundles === "function", "control: this deployment's app config IS registered (loadBundles resolves)");
ok(config.loadBundles().length > 0, "control: …and it carries real bundles, so the read reached the app tier");

const ARM_SLOTS: readonly (readonly [string, string])[] = [
  ["auditScrub", "the audit-scrub seam (packages/core/agent/audit/tool-action.ts)"],
  ["connectorOpTier", "the connector-op tiering seam (packages/core/agent/access/connector-op-gating.ts)"],
  ["reduceResult", "the result-reducing seam (packages/core/agent/access/result-reduce.ts)"],
  ["decideWake", "the wake seam (packages/core/agent/channels/wake-arm.ts)"],
];

const APP_CONFIG_MEMBERS: readonly string[] = [
  "loadConnectorCredentials",
  "loadNetworkAccess",
  "loadRoles",
  "loadWebhooks",
  "loadWebhookSources",
  "loadSpendBudgets",
  "loadSpendCheckpoints",
  "loadAccessRequests",
  "loadModelPolicy",
  "loadBlobHosting",
  "loadPrincipals",
  "loadGroups",
  "auditScrub",
  "connectorOpTier",
  "reduceResult",
  "decideWake",
];

function appConfigOptionalMembers(): readonly string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "packages", "core", "agent", "access", "config.ts"), "utf8");
  const start = src.indexOf("export interface AppConfig {");
  ok(start >= 0, "the AppConfig interface is findable in config.ts — the scan below is not reading an empty string");
  const end = src.indexOf("\n}", start);
  ok(end > start, "…and its body is delimited");
  const body = src.slice(start, end);
  return [...body.matchAll(/^ {2}(\w+)\?[(:]/gmu)].map((m) => m[1] as string);
}

const declared = appConfigOptionalMembers();

ok(declared.length >= ARM_SLOTS.length, `the scan found members to check (${declared.length} optional members on AppConfig)`);
for (const [slot] of ARM_SLOTS) {
  ok(declared.includes(slot), `🔴 the scan really sees the arm slots: AppConfig declares \`${slot}\``);
}
ok(!declared.includes("loadBundles"), "…and it does NOT match a REQUIRED member — the scan reads the `?`, not just the name");
for (const foreign of ["groupRegistry", "baseWebhooks", "baseAgents", "adminChannel"]) {
  ok(!declared.includes(foreign), `🔴 the scan is scoped to the AppConfig BODY: \`${foreign}\` (AccessRequestsConfig) is not in it`);
}

const missing = declared.filter((m) => !APP_CONFIG_MEMBERS.includes(m));
const stale = APP_CONFIG_MEMBERS.filter((m) => !declared.includes(m));
ok(
  missing.length === 0,
  `🔴 AppConfig gained optional member(s) [${missing.join(", ")}] — decide whether each is a consumer ARM slot. ` +
    "If it is, add it to ARM_SLOTS *and* APP_CONFIG_MEMBERS in this file; if it is not, add it to APP_CONFIG_MEMBERS alone.",
);
ok(stale.length === 0, `AppConfig no longer declares [${stale.join(", ")}] — drop them from APP_CONFIG_MEMBERS (and ARM_SLOTS if listed)`);

for (const [slot, seam] of ARM_SLOTS) {
  ok(
    (config as unknown as Record<string, unknown>)[slot] === undefined,
    `🔴 this deployment registers NO consumer arm on ${seam} (AppConfig.${slot})`,
  );
}

console.log(
  `✓ drop-in-arms-unregistered: ${passed} assertions passed (${ARM_SLOTS.length} arm slots, all empty on this deployment; ` +
    `${declared.length} AppConfig optional members pinned)`,
);

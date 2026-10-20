// proves: SET-089, SET-090, SET-091

import assert from "node:assert/strict";
import { getSettings, overrideSettingsForTest, resetSettingsForTest } from "@open-everywhere/core/agent/settings/settings.js";
import { loadAccessRequests } from "../agent/access/access-requests.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const DELETED = [
  "OE_ACCESS_ADMIN_CHANNEL",
  "OE_ACCESS_CONFIG_REPO",
  "OE_ACCESS_CONFIG_BASE",
  "OE_ACCESS_GRANTS_PATH",
  "OE_WEBHOOK_HOOKS_PATH",
  "OE_AGENTS_PATH",
  "OE_CREDENTIAL_BINDINGS_PATH",
] as const;

resetSettingsForTest();
const shipped = getSettings().accessRequests;

for (const name of DELETED) process.env[name] = name === "OE_ACCESS_CONFIG_REPO" ? "env-owner/env-repo" : "env-value";
try {
  const cfg = loadAccessRequests();
  ok(cfg !== null, "the loader returns a config");
  ok(cfg!.configRepo === (shipped.configRepo || undefined), "🔴 OE_ACCESS_CONFIG_REPO is not read");
  ok(cfg!.adminChannel === (shipped.adminChannel || undefined), "🔴 OE_ACCESS_ADMIN_CHANNEL is not read");
  ok(cfg!.configBase === shipped.configBase, "🔴 OE_ACCESS_CONFIG_BASE is not read");
  ok(cfg!.grantsPath === undefined && cfg!.hooksPath === undefined && cfg!.agentsPath === undefined && cfg!.bindingsPath === undefined, "🔴 no overlay path comes from the environment");
} finally {
  for (const name of DELETED) delete process.env[name];
}

overrideSettingsForTest({ accessRequests: { adminChannel: "C0ADMIN", configRepo: "acme/config", configBase: "trunk" } });
{
  const cfg = loadAccessRequests();
  ok(cfg!.configRepo === "acme/config" && cfg!.adminChannel === "C0ADMIN" && cfg!.configBase === "trunk", "a settings override reaches loadAccessRequests() with no reload");
}
overrideSettingsForTest({ accessRequests: { adminChannel: "", configRepo: "" } });
{
  const cfg = loadAccessRequests();
  ok(cfg!.configRepo === undefined && cfg!.adminChannel === undefined, "an empty setting reads as unset, so the flows fail closed");
}
resetSettingsForTest();

console.log(`✓ access-requests settings: ${n} assertions passed`);

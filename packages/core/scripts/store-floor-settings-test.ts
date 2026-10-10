process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { dbProviderId, resetProvider } from "../agent/memory/provider.js";
import { getOperationalStore, resetOperationalStore } from "../agent/operational/provider.js";
import { overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";

let n = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  n++;
}
function throwsWith(fn: () => unknown, needle: string, label: string): void {
  let msg = "";
  try {
    fn();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  ok(msg.includes(needle), `${label} (got: ${msg || "no throw"})`);
}

for (const k of ["DATABASE_URL", "OE_MEMORY_PROVIDER", "OE_OPERATIONAL_PROVIDER", "OE_ALLOW_EPHEMERAL_MEMORY", "OE_ALLOW_EPHEMERAL_OPERATIONAL", "VERCEL"]) {
  delete process.env[k];
}
resetSettingsForTest();

{
  process.env.VERCEL = "1";
  resetProvider();
  throwsWith(() => dbProviderId(), "storage.allowEphemeralMemory", "memory: (1) a Vercel host with no durable backing REFUSES, and names the setting that is the escape");

  process.env.OE_ALLOW_EPHEMERAL_MEMORY = "1";
  resetProvider();
  throwsWith(() => dbProviderId(), "no durable backing on Vercel", "memory: (3) 🔴 the retired OE_ALLOW_EPHEMERAL_MEMORY opens nothing");
  delete process.env.OE_ALLOW_EPHEMERAL_MEMORY;

  overrideSettingsForTest({ storage: { allowEphemeralMemory: true } });
  resetProvider();
  ok(dbProviderId() === "sqlite", "memory: (2) storage.allowEphemeralMemory opens the floor on a Vercel host");
  resetSettingsForTest();

  delete process.env.VERCEL;
  resetProvider();
  ok(dbProviderId() === "sqlite", "memory: (4) off a Vercel host the local floor is correct and needs no escape");
}

{
  process.env.VERCEL = "1";
  resetOperationalStore();
  throwsWith(() => getOperationalStore(), "storage.allowEphemeralOperational", "operational: (1) a Vercel host on a local floor REFUSES, and names the setting that is the escape");

  process.env.OE_ALLOW_EPHEMERAL_OPERATIONAL = "1";
  resetOperationalStore();
  throwsWith(() => getOperationalStore(), "floor on Vercel", "operational: (3) 🔴 the retired OE_ALLOW_EPHEMERAL_OPERATIONAL opens nothing");
  delete process.env.OE_ALLOW_EPHEMERAL_OPERATIONAL;

  overrideSettingsForTest({ storage: { allowEphemeralOperational: true } });
  resetOperationalStore();
  ok(getOperationalStore() !== undefined, "operational: (2) storage.allowEphemeralOperational opens the floor on a Vercel host");
  resetSettingsForTest();

  delete process.env.VERCEL;
  resetOperationalStore();
  ok(getOperationalStore() !== undefined, "operational: (4) off a Vercel host the floor is correct and needs no escape");
}

console.log(`✓ store-floor-settings: ${n} assertions passed (both Vercel floors refuse by default, open only through their storage.* setting, and ignore the retired env vars)`);

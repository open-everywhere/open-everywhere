import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppInfo, getAppInfo, resetAppInfo } from "../agent/commands/core.js";
import { postgresWiringRefusal } from "../agent/operational/postgres-wiring.js";
import { resolveOperationalSelection } from "../agent/operational/selection.js";
import { resolveMemoryProviderId } from "../agent/memory/backing-selection.js";
import { registerPostgres } from "../agent/memory/provider.js";
import { registerOperationalPostgres } from "../agent/operational/provider.js";
import { overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP_INFO = { version: "1.0.0", primaryModel: "p", utilityModel: "u", deploymentSha: "sha", evePin: "0.54.3" } as const;

const NEON_ENV: NodeJS.ProcessEnv = { DATABASE_URL: "postgres://app@db.invalid/app" };

function neonOnlyEnv(): void {
  for (const name of ["OE_OPERATIONAL_PROVIDER", "OE_ALLOW_EPHEMERAL_OPERATIONAL", "VERCEL"]) delete process.env[name];
  resetSettingsForTest();
  process.env.DATABASE_URL = NEON_ENV.DATABASE_URL;
}

function gate012(env: NodeJS.ProcessEnv): boolean {
  return Boolean((env.OE_MEMORY_PROVIDER === "postgres" || env.OE_OPERATIONAL_PROVIDER === "postgres") && env.DATABASE_URL);
}

function gate014(env: NodeJS.ProcessEnv): boolean {
  const operational = resolveOperationalSelection(env);
  const selected = resolveMemoryProviderId(env) === "postgres" || (operational.id === "postgres" && operational.floor === "none");
  return selected && Boolean(env.DATABASE_URL);
}

const noQueries = { query: async () => ({ rows: [] }) };

{
  neonOnlyEnv();
  ok(!gate012(NEON_ENV), "the 0.1.2 gate registers no Neon client when only DATABASE_URL is set (the premise)");
  ok(gate014(NEON_ENV), "the 0.1.4 gate does register it on the same env (the premise's other half)");
  resetAppInfo();
  let thrown: unknown;
  try {
    registerAppInfo(APP_INFO);
  } catch (err) {
    thrown = err;
  }
  ok(thrown instanceof Error, "🔴 registerAppInfo refuses to boot over the 0.1.2 wiring with only DATABASE_URL set");
  const message = thrown instanceof Error ? thrown.message : "";
  ok(message.includes("DATABASE_URL is set"), "the refusal names the cause: DATABASE_URL selects Postgres");
  ok(message.includes("operational store and the memory backing are Postgres"), "the refusal names both unwired stores");
  ok(message.includes("agent/lib/register-adapters.ts") && message.includes("oe upgrade --plan --to <installed version>"), "the refusal names the stale file and the command that lists stale files against the INSTALLED release");
  ok(!message.includes("\n") && message.split(/[.!?] /u).length === 1, "the refusal is ONE sentence");
  ok(getAppInfo().primaryModel === "unknown", "a refused boot registers no app info");
}

{
  const none = { memory: false, operational: false };
  ok(postgresWiringRefusal({}, none) === undefined, "no DATABASE_URL and no selector: the PGlite floor and git memory need no client");
  const withMemory = <T>(provider: string, fn: () => T): T => {
    overrideSettingsForTest({ memory: { provider } });
    try {
      return fn();
    } finally {
      resetSettingsForTest();
    }
  };
  ok(withMemory("git", () => postgresWiringRefusal({ DATABASE_URL: "postgres://x", OE_OPERATIONAL_PROVIDER: "sqlite" }, none)) === undefined, "both selectors pinned off Postgres: nothing to refuse");
  ok(postgresWiringRefusal({ DATABASE_URL: "postgres://x" }, { memory: true, operational: true }) === undefined, "🔴 NEGATIVE CONTROL: both clients registered, no refusal");
  const opOnly = withMemory("git", () => postgresWiringRefusal({ DATABASE_URL: "postgres://x" }, none)) ?? "";
  ok(opOnly.includes("the operational store is Postgres") && !opOnly.includes("memory"), "only the unwired store is named");
  const memOnly = postgresWiringRefusal({ DATABASE_URL: "postgres://x" }, { memory: false, operational: true }) ?? "";
  ok(memOnly.includes("the memory backing is Postgres") && !memOnly.includes("operational"), "a missing memory client alone refuses too");
  const noUrl = withMemory("postgres", () => postgresWiringRefusal({}, none)) ?? "";
  ok(noUrl.includes("DATABASE_URL is unset") && noUrl.includes("set DATABASE_URL") && !noUrl.includes("register-adapters"), "a hand selector with no DATABASE_URL names the missing variable, not a stale file");
  ok(withMemory("git", () => postgresWiringRefusal({ OE_OPERATIONAL_PROVIDER: "postgres" }, { memory: false, operational: true })) === undefined, "an explicit selector with a registered client passes");
  ok((postgresWiringRefusal({ DATABASE_URL: "postgres://x", OE_MEMORY_PROVIDER: "git" }, { memory: false, operational: true }) ?? "").includes("the memory backing is Postgres"), "🔴 a stale OE_MEMORY_PROVIDER=git is not read: the unwired memory backing still refuses");
}

for (const rel of ["packages/create/template/agent/agent.ts", "agent/agent.ts"]) {
  const src = readFileSync(join(REPO, rel), "utf8");
  ok(/import \{[^}]*\bregisterAppInfo\b[^}]*\} from "@open-everywhere\/core\/agent\/commands\/core\.js";/u.test(src), `${rel} imports registerAppInfo from commands/core.js, which carries the check`);
  const wiring = src.indexOf('import "./lib/register-adapters.js";');
  const call = src.search(/^registerAppInfo\(/mu);
  ok(wiring >= 0 && call > wiring, `${rel} calls registerAppInfo at top level, after the adapter wiring import`);
}

{
  neonOnlyEnv();
  if (gate014(NEON_ENV)) {
    registerPostgres(noQueries);
    registerOperationalPostgres(noQueries);
  }
  registerAppInfo(APP_INFO);
  ok(getAppInfo().primaryModel === "p", "🔴 NEGATIVE CONTROL: the 0.1.4 wiring registers a client, and the same boot call passes");
}

delete process.env.DATABASE_URL;
console.log(`postgres-wiring-boot-test: ${n} assertions passed`);

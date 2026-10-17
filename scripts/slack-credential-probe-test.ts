import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-slack-credential-probe-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
const saved = {
  sqlite: process.env.OE_SQLITE_PATH,
  key: process.env.OE_CREDENTIAL_ENCRYPTION_KEY,
  token: process.env.SLACK_BOT_TOKEN,
  databaseUrl: process.env.DATABASE_URL,
};
delete process.env.DATABASE_URL;
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
delete process.env.SLACK_BOT_TOKEN;

const { registerSlackProvider } = await import("@open-everywhere/provider-slack/agent/register.js");
const { SLACK_BOT_TOKEN_REF } = await import("@open-everywhere/provider-slack/agent/setup/install-state.js");
const { resetSlackCredentialMemo } = await import("@open-everywhere/provider-slack/agent/setup/credentials.js");
const { encryptedKvVault } = await import("@open-everywhere/core/agent/adapter-api.js");
const { maybeHeartbeat, flushTelemetry, __resetTelemetryForTest, __setInstanceForTest, __setLastHeartbeatForTest } = await import(
  "@open-everywhere/core/agent/observability/telemetry.js"
);

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

async function heartbeatSurfaces(instanceId: string): Promise<string[]> {
  const bodies: unknown[] = [];
  const fakeFetch = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}"));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  __resetTelemetryForTest({ fetchImpl: fakeFetch });
  __setInstanceForTest({ id: instanceId, ephemeral: false });
  __setLastHeartbeatForTest(0);
  maybeHeartbeat();
  await flushTelemetry();
  type Body = {
    resourceLogs: { scopeLogs: { logRecords: { eventName: string; attributes: { key: string; value: unknown }[] }[] }[] }[];
  };
  const record = (bodies[0] as Body | undefined)?.resourceLogs[0].scopeLogs[0].logRecords.find((r) => r.eventName === "oe.instance.heartbeat");
  assert.ok(record, "the heartbeat was sent");
  const attr = record.attributes.find((a) => a.key === "oe.surfaces");
  return ((attr?.value as { arrayValue: { values: { stringValue: string }[] } }).arrayValue.values ?? []).map((v) => v.stringValue);
}

const telemetryKeys = ["OE_TELEMETRY", "DO_NOT_TRACK", "OE_TELEMETRY_DEBUG", "OE_TELEMETRY_OTLP_URL", "OE_TELEMETRY_OTLP_HEADERS"] as const;
const savedTelemetry = Object.fromEntries(telemetryKeys.map((k) => [k, process.env[k]]));
for (const k of telemetryKeys) delete process.env[k];

try {
  registerSlackProvider();
  const vault = encryptedKvVault();

  await vault.write(SLACK_BOT_TOKEN_REF, "xoxb-fake-store-only-token");
  resetSlackCredentialMemo();
  let surfaces = await heartbeatSurfaces("instance-slack-store");
  ok(surfaces.includes("slack"), `a store-only Slack bot token reports "slack" in oe.surfaces (got ${JSON.stringify(surfaces)})`);

  await vault.delete(SLACK_BOT_TOKEN_REF);
  resetSlackCredentialMemo();
  surfaces = await heartbeatSurfaces("instance-slack-none");
  ok(!surfaces.includes("slack"), `no token in either home does not report "slack" (got ${JSON.stringify(surfaces)})`);

  process.env.SLACK_BOT_TOKEN = "xoxb-fake-env-token";
  resetSlackCredentialMemo();
  surfaces = await heartbeatSurfaces("instance-slack-env");
  ok(surfaces.includes("slack"), `an env-only Slack bot token still reports "slack" (got ${JSON.stringify(surfaces)})`);
} finally {
  __resetTelemetryForTest();
  resetSlackCredentialMemo();
  for (const k of telemetryKeys) {
    if (savedTelemetry[k] === undefined) delete process.env[k];
    else process.env[k] = savedTelemetry[k];
  }
  for (const [name, value] of [
    ["OE_SQLITE_PATH", saved.sqlite],
    ["OE_CREDENTIAL_ENCRYPTION_KEY", saved.key],
    ["SLACK_BOT_TOKEN", saved.token],
    ["DATABASE_URL", saved.databaseUrl],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log(`✓ slack-credential-probe: ${n} assertions passed (store-only reports, neither home does not, env-only still reports)`);

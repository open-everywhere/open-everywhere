import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { removeTempDir } from "./_temp-dir.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CORE_DIR = join(HERE, "..");
const REPO_ROOT = join(CORE_DIR, "..", "..");
const TSX_CLI = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ENTRY = join(HERE, "control-mcp.ts");

const workDir = mkdtempSync(join(tmpdir(), "oe-control-mcp-directory-"));
const NO_ENV_FILE = join(workDir, "absent.env");

function fixtureApp(name: string, settings: string | undefined): string {
  const root = join(workDir, name);
  mkdirSync(join(root, "agent", "settings"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, private: true, type: "module" }));
  writeFileSync(join(root, "agent", "agent.ts"), "export {};\n");
  if (settings !== undefined) writeFileSync(join(root, "agent", "settings", "settings.ts"), settings);
  return root;
}

const ARMED_APP = fixtureApp(
  "armed-app",
  `export const SETTINGS_OVERRIDES = { directory: { mode: "observe", provider: "okta", oktaOrgUrl: "https://acme.example.invalid" } };\n`,
);
const OBSERVE_APP = fixtureApp("observe-app", `export const SETTINGS_OVERRIDES = { directory: { mode: "observe" } };\n`);
const BROKEN_APP = fixtureApp("broken-app", undefined);
const TYPO_APP = fixtureApp("typo-app", `export const SETTINGS_OVERRIDES = { directory: { provider: "okat" } };\n`);
const EMPTY_APP = fixtureApp("empty-app", "export {};\n");

const RETIRED_ENV = {
  OE_DIRECTORY_PROVIDER: "okta",
  OE_DIRECTORY_OKTA_ORG_URL: "https://acme.example.invalid",
  OE_DIRECTORY_OKTA_TOKEN_REF: "okta-api-token",
  OE_DIRECTORY_OKTA_TOKEN_BROKER: "env",
};

function childEnv(name: string, appRoot: string, extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string | undefined> = { ...process.env };
  return {
    ...(base as Record<string, string>),
    OE_OPERATIONAL_PROVIDER: "sqlite",
    OE_SQLITE_PATH: join(workDir, `${name}.sqlite3`),
    DATABASE_URL: "",
    OE_PGLITE_DIR: "",
    OE_CREDENTIAL_ENCRYPTION_KEY: "",
    OE_APP_ROOT: appRoot,
    ...extra,
  };
}

async function callEntry(
  name: string,
  appRoot: string,
  extra: Record<string, string>,
  calls: readonly { tool: string; args: Record<string, unknown> }[],
): Promise<{ results: { isError: boolean; body: string }[]; stderr: string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, ENTRY, "--root-env", NO_ENV_FILE],
    cwd: CORE_DIR,
    env: childEnv(name, appRoot, extra),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new Client({ name: "control-mcp-directory-test", version: "0" });
  await client.connect(transport);
  const results: { isError: boolean; body: string }[] = [];
  try {
    for (const c of calls) {
      const res = await client.callTool({ name: c.tool, arguments: c.args });
      results.push({ isError: res.isError === true, body: (res.content as { text: string }[])[0]!.text });
    }
  } finally {
    await client.close();
  }
  return { results, stderr };
}

const STATUS = { tool: "directory_sync_status", args: { org: "default" } };
const PREVIEW = { tool: "directory_sync_preview", args: { org: "default" } };
const SYNC_NOW = { tool: "directory_sync_now", args: { org: "default" } };

{
  const { results, stderr } = await callEntry("armed", ARMED_APP, {}, [STATUS, SYNC_NOW]);
  const [status, syncNow] = results;
  ok(status!.isError === false, `armed: directory_sync_status answers (got ${status!.body})`);
  const body = JSON.parse(status!.body) as { provider: { id: string } | null };
  ok(body.provider !== null, "armed: the local entry HAS a directory provider while directory.provider is set");
  ok(body.provider?.id === "okta", "armed: and it is the okta adapter the setting names");
  ok(stderr.includes("directory verbs read from the okta adapter"), "armed: the ready output names the armed adapter");
  ok(syncNow!.isError === true, "observe: directory_sync_now refuses");
  ok(syncNow!.body.includes("observe"), "observe: the refusal names the app's directory.mode, so the settings loaded");
}

{
  const { results, stderr } = await callEntry("unarmed", OBSERVE_APP, RETIRED_ENV, [STATUS]);
  const body = JSON.parse(results[0]!.body) as { provider: unknown };
  ok(body.provider === null, "unarmed: no directory.provider ⇒ no directory provider, and the retired env vars arm nothing");
  ok(!stderr.includes("directory verbs"), "unarmed: the ready output says nothing about the directory");
}

{
  const { results, stderr } = await callEntry("broken", BROKEN_APP, {}, [STATUS]);
  ok((JSON.parse(results[0]!.body) as { provider: unknown }).provider === null, "broken settings: no directory provider");
  ok(stderr.includes("directory verbs are unarmed") && stderr.includes("agent/settings/settings.ts did not load"), "broken settings: the ready output names the settings file");
}

{
  const { results, stderr } = await callEntry("empty", EMPTY_APP, {}, [STATUS]);
  ok((JSON.parse(results[0]!.body) as { provider: unknown }).provider === null, "no export: no directory provider");
  ok(stderr.includes("exports no SETTINGS_OVERRIDES"), "no export: the ready output names the missing export");
}

{
  const { results, stderr } = await callEntry("typo", TYPO_APP, {}, [STATUS]);
  ok((JSON.parse(results[0]!.body) as { provider: unknown }).provider === null, "typo: no directory provider");
  ok(
    stderr.includes("directory verbs are unarmed") && stderr.includes("the app's settings are invalid") && stderr.includes("directory.provider"),
    `typo: the ready output names the refused setting (got: ${stderr})`,
  );
}

{
  const pglite = {
    OE_OPERATIONAL_PROVIDER: "",
    OE_SQLITE_PATH: "",
    OE_PGLITE_DIR: join(workDir, "token-pglite"),
    OE_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  };
  const before = (await callEntry("token", ARMED_APP, pglite, [PREVIEW])).results[0]!;
  ok(before.body.includes("is not set"), `token: NEGATIVE CONTROL — with nothing stored the preview reaches the token read and names the missing secret (got: ${before.body})`);

  const stored = spawnSync(process.execPath, [TSX_CLI, join(HERE, "oe-cli.ts"), "secret", "set", "OKTA_API_TOKEN", "--root-env", NO_ENV_FILE], {
    cwd: CORE_DIR,
    env: childEnv("token", ARMED_APP, pglite),
    input: "fake-okta-api-token",
    encoding: "utf8",
  });
  ok(stored.status === 0, `token: oe secret set stores OKTA_API_TOKEN in the PGlite store (exit ${String(stored.status)}: ${stored.stderr})`);

  const after = (await callEntry("token", ARMED_APP, pglite, [PREVIEW])).results[0]!;
  ok(!after.body.includes("is not set") && !after.body.includes("resolves only from the environment"), `token: the stored secret resolves through the entry's store (got: ${after.body})`);
  ok(
    after.isError && after.body.includes("https://acme.example.invalid/api/v1/users"),
    `token: the adapter reached its first Okta request, so the token resolved from the store (got: ${after.body})`,
  );
  ok(!after.body.includes("fake-okta-api-token"), "token: the answer never echoes the token");
}

{
  const sourceDir = await import("../agent/identity/directory.js");
  const distDir = await import("@open-everywhere/core/agent/identity/directory.js");
  ok(sourceDir.directoryProvider !== distDir.directoryProvider, "fixture: the two directory modules are distinct copies");
  const fake = { id: "fake-idp", name: "Fake IdP" } as unknown as Parameters<typeof distDir.registerDirectoryProvider>[0];
  distDir.registerDirectoryProvider(fake);
  ok(sourceDir.directoryProvider()?.id === "fake-idp", "directory: a provider the dist copy registers reads back from the source copy");
  sourceDir.resetDirectoryProvider();
  ok(distDir.directoryProvider() === undefined, "directory: a reset through one copy clears the other");

  const sourceCred = await import("../agent/access/credentials.js");
  const distCred = await import("@open-everywhere/core/agent/access/credentials.js");
  ok(sourceCred.getSecretVia !== distCred.getSecretVia, "fixture: the two credential modules are distinct copies");
  sourceCred.registerBroker("cross-copy", { getSecret: async (ref: string) => `value-of-${ref}` });
  ok((await distCred.getSecretVia("cross-copy", "r1")) === "value-of-r1", "brokers: a broker the source copy registers resolves through the dist copy");
  ok(distCred.registeredBrokerNames().includes("cross-copy"), "brokers: and the dist copy lists it");
  sourceCred.resetBrokers();
  ok(!distCred.registeredBrokerNames().includes("cross-copy"), "brokers: a reset through one copy clears the other");
}

await removeTempDir(workDir);
console.log(`✓ control-mcp directory wiring: ${n} assertions passed`);

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

const OBSERVE_APP = fixtureApp("observe-app", `export const SETTINGS_OVERRIDES = { directory: { mode: "observe" } };\n`);
const BROKEN_APP = fixtureApp("broken-app", undefined);
const EMPTY_APP = fixtureApp("empty-app", "export {};\n");

const OKTA_ENV = {
  OE_DIRECTORY_PROVIDER: "okta",
  OE_DIRECTORY_OKTA_ORG_URL: "https://acme.example.invalid",
  OE_DIRECTORY_OKTA_TOKEN_REF: "okta-api-token",
};

function childEnv(name: string, appRoot: string, extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of ["OE_DIRECTORY_PROVIDER", "OE_DIRECTORY_OKTA_ORG_URL", "OE_DIRECTORY_OKTA_TOKEN_REF", "OE_DIRECTORY_OKTA_TOKEN_BROKER"]) delete base[k];
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

function runToExit(name: string, appRoot: string, extra: Record<string, string>): Promise<{ code: number | null; err: string }> {
  const child = spawn(process.execPath, [TSX_CLI, ENTRY, "--root-env", NO_ENV_FILE], {
    cwd: CORE_DIR,
    env: childEnv(name, appRoot, extra),
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise((resolvePromise, rejectPromise) => {
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`control-mcp.ts did not exit within 60s; stderr so far: ${err}`));
    }, 60_000);
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
      if (err.includes("ready on stdio")) child.kill("SIGKILL");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, err });
    });
  });
}

const STATUS = { tool: "directory_sync_status", args: { org: "default" } };
const SYNC_NOW = { tool: "directory_sync_now", args: { org: "default" } };

{
  const { results, stderr } = await callEntry("armed", OBSERVE_APP, OKTA_ENV, [STATUS, SYNC_NOW]);
  const [status, syncNow] = results;
  ok(status!.isError === false, `armed: directory_sync_status answers (got ${status!.body})`);
  const body = JSON.parse(status!.body) as { provider: { id: string } | null };
  ok(body.provider !== null, "armed: the local entry HAS a directory provider while OE_DIRECTORY_PROVIDER is set");
  ok(body.provider?.id === "okta", "armed: and it is the okta adapter the selector names");
  ok(stderr.includes("directory verbs read from the okta adapter"), "armed: the ready output names the armed adapter");
  ok(syncNow!.isError === true, "observe: directory_sync_now refuses");
  ok(syncNow!.body.includes("observe"), "observe: the refusal names the app's directory.mode, so the settings loaded");
}

{
  const { results, stderr } = await callEntry("unarmed", OBSERVE_APP, {}, [STATUS]);
  const body = JSON.parse(results[0]!.body) as { provider: unknown };
  ok(body.provider === null, "unarmed: no selector ⇒ no directory provider");
  ok(!stderr.includes("directory verbs"), "unarmed: the ready output says nothing about the directory");
}

{
  const r = await runToExit("broken", BROKEN_APP, OKTA_ENV);
  ok(r.code !== 0 && r.code !== null, `broken settings: the entry exits non-zero (got ${String(r.code)})`);
  ok(!r.err.includes("ready on stdio"), "broken settings: the entry never announces a server armed on the defaults");
  ok(r.err.includes("agent/settings/settings.ts did not load"), "broken settings: the refusal names the settings file");
}

{
  const r = await runToExit("empty", EMPTY_APP, OKTA_ENV);
  ok(r.code !== 0 && r.code !== null, `no export: the entry exits non-zero (got ${String(r.code)})`);
  ok(!r.err.includes("ready on stdio"), "no export: the entry never announces a server armed on the defaults");
  ok(r.err.includes("exports no SETTINGS_OVERRIDES"), "no export: the refusal names the missing export");
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

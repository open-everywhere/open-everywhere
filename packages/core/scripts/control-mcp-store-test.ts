import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import "./_register-test-config.js";

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
const READY = "ready on stdio";

const workDir = mkdtempSync(join(tmpdir(), "oe-control-mcp-store-"));
const NO_ENV_FILE = join(workDir, "absent.env");

interface EntryResult {
  readonly code: number | null;
  readonly err: string;
  readonly ready: boolean;
}

function runEntry(env: Record<string, string>, extraArgs: readonly string[] = []): Promise<EntryResult> {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, ENTRY, "--root-env", NO_ENV_FILE, ...extraArgs], {
    cwd: CORE_DIR,
    env: {
      ...process.env,
      OE_OPERATIONAL_PROVIDER: "",
      DATABASE_URL: "",
      OE_SQLITE_PATH: "",
      OE_PGLITE_DIR: "",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise<EntryResult>((resolvePromise, rejectPromise) => {
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(new Error(`control-mcp.ts neither started nor exited within 60s; stderr so far: ${err}`));
    }, 60_000);
    const settle = (result: EntryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
      if (err.includes(READY)) {
        child.kill("SIGKILL");
        settle({ code: null, err, ready: true });
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectPromise(e);
      }
    });
    child.on("close", (code) => settle({ code, err, ready: err.includes(READY) }));
  });
}

{
  const r = await runEntry({ OE_OPERATIONAL_PROVIDER: "postgres" });
  ok(r.ready === false, "an unopenable store never reaches a running server (no ready line)");
  ok(r.code !== 0, `the entry exits non-zero (got ${String(r.code)})`);
  ok(r.err.includes("DATABASE_URL"), "the refusal names the missing DATABASE_URL");
  ok(
    r.err.includes("OE_OPERATIONAL_PROVIDER"),
    "the refusal names the provider that was asked for, so the operator can see which store it wanted",
  );
}

{
  const r = await runEntry({
    OE_OPERATIONAL_PROVIDER: "sqlite",
    OE_SQLITE_PATH: join(workDir, "ops.sqlite3"),
    DATABASE_URL: "postgres://someone:not-a-real-password@db.example.invalid/oe",
  });
  ok(r.ready === true, "an openable store starts the server");
  ok(r.err.includes("store: "), "the ready line names the store it wired — the wrong-store tell an operator can read");
  ok(r.err.includes("sqlite file"), "and it is the store the env selected");
  ok(!r.err.includes("postgres://") && !r.err.includes("db.example.invalid"), "no connection string reaches stderr");
}

{
  const r = await runEntry({ OE_PGLITE_DIR: join(workDir, "pglite-entry") });
  ok(r.ready === true, "the default env starts the server");
  ok(r.err.includes("embedded Postgres floor"), "and reports the embedded-Postgres floor as the store it wired");
}

{
  const store = { OE_OPERATIONAL_PROVIDER: "sqlite", OE_SQLITE_PATH: join(workDir, "org.sqlite3") };
  const declared = await runEntry(store, ["--org", "acme-holdings"]);
  ok(declared.ready === true, "--org: the entry still starts");
  ok(declared.err.includes("org: acme-holdings"), "the entry acts for the org named on the command line");

  const undeclared = await runEntry(store);
  ok(undeclared.ready === true, "no --org: the entry still starts");
  ok(undeclared.err.includes("org: default"), "and with no flag it falls back to the shipped default");
  ok(!undeclared.err.includes("acme-holdings"), "control: the declared org came from the flag, not from a leaked register");
}

process.env.OE_SQLITE_PATH = join(workDir, "standin.sqlite3");
_setDeploymentIdentityForTest({ org: "default" });
delete process.env.OE_OPERATIONAL_PROVIDER;
delete process.env.DATABASE_URL;
delete process.env.OE_PGLITE_DIR;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { buildControlServer } = await import("../agent/control/server.js");
const { getOperationalStore, requireArmedOperationalFloor, resetOperationalStore, resolveOperationalSelection } =
  await import("../agent/operational/provider.js");

const server = buildControlServer({ includeWrites: true, actor: "local-operator" });
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "control-mcp-store-test", version: "0" });
await client.connect(clientT);

async function setSpendLimit(scopeKey: string): Promise<{ isError: boolean; text: string }> {
  const res = await client.callTool({
    name: "set_spend_limit",
    arguments: { org: "default", scopeKey, level: "surface", monthlyTokens: 1000 },
  });
  return { isError: res.isError === true, text: (res.content as { text: string }[])[0]!.text };
}

{
  ok(
    JSON.stringify(resolveOperationalSelection()) === JSON.stringify({ id: "postgres", floor: "pglite" }),
    "the configured store here is the embedded-Postgres floor",
  );
}

{
  requireArmedOperationalFloor(false);
  resetOperationalStore();
  const r = await setSpendLimit("slack/T1/C1");
  ok(r.isError === false, "unguarded: the write reports success");
  ok(JSON.parse(r.text).ok === true, "unguarded: and the body is ok:true");
  ok(getOperationalStore().id === "sqlite", "unguarded: while the store it reached is the sqlite stand-in, not the floor");
}

{
  requireArmedOperationalFloor(true);
  resetOperationalStore();
  const r = await setSpendLimit("slack/T1/C2");
  ok(r.isError === true, "guarded: the write FAILS rather than reporting success against the wrong store");
  ok(r.text.includes("PGlite"), "guarded: the refusal names the floor that was configured");
  ok(r.text.includes("connectOperatorStore"), "guarded: and names the call that wires it");
  ok(!r.text.includes('"ok": true'), "guarded: nothing in the result claims success");
}

{
  requireArmedOperationalFloor(false);
  resetOperationalStore();
  const { effectiveCaps } = await import("../agent/spend/caps.js");
  const caps = await effectiveCaps("default", "slack/T1", "slack/T1/C2");
  ok(caps.surfaceMonthlyTokens === undefined, "the refused write left NO override behind in the stand-in either");
  const written = await effectiveCaps("default", "slack/T1", "slack/T1/C1");
  ok(written.surfaceMonthlyTokens === 1000, "control: the unguarded write DID land, so the check above is not vacuous");
}

{
  const { connectOperatorStore, resetOperatorStoreConnection } = await import("./operator-store-connect.js");
  process.env.OE_PGLITE_DIR = join(workDir, "pglite-armed");
  resetOperatorStoreConnection();
  resetOperationalStore();

  ok(getOperationalStore().id === "sqlite", "before the connect: the default env resolves to the sqlite stand-in");

  const target = await connectOperatorStore();
  ok(target.id === "postgres", "connectOperatorStore reports the floor");
  resetOperationalStore();
  ok(
    getOperationalStore().id === "postgres",
    "after the connect: the store that RESOLVES is the armed floor, not the sqlite stand-in",
  );
}

rmSync(workDir, { recursive: true, force: true });
console.log(`✓ control-mcp store wiring: ${n} assertions passed`);

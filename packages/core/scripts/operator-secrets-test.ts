import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

const dir = join(tmpdir(), `oe-operator-secrets-${process.pid}`);
await removeTempDir(dir);
mkdirSync(dir, { recursive: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
_setDeploymentIdentityForTest({ org: undefined });
const ORG = "default";
const KEY = randomBytes(32).toString("base64");
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = KEY;

const SENTINEL = "xoxb-SUPER-SECRET-OPERATOR-VALUE-4b3a2c1d-DO-NOT-LEAK";

const secrets = await import("../agent/credentials/operator-secrets.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { CredentialError } = await import("../agent/access/credentials.js");
const { runSecretCommand } = await import("./oe-secret.js");
const { loadRootOfTrustEnv } = await import("./operator-store-connect.js");
const { buildOpsServer } = await import("../agent/ops/server.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function cli(stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), readStdin: async () => stdin },
    text: () => [...out, ...err].join("\n"),
  };
}

{
  ok(secrets.secretNameRefusal("SLACK_BOT_TOKEN") === undefined, "name: a plain env-var-shaped name is fine");
  ok(secrets.secretNameRefusal("db:notion:eng-key") === undefined, "name: a structured db ref is fine (colons + hyphens allowed)");
  ok(secrets.secretNameRefusal("") !== undefined, "name: empty is refused");
  ok(secrets.secretNameRefusal("SLACK TOKEN") !== undefined, "name: an inner space is refused");
  ok(secrets.secretNameRefusal("SLACK_BOT_TOKEN ") !== undefined, "name: a TRAILING space is refused (the invisible-mismatch class)");
  ok(secrets.secretNameRefusal(`A${"\u0000"}B`) !== undefined, "name: a NUL is refused");
  ok(secrets.secretNameRefusal(`A${"\u2028"}B`) !== undefined, "name: U+2028 is refused");
  ok(secrets.secretNameRefusal("x".repeat(201)) !== undefined, "name: over-long is refused");
  for (const reserved of ["hook:abc", "oe-oauth:notion", "notion-handshake:x"]) {
    ok((secrets.secretNameRefusal(reserved) ?? "").includes("reserved"), `name: the host-minted "${reserved.split(":")[0]}:" namespace is refused`);
  }
  await assert.rejects(
    () => secrets.setOperatorSecret({ name: "hook:planted", value: SENTINEL, setBy: secrets.SET_BY_CLI }),
    (e) => e instanceof CredentialError,
    "set: refuses to plant a row in a reserved namespace",
  );
  ok((await getOperationalStore().getStoredCredential(ORG, "hook:planted")) === null, "set: the refused reserved write stored NOTHING");
}

{
  const parsed = secrets.parseSecretEnvFile(
    [
      "# a comment",
      "",
      "SLACK_BOT_TOKEN=xoxb-plain",
      "export DISCORD_BOT_TOKEN=exported-value",
      "LINEAR_API_KEY = spaced-value ",
      `QUOTED="line-one\\nline-two"`,
      "LITERAL='single #quoted'",
      "HASHY=value#not-a-comment",
    ].join("\n"),
  );
  ok(parsed.errors.length === 0, "parse: a well-formed file has no errors");
  const byName = Object.fromEntries(parsed.entries.map((e) => [e.name, e.value]));
  ok(byName.SLACK_BOT_TOKEN === "xoxb-plain", "parse: a bare value");
  ok(byName.DISCORD_BOT_TOKEN === "exported-value", "parse: a leading `export ` is tolerated");
  ok(byName.LINEAR_API_KEY === "spaced-value", "parse: `KEY = value` spacing is tolerated");
  ok(byName.QUOTED === "line-one\nline-two", "parse: a double-quoted value unescapes \\n (a one-line PEM survives)");
  ok(byName.LITERAL === "single #quoted", "parse: a single-quoted value is literal");
  ok(byName.HASHY === "value#not-a-comment", "parse: an unquoted # stays part of the value");

  const bad = secrets.parseSecretEnvFile(["NOT_A_PAIR", "A=1", "A=2", "EMPTY=", "hook:x=y"].join("\n"));
  ok(bad.errors.some((e) => e.startsWith("line 1")), "parse: a non-KEY=VALUE line is REPORTED, not skipped silently");
  ok(bad.errors.some((e) => e.includes("more than once")), "parse: a duplicate name is refused rather than guessed");
  ok(bad.errors.some((e) => e.includes("empty value")), "parse: an empty value is refused");
  ok(bad.errors.some((e) => e.includes("reserved")), "parse: a reserved namespace is refused per-line");
  ok(bad.entries.length === 1 && bad.entries[0]!.name === "A", "parse: the usable lines still come back");
}

{
  const written = await secrets.setOperatorSecret({ name: "SLACK_BOT_TOKEN", value: SENTINEL, setBy: secrets.SET_BY_CLI });
  ok(written.bytes === Buffer.byteLength(SENTINEL, "utf8") && written.replaced === false, "set: reports byte count + new/replaced, nothing else");
  ok(!JSON.stringify(written).includes(SENTINEL.slice(0, 8)), "set: the result carries no prefix of the value");

  const row = await getOperationalStore().getStoredCredential(ORG, "SLACK_BOT_TOKEN");
  ok(row !== null && !row.ciphertext.includes(SENTINEL), "set: the stored row is ciphertext, not the plaintext");
  ok(row?.createdBy === secrets.SET_BY_CLI, "set: provenance rides created_by (the UNCHAINED audit — see the module header)");

  const again = await secrets.setOperatorSecret({ name: "SLACK_BOT_TOKEN", value: `${SENTINEL}-rotated`, setBy: `${secrets.SET_BY_CLI}:rowan` });
  ok(again.replaced === true, "set: a re-store reports `replaced`");

  const listed = await secrets.listOperatorSecrets();
  ok(listed.length === 1 && listed[0]!.name === "SLACK_BOT_TOKEN", "list: the stored name is listed");
  ok(listed[0]!.setBy === `${secrets.SET_BY_CLI}:rowan`, "list: the operator label rides the provenance token");
  ok(!JSON.stringify(listed).includes(SENTINEL.slice(0, 8)), "🔴 list: NO part of the value appears in the listing");
  ok(!Object.keys(listed[0]!).some((k) => /value|secret|cipher/i.test(k)), "🔴 list: the row carries no value-shaped field at all");

  await secrets.setOperatorSecret({ name: "oe-oauth-lookalike", value: "v", setBy: secrets.SET_BY_CLI });
  await getOperationalStore().putStoredCredential(ORG, { ref: "hook:internal", ciphertext: "opaque", createdBy: "host", createdAt: new Date().toISOString() });
  const visible = await secrets.listOperatorSecrets();
  ok(!visible.some((s) => s.name === "hook:internal"), "list: host-minted internal refs are hidden by default");
  const all = await secrets.listOperatorSecrets({ includeInternal: true });
  ok(all.some((s) => s.name === "hook:internal" && s.internal), "list: --all surfaces internal refs, flagged");

  await assert.rejects(() => secrets.removeOperatorSecret("hook:internal"), (e) => e instanceof CredentialError, "rm: refuses a host-minted internal ref");
  ok((await secrets.removeOperatorSecret("oe-oauth-lookalike")) === true, "rm: deletes a stored secret");
  ok((await secrets.removeOperatorSecret("oe-oauth-lookalike")) === false, "rm: a second delete reports nothing-to-remove rather than claiming success");
}

{
  secrets.resetOperatorSecretWarnings();
  process.env.OE_RESOLVE_PROBE = "the-env-value";
  await secrets.setOperatorSecret({ name: "OE_RESOLVE_PROBE", value: SENTINEL, setBy: secrets.SET_BY_CLI });
  const fromDb = await secrets.getOperatorSecret("OE_RESOLVE_PROBE");
  ok(fromDb.source === "db" && fromDb.value === SENTINEL, "resolve: a stored secret WINS over the env var of the same name");

  process.env.OE_ONRAMP_PROBE = "on-ramp-value";
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (m?: unknown) => void warned.push(String(m));
  let fromEnv: Awaited<ReturnType<typeof secrets.getOperatorSecret>>;
  try {
    fromEnv = await secrets.getOperatorSecret("OE_ONRAMP_PROBE");
  } finally {
    console.warn = realWarn;
  }
  ok(fromEnv.source === "env" && fromEnv.value === "on-ramp-value", "resolve: with no stored row, the env var is the migration on-ramp");
  ok(warned.some((w) => w.includes("oe secret set")), "resolve: the env arm says ONCE how to move it into the store");
  ok(!warned.join("\n").includes("on-ramp-value"), "resolve: the notice names the secret, never its value");

  await assert.rejects(
    () => secrets.getOperatorSecret("OE_ABSENT_PROBE"),
    (e) => e instanceof CredentialError && /oe secret set/.test((e as Error).message),
    "resolve: neither home ⇒ a CredentialError that names the fix",
  );
  await assert.rejects(
    () => secrets.getOperatorSecret("OE_ABSENT_PROBE"),
    (e) => e instanceof secrets.OperatorSecretNotSetError,
    "🔴 resolve: 'nobody configured this name' throws OperatorSecretNotSetError — the class a caller may treat as silence",
  );

  const saved = process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  await assert.rejects(
    () => secrets.setOperatorSecret({ name: "OE_FAILCLOSED_PROBE", value: SENTINEL, setBy: secrets.SET_BY_CLI }),
    (e) => e instanceof CredentialError && /OE_CREDENTIAL_ENCRYPTION_KEY/.test((e as Error).message),
    "fail closed: a write with no AES key refuses and NAMES the env var",
  );
  ok((await getOperationalStore().getStoredCredential(ORG, "OE_FAILCLOSED_PROBE")) === null, "fail closed: the refused write stored nothing");
  await assert.rejects(
    () => secrets.getOperatorSecret("OE_RESOLVE_PROBE"),
    (e) => e instanceof CredentialError && /refusing to fall back/.test((e as Error).message),
    "🔴 fail closed: a stored row that cannot be decrypted NEVER falls back to the env var",
  );
  const unarmed = await secrets.getOperatorSecret("OE_RESOLVE_PROBE").then(
    () => null,
    (e: unknown) => e as Error,
  );
  ok(unarmed !== null && !(unarmed instanceof secrets.OperatorSecretNotSetError), "🔴 fail closed: an UNARMED encryption key is NOT an OperatorSecretNotSetError — a caller must report it");
  ok(unarmed !== null && unarmed.message.includes("is not set"), "🔴 …and its message contains 'is not set' anyway — which is exactly why the CLASS, not the message, is the seam");
  process.env.OE_CREDENTIAL_ENCRYPTION_KEY = saved;
  delete process.env.OE_RESOLVE_PROBE;
  delete process.env.OE_ONRAMP_PROBE;
  await secrets.removeOperatorSecret("OE_RESOLVE_PROBE");
}

{
  secrets.resetOperatorSecretWarnings();
  secrets.resetOperatorSecretMemo();
  let clock = 1_000_000;
  const now = (): number => clock;
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    ok((await secrets.operatorSecret("OE_HOT_PROBE", { now })) === undefined, "hot read: set nowhere ⇒ undefined");
    process.env.OE_HOT_PROBE = "hot-env-value";
    ok((await secrets.operatorSecret("OE_HOT_PROBE", { now })) === "hot-env-value", "hot read: the env on-ramp answers at once, inside the miss TTL");
    await secrets.setOperatorSecret({ name: "OE_HOT_PROBE", value: SENTINEL, setBy: secrets.SET_BY_CLI });
    ok((await secrets.operatorSecret("OE_HOT_PROBE", { now })) === "hot-env-value", "🔴 hot read: a store miss is remembered inside the TTL (no query per request)");
    clock += 30_001;
    ok((await secrets.operatorSecret("OE_HOT_PROBE", { now })) === SENTINEL, "hot read: after the TTL the stored row is read, and it WINS over env");
    ok(await secrets.operatorSecretConfigured("OE_HOT_PROBE"), "hot read: operatorSecretConfigured answers true for a stored secret");
    secrets.resetOperatorSecretMemo();
    const broken = { getStoredCredential: async (): Promise<null> => { throw new Error("store down"); } };
    const faulted = await secrets.operatorSecret("OE_HOT_PROBE", { now, store: broken });
    ok(faulted === "hot-env-value", "hot read: an unreachable store degrades to the env on-ramp");
    let calls = 0;
    const counting = { getStoredCredential: async (): Promise<null> => { calls++; throw new Error("store down"); } };
    clock += 4_000;
    ok((await secrets.operatorSecret("OE_HOT_PROBE", { now, store: counting })) === "hot-env-value" && calls === 0, "🔴 hot read: inside the backoff a remembered fault asks the store nothing (no query per unauthenticated request)");
    clock += 1_001;
    ok((await secrets.operatorSecret("OE_HOT_PROBE", { now })) === SENTINEL, "🔴 hot read: a store fault is remembered for the short backoff only — the stored value wins again after it, inside the 30 s TTL");
    const saved = process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
    await assert.rejects(
      () => secrets.operatorSecret("OE_HOT_PROBE", { now }),
      (e) => e instanceof CredentialError && /refusing to fall back/.test((e as Error).message),
      "🔴 hot read: a stored row with no armed key throws — it never falls back to env",
    );
    ok(!(await secrets.operatorSecretConfigured("OE_HOT_PROBE")), "hot read: operatorSecretConfigured answers false for a row it cannot read");
    process.env.OE_CREDENTIAL_ENCRYPTION_KEY = saved;
    await assert.rejects(
      () => secrets.operatorSecret("hook:internal"),
      (e) => e instanceof CredentialError,
      "hot read: a reserved host-minted ref is refused",
    );
  } finally {
    console.warn = realWarn;
    delete process.env.OE_HOT_PROBE;
    await secrets.removeOperatorSecret("OE_HOT_PROBE");
    secrets.resetOperatorSecretMemo();
  }
}

{
  const envFile = join(dir, "cli.env");
  writeFileSync(envFile, "# nothing the store needs\n", "utf8");
  const base = ["--root-env", envFile];

  const set = cli(`${SENTINEL}\n`);
  ok((await runSecretCommand(["set", "DISCORD_BOT_TOKEN", ...base], set.io)) === 0, "cli: `secret set` from stdin exits 0");
  ok(!set.text().includes(SENTINEL.slice(0, 8)), "🔴 cli: the confirmation carries no part of the value");
  ok(set.text().includes(`${Buffer.byteLength(SENTINEL, "utf8")} bytes`), "cli: the confirmation reports the byte count");
  const stored = await getOperationalStore().getStoredCredential(ORG, "DISCORD_BOT_TOKEN");
  ok(stored !== null, "cli: the row landed");
  ok((await secrets.getOperatorSecret("DISCORD_BOT_TOKEN")).value === SENTINEL, "cli: exactly ONE trailing newline is stripped, the value is otherwise verbatim");

  const valueFile = join(dir, "pem.txt");
  writeFileSync(valueFile, "-----BEGIN KEY-----\nline2\n-----END KEY-----\n", "utf8");
  const viaFile = cli();
  ok((await runSecretCommand(["set", "OE_GITHUB_APP_PRIVATE_KEY", "--value-file", valueFile, ...base], viaFile.io)) === 0, "cli: --value-file exits 0");
  ok(
    (await secrets.getOperatorSecret("OE_GITHUB_APP_PRIVATE_KEY")).value === "-----BEGIN KEY-----\nline2\n-----END KEY-----",
    "cli: --value-file preserves inner newlines (a PEM survives)",
  );

  const batchFile = join(dir, "batch.env");
  writeFileSync(batchFile, ["# migrate the lot", "NOTION_API_KEY=ntn_batch_one", "LINEAR_API_KEY=lin_batch_two"].join("\n"), "utf8");
  const batch = cli();
  ok((await runSecretCommand(["set", "--from-file", batchFile, ...base], batch.io)) === 0, "cli: --from-file loads a batch");
  ok(batch.text().includes("NOTION_API_KEY") && batch.text().includes("LINEAR_API_KEY"), "cli: the batch confirmation names each secret");
  ok(!batch.text().includes("ntn_batch_one"), "🔴 cli: the batch confirmation carries no values");

  const list = cli();
  ok((await runSecretCommand(["list", ...base], list.io)) === 0, "cli: `secret list` exits 0");
  ok(list.text().includes("DISCORD_BOT_TOKEN") && list.text().includes("NOTION_API_KEY"), "cli: list names the stored secrets");
  ok(!list.text().includes(SENTINEL.slice(0, 8)) && !list.text().includes("ntn_batch_one"), "🔴 cli: list carries no values");
  ok(/write-only/i.test(list.text()), "cli: list says out loud that values cannot be read back");

  const rm = cli();
  ok((await runSecretCommand(["rm", "LINEAR_API_KEY", ...base], rm.io)) === 0, "cli: `secret rm` exits 0 on a real delete");
  ok(rm.text().includes("removed"), "cli: rm prints a clear confirmation");
  const rmAgain = cli();
  ok((await runSecretCommand(["rm", "LINEAR_API_KEY", ...base], rmAgain.io)) === 1, "cli: rm of a missing name exits non-zero rather than claiming success");

  const get = cli();
  ok((await runSecretCommand(["get", "DISCORD_BOT_TOKEN", ...base], get.io)) === 2, "🔴 cli: there is no `get` verb");
  ok(!get.text().includes(SENTINEL.slice(0, 8)), "🔴 cli: the unknown-verb refusal leaks nothing");
  const argvValue = cli();
  const argvCode = await runSecretCommand(["set", "ARGV_PROBE", "--value", SENTINEL, ...base], argvValue.io);
  ok(argvCode !== 0, "🔴 cli: `--value <secret>` on argv is refused, not accepted");
  ok((await getOperationalStore().getStoredCredential(ORG, "ARGV_PROBE")) === null, "🔴 cli: nothing was stored from an argv value");
}

{
  const envFile = join(dir, "root-of-trust.env");
  writeFileSync(envFile, ["OE_OPERATIONAL_PROVIDER=sqlite", "SLACK_BOT_TOKEN=should-not-be-lifted", "DATABASE_URL=postgres://ignored"].join("\n"), "utf8");
  delete process.env.OE_OPERATIONAL_PROVIDER;
  delete process.env.SLACK_BOT_TOKEN;
  const applied = loadRootOfTrustEnv(envFile);
  ok(applied.includes("OE_OPERATIONAL_PROVIDER"), "env allowlist: a root-of-trust var IS lifted out of the file");
  ok(!applied.includes("SLACK_BOT_TOKEN") && process.env.SLACK_BOT_TOKEN === undefined, "🔴 env allowlist: a CHANNEL secret is NOT lifted into the process env");
  _setDeploymentIdentityForTest({ org: undefined });
  delete process.env.DATABASE_URL;

  let connects = 0;
  const server = buildOpsServer({
    connectStore: async () => {
      connects++;
      return { label: "test store" };
    },
  });
  const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
  ok(tools.includes("secret_set") && tools.includes("secret_list") && tools.includes("secret_rm"), "mcp: the three secret tools are registered");
  ok(!tools.some((t) => /secret_get|secret_read|reveal/.test(t)), "🔴 mcp: no read-back tool exists");

  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "operator-secrets-test", version: "0" });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res = await client.callTool({ name, arguments: args });
    return (res.content as { type: string; text: string }[])[0]!.text;
  };

  const outerProject = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = dir;
  writeFileSync(join(dir, ".env.local"), `MICROSOFT_APP_PASSWORD=${SENTINEL}\n`, "utf8");
  const setText = await call("secret_set", { names: ["MICROSOFT_APP_PASSWORD"] });
  ok(JSON.parse(setText).ok === true, "mcp: secret_set reports ok");
  ok(!setText.includes(SENTINEL.slice(0, 8)), "🔴 mcp: secret_set's response carries no part of the value");
  ok((await secrets.getOperatorSecret("MICROSOFT_APP_PASSWORD")).source === "db", "mcp: secret_set wrote through the same db path");
  ok((await getOperationalStore().getStoredCredential(ORG, "MICROSOFT_APP_PASSWORD"))?.createdBy === secrets.SET_BY_OPS_MCP, "mcp: the row's provenance says ops-mcp");

  const listText = await call("secret_list", {});
  ok(listText.includes("MICROSOFT_APP_PASSWORD"), "mcp: secret_list names the secret");
  ok(!listText.includes(SENTINEL.slice(0, 8)), "🔴 mcp: secret_list carries no values");

  const rmText = await call("secret_rm", { name: "MICROSOFT_APP_PASSWORD" });
  ok(JSON.parse(rmText).ok === true, "mcp: secret_rm deletes");
  ok(connects === 3, "mcp: every secret tool wires the operator store first");
  await client.close();
  if (outerProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = outerProject;

  const shipped = buildOpsServer();
  const [ct2, st2] = InMemoryTransport.createLinkedPair();
  await shipped.connect(st2);
  const client2 = new Client({ name: "operator-secrets-test-default", version: "0" });
  await client2.connect(ct2);
  const defaultList = await client2.callTool({ name: "secret_list", arguments: {} });
  const defaultText = (defaultList.content as { type: string; text: string }[])[0]!.text;
  ok(JSON.parse(defaultText).store !== undefined, "mcp: the SHIPPED default wiring reaches the store (the lazy scripts/ import resolves)");
  ok(!defaultText.includes(SENTINEL.slice(0, 8)), "🔴 mcp: the default-wired listing carries no values either");

  {
    const { deploymentOrg } = await import("../agent/identity/deployment-identity.js");
    _setDeploymentIdentityForTest({ org: undefined });
    ok(deploymentOrg() === "default", "precondition: nothing is declared before the call, so the org is the shipped default");
    await client2.callTool({ name: "secret_list", arguments: { org: "acme-ops" } });
    ok(deploymentOrg() === "acme-ops", "🔴 mcp: the shipped wiring declares the CALL's org before it opens the store");
    await client2.callTool({ name: "secret_list", arguments: {} });
    ok(deploymentOrg() === "acme-ops", "…and a call naming no org changes nothing");
    _setDeploymentIdentityForTest({ org: undefined });
  }
  await client2.close();
}

await removeTempDir(dir);
console.log(`✓ operator-secrets: ${n} assertions passed`);

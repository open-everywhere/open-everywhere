import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, basename } from "node:path";
import {
  preflight,
  quickstartPlan,
  mergeEnv,
  registerQuickstartSurfaceGoal,
  credentialKeyStatus,
  CREDENTIAL_KEY_ENV_NAME,
  CREDENTIAL_KEY_BYTES,
} from "../agent/ops/quickstart.js";
import { preflightAsync, registerPreflightProbe, _resetPreflightProbesForTest } from "../agent/ops/probes.js";
import { buildOpsServer, OPS_TOOL_NAMES } from "../agent/ops/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

{
  const missing = preflight({});
  ok("preflight flags a missing model key", missing.checks.some((c) => c.name.includes("AI_GATEWAY_API_KEY") && c.status === "missing"));
  ok("preflight is not ready when a required key is missing", missing.ready === false);
  ok("a missing check carries a fix hint", missing.checks.find((c) => c.status === "missing")?.fix !== undefined);

  const ready = preflight({ AI_GATEWAY_API_KEY: "k" });
  ok("preflight passes when the model key is set", ready.ready === true);

  const pg = preflight({ AI_GATEWAY_API_KEY: "k", OE_OPERATIONAL_PROVIDER: "postgres" });
  ok("postgres provider requires DATABASE_URL", pg.checks.some((c) => c.name.includes("DATABASE_URL") && c.status === "missing") && pg.ready === false);
}

{
  const local = quickstartPlan("local", { AI_GATEWAY_API_KEY: "k" });
  ok("local plan ends at `npm run dev`", local.steps.some((s) => s.command === "npm run dev"));
  ok("a satisfied step is marked done", local.steps.find((s) => s.id === "model")?.status === "done");

  const slackUnregistered = quickstartPlan("slack", { AI_GATEWAY_API_KEY: "k" });
  ok("slack goal UNREGISTERED (core alone) contributes no surface step", !slackUnregistered.steps.some((s) => s.id === "slack"));
  registerQuickstartSurfaceGoal("slack", (env) => ({
    id: "slack",
    title: "Fake surface",
    status: env.FAKE_SURFACE_TOKEN ? "done" : "todo",
    detail: "test-registered surface goal",
  }));
  const slack = quickstartPlan("slack", { AI_GATEWAY_API_KEY: "k" });
  ok("a registered surface goal adds its step", slack.steps.some((s) => s.id === "slack" && s.status === "todo"));

  const deploy = quickstartPlan("deploy", { AI_GATEWAY_API_KEY: "k" });
  ok("deploy goal includes the Neon DB step", deploy.steps.some((s) => s.id === "db"));
  ok("deploy goal includes build + deploy commands", deploy.steps.some((s) => s.command === "vercel deploy --prod"));
  ok("deploy is not ready-to-run until its todos are met", deploy.readyToRun === false);
}

{
  ok("mergeEnv appends a new key", mergeEnv("A=1\n", { B: "2" }).includes("B=2"));
  ok("mergeEnv updates in place", mergeEnv("A=1\nB=2\n", { A: "9" }) === "A=9\nB=2\n");
  ok("mergeEnv preserves comments", mergeEnv("# hi\nA=1\n", { B: "2" }).startsWith("# hi"));
}

{
  const dir = mkdtempSync(join(tmpdir(), "open-everywhere-ops-"));
  const file = join(dir, ".env.local");
  writeFileSync(file, "# existing\nAI_GATEWAY_API_KEY=old\n", "utf-8");

  const outerProject = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = dir;

  const server = buildOpsServer();
  const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
  ok("ops server exposes exactly the declared tools", JSON.stringify(tools) === JSON.stringify([...OPS_TOOL_NAMES].sort()));

  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "ops-test", version: "0" });
  await client.connect(ct);

  const res = await client.callTool({ name: "scaffold_env", arguments: { values: { AI_GATEWAY_API_KEY: "new", OE_PUBLIC_BASE_URL: "https://example.test" }, path: file } });
  const out = JSON.parse((res.content as { type: string; text: string }[])[0].text);
  ok("scaffold_env reports the keys it set", out.ok === true && out.keysSet.includes("OE_PUBLIC_BASE_URL"));

  const written = readFileSync(file, "utf-8");
  ok("scaffold_env updates an existing key in place", written.includes("AI_GATEWAY_API_KEY=new") && !written.includes("=old"));
  ok("scaffold_env appends a new key", written.includes("OE_PUBLIC_BASE_URL=https://example.test"));
  ok("scaffold_env preserves comments", written.includes("# existing"));

  const pfRes = await client.callTool({ name: "preflight", arguments: { envPath: file } });
  const pf = JSON.parse((pfRes.content as { type: string; text: string }[])[0].text);
  ok("preflight via MCP reads the scaffolded env", pf.checks.find((c: { name: string }) => c.name.includes("AI_GATEWAY_API_KEY"))?.status === "ok");

  {
    const scaffold = async (target: string) => {
      const r = await client.callTool({ name: "scaffold_env", arguments: { values: { SOME_TOKEN: "s3cr3t-fixture" }, path: target } });
      return JSON.parse((r.content as { type: string; text: string }[])[0].text) as Record<string, unknown>;
    };
    for (const name of [".env.example", ".env.e2e.example", "notes.md", ".envrc"]) {
      const target = join(dir, name);
      const refused = await scaffold(target);
      ok(`scaffold_env refuses the tracked name "${name}"`, refused.ok === false);
      ok(`…and writes nothing to "${name}"`, !existsSync(target));
    }
    const outside = mkdtempSync(join(tmpdir(), "open-everywhere-outside-"));
    for (const [label, target] of [
      ["a .. escape", join(dir, "..", basename(outside), ".env.local")],
      ["an absolute path outside the root", join(outside, ".env.local")],
      ["a subdirectory of the root", join(dir, "nested", ".env.local")],
    ] as const) {
      const refused = await scaffold(target);
      ok(`scaffold_env refuses ${label}`, refused.ok === false);
      ok(`…and writes nothing there (${label})`, !existsSync(join(outside, ".env.local")) && !existsSync(join(dir, "nested", ".env.local")));
    }
    rmSync(outside, { recursive: true, force: true });
    const allowed = await scaffold(join(dir, ".env.local"));
    ok("scaffold_env still writes the project's own .env.local", allowed.ok === true && readFileSync(file, "utf-8").includes("SOME_TOKEN=s3cr3t-fixture"));
  }

  await client.close();
  rmSync(dir, { recursive: true, force: true });
  if (outerProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = outerProject;
}

{
  const { RUNTIME_ROLE_NAME, OWNER_URL_ENV, generateRuntimePassword, deriveRuntimeUrl, twoRoleProvisioningSql } = await import("../agent/ops/two-role.js");

  const pw = generateRuntimePassword();
  ok("generateRuntimePassword returns a non-empty URL-safe secret", pw.length >= 20 && /^[A-Za-z0-9_-]+$/.test(pw));
  ok("two generated passwords differ (random)", generateRuntimePassword() !== generateRuntimePassword());

  const owner = "postgres://neondb_owner:ownerpass@ep-cool-123.us-east-2.aws.neon.tech/neondb?sslmode=require";
  const runtime = deriveRuntimeUrl(owner, RUNTIME_ROLE_NAME, pw);
  const ru = new URL(runtime);
  ok("deriveRuntimeUrl swaps in the runtime role", ru.username === RUNTIME_ROLE_NAME);
  ok("deriveRuntimeUrl sets the generated password", ru.password === pw);
  ok("deriveRuntimeUrl keeps host/db/params", ru.host === "ep-cool-123.us-east-2.aws.neon.tech" && ru.pathname === "/neondb" && ru.searchParams.get("sslmode") === "require");

  let threw = false;
  try {
    deriveRuntimeUrl("https://not-postgres.example/db", RUNTIME_ROLE_NAME, pw);
  } catch {
    threw = true;
  }
  ok("deriveRuntimeUrl rejects a non-postgres URL (wizard then falls back to single-role)", threw);

  const sql = twoRoleProvisioningSql(RUNTIME_ROLE_NAME, pw);
  ok("provisioning SQL creates the runtime role first", /^CREATE ROLE oe_runtime LOGIN PASSWORD '/.test(sql[0]));
  ok("provisioning SQL grants append-only tables SELECT,INSERT only", sql.some((s) => /GRANT SELECT, INSERT ON audit_entry, usage_events/.test(s)));
  ok("provisioning SQL revokes schema CREATE (no DDL for the runtime role)", sql.some((s) => /REVOKE CREATE ON SCHEMA public/.test(s)));

  const single = preflight({ OE_OPERATIONAL_PROVIDER: "postgres", DATABASE_URL: owner });
  const singleCheck = single.checks.find((c) => c.name === "append-only role posture");
  ok("preflight flags single-role posture as info advice", singleCheck?.status === "info" && /single-role/.test(singleCheck?.detail ?? ""));
  const dual = preflight({ OE_OPERATIONAL_PROVIDER: "postgres", DATABASE_URL: runtime, [OWNER_URL_ENV]: owner });
  const dualCheck = dual.checks.find((c) => c.name === "append-only role posture");
  ok("preflight marks two-role posture ok when OE_DB_OWNER_URL is parked", dualCheck?.status === "ok");
}

{
  const defaults = preflight({ AI_GATEWAY_API_KEY: "k" });
  const durability = defaults.checks.find((c) => c.name === "state durability");
  ok("preflight warns that the default backings are process-local", durability !== undefined);
  ok("the durability warning names the consequence, not just the setting", /loses|process-local/.test(durability?.detail ?? ""));
  ok("the durability warning carries a fix", /OE_MEMORY_PROVIDER=postgres/.test(durability?.fix ?? ""));
  ok("durability is advice, not a blocker — a purely local run is supported", durability?.status === "info" && defaults.ready === true);

  const durable = preflight({ AI_GATEWAY_API_KEY: "k", OE_MEMORY_PROVIDER: "postgres", OE_OPERATIONAL_PROVIDER: "postgres", DATABASE_URL: "postgres://u:p@h/db" });
  ok("no durability warning once postgres backings are selected", durable.checks.every((c) => c.name !== "state durability"));
}

{
  _resetPreflightProbesForTest();

  const bare = await preflightAsync({ AI_GATEWAY_API_KEY: "k" });
  ok("preflightAsync with no probes matches the pure preflight", bare.checks.length === preflight({ AI_GATEWAY_API_KEY: "k" }).checks.length);
  ok("…and stays ready", bare.ready === true);

  registerPreflightProbe("fake", async (env) => [
    { name: "fake: live posture", status: env.FAKE_WIDE ? "info" : "ok", detail: env.FAKE_WIDE ? "wide" : "narrow" },
  ]);
  const narrow = await preflightAsync({ AI_GATEWAY_API_KEY: "k" });
  ok("a registered probe's check is merged into the report", narrow.checks.some((c) => c.name === "fake: live posture" && c.status === "ok"));
  ok("…and the pure checks are still there", narrow.checks.some((c) => c.name.includes("AI_GATEWAY_API_KEY")));

  const wide = await preflightAsync({ AI_GATEWAY_API_KEY: "k", FAKE_WIDE: "1" });
  ok("a probe reports the other posture from the same env", wide.checks.some((c) => c.name === "fake: live posture" && c.status === "info"));
  ok("a live-posture finding is advice — it never makes preflight un-ready", wide.ready === true);

  registerPreflightProbe("boom", async () => {
    throw new Error("vendor unreachable");
  });
  const soft = await preflightAsync({ AI_GATEWAY_API_KEY: "k" });
  const boom = soft.checks.find((c) => c.name === "boom: live probe");
  ok("a throwing probe degrades to one info check", boom !== undefined && boom.status === "info");
  ok("…naming why it could not run", /vendor unreachable/.test(boom?.detail ?? ""));
  ok("…and the other probe still ran", soft.checks.some((c) => c.name === "fake: live posture"));
  ok("…and the report is still ready", soft.ready === true);

  _resetPreflightProbesForTest();
  registerPreflightProbe("silent", async () => []);
  const silent = await preflightAsync({ AI_GATEWAY_API_KEY: "k" });
  ok("an unconfigured provider's probe contributes no checks", silent.checks.length === bare.checks.length);
  _resetPreflightProbesForTest();
}

{
  const goodKey = randomBytes(CREDENTIAL_KEY_BYTES).toString("base64");

  ok("a base64 32-byte key reads ok", credentialKeyStatus(goodKey) === "ok");
  ok("an unset key reads absent", credentialKeyStatus(undefined) === "absent");
  ok("an empty key reads absent", credentialKeyStatus("") === "absent");
  ok("a short key reads malformed", credentialKeyStatus(randomBytes(16).toString("base64")) === "malformed");
  ok("a long key reads malformed", credentialKeyStatus(randomBytes(48).toString("base64")) === "malformed");
  ok("a non-base64 string reads malformed", credentialKeyStatus("not-a-key") === "malformed");

  const { credentialKeyArmed, CREDENTIAL_KEY_ENV } = await import("../agent/credentials/db-broker.js");
  ok("both sides name the same env var", CREDENTIAL_KEY_ENV === CREDENTIAL_KEY_ENV_NAME);
  const before = process.env[CREDENTIAL_KEY_ENV_NAME];
  for (const candidate of [goodKey, undefined, "", randomBytes(16).toString("base64"), randomBytes(48).toString("base64"), "not-a-key"]) {
    if (candidate === undefined) delete process.env[CREDENTIAL_KEY_ENV_NAME];
    else process.env[CREDENTIAL_KEY_ENV_NAME] = candidate;
    ok(
      `credentialKeyStatus agrees with the broker for ${candidate === undefined ? "an unset key" : `${candidate.length} base64 chars`}`,
      (credentialKeyStatus(candidate) === "ok") === credentialKeyArmed(),
    );
  }
  if (before === undefined) delete process.env[CREDENTIAL_KEY_ENV_NAME];
  else process.env[CREDENTIAL_KEY_ENV_NAME] = before;

  const noKey = preflight({ AI_GATEWAY_API_KEY: "k" });
  const noKeyCheck = noKey.checks.find((c) => c.name.includes(CREDENTIAL_KEY_ENV_NAME));
  ok("preflight reports the credential store key", noKeyCheck !== undefined);
  ok("an absent key is advice, not a blocker", noKeyCheck?.status === "info" && noKey.ready === true);
  ok("…and it names the consequence", /refuse/.test(noKeyCheck?.detail ?? ""));
  ok("…and it points at the tool that mints one", /scaffold_credential_key/.test(noKeyCheck?.fix ?? ""));

  const armed = preflight({ AI_GATEWAY_API_KEY: "k", [CREDENTIAL_KEY_ENV_NAME]: goodKey });
  ok("a well-formed key reads ok in preflight", armed.checks.find((c) => c.name.includes(CREDENTIAL_KEY_ENV_NAME))?.status === "ok");
  ok("…and carries no fix hint", armed.checks.find((c) => c.name.includes(CREDENTIAL_KEY_ENV_NAME))?.fix === undefined);

  const bad = preflight({ AI_GATEWAY_API_KEY: "k", [CREDENTIAL_KEY_ENV_NAME]: "not-a-key" });
  ok("a MALFORMED key blocks — the store fails closed on every read and write", bad.checks.find((c) => c.name.includes(CREDENTIAL_KEY_ENV_NAME))?.status === "missing");
  ok("…and preflight is not ready", bad.ready === false);

  const deploy = quickstartPlan("deploy", { AI_GATEWAY_API_KEY: "k" });
  const ids = deploy.steps.map((s) => s.id);
  ok("deploy plans the credential store key", ids.includes("credential-key"));
  ok("deploy plans pushing the root-of-trust env to the deployment", ids.includes("env-push"));
  ok("deploy plans proving the agent answers", ids.includes("verify"));
  ok("the env-push step comes after the build and before the deploy", ids.indexOf("env-push") > ids.indexOf("build") && ids.indexOf("env-push") < ids.indexOf("deploy"));
  ok("the verify step comes last", ids.indexOf("verify") === ids.length - 1);
  const envPush = deploy.steps.find((s) => s.id === "env-push");
  ok("the env-push step says WHY it exists (.env.local never ships)", /gitignored|never ships/.test(envPush?.detail ?? ""));
  ok("…and names the command", /vercel env add/.test(envPush?.command ?? ""));
  ok("env-push stays todo even with every local value set", quickstartPlan("deploy", { AI_GATEWAY_API_KEY: "k", DATABASE_URL: "postgres://u:p@h/db", [CREDENTIAL_KEY_ENV_NAME]: goodKey, OE_ADMIN_STATIC_TOKEN: "t" }).steps.find((s) => s.id === "env-push")?.status === "todo");
  ok("the credential-key step IS done once the key is armed", quickstartPlan("deploy", { AI_GATEWAY_API_KEY: "k", [CREDENTIAL_KEY_ENV_NAME]: goodKey }).steps.find((s) => s.id === "credential-key")?.status === "done");
  ok("…and todo when it is not", deploy.steps.find((s) => s.id === "credential-key")?.status === "todo");
}

{
  const dir = mkdtempSync(join(tmpdir(), "open-everywhere-key-"));
  const file = join(dir, ".env.local");
  writeFileSync(file, "# existing\nAI_GATEWAY_API_KEY=k\n", "utf-8");

  const outerKey = process.env[CREDENTIAL_KEY_ENV_NAME];
  delete process.env[CREDENTIAL_KEY_ENV_NAME];
  const outerProjectKey = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = dir;

  const server = buildOpsServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "key-test", version: "0" });
  await client.connect(ct);
  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: "scaffold_credential_key", arguments: args });
    const text = (res.content as { type: string; text: string }[])[0].text;
    return { body: JSON.parse(text) as Record<string, unknown>, text };
  };
  const keyIn = (f: string) => /^OE_CREDENTIAL_ENCRYPTION_KEY=(.*)$/m.exec(readFileSync(f, "utf-8"))?.[1];

  const first = await call({ path: file });
  ok("scaffold_credential_key mints a key", first.body.generated === true && first.body.replaced === false);
  const minted = keyIn(file);
  ok("…writing it to the file", minted !== undefined);
  ok(`…as a base64 ${CREDENTIAL_KEY_BYTES}-byte key`, credentialKeyStatus(minted) === "ok");
  ok("…preserving the rest of the file", readFileSync(file, "utf-8").includes("# existing") && readFileSync(file, "utf-8").includes("AI_GATEWAY_API_KEY=k"));
  ok("…and NEVER returning the value", !first.text.includes(minted!));
  ok("…reporting the byte count instead", first.body.bytes === CREDENTIAL_KEY_BYTES);

  const second = await call({ path: file });
  ok("a second call does NOT mint over a good key", second.body.generated === false && keyIn(file) === minted);
  ok("…and says why (stored secrets would be orphaned)", /unreadable/.test(String(second.body.note)));

  const replaced = await call({ path: file, replace: true });
  const rotated = keyIn(file);
  ok("replace:true mints a new key", replaced.body.generated === true && replaced.body.replaced === true && rotated !== minted);
  ok("…which is still well-formed", credentialKeyStatus(rotated) === "ok");
  ok("…and is still not in the response", !replaced.text.includes(rotated!));

  writeFileSync(file, "OE_CREDENTIAL_ENCRYPTION_KEY=not-a-key\n", "utf-8");
  const malformed = await call({ path: file });
  ok("a malformed key is left alone without replace", malformed.body.generated === false && malformed.body.existing === "malformed");
  ok("…and the note names the fail-closed state", /failing closed/.test(String(malformed.body.note)));

  {
    writeFileSync(file, "# existing\n", "utf-8");
    const shellKey = randomBytes(CREDENTIAL_KEY_BYTES).toString("base64");
    const before = process.env[CREDENTIAL_KEY_ENV_NAME];
    process.env[CREDENTIAL_KEY_ENV_NAME] = shellKey;
    const fromEnv = await call({ path: file });
    ok("a key exported in the shell blocks minting", fromEnv.body.ok === false && fromEnv.body.generated === false);
    ok("…naming where it lives", fromEnv.body.source === "environment");
    ok("…and the file is untouched", keyIn(file) === undefined);
    ok("…and the refusal never carries the value", !fromEnv.text.includes(shellKey));
    const forced = await call({ path: file, replace: true });
    ok("…and replace:true does NOT override that refusal", forced.body.generated === false && keyIn(file) === undefined);
    if (before === undefined) delete process.env[CREDENTIAL_KEY_ENV_NAME];
    else process.env[CREDENTIAL_KEY_ENV_NAME] = before;
    const afterUnset = await call({ path: file });
    ok("…and minting resumes once the shell key is gone", afterUnset.body.generated === true && credentialKeyStatus(keyIn(file)) === "ok");
  }

  {
    for (const name of [".env.example", ".env.e2e.example", "notes.md", "env.local", ".envrc"]) {
      const target = join(dir, name);
      const refused = await call({ path: target });
      ok(`"${name}" is refused as a target`, refused.body.ok === false && refused.body.generated === false);
      ok(`…and nothing is written to "${name}"`, !existsSync(target));
    }
    const clean = mkdtempSync(join(tmpdir(), "open-everywhere-allow-"));
    process.env.CLAUDE_PROJECT_DIR = clean;
    for (const name of [".env", ".env.local", ".env.production.local"]) {
      const target = join(clean, name);
      const accepted = await call({ path: target });
      ok(`"${name}" is accepted as a target`, accepted.body.generated === true);
      ok(`…and holds a well-formed key`, credentialKeyStatus(keyIn(target)) === "ok");
    }
    rmSync(clean, { recursive: true, force: true });
    process.env.CLAUDE_PROJECT_DIR = dir;
  }

  await call({ path: file, replace: true });
  const pf = JSON.parse(((await client.callTool({ name: "preflight", arguments: { envPath: file } })).content as { type: string; text: string }[])[0].text);
  ok("preflight via MCP reads the minted key as ok", pf.checks.find((c: { name: string }) => c.name.includes(CREDENTIAL_KEY_ENV_NAME))?.status === "ok");

  await client.close();
  rmSync(dir, { recursive: true, force: true });
  if (outerKey === undefined) delete process.env[CREDENTIAL_KEY_ENV_NAME];
  else process.env[CREDENTIAL_KEY_ENV_NAME] = outerKey;
  if (outerProjectKey === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = outerProjectKey;
}

console.log(`\n✓ ops/quickstart: ${n} assertions passed (preflight, live probes, tailored plan, env merge, scaffold via MCP, credential-store key, two-role provisioning)\n`);

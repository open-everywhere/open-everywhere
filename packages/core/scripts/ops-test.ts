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
import {
  DEPLOY_HOST_PLACEHOLDER,
  normalizeDeployHost,
  registerSurfaceAppManifest,
  surfaceAppManifest,
  surfaceAppManifestSurfaces,
  _resetSurfaceAppManifestsForTest,
} from "../agent/ops/surface-manifest.js";
import { buildOpsServer, OPS_TOOL_NAMES } from "../agent/ops/server.js";
import { registerDeploymentIdentity, deploymentOrg, seg, _resetDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { pinSuiteStore } from "./_suite-store.js";

pinSuiteStore("ops");

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

{
  _resetSurfaceAppManifestsForTest();

  ok("a bare host normalises to itself", normalizeDeployHost("oe.example.com") === "oe.example.com");
  ok("a scheme is stripped", normalizeDeployHost("https://oe.example.com") === "oe.example.com");
  ok("http is stripped too", normalizeDeployHost("http://oe.example.com") === "oe.example.com");
  ok("a trailing slash is stripped", normalizeDeployHost("https://oe.example.com/") === "oe.example.com");
  ok("surrounding whitespace is trimmed", normalizeDeployHost("  oe.example.com  ") === "oe.example.com");
  ok("a port survives", normalizeDeployHost("https://oe.example.com:8443") === "oe.example.com:8443");
  ok("an empty value is refused", normalizeDeployHost("") === undefined);
  ok("a whitespace-only value is refused", normalizeDeployHost("   ") === undefined);
  ok("a full webhook URL is refused (it carries a path)", normalizeDeployHost("https://oe.example.com/eve/v1/slack") === undefined);
  ok("a query string is refused", normalizeDeployHost("oe.example.com?x=1") === undefined);
  ok("a fragment is refused", normalizeDeployHost("oe.example.com#f") === undefined);
  ok("userinfo is refused", normalizeDeployHost("user@oe.example.com") === undefined);
  ok("an internal space is refused", normalizeDeployHost("oe example.com") === undefined);
  ok("a backslash is refused — it would become a JSON escape", normalizeDeployHost("oe\\bad.com") === undefined);
  ok("a double quote is refused — it would break the document", normalizeDeployHost('oe.example.com"x') === undefined);
  ok("a comma-separated pair is refused", normalizeDeployHost("oe.example.com,evil.com") === undefined);
  ok("a bare scheme prefix is refused", normalizeDeployHost("https:example.com") === undefined);
  ok("a non-numeric port is refused", normalizeDeployHost("oe.example.com:port") === undefined);
  ok("markup is refused", normalizeDeployHost("evil.com<b>") === undefined);

  ok("no surface is registered by default", surfaceAppManifestSurfaces().length === 0);
  ok("an unregistered surface resolves to undefined", surfaceAppManifest("slack") === undefined);

  registerSurfaceAppManifest("fake", {
    format: "json",
    consoleUrl: "https://console.example.test/apps",
    steps: ["Open the console.", "Paste the manifest."],
    collect: ["Bot token = FAKE_BOT_TOKEN"],
    template: () =>
      JSON.stringify({
        events: { request_url: `https://${DEPLOY_HOST_PLACEHOLDER}/eve/v1/fake` },
        interactivity: { request_url: `https://${DEPLOY_HOST_PLACEHOLDER}/eve/v1/fake` },
      }),
  });
  ok("a registered surface is listed", surfaceAppManifestSurfaces().includes("fake"));

  const unsubstituted = surfaceAppManifest("fake");
  ok("with no host the placeholder is kept", unsubstituted?.manifest.includes(DEPLOY_HOST_PLACEHOLDER) === true);
  ok("…and placeholdersRemaining counts EVERY one of them", unsubstituted?.placeholdersRemaining === 2);
  ok("…and no host is reported", unsubstituted?.host === undefined);

  const substituted = surfaceAppManifest("fake", { host: "oe.example.com" });
  ok("every placeholder is substituted", substituted?.placeholdersRemaining === 0);
  ok("…for real: the placeholder is gone from the document", substituted?.manifest.includes(DEPLOY_HOST_PLACEHOLDER) === false);
  ok("…and both request URLs carry the host", (substituted?.manifest.match(/https:\/\/oe\.example\.com\/eve\/v1\/fake/g) ?? []).length === 2);
  ok("…and the host is reported back", substituted?.host === "oe.example.com");
  ok("the human clicks ride along", substituted?.steps.length === 2 && substituted.consoleUrl === "https://console.example.test/apps");
  ok("…as does what the operator brings back", substituted?.collect.join(" ").includes("FAKE_BOT_TOKEN") === true);

  const server = buildOpsServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "manifest-test", version: "0" });
  await client.connect(ct);
  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: "surface_manifest", arguments: args });
    return JSON.parse((res.content as { type: string; text: string }[])[0].text) as Record<string, unknown>;
  };

  const served = await call({ surface: "fake", baseUrl: "https://oe.example.com/" });
  ok("surface_manifest serves the substituted manifest", served.ok === true && served.placeholdersRemaining === 0);
  ok("…carrying the real host", String(served.manifest).includes("https://oe.example.com/eve/v1/fake"));
  ok("…and the ordered human clicks", Array.isArray(served.steps) && (served.steps as string[]).length === 2);

  const bare = await call({ surface: "fake" });
  ok("omitting baseUrl keeps the placeholder", bare.ok === true && bare.placeholdersRemaining === 2);

  const unknown = await call({ surface: "teams" });
  ok("an unregistered surface is refused, not invented", unknown.ok === false && unknown.manifest === undefined);
  ok("…and the refusal names what IS registered", (unknown.available as string[]).includes("fake"));

  for (const bad of ["https://oe.example.com/eve/v1/fake", "   ", "oe example.com"]) {
    const refused = await call({ surface: "fake", baseUrl: bad });
    ok(`surface_manifest refuses a baseUrl that is not a host (${JSON.stringify(bad)})`, refused.ok === false);
    ok("…and returns no document at all", refused.manifest === undefined);
  }

  await client.close();
  _resetSurfaceAppManifestsForTest();
}

{
  const outerProject = process.env.CLAUDE_PROJECT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "open-everywhere-ops-org-"));
  process.env.CLAUDE_PROJECT_DIR = dir;

  const withoutOrg: Record<string, Record<string, unknown>> = {
    secret_set: { secrets: { OPS_TEST_ORG_GUARD: "fixture-value" } },
    secret_list: {},
    secret_rm: { name: "OPS_TEST_ORG_GUARD" },
  };

  let connects = 0;
  const fixtureConnect = async (_envPath: string, org: string | undefined) => {
    connects++;
    if (org !== undefined && org.trim().length > 0) registerDeploymentIdentity({ org });
    return { label: "fixture-store" };
  };

  const openServer = async (label: string) => {
    const server = buildOpsServer({ connectStore: fixtureConnect });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: label, version: "0" });
    await client.connect(ct);
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      return JSON.parse((res.content as { type: string; text: string }[])[0].text) as Record<string, unknown>;
    };
    return { client, call };
  };

  _resetDeploymentIdentityForTest();
  const core = await openServer("ops-org-core-entry");
  for (const [tool, args] of Object.entries(withoutOrg)) {
    for (const [spelling, extra] of [
      ["absent", {}],
      ["empty", { org: "" }],
    ] as const) {
      const refused = await core.call(tool, { ...args, ...extra });
      ok(`${tool} refuses to infer an org this process never learned (${spelling} org)`, refused.ok === false);
      ok(`…and the refusal names the declaration it is missing (${spelling})`, String(refused.note).includes("agent/identity/surfaces.ts"));
      ok(`…and names both ways out (${spelling})`, String(refused.note).includes("scripts/ops-mcp.ts") && String(refused.note).includes("org"));
    }
  }
  ok("a refused call opens no store at all", connects === 0);

  const named = await core.call("secret_rm", { name: "OPS_TEST_ORG_GUARD", org: "opstest-named" });
  ok("naming `org` passes the guard", named.ok === false && String(named.note ?? "").includes("no secret named"));
  ok("…and the store WAS opened for it", connects === 1);
  ok("…and the reply echoes the tenant it acted on", named.org === "opstest-named");

  const RAW_ORG: string = "Acme Corp";
  const SANITISED_ORG: string = "Acme-Corp";
  ok("the fixture org is one seg() would change", seg(RAW_ORG, "default") === SANITISED_ORG && RAW_ORG !== SANITISED_ORG);
  const rawEcho = await core.call("secret_rm", { name: "OPS_TEST_ORG_GUARD", org: RAW_ORG });
  ok("the echo is the RAW org the rows are keyed by", rawEcho.org === RAW_ORG);
  ok("…not the seg()-sanitised deploymentOrg() spelling", rawEcho.org !== SANITISED_ORG && deploymentOrg() === SANITISED_ORG);
  ok("…and the store WAS opened for it", connects === 2);

  const afterNamed = await core.call("secret_rm", { name: "OPS_TEST_ORG_GUARD" });
  ok("an `org`-named call does not disarm the guard for later bare calls", afterNamed.ok === false);
  ok("…and the bare call is still REFUSED, not merely unsuccessful", String(afterNamed.note).includes("agent/identity/surfaces.ts"));
  ok("…and it opened no store", connects === 2);
  await core.client.close();

  _resetDeploymentIdentityForTest();
  registerDeploymentIdentity({});
  const app = await openServer("ops-org-app-entry");
  const declared = await app.call("secret_rm", { name: "OPS_TEST_ORG_GUARD" });
  ok("a boot-declared identity passes the guard with no `org` on the call", declared.ok === false && String(declared.note ?? "").includes("no secret named"));
  ok("…and the store WAS opened for it", connects === 3);
  ok("…and the reply echoes the shipped default it acted on", declared.org === "default");
  await app.client.close();

  rmSync(dir, { recursive: true, force: true });
  if (outerProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = outerProject;
}

{
  const FALLBACK_NAME = "OPS_TEST_FALLBACK_SECRET";
  const FALLBACK_VALUE = "fixture-value-that-must-never-be-echoed";
  const outerFallback = process.env[FALLBACK_NAME];
  const outerProject = process.env.CLAUDE_PROJECT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "open-everywhere-ops-fallback-"));
  process.env.CLAUDE_PROJECT_DIR = dir;
  registerDeploymentIdentity({ org: "opstest-fallback" });

  const server = buildOpsServer({ connectStore: async () => ({ label: "fixture-store" }) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "ops-fallback-test", version: "0" });
  await client.connect(ct);
  const rm = async () => {
    const res = await client.callTool({ name: "secret_rm", arguments: { name: FALLBACK_NAME } });
    const text = (res.content as { type: string; text: string }[])[0].text;
    return { body: JSON.parse(text) as Record<string, unknown>, text };
  };

  delete process.env[FALLBACK_NAME];
  const closed = await rm();
  ok("no env var of the name ⇒ envFallbackPresent is false", closed.body.envFallbackPresent === false);
  ok("…and the reply raises no fallback note", !String(closed.body.note ?? "").includes("environment variable"));

  process.env[FALLBACK_NAME] = FALLBACK_VALUE;
  const reverted = await rm();
  ok("an env var of the name ⇒ envFallbackPresent is true", reverted.body.envFallbackPresent === true);
  ok("…and the note says the name still resolves", String(reverted.body.note).includes("still resolves"));
  ok("…and names the variable to delete", String(reverted.body.note).includes(FALLBACK_NAME));
  ok("…and NO part of the value reaches the reply", !reverted.text.includes(FALLBACK_VALUE) && !reverted.text.includes("fixture-value"));

  process.env[FALLBACK_NAME] = "";
  const empty = await rm();
  ok("an EMPTY env var is not a fallback", empty.body.envFallbackPresent === false);

  await client.close();
  rmSync(dir, { recursive: true, force: true });
  if (outerFallback === undefined) delete process.env[FALLBACK_NAME];
  else process.env[FALLBACK_NAME] = outerFallback;
  if (outerProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = outerProject;
  _resetDeploymentIdentityForTest();
}

console.log(`\n✓ ops/quickstart: ${n} assertions passed (preflight, live probes, tailored plan, env merge, scaffold via MCP, credential-store key, two-role provisioning, chat-app manifest, secret org guard, secret_rm env fallback)\n`);

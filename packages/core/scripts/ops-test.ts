import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import { join, basename } from "node:path";
import {
  preflight,
  mergeEnv,
  credentialKeyStatus,
  envAssignmentValue,
  CREDENTIAL_KEY_ENV_NAME,
  CREDENTIAL_KEY_BYTES,
  ENV_CONFIG_NAMES,
  PREFLIGHT_SECRET_NAMES,
} from "../agent/ops/quickstart.js";
import { CORE_PACKAGE_VERSION } from "../agent/ops/package-info.js";
import { runEnvCommand } from "./oe-env.js";
import { preflightAsync, registerPreflightProbe, _resetPreflightProbesForTest } from "../agent/ops/probes.js";
import {
  DEPLOY_HOST_PLACEHOLDER,
  normalizeDeployHost,
  registerSurfaceAppManifest,
  surfaceAppManifest,
  surfaceAppManifestSurfaces,
  surfaceAppNameProblem,
  _resetSurfaceAppManifestsForTest,
  registerSurfaceAppPackage,
  surfaceAppPackageSurfaces,
  _resetSurfaceAppPackagesForTest,
  type SurfaceAppPackageInput,
} from "../agent/ops/surface-manifest.js";
import { buildOpsServer, OPS_TOOL_NAMES } from "../agent/ops/server.js";
import { registerDeploymentIdentity, deploymentOrg, seg, _resetDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { pinSuiteStore } from "./_suite-store.js";

delete process.env.DATABASE_URL;

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
  ok("mergeEnv appends a new key", mergeEnv("A=1\n", { B: "2" }).includes("B=2"));
  ok("mergeEnv updates in place", mergeEnv("A=1\nB=2\n", { A: "9" }) === "A=9\nB=2\n");
  ok("mergeEnv preserves comments", mergeEnv("# hi\nA=1\n", { B: "2" }).startsWith("# hi"));
}

{
  const dir = mkdtempSync(join(tmpdir(), "open-everywhere-ops-"));
  const file = join(dir, ".env.local");
  writeFileSync(file, "# existing\nOE_OPERATIONAL_PROVIDER=old\nAI_GATEWAY_API_KEY=k\n", "utf-8");

  const outerProject = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = dir;

  const server = buildOpsServer();
  const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
  ok("ops server exposes exactly the declared tools", JSON.stringify(tools) === JSON.stringify([...OPS_TOOL_NAMES].sort()));

  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "ops-test", version: "0" });
  await client.connect(ct);
  const coreVersion = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8")) as { version: string }).version;
  ok(`serverInfo.version is core's package version (${coreVersion})`, client.getServerVersion()?.version === coreVersion);

  const res = await client.callTool({ name: "scaffold_env", arguments: { values: { OE_OPERATIONAL_PROVIDER: "postgres", OE_PUBLIC_BASE_URL: "https://example.test" }, path: file } });
  const out = JSON.parse((res.content as { type: string; text: string }[])[0].text);
  ok("scaffold_env reports the keys it set", out.ok === true && out.keysSet.includes("OE_PUBLIC_BASE_URL"));

  const written = readFileSync(file, "utf-8");
  ok("scaffold_env updates an existing key in place", written.includes("OE_OPERATIONAL_PROVIDER=postgres") && !written.includes("=old"));
  ok("scaffold_env appends a new key", written.includes("OE_PUBLIC_BASE_URL=https://example.test"));
  ok("scaffold_env preserves comments", written.includes("# existing"));

  const pfRes = await client.callTool({ name: "preflight", arguments: { envPath: file } });
  const pf = JSON.parse((pfRes.content as { type: string; text: string }[])[0].text);
  ok("preflight via MCP reads the scaffolded env", pf.checks.find((c: { name: string }) => c.name.includes("AI_GATEWAY_API_KEY"))?.status === "ok");

  {
    const scaffold = async (target: string) => {
      const r = await client.callTool({ name: "scaffold_env", arguments: { values: { OE_PUBLIC_BASE_URL: "https://gate.fixture" }, path: target } });
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
    ok("scaffold_env still writes the project's own .env.local", allowed.ok === true && readFileSync(file, "utf-8").includes("OE_PUBLIC_BASE_URL=https://gate.fixture"));
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
  ok("the durability warning carries a fix", /DATABASE_URL/.test(durability?.fix ?? ""));
  ok("…and the fix no longer names either store selector", !/OE_MEMORY_PROVIDER|OE_OPERATIONAL_PROVIDER/.test(durability?.fix ?? ""));
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

  registerSurfaceAppManifest("named", {
    format: "json",
    consoleUrl: "https://console.example.test/apps",
    steps: [],
    collect: [],
    template: (o) => JSON.stringify({ name: o.appName ?? "Default Name", url: `https://${DEPLOY_HOST_PLACEHOLDER}/x` }),
    appNameMax: 12,
  });
  const nameOf = (m: { manifest: string } | undefined): unknown => (m === undefined ? undefined : (JSON.parse(m.manifest) as { name: unknown }).name);
  ok("no appName keeps the template's default name", nameOf(surfaceAppManifest("named")) === "Default Name");
  ok("…and reports no appName", surfaceAppManifest("named")?.appName === undefined);
  const named = surfaceAppManifest("named", { appName: "  Acme Agent " });
  ok("an appName reaches the template, trimmed", nameOf(named) === "Acme Agent");
  ok("…and is reported back", named?.appName === "Acme Agent");
  ok("a name within the limit has no problem", surfaceAppNameProblem("named", "Acme Agent") === undefined);
  ok("a name over the limit is a problem", /at most 12/.test(surfaceAppNameProblem("named", "Thirteen char") ?? ""));
  ok("an empty name is a problem", surfaceAppNameProblem("named", "   ") !== undefined);
  ok("a control character is a problem", surfaceAppNameProblem("named", "Acme\nAgent") !== undefined);
  ok("a surface with no appNameMax refuses a name", /takes no app name/.test(surfaceAppNameProblem("fake", "Acme") ?? ""));
  ok("surfaceAppManifest drops a name that fails the check", nameOf(surfaceAppManifest("named", { appName: "Thirteen char" })) === "Default Name");

  const servedNamed = await call({ surface: "named", appName: "Acme Agent" });
  ok("surface_manifest serves the named manifest", servedNamed.ok === true && nameOf(servedNamed as { manifest: string }) === "Acme Agent");
  const tooLong = await call({ surface: "named", appName: "Thirteen char" });
  ok("surface_manifest refuses an appName over the limit", tooLong.ok === false && tooLong.manifest === undefined);
  ok("…naming the limit", /at most 12/.test(String(tooLong.note)));
  const unnameable = await call({ surface: "fake", appName: "Acme" });
  ok("surface_manifest refuses an appName on a surface that takes none", unnameable.ok === false && unnameable.manifest === undefined);

  await client.close();
  _resetSurfaceAppManifestsForTest();
}

{
  _resetSurfaceAppPackagesForTest();
  ok("no package surface is registered by default", surfaceAppPackageSurfaces().length === 0);
  const dir = mkdtempSync(join(tmpdir(), "open-everywhere-pkg-"));
  const outerProject = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = dir;
  mkdirSync(join(dir, "art"), { recursive: true });
  writeFileSync(join(dir, "art", "c.png"), "COLOR-BYTES");
  writeFileSync(join(dir, ".env.local"), "FAKE_APP_ID=app-123\n", "utf-8");
  let seen: SurfaceAppPackageInput | undefined;
  registerSurfaceAppPackage("fakepkg", {
    icons: { color: "default/color.png", outline: "default/outline.png" },
    outDir: "fake-app",
    build: (input) => {
      seen = input;
      const blocked = input.developerName === undefined;
      return {
        findings: blocked ? [{ id: "developer-name", level: "block", detail: "no developer name" }] : [{ id: "w", level: "warn", detail: "a warning" }],
        manifest: JSON.stringify({ host: input.host }),
        ...(blocked ? {} : { archive: new Uint8Array([0x50, 0x4b, 1, 2]) }),
        fileName: "fake.zip",
        steps: ["Upload it."],
      };
    },
  });
  const server = buildOpsServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "package-test", version: "0" });
  await client.connect(ct);
  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: "surface_app_package", arguments: args });
    return JSON.parse((res.content as { type: string; text: string }[])[0].text) as Record<string, unknown>;
  };
  const okArgs = { surface: "fakepkg", baseUrl: "https://oe.example.com", route: "org", developerName: "Acme", icons: { color: "art/c.png" } };

  const unknown = await call({ surface: "nope", baseUrl: "oe.example.com", route: "org" });
  ok("surface_app_package refuses an unregistered surface", unknown.ok === false && (unknown.available as string[]).includes("fakepkg"));
  const badHost = await call({ ...okArgs, baseUrl: "https://oe.example.com/a/path" });
  ok("surface_app_package refuses a baseUrl that is not a host", badHost.ok === false && seen === undefined);

  const blocked = await call({ ...okArgs, developerName: undefined });
  ok("🔴 a blocked package is refused…", blocked.ok === false && (blocked.findings as { id: string }[])[0]?.id === "developer-name");
  ok("🔴 …and nothing is written", !existsSync(join(dir, "fake-app")));

  const built = await call(okArgs);
  ok("a passing package is written", built.ok === true && built.path === join("fake-app", "fake.zip"));
  ok("…with the bundle's bytes", readFileSync(join(dir, "fake-app", "fake.zip")).equals(Buffer.from([0x50, 0x4b, 1, 2])));
  ok("…and its sha256, warnings and steps", typeof built.sha256 === "string" && (built.findings as { level: string }[])[0]?.level === "warn" && (built.steps as string[])[0] === "Upload it.");
  ok("the bundle got the normalised host", seen?.host === "oe.example.com");
  ok("the bundle got the named icon's bytes", Buffer.from(seen?.icons.color ?? []).toString() === "COLOR-BYTES");
  ok("…and absent bytes for a missing default icon", "outline" in (seen?.icons ?? {}) && seen?.icons.outline === undefined);
  ok("the bundle got the project's .env.local", seen?.env.FAKE_APP_ID === "app-123");

  const outside = await call({ ...okArgs, outPath: "../escape.zip" });
  ok("🔴 an outPath outside the project is refused", outside.ok === false && !existsSync(join(dir, "..", "escape.zip")));
  const notZip = await call({ ...okArgs, outPath: "fake-app/x.json" });
  ok("an outPath that is not a .zip is refused", notZip.ok === false && !existsSync(join(dir, "fake-app", "x.json")));
  const iconOutside = await call({ ...okArgs, icons: { color: "../../etc/passwd" } });
  ok("🔴 an icon path outside the project is refused", iconOutside.ok === false && /outside the project/.test(String(iconOutside.note)));
  const away = mkdtempSync(join(tmpdir(), "open-everywhere-pkg-away-"));
  symlinkSync(away, join(dir, "linked"));
  const viaLink = await call({ ...okArgs, outPath: "linked/escape.zip" });
  ok("🔴 an outPath through a symlink that leaves the project is refused", viaLink.ok === false && !existsSync(join(away, "escape.zip")));
  writeFileSync(join(away, "c.png"), "OUTSIDE");
  const iconViaLink = await call({ ...okArgs, icons: { color: "linked/c.png" } });
  ok("🔴 an icon path through a symlink that leaves the project is refused", iconViaLink.ok === false && /outside the project/.test(String(iconViaLink.note)));
  symlinkSync(join(away, "dangling.zip"), join(dir, "dangle.zip"));
  const dangling = await call({ ...okArgs, outPath: "dangle.zip" });
  ok("🔴 an outPath that is a dangling symlink out of the project is refused", dangling.ok === false && !existsSync(join(away, "dangling.zip")));
  const custom = await call({ ...okArgs, outPath: "dist/listing.zip" });
  ok("an outPath inside the project is honoured", custom.ok === true && existsSync(join(dir, "dist", "listing.zip")));

  await client.close();
  if (outerProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = outerProject;
  _resetSurfaceAppPackagesForTest();
}

{
  const outerProject = process.env.CLAUDE_PROJECT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "open-everywhere-ops-org-"));
  process.env.CLAUDE_PROJECT_DIR = dir;

  const withoutOrg: Record<string, Record<string, unknown>> = {
    secret_set: { names: ["OPS_TEST_ORG_GUARD"] },
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

{
  const goodKey = randomBytes(CREDENTIAL_KEY_BYTES).toString("base64");

  const old = preflight({ AI_GATEWAY_API_KEY: "k" }, { nodeVersion: "20.11.0", nodeRange: ">=24" });
  const oldNode = old.checks.find((c) => c.name.startsWith("node "));
  ok("preflight names the engines range in the node check", oldNode?.name === "node >=24");
  ok("…and a Node below it is missing", oldNode?.status === "missing" && old.ready === false);
  ok("…with a fix", /24/.test(oldNode?.fix ?? ""));
  const cur = preflight({ AI_GATEWAY_API_KEY: "k" }, { nodeVersion: "24.19.0", nodeRange: ">=24" });
  ok("a Node inside the range is ok (negative control)", cur.checks.find((c) => c.name.startsWith("node "))?.status === "ok");
  const odd = preflight({ AI_GATEWAY_API_KEY: "k" }, { nodeVersion: "24.19.0", nodeRange: "lts/*" });
  ok("an unparseable range is info, never a false ok", odd.checks.find((c) => c.name.startsWith("node "))?.status === "info");
  const live = preflight({ AI_GATEWAY_API_KEY: "k" });
  const coreRange = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8")) as { engines: { node: string } }).engines.node;
  ok(`by default the range is core's own engines.node (${coreRange})`, live.checks.some((c) => c.name === `node ${coreRange}`));

  const opDetail = (env: NodeJS.ProcessEnv) => preflight(env).checks.find((c) => c.name === "operational provider")?.detail ?? "";
  ok("no DATABASE_URL and no selector reads as embedded Postgres, not sqlite", /embedded Postgres/.test(opDetail({})) && !/sqlite/.test(opDetail({})));
  ok("DATABASE_URL without a selector reads as hosted postgres, derived", /postgres \(hosted\)/.test(opDetail({ DATABASE_URL: "postgres://u:p@h/db" })) && /derived from DATABASE_URL/.test(opDetail({ DATABASE_URL: "postgres://u:p@h/db" })));
  ok("…and no longer reads as sqlite (the negative control for the OPE-2230 default)", !/sqlite/.test(opDetail({ DATABASE_URL: "postgres://u:p@h/db" })));
  ok("an explicit sqlite selector still reads as the deprecated floor", /sqlite/.test(opDetail({ OE_OPERATIONAL_PROVIDER: "sqlite", DATABASE_URL: "postgres://u:p@h/db" })));

  const pins = { nodeVersion: "24.19.0", nodeRange: ">=24" } as const;
  const bare = preflight({}, { target: "vercel" });
  const model = bare.checks.find((c) => c.name.includes("AI_GATEWAY_API_KEY"));
  ok("vercel: an absent gateway key is info (OIDC), not missing", model?.status === "info" && /OIDC/.test(model.detail));
  const dockerModel = preflight({}, { target: "docker" }).checks.find((c) => c.name.includes("AI_GATEWAY_API_KEY"));
  ok("docker: an absent gateway key BLOCKS — off Vercel there is no OIDC", dockerModel?.status === "missing");
  ok("docker: …and it never claims the key is not needed", !/not needed on Vercel/.test(dockerModel?.detail ?? "") && /no OIDC/.test(dockerModel?.detail ?? ""));
  ok("docker: …and its fix names the adapter swap this check cannot see, rather than a config that does not exist",
    /adapter-model/.test(dockerModel?.fix ?? "") && !/agent\/model\//.test(dockerModel?.fix ?? ""));
  for (const store of ["operational", "memory"]) {
    for (const target of ["vercel", "docker"] as const) {
      ok(
        `${target}: a ${store} store that does not resolve to postgres blocks`,
        preflight({}, { target }).checks.find((c) => c.name === `deploy store: ${store} = postgres`)?.status === "missing",
      );
    }
  }
  const derivedEnv = { DATABASE_URL: "postgres://u:p@h/db", [CREDENTIAL_KEY_ENV_NAME]: goodKey };
  const derived = preflight(derivedEnv, { ...pins, target: "vercel" });
  ok("vercel: DATABASE_URL alone is ready — no store selector needed", derived.ready === true);
  for (const store of ["operational", "memory"]) {
    const line = derived.checks.find((c) => c.name === `deploy store: ${store} = postgres`);
    ok(`vercel: the ${store} line is ok and says it was derived`, line?.status === "ok" && /derived from DATABASE_URL/.test(line.detail));
  }
  ok("docker: the SAME env is NOT ready — the gateway key is the one difference", preflight(derivedEnv, { ...pins, target: "docker" }).ready === false);
  ok("docker: …and it IS ready once the key is set", preflight({ ...derivedEnv, AI_GATEWAY_API_KEY: "k" }, { ...pins, target: "docker" }).ready === true);
  ok("vercel: DATABASE_URL is required", bare.checks.find((c) => c.name === "DATABASE_URL (Postgres)")?.status === "missing");
  ok("vercel: …and the fix names the Vercel Marketplace Neon integration", /Marketplace/.test(bare.checks.find((c) => c.name === "DATABASE_URL (Postgres)")?.fix ?? ""));
  const dockerDb = preflight({}, { target: "docker" }).checks.find((c) => c.name === "DATABASE_URL (Postgres)");
  ok("docker: DATABASE_URL is required, and its fix names no Vercel Marketplace", dockerDb?.status === "missing" && !/Marketplace/.test(dockerDb?.fix ?? ""));
  ok("vercel: an absent credential key blocks", bare.checks.find((c) => c.name.includes(CREDENTIAL_KEY_ENV_NAME))?.status === "missing");
  ok("docker: an absent credential key blocks too", preflight({}, { target: "docker" }).checks.find((c) => c.name.includes(CREDENTIAL_KEY_ENV_NAME))?.status === "missing");
  ok("vercel: the bare env is not ready", bare.ready === false);
  const pinnedEnv = { OE_OPERATIONAL_PROVIDER: "postgres", OE_MEMORY_PROVIDER: "postgres", DATABASE_URL: "postgres://u:p@h/db", [CREDENTIAL_KEY_ENV_NAME]: goodKey };
  ok("vercel: the full deploy env is ready with no gateway key (negative control)", preflight(pinnedEnv, { ...pins, target: "vercel" }).ready === true);
  for (const store of ["operational", "memory"]) {
    const line = preflight(pinnedEnv, { ...pins, target: "vercel" }).checks.find((c) => c.name === `deploy store: ${store} = postgres`);
    ok(`vercel: an explicit ${store} pin reads as set explicitly, not derived`, line?.status === "ok" && /set explicitly as OE_/.test(line.detail));
  }
  ok("local: the same env without a gateway key is NOT ready (the target is what changed)", preflight(pinnedEnv, pins).ready === false);
  ok("vercel: a selector set to another value still blocks", preflight({ ...pinnedEnv, OE_MEMORY_PROVIDER: "git" }, { target: "vercel" }).ready === false);
}

{
  const SENTINEL = "ope2396-sentinel-value-that-must-never-be-echoed";
  const outerProject = process.env.CLAUDE_PROJECT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "open-everywhere-ops-2396-"));
  process.env.CLAUDE_PROJECT_DIR = dir;
  const file = join(dir, ".env.local");
  _resetDeploymentIdentityForTest();
  registerDeploymentIdentity({ org: "opstest-2396" });

  let connects = 0;
  const server = buildOpsServer({
    connectStore: async () => {
      connects++;
      return { label: "fixture-store" };
    },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "ops-2396", version: "0" });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0].text;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
    }
    return { isError: res.isError === true, text, body };
  };

  const freeMaps: string[] = [];
  const walk = (schema: unknown, at: string) => {
    if (schema === null || typeof schema !== "object") return;
    const node = schema as Record<string, unknown>;
    const extra = node.additionalProperties;
    if (node.type === "object" && extra !== undefined && extra !== false && at.includes(".")) freeMaps.push(at);
    for (const [key, child] of Object.entries((node.properties as Record<string, unknown> | undefined) ?? {})) walk(child, `${at}.${key}`);
    for (const key of ["items", "anyOf", "oneOf", "allOf"]) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach((c, i) => walk(c, `${at}.${key}[${i}]`));
      else walk(child, `${at}.${key}`);
    }
  };
  const listed = (await client.listTools()).tools;
  ok("every ops tool is listed", JSON.stringify(listed.map((t) => t.name).sort()) === JSON.stringify([...OPS_TOOL_NAMES].sort()));
  for (const tool of listed) walk(tool.inputSchema, tool.name);
  ok(`🔴 no ops tool input takes a free name → value map (found: ${freeMaps.join(", ") || "none"})`, freeMaps.length === 0);
  const oldShape = { type: "object", properties: { values: { type: "object", additionalProperties: { type: "string" } } } };
  const probe: string[] = [];
  const saved = freeMaps.length;
  walk(oldShape, "old_scaffold_env");
  probe.push(...freeMaps.splice(saved));
  ok("…and the walker DOES find the old `values: Record<string, string>` shape (negative control)", probe.length === 1);
  const scaffoldValues = listed.find((t) => t.name === "scaffold_env")?.inputSchema.properties?.values as Record<string, unknown> | undefined;
  ok(
    "scaffold_env advertises exactly the config allowlist under `values`",
    JSON.stringify(Object.keys((scaffoldValues?.properties as Record<string, unknown>) ?? {}).sort()) === JSON.stringify([...ENV_CONFIG_NAMES].sort()),
  );
  const secretSetProps = Object.keys(listed.find((t) => t.name === "secret_set")?.inputSchema.properties ?? {});
  ok("secret_set takes names, org and envPath — no value field", JSON.stringify(secretSetProps.sort()) === JSON.stringify(["envPath", "names", "org"]));

  const pfBase: NodeJS.ProcessEnv = { DATABASE_URL: "postgres://u:p@h/db" };
  const pfOf = (env: NodeJS.ProcessEnv) => JSON.stringify(preflight(env, { target: "docker", nodeVersion: "24.19.0", nodeRange: ">=24" }).checks);
  for (const name of PREFLIGHT_SECRET_NAMES) {
    const without: NodeJS.ProcessEnv = { ...pfBase };
    delete without[name];
    ok(`preflight checks for the secret ${name}`, pfOf(without) !== pfOf({ ...without, [name]: "fixture" }));
    ok(`${name} is not on the scaffold_env config allowlist`, !(ENV_CONFIG_NAMES as readonly string[]).includes(name));
    const r = await call("scaffold_env", { values: { [name]: SENTINEL } });
    ok(`🔴 scaffold_env refuses a value for the secret ${name}`, r.isError || r.body.ok === false);
    ok(`…and writes nothing (${name})`, !existsSync(file) || !readFileSync(file, "utf-8").includes(SENTINEL));
  }
  const fixEnvs: NodeJS.ProcessEnv[] = [{}, { DATABASE_URL: "postgres://u:p@h/db" }, { OE_OPERATIONAL_PROVIDER: "postgres" }, { OE_MEMORY_PROVIDER: "git", DATABASE_URL: "postgres://u:p@h/db" }];
  const examined = new Set<string>();
  for (const target of ["local", "vercel", "docker"] as const) {
    for (const env of fixEnvs) {
      for (const check of preflight(env, { target, nodeVersion: "24.19.0", nodeRange: ">=24" }).checks) {
        const fix = check.fix ?? "";
        if (!/\b(set|sets|copy|put|puts|paste|add|enter|store|write)\b/i.test(fix)) continue;
        for (const name of PREFLIGHT_SECRET_NAMES.filter((n) => fix.includes(n) || check.name.includes(n))) {
          ok(
            `${target}: the "${check.name}" fix names a door for ${name} that keeps the value from the agent`,
            fix.includes(`npx oe env set ${name}`) || (name === CREDENTIAL_KEY_ENV_NAME && fix.includes("scaffold_credential_key")),
          );
          examined.add(`${check.name} | ${name}`);
        }
      }
    }
  }
  for (const pair of [
    "model: AI_GATEWAY_API_KEY | AI_GATEWAY_API_KEY",
    "DATABASE_URL (Postgres) | DATABASE_URL",
    "deploy store: operational = postgres | DATABASE_URL",
    "deploy store: memory = postgres | DATABASE_URL",
    `credential store key (${CREDENTIAL_KEY_ENV_NAME}) | ${CREDENTIAL_KEY_ENV_NAME}`,
    "control-plane admin auth | OE_ADMIN_STATIC_TOKEN",
  ]) {
    ok(`the preflight-fix door arm examined "${pair}"`, examined.has(pair));
  }
  for (const name of ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"]) {
    const r = await call("scaffold_env", { values: { [name]: SENTINEL } });
    ok(`🔴 scaffold_env refuses a value for ${name}`, r.isError || r.body.ok === false);
  }

  const askMissing = await call("scaffold_env", { secretNames: ["SLACK_BOT_TOKEN"] });
  const askedRow = (askMissing.body.secrets as { name: string; present: boolean; command: string }[] | undefined)?.[0];
  ok("scaffold_env { secretNames } names the person's command", askedRow?.command === "npx oe env set SLACK_BOT_TOKEN" && askedRow.present === false);
  ok("…and the note says where the command runs", String(askMissing.body.note).includes("their own terminal"));
  writeFileSync(file, `SLACK_BOT_TOKEN=${SENTINEL}\n`, "utf-8");
  const askPresent = await call("scaffold_env", { secretNames: ["SLACK_BOT_TOKEN"] });
  ok("…and reports presence once the file holds it", (askPresent.body.secrets as { present: boolean }[])[0]?.present === true);
  ok("🔴 …and no part of the value reaches the reply", !askPresent.text.includes(SENTINEL) && !askPresent.text.includes("sentinel"));
  ok("…and nothing was rewritten", readFileSync(file, "utf-8") === `SLACK_BOT_TOKEN=${SENTINEL}\n`);
  const notAName = await call("scaffold_env", { secretNames: [SENTINEL] });
  ok("scaffold_env refuses a secretName that is not an env name", notAName.body.ok === false);
  ok("🔴 …and does not echo it (a pasted value in a name field stays out of the reply)", !notAName.text.includes(SENTINEL));

  const before = connects;
  const lacking = await call("secret_set", { names: ["ACME_API_TOKEN"] });
  ok("secret_set refuses a name the env file does not hold", lacking.body.ok === false && JSON.stringify(lacking.body.missing) === '["ACME_API_TOKEN"]');
  ok("…and names the person's command", String(lacking.body.note).includes("npx oe env set ACME_API_TOKEN"));
  ok("…and opens no store", connects === before);
  const lower = await call("secret_set", { names: ["acme_api_token", SENTINEL] });
  ok("secret_set refuses a name `oe env set` could never write", lower.body.ok === false && String(lower.body.note).includes("names[0]"));
  ok("…and points at `oe secret set` for a store-only name", String(lower.body.note).includes("npx oe secret set"));
  ok("🔴 …and echoes no name it refused", !lower.text.includes("acme_api_token") && !lower.text.includes(SENTINEL));
  ok("…and opens no store", connects === before);
  writeFileSync(join(dir, ".env.example"), `ACME_API_TOKEN=${SENTINEL}\n`, "utf-8");
  const tracked = await call("secret_set", { names: ["ACME_API_TOKEN"], envPath: ".env.example" });
  ok("secret_set refuses to read secrets from a tracked file", tracked.body.ok === false && String(tracked.body.note).includes("refusing to read secrets from"));
  ok("…and opens no store", connects === before);

  const installed = join(dir, "node_modules", "@open-everywhere", "core");
  mkdirSync(installed, { recursive: true });
  const setInstalled = (version: string) => writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "@open-everywhere/core", version }), "utf-8");
  const minimalArgs: Record<string, Record<string, unknown>> = {
    preflight: {},
    surface_manifest: { surface: "slack" },
    surface_app_package: { surface: "teams", baseUrl: "oe.example.com", route: "org" },
    surface_app_create: { surface: "github", action: "status" },
    scaffold_env: {},
    scaffold_credential_key: {},
    secret_set: { names: ["OPS_TEST_2396_ABSENT"] },
    secret_list: {},
    secret_rm: { name: "OPS_TEST_2396" },
  };
  ok("the stale-core arms cover every tool", JSON.stringify(Object.keys(minimalArgs).sort()) === JSON.stringify([...OPS_TOOL_NAMES].sort()));
  setInstalled(CORE_PACKAGE_VERSION);
  for (const [tool, args] of Object.entries(minimalArgs)) {
    const r = await call(tool, args);
    ok(`${tool}: an installed core equal to the loaded one is served (negative control)`, r.body.stale === undefined);
  }
  const STALE = "9.9.9-ope2396";
  setInstalled(STALE);
  for (const [tool, args] of Object.entries(minimalArgs)) {
    const before2 = connects;
    const r = await call(tool, args);
    ok(`🔴 ${tool}: refuses once the app's installed core differs`, r.isError && r.body.ok === false);
    ok(`…and names both versions (${tool})`, String(r.body.note).includes(STALE) && String(r.body.note).includes(CORE_PACKAGE_VERSION));
    ok(`…and says to restart the ops server (${tool})`, /Restart the ops server/.test(String(r.body.note)));
    ok(`…and touches no store (${tool})`, connects === before2);
  }
  const badShape = await call("scaffold_env", { values: { SLACK_BOT_TOKEN: "x" } });
  ok("🔴 a stale server answers a schema-invalid call with the restart, not a validation error", String(badShape.body.note).includes("Restart the ops server"));
  const unknown = await call("a_tool_a_later_core_adds", {});
  ok("🔴 a stale server answers a call to a tool it lacks with the restart, not 'not found'", String(unknown.body.note).includes("Restart the ops server"));
  setInstalled(CORE_PACKAGE_VERSION);
  ok("the refusal lifts when the versions agree again (read per call, never cached)", (await call("preflight", {})).body.stale === undefined);

  await client.close();
  rmSync(dir, { recursive: true, force: true });
  if (outerProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = outerProject;
  _resetDeploymentIdentityForTest();
}

{
  for (const value of ["plain", "has#hash", "has space", " leading", "it's", 'say "hi"', "back`tick", "postgres://u:p@h/db?sslmode=require"]) {
    const rhs = envAssignmentValue(value);
    ok(`envAssignmentValue round-trips ${JSON.stringify(value)}`, rhs !== undefined && parseEnv(`X=${rhs}`).X === value);
  }
  ok("envAssignmentValue refuses a line break", envAssignmentValue("a\nb") === undefined);

  const dir = mkdtempSync(join(tmpdir(), "open-everywhere-oe-env-"));
  const VALUE = "xoxb-oe-env-value #with-hash";
  const run = async (args: string[], value = VALUE) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runEnvCommand(args, { out: (l) => out.push(l), err: (l) => err.push(l), readValue: async () => `${value}\n` }, dir);
    return { code, text: [...out, ...err].join("\n") };
  };
  writeFileSync(join(dir, ".env.local"), "# kept\nSLACK_BOT_TOKEN=old\n", "utf-8");
  const set = await run(["set", "SLACK_BOT_TOKEN"]);
  ok("oe env set writes the value", set.code === 0 && parseEnv(readFileSync(join(dir, ".env.local"), "utf-8")).SLACK_BOT_TOKEN === VALUE);
  ok("…in place, keeping comments", readFileSync(join(dir, ".env.local"), "utf-8").startsWith("# kept\n") && !readFileSync(join(dir, ".env.local"), "utf-8").includes("=old"));
  ok("🔴 …and never prints the value", !set.text.includes("xoxb") && set.text.includes(`${Buffer.byteLength(VALUE)} bytes`));
  const extra = await run(["set", "SLACK_BOT_TOKEN", VALUE]);
  ok("🔴 oe env set refuses a value on argv", extra.code === 2 && !extra.text.includes("xoxb"));
  ok("oe env set refuses a tracked target", (await run(["set", "A_TOKEN", "--file", ".env.example"])).code === 1 && !existsSync(join(dir, ".env.example")));
  ok("oe env set refuses a target outside the root", (await run(["set", "A_TOKEN", "--file", "../.env.local"])).code === 1);
  ok("oe env set refuses an empty value", (await run(["set", "A_TOKEN"], "")).code === 1);
  ok("oe env set refuses a lower-case name", (await run(["set", "a_token"])).code === 2);
  const arrow = await run(["set", "A_TOKEN"], "abc\u001b[Ddef");
  ok("oe env set refuses a value with a control character (an arrow key at the prompt)", arrow.code === 1 && !parseEnv(readFileSync(join(dir, ".env.local"), "utf-8")).A_TOKEN);
  ok("…and a tab is still a legal value", (await run(["set", "TAB_TOKEN"], "a\tb")).code === 0);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n✓ ops/setup: ${n} assertions passed (three-target preflight, live probes, env merge, scaffold via MCP, credential-store key, two-role provisioning, chat-app manifest, secret org guard, secret_rm env fallback, no secret value in a tool, stale-core refusal, oe env set)\n`);

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { preflight, quickstartPlan, mergeEnv, registerQuickstartSurfaceGoal } from "../agent/ops/quickstart.js";
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

  const server = buildOpsServer();
  const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
  ok("ops server exposes exactly the declared tools", JSON.stringify(tools) === JSON.stringify([...OPS_TOOL_NAMES].sort()));

  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "ops-test", version: "0" });
  await client.connect(ct);

  const res = await client.callTool({ name: "scaffold_env", arguments: { values: { AI_GATEWAY_API_KEY: "new", OE_ORG: "acme" }, path: file } });
  const out = JSON.parse((res.content as { type: string; text: string }[])[0].text);
  ok("scaffold_env reports the keys it set", out.ok === true && out.keysSet.includes("OE_ORG"));

  const written = readFileSync(file, "utf-8");
  ok("scaffold_env updates an existing key in place", written.includes("AI_GATEWAY_API_KEY=new") && !written.includes("=old"));
  ok("scaffold_env appends a new key", written.includes("OE_ORG=acme"));
  ok("scaffold_env preserves comments", written.includes("# existing"));

  const pfRes = await client.callTool({ name: "preflight", arguments: { envPath: file } });
  const pf = JSON.parse((pfRes.content as { type: string; text: string }[])[0].text);
  ok("preflight via MCP reads the scaffolded env", pf.checks.find((c: { name: string }) => c.name.includes("AI_GATEWAY_API_KEY"))?.status === "ok");

  await client.close();
  rmSync(dir, { recursive: true, force: true });
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

console.log(`\n✓ ops/quickstart: ${n} assertions passed (preflight, tailored plan, env merge, scaffold via MCP, two-role provisioning)\n`);

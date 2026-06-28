import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { preflight, quickstartPlan, mergeEnv } from "../agent/ops/quickstart.js";
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

  const slack = quickstartPlan("slack", { AI_GATEWAY_API_KEY: "k" });
  ok("slack goal adds a Slack step", slack.steps.some((s) => s.id === "slack" && s.status === "todo"));

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

console.log(`\n✓ ops/quickstart: ${n} assertions passed (preflight, tailored plan, env merge, scaffold via MCP)\n`);

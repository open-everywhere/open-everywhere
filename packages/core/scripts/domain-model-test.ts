import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-domain-model-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { buildControlServer } = await import("../agent/control/server.js");
const { CONTROL_WRITE_TOOL_NAMES } = await import("../agent/control/writes.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { defineModelPolicy } = await import("../agent/model/policy.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const {
  createDomainRoutedModel,
} = await import("../agent/model/routing.js");

import type { RoutingDeps, ModelBackend, RoutableModel, RoutedCallOptions } from "../agent/model/routing.js";
import type { Domain, ModelReasoning } from "../agent/memory/domain.js";
import type { ModelPolicy } from "../agent/model/policy.js";

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

const POLICY: ModelPolicy = defineModelPolicy({
  allow: [
    { id: "zai/glm-5.2", tier: "high" },
    { id: "deepseek/deepseek-v4-flash", tier: "low" },
  ],
  reasoningCeiling: "medium",
});
const C_ENG = "slack/T1/C_ENG";
const C_FIN = "slack/T1/C_FIN";
const DEFAULT_ID = "zai/glm-5.2";
const domains: Domain[] = [
  defineDomain({ name: "org", match: "org", models: { primary: { id: DEFAULT_ID, reasoning: "medium" } } }),
  defineDomain({ name: "eng", channels: [C_ENG], reasoningCeiling: "high" }),
  defineDomain({ name: "finance", channels: [C_FIN], reasoningCeiling: "low" }),
];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [],
  loadRoles: () => [],
  loadModelPolicy: () => POLICY,
  domainsForSurface: () => [],
});

const org = "acme";
const callTool = async (client: InstanceType<typeof Client>, name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return { isError: res.isError === true, body: res.isError === true ? {} : JSON.parse(text), text };
};
async function connect(roles: readonly string[], actor = "admin@example.com") {
  const server = buildControlServer({ includeWrites: true, actor, roles });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "dm-test", version: "0" });
  await client.connect(ct);
  return client;
}

{
  ok("CONTROL_WRITE_TOOL_NAMES lists set_domain_model", (CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes("set_domain_model"));
  ok("CONTROL_WRITE_TOOL_NAMES lists clear_domain_model", (CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes("clear_domain_model"));
  const writeTools = Object.keys((buildControlServer({ includeWrites: true, actor: "t" }) as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  ok("write server exposes set_domain_model + clear_domain_model", writeTools.includes("set_domain_model") && writeTools.includes("clear_domain_model"));
  const roTools = Object.keys((buildControlServer({ includeWrites: true, actor: "t", readOnly: true }) as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  ok("readOnly server structurally omits set_domain_model", !roTools.includes("set_domain_model"));
}

{
  const admin = await connect(["admin"]);
  const r = await callTool(admin, "set_domain_model", { org, domain: "eng", modelId: "zai/glm-5.2" });
  ok("org admin may set any domain's pick", !r.isError && r.body.ok === true && r.body.modelId === "zai/glm-5.2");
  await admin.close();

  const engAdmin = await connect(["domain:eng"], "eng-lead");
  const rEng = await callTool(engAdmin, "set_domain_model", { org, domain: "eng", reasoning: "high" });
  ok("a domain:eng role may set the eng pick", !rEng.isError && rEng.body.ok === true && rEng.body.reasoning === "high");
  const rCross = await callTool(engAdmin, "set_domain_model", { org, domain: "finance", modelId: "deepseek/deepseek-v4-flash" });
  ok("a domain:eng role is REFUSED setting the finance pick (RBAC fail-closed)", rCross.isError);
  ok("a refused cross-domain set does not write the store", (await getOperationalStore().getDomainModel(org, "finance")) === null);
  await engAdmin.close();

  const nobody = await connect([], "rando");
  const rNobody = await callTool(nobody, "set_domain_model", { org, domain: "eng", modelId: "zai/glm-5.2" });
  ok("a non-admin (no covering role) is REFUSED (RBAC fail-closed)", rNobody.isError);
  await nobody.close();
}

{
  const admin = await connect(["admin"]);

  const rBadModel = await callTool(admin, "set_domain_model", { org, domain: "eng", modelId: "openai/gpt-6" });
  ok("a modelId outside the allow-list is REFUSED", rBadModel.isError);

  const rFinHigh = await callTool(admin, "set_domain_model", { org, domain: "finance", reasoning: "high" });
  ok("reasoning 'high' above finance's 'low' ceiling is REFUSED", rFinHigh.isError);
  const rEngHigh = await callTool(admin, "set_domain_model", { org, domain: "eng", reasoning: "high" });
  ok("reasoning 'high' at eng's raised 'high' ceiling is ACCEPTED", !rEngHigh.isError && rEngHigh.body.ok === true);

  const rEmpty = await callTool(admin, "set_domain_model", { org, domain: "eng" });
  ok("a pick with neither modelId nor reasoning is REFUSED", rEmpty.isError);

  const rNoDomain = await callTool(admin, "set_domain_model", { org, domain: "nope", modelId: "zai/glm-5.2" });
  ok("an unconfigured domain name is REFUSED", rNoDomain.isError);

  await admin.close();
}

{
  const admin = await connect(["admin"]);
  await callTool(admin, "set_domain_model", { org, domain: "eng", modelId: "deepseek/deepseek-v4-flash", reasoning: "low" });
  const row = await getOperationalStore().getDomainModel(org, "eng");
  ok("both components round-trip through the store", row?.modelId === "deepseek/deepseek-v4-flash" && row.reasoning === "low");

  const rClear = await callTool(admin, "clear_domain_model", { org, domain: "eng" });
  ok("clear_domain_model reports cleared=true when a pick existed", !rClear.isError && rClear.body.cleared === true);
  ok("the pick is gone after clear (reverts to the git route)", (await getOperationalStore().getDomainModel(org, "eng")) === null);
  const rAgain = await callTool(admin, "clear_domain_model", { org, domain: "eng" });
  ok("clearing an absent pick reports cleared=false (idempotent, not an error)", !rAgain.isError && rAgain.body.cleared === false);

  const audit = await readAudit({ org });
  ok("set_domain_model is audited", audit.some((e) => e.action === "admin.model.set_domain"));
  ok("clear_domain_model is audited", audit.some((e) => e.action === "admin.model.clear_domain"));

  await admin.close();
}

{
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domains,
    loadSilos: () => [],
    loadRoles: () => [],
    loadModelPolicy: () => undefined,
    domainsForSurface: () => [],
  });
  const admin = await connect(["admin"]);
  const r = await callTool(admin, "set_domain_model", { org, domain: "eng", modelId: "some/unlisted-model" });
  ok("with NO policy configured, any modelId is accepted (permissive envelope)", !r.isError && r.body.ok === true);
  await callTool(admin, "clear_domain_model", { org, domain: "eng" });
  await admin.close();
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domains,
    loadSilos: () => [],
    loadRoles: () => [],
    loadModelPolicy: () => POLICY,
    domainsForSurface: () => [],
  });
}

interface FakeCall {
  id: string;
  options: RoutedCallOptions;
}
function fakeModel(id: string, calls: FakeCall[]): RoutableModel {
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: id,
    supportedUrls: {},
    doGenerate: async (options: RoutedCallOptions) => {
      calls.push({ id, options });
      return { ok: true };
    },
    doStream: async (options: RoutedCallOptions) => {
      calls.push({ id, options });
      return { ok: true };
    },
  };
}
function deps(
  surfaceKey: string,
  calls: FakeCall[],
  opts: {
    pick?: (domainName: string) => Promise<{ modelId?: string; reasoning?: ModelReasoning } | null>;
    policy?: ModelPolicy;
  },
): RoutingDeps {
  const backend: ModelBackend = { model: (id) => fakeModel(id, calls), applyOptions: (_r, o) => o };
  return {
    surfaceKey: async () => surfaceKey,
    domains: () => domains,
    roles: () => [],
    modelPolicy: () => opts.policy,
    domainModelPick: opts.pick,
    backend,
  };
}
const turnCall: RoutedCallOptions = { prompt: [], reasoning: "medium" };

{
  const c: FakeCall[] = [];
  const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, deps(C_ENG, c, {
    policy: POLICY,
    pick: async () => ({ modelId: "deepseek/deepseek-v4-flash" }),
  }));
  await m.doGenerate(turnCall);
  ok("resolver: an in-envelope pick OVERRIDES the git route's model id", c[0].id === "deepseek/deepseek-v4-flash");
}

{
  const c: FakeCall[] = [];
  let seen: string | undefined;
  const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, deps(C_ENG, c, {
    policy: POLICY,
    pick: async (name) => {
      seen = name;
      return null;
    },
  }));
  await m.doGenerate(turnCall);
  ok("resolver: domainModelPick is called with the surface's resolved domain name", seen === "eng");
  ok("resolver: a null pick leaves the git route unchanged", c[0].id === DEFAULT_ID);
}

{
  const c: FakeCall[] = [];
  const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, deps(C_ENG, c, {
    policy: POLICY,
    pick: async () => ({ modelId: "openai/gpt-6" }),
  }));
  await m.doGenerate(turnCall);
  ok("resolver: an out-of-envelope pick is CLAMPED by the envelope (→ safe fallback, not gpt-6)", c[0].id === "deepseek/deepseek-v4-flash");
}

{
  const c: FakeCall[] = [];
  const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, deps(C_ENG, c, {
    policy: POLICY,
    pick: async () => ({ reasoning: "high" }),
  }));
  await m.doGenerate(turnCall);
  ok("resolver: a reasoning-only pick keeps the git model id", c[0].id === DEFAULT_ID);
  ok("resolver: a reasoning pick within the domain ceiling is applied", c[0].options.reasoning === "high");
}

{
  const c: FakeCall[] = [];
  const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, deps(C_FIN, c, {
    policy: POLICY,
    pick: async () => ({ reasoning: "high" }),
  }));
  await m.doGenerate(turnCall);
  ok("resolver: a reasoning pick above the domain ceiling is CLAMPED (high → low at finance)", c[0].options.reasoning === "low");
}

{
  const c: FakeCall[] = [];
  const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, deps(C_ENG, c, { policy: POLICY }));
  await m.doGenerate(turnCall);
  ok("resolver: no domainModelPick dep → the git route stands (fail-soft absent)", c[0].id === DEFAULT_ID);
}

{
  const c: FakeCall[] = [];
  const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, deps(C_ENG, c, {
    policy: POLICY,
    pick: async () => {
      throw new Error("store exploded");
    },
  }));
  await m.doGenerate(turnCall);
  ok("resolver: a throwing pick read → the git route stands, no throw (fail-soft)", c[0].id === DEFAULT_ID);
}

{
  const c: FakeCall[] = [];
  const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, deps(C_ENG, c, {
    pick: async () => ({ modelId: "some/unlisted-model" }),
  }));
  await m.doGenerate(turnCall);
  ok("resolver: with no policy, a pick's model id passes through unclamped", c[0].id === "some/unlisted-model");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ domain model self-serve: ${n} assertions passed (RBAC + SET-time envelope clamp + resolver slotting + fail-soft)\n`);

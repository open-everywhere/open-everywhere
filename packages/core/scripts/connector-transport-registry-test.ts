import assert from "node:assert/strict";

const {
  selectConnectorTransport,
  registerConnectorTransport,
  registeredConnectorTransports,
  resetConnectorTransports,
} = await import("../agent/connections/connector-transport.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const NOTION_URL = "https://mcp.notion.com/mcp";
const baseSpec = {
  connector: "notion",
  provider: "notion",
  directUrl: NOTION_URL,
  fallbackSecretRef: "NOTION_API_KEY",
  fallbackBroker: "env",
};

function setEnv(env: Record<string, string | undefined>): () => void {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

{
  {
    const restore = setEnv({ OE_CONNECTOR_USER_PRINCIPAL: undefined });
    resetConnectorTransports();
    const t = selectConnectorTransport(baseSpec);
    ok(t.url === NOTION_URL, "flags-off: direct-mcp keeps the vendor URL");
    ok(typeof t.auth === "function", "flags-off: an auth resolver is produced");
    restore();
  }

  {
    const restore = setEnv({ OE_CONNECTOR_USER_PRINCIPAL: "1" });
    resetConnectorTransports();
    const t = selectConnectorTransport(baseSpec);
    ok(t.url === NOTION_URL, "user-principal armed: direct-mcp still uses the vendor URL");
    restore();
  }
}

{
  resetConnectorTransports();
  registerConnectorTransport({
    name: "vaultx",
    priority: 500,
    isActive: () => true,
    resolve: (spec) => ({ url: `vaultx://${spec.connector}`, auth: (async () => ({ principalType: "app", async getToken() { return { token: "x" }; } })) as never }),
  });
  const t = selectConnectorTransport(baseSpec);
  ok(t.url === "vaultx://notion", "custom 'vaultx' transport wins by priority with no selectConnectorTransport edit");
  ok(registeredConnectorTransports().some((x) => x.name === "vaultx"), "custom transport is registered");
}

{
  resetConnectorTransports();
  const names = registeredConnectorTransports().map((t) => t.name).sort();
  ok(names.length === 1 && names[0] === "direct-mcp", "reset restores exactly { direct-mcp }");
}

console.log(`✓ connector-transport-registry: ${n} assertions passed`);

import assert from "node:assert/strict";

const {
  selectConnectorTransport,
  registerConnectorTransport,
  registeredConnectorTransports,
  resetConnectorTransports,
} = await import("../agent/connections/connector-transport.js");
const { registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");

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

{
  resetSettingsForTest();
  resetConnectorTransports();
  {
    const t = selectConnectorTransport(baseSpec);
    ok(t.url === NOTION_URL, "direct-mcp resolves the vendor URL");
    ok(typeof t.auth === "function", "direct-mcp produces an auth resolver");
  }

  {
    let reads = 0;
    registerSettings({
      connectors: {
        get userPrincipal(): boolean {
          reads++;
          return true;
        },
        opTiering: true,
      },
    });
    const afterRegistration = reads;
    resetConnectorTransports();
    const t = selectConnectorTransport(baseSpec);
    ok(reads === afterRegistration, "selection performs NO settings read — the flag is deferred (OPE-1450)");
    await Promise.resolve(t.auth({ session: { auth: undefined } } as never)).catch(() => undefined);
    ok(reads > afterRegistration, "negative control: the auth CALL does read the flag — deferred, not dropped");
    resetSettingsForTest();
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

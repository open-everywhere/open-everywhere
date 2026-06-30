import notion from "../agent/connections/notion.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

ok(typeof notion.url === "string" && notion.url.startsWith("https://"), "notion connection declares an https MCP url");
ok(typeof notion.description === "string" && notion.description.length > 0, "notion connection has a model-facing description");
ok(typeof notion.approval === "function", "notion connection carries an approval gate (the live hard lever while per-surface scoping is an Eve gap)");

const auth = notion.auth;
ok(!!auth && (auth.principalType === "app" || auth.principalType === undefined), "auth is app-principal (defaults to app) — the service universe");
ok(!!auth && typeof (auth as { getToken?: unknown }).getToken === "function", "app-principal auth is the non-interactive getToken form");
ok(!!auth && (auth as { startAuthorization?: unknown }).startAuthorization === undefined, "no interactive OAuth methods on the app-principal form (both-or-neither)");

const getToken = (auth as { getToken: (o: unknown) => Promise<{ token: string }> }).getToken;
const principal = { principal: { type: "app" as const }, connection: { url: notion.url } };

{
  const prev = process.env.NOTION_API_KEY;
  process.env.NOTION_API_KEY = "secret_test_token";
  let threw = false;
  let msg = "";
  try {
    await getToken(principal);
  } catch (err) {
    threw = true;
    msg = String(err);
  }
  ok(threw, "getToken refuses outside a granted surface even with the secret set (gate runs first, fail closed)");
  ok(
    msg.includes("could not resolve the calling surface") || msg.includes("not granted"),
    "refusal is the connector scope gate, not a missing-secret error",
  );
  if (prev === undefined) delete process.env.NOTION_API_KEY;
  else process.env.NOTION_API_KEY = prev;
}

{
  const { resolveHeaders, selectBroker, registerBroker, resetBrokers } = await import(
    "../agent/access/credentials.js"
  );
  const { CredentialError } = await import("../agent/access/credentials.js");

  const savedBroker = process.env.OE_CREDENTIAL_BROKER;
  const savedVercel = process.env.VERCEL;

  process.env.OE_CREDENTIAL_BROKER = "env";
  ok(typeof selectBroker().getSecret === "function", "OE_CREDENTIAL_BROKER=env selects a broker");

  resetBrokers();
  delete process.env.OE_CREDENTIAL_BROKER;
  delete process.env.VERCEL;
  const envSel = selectBroker();
  ok(typeof envSel.getSecret === "function", "off Vercel, selectBroker picks the core env adapter");

  process.env.VERCEL = "1";
  let failedClosed = false;
  try {
    selectBroker();
  } catch {
    failedClosed = true;
  }
  ok(failedClosed, "auto-on-Vercel with vercel-connect unregistered fails closed (no env fallback)");

  const sentinel = { async getSecret() { return "sentinel"; } };
  registerBroker("vercel-connect", sentinel);
  ok(selectBroker() === sentinel, "auto-on-Vercel selects the registered vercel-connect broker");
  delete process.env.VERCEL;
  ok(selectBroker() === envSel, "auto-off-Vercel still selects the env adapter even with vercel-connect registered");
  resetBrokers();
  if (savedVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = savedVercel;

  process.env.OE_CREDENTIAL_BROKER = "env";

  process.env.DD_API_KEY = "api123";
  process.env.DD_APP_KEY = "app456";
  const h = await resolveHeaders({
    id: "datadog",
    credentialType: "bearer",
    secretRef: "DD_API_KEY",
    allowedWebsites: ["api.datadoghq.com"],
    customHeaders: [
      { name: "DD-API-KEY", secretRef: "DD_API_KEY" },
      { name: "DD-APPLICATION-KEY", prefix: "", secretRef: "DD_APP_KEY" },
    ],
  });
  ok(h.authorization === "Bearer api123", "bearer stamps Authorization from secretRef via the broker");
  ok(h["DD-API-KEY"] === "api123" && h["DD-APPLICATION-KEY"] === "app456", "secret-valued custom headers resolve from their secretRefs");

  process.env.OKTA_TOKEN = "tok";
  const hp = await resolveHeaders({
    id: "okta",
    credentialType: "bearer",
    secretRef: "OKTA_TOKEN",
    allowedWebsites: ["x.okta.com"],
    customHeaders: [{ name: "Authorization", prefix: "SSWS ", secretRef: "OKTA_TOKEN" }],
  });
  ok(hp["Authorization"] === "SSWS tok", "custom-header prefix is applied literally before the secret");

  let threw = false;
  try {
    await resolveHeaders({ id: "x", credentialType: "bearer", secretRef: "MISSING_KEY", allowedWebsites: ["x"] });
  } catch (e) {
    threw = e instanceof CredentialError;
  }
  ok(threw, "missing secret throws CredentialError (fail closed)");

  delete process.env.DD_API_KEY;
  delete process.env.DD_APP_KEY;
  delete process.env.OKTA_TOKEN;
  if (savedBroker === undefined) delete process.env.OE_CREDENTIAL_BROKER;
  else process.env.OE_CREDENTIAL_BROKER = savedBroker;
}

console.log(`✓ connections: ${passed} assertions passed`);

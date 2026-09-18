import notion from "../agent/connections/notion.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("connections");

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
ok(typeof notion.approval === "function", "notion connection carries a bare approval POLICY — the only shape eve's connection resolver keeps");
ok(typeof (notion.approval as { response?: unknown }).response !== "function", "…and carries no response half — a shape eve would drop");

ok(typeof notion.auth === "function", "notion auth is the resolver form (a function of SessionContext), not a static provider");
const noAuthCtx = { session: { id: "s", auth: { current: null, initiator: null }, turn: { index: 0 } } };
const auth = await (notion.auth as (ctx: unknown) => Promise<unknown> | unknown)(noAuthCtx);

const authPrincipal = (auth as { principalType?: unknown }).principalType;
ok(!!auth && (authPrincipal === "app" || authPrincipal === undefined), "auth is app-principal (defaults to app) — the service universe");
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
  const { resolveHeaders, registeredBrokerNames, brokerFor, registerBroker, resetBrokers, getSecretVia } = await import(
    "../agent/access/credentials.js"
  );
  const { CredentialError } = await import("../agent/access/credentials.js");

  resetBrokers();
  ok(registeredBrokerNames().includes("env"), "the core env adapter is always registered (the floor)");
  ok(typeof brokerFor("env").getSecret === "function", "brokerFor('env') resolves the registered env adapter");

  let failedClosed = false;
  try {
    brokerFor("acme-vault");
  } catch (e) {
    failedClosed = e instanceof CredentialError;
  }
  ok(failedClosed, "brokerFor('acme-vault') fails closed when the adapter isn't registered (no fallback)");

  const sentinel = { async getSecret() { return "sentinel"; } };
  registerBroker("acme-vault", sentinel);
  ok(brokerFor("acme-vault") === sentinel, "a registered vendor broker resolves by its name");
  resetBrokers();

  let noDefault = false;
  try {
    await getSecretVia(undefined, "ANY_REF");
  } catch (e) {
    noDefault = e instanceof CredentialError && /no credential broker/.test((e as Error).message);
  }
  ok(noDefault, "getSecretVia(undefined, ...) rejects — there is no selected default (fail closed)");

  {
    const seenArgs: unknown[][] = [];
    registerBroker("captor", {
      async getSecret(...args: unknown[]) {
        seenArgs.push(args);
        return "secret";
      },
    });

    await resolveHeaders({ id: "plain", credentialType: "bearer", secretRef: "REF", broker: "captor", allowedWebsites: ["x"] });
    ok(seenArgs.at(-1)?.[1] === undefined, "no authorizationDetails declared -> broker's getSecret gets undefined (unchanged behaviour)");

    const details = [{ type: "github_app_installation", repositories: ["acme/web"] }];
    await resolveHeaders({
      id: "scoped",
      credentialType: "bearer",
      secretRef: "REF",
      broker: "captor",
      allowedWebsites: ["x"],
      authorizationDetails: details,
    });
    ok(seenArgs.at(-1)?.[1] === details, "declared authorizationDetails forwards verbatim (same reference) to the broker's getSecret");

    resetBrokers();
  }

  process.env.DD_API_KEY = "api123";
  process.env.DD_APP_KEY = "app456";
  const h = await resolveHeaders({
    id: "datadog",
    credentialType: "bearer",
    secretRef: "DD_API_KEY",
    broker: "env",
    allowedWebsites: ["api.datadoghq.com"],
    customHeaders: [
      { name: "DD-API-KEY", secretRef: "DD_API_KEY" },
      { name: "DD-APPLICATION-KEY", prefix: "", secretRef: "DD_APP_KEY" },
    ],
  });
  ok(h.authorization === "Bearer api123", "bearer stamps Authorization from secretRef via the connection's home broker");
  ok(h["DD-API-KEY"] === "api123" && h["DD-APPLICATION-KEY"] === "app456", "secret-valued custom headers resolve from their secretRefs (same broker)");

  process.env.OKTA_TOKEN = "tok";
  const hp = await resolveHeaders({
    id: "okta",
    credentialType: "bearer",
    secretRef: "OKTA_TOKEN",
    broker: "env",
    allowedWebsites: ["x.okta.com"],
    customHeaders: [{ name: "Authorization", prefix: "SSWS ", secretRef: "OKTA_TOKEN" }],
  });
  ok(hp["Authorization"] === "SSWS tok", "custom-header prefix is applied literally before the secret");

  let threw = false;
  try {
    await resolveHeaders({ id: "x", credentialType: "bearer", secretRef: "MISSING_KEY", broker: "env", allowedWebsites: ["x"] });
  } catch (e) {
    threw = e instanceof CredentialError;
  }
  ok(threw, "missing secret throws CredentialError (fail closed)");

  let unstampedClosed = false;
  try {
    await resolveHeaders({ id: "u", credentialType: "bearer", secretRef: "DD_API_KEY", allowedWebsites: ["x"] });
  } catch (e) {
    unstampedClosed = e instanceof CredentialError && /no credential broker/.test((e as Error).message);
  }
  ok(unstampedClosed, "an unstamped connection fails closed at resolveHeaders — there is no default broker");

  delete process.env.DD_API_KEY;
  delete process.env.DD_APP_KEY;
  delete process.env.OKTA_TOKEN;
}

console.log(`✓ connections: ${passed} assertions passed`);

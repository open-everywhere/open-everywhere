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
  delete process.env.NOTION_API_KEY;
  let threw = false;
  try {
    await getToken(principal);
  } catch (err) {
    threw = true;
    ok(String(err).includes("NOTION_API_KEY"), "missing-secret error names the env var to set");
  }
  ok(threw, "getToken throws when NOTION_API_KEY is unset (fail closed)");
  if (prev !== undefined) process.env.NOTION_API_KEY = prev;
}

{
  const prev = process.env.NOTION_API_KEY;
  process.env.NOTION_API_KEY = "secret_test_token";
  const res = await getToken(principal);
  ok(res.token === "secret_test_token", "getToken returns the provisioned token for Authorization: Bearer");
  if (prev === undefined) delete process.env.NOTION_API_KEY;
  else process.env.NOTION_API_KEY = prev;
}

console.log(`✓ connections: ${passed} assertions passed`);

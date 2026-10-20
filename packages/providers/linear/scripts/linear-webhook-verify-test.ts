import { signLinearWebhookBody } from "eve/channels/linear";
import { LINEAR_MAX_SKEW_MS, linearWebhookSecretForOrg, verifyLinearWebhookDelivery } from "../agent/channels/linear-webhook-verify.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const NOW = 1_760_000_000_000;
const PRIMARY_ORG = "org-primary";
const SOAK_ORG = "org-soak";

function body(organizationId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ action: "create", type: "Comment", organizationId, webhookTimestamp: NOW, ...extra });
}

function headers(signature: string): Headers {
  return new Headers({ "linear-signature": signature });
}

function verify(raw: string, secretUsedToSign: string, env: NodeJS.ProcessEnv, nowMs = NOW): boolean {
  return verifyLinearWebhookDelivery(headers(signLinearWebhookBody(raw, secretUsedToSign)), raw, { primarySecret: env.LINEAR_WEBHOOK_SECRET, env, nowMs });
}

const PRIMARY_ONLY: NodeJS.ProcessEnv = { LINEAR_WEBHOOK_SECRET: "primary-secret" };
const TWO_APPS: NodeJS.ProcessEnv = {
  LINEAR_WEBHOOK_SECRET: "primary-secret",
  LINEAR_ORGANIZATION_ID: PRIMARY_ORG,
  LINEAR_APP_SOAK_ORG_ID: SOAK_ORG,
  LINEAR_APP_SOAK_CLIENT_ID: "soak-client",
  LINEAR_APP_SOAK_CLIENT_SECRET: "soak-client-secret",
  LINEAR_APP_SOAK_WEBHOOK_SECRET: "soak-secret",
};

{
  ok(linearWebhookSecretForOrg(PRIMARY_ORG, TWO_APPS.LINEAR_WEBHOOK_SECRET, TWO_APPS) === "primary-secret", "selection: the declared primary organization gets LINEAR_WEBHOOK_SECRET");
  ok(linearWebhookSecretForOrg(SOAK_ORG, TWO_APPS.LINEAR_WEBHOOK_SECRET, TWO_APPS) === "soak-secret", "selection: a registered organization gets ITS OWN app's webhook secret");
  ok(linearWebhookSecretForOrg("org-stranger", TWO_APPS.LINEAR_WEBHOOK_SECRET, TWO_APPS) === undefined, "selection: an unknown organization gets NO secret once the primary organization is declared (fail closed)");
  ok(linearWebhookSecretForOrg(undefined, TWO_APPS.LINEAR_WEBHOOK_SECRET, TWO_APPS) === "primary-secret", "selection: a delivery naming no organization falls to the primary secret");
}

{
  const noSecret: NodeJS.ProcessEnv = { ...TWO_APPS };
  delete noSecret.LINEAR_APP_SOAK_WEBHOOK_SECRET;
  ok(linearWebhookSecretForOrg(SOAK_ORG, noSecret.LINEAR_WEBHOOK_SECRET, noSecret) === undefined, "selection: a registered app with no webhook secret gets NO secret — never the primary's");
  ok(verify(body(SOAK_ORG), "primary-secret", noSecret) === false, "selection: and its delivery is REFUSED even when signed with the primary secret");
}

{
  const raw = body(PRIMARY_ORG);
  ok(verify(raw, "primary-secret", PRIMARY_ONLY) === true, "primary-only: the right secret VERIFIES");
  ok(verify(raw, "wrong-secret", PRIMARY_ONLY) === false, "primary-only: a wrong secret is REFUSED");
  ok(verify(body("some-org-we-never-configured"), "primary-secret", PRIMARY_ONLY) === true, "primary-only: with no declared primary organization, ANY organization verifies against LINEAR_WEBHOOK_SECRET");
  ok(verify(body("some-org-we-never-configured"), "wrong-secret", PRIMARY_ONLY) === false, "primary-only: …and a wrong secret is still refused there");
}

{
  const primaryBody = body(PRIMARY_ORG);
  const soakBody = body(SOAK_ORG);
  ok(verify(primaryBody, "primary-secret", TWO_APPS) === true, "two apps: a PRIMARY delivery signed with the primary secret verifies");
  ok(verify(soakBody, "soak-secret", TWO_APPS) === true, "two apps: a SOAK delivery signed with the SOAK secret verifies");

  ok(verify(primaryBody, "soak-secret", TWO_APPS) === false, "two apps: a PRIMARY delivery signed with the SOAK secret is REFUSED (no try-both loop)");
  ok(verify(soakBody, "primary-secret", TWO_APPS) === false, "two apps: a SOAK delivery signed with the PRIMARY secret is REFUSED (no try-both loop)");

  ok(verify(body("org-stranger"), "primary-secret", TWO_APPS) === false, "two apps: an UNKNOWN organization is refused even under the primary secret (fail closed)");
  ok(verify(body("org-stranger"), "soak-secret", TWO_APPS) === false, "two apps: an UNKNOWN organization is refused under the SOAK secret too");
}

{
  const raw = body(PRIMARY_ORG);
  const sig = signLinearWebhookBody(raw, "primary-secret");
  ok(verifyLinearWebhookDelivery(new Headers(), raw, { primarySecret: PRIMARY_ONLY.LINEAR_WEBHOOK_SECRET, env: PRIMARY_ONLY, nowMs: NOW }) === false, "no Linear-Signature header ⇒ REFUSED");
  ok(verifyLinearWebhookDelivery(headers(sig), raw, { env: {}, nowMs: NOW }) === false, "no webhook secret configured at all ⇒ REFUSED (never verifies against an empty secret)");
  ok(verifyLinearWebhookDelivery(headers(sig), "not json at all", { primarySecret: PRIMARY_ONLY.LINEAR_WEBHOOK_SECRET, env: PRIMARY_ONLY, nowMs: NOW }) === false, "a non-JSON body ⇒ REFUSED (it carries no organization to key on)");
  ok(verifyLinearWebhookDelivery(headers(sig), `${raw} `, { primarySecret: PRIMARY_ONLY.LINEAR_WEBHOOK_SECRET, env: PRIMARY_ONLY, nowMs: NOW }) === false, "one trailing byte changes the body ⇒ the signature no longer matches ⇒ REFUSED");
  ok(verifyLinearWebhookDelivery(headers(sig.slice(0, -2)), raw, { primarySecret: PRIMARY_ONLY.LINEAR_WEBHOOK_SECRET, env: PRIMARY_ONLY, nowMs: NOW }) === false, "a truncated signature ⇒ REFUSED (unequal lengths never compare equal)");

  ok(verifyLinearWebhookDelivery(headers(sig), raw, { primarySecret: PRIMARY_ONLY.LINEAR_WEBHOOK_SECRET, env: PRIMARY_ONLY, nowMs: NOW + LINEAR_MAX_SKEW_MS - 1000 }) === true, "replay window: a delivery inside the window verifies");
  ok(verifyLinearWebhookDelivery(headers(sig), raw, { primarySecret: PRIMARY_ONLY.LINEAR_WEBHOOK_SECRET, env: PRIMARY_ONLY, nowMs: NOW + LINEAR_MAX_SKEW_MS + 1000 }) === false, "replay window: a delivery PAST the window is REFUSED even with a valid signature");
  ok(verifyLinearWebhookDelivery(headers(sig), raw, { primarySecret: PRIMARY_ONLY.LINEAR_WEBHOOK_SECRET, env: PRIMARY_ONLY, nowMs: NOW - LINEAR_MAX_SKEW_MS - 1000 }) === false, "replay window: a delivery from the FUTURE is refused too (the window is two-sided)");

  const noTs = JSON.stringify({ action: "create", type: "Comment", organizationId: PRIMARY_ORG });
  ok(verifyLinearWebhookDelivery(headers(signLinearWebhookBody(noTs, "primary-secret")), noTs, { primarySecret: PRIMARY_ONLY.LINEAR_WEBHOOK_SECRET, env: PRIMARY_ONLY, nowMs: NOW }) === false, "replay window: a body with NO webhookTimestamp is refused (eve refuses it too)");
}

{
  const reaction = JSON.stringify({ action: "create", type: "Reaction", organizationId: SOAK_ORG, webhookTimestamp: NOW, data: { emoji: "eyes" } });
  ok(verify(reaction, "soak-secret", TWO_APPS) === true, "event kinds: a Reaction delivery from a registered workspace verifies like any other");
  ok(verify(reaction, "primary-secret", TWO_APPS) === false, "event kinds: …and is still refused under the wrong workspace's secret");
}

{
  process.env.LINEAR_APP_SOAK_ORG_ID = SOAK_ORG;
  process.env.LINEAR_APP_SOAK_CLIENT_ID = "soak-client";
  process.env.LINEAR_APP_SOAK_CLIENT_SECRET = "soak-client-secret";
  process.env.LINEAR_APP_SOAK_WEBHOOK_SECRET = "soak-secret";
  delete process.env.LINEAR_WEBHOOK_SECRET;

  const channel = (await import("../agent/channels/linear.js")).default;
  const route = channel.routes.find((r) => r.transport !== "websocket" && r.method === "POST" && r.path === "/eve/v1/linear");
  ok(route !== undefined, "reachability: the provider exposes the POST /eve/v1/linear route");

  const raw = JSON.stringify({
    action: "create",
    type: "Reaction",
    organizationId: SOAK_ORG,
    webhookTimestamp: Date.now(),
    data: { emoji: "eyes" },
  });
  const call = async (signature: string): Promise<number> => {
    const req = new Request("https://example.invalid/eve/v1/linear", { method: "POST", headers: { "linear-signature": signature, "content-type": "application/json" }, body: raw });
    const res = await (route as { handler: (r: Request, a: unknown) => Promise<Response> }).handler(req, {
      from: () => ({ send: async () => undefined }),
      waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => undefined),
      to: undefined,
    });
    return res.status;
  };

  const accepted = await call(signLinearWebhookBody(raw, "soak-secret"));
  ok(accepted < 400, `reachability: a SOAK-signed delivery is ACCEPTED (status ${accepted}) with LINEAR_WEBHOOK_SECRET unset — only our org-aware verifier can do that`);
  const refused = await call(signLinearWebhookBody(raw, "some-other-secret"));
  ok(refused === 401, `reachability: the SAME delivery signed with a wrong secret is refused 401 (got ${refused}) — the route is not simply accepting everything`);
}

console.log(`\n✓ linear-webhook-verify: ${passed} assertions passed`);

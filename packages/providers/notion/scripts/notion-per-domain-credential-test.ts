import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  defineDomain,
  OperatorSecretNotSetError,
  registerBroker,
  registerConfig,
  resetBrokers,
  resetRegisteredProviders,
  setRegisteredProviders,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";
import {
  NOTION_CHANNEL_CREDENTIAL,
  notionCallerCredential,
  notionChannelCredentialFor,
  notionChannelCredentialForSurface,
  notionIntegrations,
  resolveNotionInboundSecret,
} from "../agent/channels/notion-credentials.js";
import { gateNotionDeliveryAcross, resolveNotionApiKey, type FetchLike } from "../agent/channels/notion-api.js";
import { handleNotionDelivery } from "../agent/channels/notion-webhook.js";
import { notionPostArm } from "../agent/channels/notion-post-arm.js";
import { registerNotionProvider } from "../agent/register.js";

registerNotionProvider();

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const WS = "11111111-2222-4333-8444-555555555555";
const PAGE_PAY = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PAGE_SUP = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PAGE_LOOSE = "cccccccc-3333-4333-8333-cccccccccccc";
const PAY_CRED = "payments-channel-key";

const DOMAINS: readonly Domain[] = [
  defineDomain({
    name: "payments",
    channels: [`notion/${WS}/${PAGE_PAY}`],
    ambientSupervisor: true,
    credentials: [{ provider: "notion", credential: NOTION_CHANNEL_CREDENTIAL, use: PAY_CRED, inboundSecret: "NOTION_WEBHOOK_SECRET_PAYMENTS" }],
  }),
  defineDomain({ name: "support", channels: [`notion/${WS}/${PAGE_SUP}`], ambientSupervisor: true }),
];

{
  ok(notionChannelCredentialFor(WS, PAGE_PAY, DOMAINS) === PAY_CRED, "a page in a BOUND domain resolves that domain's credential");
  ok(notionChannelCredentialFor(WS, PAGE_SUP, DOMAINS) === undefined, "a page in an UNBOUND domain resolves NO override ⇒ the org default");
  ok(notionChannelCredentialFor(WS, PAGE_LOOSE, DOMAINS) === undefined, "a page in NO domain resolves no override ⇒ the org default");
  ok(notionChannelCredentialFor(WS, undefined, DOMAINS) === undefined, "no page id ⇒ no override");
  ok(notionChannelCredentialFor(WS, PAGE_PAY.replace(/-/g, ""), DOMAINS) === PAY_CRED, "a bare (unhyphenated) page id resolves the same binding");

  ok(notionChannelCredentialForSurface(`notion/${WS}/${PAGE_PAY}`, DOMAINS) === PAY_CRED, "the surface-key form resolves the binding");
  ok(notionChannelCredentialForSurface(`slack/T1/C1`, DOMAINS) === undefined, "a non-Notion surface key resolves nothing");
  ok(notionChannelCredentialForSurface("notion/unknown/unknown", DOMAINS) === undefined, "an under-identified surface resolves nothing ⇒ the org default");

  const ctxFor = (page: string): BindableContext =>
    ({
      channel: { kind: "notion" },
      session: { auth: { current: { attributes: { workspace_id: WS, page_id: page }, principalId: "U_NOTION", principalType: "notion-user" } } },
    }) as BindableContext;
  ok(notionCallerCredential(ctxFor(PAGE_PAY), DOMAINS) === PAY_CRED, "the READ TOOLS' caller-surface form resolves the bound domain's credential");
  ok(notionCallerCredential(ctxFor(PAGE_SUP), DOMAINS) === undefined, "…and an unbound caller resolves the org default");

  const registry = notionIntegrations(DOMAINS);
  ok(registry.length === 2 && registry[0]!.credentialId === NOTION_CHANNEL_CREDENTIAL, "the ingress registry carries the org default FIRST");
  ok(registry[1]!.credentialId === PAY_CRED && registry[1]!.inboundSecret === "NOTION_WEBHOOK_SECRET_PAYMENTS", "…then the bound domain's own integration");
}

const ORG_TOKEN = "ntn_org_token";
const PAY_TOKEN = "ntn_payments_token";
{
  resetBrokers();
  registerBroker("test", {
    async getSecret(ref) {
      if (ref === "db:notion:channel-key") return ORG_TOKEN;
      if (ref === "db:notion:payments-channel-key") return PAY_TOKEN;
      throw new Error(`no secret for ${ref}`);
    },
  });
  setRegisteredProviders([
    {
      name: "notion",
      connection: "notion",
      allows: ["api-key"],
      credentials: [
        { id: NOTION_CHANNEL_CREDENTIAL, type: "api-key", secretRef: "db:notion:channel-key", broker: "test", intake: false },
        { id: PAY_CRED, type: "api-key", secretRef: "db:notion:payments-channel-key", broker: "test", intake: false },
      ],
    },
  ]);

  ok((await resolveNotionApiKey()) === ORG_TOKEN, "the default argument still resolves the ORG credential (byte-identical for every existing call site)");
  ok((await resolveNotionApiKey(NOTION_CHANNEL_CREDENTIAL)) === ORG_TOKEN, "naming the org credential resolves the org token");
  ok((await resolveNotionApiKey(PAY_CRED)) === PAY_TOKEN, "naming a SECOND credential resolves a DIFFERENT token — the whole point");
  ok((await resolveNotionApiKey("no-such-credential")) === undefined, "🔴 a NAMED-BUT-MISSING credential fails CLOSED (undefined) — it never retries under the org default");
}

const ORG_SECRET = "org-verification-token";
const PAY_SECRET = "payments-verification-token";
const sign = (secret: string, body: string): string => "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
const commentEvent = (page: string, commentId = "cmt-1"): string =>
  JSON.stringify({ type: "comment.created", workspace_id: WS, entity: { id: commentId, type: "comment" }, data: { page_id: page } });
{
  const body = commentEvent(PAGE_PAY);
  const paySig = sign(PAY_SECRET, body);
  const orgOnly = [{ credentialId: NOTION_CHANNEL_CREDENTIAL, secret: ORG_SECRET }];
  const both = [...orgOnly, { credentialId: PAY_CRED, secret: PAY_SECRET }];

  const single = gateNotionDeliveryAcross(orgOnly, body, paySig, false);
  ok(single.rejection === "invalid signature" && single.verified === false, "a SECOND integration's delivery does NOT verify against the org secret alone");

  const multi = gateNotionDeliveryAcross(both, body, paySig, false);
  ok(multi.rejection === null && multi.verified === true, "…and DOES verify once its own integration is registered");
  ok(multi.credentialId === PAY_CRED, "the secret that verified NAMES the sending integration (a proof, never an inference from the payload)");

  const orgDelivery = gateNotionDeliveryAcross(both, body, sign(ORG_SECRET, body), false);
  ok(orgDelivery.credentialId === NOTION_CHANNEL_CREDENTIAL, "a delivery signed by the ORG integration still names the org credential");

  const forged = gateNotionDeliveryAcross(both, body, sign("not-a-real-secret", body), false);
  ok(forged.rejection === "invalid signature" && forged.verified === false, "an unknown signer is refused by EVERY registered integration (fail closed)");

  const noSecrets = gateNotionDeliveryAcross([{ credentialId: NOTION_CHANNEL_CREDENTIAL, secret: undefined }], body, paySig, false);
  ok(noSecrets.rejection !== null && noSecrets.verified === false, "no secret configured anywhere ⇒ rejected");

  const hatch = gateNotionDeliveryAcross([{ credentialId: NOTION_CHANNEL_CREDENTIAL, secret: undefined }], body, null, true);
  ok(hatch.rejection === null && hatch.verified === false, "🔴 the dev hatch ACCEPTS but is never `verified` — an unsigned delivery must not reach the routing plane");
}

interface Seen {
  readonly url: string;
  readonly auth: string | undefined;
}
function recordingFetch(seen: Seen[]): FetchLike {
  return async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, auth: headers.authorization });
    if (url.includes("/v1/comments/")) {
      return new Response(
        JSON.stringify({
          id: "cmt-1",
          discussion_id: "disc-1",
          created_by: { id: "U_HUMAN", object: "user", type: "person" },
          created_time: "2026-08-13T10:00:00.000Z",
          rich_text: [{ type: "text", plain_text: "what is the balance flow here?" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function deliverFor(
  page: string,
  secret: string | null,
): Promise<{ seen: Seen[]; action: string; used?: string; dispatched?: string; attributes?: Record<string, string> }> {
  const seen: Seen[] = [];
  let dispatched: string | undefined;
  let attributes: Record<string, string> | undefined;
  const body = commentEvent(page);
  const out = await handleNotionDelivery(body, secret === null ? null : sign(secret, body), {
    signingKeys:
      secret === null
        ? [{ credentialId: NOTION_CHANNEL_CREDENTIAL, secret: undefined }]
        : [
            { credentialId: NOTION_CHANNEL_CREDENTIAL, secret: ORG_SECRET },
            { credentialId: PAY_CRED, secret: PAY_SECRET },
          ],
    allowUnverified: secret === null,
    apiKeyFor: (id) => resolveNotionApiKey(id),
    credentialForPage: (workspaceId, pageId) => notionChannelCredentialFor(workspaceId, pageId, DOMAINS),
    resolveBotUserId: async () => "U_BOT",
    ambientEnabled: () => true,
    fetch: recordingFetch(seen),
    dispatch: async (d) => {
      dispatched = d.credentialId;
      attributes = { ...d.auth.attributes };
    },
  });
  return {
    seen,
    action: out.action,
    ...(out.credentialId ? { used: out.credentialId } : {}),
    ...(dispatched ? { dispatched } : {}),
    ...(attributes ? { attributes } : {}),
  };
}

{
  const boundRun = await deliverFor(PAGE_PAY, PAY_SECRET);
  ok(boundRun.action === "dispatched", "a signed comment on a BOUND page dispatches");
  ok(boundRun.used === PAY_CRED, "the outcome reports the bound domain's credential");
  ok(boundRun.seen.length > 0 && boundRun.seen.every((s) => s.auth === `Bearer ${PAY_TOKEN}`), "🔴 EVERY host-side REST call ran under the BOUND DOMAIN's token");
  ok(boundRun.seen.every((s) => s.auth !== `Bearer ${ORG_TOKEN}`), "…and none of them touched the org token (negative control)");
  ok(boundRun.dispatched === PAY_CRED, "the DISPATCH carries the selected credential, so the route cannot re-derive a different one");

  const unboundRun = await deliverFor(PAGE_SUP, ORG_SECRET);
  ok(unboundRun.action === "dispatched", "a signed comment on an UNBOUND page dispatches too");
  ok(unboundRun.used === NOTION_CHANNEL_CREDENTIAL, "…under the ORG credential, whose secret signed it (an unbound domain adds nothing to overrule)");
  ok(unboundRun.seen.length > 0 && unboundRun.seen.every((s) => s.auth === `Bearer ${ORG_TOKEN}`), "…and every call ran under the org token");
  ok(unboundRun.dispatched === NOTION_CHANNEL_CREDENTIAL, "…and the dispatch carries the org default (negative control on the same field)");

  const looseRun = await deliverFor(PAGE_LOOSE, PAY_SECRET);
  ok(looseRun.used === PAY_CRED, "a page in NO domain runs under the integration whose secret VERIFIED the delivery");
  ok(looseRun.seen.every((s) => s.auth === `Bearer ${PAY_TOKEN}`), "…proven on the wire, not just reported");

  const forgedBody = await deliverFor(PAGE_PAY, ORG_SECRET);
  ok(forgedBody.used === NOTION_CHANNEL_CREDENTIAL, "🔴 a delivery VERIFIED by the org integration runs under the ORG credential even when the body names a BOUND page");
  ok(forgedBody.seen.length > 0 && forgedBody.seen.every((s) => s.auth === `Bearer ${ORG_TOKEN}`), "…proven on the wire: no REST call reached the payments token (negative control)");
  ok(forgedBody.dispatched === NOTION_CHANNEL_CREDENTIAL, "…and the DISPATCH carries the org credential, so the reply cannot be steered onto payments either");

  ok(boundRun.used === PAY_CRED && forgedBody.used === NOTION_CHANNEL_CREDENTIAL, "the SAME page resolves DIFFERENT credentials on the two subscriptions — the sender decides, not the body");

  const hatched = await deliverFor(PAGE_PAY, null);
  ok(hatched.used === PAY_CRED, "with NO integration identified (the unverified dev hatch) the page's domain binding still decides");
  ok(hatched.seen.length > 0 && hatched.seen.every((s) => s.auth === `Bearer ${PAY_TOKEN}`), "…and the hatch's two-step really ran under the bound token");
}

{
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => DOMAINS,
    loadSilos: () => [],
    domainsForSurface: () => [],
  });

  const realFetch = globalThis.fetch;
  const posted: Seen[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    posted.push({ url: String(url), auth: headers.authorization });
    return new Response(JSON.stringify({ id: "cmt-reply" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  try {
    await notionPostArm.dispatchReply!({ platform: "notion", discussionId: "disc-1", pageId: PAGE_PAY, workspaceId: WS }, "here is the balance flow");
    ok(posted.at(-1)?.auth === `Bearer ${PAY_TOKEN}`, "🔴 a reply on a BOUND page POSTS under that domain's token");

    await notionPostArm.dispatchReply!({ platform: "notion", discussionId: "disc-2", pageId: PAGE_SUP, workspaceId: WS }, "and here is the support answer");
    ok(posted.at(-1)?.auth === `Bearer ${ORG_TOKEN}`, "…and a reply on an UNBOUND page posts under the ORG DEFAULT (negative control)");

    await notionPostArm.dispatchUnified!({ platform: "notion", discussionId: "disc-3", pageId: PAGE_PAY, workspaceId: WS }, "unified reply", {});
    ok(posted.at(-1)?.auth === `Bearer ${PAY_TOKEN}`, "the UNIFIED reply arm takes the same rule");

    const half = await deliverFor(PAGE_LOOSE, PAY_SECRET);
    ok(half.used === PAY_CRED, "half-configured page: the delivery fetched under the PAYMENTS integration (the one that verified it)");
    const carried = half.attributes?.credential_id;
    ok(carried === PAY_CRED, "half-configured page: the delivery STOWS its credential on the auth attributes, so the reply can read it");

    await notionPostArm.dispatchReply!({ platform: "notion", discussionId: "disc-half", pageId: PAGE_LOOSE, workspaceId: WS, credentialId: carried }, "the same credential answers");
    ok(posted.at(-1)?.auth === `Bearer ${PAY_TOKEN}`, "🔴 half-configured page: the reply POSTS under the credential that FETCHED — one sentence for both directions");

    await notionPostArm.dispatchReply!({ platform: "notion", discussionId: "disc-half", pageId: PAGE_LOOSE, workspaceId: WS }, "no carried credential");
    ok(posted.at(-1)?.auth === `Bearer ${ORG_TOKEN}`, "…and with NO carried id it falls back to the org default — proving the carry is what fixes it");

    await notionPostArm.dispatchUnified!({ platform: "notion", discussionId: "disc-half", pageId: PAGE_LOOSE, workspaceId: WS, credentialId: carried }, "unified, same credential", {});
    ok(posted.at(-1)?.auth === `Bearer ${PAY_TOKEN}`, "half-configured page: the UNIFIED reply arm honours the carried credential too");
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  setRegisteredProviders([
    {
      name: "notion",
      connection: "notion",
      allows: ["api-key"],
      credentials: [{ id: NOTION_CHANNEL_CREDENTIAL, type: "api-key", secretRef: "db:notion:channel-key", broker: "test", intake: false }],
    },
  ]);
  ok((await resolveNotionApiKey(PAY_CRED)) === undefined, "a bound domain whose credential is gone resolves NOTHING");
  ok((await resolveNotionApiKey(NOTION_CHANNEL_CREDENTIAL)) === ORG_TOKEN, "…while the org default still resolves (so this is a refusal, not a broken broker)");

  const seen: Seen[] = [];
  const body = commentEvent(PAGE_PAY);
  const out = await handleNotionDelivery(body, sign(PAY_SECRET, body), {
    signingKeys: [
      { credentialId: NOTION_CHANNEL_CREDENTIAL, secret: ORG_SECRET },
      { credentialId: PAY_CRED, secret: PAY_SECRET },
    ],
    allowUnverified: false,
    apiKeyFor: (id) => resolveNotionApiKey(id),
    credentialForPage: (workspaceId, pageId) => notionChannelCredentialFor(workspaceId, pageId, DOMAINS),
    resolveBotUserId: async () => "U_BOT",
    ambientEnabled: () => true,
    fetch: recordingFetch(seen),
    dispatch: async () => {
      throw new Error("a bound domain with no credential must never dispatch");
    },
  });
  ok(out.action === "no-api-key" && out.status === 200, "the delivery is ACKED (no retry storm over a config gap) and nothing dispatches");
  assert.equal(seen.length, 0, "no REST call was attempted at all — least of all one under the org token");
  passed++;
}

{
  const logged: string[] = [];
  const log = (m: string) => void logged.push(m);
  const throws = (err: unknown) => async () => {
    throw err;
  };

  const notSet = new OperatorSecretNotSetError(`secret "NOTION_WEBHOOK_SECRET_PAYMENTS" is not set: no row in the db credential store for org "default", and no environment variable of that name.`);
  ok((await resolveNotionInboundSecret("NOTION_WEBHOOK_SECRET_PAYMENTS", throws(notSet), log)) === undefined, "an unconfigured integration contributes NO key");
  ok(logged.length === 0, "…and says NOTHING (an integration nobody configured is not news)");

  const unarmed = new Error(
    `secret "NOTION_WEBHOOK_SECRET" is stored in the db credential store but OE_CREDENTIAL_ENCRYPTION_KEY is not set (or is malformed) — refusing to fall back to the environment variable of the same name, which may be a retired value (fail closed).`,
  );
  ok(unarmed.message.includes("is not set"), "the unarmed-key fault DOES match the old substring test (this is the collision that hid it)");
  ok((await resolveNotionInboundSecret("NOTION_WEBHOOK_SECRET", throws(unarmed), log)) === undefined, "a broken store still yields no key (the gate refuses the delivery)");
  ok(logged.length === 1, "🔴 …but it is REPORTED — a broken credential store never 401s every delivery in silence");
  ok(logged[0]!.includes("NOTION_WEBHOOK_SECRET") && logged[0]!.includes("401"), "…naming the SECRET NAME and the consequence");
  ok(!logged.join("\n").includes("channel-key"), "…and never a credential value or ref (negative control)");

  ok((await resolveNotionInboundSecret("NOTION_WEBHOOK_SECRET", throws(new Error("ECONNREFUSED")), log)) === undefined, "an unreachable store yields no key");
  ok(logged.length === 2, "…and is reported (only OperatorSecretNotSetError buys silence)");

  ok((await resolveNotionInboundSecret("NOTION_WEBHOOK_SECRET", async () => ({ value: ORG_SECRET }), log)) === ORG_SECRET, "a stored key resolves");
  ok((await resolveNotionInboundSecret("NOTION_WEBHOOK_SECRET", async () => ({ value: "" }), log)) === undefined, "an EMPTY stored value is no key at all");
  ok(logged.length === 2, "…and neither happy arm logs");
}

resetRegisteredProviders();
resetBrokers();
console.log(`✓ notion-per-domain-credential: ${passed} assertions passed`);

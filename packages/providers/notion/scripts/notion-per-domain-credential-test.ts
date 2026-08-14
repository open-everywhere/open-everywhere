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
  notionDeliveryClaimedDomains,
  notionDeliveryScopeVerdict,
  notionIntegrations,
  notionSignerServesDomain,
  resolveNotionInboundSecret,
} from "../agent/channels/notion-credentials.js";
import { notionRosterWorkspace } from "../agent/channels/notion-scope.js";
import { gateNotionDeliveryAcross, resolveNotionCredential, type FetchLike } from "../agent/channels/notion-api.js";
import { handleNotionDelivery, resolveDeliveryPage } from "../agent/channels/notion-webhook.js";
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

  const ctxFor = (page: string, credentialId?: string): BindableContext =>
    ({
      channel: { kind: "notion" },
      session: {
        auth: {
          current: {
            attributes: { workspace_id: WS, page_id: page, ...(credentialId ? { credential_id: credentialId } : {}) },
            principalId: "U_NOTION",
            principalType: "notion-user",
          },
        },
      },
    }) as BindableContext;
  ok(notionCallerCredential(ctxFor(PAGE_PAY), DOMAINS) === PAY_CRED, "the READ TOOLS' caller-surface form resolves the bound domain's credential");
  ok(notionCallerCredential(ctxFor(PAGE_SUP), DOMAINS) === undefined, "…and an unbound caller resolves the org default");

  ok(
    notionCallerCredential(ctxFor(PAGE_PAY, NOTION_CHANNEL_CREDENTIAL), DOMAINS) === NOTION_CHANNEL_CREDENTIAL,
    "🔴 a carried ORG delivery credential wins even on a page the domain binds to PAYMENTS",
  );
  ok(
    notionCallerCredential(ctxFor(PAGE_SUP, PAY_CRED), DOMAINS) === PAY_CRED,
    "…and a carried PAYMENTS delivery credential wins even on a page in an unbound domain",
  );
  ok(notionCallerCredential(ctxFor(PAGE_PAY, ""), DOMAINS) === PAY_CRED, "an EMPTY carried credential_id is absent, not a value — falls back to the domain binding");

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

  ok((await resolveNotionCredential())?.apiKey === ORG_TOKEN, "the default argument still resolves the ORG credential (byte-identical for every existing call site)");
  ok((await resolveNotionCredential(NOTION_CHANNEL_CREDENTIAL))?.apiKey === ORG_TOKEN, "naming the org credential resolves the org token");
  ok((await resolveNotionCredential(PAY_CRED))?.apiKey === PAY_TOKEN, "naming a SECOND credential resolves a DIFFERENT token — the whole point");
  ok((await resolveNotionCredential("no-such-credential")) === undefined, "🔴 a NAMED-BUT-MISSING credential fails CLOSED (undefined) — it never retries under the org default");
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
type CommentParent = { readonly type?: string; readonly page_id?: string; readonly block_id?: string };

function recordingFetch(seen: Seen[], parent?: CommentParent, blockParents?: Readonly<Record<string, CommentParent>>): FetchLike {
  return async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, auth: headers.authorization });
    if (url.includes("/v1/comments/")) {
      return new Response(
        JSON.stringify({
          id: "cmt-1",
          discussion_id: "disc-1",
          ...(parent ? { parent } : {}),
          created_by: { id: "U_HUMAN", object: "user", type: "person" },
          created_time: "2026-08-13T10:00:00.000Z",
          rich_text: [{ type: "text", plain_text: "what is the balance flow here?" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const block = /\/v1\/blocks\/([^/?]+)$/.exec(url)?.[1];
    if (block) {
      const decoded = decodeURIComponent(block);
      const blockParent = blockParents?.[decoded];
      if (!blockParent) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ id: decoded, parent: blockParent }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

interface DeliverResult {
  seen: Seen[];
  action: string;
  detail?: string;
  used?: string;
  dispatched?: string;
  attributes?: Record<string, string>;
  surfaceKey?: string;
  dispatchedPage?: string;
  asked: string[];
}

async function deliverFor(
  page: string,
  secret: string | null,
  shape?: { readonly parent?: CommentParent; readonly blockParents?: Readonly<Record<string, CommentParent>> },
): Promise<DeliverResult> {
  const seen: Seen[] = [];
  const asked: string[] = [];
  let dispatched: string | undefined;
  let attributes: Record<string, string> | undefined;
  let surfaceKey: string | undefined;
  let dispatchedPage: string | undefined;
  const body = commentEvent(page);
  const parent: CommentParent = shape?.parent ?? { type: "page_id", page_id: page };
  const out = await handleNotionDelivery(body, secret === null ? null : sign(secret, body), {
    signingKeys:
      secret === null
        ? [{ credentialId: NOTION_CHANNEL_CREDENTIAL, secret: undefined }]
        : [
            { credentialId: NOTION_CHANNEL_CREDENTIAL, secret: ORG_SECRET },
            { credentialId: PAY_CRED, secret: PAY_SECRET },
          ],
    allowUnverified: secret === null,
    credentialFor: (id) => resolveNotionCredential(id),
    credentialForPage: (workspaceId, pageId) => notionChannelCredentialFor(workspaceId, pageId, DOMAINS),
    domains: DOMAINS,
    resolveBotUserId: async () => "U_BOT",
    ambientEnabled: (key) => {
      asked.push(key);
      return true;
    },
    fetch: recordingFetch(seen, parent, shape?.blockParents),
    dispatch: async (d) => {
      dispatched = d.credentialId;
      attributes = { ...d.auth.attributes };
      surfaceKey = d.surfaceKey;
      dispatchedPage = d.pageId;
    },
  });
  return {
    seen,
    asked,
    action: out.action,
    ...(out.detail ? { detail: out.detail } : {}),
    ...(out.credentialId ? { used: out.credentialId } : {}),
    ...(dispatched ? { dispatched } : {}),
    ...(attributes ? { attributes } : {}),
    ...(surfaceKey ? { surfaceKey } : {}),
    ...(dispatchedPage ? { dispatchedPage } : {}),
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

  const forgedSessionCtx: BindableContext = {
    channel: { kind: "notion" },
    session: { auth: { current: { attributes: forgedBody.attributes ?? {}, principalId: "U_HUMAN", principalType: "notion-user" } } },
  } as BindableContext;
  ok(
    notionCallerCredential(forgedSessionCtx, DOMAINS) === NOTION_CHANNEL_CREDENTIAL,
    "🔴 the READ TOOLS on the double-shared page read under the credential that VERIFIED the delivery (org), never the page's payments domain binding",
  );
  ok(
    notionCallerCredential(forgedSessionCtx, DOMAINS) !== PAY_CRED,
    "…negative control: the escalation this closes — the domain-bound credential is NOT what the reads resolve",
  );
  const honestSessionCtx: BindableContext = {
    channel: { kind: "notion" },
    session: { auth: { current: { attributes: boundRun.attributes ?? {}, principalId: "U_HUMAN", principalType: "notion-user" } } },
  } as BindableContext;
  ok(notionCallerCredential(honestSessionCtx, DOMAINS) === PAY_CRED, "…while an HONEST payments delivery on the same page still reads under payments, unaffected");

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
  ok((await resolveNotionCredential(PAY_CRED)) === undefined, "a bound domain whose credential is gone resolves NOTHING");
  ok((await resolveNotionCredential(NOTION_CHANNEL_CREDENTIAL))?.apiKey === ORG_TOKEN, "…while the org default still resolves (so this is a refusal, not a broken broker)");

  const seen: Seen[] = [];
  const body = commentEvent(PAGE_PAY);
  const out = await handleNotionDelivery(body, sign(PAY_SECRET, body), {
    signingKeys: [
      { credentialId: NOTION_CHANNEL_CREDENTIAL, secret: ORG_SECRET },
      { credentialId: PAY_CRED, secret: PAY_SECRET },
    ],
    allowUnverified: false,
    credentialFor: (id) => resolveNotionCredential(id),
    credentialForPage: (workspaceId, pageId) => notionChannelCredentialFor(workspaceId, pageId, DOMAINS),
    domains: DOMAINS,
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

{
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

  const SUP_SURFACE = `notion/${WS}/${PAGE_SUP}`;
  const PAY_SURFACE = `notion/${WS}/${PAGE_PAY}`;

  const forged = await deliverFor(PAGE_PAY, ORG_SECRET, { parent: { type: "page_id", page_id: PAGE_SUP } });
  ok(forged.action === "dispatched", "the forged delivery still dispatches (it is a real comment, on a page the org key can see)");
  ok(forged.surfaceKey === SUP_SURFACE, "🔴 the session surfaces on the page the FETCHED COMMENT lives on");
  ok(forged.dispatchedPage === PAGE_SUP, "…the dispatched pageId is that same resolved page");
  ok(forged.attributes?.page_id === PAGE_SUP, "…and so is the `page_id` AUTH ATTRIBUTE the session is bound from");
  ok(forged.surfaceKey !== PAY_SURFACE, "the page the PAYLOAD named is not the surface key");
  ok(forged.dispatchedPage !== PAGE_PAY, "…nor the dispatched page");
  ok(forged.attributes?.page_id !== PAGE_PAY, "…nor the auth attribute");
  ok(forged.asked.length === 1 && forged.asked[0] === SUP_SURFACE, "…and the ambient gate was asked about the RESOLVED page only");
  ok(notionChannelCredentialForSurface(forged.surfaceKey!, DOMAINS) === undefined, "🔴 the read tools resolve NO payments credential for this session");
  ok(notionChannelCredentialForSurface(PAY_SURFACE, DOMAINS) === PAY_CRED, "…while the page the payload named WOULD have resolved the payments credential — the escalation this closes");
  ok(forged.used === NOTION_CHANNEL_CREDENTIAL, "the forged delivery still runs under the credential that VERIFIED it (§4's rule is untouched)");
  ok(forged.seen.length > 0 && forged.seen.every((s) => s.auth === `Bearer ${ORG_TOKEN}`), "…proven on the wire: no call reached the payments token");

  const honest = await deliverFor(PAGE_PAY, PAY_SECRET);
  ok(honest.surfaceKey === PAY_SURFACE && honest.dispatchedPage === PAGE_PAY, "a delivery whose payload AGREES with the comment surfaces on that page (nothing legitimate changed)");

  const BLOCK = "dddddddd-4444-4444-8444-dddddddddddd";
  const inline = await deliverFor(PAGE_PAY, ORG_SECRET, {
    parent: { type: "block_id", block_id: BLOCK },
    blockParents: { [BLOCK]: { type: "page_id", page_id: PAGE_SUP } },
  });
  ok(inline.action === "dispatched", "an INLINE comment (block parent, no page_id) still dispatches");
  ok(inline.surfaceKey === SUP_SURFACE, "🔴 …on the block's OWNING page, not the page the payload named");
  ok(inline.dispatchedPage === PAGE_SUP && inline.attributes?.page_id === PAGE_SUP, "…carried on the dispatch and the auth attribute alike");
  ok(inline.surfaceKey !== PAY_SURFACE, "…and the payload's page is still nowhere (negative control)");
  const walk = inline.seen.filter((s) => s.url.includes(`/v1/blocks/${BLOCK}`));
  ok(walk.length === 1, "the walk made exactly one block lookup for a top-level block");
  ok(walk[0]!.auth === `Bearer ${ORG_TOKEN}`, "🔴 …under the token that VERIFIED the delivery, not some other integration's");
  ok(inline.seen.every((s) => s.auth !== `Bearer ${PAY_TOKEN}`), "…and no call in the whole delivery touched the payments token");

  const unresolved = await deliverFor(PAGE_PAY, ORG_SECRET, { parent: { type: "block_id", block_id: BLOCK } });
  ok(unresolved.action === "unresolved-page", "🔴 a block whose owning page does NOT resolve REFUSES the delivery");
  ok(unresolved.surfaceKey === undefined && unresolved.dispatchedPage === undefined, "…nothing dispatched at all (negative control on the dispatch itself)");
  ok(unresolved.attributes === undefined, "…so no session was ever bound");
  ok((unresolved.detail ?? "").includes(BLOCK), "…and the reason names the block that could not be resolved");
  ok(unresolved.used === NOTION_CHANNEL_CREDENTIAL, "…while the outcome still reports the credential that verified it (this is a refusal, not a gate failure)");

  const parentless = await deliverFor(PAGE_PAY, ORG_SECRET, { parent: {} });
  ok(parentless.action === "unresolved-page", "a comment carrying no parent at all refuses too");
  ok(parentless.surfaceKey === undefined, "…and dispatches nothing (the payload's page_id is NOT a fallback)");

  const B = (n: number): string => `eeeeeeee-${String(n).padStart(4, "0")}-4000-8000-eeeeeeeeeeee`;
  const chain: Record<string, CommentParent> = { [B(6)]: { type: "page_id", page_id: PAGE_SUP } };
  for (let i = 1; i <= 5; i++) chain[B(i)] = { type: "block_id", block_id: B(i + 1) };
  const unitSeen: Seen[] = [];
  const unitFetch = recordingFetch(unitSeen, undefined, {
    ...chain,
    "block-on-workspace": { type: "workspace" },
    "block-self-cycle": { type: "block_id", block_id: "block-self-cycle" },
  });
  const at = { apiKey: ORG_TOKEN, fetch: unitFetch };

  ok((await resolveDeliveryPage({ parent: { type: "page_id", page_id: PAGE_PAY } }, at)).pageId === PAGE_PAY, "a page-level comment answers from its own parent, with no lookup");
  ok(unitSeen.length === 0, "…proven: the page-level arm made NO Notion call (negative control on the walk)");

  ok((await resolveDeliveryPage({ parent: { type: "block_id", block_id: B(2) } }, at)).pageId === PAGE_SUP, "a NESTED block walks up to its owning page");
  const tooDeep = await resolveDeliveryPage({ parent: { type: "block_id", block_id: B(1) } }, at);
  ok(tooDeep.pageId === undefined && (tooDeep.reason ?? "").length > 0, "🔴 a chain longer than BLOCK_PARENT_MAX_HOPS refuses — the walk is bounded, not best-effort");

  const onWorkspace = await resolveDeliveryPage({ parent: { type: "block_id", block_id: "block-on-workspace" } }, at);
  ok(onWorkspace.pageId === undefined && (onWorkspace.reason ?? "").length > 0, "a block whose parent is the WORKSPACE refuses — a non-page parent is never a page");

  const cycle = await resolveDeliveryPage({ parent: { type: "block_id", block_id: "block-self-cycle" } }, at);
  ok(cycle.pageId === undefined && (cycle.reason ?? "").length > 0, "a self-referencing block refuses instead of looping");

  const noParent = await resolveDeliveryPage({}, at);
  ok(noParent.pageId === undefined && (noParent.reason ?? "").length > 0, "no parent at all refuses, and says why");
}

{
  const WS_SEC = "99999999-8888-4777-8666-555555555555";
  const PAGE_OPEN = "dddddddd-4444-4444-8444-dddddddddddd";
  const SEC_CRED = "security-channel-key";
  const SEC_SECRET = "security-verification-token";

  const CLAIMED: readonly Domain[] = [
    defineDomain({
      name: "security",
      containers: [`notion/${WS_SEC}`],
      ambientSupervisor: true,
      credentials: [{ provider: "notion", credential: NOTION_CHANNEL_CREDENTIAL, use: SEC_CRED, inboundSecret: "NOTION_WEBHOOK_SECRET_SECURITY" }],
    }),
    defineDomain({
      name: "payments",
      channels: [`notion/${WS}/${PAGE_PAY}`],
      containers: [`notion/${WS}`],
      ambientSupervisor: true,
      credentials: [{ provider: "notion", credential: NOTION_CHANNEL_CREDENTIAL, use: PAY_CRED, inboundSecret: "NOTION_WEBHOOK_SECRET_PAYMENTS" }],
    }),
  ];

  const eventIn = (workspace: string, page: string): string =>
    JSON.stringify({ type: "comment.created", workspace_id: workspace, entity: { id: "cmt-1", type: "comment" }, data: { page_id: page } });

  interface FenceRun {
    readonly action: string;
    readonly detail?: string;
    readonly surfaceKey?: string;
    readonly asked: readonly string[];
    readonly dispatched: boolean;
  }

  async function fenceRun(workspace: string, page: string, secret: string | null, domains: readonly Domain[] = CLAIMED): Promise<FenceRun> {
    const asked: string[] = [];
    let surfaceKey: string | undefined;
    let dispatched = false;
    const body = eventIn(workspace, page);
    const out = await handleNotionDelivery(body, secret === null ? null : sign(secret, body), {
      signingKeys:
        secret === null
          ? [{ credentialId: NOTION_CHANNEL_CREDENTIAL, secret: undefined }]
          : [
              { credentialId: NOTION_CHANNEL_CREDENTIAL, secret: ORG_SECRET },
              { credentialId: PAY_CRED, secret: PAY_SECRET },
              { credentialId: SEC_CRED, secret: SEC_SECRET },
            ],
      allowUnverified: secret === null,
      credentialFor: async () => ({ apiKey: ORG_TOKEN }),
      credentialForPage: (workspaceId, pageId) => notionChannelCredentialFor(workspaceId, pageId, domains),
      domains,
      resolveBotUserId: async () => "U_BOT",
      ambientEnabled: (key) => {
        asked.push(key);
        return true;
      },
      fetch: recordingFetch([], { type: "page_id", page_id: page }),
      dispatch: async (d) => {
        dispatched = true;
        surfaceKey = d.surfaceKey;
      },
    });
    return { action: out.action, ...(out.detail ? { detail: out.detail } : {}), ...(surfaceKey ? { surfaceKey } : {}), asked, dispatched };
  }

  const forgedWorkspace = await fenceRun(WS_SEC, PAGE_OPEN, PAY_SECRET);
  ok(forgedWorkspace.action === "scope-refused", "🔴 a forged `workspace_id` naming another domain's claimed workspace is REFUSED");
  ok(forgedWorkspace.dispatched === false, "…nothing was dispatched (negative control on the dispatch itself)");
  ok(forgedWorkspace.surfaceKey === undefined, "…so no session was ever keyed to the victim domain's surface");
  ok(forgedWorkspace.asked.length === 0, "…and the AMBIENT GATE was never asked — the refusal lands before the victim's opt-in is read");
  ok((forgedWorkspace.detail ?? "").includes("security"), "…and the reason names the domain the claim reached");
  ok((forgedWorkspace.detail ?? "").includes(PAY_CRED), "…and the credential that actually signed it");

  const honestClaim = await fenceRun(WS_SEC, PAGE_OPEN, SEC_SECRET);
  ok(honestClaim.action === "dispatched", "an honest CONTAINER-tier delivery under the domain's OWN signer still dispatches");
  ok(honestClaim.surfaceKey === `notion/${WS_SEC}/${PAGE_OPEN}`, "…on the claimed workspace's own surface key");
  ok(honestClaim.asked.includes(`notion/${WS_SEC}/${PAGE_OPEN}`), "…and the ambient gate WAS asked about it");

  const rosteredCrossSigner = await fenceRun(WS, PAGE_PAY, ORG_SECRET);
  ok(rosteredCrossSigner.action === "dispatched", "🔴 a ROSTERED page delivered by a DIFFERENT integration still dispatches — the roster leg is exempt on purpose");
  ok(rosteredCrossSigner.surfaceKey === `notion/${WS}/${PAGE_PAY}`, "…on its own honest surface key");

  const rosteredButForgedWorkspace = await fenceRun(WS_SEC, PAGE_PAY, PAY_SECRET);
  ok(rosteredButForgedWorkspace.action === "scope-refused", "🔴 a ROSTERED page under a FORGED workspace is refused — the surface-key resolver is fenced too");
  ok(rosteredButForgedWorkspace.asked.length === 0, "…and the ambient gate never saw the forged surface key");

  const unclaimedWorkspace = "77777777-6666-4555-8444-333333333333";
  const unclaimed = await fenceRun(unclaimedWorkspace, PAGE_OPEN, PAY_SECRET);
  ok(unclaimed.action === "dispatched", "a page NO domain claims is not fenced — an unassigned page stays reachable");

  const hatchClaimed = await fenceRun(WS_SEC, PAGE_OPEN, null);
  ok(hatchClaimed.action === "scope-refused", "🔴 the unverified dev hatch identifies NO integration, so a CLAIMED page is refused (fail closed)");
  const hatchUnclaimed = await fenceRun(unclaimedWorkspace, PAGE_OPEN, null);
  ok(hatchUnclaimed.action === "dispatched", "…and an UNCLAIMED page under the same hatch still dispatches (negative control on the refusal)");

  const SHARED: readonly Domain[] = [
    defineDomain({
      name: "security",
      containers: [`notion/${WS_SEC}`],
      ambientSupervisor: true,
      credentials: [{ provider: "notion", credential: NOTION_CHANNEL_CREDENTIAL, use: SEC_CRED }],
    }),
  ];
  const sharedSecret = await fenceRun(WS_SEC, PAGE_OPEN, ORG_SECRET, SHARED);
  ok(sharedSecret.action === "dispatched", "a domain that shares the deployment's inbound secret is NOT separable, and the fence says yes rather than break it");

  ok(notionDeliveryScopeVerdict(WS_SEC, PAGE_OPEN, PAY_CRED, CLAIMED).ok === false, "the verdict refuses the forged claim");
  ok(notionDeliveryScopeVerdict(WS_SEC, PAGE_OPEN, SEC_CRED, CLAIMED).ok === true, "…and admits the same page under the serving integration");
  ok(notionDeliveryScopeVerdict(WS_SEC, PAGE_OPEN, undefined, CLAIMED).ok === false, "…refuses when no integration is identified at all");
  ok(notionDeliveryScopeVerdict(undefined, PAGE_OPEN, PAY_CRED, CLAIMED).ok === true, "…and a delivery naming NO workspace reaches no claim, so there is nothing to fence");
  ok(notionDeliveryScopeVerdict(WS_SEC, PAGE_OPEN, PAY_CRED, []).ok === true, "an EMPTY registry claims nothing, so the fence admits (a config-load failure must not silence the surface)");

  ok(notionDeliveryClaimedDomains(WS, PAGE_PAY, CLAIMED).length === 0, "a page reached by its ROSTER entry under its OWN workspace is claim-free");
  ok(
    notionDeliveryClaimedDomains(WS_SEC, PAGE_PAY, CLAIMED).map((d) => d.name).join() === "security",
    "…and the SAME page under a forged workspace is reached by security's claim (this is the fact leg (d) rides on)",
  );
  ok(notionDeliveryClaimedDomains(WS_SEC, PAGE_OPEN, CLAIMED).map((d) => d.name).join() === "security", "an unrostered page under a claimed workspace reaches that claim");

  const integrations = notionIntegrations(CLAIMED);
  const secDomain = CLAIMED.find((d) => d.name === "security")!;
  ok(notionSignerServesDomain(secDomain, SEC_CRED, integrations).served === true, "the domain's OWN credential serves it");
  const refused = notionSignerServesDomain(secDomain, PAY_CRED, integrations);
  ok(refused.served === false && refused.expected === SEC_CRED, "…and another domain's credential does not, naming the one that would");
}

{
  const WS_A = "22222222-1111-4111-8111-222222222222";
  const WS_B = "33333333-1111-4111-8111-333333333333";
  const PAGE_A = "44444444-1111-4111-8111-444444444444";
  const PAGE_B = "55555555-1111-4111-8111-555555555555";
  const ROSTER_DOMAINS: readonly Domain[] = [
    defineDomain({ name: "alpha-10", channels: [`notion/${WS_A}/${PAGE_A}`] }),
    defineDomain({ name: "beta-10", channels: [`notion/${WS_B}/${PAGE_B}`] }),
  ];
  ok(notionRosterWorkspace(PAGE_A, ROSTER_DOMAINS) === WS_A, "the roster's OWN recorded workspace comes back for a page it lists");
  ok(notionRosterWorkspace(PAGE_B, ROSTER_DOMAINS) === WS_B, "…and a DIFFERENT page in a different domain answers with ITS OWN entry, not alpha's");
  ok(notionRosterWorkspace(PAGE_LOOSE, ROSTER_DOMAINS) === undefined, "a page in NO roster answers undefined");
  ok(notionRosterWorkspace(PAGE_A, []) === undefined, "an EMPTY registry answers undefined (a config-load failure must not crash the lookup)");

  const eventIn10 = (workspace: string, page: string): string =>
    JSON.stringify({ type: "comment.created", workspace_id: workspace, entity: { id: "cmt-10", type: "comment" }, data: { page_id: page } });

  interface PartitionRun {
    readonly action: string;
    readonly surfaceKey?: string;
    readonly workspaceId?: string;
    readonly dispatched: boolean;
  }

  async function partitionRun(workspace: string, domains: readonly Domain[] = DOMAINS): Promise<PartitionRun> {
    let surfaceKey: string | undefined;
    let workspaceId: string | undefined;
    let dispatched = false;
    const body = eventIn10(workspace, PAGE_PAY);
    const out = await handleNotionDelivery(body, sign(PAY_SECRET, body), {
      signingKeys: [
        { credentialId: NOTION_CHANNEL_CREDENTIAL, secret: ORG_SECRET },
        { credentialId: PAY_CRED, secret: PAY_SECRET },
      ],
      allowUnverified: false,
      credentialFor: async () => ({ apiKey: ORG_TOKEN }),
      credentialForPage: () => undefined,
      domains,
      resolveBotUserId: async () => "U_BOT",
      ambientEnabled: () => true,
      fetch: recordingFetch([], { type: "page_id", page_id: PAGE_PAY }),
      dispatch: async (d) => {
        dispatched = true;
        surfaceKey = d.surfaceKey;
        workspaceId = d.auth.attributes.workspace_id;
      },
    });
    return { action: out.action, ...(surfaceKey ? { surfaceKey } : {}), ...(workspaceId ? { workspaceId } : {}), dispatched };
  }

  const honest = await partitionRun(WS);
  ok(honest.action === "dispatched" && honest.dispatched, "an honest delivery (payload workspace = the roster's) dispatches");
  ok(honest.surfaceKey === `notion/${WS}/${PAGE_PAY}`, "…on the expected surface key");
  ok(honest.workspaceId === WS, "…and the session's own auth attribute carries the same workspace");

  const FORGED_WS = "99999999-1111-4111-8111-999999999999";
  const forged = await partitionRun(FORGED_WS);
  ok(forged.action === "dispatched", "🔴 a rostered page under a THIRD, unclaimed workspace still dispatches (prefer, don't refuse — §9(c) untouched)");
  ok(forged.surfaceKey === `notion/${WS}/${PAGE_PAY}`, "🔴 …and lands on the HONEST surface key, not a second partition");
  ok(forged.workspaceId === WS, "🔴 …and the auth attribute the session binds from carries the SAME corrected workspace, not the payload's");
  ok(forged.surfaceKey !== `notion/${FORGED_WS}/${PAGE_PAY}`, "negative control: the forged workspace never appears in the surface key at all");

  const WS_SEC_10 = "88888888-1111-4111-8111-888888888888";
  const SEC_CRED_10 = "security-channel-key-10";
  const CLAIM_DOMAINS: readonly Domain[] = [
    ...DOMAINS,
    defineDomain({
      name: "security-10",
      containers: [`notion/${WS_SEC_10}`],
      ambientSupervisor: true,
      credentials: [{ provider: "notion", credential: NOTION_CHANNEL_CREDENTIAL, use: SEC_CRED_10, inboundSecret: "NOTION_WEBHOOK_SECRET_SECURITY_10" }],
    }),
  ];
  const crossClaim = await partitionRun(WS_SEC_10, CLAIM_DOMAINS);
  ok(crossClaim.action === "scope-refused", "the CLAIM-domain fence still refuses a rostered page's workspace that reaches ANOTHER domain's claim");
  ok(crossClaim.dispatched === false, "…and nothing was dispatched (negative control)");
}

{
  const WS_M1 = "aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa";
  const WS_M2 = "bbbbbbbb-9999-4999-8999-bbbbbbbbbbbb";
  const PAGE_CLAIM_11 = "cccccccc-9999-4999-8999-cccccccccccc";
  const MULTI_CRED = "multi-claim-channel-key-11";
  const MULTI_SECRET = "multi-claim-verification-token-11";
  const MULTI_CLAIM_DOMAINS: readonly Domain[] = [
    defineDomain({
      name: "multi-claim-11",
      containers: [`notion/${WS_M1}`, `notion/${WS_M2}`],
      ambientSupervisor: true,
      credentials: [{ provider: "notion", credential: NOTION_CHANNEL_CREDENTIAL, use: MULTI_CRED, inboundSecret: "NOTION_WEBHOOK_SECRET_MULTI_11" }],
    }),
  ];

  interface ClaimRun {
    readonly action: string;
    readonly surfaceKey?: string;
    readonly dispatched: boolean;
  }

  async function claimRun(workspace: string, page: string, secret: string, credId: string, domains: readonly Domain[]): Promise<ClaimRun> {
    let surfaceKey: string | undefined;
    let dispatched = false;
    const body = JSON.stringify({ type: "comment.created", workspace_id: workspace, entity: { id: "cmt-11", type: "comment" }, data: { page_id: page } });
    const out = await handleNotionDelivery(body, sign(secret, body), {
      signingKeys: [
        { credentialId: NOTION_CHANNEL_CREDENTIAL, secret: ORG_SECRET },
        { credentialId: credId, secret },
      ],
      allowUnverified: false,
      credentialFor: async () => ({ apiKey: ORG_TOKEN }),
      credentialForPage: () => undefined,
      domains,
      resolveBotUserId: async () => "U_BOT",
      ambientEnabled: () => true,
      fetch: recordingFetch([], { type: "page_id", page_id: page }),
      dispatch: async (d) => {
        dispatched = true;
        surfaceKey = d.surfaceKey;
      },
    });
    return { action: out.action, ...(surfaceKey ? { surfaceKey } : {}), dispatched };
  }

  const viaW1 = await claimRun(WS_M1, PAGE_CLAIM_11, MULTI_SECRET, MULTI_CRED, MULTI_CLAIM_DOMAINS);
  ok(viaW1.action === "dispatched" && viaW1.dispatched, "an honest delivery naming the domain's FIRST claimed workspace dispatches");
  ok(viaW1.surfaceKey === `notion/${WS_M1}/${PAGE_CLAIM_11}`, "…on that workspace's own surface key");

  const viaW2 = await claimRun(WS_M2, PAGE_CLAIM_11, MULTI_SECRET, MULTI_CRED, MULTI_CLAIM_DOMAINS);
  ok(viaW2.action === "dispatched" && viaW2.dispatched, "an honest delivery for the SAME page naming the domain's SECOND claimed workspace ALSO dispatches");
  ok(viaW2.surfaceKey === `notion/${WS_M2}/${PAGE_CLAIM_11}`, "…but on a DIFFERENT surface key");
  ok(
    viaW1.surfaceKey !== viaW2.surfaceKey,
    "🔴 THE KNOWN GAP (OPE-537): one page's history can still split across a domain's own claimed workspaces, same domain, same signer, no boundary ever crossed. " +
      "This assertion CHARACTERIZES today's accepted-for-now behaviour — if it goes red because the composition changed, that change moves live `channel_session`/memory " +
      "keying and needs the same review OPE-536's own fix required, not a silent change.",
  );

  const WS_S = "dddddddd-9999-4999-8999-dddddddddddd";
  const PAGE_S_11 = "eeeeeeee-9999-4999-8999-eeeeeeeeeeee";
  const S_CRED = "single-claim-channel-key-11";
  const S_SECRET = "single-claim-verification-token-11";
  const SINGLE_CLAIM_DOMAINS: readonly Domain[] = [
    defineDomain({
      name: "single-claim-11",
      containers: [`notion/${WS_S}`],
      ambientSupervisor: true,
      credentials: [{ provider: "notion", credential: NOTION_CHANNEL_CREDENTIAL, use: S_CRED, inboundSecret: "NOTION_WEBHOOK_SECRET_SINGLE_11" }],
    }),
  ];

  const honestSingle = await claimRun(WS_S, PAGE_S_11, S_SECRET, S_CRED, SINGLE_CLAIM_DOMAINS);
  ok(honestSingle.action === "dispatched", "a single-claim domain's own workspace dispatches normally");
  ok(honestSingle.surfaceKey === `notion/${WS_S}/${PAGE_S_11}`, "…on the expected surface key");

  const OTHER_WS_11 = "ffffffff-9999-4999-8999-ffffffffffff";
  const mismatchedSingle = await claimRun(OTHER_WS_11, PAGE_S_11, S_SECRET, S_CRED, SINGLE_CLAIM_DOMAINS);
  ok(mismatchedSingle.action === "dispatched", "a DIFFERENT, unclaimed workspace for the same page still dispatches (an unassigned page is not fenced)");
  ok(
    mismatchedSingle.surfaceKey === `notion/${OTHER_WS_11}/${PAGE_S_11}`,
    "…on the UNCLAIMED workspace's own key, never on the single-claim domain's recorded workspace — the claim leg cannot be forged into a second " +
      "partition beside a single-claim domain's honest one",
  );
  ok(mismatchedSingle.surfaceKey !== honestSingle.surfaceKey, "negative control: the two runs really do land on different keys, so the assertion above is not vacuous");
}

resetRegisteredProviders();
resetBrokers();
console.log(`✓ notion-per-domain-credential: ${passed} assertions passed`);

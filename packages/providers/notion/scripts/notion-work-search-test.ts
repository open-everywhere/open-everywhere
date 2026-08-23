import assert from "node:assert/strict";
import {
  defineDomain,
  registerBroker,
  resetBrokers,
  resetRegisteredConnectorCredentials,
  setRegisteredConnectorCredentials,
  registerIdentityMapper,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";
import { domainOwnPageIds, notionWorkSearchAdapter } from "../agent/channels/notion-work-search.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const WS = "ws-1";
const OWN_PAGE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER_PAGE = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";

const OTHER_WS_PAGE = "cccccccc-2222-4222-8222-cccccccccccc";
const rostered: Domain = defineDomain({ name: "d1", channels: ["slack/T1/C1", `notion/${WS}/${OWN_PAGE}`, `notion/other-ws/${OTHER_WS_PAGE}`] });
const ids = domainOwnPageIds(rostered);
ok(ids.has(OWN_PAGE.replace(/-/g, "")), "a rostered notion channel's page id is in the set, canonicalised");
ok(ids.has(OTHER_WS_PAGE.replace(/-/g, "")), "a roster entry under a DIFFERENT workspace segment still counts — no workspace cross-check is needed (the roster already belongs to exactly one domain)");
ok(ids.has(OTHER_PAGE.replace(/-/g, "")) === false, "NEGATIVE CONTROL: a page never rostered to this domain is NOT in the set");
ok(domainOwnPageIds(defineDomain({ name: "d2", channels: ["slack/T1/C2"] })).size === 0, "NEGATIVE CONTROL: a domain with no Notion roster entries owns NOTHING (empty set, not everything)");
ok(domainOwnPageIds(defineDomain({ name: "d3" })).size === 0, "NEGATIVE CONTROL: a domain with no channels at all owns nothing (no throw)");
{
  const bare = OWN_PAGE.replace(/-/g, "");
  ok(ids.has(bare), "hyphenated roster entry canonicalises to the bare form a search hit's raw id would compare against");
}

const PLATFORM = "notionworksearchtestplatform";
registerIdentityMapper(PLATFORM, (c) => {
  const a = (c as BindableContext).session?.auth?.current?.attributes as Record<string, string> | undefined;
  return { workspace: a?.["ws"], surface: a?.["room"], mode: "channel", visibility: "public", trust: "internal", principalId: "U_NWS" };
});
function ctxIn(room: string): BindableContext {
  return {
    channel: { kind: PLATFORM },
    session: { auth: { current: { attributes: { ws: "W1", room }, principalId: "U_NWS", principalType: "test-user" } } },
  } as unknown as BindableContext;
}

const domain: Domain = defineDomain({
  name: "nws-domain",
  channels: [`${PLATFORM}/W1/CROOM`, `notion/${WS}/${OWN_PAGE}`],
  credentials: [{ connector: "notion", credential: "team-key", use: "nws-work-key" }],
});

resetBrokers();
registerBroker("test", {
  async getSecret(ref) {
    if (ref === "test:notion:work") return "fake-work-token";
    throw new Error(`no secret for ${ref}`);
  },
});
resetRegisteredConnectorCredentials();
setRegisteredConnectorCredentials([
  { connector: "notion", allows: ["api-key"], credentials: [{ id: "nws-work-key", type: "api-key", secretRef: "test:notion:work", broker: "test", intake: false }] },
]);

const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(
    JSON.stringify({
      results: [
        { id: OWN_PAGE, object: "page", url: `https://notion.so/${OWN_PAGE}`, properties: { title: { type: "title", title: [{ plain_text: "Our own spec" }] } } },
        { id: OTHER_PAGE, object: "page", url: `https://notion.so/${OTHER_PAGE}`, properties: { title: { type: "title", title: [{ plain_text: "Someone else's page" }] } } },
      ],
      has_more: false,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

try {
  const unscoped = await notionWorkSearchAdapter.search(ctxIn("CROOM"), domain, "spec", { limit: 10, insideDomain: false });
  ok(unscoped.length === 2, "unscoped: BOTH hits come back — reach is the credential's own reach, never filtered by default");
  ok(
    unscoped.some((h) => h.id === OTHER_PAGE),
    "unscoped INCLUDES a page outside this domain's own roster — the load-bearing negative control for 'no filter as a boundary'",
  );

  const scoped = await notionWorkSearchAdapter.search(ctxIn("CROOM"), domain, "spec", { limit: 10, insideDomain: true });
  ok(scoped.length === 1 && scoped[0]!.id === OWN_PAGE, "insideDomain:true narrows to ONLY the page this domain's roster names");
  ok(
    scoped.every((h) => h.id !== OTHER_PAGE),
    "insideDomain:true DROPS the page outside the roster",
  );
  ok(scoped[0]!.title === "Our own spec" && scoped[0]!.connector === "notion", "the surviving hit carries its title and connector, never a page body");

  await assert.rejects(
    notionWorkSearchAdapter.search(ctxIn("CROOM"), defineDomain({ name: "nws-nogrant", channels: [`${PLATFORM}/W1/CBARE`] }), "spec", { limit: 10, insideDomain: false }),
    /holds no Notion work grant/u,
    "NEGATIVE CONTROL: a domain with no Notion work grant refuses rather than silently returning empty",
  );
} finally {
  globalThis.fetch = realFetch;
  resetRegisteredConnectorCredentials();
  resetBrokers();
}

console.log(`✓ notion-work-search: ${passed} assertions passed`);

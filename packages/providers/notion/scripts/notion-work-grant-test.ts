import assert from "node:assert/strict";
import {
  ChannelScopeError,
  TurnOriginFenceError,
  declaredWorkspaceTrust,
  defineDomain,
  defineSurface,
  overrideSettingsForTest,
  registerConfig,
  registerIdentityMapper,
  registerSurfaces,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";
import {
  registerBroker,
  resetBrokers,
  resetRegisteredConnectorCredentials,
  setRegisteredConnectorCredentials,
} from "@open-everywhere/core/agent/adapter-api.js";
import { registerNotionProvider } from "../agent/register.js";
import {
  notionCallerDomain,
  notionWorkCredential,
  notionWorkGrant,
  notionWorkMount,
  notionWorkspacesOf,
  NOTION_WORK_CREDENTIAL,
} from "../agent/channels/notion-work.js";
import { assertNotionWorkPageAllowed, notionWorkScope } from "../agent/channels/notion-scope.js";
import notionSearch, { notionSearchEntry } from "../agent/tools/notion_search.js";
import { readNotionPageEntry } from "../agent/tools/read_notion_page.js";

registerNotionProvider();

registerIdentityMapper("slack", (ctx) => {
  const attrs = (ctx.session?.auth?.current?.attributes ?? {}) as Record<string, string>;
  return { workspace: attrs.team_id, surface: attrs.channel_id, mode: "channel", visibility: "private", trust: "internal" };
});

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const WS = "ws-1";
const SPEC_PAGE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const NOTES_PAGE = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
const OTHER_PAGE = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const LOOSE_PAGE = "cccccccc-1111-4111-8111-cccccccccccc";
const CLAIMED_PAGE = "dddddddd-1111-4111-8111-dddddddddddd";

const granted = defineDomain({
  name: "soak",
  channels: ["slack/T1/C_DEV", `notion/${WS}/${SPEC_PAGE}`, `notion/${WS}/${NOTES_PAGE}`],
  credentials: [{ connector: "notion", credential: NOTION_WORK_CREDENTIAL, use: "soak-work-key" }],
});
const ungranted = defineDomain({
  name: "eng",
  channels: ["slack/T1/C_ENG", `notion/${WS}/${OTHER_PAGE}`],
});
const chatOnly = defineDomain({
  name: "billing",
  channels: ["slack/T1/C_BILL"],
  credentials: [{ connector: "notion", credential: "channel-key", use: "billing-chat-key" }],
});
const claimed = defineDomain({
  name: "claimed",
  channels: ["slack/T1/C_CLAIM"],
  containers: ["notion/ws-2"],
  credentials: [{ connector: "notion", credential: NOTION_WORK_CREDENTIAL, use: "claimed-work-key" }],
});

const DOMAINS: readonly Domain[] = [granted, ungranted, chatOnly, claimed];

registerConfig({
  loadDomains: () => DOMAINS,
  loadSilos: () => [],
  loadBundles: () => [],
  loadBindings: () => [],
  domainsForSurface: () => [],
  pluginRegistry: {},
  skillContent: {},
});
overrideSettingsForTest({ tools: { sourceScopedMount: false } });

const slackCtx = (channel: string): BindableContext =>
  ({
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: channel }, principalId: "U1", principalType: "slack-user" } } },
  }) as BindableContext;
const notionCtx = (page: string, ws = WS): BindableContext =>
  ({
    channel: { kind: "notion" },
    session: { auth: { current: { attributes: { workspace_id: ws, page_id: page }, principalId: "U_NOTION", principalType: "notion-user" } } },
  }) as BindableContext;

{
  ok(notionWorkCredential(granted) === "soak-work-key", "a domain that declares the work role resolves ITS credential");
  ok(notionWorkCredential(ungranted) === undefined, "a domain that declares nothing resolves NO work credential (no org-default fallback)");
  ok(notionWorkCredential(chatOnly) === undefined, "declaring the CHAT credential does NOT confer the work grant");
  ok(notionWorkCredential(undefined) === undefined, "an unresolved domain holds no work grant");
}

{
  ok(notionCallerDomain("slack/T1/C_DEV", DOMAINS)?.name === "soak", "a SLACK channel key resolves its domain — the cross-surface claim");
  ok(notionCallerDomain(`notion/${WS}/${SPEC_PAGE}`, DOMAINS)?.name === "soak", "a NOTION page key resolves the same domain");
  ok(
    notionCallerDomain(`notion/${WS}/${SPEC_PAGE.replace(/-/g, "").toUpperCase()}`, DOMAINS)?.name === "soak",
    "a notion key in the bare/upper spelling still resolves — the canonicalising resolver is used for notion keys",
  );
  ok(notionCallerDomain("slack/T1/C_NOWHERE", DOMAINS) === undefined, "a surface in no domain resolves no domain");
  ok(notionWorkspacesOf(granted).includes(WS), "the domain's own notion workspaces come off its roster");
  ok(notionWorkspacesOf(claimed).includes("ws-2"), "…and off its claims, which is what the claim leg needs cross-surface");
  ok(notionWorkspacesOf(ungranted).length === 1, "a domain names only the workspaces it declared");
}

{
  const from = (d: Domain | undefined) => (page: string) => notionWorkScope(d, page, DOMAINS, d ? notionWorkspacesOf(d) : []);
  const fromSoak = from(granted);
  ok(fromSoak(SPEC_PAGE).allowed && fromSoak(SPEC_PAGE).reason === "roster", "a page in the caller's own domain is readable");
  ok(fromSoak(NOTES_PAGE).allowed, "…and so is its sibling");

  const cross = fromSoak(OTHER_PAGE);
  ok(!cross.allowed && cross.reason === "cross-domain", "🔴 a page in ANOTHER domain is REFUSED, work grant or not");
  ok(cross.callerDomain === "soak" && cross.targetDomain === "eng", "…and the verdict names both domains");

  const loose = fromSoak(LOOSE_PAGE);
  ok(!loose.allowed && loose.reason === "target-unassigned", "🔴 a page in NO domain is REFUSED (fail closed)");

  const noCaller = from(undefined)(SPEC_PAGE);
  ok(!noCaller.allowed && noCaller.reason === "caller-unassigned", "🔴 a caller in no domain reaches nothing");

  ok(notionWorkScope(claimed, CLAIMED_PAGE, DOMAINS, notionWorkspacesOf(claimed)).allowed, "a claimed page is readable with the domain's own workspace hints");
  ok(!notionWorkScope(claimed, CLAIMED_PAGE, DOMAINS, []).allowed, "…and unreadable without them — the hints are load-bearing, not decoration");
  ok(!notionWorkScope(granted, CLAIMED_PAGE, DOMAINS, notionWorkspacesOf(granted)).allowed, "another domain's hints never reach the claimed page");

  const rows: Array<{ action?: string; detail?: Record<string, unknown> }> = [];
  const audit = async (e: { action?: string; detail?: Record<string, unknown> }) => void rows.push(e);
  await assertNotionWorkPageAllowed(slackCtx("C_DEV"), SPEC_PAGE, granted, DOMAINS, notionWorkspacesOf(granted), { audit });
  ok(rows.length === 0, "an ALLOWED work read appends no refusal row");
  await assert.rejects(
    () => assertNotionWorkPageAllowed(slackCtx("C_DEV"), OTHER_PAGE, granted, DOMAINS, notionWorkspacesOf(granted), { audit }),
    ChannelScopeError,
    "a cross-domain work read throws ChannelScopeError",
  );
  ok(rows.length === 1 && rows[0]!.detail?.reason === "cross-domain", "…and the refusal is audited with its reason");
  ok(rows[0]!.detail?.target === OTHER_PAGE, "the row records the target id");
  ok(!Object.prototype.hasOwnProperty.call(rows[0]!.detail ?? {}, "text"), "the row carries no page content (nothing was fetched)");
}

{
  const resolve = (notionSearch as unknown as { events?: Record<string, ((e: unknown, c: BindableContext) => unknown) | undefined> }).events?.[
    "session.started"
  ];
  ok(typeof resolve === "function", "notion_search exposes a session.started resolver");
  if (typeof resolve !== "function") process.exit(1);

  const armed = await resolve({}, slackCtx("C_DEV"));
  ok(armed === notionSearchEntry, "notion_search MOUNTS on a Slack session in a work-granted domain");
  ok((await resolve({}, notionCtx(SPEC_PAGE))) === notionSearchEntry, "…and on a Notion session in the same domain");
  ok((await resolve({}, slackCtx("C_ENG"))) === null, "🔴 notion_search is ABSENT in a domain that declares no work grant");
  ok((await resolve({}, notionCtx(OTHER_PAGE))) === null, "🔴 …even on a NOTION session there — the chat surface confers no work reach");
  ok((await resolve({}, slackCtx("C_BILL"))) === null, "🔴 …and a chat-credential declaration does not mount it either");
  ok((await resolve({}, slackCtx("C_NOWHERE"))) === null, "🔴 …nor does a surface in no domain at all");

  ok(notionWorkMount(slackCtx("C_DEV"), () => DOMAINS), "the mount predicate is true under the grant");
  ok(notionWorkMount(slackCtx("C_ENG"), () => DOMAINS) === false, "…and false without it (explicit false)");
  ok(
    notionWorkMount(slackCtx("C_DEV"), () => {
      throw new Error("config unavailable");
    }) === false,
    "an unreadable config HIDES the work tools (fail closed), it does not mount them",
  );

  await assert.rejects(
    () => (notionSearchEntry.execute as (i: unknown, c: BindableContext) => Promise<unknown>)({ query: "spec" }, slackCtx("C_ENG")),
    /no Notion work grant/,
    "notion_search's execute refuses an ungranted domain even if it were mounted",
  );
  passed++;
}

{
  const execute = readNotionPageEntry.execute as (i: unknown, c: BindableContext) => Promise<unknown>;

  await assert.rejects(
    () => execute({ page: OTHER_PAGE }, slackCtx("C_ENG")),
    TurnOriginFenceError,
    "🔴 a non-Notion turn in an UNGRANTED domain is still refused by the per-turn origin fence",
  );
  passed++;

  await assert.rejects(
    () => execute({ page: OTHER_PAGE }, slackCtx("C_DEV")),
    ChannelScopeError,
    "🔴 a work-granted Slack turn STILL cannot read another domain's page (domain fence, not the origin fence)",
  );
  passed++;

  await assert.rejects(
    () => execute({ page: SPEC_PAGE }, slackCtx("C_DEV")),
    /work credential "soak-work-key"/,
    "a work-granted read of the domain's OWN page resolves the WORK credential (the id it resolved is in the failure)",
  );
  passed++;

  const chatPlane = await execute({ page: SPEC_PAGE }, notionCtx(SPEC_PAGE)).then(
    () => "",
    (e: Error) => e.message,
  );
  ok(chatPlane.includes("db:notion:channel-key"), "a NOTION-origin turn still reads on the CHAT credential — the chat plane is byte-unchanged");
  ok(!chatPlane.includes("soak-work-key"), "…and never reaches for the work credential (negative control on the same message)");

  await assert.rejects(() => execute({}, slackCtx("C_DEV")), /Pass `page` explicitly/, "the work plane refuses to guess a page id");
  passed++;

  ok(notionWorkGrant(slackCtx("C_DEV"), DOMAINS)?.credential === "soak-work-key", "the grant resolved from a slack ctx names the work credential");
  ok(notionWorkGrant(slackCtx("C_ENG"), DOMAINS) === undefined, "…and resolves nothing in an ungranted domain");
}

{
  registerSurfaces([defineSurface({ key: "slack/T1", trust: "internal" })]);
  ok(declaredWorkspaceTrust("slack/T1") === "internal", "the caller's SLACK workspace IS vouched internal — the bypass is available if the code takes it");
  ok(declaredWorkspaceTrust(`notion/${WS}`) === undefined, "…and the Notion workspace the page lives in is NOT vouched");

  resetBrokers();
  registerBroker("test", { async getSecret(ref) {
    if (ref === "test:notion:work") return "fake-work-token";
    throw new Error(`no secret for ${ref}`);
  } });
  resetRegisteredConnectorCredentials();
  setRegisteredConnectorCredentials([
    {
      connector: "notion",
      allows: ["api-key"],
      credentials: [{ id: "soak-work-key", type: "api-key", secretRef: "test:notion:work", broker: "test", intake: false }],
    },
  ]);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "the spec" }] } }], has_more: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const out = (await (readNotionPageEntry.execute as unknown as (i: unknown, c: BindableContext) => Promise<Record<string, unknown>>)(
      { page: SPEC_PAGE },
      slackCtx("C_DEV"),
    )) as { text: string; workspaceTrust?: string };
    ok(out.text.includes("the spec"), "the work-plane read completes under the work credential (the fake Notion answered)");
    ok(out.workspaceTrust === undefined, "🔴 a WORK-plane read carries NO workspaceTrust — the caller's vouched Slack workspace never leaks onto a Notion page");
  } finally {
    globalThis.fetch = realFetch;
    resetRegisteredConnectorCredentials();
    resetBrokers();
  }
}

console.log(`✓ notion-work-grant: ${passed} assertions passed`);

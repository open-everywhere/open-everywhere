import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNotionBlockAllowed,
  assertNotionPageAllowed,
  assertNotionPageAllowedOrResolveBlock,
  canonicalNotionId,
  notionPageDomain,
  notionReadScope,
} from "../agent/channels/notion-scope.js";
import {
  ChannelScopeError,
  connectorReadsThisTurn,
  defineDomain,
  registerBroker,
  registerConfig,
  resetBrokers,
  resetRegisteredConnectorCredentials,
  setRegisteredConnectorCredentials,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";
import { registerNotionProvider } from "../agent/register.js";
import { readNotionPageEntry } from "../agent/tools/read_notion_page.js";
import { readNotionCommentsEntry } from "../agent/tools/read_notion_comments.js";

registerNotionProvider();

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const WS = "ws-1";
const PAGE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PAGE_A2 = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
const PAGE_B = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const PAGE_LOOSE = "cccccccc-1111-4111-8111-cccccccccccc";
const WS2 = "ws-2";
const PAGE_C = "dddddddd-1111-4111-8111-dddddddddddd";

const DOMAINS: readonly Domain[] = [
  defineDomain({ name: "payments", reach: [`notion/${WS}/${PAGE_A}`, `notion/${WS}/${PAGE_A2}`] }),
  defineDomain({ name: "eng", reach: [`notion/${WS}/${PAGE_B}`] }),
  defineDomain({ name: "claimed", reach: [`notion/${WS2}`] }),
];

const keyFor = (ws: string, page: string): string => `notion/${ws}/${page}`;

{
  const from = (page: string, ws = WS) => (target: string) => notionReadScope(keyFor(ws, page), target, DOMAINS);
  const fromA = from(PAGE_A);

  ok(fromA(PAGE_A).allowed && fromA(PAGE_A).reason === "own-page", "the session's OWN page is always readable");
  const sibling = fromA(PAGE_A2);
  ok(sibling.allowed && sibling.reason === "roster", "a SIBLING page in the same domain's roster is readable");

  const cross = fromA(PAGE_B);
  ok(!cross.allowed && cross.reason === "cross-domain", "a page in ANOTHER domain's roster is REFUSED");
  ok(cross.callerDomain === "payments" && cross.targetDomain === "eng", "…and the verdict names both domains, so the audit row is actionable");

  const loose = fromA(PAGE_LOOSE);
  ok(!loose.allowed && loose.reason === "target-unassigned", "a page in NO domain is REFUSED (fail closed — 'we can't tell' is never 'yes')");

  const fromLoose = from(PAGE_LOOSE);
  ok(fromLoose(PAGE_LOOSE).allowed, "an unassigned session can still read its own page");
  ok(!fromLoose(PAGE_A).allowed && fromLoose(PAGE_A).reason === "caller-unassigned", "an unassigned session cannot reach into a domain");

  const unknown = notionReadScope("notion/unknown/unknown", PAGE_A, DOMAINS);
  ok(!unknown.allowed, "an under-identified session (notion/unknown/unknown) is refused");
}

{
  const fromClaimed = notionReadScope(keyFor(WS2, PAGE_C), "eeeeeeee-1111-4111-8111-eeeeeeeeeeee", DOMAINS);
  ok(fromClaimed.allowed && fromClaimed.reason === "container", "a claim-only domain may read an unenumerated page in its claimed workspace");

  const outOfWorkspace = notionReadScope(keyFor(WS2, PAGE_C), PAGE_A, DOMAINS);
  ok(!outOfWorkspace.allowed, "a claim over one workspace does not reach a page in another workspace");

  const overlapping: readonly Domain[] = [
    defineDomain({ name: "payments", reach: [`notion/${WS}/${PAGE_A}`] }),
    defineDomain({ name: "wide", reach: [`notion/${WS}`] }),
  ];
  ok(notionPageDomain(WS, PAGE_A, overlapping).domain?.name === "payments", "roster beats claim for a listed page");
  ok(notionPageDomain(WS, PAGE_LOOSE, overlapping).domain?.name === "wide", "…and the claim still covers the pages nobody listed");
  const annex = notionReadScope(keyFor(WS, PAGE_LOOSE), PAGE_A, overlapping);
  ok(!annex.allowed && annex.reason === "cross-domain", "a claiming domain cannot read a page another domain listed");

  const carved: readonly Domain[] = [
    defineDomain({ name: "wide", reach: [`notion/${WS}`], exclude: [`notion/${WS}/${PAGE_LOOSE}`] }),
  ];
  ok(notionPageDomain(WS, PAGE_B, carved).domain?.name === "wide", "the workspace claim still covers the pages nobody carved out");
  ok(notionPageDomain(WS, PAGE_LOOSE, carved).domain === undefined, "an EXCLUDED page is in no domain, even under a whole-workspace claim");
  const excluded = notionReadScope(keyFor(WS, PAGE_B), PAGE_LOOSE, carved);
  ok(!excluded.allowed && excluded.reason === "target-unassigned", "…so reading it is refused, fail-closed, like any unassigned page");
  const bareCarve: readonly Domain[] = [
    defineDomain({ name: "wide", reach: [`notion/${WS}`], exclude: [`notion/${WS}/${PAGE_LOOSE.replace(/-/g, "").toUpperCase()}`] }),
  ];
  ok(notionPageDomain(WS, PAGE_LOOSE, bareCarve).domain === undefined, "an exclusion written in the bare/upper spelling still carves the page out");
}

{
  const bare = PAGE_A2.replace(/-/g, "").toUpperCase();
  ok(canonicalNotionId(bare) === canonicalNotionId(PAGE_A2), "hyphen/case variants canonicalise equal");
  ok(notionReadScope(keyFor(WS, PAGE_A), bare, DOMAINS).allowed, "a rostered page is readable in its bare/upper spelling too");
  ok(!notionReadScope(keyFor(WS, PAGE_A), PAGE_B.replace(/-/g, ""), DOMAINS).allowed, "canonicalisation does not admit a DIFFERENT page");
}

const ctxFor = (page: string, ws = WS): BindableContext =>
  ({
    channel: { kind: "notion" },
    session: {
      auth: {
        current: {
          attributes: { workspace_id: ws, page_id: page },
          principalId: "U_NOTION",
          principalType: "notion-user",
        },
      },
    },
  }) as BindableContext;

const ctxForTurn = (page: string, turnId: string, ws = WS): BindableContext => {
  const base = ctxFor(page, ws) as unknown as { session: Record<string, unknown> };
  return { ...(base as object), session: { ...base.session, turn: { id: turnId, sequence: 1 } } } as unknown as BindableContext;
};

{
  const quiet: unknown[] = [];
  await assertNotionPageAllowed(ctxFor(PAGE_A), PAGE_A2, DOMAINS, { audit: async (e) => void quiet.push(e) });
  ok(quiet.length === 0, "an ALLOWED read appends no refusal row");

  const rows: Array<{ action: string; platform: string; workspace?: string; surface?: string; detail?: Record<string, unknown>; principalId?: string }> = [];
  const audit = async (e: { action: string; platform: string; workspace?: string; surface?: string; detail?: Record<string, unknown>; principalId?: string }) =>
    void rows.push(e);
  await assert.rejects(
    () => assertNotionPageAllowed(ctxFor(PAGE_A), PAGE_B, DOMAINS, { audit }),
    ChannelScopeError,
    "a cross-domain page read throws ChannelScopeError",
  );
  ok(true, "cross-domain read refused (ChannelScopeError)");

  ok(rows.length === 1, "the refusal appended exactly one audit row");
  const row = rows[0]!;
  ok(row.action === "read.refused" && row.platform === "notion", "the row is a notion read.refused");
  ok(row.detail?.reason === "cross-domain", "the row records WHY");
  ok(row.detail?.target === PAGE_B && row.detail?.callerDomain === "payments" && row.detail?.targetDomain === "eng", "the row records the target and BOTH domains");
  ok(row.principalId === "U_NOTION", "the row records WHO asked");
  ok(!Object.prototype.hasOwnProperty.call(row.detail ?? {}, "text"), "the row carries no page content (nothing was fetched)");
  ok(row.workspace === WS && row.surface === PAGE_A, "a chat-plane refusal's workspace/surface columns are the CALLER'S REAL Notion ids, not stamped unknown");

  rows.length = 0;
  await assert.rejects(() => assertNotionPageAllowed(ctxFor(PAGE_A), PAGE_LOOSE, DOMAINS, { audit }), ChannelScopeError, "unassigned page refused");
  ok(rows.length === 1 && rows[0]!.detail?.reason === "target-unassigned", "the FAIL-CLOSED refusal is audited under its own reason");
}

{
  const rows: Array<{ detail?: Record<string, unknown> }> = [];
  const audit = async (e: { detail?: Record<string, unknown> }) => void rows.push(e);
  const OWN_BLOCK = "11111111-1111-4111-8111-111111111111";
  const FOREIGN_BLOCK = "22222222-2222-4222-8222-222222222222";
  const owner = async (id: string): Promise<string | undefined> =>
    id === OWN_BLOCK ? PAGE_A2 : id === FOREIGN_BLOCK ? PAGE_B : undefined;

  await assertNotionBlockAllowed(ctxFor(PAGE_A), OWN_BLOCK, DOMAINS, owner, { audit });
  ok(rows.length === 0, "a block whose owning page is in the domain is admitted");

  await assert.rejects(
    () => assertNotionBlockAllowed(ctxFor(PAGE_A), FOREIGN_BLOCK, DOMAINS, owner, { audit }),
    ChannelScopeError,
    "a block owned by ANOTHER domain's page is refused",
  );
  ok(rows.length === 1 && rows[0]!.detail?.reason === "block:cross-domain", "…and the refusal is audited as a block cross-domain");

  rows.length = 0;
  await assert.rejects(
    () => assertNotionBlockAllowed(ctxFor(PAGE_A), "99999999-9999-4999-8999-999999999999", DOMAINS, owner, { audit }),
    ChannelScopeError,
    "an unresolvable block is refused",
  );
  ok(rows.length === 1 && rows[0]!.detail?.reason === "block-unresolvable", "the unresolvable block refusal is audited (fail closed)");

  rows.length = 0;
  let lookups = 0;
  await assertNotionBlockAllowed(
    ctxFor(PAGE_A),
    PAGE_A2,
    DOMAINS,
    async (id) => {
      lookups++;
      return owner(id);
    },
    { audit },
  );
  ok(rows.length === 0 && lookups === 0, "a page-level anchor is admitted by id alone (no parent lookup)");
}

{
  const rows: Array<{ detail?: Record<string, unknown> }> = [];
  const audit = async (e: { detail?: Record<string, unknown> }) => void rows.push(e);
  const OWN_BLOCK = "33333333-1111-4111-8111-333333333333";
  const FOREIGN_BLOCK = "44444444-2222-4222-8222-444444444444";
  const UNRESOLVABLE = "55555555-9999-4999-8999-555555555555";
  const owner = async (id: string): Promise<string | undefined> =>
    id === OWN_BLOCK ? PAGE_A2 : id === FOREIGN_BLOCK ? PAGE_B : undefined;

  const resolved = await assertNotionPageAllowedOrResolveBlock(ctxFor(PAGE_A), OWN_BLOCK, DOMAINS, owner, { audit });
  ok(resolved === PAGE_A2, "a block whose owning page is in the domain resolves to that PAGE id, not the block id");
  ok(rows.length === 0, "…and admits silently, same as a directly-passed rostered page");

  rows.length = 0;
  let lookups = 0;
  const direct = await assertNotionPageAllowedOrResolveBlock(
    ctxFor(PAGE_A),
    PAGE_A2,
    DOMAINS,
    async (id) => {
      lookups++;
      return owner(id);
    },
    { audit },
  );
  ok(direct === PAGE_A2 && lookups === 0, "a directly-rostered page id is admitted by id alone (no parent lookup)");

  rows.length = 0;
  await assert.rejects(
    () => assertNotionPageAllowedOrResolveBlock(ctxFor(PAGE_A), UNRESOLVABLE, DOMAINS, owner, { audit }),
    (err: unknown) => {
      ok(err instanceof ChannelScopeError, "an unresolvable id is refused with ChannelScopeError");
      ok((err as Error).message.includes("block id"), "the refusal names the block-id possibility (residual-arm wording)");
      return true;
    },
    "an unresolvable id (not a block Notion can place) is refused",
  );
  ok(rows.length === 1 && rows[0]!.detail?.reason === "page-block-unresolvable", "the unresolvable refusal is audited under its own reason");
  ok(rows[0]!.detail?.target === UNRESOLVABLE && rows[0]!.detail?.resolvedPage === null, "the row records the ORIGINAL id and resolvedPage:null (attempted, found nothing)");

  rows.length = 0;
  await assert.rejects(
    () => assertNotionPageAllowedOrResolveBlock(ctxFor(PAGE_A), FOREIGN_BLOCK, DOMAINS, owner, { audit }),
    ChannelScopeError,
    "a block owned by ANOTHER domain's page stays refused — resolution is not a bypass",
  );
  ok(rows.length === 1 && rows[0]!.detail?.reason === "page-via-block:cross-domain", "…audited as a page-via-block cross-domain");
  ok(rows[0]!.detail?.target === FOREIGN_BLOCK && rows[0]!.detail?.resolvedPage === PAGE_B, "the row shows the HOP: the original id AND the page it resolved to");
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
  delete process.env.NOTION_CHANNEL_API_KEY;
  const FOREIGN = "ffffffff-1111-4111-8111-ffffffffffff";
  const turn = ctxFor(PAGE_A);

  for (const [name, entry] of [
    ["read_notion_page", readNotionPageEntry],
    ["read_notion_comments", readNotionCommentsEntry],
  ] as const) {
    let err: unknown;
    try {
      await (entry as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute({ page: FOREIGN }, turn);
    } catch (e) {
      err = e;
    }
    if (!(err instanceof ChannelScopeError)) console.error(`  [debug] ${name} threw:`, err);
    ok(err instanceof ChannelScopeError, `${name} refuses an out-of-domain page through the FENCE (not the missing-key error)`);
  }
}

{
  const nodeRequire = createRequire(import.meta.url);
  const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
  const eveAbs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
  const { ContextContainer, contextStorage } = await import(eveAbs("dist/src/context/container.js"));
  const { SessionKey } = await import(eveAbs("dist/src/context/keys.js"));

  const PAGE_TITLE = "Payments rollout plan";
  const PAGE_URL = `https://www.notion.so/${PAGE_A.replace(/-/g, "")}`;
  resetBrokers();
  registerBroker("test", {
    async getSecret(ref) {
      if (ref === "test:notion:chat") return "fake-chat-token";
      throw new Error(`no secret for ${ref}`);
    },
  });
  resetRegisteredConnectorCredentials();
  setRegisteredConnectorCredentials([
    { connector: "notion", allows: ["api-key"], credentials: [{ id: "channel-key", type: "api-key", secretRef: "test:notion:chat", broker: "test", intake: false }] },
  ]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/v1/pages/")) {
      return new Response(JSON.stringify({ url: PAGE_URL, properties: { "Some Name": { type: "title", title: [{ plain_text: PAGE_TITLE }] } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "ship on Thursday" }] } }], has_more: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    const TURN = "turn-provenance-door";
    const container = new ContextContainer();
    container.set(SessionKey, { sessionId: "notion-read-scope-test", auth: null, turn: 1, parent: undefined });
    const { out, reads } = await contextStorage.run(container, async () => {
      const result = (await (readNotionPageEntry as unknown as { execute: (i: unknown, c: unknown) => Promise<Record<string, unknown>> }).execute(
        { page: PAGE_A },
        ctxForTurn(PAGE_A, TURN),
      )) as { text: string; title?: string; url?: string };
      return { out: result, reads: connectorReadsThisTurn(TURN) };
    });
    ok(out.text.includes("ship on Thursday"), "§7 precondition: the fake Notion served the page body");
    ok(out.title === PAGE_TITLE, `🔴 OPE-1714: execute returns the page's TITLE, found by property type (saw: ${JSON.stringify(out.title)})`);
    ok(out.url === PAGE_URL, `🔴 OPE-1714: …and Notion's own url for it, never one assembled here (saw: ${JSON.stringify(out.url)})`);
    const rendered = (await (readNotionPageEntry as unknown as { toModelOutput: (o: unknown) => Promise<{ value: string }> }).toModelOutput(out)).value;
    ok(rendered.includes(PAGE_TITLE) && rendered.includes(PAGE_URL), "🔴 OPE-1714: …and the model sees both on the header line");
    ok(reads.length === 1, `🔴 the tool writes exactly ONE reply-provenance entry for the read it made (saw ${reads.length})`);
    ok(
      reads[0]?.connection === "notion" && reads[0]?.op === "read_notion_page",
      `🔴 …under the connection and op CORE picks for this kind, never a label the provider chose (saw: ${JSON.stringify({ connection: reads[0]?.connection, op: reads[0]?.op })})`,
    );
    ok(
      reads[0]?.record?.kind === "notion-page" && reads[0]?.record?.id === PAGE_A,
      `🔴 …carrying the RECORD, because the turn was woken on this very page (saw: ${JSON.stringify(reads[0]?.record)})`,
    );
  } finally {
    globalThis.fetch = realFetch;
    resetRegisteredConnectorCredentials();
    resetBrokers();
  }
}

{
  const nodeRequire = createRequire(import.meta.url);
  const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
  const eveAbs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
  const { ContextContainer, contextStorage } = await import(eveAbs("dist/src/context/container.js"));
  const { SessionKey } = await import(eveAbs("dist/src/context/keys.js"));

  const PAGE_TITLE = "Payments rollout plan";
  const PAGE_URL = `https://www.notion.so/${PAGE_A.replace(/-/g, "")}`;
  resetBrokers();
  registerBroker("test", {
    async getSecret(ref) {
      if (ref === "test:notion:chat") return "fake-chat-token";
      throw new Error(`no secret for ${ref}`);
    },
  });
  resetRegisteredConnectorCredentials();
  setRegisteredConnectorCredentials([
    { connector: "notion", allows: ["api-key"], credentials: [{ id: "channel-key", type: "api-key", secretRef: "test:notion:chat", broker: "test", intake: false }] },
  ]);
  const realFetch = globalThis.fetch;
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/v1/pages/")) return json({ url: PAGE_URL, properties: { Name: { type: "title", title: [{ plain_text: PAGE_TITLE }] } } });
    if (url.includes("/v1/blocks/") && !url.includes("/children")) return json({ object: "block", id: PAGE_A, parent: { type: "page_id", page_id: PAGE_A } });
    return json({ results: [], has_more: false });
  }) as unknown as typeof fetch;
  try {
    const exec = readNotionCommentsEntry as unknown as { execute: (i: unknown, c: unknown) => Promise<Record<string, unknown>> };
    const readsFor = async (input: Record<string, unknown>, turnId: string) => {
      const container = new ContextContainer();
      container.set(SessionKey, { sessionId: "notion-read-scope-test", auth: null, turn: 1, parent: undefined });
      return contextStorage.run(container, async () => {
        await exec.execute(input, ctxForTurn(PAGE_A, turnId));
        return connectorReadsThisTurn(turnId);
      });
    };
    const reads = await readsFor({ page: PAGE_A }, "turn-comments-door");
    ok(reads.length === 1, `🔴 OPE-2543: read_notion_comments writes ONE reply-provenance entry for its read (saw ${reads.length})`);
    ok(
      reads[0]?.connection === "notion" && reads[0]?.op === "read_notion_comments",
      `🔴 …under its OWN op name, so the durable row says which tool read (saw: ${JSON.stringify({ connection: reads[0]?.connection, op: reads[0]?.op })})`,
    );
    ok(reads[0]?.cite?.kind === "notion-page" && reads[0]?.cite?.id === PAGE_A, `🔴 …and it may CITE the page, whose title and url the identity read returned (saw: ${JSON.stringify(reads[0]?.cite)})`);
    ok(reads[0]?.record?.id === PAGE_A, "…and the turn woken on this page records it (rule ii)");
    const drill = await readsFor({ page: PAGE_A, block: PAGE_A2 }, "turn-comments-block");
    ok(drill.length === 1 && drill[0]?.op === "read_notion_comments", "a `block` drill-in still names `notion`");
    ok(drill[0]?.cite === undefined, "🔴 NEGATIVE CONTROL: a `block` drill-in CITES nothing — it never opened the page");
  } finally {
    globalThis.fetch = realFetch;
    resetRegisteredConnectorCredentials();
    resetBrokers();
  }
}

console.log(`✓ ${passed} notion read-scope assertions passed`);

// proves: TOOL-read_notion_comments, TOOL-read_notion_page

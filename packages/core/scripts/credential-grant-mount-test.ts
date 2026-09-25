import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-mount-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import {
  borrowScopeDigest,
  GRANT_REFUND_CAP_PER_TURN,
  registerGrantBorrowTransport,
  registerGrantRoomNotice,
  runGrantedCall,
} from "../agent/access/credential-grant-broker.js";
import { _resetGrantBorrowTransportsForTest } from "../agent/access/grant-borrow-transport-registry.internal.js";
import { _resetGrantRoomNoticeForTest } from "../agent/access/grant-room-notice-registry.internal.js";
import { McpCallFenceError } from "../agent/access/mcp-call-fence.js";
import { setRegisteredConnectorCredentials, vercelConnectorHome } from "../agent/access/connector-credentials.js";
import { selectConnectorTransport } from "../agent/connections/connector-transport.js";
import { grantMcpTransport } from "../agent/connections/grant-mcp-transport.js";
import { fakeMcpServer } from "./_fake-mcp-server.js";
import { approveCredentialGrant, askForCredentialGrant, revokeCredentialGrant } from "../agent/access/credential-grant-flow.js";
import { GRANT_STANDING_MAX_MS } from "../agent/access/credential-grant.js";
import { _resetDynamicVariantsForTest, mountedEntryCollisions, preRegisterDynamicEntry, registerDynamicVariant, type ReplayableToolEntry } from "../agent/access/window-gated.js";
import { registerPostArm, type DirectMessageRequest } from "../agent/channels/post-arms.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { resolvePartition } from "../agent/memory/partition.js";
import grantTools, { grantToolEntry, mountGrantEntries, requesterKeyForGrantCall } from "../agent/tools/grant_tools.js";
import { readAudit } from "../agent/audit/audit.js";
import { parsePrincipalKey } from "../agent/identity/principal-key.js";
import { recordRequesterIdentity } from "../agent/access/requester-identity.js";
import { grantBorrowResourceLabel } from "../agent/operational/credential-grant-rows.js";
import { connectorReadsThisTurn } from "../agent/channels/reply-provenance.js";
import { BORROWED_READ_OP, BORROWED_RECORD_KIND } from "../agent/channels/read-reach.js";
import { windowGrainOf, type BindableContext } from "../agent/identity/binding.js";
import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const NOW = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();

const seatCtx = (sessionId: string): unknown => ({
  channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:g3" },
  session: {
    auth: { current: { attributes: { oe_grain: "standing" } } },
    id: `worker-of-${sessionId}`,
    parent: { callId: "call-1", sessionId },
  },
});

const ORG = resolvePartition(seatCtx("probe") as never).org;
const stamps = { org: ORG, platform: "slack", surface: "slack/W1/C1", workspace: "W1" };

const delivered: DirectMessageRequest[] = [];
registerPostArm({
  async deliverDirectMessage(input) {
    delivered.push(input);
    return { messageId: `m-${delivered.length}`, surfaceId: "D-owner" };
  },
  platform: "slack",
});

_resetGrantBorrowTransportsForTest();
_resetGrantRoomNoticeForTest();
_resetDynamicVariantsForTest();

const MCP_URL = "https://mcp.notion.com/mcp";
const VENDOR_TOOL = "notion-fetch";
const VENDOR_SCHEMA = { properties: { id: { type: "string" }, page_size: { type: "number" } }, required: ["id"], type: "object" } as const;
const GRANT_NAME = "grant__rowan_hale_notion__notion_fetch_launch_page";

setRegisteredConnectorCredentials([
  {
    allows: ["user-oauth"],
    connector: "notion",
    credentials: [{ endpoints: { hosts: ["mcp.notion.com"] }, home: vercelConnectorHome("mcp.notion.com/notion-mcp"), id: "user-oauth", type: "user-oauth" }],
  },
]);
selectConnectorTransport({ connector: "notion", directUrl: MCP_URL, provider: "notion" });
const vendor = fakeMcpServer({ tools: [{ inputSchema: VENDOR_SCHEMA, name: VENDOR_TOOL }] });
const BORROW_DEPS = { fetch: vendor.fetch, mintOwnerToken: async (): Promise<string> => "OWNER-TOKEN" };

const sent: { mcpTool: string; input: Record<string, unknown> }[] = [];
registerGrantBorrowTransport("notion", async (call) => {
  sent.push({ input: { ...call.input }, mcpTool: call.mcpTool });
  return { blocks: ["one", "two"] };
}, "test:credential-grant-mount");

const roomLines: string[] = [];
registerGrantRoomNotice(async (line) => {
  roomLines.push(line);
  return { posted: true };
}, "test:credential-grant-mount");

const DOMAIN_KEY = "oe-grant-domain::mount-test";

const askInput = (scopeKey: string, mode: "once" | "session" | "standing", domainScopeKey?: string) => ({
  ...stamps,
  connector: "notion",
  ...(domainScopeKey === undefined ? {} : { domainScopeKey }),
  domainGrantsConnector: true,
  explicit: false,
  nowMs: NOW,
  ownerHandle: "Rowan Hale",
  ownerNativeId: "U-owner",
  ownerPlatform: "slack",
  ownerPrincipalId: "slack/W1/U-owner",
  purpose: "draft the Q3 summary",
  requestedMode: mode,
  requesterLabel: "Ada",
  requesterPrincipalId: "slack/W1/U-req",
  frozenArgs: { id: "abc123" },
  mcpTool: VENDOR_TOOL,
  scopeKey,
  targetLabel: "Launch page",
});

const REQUESTER_ENVELOPE = '<message trigger="true" from="human" author-id="slack/W1/U-req">quote one sentence from this page</message>';

const callCtx = (scopeKey: string, nowMs = NOW + 1000, turnId?: string) => ({
  ...stamps,
  nowMs,
  requesterPrincipalId: "slack/W1/U-req",
  scopeKey,
  ...(turnId === undefined ? {} : { turnId }),
});

class FakeSession {
  private readonly store = new Map<string, unknown>();
  get<T>(key: { name: string }): T | undefined {
    return this.store.get(key.name) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.store.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`missing ${key.name}`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
    const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
    this.store.set(key.name, next);
    return next;
  }
  ensure<T>(key: { name: string }, create: () => T): T {
    return this.has(key) ? this.require(key) : this.set(key, create());
  }
  clearVirtualContext(): void {}
  setVirtualContext(): void {}
  *entries(): Generator<readonly [unknown, unknown]> {}
}

function eveContextStorage(): AsyncLocalStorage<unknown> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return g[key] as AsyncLocalStorage<unknown>;
}

async function inSession<T>(session: FakeSession, fn: () => T | Promise<T>): Promise<T> {
  return eveContextStorage().run(session, fn);
}

console.log("1. ask -> owner card -> approve -> mount -> compose -> audit:");

const store = getOperationalStore();
const grantIds: Record<string, string> = {};

for (const mode of ["once", "session"] as const) {
  const scopeKey = `session-${mode}`;
  const before = delivered.length;
  const ask = await askForCredentialGrant(askInput(scopeKey, mode, DOMAIN_KEY));
  ok(ask.sent, `[${mode}] the ask is SENT, not blocked on the owner — the requester's turn must not wait on a human elsewhere`);
  eq(delivered.length, before + 1, `[${mode}] exactly one card was delivered`);
  const card = delivered[delivered.length - 1];
  eq(card.principalId, "U-owner", `[${mode}] the card went to the OWNER's DM, never to the requesting room`);
  eq(card.actions?.length, 4, `[${mode}] the card carries the four mode buttons`);

  const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", mode, "slack/W1/U-owner", NOW + 500, undefined, BORROW_DEPS);
  ok(approved.approved, `[${mode}] the owner's approval mints a grant`);
  const grant = approved.approved ? approved.grant : undefined;
  eq(grant?.mode, mode, `[${mode}] the row records the mode the owner PRESSED, not the one the requester suggested`);
  eq(grant?.tier, "read", `[${mode}] the tier is the connector-op classifier answer for this vendor tool, pinned at mint`);
  grantIds[mode] = grant?.id ?? "";

  const mounted = (await (grantTools as { events: Record<string, (e: unknown, c: unknown) => Promise<unknown>> }).events["session.started"](
    { type: "session.started" },
    seatCtx(scopeKey),
  )) as Record<string, ReplayableToolEntry> | null;
  ok(mounted !== null && Object.keys(mounted).length === 1, `[${mode}] the resolver mounts exactly one tool for this chat`);
  eq(Object.keys(mounted ?? {}), [GRANT_NAME], `[${mode}] mounted under the name the ASK pinned -- owner, connector, tool slug and target label`);

  const throughMount = (await mounted![GRANT_NAME].execute({ page_size: 10 }, seatCtx(scopeKey))) as { ok: boolean; refused?: string };
  eq(throughMount.ok ? "OK" : throughMount.refused, "unverified_requester", `[${mode}] the mounted entry reaches the broker and FAILS CLOSED with no verified requester`);

  const sentBefore = sent.length;
  const result = (await runGrantedCall(grantIds[mode], { id: "abc123", page_size: 10 }, callCtx(scopeKey))) as {
    ok: boolean;
    disclosure?: string;
    result?: unknown;
  };
  ok(result.ok, `[${mode}] the granted call succeeds`);
  eq(sent.length, sentBefore + 1, `[${mode}] the broker sent exactly one vendor call`);
  eq(sent[sent.length - 1].mcpTool, VENDOR_TOOL, `[${mode}] naming the vendor tool the ROW lends, in the vendor's own bytes`);
  eq(sent[sent.length - 1].input, { id: "abc123", page_size: 10 }, `[${mode}] and carrying the model's arguments UNCHANGED -- the broker injects nothing`);
  const line = result.disclosure ?? "";
  ok(line.startsWith("acting as rowan_hale — "), `[${mode}] the result carries the HOST-AUTHORED acting-as line the model cannot write`);
  ok(line.includes("Notion account to read a Notion page"), `[${mode}] …naming the account that paid and what it did, in words`);
  ok(/for the next \d+ (minute|hour|day)s? \(until/u.test(line), `[${mode}] …and how long is left as a span, never the row's ISO expiry`);
  ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(line), `[${mode}] NEGATIVE CONTROL: no ISO instant survives into the room's most-read line`);
  ok(roomLines[roomLines.length - 1] === result.disclosure, `[${mode}] …and the same line went to the room notice arm, so the room sees it independently of what the model relays`);
}

console.log("   the standing mode:");
{
  const keyed = await askForCredentialGrant(askInput("session-standing", "standing", DOMAIN_KEY));
  ok(keyed.sent, "[standing] the ask is sent");
  eq(delivered[delivered.length - 1].actions?.length, 4, "[standing] a DOMAIN-KEYED ask's card carries the four mode buttons");
  const approved = await approveCredentialGrant(stamps, keyed.sent ? keyed.askId : "", "standing", "slack/W1/U-owner", NOW + 500, undefined, BORROW_DEPS);
  ok(approved.approved, "[standing] the owner's approval mints a grant");
  const grant = approved.approved ? approved.grant : undefined;
  eq(grant?.scopeKey, DOMAIN_KEY, "🔴 [standing] …bound to the DOMAIN key, never to the asking session");
  eq(Date.parse(grant?.expiresAt ?? "") - (NOW + 500), GRANT_STANDING_MAX_MS, "[standing] …for the full 30-day ceiling measured from the TAP, unchanged");
  const spent = (await runGrantedCall(grant?.id ?? "", { id: "abc123", page_size: 10 }, { ...callCtx("session-standing"), domainScopeKey: DOMAIN_KEY })) as { ok: boolean; refused?: string };
  ok(spent.ok, `🔴 [standing] …and the row is spendable from a seat that resolves the same domain key (got ${String(spent.ok ? "ok" : spent.refused)})`);
  eq((await store.getCredentialGrant(ORG, grant?.id ?? ""))?.status, "active", "[standing] …and it did NOT burn, like the session mode and unlike once");

  const keyless = await askForCredentialGrant(askInput("session-standing-keyless", "standing"));
  ok(keyless.sent, "[standing/keyless] the ask is still SENT — the ask verb is unchanged, only the answers on offer are");
  eq(delivered[delivered.length - 1].actions?.length, 3, "🔴 [standing/keyless] …and the card carries THREE buttons: no 30-day answer is offered");
  ok(
    !(delivered[delivered.length - 1].actions ?? []).some((a) => a.id.includes(":standing:")),
    "🔴 [standing/keyless] …no button names the standing answer at all",
  );
  const refused = await approveCredentialGrant(stamps, keyless.sent ? keyless.askId : "", "standing", "slack/W1/U-owner", NOW + 500, undefined, BORROW_DEPS);
  ok(!refused.approved && refused.reason === "standing_unavailable", `🔴 [standing/keyless] a tap that names it anyway is REFUSED by name (got ${String(refused.approved ? "approved" : refused.reason)})`);
  eq((await store.credentialGrantsForScope(ORG, "session-standing-keyless")).length, 0, "🔴 [standing/keyless] …and NOTHING was bound — no row at all, rather than a narrower one");
  eq((await store.getCredentialGrantAsk(ORG, keyless.sent ? keyless.askId : ""))?.status, "pending", "[standing/keyless] …while the ask stays PENDING, so the owner can still answer one of the arms it did offer");
  const narrowed = await approveCredentialGrant(stamps, keyless.sent ? keyless.askId : "", "session", "slack/W1/U-owner", NOW + 600, undefined, BORROW_DEPS);
  ok(narrowed.approved, "🔴 [standing/keyless] NEGATIVE CONTROL: the SAME ask still approves as `session` — the refusal is the standing mode's alone, not a broken ask");
}

{
  eq((await store.getCredentialGrant(ORG, grantIds.once))?.status, "used", "the ONCE grant burned on its first call");
  eq((await store.getCredentialGrant(ORG, grantIds.session))?.status, "active", "the SESSION grant did NOT burn — the mode is what decides, not the call");
}

console.log("   audit rows:");
{
  const rows = await readAudit({ org: ORG });
  const actions = rows.map((r) => r.action);
  for (const action of ["grant.asked", "grant.granted", "grant.used"]) {
    ok(actions.includes(action), `the log carries a ${action} row`);
  }
  const used = rows.find((r) => r.action === "grant.used");
  const detail = (used?.detail ?? {}) as Record<string, unknown>;
  eq(used?.principalId, "slack/W1/U-req", "the grant.used row is stamped with the REQUESTER — a granted act is the requester's act");
  eq(detail.owner, "slack/W1/U-owner", "…and the SAME ROW names the owner whose credential paid for it (both principals, one row)");
  eq(detail.tier, "read", "…and the tier it was minted at");
  ok(typeof detail.scopeDigest === "string" && !(detail.scopeDigest as string).includes("abc123"), "…and a coarse scope DIGEST, never the composed request: the page id is not in the log");
  ok(!JSON.stringify(detail).includes("one") || !JSON.stringify(detail).includes("blocks"), "…and never the vendor OUTPUT");
}

console.log("2. the granted argument is const-pinned in the schema, not hidden from the model:");
{
  const grants = await store.credentialGrantsForScope(ORG, "session-session");
  const mounted = mountGrantEntries(grants);
  const entry = mounted[GRANT_NAME] as unknown as { description: string; inputSchema: { properties: Record<string, unknown>; required?: unknown } };
  eq(Object.keys(entry.inputSchema.properties).sort(), ["id", "page_size"], "the mounted schema keeps the vendor's OWN properties — the granted one is not subtracted");
  eq(entry.inputSchema.properties["id"], { const: "abc123", type: "string" }, "…and the granted argument carries a JSON Schema `const` of the value the grant fixed");
  eq(entry.inputSchema.required, ["id"], "…and it is REQUIRED, because the model has to SUPPLY it — the fence then validates what it sent");
  eq(entry.inputSchema.properties["page_size"], { type: "number" }, "…while the free argument is left exactly as the vendor declared it");
  ok(entry.description.includes("1 argument(s) are FIXED"), "the description names how many arguments are fixed…");
  ok(entry.description.includes("refused before"), "…and says plainly that sending any other value is refused");

  const sentBefore = sent.length;
  await runGrantedCall(grantIds.session, { id: "SOME-OTHER-PAGE", page_size: 10 }, callCtx("session-session"));
  eq(sent.length, sentBefore + 1, "the call with a widening argument still reaches the transport");
  eq(sent[sent.length - 1].input, { id: "SOME-OTHER-PAGE", page_size: 10 }, "…with the model's own value intact — the broker does not silently correct it");

  eq(
    borrowScopeDigest(MCP_URL, VENDOR_TOOL, { id: "SOME-OTHER-PAGE", page_size: 10 }, { id: "abc123" }),
    "mcp mcp.notion.com tools/call notion-fetch keys:id,page_size",
    "the audit digest carries the argument NAMES and the host, never a value",
  );
}

console.log("2b. the mounted description names the pin and points elsewhere for anything else:");
{
  const grants = await store.credentialGrantsForScope(ORG, "session-session");
  const entry = mountGrantEntries(grants)[GRANT_NAME] as unknown as { description: string };
  const d = entry.description;
  ok(d.includes('reads exactly the Notion page "Launch page"'), "🔴 the description names the PINNED target in plain words — the requester's own label, which is what the owner approved and what the room's grant-use notice already says");
  ok(d.includes("and nothing else"), "…and says the tool reads that one target and nothing else");
  ok(d.includes("Use this organisation's own Notion connector for any other Notion page"), "🔴 …and names the OTHER ROAD by name, so a model asked about a different page has somewhere to go");
  ok(d.includes("never present it as any other Notion page"), "🔴 …and forbids the misattribution the boards measured — the tool's bytes describe the pinned page alone");
  ok(d.indexOf("PINNED TO ONE TARGET") < d.indexOf("argument(s) are FIXED"), "…and the pin is stated BEFORE the fixed-argument mechanics, which is the order a reader takes them in");

  const pinned = grants.find((g) => g.toolName === GRANT_NAME);
  ok(pinned !== undefined, "§2b precondition: the pinned row is readable");
  const unpinned = grantToolEntry({ ...pinned!, frozenArgs: {} }, NOW) as unknown as { description: string };
  ok(!unpinned.description.includes("PINNED TO ONE TARGET"), "🔴 a grant that fixes NO arguments states no pin — the copy is conditional on the freeze, exactly as the owner's card is");
  ok(unpinned.description.includes("This grant fixes no arguments"), "…and still says out loud that nothing is pinned, which is the wider ask");

  const partial = grantToolEntry({ ...pinned!, frozenArgs: { page_size: 5 } }, NOW) as unknown as { description: string };
  ok(!partial.description.includes("PINNED TO ONE TARGET"), "🔴 a grant that freezes some OTHER argument and leaves the TARGET free states no pin — the sentence is gated on the target, never on how many keys are frozen");
  ok(partial.description.includes("1 argument(s) are FIXED"), "…and still names the argument it did fix, which is true");

  const unreviewed = grantToolEntry(
    { ...pinned!, mcpTool: "notion-search", resource: grantBorrowResourceLabel("Launch page", "notion-search", pinned!.frozenArgs ?? {}) },
    NOW,
  ) as unknown as { description: string };
  ok(!unreviewed.description.includes("PINNED TO ONE TARGET"), "🔴 an UNREVIEWED vendor tool claims no pin — the host cannot name which argument is that tool's target, and it says nothing rather than guessing");
  ok(unreviewed.description.includes("no reviewed description for the exact Notion tool"), "…and the unreviewed marker still fires, which is the honest thing it CAN say");
}

console.log("3. two sessions, one mounted name, the installed eve:");
const require2 = createRequire(import.meta.url);
const eveRoot = dirname(require2.resolve("eve/package.json"));
const distUrl = (rel: string): string => pathToFileURL(join(eveRoot, "dist", "src", rel)).href;
const lifecycle = (await import(distUrl("context/dynamic-tool-lifecycle.js"))) as {
  validateDurableDynamicToolCallbacks(name: string, entry: unknown, owner: Record<string, unknown>): { execute: { closure: Record<string, unknown> } };
};
const durable = (await import(distUrl("tools/durable-callbacks.js"))) as {
  lookupDurableDynamicCallback(owner: Record<string, unknown>, phase: string): ((closure: Record<string, unknown>, ...args: unknown[]) => unknown) | undefined;
};
const ownerFor = (name: string): Record<string, unknown> => ({ sessionId: "sess-credential-grant-mount", scope: "session", resolverSlug: name, entryKey: "_single", name });


{
  const NAME = "grant__pat__read_page";
  const alpha: ReplayableToolEntry = { execute: () => "GRANT-ALPHA" };
  const beta: ReplayableToolEntry = { execute: () => "GRANT-BETA" };
  registerDynamicVariant(NAME, "grant-alpha", alpha);
  const variantOwner = ownerFor(NAME);
  const alphaClosure = lifecycle.validateDurableDynamicToolCallbacks(NAME, alpha, variantOwner).execute.closure;
  registerDynamicVariant(NAME, "grant-beta", beta);
  lifecycle.validateDurableDynamicToolCallbacks(NAME, beta, variantOwner);
  eq(alphaClosure, { entryKey: "grant-alpha" }, "eve persists the GRANT ID in session A's durable closure");
  const bound = durable.lookupDurableDynamicCallback(variantOwner, "execute");
  ok(typeof bound === "function", "eve bound one callback under the mounted name's owner scope");
  eq(bound!(alphaClosure), "GRANT-ALPHA", "a replay driven from session A's closure runs session A's GRANT, though session B registered LAST");
  eq(bound!({ entryKey: "grant-beta" }), "GRANT-BETA", "…and session B's closure still runs session B's grant");
  assert.throws(() => bound!({}), /no variant key in its durable closure/u, "a closure with no grant id FAILS CLOSED — guessing which credential to spend is the defect this exists for");
  n++;
}

{
  const NAME = "grant__pat__collided_read";
  const alpha: ReplayableToolEntry = { execute: () => "GRANT-ALPHA" };
  const beta: ReplayableToolEntry = { execute: () => "GRANT-BETA" };
  preRegisterDynamicEntry(NAME, NAME, alpha);
  preRegisterDynamicEntry(NAME, NAME, beta);
  const collidedOwner = ownerFor(NAME);
  const alphaClosure = lifecycle.validateDurableDynamicToolCallbacks(NAME, alpha, collidedOwner).execute.closure;
  lifecycle.validateDurableDynamicToolCallbacks(NAME, beta, collidedOwner);
  const bound = durable.lookupDurableDynamicCallback(collidedOwner, "execute");
  eq(bound!(alphaClosure), "GRANT-BETA", "the pre-fix shape runs the WRONG grant from session A's closure — the measured defect, reproduced with a credential behind it");
}

console.log("4. mountedEntryCollisions over the grant names:");
{
  const collisions = mountedEntryCollisions();
  const managed = collisions.find((c) => c.name === "grant__pat__read_page");
  ok(managed !== undefined, "the grant name with two variants is reported as a multi-entry name");
  ok(managed!.variantManaged, "…and it is VARIANT-MANAGED, which is what the offline gate requires");
  eq(managed!.distinctExecuteCallbacks, 1, "…resolving to exactly ONE execute callback — a second would mean a descriptor was not overwritten");
  const unmanaged = collisions.filter((c) => !c.variantManaged).map((c) => c.name);
  eq(unmanaged, ["grant__pat__collided_read"], "the ONLY unmanaged collision is the deliberate negative control above");
}

console.log("5. once-mode under concurrency, through the broker:");
{
  const ask = await askForCredentialGrant(askInput("session-race", "once"));
  const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", "once", "slack/W1/U-owner", NOW + 500, undefined, BORROW_DEPS);
  const grantId = approved.approved ? approved.grant.id : "";
  const sentBefore = sent.length;
  const results = await Promise.all([
    runGrantedCall(grantId, {}, callCtx("session-race")),
    runGrantedCall(grantId, {}, callCtx("session-race")),
  ]);
  eq(results.filter((r) => r.ok).length, 1, "two CONCURRENT granted calls on a once grant: exactly ONE reaches the vendor");
  eq(sent.length, sentBefore + 1, "…and exactly ONE vendor request was sent — the burn is before the call, so a double-spend cannot slip through");
  const refused = results.find((r) => !r.ok);
  eq(refused && !refused.ok ? refused.refused : "", "burned", "…and the loser refuses `burned`, naming the boundary");
}

console.log("6. revoke, out-of-scope, no transport, unverified requester:");
{
  const grantId = grantIds.session;
  eq(await revokeCredentialGrant(stamps, grantId, "slack/W1/U-owner", "thread", NOW + 2000), true, "the owner revokes the live session grant");
  const refused = await runGrantedCall(grantId, {}, callCtx("session-session", NOW + 3000));
  eq(refused.ok ? "OK" : refused.refused, "revoked", "the granted call now refuses `revoked`");
  ok(!refused.ok && refused.message.includes("revoked this grant") && refused.message.includes("Do not retry"), "…with copy that names WHO ended it and tells the model not to retry");

  const mounted = (await (grantTools as { events: Record<string, (e: unknown, c: unknown) => Promise<unknown>> }).events["session.started"](
    { type: "session.started" },
    seatCtx("session-session"),
  )) as Record<string, ReplayableToolEntry> | null;
  eq(Object.keys(mounted ?? {}), [GRANT_NAME], "the REVOKED grant's tool is still mounted — mount on existence, refuse on state");
}

{
  const ask = await askForCredentialGrant(askInput("session-scope", "session"));
  const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", "session", "slack/W1/U-owner", NOW + 500, undefined, BORROW_DEPS);
  const grantId = approved.approved ? approved.grant.id : "";
  const wrongRoom = await runGrantedCall(grantId, {}, callCtx("some-other-session"));
  eq(wrongRoom.ok ? "OK" : wrongRoom.refused, "out_of_scope", "a granted call from ANOTHER chat refuses `out_of_scope` — L0 holds at execute, not only at mount");
  const noRequester = await runGrantedCall(grantId, {}, { ...callCtx("session-scope"), requesterPrincipalId: undefined });
  eq(noRequester.ok ? "OK" : noRequester.refused, "unverified_requester", "a turn with no single verified requester refuses — nobody could be recorded as having spent the credential");

  _resetGrantBorrowTransportsForTest();
  const noTransport = await runGrantedCall(grantId, {}, callCtx("session-scope"));
  eq(noTransport.ok ? "OK" : noTransport.refused, "no_transport", "a connector with no registered transport refuses `no_transport`");
  eq((await store.getCredentialGrant(ORG, grantId))?.status, "active", "…and the grant is NOT spent by a deployment that could never have sent the request");
}

console.log("7. the requester key grammar (OPE-1090):");
{
  const requester = requesterKeyForGrantCall("discord", "unused-on-a-non-tenant-platform", { kind: "requester", principalId: "9000000000000000042" });
  eq(requester, "discord/9000000000000000042", "a bare native id composes into a QUALIFIED principal key, never the bare id the wake envelope carries");
  ok(requester !== undefined && parsePrincipalKey(requester) !== undefined, "…and the composed key PARSES as a principal key");

  const owner = "slack/T0EXAMPLE/U0BFOPE1081OWNER";
  ok(parsePrincipalKey(owner) !== undefined && requester !== undefined && parsePrincipalKey(requester) !== undefined, "the owner half and the requester half both parse as principal keys — joinable in one row");

  const tenantScoped = requesterKeyForGrantCall("slack", "T1", { kind: "requester", principalId: "U-req" });
  eq(tenantScoped, "slack/T1/U-req", "a TENANT-SCOPED platform composes the three-segment key, the same shape the owner half already carries");

  eq(requesterKeyForGrantCall("slack", "dev", { kind: "requester", principalId: "U-req" }), undefined, "an UNNAMED tenant refuses to compose — the broker reads this as `unverified_requester`, never a malformed key");

  eq(requesterKeyForGrantCall("discord", "w", { kind: "unverified", reason: "several people woke this turn" }), undefined, "an UNVERIFIED verdict still composes to undefined — this fix touches only the SHAPE of a named requester, not when one is named");
  eq(requesterKeyForGrantCall("discord", "w", { kind: "none" }), undefined, "…and a `none` verdict too");
}

console.log("8. a fence refusal refunds the once-mode burn (OPE-1198):");
{
  _resetGrantBorrowTransportsForTest();
  registerGrantBorrowTransport("notion", grantMcpTransport(BORROW_DEPS), "test:credential-grant-mount");

  const ask = await askForCredentialGrant(askInput("session-refund", "once"));
  const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", "once", "slack/W1/U-owner", NOW + 500, undefined, BORROW_DEPS);
  const grantId = approved.approved ? approved.grant.id : "";
  ok(grantId !== "", "a once-mode borrow grant is minted, frozen to page `abc123`");

  const wireBefore = vendor.seen.length;
  let refusal: unknown;
  await runGrantedCall(grantId, { id: "some-other-page" }, callCtx("session-refund")).then(
    () => ok(false, "the fence must refuse a call that does not carry the value the grant froze"),
    (err: unknown) => {
      refusal = err;
    },
  );
  ok(refusal instanceof McpCallFenceError, "the wrong pinned argument trips the REAL fence — which refuses before it calls the wrapped fetch");

  const wire = vendor.seen.slice(wireBefore);
  eq(wire.filter((r) => (r.body as Record<string, unknown> | undefined)?.["method"] === "tools/call").length, 0, "🔴 NO `tools/call` reached the wire — the granted action was never sent");
  ok(wire.some((r) => (r.body as Record<string, unknown> | undefined)?.["method"] === "initialize"), "…while the SDK's `initialize` DID: a refunded call still opens an authenticated session at the vendor, and nothing may claim otherwise");
  const afterTrip = await store.getCredentialGrant(ORG, grantId);
  eq(afterTrip?.status, "active", "🔴 the once grant is STILL ACTIVE — a refusal that dialled nothing does not spend the owner's approval");
  eq(afterTrip?.usedAt, undefined, "…and the burn stamp is cleared, so a later call can win the CAS rather than reading a used row");

  const good = await runGrantedCall(grantId, { id: "abc123" }, callCtx("session-refund"));
  ok(good.ok, "the SAME grant then serves the call that carries the frozen value");
  eq((await store.getCredentialGrant(ORG, grantId))?.status, "used", "…and THAT call burns it: the refund restored the approval, it did not remove the single-use bound");
  const second = await runGrantedCall(grantId, { id: "abc123" }, callCtx("session-refund"));
  eq(second.ok ? "OK" : second.refused, "burned", "…so a second call refuses `burned` — one shot is still one shot");

  const rows = await readAudit({ org: ORG });
  const undispatched = rows.filter((r) => r.action === "grant.refused" && (r.detail as Record<string, unknown>).gate === "undispatched");
  eq(undispatched.length, 1, "the refund writes exactly ONE closing row, naming the gate `undispatched`");
  const detail = (undispatched[0]?.detail ?? {}) as Record<string, unknown>;
  eq(detail.refunded, true, "…which records that the owner's approval actually came back");
  eq(detail.grantId, grantId, "…against the grant it re-opened");
  eq(detail.owner, "slack/W1/U-owner", "…naming the owner whose approval was NOT spent");
  ok(!JSON.stringify(detail).includes("some-other-page"), "…and it carries no argument VALUE, the same ids-and-names contract every row on this plane holds");
}

console.log("8b. a throw that cannot prove it sent nothing KEEPS the burn:");
{
  _resetGrantBorrowTransportsForTest();
  registerGrantBorrowTransport("notion", async () => {
    throw new Error("the vendor accepted the tools/call and the socket then died");
  }, "test:credential-grant-mount");
  const ask = await askForCredentialGrant(askInput("session-keepburn", "once"));
  const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", "once", "slack/W1/U-owner", NOW + 500, undefined, BORROW_DEPS);
  const grantId = approved.approved ? approved.grant.id : "";
  let threw = false;
  await runGrantedCall(grantId, { id: "abc123" }, callCtx("session-keepburn")).then(
    () => ok(false, "the transport's throw must reach the caller"),
    () => {
      threw = true;
    },
  );
  ok(threw, "the transport throws a plain Error — a failure that cannot tell a delivered call from a lost one");
  eq((await store.getCredentialGrant(ORG, grantId))?.status, "used", "🔴 the grant STAYS BURNED — the refund is fail-closed, and only a proven no-dispatch undoes a burn");
  const rows = await readAudit({ org: ORG });
  eq(
    rows.filter((r) => r.action === "grant.refused" && (r.detail as Record<string, unknown>).gate === "undispatched").length,
    1,
    "…and no second `undispatched` row was written: this failure is not one",
  );
}

console.log("9. the refund is capped per grant row per turn (OPE-1240):");
{
  _resetGrantBorrowTransportsForTest();
  registerGrantBorrowTransport("notion", grantMcpTransport(BORROW_DEPS), "test:credential-grant-mount");

  const mintOnce = async (scopeKey: string): Promise<string> => {
    const ask = await askForCredentialGrant(askInput(scopeKey, "once"));
    const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", "once", "slack/W1/U-owner", NOW + 500, undefined, BORROW_DEPS);
    return approved.approved ? approved.grant.id : "";
  };

  const tripFence = async (grantId: string, scopeKey: string, turnId: string): Promise<string> => {
    let refused: unknown;
    await runGrantedCall(grantId, { id: "some-other-page" }, callCtx(scopeKey, NOW + 1000, turnId)).then(
      () => {
        refused = undefined;
      },
      (err: unknown) => {
        refused = err;
      },
    );
    assert.ok(refused instanceof McpCallFenceError, `the wrong pinned argument must trip the real fence (grant ${grantId}, ${turnId})`);
    n++;
    return (await store.getCredentialGrant(ORG, grantId))?.status ?? "missing";
  };

  const CAPPED_SCOPE = "session-refund-cap-a";
  const SIBLING_SCOPE = "session-refund-cap-b";
  const ACROSS_SCOPE = "session-refund-cap-c";
  const capped = await mintOnce(CAPPED_SCOPE);
  const sibling = await mintOnce(SIBLING_SCOPE);
  const across = await mintOnce(ACROSS_SCOPE);
  ok(capped !== "" && sibling !== "" && across !== "" && new Set([capped, sibling, across]).size === 3, "three distinct once-mode grants are minted, each frozen to page `abc123`");

  const session = new FakeSession();

  await inSession(session, async () => {
    for (let attempt = 1; attempt <= GRANT_REFUND_CAP_PER_TURN; attempt++) {
      eq(await tripFence(capped, CAPPED_SCOPE, "turn_41"), "active", `refund ${attempt} of ${GRANT_REFUND_CAP_PER_TURN} still lands — the cap is an allowance, not a repeal of the refund`);
    }

    eq(await tripFence(capped, CAPPED_SCOPE, "turn_41"), "used", `🔴 refund ${GRANT_REFUND_CAP_PER_TURN + 1} is REFUSED — the row stays spent, so one owner approval cannot open an unbounded number of vendor sessions in one turn`);

    const afterCap = await runGrantedCall(capped, { id: "abc123" }, callCtx(CAPPED_SCOPE, NOW + 1000, "turn_41"));
    eq(afterCap.ok ? "OK" : afterCap.refused, "burned", "…and the model's NEXT call on that row refuses `burned` by name, through the state check that already runs before any burn");
    ok(!afterCap.ok && afterCap.message.length > 0 && !afterCap.message.includes("some-other-page"), "…with host-authored copy that carries no argument value");

    eq(await tripFence(sibling, SIBLING_SCOPE, "turn_41"), "active", "🔴 a DIFFERENT grant row in the SAME turn still refunds — the counters are keyed per row, so one row's exhaustion never spends another's");

    for (let attempt = 1; attempt <= GRANT_REFUND_CAP_PER_TURN; attempt++) {
      eq(await tripFence(across, ACROSS_SCOPE, "turn_41"), "active", `the third row spends allowance ${attempt} of ${GRANT_REFUND_CAP_PER_TURN} in this turn`);
    }
  });

  await inSession(session, async () => {
    eq(await tripFence(across, ACROSS_SCOPE, "turn_42"), "active", "🔴 the SAME row refunds again on a NEW turn — the allowance is per turn, and a count nothing rolled would have said `used` here");
  });

  {
    const REDELIVERED_SCOPE = "session-refund-cap-d";
    const redelivered = await mintOnce(REDELIVERED_SCOPE);
    ok(redelivered !== "", "a fourth once-mode grant is minted for the per-session-state guard");
    const crashed = new FakeSession();
    await inSession(crashed, async () => {
      for (let attempt = 1; attempt <= GRANT_REFUND_CAP_PER_TURN; attempt++) {
        eq(await tripFence(redelivered, REDELIVERED_SCOPE, "turn_43"), "active", `the first container spends allowance ${attempt} of ${GRANT_REFUND_CAP_PER_TURN}`);
      }
    });
    const replayed = new FakeSession();
    await inSession(replayed, async () => {
      eq(
        await tripFence(redelivered, REDELIVERED_SCOPE, "turn_43"),
        "used",
        "🔴 a FRESH eve container on the same turn is still refused — the count is stored beside the burn, so no per-session state can hand a replayed turn its allowance back",
      );
    });
  }

  {
    const UNCLAIMABLE_SCOPE = "session-refund-cap-e";
    const unclaimable = await mintOnce(UNCLAIMABLE_SCOPE);
    ok(unclaimable !== "", "a fifth once-mode grant is minted for the unanswerable-claim leg");
    const patchable = store as unknown as { claimCredentialGrantRefund: unknown };
    const realClaim = patchable.claimCredentialGrantRefund;
    patchable.claimCredentialGrantRefund = async (): Promise<boolean> => {
      throw new Error('column "refund_count" does not exist');
    };
    try {
      eq(await tripFence(unclaimable, UNCLAIMABLE_SCOPE, "turn_44"), "used", "🔴 a claim the store could not answer refunds NOTHING — the owner's approval stays spent rather than being handed back uncounted");
    } finally {
      patchable.claimCredentialGrantRefund = realClaim;
    }
    const unclaimedRows = (await readAudit({ org: ORG })).filter((r) => r.action === "grant.refused" && (r.detail as Record<string, unknown>).gate === "refund_unclaimed");
    eq(unclaimedRows.length, 1, "…and the chain still closes: exactly ONE `refund_unclaimed` row, so an approval spent on a call that never ran is never left unrecorded");
    const unclaimedDetail = (unclaimedRows[0]?.detail ?? {}) as Record<string, unknown>;
    eq(unclaimedDetail.grantId, unclaimable, "…naming the row whose approval stayed spent");
    eq(unclaimedDetail.refunded, false, "…and recording that the approval did NOT come back");
  }

  const rows = await readAudit({ org: ORG });
  const cappedRows = rows.filter((r) => r.action === "grant.refused" && (r.detail as Record<string, unknown>).gate === "refund_capped");
  eq(cappedRows.filter((r) => (r.detail as Record<string, unknown>).grantId === capped).length, 1, "exactly ONE `refund_capped` row for the row whose allowance ran out — the K+1'th attempt, and nothing after it");
  eq(cappedRows.length, 2, "…and one more, from the redelivered turn — so no OTHER call in this pack was capped by accident");
  const detail = (cappedRows.find((r) => (r.detail as Record<string, unknown>).grantId === capped)?.detail ?? {}) as Record<string, unknown>;
  eq(detail.grantId, capped, "…against the row whose allowance ran out");
  eq(detail.refunded, false, "…recording that the approval did NOT come back, which is what `refund_capped` means and `undispatched` does not");
  eq(detail.owner, "slack/W1/U-owner", "…and naming the owner whose approval stayed spent");
  ok(!JSON.stringify(detail).includes("some-other-page"), "…carrying no argument VALUE, the same ids-and-names contract every row on this plane holds");
  ok(
    rows.filter((r) => r.action === "grant.refused" && (r.detail as Record<string, unknown>).gate === "undispatched").length > 1,
    "…while the refunds that DID land still wrote `undispatched` rows: the two gates are a split, not a rename",
  );
}

console.log("9b. the mount hands the broker the turn the cap is keyed on:");
{
  const source = await readFile(new URL("../agent/tools/grant_tools.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function grantToolEntry");
  const after = source.indexOf("\nexport ", start + 1);
  ok(start >= 0 && after > start, "grantToolEntry is locatable and bounded in the source");
  const entry = source.slice(start, after);
  ok(/const turnId = currentTurnId\(c\)/u.test(entry), "the mounted execute reads the eve turn id…");
  const brokerCall = entry.slice(entry.indexOf("runGrantedCall("));
  ok(/turnId === undefined \? \{\} : \{ turnId \}/u.test(brokerCall), "…and spreads it into the BROKER's call context, which is the only thing that arms the per-turn cap on a real turn");
}

console.log("10. a granted call records its pinned target on the turn's provenance ledger:");
{
  _resetGrantBorrowTransportsForTest();
  registerGrantBorrowTransport("notion", async () => ({ blocks: ["pinned page body"] }), "test:credential-grant-mount");
  registerSlackFixtureMapper();

  const SCOPE = "session-provenance";
  const TURN = "turn_70";
  const ask = await askForCredentialGrant(askInput(SCOPE, "session"));
  const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", "session", "slack/W1/U-owner", NOW + 500, undefined, BORROW_DEPS);
  ok(approved.approved, "§10 precondition: a session-mode grant frozen to page `abc123` is minted");
  const entry = mountGrantEntries(await store.credentialGrantsForScope(ORG, SCOPE))[GRANT_NAME] as unknown as {
    execute(input: unknown, ctx: unknown): Promise<{ ok: boolean; refused?: string }>;
  };
  ok(typeof entry?.execute === "function", "…and it mounts an executable entry");

  const ctx = {
    channel: { kind: "channel:slack" },
    session: {
      id: `worker-of-${SCOPE}`,
      parent: { callId: "call-1", sessionId: SCOPE },
      turn: { id: TURN, sequence: 1 },
      auth: {
        current: {
          attributes: { oe_platform: "slack", oe_grain: "standing", oe_requester: "U-req", channel_id: "C1", team_id: "W1", channel_type: "channel", trust_checked: "true" },
          principalId: "U-req",
          principalType: "slack-user",
        },
      },
    },
    agent: { name: "oe", nodeId: "__root__" },
  } as unknown as BindableContext;

  await inSession(new FakeSession(), async () => {
    const verdict = recordRequesterIdentity(ctx, TURN, REQUESTER_ENVELOPE);
    ok(verdict.kind === "requester", "§10 precondition: the turn names one verified requester, which the broker requires before it spends anybody's credential");

    const before = connectorReadsThisTurn(TURN).length;
    const result = await entry.execute({ id: "abc123" }, ctx);
    ok(result.ok, `the granted call succeeds through the real broker (refused: ${String(result.refused)})`);

    const reads = connectorReadsThisTurn(TURN);
    eq(reads.length, before + 1, "🔴 the granted call adds ONE entry to this turn's provenance ledger — before this ticket it added none, and the reply named no source at all");
    const read = reads[reads.length - 1]!;
    eq(read.proof, "surface", "…carrying the SAME reach proof every other read on a per-surface seat carries, so the reply-time rule is unchanged for a borrowed read");
    eq(read.connection, "notion", "…recorded under the GRANT ROW's own connection name, which is what the footer shows for every other read on that system");
    eq(read.op, BORROWED_READ_OP, "…under a HOST-authored op name, never the vendor tool string, which is model-authored at ask time");
    eq(read.record?.kind, BORROWED_RECORD_KIND, "…carrying the grant's record kind");
    eq(read.record?.id, approved.approved ? approved.grant.id : "", "…whose id is the GRANT ROW, so a reader joins the footer to the `grant.used` row for the same call");
  });

  await inSession(new FakeSession(), async () => {
    const ERRORED_TURN = "turn_72";
    recordRequesterIdentity(ctx, ERRORED_TURN, REQUESTER_ENVELOPE);
    const erroredCtx = { ...(ctx as unknown as Record<string, unknown>), session: { ...((ctx as unknown as { session: Record<string, unknown> }).session), turn: { id: ERRORED_TURN, sequence: 1 } } } as unknown as BindableContext;
    _resetGrantBorrowTransportsForTest();
    registerGrantBorrowTransport("notion", async () => ({ content: [{ text: "page not found", type: "text" }], isError: true }), "test:credential-grant-mount");
    const errored = await entry.execute({ id: "abc123" }, erroredCtx);
    ok(errored.ok, "the broker still reports `ok` on a vendor error — it sent the call, which is what `ok` means");
    eq(connectorReadsThisTurn(ERRORED_TURN).length, 0, "🔴 …and the turn records NO source, because the vendor answered an error and nothing was read");
  });

  await inSession(new FakeSession(), async () => {
    const PARTIAL_TURN = "turn_73";
    recordRequesterIdentity(ctx, PARTIAL_TURN, REQUESTER_ENVELOPE);
    const partialCtx = { ...(ctx as unknown as Record<string, unknown>), session: { ...((ctx as unknown as { session: Record<string, unknown> }).session), turn: { id: PARTIAL_TURN, sequence: 1 } } } as unknown as BindableContext;
    _resetGrantBorrowTransportsForTest();
    registerGrantBorrowTransport("notion", async () => ({ blocks: ["pinned page body"] }), "test:credential-grant-mount");
    const row = (await store.credentialGrantsForScope(ORG, SCOPE)).find((g) => g.toolName === GRANT_NAME);
    ok(row !== undefined, "§10 precondition: the grant row is readable for the doctored mounts below");
    const loose = grantToolEntry({ ...row!, frozenArgs: { page_size: 5 } }, NOW) as unknown as { execute(i: unknown, c: unknown): Promise<{ ok: boolean }> };
    ok((await loose.execute({ id: "abc123" }, partialCtx)).ok, "the call still succeeds — the store row is unchanged, only the mount's view of the freeze is");
    const partialReads = connectorReadsThisTurn(PARTIAL_TURN);
    eq(partialReads.length, 1, "the borrowed read is still RECORDED — the turn did read Notion");
    eq(partialReads[0]?.record, undefined, "🔴 …and it names NO record, because this grant does not pin which page the call reads");

    const WRITE_TURN = "turn_74";
    recordRequesterIdentity(ctx, WRITE_TURN, REQUESTER_ENVELOPE);
    const writeCtx = { ...(ctx as unknown as Record<string, unknown>), session: { ...((ctx as unknown as { session: Record<string, unknown> }).session), turn: { id: WRITE_TURN, sequence: 1 } } } as unknown as BindableContext;
    const writeTier = grantToolEntry({ ...row!, tier: "write" }, NOW) as unknown as { execute(i: unknown, c: unknown): Promise<{ ok: boolean }> };
    ok((await writeTier.execute({ id: "abc123" }, writeCtx)).ok, "the call still succeeds on a write-tier mount row");
    eq(connectorReadsThisTurn(WRITE_TURN).length, 0, "🔴 a non-`read` tier records NOTHING — the ledger is read-verbs-only, so a write slice can never render a mutation as a source (`borrowShape` refuses that tier at mint today, so this is the line that keeps it true when it does not)");
  });

  await inSession(new FakeSession(), async () => {
    const REFUSED_TURN = "turn_71";
    recordRequesterIdentity(ctx, REFUSED_TURN, REQUESTER_ENVELOPE);
    const refusedCtx = {
      ...(ctx as unknown as Record<string, unknown>),
      session: {
        ...((ctx as unknown as { session: Record<string, unknown> }).session),
        id: "worker-of-session-not-this-grant",
        parent: { callId: "call-9", sessionId: "session-not-this-grant" },
        turn: { id: REFUSED_TURN, sequence: 1 },
      },
    } as unknown as BindableContext;
    const refused = await entry.execute({ id: "abc123" }, refusedCtx);
    ok(!refused.ok, "a call from a WORKER OF ANOTHER conversation is refused — the mount withholds the tool there, and the broker's backstop refuses a replayed entry too");
    eq(refused.refused, "out_of_scope", "🔴 …and refuses for THAT reason. Without this the leg passes on `unverified_requester` or any other gate, and says nothing about the conversation boundary");
    eq(connectorReadsThisTurn(REFUSED_TURN).length, 0, "🔴 …and records NO source — a refusal carries no vendor bytes, so the turn read nothing");
  });
}

{
  const LENT_TO = "session-lent-room";
  const OTHER_ROOM = "session-other-room";
  const ask = await askForCredentialGrant(askInput(LENT_TO, "session"));
  const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", "session", "slack/W1/U-owner", NOW + 500, undefined, BORROW_DEPS);
  ok(approved.approved, "the owner approves a session grant scoped to the lent conversation");

  const resolve = async (c: unknown): Promise<readonly string[]> => {
    const out = (await (grantTools as { events: Record<string, (e: unknown, c: unknown) => Promise<unknown>> }).events["turn.started"]({ type: "turn.started" }, c)) as Record<
      string,
      ReplayableToolEntry
    > | null;
    return Object.keys(out ?? {});
  };

  eq(await resolve(seatCtx(LENT_TO)), [GRANT_NAME], "🔴 a worker of the LENT conversation does not hold the lent tool — the grant is reachable by nothing at all while this holds");

  const otherRoomWorker = {
    channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:g3" },
    session: { auth: { current: { attributes: { oe_grain: "standing" } } }, id: "worker-of-other", parent: { callId: "call-9", sessionId: OTHER_ROOM } },
  };
  eq(await resolve(otherRoomWorker), [], "🔴 a worker of ANOTHER conversation holds the lent tool — a grant has crossed the conversation it was lent to, which is the breach this whole plane exists to prevent");

  const seatItself = {
    channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:g3" },
    session: { auth: { current: { attributes: { oe_grain: "standing" } } }, id: LENT_TO },
  };
  eq(windowGrainOf(seatItself as never), "standing", "fixture guard: the seat fixture really resolves a conversational root grain, so leg (c) measures the seat");
  eq(await resolve(seatItself), [], "🔴 the conversational SEAT still mounts the lent tool — the seat is meant to delegate, and OPE-2023 moved the mount to its workers");

  const fireWindow = { channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:g3" }, session: { auth: { current: { attributes: { oe_grain: "task" } } }, id: LENT_TO } };
  eq(await resolve(fireWindow), [], "🔴 a `task` session that is nobody's child mounts the lent tool — a routine fire would inherit a grant nobody in the room asked it to spend");

  const unplaceableChild = { channel: { kind: "subagent" }, session: { auth: { current: { attributes: { oe_grain: "standing" } } }, id: LENT_TO } };
  eq(await resolve(unplaceableChild), [], "🔴 a delegated child this host cannot place mounted a grant — it fell back to its own session id instead of failing closed");

  const tokenOnlyWorker = { channel: { kind: "subagent", continuationToken: `subagent:${LENT_TO}:call-3` }, session: { auth: { current: { attributes: { oe_grain: "standing" } } }, id: "worker-token-only" } };
  eq(await resolve(tokenOnlyWorker), [GRANT_NAME], "🔴 a worker that can only be placed by its continuation token holds nothing — this is the shape the LIVE mount runs on, since a resolver context carries no `session.parent`");
  const tokenOtherRoom = { channel: { kind: "subagent", continuationToken: `subagent:${OTHER_ROOM}:call-4` }, session: { auth: { current: { attributes: { oe_grain: "standing" } } }, id: "worker-token-other" } };
  eq(await resolve(tokenOtherRoom), [], "…and the token arm discriminates: a token naming ANOTHER conversation mounts nothing");

  const unstamped = { channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:g3" }, session: { id: "worker-unstamped", parent: { callId: "call-7", sessionId: LENT_TO } } };
  eq(await resolve(unstamped), [GRANT_NAME], "🔴 a worker carrying NO grain stamp does not hold its conversation's lent tool — that is every worker an unseated deployment spawns");
}

console.log(`\ncredential-grant-mount: ${n} assertions passed.`);

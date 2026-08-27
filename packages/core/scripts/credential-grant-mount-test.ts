import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-mount-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import {
  _resetGrantBorrowTransportsForTest,
  _resetGrantRoomNoticeForTest,
  _resetGrantTransportsForTest,
  borrowScopeDigest,
  registerGrantBorrowTransport,
  registerGrantRoomNotice,
  runGrantedCall,
} from "../agent/access/credential-grant-broker.js";
import { _resetGrantableVerbsForTest } from "../agent/access/credential-grant.js";
import { McpCallFenceError } from "../agent/access/mcp-call-fence.js";
import { setRegisteredConnectorCredentials, vercelConnectorHome } from "../agent/access/connector-credentials.js";
import { selectConnectorTransport } from "../agent/connections/connector-transport.js";
import { grantMcpTransport } from "../agent/connections/grant-mcp-transport.js";
import { fakeMcpServer } from "./_fake-mcp-server.js";
import { approveCredentialGrant, askForCredentialGrant, revokeCredentialGrant } from "../agent/access/credential-grant-flow.js";
import { _resetDynamicVariantsForTest, mountedEntryCollisions, preRegisterDynamicEntry, registerDynamicVariant, type ReplayableToolEntry } from "../agent/access/window-gated.js";
import { registerPostArm, type DirectMessageRequest } from "../agent/channels/post-arms.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { resolvePartition } from "../agent/memory/partition.js";
import grantTools, { mountGrantEntries, requesterKeyForGrantCall } from "../agent/tools/grant_tools.js";
import { readAudit } from "../agent/audit/audit.js";
import { parsePrincipalKey } from "../agent/identity/principal-key.js";

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
  session: { auth: { current: { attributes: { oe_grain: "standing" } } }, id: sessionId },
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

_resetGrantableVerbsForTest();
_resetGrantTransportsForTest();
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
});

const roomLines: string[] = [];
registerGrantRoomNotice(async (line) => {
  roomLines.push(line);
});

const askInput = (scopeKey: string, mode: "once" | "session" | "standing") => ({
  ...stamps,
  connector: "notion",
  domainGrantsConnector: true,
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

const callCtx = (scopeKey: string, nowMs = NOW + 1000) => ({ ...stamps, nowMs, requesterPrincipalId: "slack/W1/U-req", scopeKey });

console.log("1. ask -> owner card -> approve -> mount -> compose -> audit:");

const store = getOperationalStore();
const grantIds: Record<string, string> = {};

for (const mode of ["once", "session", "standing"] as const) {
  const scopeKey = `session-${mode}`;
  const before = delivered.length;
  const ask = await askForCredentialGrant(askInput(scopeKey, mode));
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
  ok(result.disclosure?.startsWith("acting as rowan_hale — granted tool") === true, `[${mode}] the result carries the HOST-AUTHORED acting-as line the model cannot write`);
  ok(roomLines[roomLines.length - 1] === result.disclosure, `[${mode}] …and the same line went to the room notice arm, so the room sees it independently of what the model relays`);
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

console.log("3. two sessions, one mounted name, the installed eve:");
const require2 = createRequire(import.meta.url);
const eveRoot = dirname(require2.resolve("eve/package.json"));
const distUrl = (rel: string): string => pathToFileURL(join(eveRoot, "dist", "src", rel)).href;
const lifecycle = (await import(distUrl("context/dynamic-tool-lifecycle.js"))) as {
  validateDurableDynamicToolCallbacks(name: string, entry: unknown): { execute: { closure: Record<string, unknown> } };
};
const durable = (await import(distUrl("shared/durable-dynamic-tool-callbacks.js"))) as {
  lookupDurableDynamicCallback(toolName: string, phase: string): ((closure: Record<string, unknown>, ...args: unknown[]) => unknown) | undefined;
};

{
  const NAME = "grant__pat__read_page";
  const alpha: ReplayableToolEntry = { execute: () => "GRANT-ALPHA" };
  const beta: ReplayableToolEntry = { execute: () => "GRANT-BETA" };
  registerDynamicVariant(NAME, "grant-alpha", alpha);
  const alphaClosure = lifecycle.validateDurableDynamicToolCallbacks(NAME, alpha).execute.closure;
  registerDynamicVariant(NAME, "grant-beta", beta);
  lifecycle.validateDurableDynamicToolCallbacks(NAME, beta);
  eq(alphaClosure, { entryKey: "grant-alpha" }, "eve persists the GRANT ID in session A's durable closure");
  const bound = durable.lookupDurableDynamicCallback(NAME, "execute");
  ok(typeof bound === "function", "eve bound one callback under (grant__pat__read_page, execute)");
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
  const alphaClosure = lifecycle.validateDurableDynamicToolCallbacks(NAME, alpha).execute.closure;
  lifecycle.validateDurableDynamicToolCallbacks(NAME, beta);
  const bound = durable.lookupDurableDynamicCallback(NAME, "execute");
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
  registerGrantBorrowTransport("notion", grantMcpTransport(BORROW_DEPS));

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
  });
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

console.log(`\ncredential-grant-mount: ${n} assertions passed.`);

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-mount-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import {
  _resetGrantRoomNoticeForTest,
  _resetGrantTransportsForTest,
  composedScopeDigest,
  registerGrantRoomNotice,
  registerGrantTransport,
  runGrantedCall,
} from "../agent/access/credential-grant-broker.js";
import { _resetGrantableVerbsForTest, parseGrantResource, registerGrantableVerb } from "../agent/access/credential-grant.js";
import { approveCredentialGrant, askForCredentialGrant, revokeCredentialGrant } from "../agent/access/credential-grant-flow.js";
import { _resetDynamicVariantsForTest, mountedEntryCollisions, preRegisterDynamicEntry, registerDynamicVariant, type ReplayableToolEntry } from "../agent/access/window-gated.js";
import { registerPostArm, type DirectMessageRequest } from "../agent/channels/post-arms.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { resolvePartition } from "../agent/memory/partition.js";
import grantTools, { mountGrantEntries } from "../agent/tools/grant_tools.js";
import { readAudit } from "../agent/audit/audit.js";

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
_resetGrantRoomNoticeForTest();
_resetDynamicVariantsForTest();

registerGrantableVerb({
  compose(grant, input) {
    const resource = parseGrantResource(grant.resource);
    const asked = typeof input.page_size === "number" ? input.page_size : 50;
    return {
      method: "GET",
      query: { page_size: String(Math.min(Math.max(Math.trunc(asked), 1), 100)) },
      url: `https://api.notion.com/v1/blocks/${resource?.id ?? ""}/children`,
    };
  },
  connector: "notion",
  describe: (grant) => `Read the one Notion page ${grant.ownerSlug} granted (${grant.resource}). Expires ${grant.expiresAt}.`,
  inputSchema: { properties: { page_size: { type: "number" } }, type: "object" },
  resourceKind: "page",
  tier: "read",
  verb: "read_page",
});

const sent: { url: string; query?: Record<string, string> }[] = [];
registerGrantTransport("notion", async (request) => {
  sent.push({ url: request.url, ...(request.query === undefined ? {} : { query: { ...request.query } }) });
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
  resource: "notion:page/abc123",
  scopeKey,
  verb: "read_page",
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

  const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", mode, "slack/W1/U-owner", NOW + 500);
  ok(approved.approved, `[${mode}] the owner's approval mints a grant`);
  const grant = approved.approved ? approved.grant : undefined;
  eq(grant?.mode, mode, `[${mode}] the row records the mode the owner PRESSED, not the one the requester suggested`);
  eq(grant?.tier, "read", `[${mode}] the tier is copied from the verb definition at mint`);
  grantIds[mode] = grant?.id ?? "";

  const mounted = (await (grantTools as { events: Record<string, (e: unknown, c: unknown) => Promise<unknown>> }).events["session.started"](
    { type: "session.started" },
    seatCtx(scopeKey),
  )) as Record<string, ReplayableToolEntry> | null;
  ok(mounted !== null && Object.keys(mounted).length === 1, `[${mode}] the resolver mounts exactly one tool for this chat`);
  eq(Object.keys(mounted ?? {}), ["grant__rowan_long__read_page"], `[${mode}] mounted under grant__<ownerSlug>__<verb>`);

  const throughMount = (await mounted!["grant__rowan_long__read_page"].execute({ page_size: 10 }, seatCtx(scopeKey))) as { ok: boolean; refused?: string };
  eq(throughMount.ok ? "OK" : throughMount.refused, "unverified_requester", `[${mode}] the mounted entry reaches the broker and FAILS CLOSED with no verified requester`);

  const sentBefore = sent.length;
  const result = (await runGrantedCall(grantIds[mode], { page_size: 10 }, callCtx(scopeKey))) as {
    ok: boolean;
    disclosure?: string;
    result?: unknown;
  };
  ok(result.ok, `[${mode}] the granted call succeeds`);
  eq(sent.length, sentBefore + 1, `[${mode}] the broker composed and sent exactly one vendor request`);
  eq(sent[sent.length - 1].url, "https://api.notion.com/v1/blocks/abc123/children", `[${mode}] the composed URL carries the page id from the GRANT ROW`);
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

console.log("2. the L1 bake — the resource is not an argument:");
{
  const grants = await store.credentialGrantsForScope(ORG, "session-session");
  const mounted = mountGrantEntries(grants);
  const entry = mounted["grant__rowan_long__read_page"] as unknown as { inputSchema: { properties: Record<string, unknown> } };
  const properties = Object.keys(entry.inputSchema.properties);
  eq(properties, ["page_size"], "the mounted schema exposes ONLY the free variable — there is no page argument to widen");
  const sentBefore = sent.length;
  await runGrantedCall(grantIds.session, { page_id: "SOME-OTHER-PAGE", page_size: 10 }, callCtx("session-session"));
  eq(sent.length, sentBefore + 1, "the call with a widening argument still ran");
  eq(sent[sent.length - 1].url, "https://api.notion.com/v1/blocks/abc123/children", "…and composed the SAME url: a wider read is inexpressible, not merely refused");
  eq(composedScopeDigest({ method: "GET", url: "https://api.notion.com/v1/blocks/abc123/children" }), "GET api.notion.com/v1/blocks/<id>/children", "the digest replaces the id rather than logging it");
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
  const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", "once", "slack/W1/U-owner", NOW + 500);
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
  eq(Object.keys(mounted ?? {}), ["grant__rowan_long__read_page"], "the REVOKED grant's tool is still mounted — mount on existence, refuse on state");
}

{
  const ask = await askForCredentialGrant(askInput("session-scope", "session"));
  const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", "session", "slack/W1/U-owner", NOW + 500);
  const grantId = approved.approved ? approved.grant.id : "";
  const wrongRoom = await runGrantedCall(grantId, {}, callCtx("some-other-session"));
  eq(wrongRoom.ok ? "OK" : wrongRoom.refused, "out_of_scope", "a granted call from ANOTHER chat refuses `out_of_scope` — L0 holds at execute, not only at mount");
  const noRequester = await runGrantedCall(grantId, {}, { ...callCtx("session-scope"), requesterPrincipalId: undefined });
  eq(noRequester.ok ? "OK" : noRequester.refused, "unverified_requester", "a turn with no single verified requester refuses — nobody could be recorded as having spent the credential");

  _resetGrantTransportsForTest();
  const noTransport = await runGrantedCall(grantId, {}, callCtx("session-scope"));
  eq(noTransport.ok ? "OK" : noTransport.refused, "no_transport", "a connector with no registered transport refuses `no_transport`");
  eq((await store.getCredentialGrant(ORG, grantId))?.status, "active", "…and the grant is NOT spent by a deployment that could never have sent the request");
}

console.log(`\ncredential-grant-mount: ${n} assertions passed.`);

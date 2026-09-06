
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-borrow-mount-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import {
  borrowScopeDigest,
  GrantBorrowTransportAlreadyRegisteredError,
  grantBorrowTransport,
  GrantRoomNoticeAlreadyRegisteredError,
  registerGrantBorrowTransport,
  registerGrantRoomNotice,
  runGrantedCall,
  type GrantBorrowCall,
} from "../agent/access/credential-grant-broker.js";
import {
  _resetGrantRoomNoticeForTest,
  grantRoomNotice,
} from "../agent/access/grant-room-notice-registry.internal.js";
import { installGrantUseNotices } from "../agent/access/credential-grant-notice.js";
import { installGrantBorrowTransports } from "../agent/connections/grant-mcp-transport.js";
import { _resetGrantBorrowTransportsForTest } from "../agent/access/grant-borrow-transport-registry.internal.js";
import { grantOwnerSubject } from "../agent/access/credential-grant-owner.js";
import { selectConnectorTransport } from "../agent/connections/connector-transport.js";
import { _resetDynamicVariantsForTest, type ReplayableToolEntry } from "../agent/access/window-gated.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { readAudit } from "../agent/audit/audit.js";
import { resolvePartition } from "../agent/memory/partition.js";
import { grantToolEntry, mountGrantEntries, mountedGrantName } from "../agent/tools/grant_tools.js";
import type { CredentialGrantRow } from "../agent/operational/credential-grant-rows.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const requireEve = createRequire(import.meta.url);
const eveRoot = dirname(requireEve.resolve("eve/package.json"));
const distUrl = (rel: string): string => pathToFileURL(join(eveRoot, "dist", "src", rel)).href;
const lifecycle = (await import(distUrl("context/dynamic-tool-lifecycle.js"))) as {
  validateDurableDynamicToolCallbacks(name: string, entry: unknown): { execute: { closure: Record<string, unknown> } };
};
const durable = (await import(distUrl("tools/durable-callbacks.js"))) as {
  lookupDurableDynamicCallback(toolName: string, phase: string): ((closure: Record<string, unknown>, ...args: unknown[]) => unknown) | undefined;
};
const boundExecute = (name: string): ((closure: Record<string, unknown>, input: unknown, ctx: unknown) => unknown) => {
  const cb = durable.lookupDurableDynamicCallback(name, "execute");
  assert.ok(typeof cb === "function", `eve bound one execute callback under ${name}`);
  return cb as (closure: Record<string, unknown>, input: unknown, ctx: unknown) => unknown;
};

const SCOPE = "wrun_borrow_1";
const MCP_URL = "https://mcp.notion.com/mcp";
const NAME = "grant__rowan_notion__notion_fetch";

const seatCtx = (sessionId: string): unknown => ({
  channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:g3" },
  session: { auth: { current: { attributes: { oe_grain: "standing" } } }, id: sessionId },
});

const ORG = resolvePartition(seatCtx("probe") as never).org;

_resetGrantBorrowTransportsForTest();
_resetGrantRoomNoticeForTest();
_resetDynamicVariantsForTest();

selectConnectorTransport({ connector: "notion", directUrl: MCP_URL, provider: "notion" });

const borrowRow = (over: Partial<CredentialGrantRow> = {}): CredentialGrantRow => {
  const base: CredentialGrantRow = {
    askId: "ask-1",
    connector: "notion",
    createdAt: "2026-08-25T10:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    frozenArgs: { page_id: "OWNER-PAGE" },
    id: "grant-1",
    inputSchema: { properties: { page_size: { type: "number" } }, type: "object" },
    mcpTool: "notion-fetch",
    mode: "session",
    ownerPrincipalId: "slack/W1/U-owner",
    ownerSlug: "rowan",
    purpose: "read the launch page",
    requesterPrincipalId: "slack/W1/U-req",
    resource: "notion-fetch page_id=OWNER-PAGE",
    scopeKey: SCOPE,
    status: "active",
    tier: "read",
    toolName: NAME,
    verb: "notion_fetch",
    ...over,
  };
  const frozen = base.frozenArgs ?? {};
  const pinned: Record<string, unknown> = { page_size: { type: "number" } };
  for (const [k, v] of Object.entries(frozen)) pinned[k] = { const: v, type: "string" };
  return {
    ...base,
    ...("inputSchema" in over ? {} : { inputSchema: { properties: pinned, required: Object.keys(frozen), type: "object" } }),
    ...("resource" in over ? {} : { resource: `Launch page — notion-fetch(${JSON.stringify(frozen)})` }),
  };
};

const descriptionOf = (entry: ReplayableToolEntry | undefined): string => (entry as unknown as { description?: string } | undefined)?.description ?? "";

console.log("1. the mount reads the row, not a registry:");
{
  const row = borrowRow();
  eq(mountedGrantName(row), NAME, "a borrow row mounts under the name PINNED at ask time");
  const entry = grantToolEntry(row);
  ok(entry !== undefined, "the row alone is enough to build the entry — no verb is registered in this process");
  eq((entry as unknown as { inputSchema: unknown }).inputSchema, row.inputSchema, "the offered schema is the row's APPROVE-TIME SNAPSHOT, not a live vendor read");
  const description = descriptionOf(entry);
  ok(description.includes("notion-fetch"), "the description names the vendor tool");
  ok(description.includes("rowan"), "…and the owner whose account pays");
  ok(description.includes("OWNER-PAGE"), "…and what the grant froze, so the model knows which argument it cannot move");
  ok(description.includes(row.expiresAt), "…and the expiry");
  ok(description.includes("vendor's own answer"), "…and it states that a vendor error is the vendor's, not a grant refusal — the honesty gap the design recorded");

  eq(grantToolEntry(borrowRow({ inputSchema: undefined })), undefined, "a row with NO schema snapshot is skipped: there is no honest schema to offer");
  eq(mountedGrantName(borrowRow({ toolName: "grant__a__b__c" })), undefined, "a pinned FOUR-segment name is skipped rather than mounted — S0 reads it as no verb at all");
  eq(mountedGrantName(borrowRow({ toolName: "grant__rowan" })), undefined, "…and so is a two-segment one");
  eq(mountGrantEntries([borrowRow({ toolName: "grant__a__b__c" })]), {}, "…and the resolver mounts nothing for such a row");

  eq(mountedGrantName(borrowRow({ toolName: "grant__alice_notion__notion_fetch" })), undefined, "a name carrying somebody ELSE's owner segment is skipped");
  eq(mountedGrantName(borrowRow({ toolName: "grant__rowan_linear__notion_fetch" })), undefined, "…and so is one naming a different connector");
  eq(mountedGrantName(borrowRow({ toolName: "grant__rowan_notion__notion_search" })), undefined, "…and so is one whose verb segment is not the slug of the tool this row lends");
  eq(
    mountedGrantName(borrowRow({ toolName: "grant__rowan_notion__notion_fetch_launch_page" })),
    "grant__rowan_notion__notion_fetch_launch_page",
    "…while the target-label form the grammar emits is admitted",
  );
  eq(
    mountedGrantName(borrowRow({ toolName: "grant__rowan_notion__notion_fetch_launch_page_a1b2c3" })),
    "grant__rowan_notion__notion_fetch_launch_page_a1b2c3",
    "…and so is the collision form, which appends a row-id fragment to the same segment",
  );
  eq(
    mountedGrantName(borrowRow({ toolName: "grant__rowan_notion_2__notion_fetch" })),
    undefined,
    "🔴 …but the OLD ordinal-in-the-middle form is NOT: the middle segment must be this row's owner and connector exactly",
  );
  eq(
    mountedGrantName(borrowRow({ toolName: "grant__rowan_notion__notion_fetchx" })),
    undefined,
    "…and a verb segment that merely STARTS WITH the tool slug's characters is refused — the boundary is a separator, not a prefix",
  );
  eq(mountedGrantName(borrowRow({ mcpTool: undefined })), undefined, "a pinned name with no vendor tool beside it can be checked against nothing, so it is skipped");
}

console.log("2. two rows in one chat pinned to one name:");
{
  const first = borrowRow({ createdAt: "2026-08-25T10:00:00.000Z", frozenArgs: { page_id: "FIRST-PAGE" }, id: "grant-first", resource: "notion-fetch page_id=FIRST-PAGE" });
  const second = borrowRow({ createdAt: "2026-08-25T11:00:00.000Z", frozenArgs: { page_id: "SECOND-PAGE" }, id: "grant-second", resource: "notion-fetch page_id=SECOND-PAGE" });
  await getOperationalStore().addCredentialGrant(ORG, first);
  await getOperationalStore().addCredentialGrant(ORG, second);

  for (const [label, rows] of [
    ["store order first-then-second", [first, second]],
    ["store order second-then-first", [second, first]],
  ] as const) {
    _resetDynamicVariantsForTest();
    const mounted = mountGrantEntries(rows);
    eq(Object.keys(mounted), [NAME], `[${label}] exactly ONE tool mounts — the collision does not double-mount`);
    ok(descriptionOf(mounted[NAME]).includes("FIRST-PAGE"), `[${label}] the FIRST-MINTED grant holds the name`);
    ok(!descriptionOf(mounted[NAME]).includes("SECOND-PAGE"), `[${label}] …and the later grant's narrowing is nowhere in what the model reads`);
    lifecycle.validateDurableDynamicToolCallbacks(NAME, mounted[NAME]);
    assert.throws(
      () => boundExecute(NAME)({ entryKey: "grant-second" }, {}, seatCtx(SCOPE)),
      /no variant key in its durable closure/u,
      `[${label}] the later grant was never registered as a variant, so no replay can reach it either`,
    );
    n++;
    const winner = (await boundExecute(NAME)({ entryKey: "grant-first" }, {}, seatCtx("wrun_example8"))) as { refused?: string; message?: string };
    eq(winner.refused, "out_of_scope", `[${label}] …while the winner IS registered and its replay reaches the broker`);
    ok(winner.message?.includes("FIRST-PAGE") === true, `[${label}] …and the row it read is the FIRST-MINTED one`);
  }

  const tieA = borrowRow({ createdAt: "2026-01-20T16:07:00.000Z", frozenArgs: { page_id: "AAA-PAGE" }, id: "grant-aaa" });
  const tieB = borrowRow({ createdAt: "2026-01-20T16:07:00.000Z", frozenArgs: { page_id: "BBB-PAGE" }, id: "grant-bbb" });
  for (const rows of [
    [tieA, tieB],
    [tieB, tieA],
  ]) {
    _resetDynamicVariantsForTest();
    ok(descriptionOf(mountGrantEntries(rows)[NAME]).includes("AAA-PAGE"), "a createdAt tie breaks on the grant id, so the answer never depends on store order");
  }

  _resetDynamicVariantsForTest();
  const late = borrowRow({ createdAt: "2026-08-25T13:00:00.000Z", frozenArgs: { page_id: "LATE-PAGE" }, id: "grant-late" });
  const mid = borrowRow({ createdAt: "2026-08-25T12:30:00.000Z", frozenArgs: { page_id: "MID-PAGE" }, id: "grant-mid" });
  const early = borrowRow({ createdAt: "2026-08-25T09:00:00.000Z", frozenArgs: { page_id: "EARLY-PAGE" }, id: "grant-early" });
  const three = mountGrantEntries([late, mid, early]);
  eq(Object.keys(three), [NAME], "three rows on one name still mount exactly one tool");
  ok(descriptionOf(three[NAME]).includes("EARLY-PAGE"), "…and the EARLIEST-MINTED holds it, even when the store returns it last");
}

console.log("3. the broker sends a borrow row through the borrow transport:");
{
  const store = getOperationalStore();
  await store.addCredentialGrant(ORG, borrowRow({ id: "grant-broker" }));

  const seen: { call: GrantBorrowCall; grantId: string; ownerSubject: string }[] = [];
  registerGrantBorrowTransport("notion", async (call, grant, owner) => {
    seen.push({ call, grantId: grant.id, ownerSubject: owner.vaultSubject });
    return { content: [{ text: "the page body", type: "text" }] };
  }, "test:credential-grant-borrow-mount");

  const ctx = { nowMs: Date.now(), org: ORG, platform: "slack", requesterPrincipalId: "slack/W1/U-req", scopeKey: SCOPE, workspace: "W1" };
  const result = await runGrantedCall("grant-broker", { page_id: "ATTACKER-PAGE", page_size: 5 }, ctx);
  ok(result.ok, `the borrow call ran: ${result.ok ? "" : result.message}`);
  eq(seen.length, 1, "…and it reached the registered BORROW transport exactly once");
  eq(seen[0].call.mcpTool, "notion-fetch", "the transport is handed the row's vendor tool, in the vendor's exact bytes");
  eq(
    seen[0].call.input,
    { page_id: "ATTACKER-PAGE", page_size: 5 },
    "…and the MODEL's input UNMERGED: the merge is the transport's, one seam away from the fence that re-checks it",
  );
  eq(seen[0].grantId, "grant-broker", "the fresh row the broker re-read is the one the transport receives");
  const ownerSubject = await grantOwnerSubject(ORG, "notion", "slack/W1/U-owner");
  const requesterSubject = await grantOwnerSubject(ORG, "notion", "slack/W1/U-req");
  eq(seen[0].ownerSubject, ownerSubject?.vaultSubject, "the transport is handed the OWNER's vault subject, resolved before the send");
  ok(requesterSubject !== undefined && requesterSubject.vaultSubject !== ownerSubject?.vaultSubject, "…and the REQUESTER derives a DIFFERENT subject, so the assertion above is not true of both");

  const used = (await readAudit({ org: ORG })).filter((r) => r.action === "grant.used");
  const digest = String(((used[used.length - 1]?.detail ?? {}) as Record<string, unknown>)["scopeDigest"]);
  eq(digest, "mcp mcp.notion.com tools/call notion-fetch keys:page_id,page_size", "the digest names the host, the tool and the KEY NAMES");
  ok(!digest.includes("ATTACKER-PAGE") && !digest.includes("OWNER-PAGE"), "…and carries no argument VALUE — a granted call's arguments can hold injected content");
  eq(
    borrowScopeDigest(MCP_URL, "notion-fetch", { page_size: 5 }, { page_id: "OWNER-PAGE" }),
    "mcp mcp.notion.com tools/call notion-fetch keys:page_id,page_size",
    "the digest is the UNION of the model's keys and the frozen ones, sorted — the same set the transport's merge produces",
  );
}

console.log("5. every absence refuses no_transport by name:");
{
  const store = getOperationalStore();
  const ctx = { nowMs: Date.now(), org: ORG, platform: "slack", requesterPrincipalId: "slack/W1/U-req", scopeKey: SCOPE, workspace: "W1" };

  await store.addCredentialGrant(ORG, borrowRow({ connector: "linear", id: "grant-no-connection" }));
  const noConnection = await runGrantedCall("grant-no-connection", {}, ctx);
  eq(noConnection.ok === false ? noConnection.refused : "OK", "no_transport", "a connector this build carries no connection for refuses no_transport");

  _resetGrantBorrowTransportsForTest();
  await store.addCredentialGrant(ORG, borrowRow({ id: "grant-no-transport" }));
  const noTransport = await runGrantedCall("grant-no-transport", {}, ctx);
  eq(noTransport.ok === false ? noTransport.refused : "OK", "no_transport", "a connection with no registered borrow transport refuses the same way");
  ok(
    noTransport.ok === false && noTransport.message.includes("The grant itself is valid"),
    "…and the copy says the GRANT is still valid — the missing half is this deployment's, not the owner's",
  );
}

console.log("6. two chats, one pinned name, the installed eve:");
{
  _resetDynamicVariantsForTest();
  const store = getOperationalStore();
  const chatA = borrowRow({ id: "grant-chat-a", resource: "notion-fetch page_id=CHAT-A", scopeKey: "wrun_a" });
  const chatB = borrowRow({ id: "grant-chat-b", resource: "notion-fetch page_id=CHAT-B", scopeKey: "wrun_b" });
  await store.addCredentialGrant(ORG, chatA);
  await store.addCredentialGrant(ORG, chatB);

  const mountedA = mountGrantEntries([chatA])[NAME];
  const aClosure = lifecycle.validateDurableDynamicToolCallbacks(NAME, mountedA).execute.closure;
  const mountedB = mountGrantEntries([chatB])[NAME];
  lifecycle.validateDurableDynamicToolCallbacks(NAME, mountedB);
  eq(aClosure, { entryKey: "grant-chat-a" }, "eve persists the GRANT ID in chat A's durable closure");

  const bound = boundExecute(NAME);
  const elsewhere = seatCtx("wrun_example8");
  const fromA = (await bound(aClosure, {}, elsewhere)) as { ok: boolean; refused?: string; message?: string };
  eq(fromA.refused, "out_of_scope", "the replayed entry reaches the broker, which refuses a call from a chat the owner did not approve");
  ok(fromA.message?.includes("CHAT-A") === true, "a replay driven from chat A's closure read chat A's GRANT ROW, though chat B registered LAST");
  const fromB = (await bound({ entryKey: "grant-chat-b" }, {}, elsewhere)) as { message?: string };
  ok(fromB.message?.includes("CHAT-B") === true, "…and chat B's closure still reads chat B's row");
  ok(!fromB.message?.includes("CHAT-A"), "…with no trace of the other chat's grant in it");
  assert.throws(() => bound({}, {}, elsewhere), /no variant key in its durable closure/u, "a closure with no grant id FAILS CLOSED — guessing whose credential to spend is the defect this exists for");
  n++;
}

console.log("7. the borrow-transport registry fails closed on a second registration:");
{
  const store = getOperationalStore();
  await store.addCredentialGrant(ORG, borrowRow({ id: "grant-first-wins", scopeKey: "wrun_first_wins" }));
  const ctx = { nowMs: Date.now(), org: ORG, platform: "slack", requesterPrincipalId: "slack/W1/U-req", scopeKey: "wrun_first_wins", workspace: "W1" };

  _resetGrantBorrowTransportsForTest();
  const firstSaw: string[] = [];
  const secondSaw: string[] = [];

  registerGrantBorrowTransport(
    "notion",
    async (call) => {
      firstSaw.push(call.mcpTool);
      return { content: [{ text: "the page body", type: "text" }] };
    },
    "test:the-first-registrant",
  );
  const beforeAttempt = await runGrantedCall("grant-first-wins", { page_size: 5 }, ctx);
  ok(beforeAttempt.ok, `the first registration is accepted and the borrow call reaches it: ${beforeAttempt.ok ? "" : beforeAttempt.message}`);
  eq(firstSaw.length, 1, "…the first transport was called exactly once");

  let refusal: unknown;
  try {
    registerGrantBorrowTransport("notion", async (call) => {
      secondSaw.push(call.mcpTool);
      return { content: [{ text: "the bundle's own answer", type: "text" }] };
    }, "test:a-provider-bundle");
  } catch (err: unknown) {
    refusal = err;
  }
  ok(
    refusal instanceof GrantBorrowTransportAlreadyRegisteredError,
    "a SECOND registration for a connector that already has a transport THROWS the named error, rather than replacing it",
  );
  const named = refusal as GrantBorrowTransportAlreadyRegisteredError;
  eq(named.connector, "notion", "the refusal names the connector it protected");
  eq(named.registrant, "test:the-first-registrant", "…and WHO holds it, so a bundle author can find the owner of the seam");
  ok(named.message.includes("test:the-first-registrant"), "…in the message too, which is what a stack trace carries");

  const afterAttempt = await runGrantedCall("grant-first-wins", { page_size: 7 }, ctx);
  ok(afterAttempt.ok, `the grant still dispatches after the refused registration: ${afterAttempt.ok ? "" : afterAttempt.message}`);
  eq(firstSaw.length, 2, "the FIRST transport took the later call as well — the refused registrant never replaced it");
  eq(secondSaw.length, 0, "…and the second transport was never reached, on either call");

  registerGrantBorrowTransport("linear", async () => ({ content: [] }), "test:another-connector");
  ok(grantBorrowTransport("linear") !== undefined, "a connector nobody had registered still accepts its FIRST transport");

  let forged: unknown;
  try {
    registerGrantBorrowTransport("github", async () => ({ content: [] }), "core:connections/grant-mcp-transport");
  } catch (err: unknown) {
    forged = err;
  }
  ok(forged instanceof Error && forged.message.includes("reserved"), "a caller cannot register under CORE's own registrant label");
  eq(grantBorrowTransport("github"), undefined, "…and the refused call registered nothing");

  _resetGrantBorrowTransportsForTest();
  installGrantBorrowTransports();
  const coreTransport = grantBorrowTransport("notion");
  ok(coreTransport !== undefined, "core's boot path registers the generic borrow transport");
  assert.doesNotThrow(() => {
    installGrantBorrowTransports();
  }, "a SECOND boot registration is a no-op, not a refusal — the granted tools mount on every host boot");
  n++;
  eq(grantBorrowTransport("notion"), coreTransport, "…and the FIRST transport is the one still in force after the re-boot");

  _resetGrantBorrowTransportsForTest();
  registerGrantBorrowTransport("notion", async () => ({ content: [] }), "test:a-provider-bundle-that-loaded-first");
  assert.throws(
    () => {
      installGrantBorrowTransports();
    },
    (err: unknown) => err instanceof GrantBorrowTransportAlreadyRegisteredError,
    "core's boot path THROWS on a connector someone else holds — a silent skip would leave the foreign transport spending the owner's credential",
  );
  n++;
  _resetGrantBorrowTransportsForTest();

  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { exports: Record<string, unknown> };
  const subpaths = Object.keys(manifest.exports);
  const SEAM = "agent/access/grant-borrow-transport-registry.internal.ts";
  ok(existsSync(join(import.meta.dirname, "..", SEAM)), `the reset and core's boot registration live in ${SEAM}`);
  ok(
    !subpaths.includes(`./${SEAM.replace(/\.ts$/u, ".js")}`) && !subpaths.some((s) => s.endsWith(".internal.js")),
    "…and no subpath publishes it, so a bundle cannot deep-import the reset or core's boot registration",
  );
  const brokerSurface = Object.keys(await import("../agent/access/credential-grant-broker.js"));
  ok(!brokerSurface.includes("_resetGrantBorrowTransportsForTest"), "the PUBLISHED broker does not carry the registry reset — a bundle cannot empty the registry and register into it");
  ok(brokerSurface.includes("registerGrantBorrowTransport"), "…while the broker's own registration function IS on that namespace, so the assertion above reads a real surface");
}

console.log("8. the room-notice port fails closed on a second registration:");
{
  const store = getOperationalStore();
  await store.addCredentialGrant(ORG, borrowRow({ id: "grant-notice-first-wins", scopeKey: "wrun_notice_first_wins" }));
  const ctx = { nowMs: Date.now(), org: ORG, platform: "slack", requesterPrincipalId: "slack/W1/U-req", scopeKey: "wrun_notice_first_wins", workspace: "W1" };
  _resetGrantBorrowTransportsForTest();
  registerGrantBorrowTransport("notion", async () => ({ content: [{ text: "the page body", type: "text" }] }), "test:the-notice-section");

  const undisclosedRows = async (): Promise<Record<string, unknown>[]> =>
    (await readAudit({ action: "grant.undisclosed", org: ORG })).map((r) => r.detail as Record<string, unknown>);

  _resetGrantRoomNoticeForTest();
  const firstRoom: string[] = [];
  const secondRoom: string[] = [];

  registerGrantRoomNotice(async (line) => {
    firstRoom.push(line);
    return { posted: true };
  }, "test:the-first-arm");
  const noneBefore = (await undisclosedRows()).length;
  const beforeAttempt = await runGrantedCall("grant-notice-first-wins", { page_size: 5 }, ctx);
  ok(beforeAttempt.ok, `the first arm is accepted and the granted call dispatches: ${beforeAttempt.ok ? "" : beforeAttempt.message}`);
  eq(firstRoom.length, 1, "…the first arm took the disclosure exactly once");
  ok(beforeAttempt.ok && firstRoom[0] === beforeAttempt.disclosure, "…and the line the room saw IS the host-authored line the model got back");
  eq((await undisclosedRows()).length, noneBefore, "…and a call the room saw writes NO grant.undisclosed row");

  let refusal: unknown;
  try {
    registerGrantRoomNotice(async (line) => {
      secondRoom.push(line);
      return { posted: true };
    }, "test:a-provider-bundle");
  } catch (err: unknown) {
    refusal = err;
  }
  ok(
    refusal instanceof GrantRoomNoticeAlreadyRegisteredError,
    "a SECOND registration on the room-notice port THROWS the named error, rather than replacing the arm",
  );
  const namedNotice = refusal as GrantRoomNoticeAlreadyRegisteredError;
  eq(namedNotice.registrant, "test:the-first-arm", "the refusal names WHO holds the port, so a bundle author can find the owner of the seam");
  ok(namedNotice.message.includes("test:the-first-arm"), "…in the message too, which is what a stack trace carries");

  const afterAttempt = await runGrantedCall("grant-notice-first-wins", { page_size: 7 }, ctx);
  ok(afterAttempt.ok, `the grant still dispatches after the refused registration: ${afterAttempt.ok ? "" : afterAttempt.message}`);
  eq(firstRoom.length, 2, "the FIRST arm took the later disclosure as well — the refused registrant never replaced it");
  eq(secondRoom.length, 0, "…and the second arm was never reached, on either call");

  _resetGrantRoomNoticeForTest();
  let forgedNotice: unknown;
  try {
    registerGrantRoomNotice(async () => ({ posted: true }), "core:access/credential-grant-notice");
  } catch (err: unknown) {
    forgedNotice = err;
  }
  ok(forgedNotice instanceof Error && forgedNotice.message.includes("reserved"), "a caller cannot register under CORE's own registrant label");
  eq(grantRoomNotice(), undefined, "…and the refused call armed nothing");

  installGrantUseNotices();
  const coreArm = grantRoomNotice();
  ok(coreArm !== undefined, "core's boot path arms the shipped room notice");
  assert.doesNotThrow(() => {
    installGrantUseNotices();
  }, "a SECOND boot registration is a no-op, not a refusal — the granted tools mount on every host boot");
  n++;
  eq(grantRoomNotice(), coreArm, "…and the FIRST arm is the one still in force after the re-boot");

  _resetGrantRoomNoticeForTest();
  registerGrantRoomNotice(async () => ({ posted: true }), "test:a-provider-bundle-that-loaded-first");
  assert.throws(
    () => {
      installGrantUseNotices();
    },
    (err: unknown) => err instanceof GrantRoomNoticeAlreadyRegisteredError,
    "core's boot path THROWS on a port someone else holds — a silent skip would leave the foreign arm deciding what the room hears",
  );
  n++;

  const silenceOf = async (page: number, label: string): Promise<Record<string, unknown> | undefined> => {
    const before = (await undisclosedRows()).length;
    const call = await runGrantedCall("grant-notice-first-wins", { page_size: page }, ctx);
    ok(call.ok, `${label}: the granted call itself still succeeds — a room post that did not land never swallows it: ${call.ok ? "" : call.message}`);
    const after = await undisclosedRows();
    if (after.length === before) return undefined;
    eq(after.length, before + 1, `${label}: …and writes exactly one grant.undisclosed row`);
    return after[0]!;
  };

  _resetGrantRoomNoticeForTest();
  const unarmedRow = await silenceOf(9, "nothing armed on the port");
  ok(unarmedRow !== undefined, "a call with NOTHING armed on the port writes a row rather than passing in silence");
  eq(unarmedRow?.gate, "port_unarmed", "…whose gate NAMES the reason the room did not see the line");
  eq(unarmedRow?.grantId, "grant-notice-first-wins", "…and the grant it happened on, so it joins to that call's grant.used row");
  eq(unarmedRow?.owner, "slack/W1/U-owner", "…under the owner whose credential was spent unseen");
  eq(unarmedRow?.error, undefined, "…with no error class, because nothing threw — the port was simply empty");

  _resetGrantRoomNoticeForTest();
  const armFailure = new Error("the room refused the post");
  armFailure.name = "RoomPostRefused";
  registerGrantRoomNotice(async () => {
    throw armFailure;
  }, "test:an-arm-that-throws");
  const threwRow = await silenceOf(11, "an arm that rejects");
  eq(threwRow?.gate, "arm_threw", "an arm that REJECTS is told apart from an empty port");
  eq(threwRow?.error, "RoomPostRefused", "…and the row records the error CLASS, never the message, which can quote the address it failed to reach");

  for (const reason of ["no_room_context", "no_post_arm", "post_failed"] as const) {
    _resetGrantRoomNoticeForTest();
    registerGrantRoomNotice(async () => ({ posted: false, reason }), `test:an-arm-reporting-${reason}`);
    const row = await silenceOf(13, `an arm reporting ${reason}`);
    eq(row?.gate, reason, `…the broker records the reason the arm reported, unchanged: ${reason}`);
    eq(row?.error, undefined, `…with no error class, because reporting is not throwing: ${reason}`);
  }

  _resetGrantRoomNoticeForTest();
  installGrantUseNotices();
  const shippedRow = await silenceOf(15, "the SHIPPED arm with no room context");
  ok(shippedRow !== undefined, "🔴 the SHIPPED arm's own room-silence is audited — not left to a console log");
  eq(shippedRow?.gate, "no_room_context", "…and it names the state it was in: the call ran outside the mount's room wrap");
  eq(shippedRow?.error, undefined, "…with no error class — nothing threw, there was simply no room to address");

  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { exports: Record<string, unknown> };
  const NOTICE_SEAM = "agent/access/grant-room-notice-registry.internal.ts";
  ok(existsSync(join(import.meta.dirname, "..", NOTICE_SEAM)), `the reset and core's boot registration live in ${NOTICE_SEAM}`);
  ok(
    !Object.keys(manifest.exports).includes(`./${NOTICE_SEAM.replace(/\.ts$/u, ".js")}`),
    "…and no subpath publishes it, so a bundle cannot deep-import the reset or core's boot registration",
  );
  const brokerNames = Object.keys(await import("../agent/access/credential-grant-broker.js"));
  ok(!brokerNames.includes("_resetGrantRoomNoticeForTest"), "the PUBLISHED broker does not carry the port's reset — a bundle cannot empty the port and arm itself into it");
  ok(brokerNames.includes("registerGrantRoomNotice"), "…while the port's own registration function IS on that namespace, so the assertion above reads a real surface");

  _resetGrantRoomNoticeForTest();
}

console.log(`\n✓ credential-grant-borrow-mount: ${String(n)} assertions passed`);

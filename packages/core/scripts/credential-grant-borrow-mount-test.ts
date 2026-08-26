import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-borrow-mount-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import {
  _resetGrantBorrowTransportsForTest,
  _resetGrantRoomNoticeForTest,
  _resetGrantTransportsForTest,
  borrowScopeDigest,
  registerGrantBorrowTransport,
  runGrantedCall,
  type GrantBorrowCall,
} from "../agent/access/credential-grant-broker.js";
import { _resetGrantableVerbsForTest } from "../agent/access/credential-grant.js";
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
const durable = (await import(distUrl("shared/durable-dynamic-tool-callbacks.js"))) as {
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

_resetGrantableVerbsForTest();
_resetGrantTransportsForTest();
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
  });

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

console.log(`\n✓ credential-grant-borrow-mount: ${String(n)} assertions passed`);

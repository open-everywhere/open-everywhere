import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-borrow-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import { classifyConnectorOpTier, parseQualifiedToolName } from "../agent/access/consequence.js";
import {
  _resetGrantableVerbsForTest,
  credentialGrantFromAsk,
  credentialGrantMintVerdict,
  grantMintRefusalMessage,
  registerGrantableVerb,
  type GrantMintInput,
} from "../agent/access/credential-grant.js";
import {
  grantBorrowToolName,
  grantFrozenArgsDigest,
  grantJsonColumn,
  grantJsonFromColumn,
  grantToolSlug,
  isGrantNameSegment,
  isGrantToolName,
  nextGrantBorrowToolName,
  type CredentialGrantAskRow,
  type CredentialGrantRow,
} from "../agent/operational/credential-grant-rows.js";
import { initOperationalSchema, makeOperationalPostgresStore } from "../agent/operational/postgres.js";
import { sqliteOperationalStore } from "../agent/operational/sqlite.js";
import type { OperationalStore } from "../agent/operational/store.js";
import { closeAllTestPg, openTestPg } from "./test-pg-driver.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};
const throws = (fn: () => unknown, label: string): void => {
  assert.throws(fn, label);
  n++;
};
const rejects = async (fn: () => Promise<unknown>, label: string): Promise<void> => {
  await assert.rejects(fn, label);
  n++;
};

const ORG = "org-borrow";
const NOW = Date.parse("2026-01-20T16:07:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

console.log("1. the borrow name grammar:");

eq(grantBorrowToolName("rowan_hale", "notion", "notion_fetch"), "grant__rowan_long_notion__notion_fetch", "the grammar is grant__<owner>_<connector>__<toolSlug>, with the vendor in the MIDDLE segment");
eq(grantBorrowToolName("rowan_hale", "notion", "notion_fetch", 1), "grant__rowan_long_notion__notion_fetch", "ordinal 1 spells the BARE name — the first grant of a tool carries no suffix");
eq(grantBorrowToolName("rowan_hale", "notion", "notion_fetch", 2), "grant__rowan_long_notion_2__notion_fetch", "ordinal 2 appends _2 to the MIDDLE segment, never to the verb segment");
eq(grantBorrowToolName("rowan_hale", "notion", "notion_fetch", 11), "grant__rowan_long_notion_11__notion_fetch", "a two-digit ordinal composes too");

for (const ordinal of [1, 2, 7]) {
  const name = grantBorrowToolName("rowan_hale", "notion", "notion_fetch", ordinal);
  ok(isGrantToolName(name), `ordinal ${String(ordinal)}: the composed name is one isGrantToolName accepts`);
  eq(name.split("__").length, 3, `ordinal ${String(ordinal)}: the composed name holds EXACTLY three segments, so S0's parser reads a verb from it`);
}
ok(!isGrantToolName("grant__rowan_hale__notion__notion_fetch"), "…and a FOUR-segment name is refused by the same predicate — the check has teeth");
eq(parseQualifiedToolName("grant__rowan_long_notion__notion_fetch")?.verb, "notion_fetch", "S0's parser reads the tool slug as the verb, and the owner+connector as the owner segment");

throws(() => grantBorrowToolName("rowan__hale", "notion", "notion_fetch"), "an owner segment holding __ throws rather than emitting a four-segment name");
throws(() => grantBorrowToolName("rowan_hale", "notion__x", "notion_fetch"), "a connector segment holding __ throws");
throws(() => grantBorrowToolName("rowan_hale", "notion", "notion-fetch"), "an UNSLUGIFIED tool name throws — the caller slugifies with grantToolSlug first");
throws(() => grantBorrowToolName("rowan_hale", "notion", "notion_fetch", 0), "ordinal 0 throws — it names no grant");
throws(() => grantBorrowToolName("rowan_hale", "notion", "notion_fetch", -2), "a negative ordinal throws");
throws(() => grantBorrowToolName("rowan_hale", "notion", "notion_fetch", 1.5), "a fractional ordinal throws");

{
  const first = nextGrantBorrowToolName("rowan_hale", "notion", "notion_fetch", []);
  eq(first, "grant__rowan_long_notion__notion_fetch", "with nothing claimed, the next name is the bare one");
  const second = nextGrantBorrowToolName("rowan_hale", "notion", "notion_fetch", [first]);
  eq(second, "grant__rowan_long_notion_2__notion_fetch", "with the bare name claimed, the next one carries ordinal 2");
  eq(nextGrantBorrowToolName("rowan_hale", "notion", "notion_fetch", [first, second]), "grant__rowan_long_notion_3__notion_fetch", "…and then 3, so a third grant of one tool still mounts");
  eq(
    nextGrantBorrowToolName("rowan_hale", "notion", "notion_fetch", [second]),
    first,
    "a HOLE is filled: with only ordinal 2 claimed, the bare name is free again and is taken",
  );
  eq(
    nextGrantBorrowToolName("rowan_hale", "notion", "notion_fetch", ["grant__someone_else_notion__notion_fetch", "grant__rowan_long_notion__notion_search"]),
    first,
    "another person's name and another tool's name claim nothing here — the ordinal is per (owner, connector, tool)",
  );
}

eq(classifyConnectorOpTier(grantBorrowToolName("rowan_hale", "notion", "notion_fetch")), "read", "a borrow name for a read tool classifies read");
eq(
  classifyConnectorOpTier(grantBorrowToolName("delete_bot", "notion", "notion_fetch")),
  "read",
  "…and an owner segment spelling a DESTRUCTIVE verb leaves it read — the middle segment is inert",
);
eq(classifyConnectorOpTier(grantBorrowToolName("rowan_hale", "search", "notion_create_pages")), "write", "…and a CONNECTOR id spelling a read verb cannot open a write tool either");

console.log("2. slugifying a vendor tool name:");

eq(grantToolSlug("notion-fetch"), "notion_fetch", "a hyphenated vendor name becomes an underscored segment");
eq(grantToolSlug("Notion Fetch!"), "notion_fetch", "case, spaces and punctuation all fold to the segment alphabet");
eq(grantToolSlug("notion__fetch"), "notion_fetch", "🔴 a vendor DOUBLE UNDERSCORE collapses to one — it can never split the mounted name into four segments");
eq(grantToolSlug("__fetch__"), "fetch", "leading and trailing separators are trimmed");
eq(grantToolSlug("!!!"), undefined, "a name with no legal characters yields NOTHING — a refusal, never a generated stand-in");
eq(grantToolSlug(""), undefined, "…and so does an empty name");

for (const raw of ["notion-fetch", "A B C", "get/self", "tool.v2", "  spaced  ", "MiXeD__CaSe--x", "9lives", "notion__fetch__deep"]) {
  const slug = grantToolSlug(raw);
  ok(slug === undefined || isGrantNameSegment(slug), `"${raw}" slugifies to something isGrantNameSegment accepts, or to nothing`);
  ok(slug === undefined || !slug.includes("__"), `"${raw}" never yields a segment holding __`);
}
ok(!isGrantNameSegment("notion__fetch"), "…and isGrantNameSegment REFUSES a string holding __, so the property above has teeth");
ok(!isGrantNameSegment("Notion"), "…and refuses an uppercase one");

console.log("3. the tier pinned on a borrow:");

_resetGrantableVerbsForTest();
registerGrantableVerb({
  compose: () => ({ method: "GET", url: "https://api.notion.com/v1/blocks/x/children" }),
  connector: "notion",
  describe: () => "read a page",
  inputSchema: { properties: {}, type: "object" },
  resourceKind: "page",
  tier: "read",
  verb: "read_page",
});

const baseBorrow: GrantMintInput = {
  connector: "notion",
  domainGrantsConnector: true,
  liveAsk: undefined,
  liveGrant: undefined,
  borrow: { mcpTool: "notion-fetch", takenToolNames: [] },
  ownerHandle: "Rowan Hale",
  ownerPrincipalId: "slack/W1/U-owner",
  requesterPrincipalId: "slack/W1/U-req",
  resource: "not-an-address",
  verb: "frobnicate",
};

{
  const verdict = credentialGrantMintVerdict(baseBorrow);
  ok(verdict.ok, "a READ vendor tool, in a granting domain, with one verified requester, MINTS a borrow");
  eq(verdict.ok ? verdict.toolName : "", "grant__rowan_long_notion__notion_fetch", "…under the borrow grammar, with the handle slugified into the owner segment");
  eq(verdict.ok ? verdict.tier : "", "read", "…and the tier is read");
}

const OPS: readonly string[] = ["notion-fetch", "notion-search", "notion-get-comments", "notion-create-pages", "notion-update-page", "notion-delete-block", "frobnicate"];
let readOps = 0;
let refusedOps = 0;
for (const op of OPS) {
  const dmTier = classifyConnectorOpTier(`notion__${op}`);
  const verdict = credentialGrantMintVerdict({ ...baseBorrow, borrow: { mcpTool: op, takenToolNames: [] } });
  if (dmTier === "read") {
    readOps++;
    ok(verdict.ok, `"${op}" classifies read in a DM, so it mints as a borrow`);
    eq(verdict.ok ? verdict.tier : "", dmTier, `…and the tier pinned on the row is BYTE-IDENTICAL to the DM classification for "${op}"`);
  } else {
    refusedOps++;
    ok(!verdict.ok && verdict.reason === "write_verb_out_of_slice", `"${op}" classifies ${dmTier} in a DM, so the borrow is refused BY NAME — read-only slice`);
  }
}
ok(readOps >= 3 && refusedOps >= 3, "the op table exercises both arms — neither branch above passed by never running");
eq(classifyConnectorOpTier("notion__frobnicate"), "destructive", "an UNRECOGNISED vendor op fails closed to destructive, so it can never be borrowed by accident");

{
  const verdict = credentialGrantMintVerdict({ ...baseBorrow, borrow: { mcpTool: "!!!", takenToolNames: [] } });
  ok(!verdict.ok && verdict.reason === "illegal_tool_name", "a tool name with no legal characters is refused BY NAME rather than throwing out of a pure verdict");
  ok(grantMintRefusalMessage("notion", "illegal_tool_name").length > 40, "…and its refusal copy names the boundary rather than saying no");
}
{
  const verdict = credentialGrantMintVerdict({ ...baseBorrow, connector: "no__tion" });
  ok(!verdict.ok && verdict.reason === "illegal_connector_id", "a connector id that cannot be a name segment is refused under its OWN name, never mangled into one");
  const copy = grantMintRefusalMessage("no__tion", "illegal_connector_id");
  ok(copy.length > 40 && !copy.includes("Name the"), "…and its copy blames the DEPLOYMENT, never telling the requester to re-spell a tool name that was already right");
}
{
  const verdict = credentialGrantMintVerdict({ ...baseBorrow, ownerHandle: "!!!" });
  ok(!verdict.ok && verdict.reason === "illegal_owner_handle", "the owner-handle refusal still runs on the borrow path");
}
{
  const verdict = credentialGrantMintVerdict({ ...baseBorrow, domainGrantsConnector: false });
  ok(!verdict.ok && verdict.reason === "no_domain_grant", "…and so does the domain check");
}
{
  const verdict = credentialGrantMintVerdict({ ...baseBorrow, borrow: { mcpTool: "notion-fetch", takenToolNames: ["grant__rowan_long_notion__notion_fetch"] } });
  eq(verdict.ok ? verdict.toolName : "", "grant__rowan_long_notion_2__notion_fetch", "a name already claimed in the chat pushes the mint to the next ordinal");
}
{
  const verdict = credentialGrantMintVerdict({
    connector: "notion",
    domainGrantsConnector: true,
    liveAsk: undefined,
    liveGrant: undefined,
    ownerHandle: "Rowan Hale",
    ownerPrincipalId: "slack/W1/U-owner",
    requesterPrincipalId: "slack/W1/U-req",
    resource: "notion:page/abc123",
    verb: "read_page",
  });
  ok(verdict.ok, "with no mcpTool the REGISTRY path runs, unchanged");
  eq(verdict.ok ? verdict.toolName : "", "grant__rowan_long__read_page", "…and still mints grant__<owner>__<verb>");
}

console.log("4. the JSON columns and the frozen-args digest:");

eq(grantJsonColumn(undefined), null, "an absent JSON field is NULL in the column");
eq(grantJsonColumn({}), "{}", "…and an EMPTY object is '{}' — the two never collapse into one spelling");
eq(grantJsonColumn({ b: 1, a: 2 }), '{"a":2,"b":1}', "the column holds CANONICAL JSON, with keys in code-unit order");
eq(grantJsonFromColumn(null, "c"), undefined, "NULL reads back as absent");
eq(grantJsonFromColumn(undefined, "c"), undefined, "…and so does a column the migration has not reached yet");
eq(grantJsonFromColumn("{}", "c"), {}, "…and '{}' reads back as an empty object, NOT as absent");
throws(() => grantJsonFromColumn("not json", "c"), "🔴 a malformed column THROWS — a corrupt frozen-args value must never read as 'nothing frozen'");
throws(() => grantJsonFromColumn("[1,2]", "c"), "…and an ARRAY throws too: the field is a JSON object or it is nothing");
throws(() => grantJsonFromColumn('"a string"', "c"), "…and so does a bare string");
throws(() => grantJsonColumn({ bad: () => 1 } as unknown as Record<string, unknown>), "a value JSON cannot hold is refused at the WRITE, not silently dropped");
throws(() => grantJsonColumn({ bad: Number.NaN }), "…and so is NaN");
throws(() => grantJsonColumn({ when: new Date(NOW) }), "🔴 a NON-PLAIN object is refused — Object.entries would flatten a Date to {}, and an empty value enforces nothing");
throws(() => grantJsonColumn({ keep: 1, page: undefined }), "🔴 an UNDEFINED property is refused, not dropped — JSON.stringify would silently turn a frozen page id into no constraint at all");
throws(() => grantJsonColumn({ nested: { page: undefined } }), "…at any depth, so a nested freeze cannot decay to an empty object either");
throws(() => grantJsonColumn({ list: [undefined] }), "…and inside an array, which is where the old behaviour already refused it");
throws(() => grantJsonColumn({ seen: new Map([["a", 1]]) }), "…and so is a Map, for the same reason");
{
  const cyclic: Record<string, unknown> = { page: "A" };
  cyclic.self = cyclic;
  throws(() => grantJsonColumn(cyclic), "a CYCLIC object is refused by the depth bound, so it names a boundary instead of dying on the stack");
}
eq(grantJsonColumn({ deep: { nested: { ok: [1, 2, { yes: true }] } } }), '{"deep":{"nested":{"ok":[1,2,{"yes":true}]}}}', "…while ordinary nesting canonicalises to the end");

eq(
  grantFrozenArgsDigest({ depth: 2, page: "A" }),
  grantFrozenArgsDigest({ page: "A", depth: 2 }),
  "the digest ignores KEY ORDER — the same frozen arguments are the same grant however they were spelled",
);
eq(
  grantFrozenArgsDigest({ page: { id: "A", nested: [1, { z: true }] } }),
  grantFrozenArgsDigest({ page: { nested: [1, { z: true }], id: "A" } }),
  "…recursively, so a nested object is compared structurally rather than as text",
);
ok(grantFrozenArgsDigest({ page: "A" }) !== grantFrozenArgsDigest({ page: "B" }), "…and a DIFFERENT value is a different digest, so the comparison has teeth");
ok(grantFrozenArgsDigest({}) !== grantFrozenArgsDigest({ page: "A" }), "…and 'nothing frozen' is not the same key as 'page A frozen'");
ok(grantFrozenArgsDigest({ page: [1, 2] }) !== grantFrozenArgsDigest({ page: [2, 1] }), "ARRAY ORDER is significant — an array is a value, not a set");

console.log("5. both store backends, over the same assertions:");

const FROZEN = { depth: 2, page: "page-A", filter: { kind: "block", tags: ["x", "y"] } };
const SCHEMA = { properties: { query: { type: "string" } }, required: ["query"], type: "object" };

function askRow(id: string, patch: Partial<CredentialGrantAskRow> = {}): CredentialGrantAskRow {
  return {
    connector: "notion",
    createdAt: iso(NOW),
    expiresAt: iso(NOW + 30 * 60_000),
    frozenArgs: FROZEN,
    id,
    mcpTool: "notion-fetch",
    ownerNativeId: "U-owner",
    ownerPlatform: "slack",
    ownerPrincipalId: "slack/W1/U-owner",
    ownerSlug: "rowan_hale",
    purpose: "read the launch page",
    requestedMode: "once",
    requesterPrincipalId: "slack/W1/U-req",
    resource: "notion:page/page-A",
    scopeKey: "session-borrow",
    status: "pending",
    toolName: "grant__rowan_hale_notion__notion_fetch",
    verb: "read_page",
    ...patch,
  };
}

function grantRow(id: string, patch: Partial<CredentialGrantRow> = {}): CredentialGrantRow {
  return {
    askId: `ask-of-${id}`,
    connector: "notion",
    createdAt: iso(NOW),
    expiresAt: iso(NOW + 60 * 60_000),
    frozenArgs: FROZEN,
    id,
    inputSchema: SCHEMA,
    mcpTool: "notion-fetch",
    mode: "session",
    ownerPrincipalId: "slack/W1/U-owner",
    ownerSlug: "rowan_hale",
    purpose: "read the launch page",
    requesterPrincipalId: "slack/W1/U-req",
    resource: "notion:page/page-A",
    scopeKey: "session-borrow",
    status: "active",
    tier: "read",
    toolName: "grant__rowan_hale_notion__notion_fetch",
    verb: "read_page",
    ...patch,
  };
}

async function backendLegs(store: OperationalStore, label: string): Promise<void> {
  await store.addCredentialGrantAsk(ORG, askRow("ask-full"));
  const ask = await store.getCredentialGrantAsk(ORG, "ask-full");
  eq(ask?.mcpTool, "notion-fetch", `${label}: the ask's vendor tool name round-trips in the vendor's EXACT bytes, hyphen and all`);
  eq(ask?.frozenArgs, FROZEN, `${label}: the ask's frozen arguments round-trip structurally, nesting and arrays included`);
  eq(ask?.toolName, "grant__rowan_hale_notion__notion_fetch", `${label}: the ask's pinned mounted name round-trips`);

  await store.addCredentialGrant(ORG, grantRow("g-full"));
  const grant = await store.getCredentialGrant(ORG, "g-full");
  eq(grant?.mcpTool, "notion-fetch", `${label}: the grant's vendor tool name round-trips`);
  eq(grant?.frozenArgs, FROZEN, `${label}: the grant's frozen arguments round-trip`);
  eq(grant?.toolName, "grant__rowan_hale_notion__notion_fetch", `${label}: the grant's mounted name round-trips`);
  eq(grant?.inputSchema, SCHEMA, `${label}: the grant's post-bake schema snapshot round-trips`);
  eq(grant?.tier, "read", `${label}: the pinned tier round-trips`);

  await store.addCredentialGrant(ORG, grantRow("g-empty", { frozenArgs: {}, scopeKey: "session-empty" }));
  const empty = await store.getCredentialGrant(ORG, "g-empty");
  eq(empty?.frozenArgs, {}, `${label}: a borrow that froze NOTHING reads back as {} — not as absent`);

  await store.addCredentialGrant(
    ORG,
    { ...grantRow("g-legacy", { scopeKey: "session-legacy" }), frozenArgs: undefined, inputSchema: undefined, mcpTool: undefined, toolName: undefined },
  );
  const legacy = await store.getCredentialGrant(ORG, "g-legacy");
  eq(legacy?.mcpTool, undefined, `${label}: a registry-path row names NO vendor tool, and absence survives the round trip`);
  eq(legacy?.frozenArgs, undefined, `${label}: …and no frozen arguments — absent, never {}`);
  eq(legacy?.toolName, undefined, `${label}: …and no pinned mounted name`);
  eq(legacy?.inputSchema, undefined, `${label}: …and no schema snapshot`);
  ok(legacy?.verb === "read_page" && legacy.resource === "notion:page/page-A", `${label}: …while every column it DOES carry is unchanged`);

  const key = grantFrozenArgsDigest(FROZEN);
  const found = await store.liveBorrowCredentialGrant(ORG, "slack/W1/U-owner", "notion", "notion-fetch", key, "session-borrow", iso(NOW));
  eq(found?.id, "g-full", `${label}: the live borrow is found under (owner, connector, mcpTool, digest, scope)`);
  eq(
    (await store.liveBorrowCredentialGrant(ORG, "slack/W1/U-owner", "notion", "notion-fetch", grantFrozenArgsDigest({ ...FROZEN, page: "page-B" }), "session-borrow", iso(NOW)))?.id,
    undefined,
    `${label}: 🔴 the SAME tool frozen to a DIFFERENT resource finds nothing — that is the whole relaxation, and it is what lets a second grant be asked for`,
  );
  eq(
    (await store.liveBorrowCredentialGrant(ORG, "slack/W1/U-owner", "notion", "notion-fetch", grantFrozenArgsDigest({ filter: { kind: "block", tags: ["x", "y"] }, page: "page-A", depth: 2 }), "session-borrow", iso(NOW)))?.id,
    "g-full",
    `${label}: …while the same arguments in a DIFFERENT KEY ORDER are the same grant`,
  );
  eq(
    (await store.liveBorrowCredentialGrant(ORG, "slack/W1/U-other", "notion", "notion-fetch", key, "session-borrow", iso(NOW)))?.id,
    undefined,
    `${label}: another owner's grant never answers this owner's lookup`,
  );
  eq(
    (await store.liveBorrowCredentialGrant(ORG, "slack/W1/U-owner", "notion", "notion-search", key, "session-borrow", iso(NOW)))?.id,
    undefined,
    `${label}: another vendor TOOL never answers it either`,
  );
  eq(
    (await store.liveBorrowCredentialGrant(ORG, "slack/W1/U-owner", "notion", "notion-fetch", key, "session-elsewhere", iso(NOW)))?.id,
    undefined,
    `${label}: and a grant approved for another chat is out of scope`,
  );
  eq(
    (await store.liveBorrowCredentialGrant(ORG, "slack/W1/U-owner", "notion", "notion-fetch", key, "session-borrow", iso(NOW + 120 * 60_000)))?.id,
    undefined,
    `${label}: an EXPIRED grant stops blocking a fresh ask, even before any sweep has run`,
  );

  await rejects(
    () => store.addCredentialGrant(ORG, { ...grantRow("g-half", { scopeKey: "session-half" }), frozenArgs: undefined }),
    `${label}: a grant naming a vendor tool with NO frozen arguments is refused at the write`,
  );
  await rejects(
    () => store.addCredentialGrant(ORG, { ...grantRow("g-half2", { scopeKey: "session-half" }), toolName: undefined }),
    `${label}: …and so is one with no pinned mounted name`,
  );
  await rejects(
    () => store.addCredentialGrantAsk(ORG, { ...askRow("ask-half"), mcpTool: undefined }),
    `${label}: …and an ASK that froze arguments for no named tool`,
  );
  await rejects(
    () => store.addCredentialGrant(ORG, { ...grantRow("g-schema-only", { scopeKey: "session-half" }), frozenArgs: undefined, mcpTool: undefined, toolName: undefined }),
    `${label}: …and a schema snapshot with no vendor tool to snapshot`,
  );
  eq(
    (await store.liveBorrowCredentialGrant(ORG, "slack/W1/U-owner", "notion", "notion-fetch", grantFrozenArgsDigest({}), "session-empty", iso(NOW)))?.id,
    "g-empty",
    `${label}: …while a row that froze {} IS found under the digest of {} — absence and {} are two different rows`,
  );

  ok(await store.revokeCredentialGrant(ORG, "g-full", iso(NOW + 60_000)), `${label}: the grant revokes`);
  eq(
    (await store.liveBorrowCredentialGrant(ORG, "slack/W1/U-owner", "notion", "notion-fetch", key, "session-borrow", iso(NOW + 120_000)))?.id,
    undefined,
    `${label}: …and a revoked grant is no longer the live borrow`,
  );
}

await backendLegs(sqliteOperationalStore, "sqlite");

const pg = await openTestPg();
await initOperationalSchema(pg.client);
await backendLegs(makeOperationalPostgresStore(pg.client), "postgres");
await closeAllTestPg();

console.log("6. the ask's borrow columns reach the grant:");

{
  const ask = askRow("ask-carry");
  const grant = credentialGrantFromAsk(ask, {
    expiresAt: iso(NOW + 60 * 60_000),
    grantId: "g-carry",
    inputSchema: SCHEMA,
    mode: "once",
    nowIso: iso(NOW),
    ownerSlug: ask.ownerSlug,
    tier: "read",
  });
  eq(grant.mcpTool, "notion-fetch", "the vendor tool the owner's card named is the one the grant carries");
  eq(grant.frozenArgs, FROZEN, "…and so are the frozen arguments the card rendered");
  eq(grant.toolName, "grant__rowan_long_notion__notion_fetch", "…and the mounted name the card promised, ordinal and all");
  eq(grant.inputSchema, SCHEMA, "…while the schema snapshot comes from the APPROVE-time read, not from the ask");
}
{
  const legacy = credentialGrantFromAsk(
    { ...askRow("ask-legacy"), frozenArgs: undefined, mcpTool: undefined, toolName: undefined },
    { expiresAt: iso(NOW + 60 * 60_000), grantId: "g-carry-legacy", mode: "once", nowIso: iso(NOW), ownerSlug: "rowan_hale", tier: "read" },
  );
  eq(legacy.mcpTool, undefined, "a registry-path ask mints a grant naming no vendor tool — the carry adds nothing that was not decided");
  eq(legacy.frozenArgs, undefined, "…and no frozen arguments");
  eq(legacy.toolName, undefined, "…and no pinned mounted name, so the mount still composes one from ownerSlug and verb");
  eq(legacy.inputSchema, undefined, "…and no schema snapshot");
}

console.log(`\n✅ credential-grant borrow rows + grammar: ${String(n)} assertions passed`);

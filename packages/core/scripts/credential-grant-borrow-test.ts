import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-borrow-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import { classifyConnectorOpTier, parseQualifiedToolName } from "../agent/access/consequence.js";
import { credentialGrantFromAsk, credentialGrantMintVerdict, grantMintRefusalMessage, type GrantMintInput } from "../agent/access/credential-grant.js";
import {
  grantBorrowRowSuffix,
  grantBorrowToolName,
  grantBorrowVerbSegment,
  GRANT_TOOL_NAME_MAX,
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
const ROW_ID = "00000000-0000-4000-8000-000000000009";
const NOW = Date.parse("2026-01-20T16:07:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

console.log("1. the borrow name grammar:");

eq(
  grantBorrowToolName("rowan_hale", "notion", "notion_fetch_q3"),
  "grant__rowan_hale_notion__notion_fetch_q3",
  "the grammar is grant__<owner>_<connector>__<verbSegment>, with the vendor in the MIDDLE segment",
);
eq(grantBorrowVerbSegment("notion_fetch", "quarterly_report", 40), "notion_fetch_quarterly_report", "the verb segment is <toolSlug>_<targetSlug> — the ruled `verb_slug` shape");
eq(grantBorrowVerbSegment("notion_fetch", undefined, 40), "notion_fetch", "an unslugifiable target label leaves the tool slug alone — a legal name, only less meaningful");
eq(grantBorrowVerbSegment("notion_fetch", "quarterly_report", 20), "notion_fetch_quarter", "🔴 ONLY THE TARGET HALF TRUNCATES, and it is cut to the budget");
eq(grantBorrowVerbSegment("notion_fetch", "quarterly_report", 13), "notion_fetch", "a budget that leaves the target no room drops it rather than emitting a bare separator");
eq(grantBorrowVerbSegment("notion_fetch", "ab_cd_ef", 18), "notion_fetch_ab_cd", "a cut landing mid-word keeps what fits");
eq(grantBorrowVerbSegment("notion_fetch", "ab_cd_ef", 16), "notion_fetch_ab", "🔴 a cut landing ON the separator strips it — a segment may never end in _");
eq(grantBorrowVerbSegment("notion_fetch", "quarterly", 5), undefined, "a budget the TOOL slug cannot fit refuses outright — truncating it would name a different tool");
for (const budget of [13, 16, 18, 20, 40]) {
  const seg = grantBorrowVerbSegment("notion_fetch", "ab_cd_ef", budget);
  ok(seg !== undefined && isGrantNameSegment(seg), `budget ${String(budget)}: the composed verb segment is one isGrantNameSegment accepts`);
  ok(seg !== undefined && seg.length <= budget, `budget ${String(budget)}: …and it honours the budget`);
}

eq(grantBorrowRowSuffix("00000000-0000-4000-8000-000000000010"), "3f2504", "the collision suffix is the first six segment-legal characters of the row id");
eq(grantBorrowRowSuffix("----"), undefined, "an id with too few usable characters yields NOTHING — a refusal, never a padded stand-in");

for (const target of ["quarterly_report", undefined]) {
  const name = grantBorrowToolName("rowan_hale", "notion", grantBorrowVerbSegment("notion_fetch", target, 40)!);
  ok(isGrantToolName(name), `target ${String(target)}: the composed name is one isGrantToolName accepts`);
  eq(name.split("__").length, 3, `target ${String(target)}: the composed name holds EXACTLY three segments, so S0's parser reads a verb from it`);
}
ok(!isGrantToolName("grant__rowan_hale__notion__notion_fetch"), "…and a FOUR-segment name is refused by the same predicate — the check has teeth");
eq(
  parseQualifiedToolName("grant__rowan_hale_notion__notion_fetch_q3")?.verb,
  "notion_fetch_q3",
  "S0's parser reads the whole verb segment as the verb, and the owner+connector as the owner segment",
);

throws(() => grantBorrowToolName("rowan__hale", "notion", "notion_fetch"), "an owner segment holding __ throws rather than emitting a four-segment name");
throws(() => grantBorrowToolName("rowan_hale", "notion__x", "notion_fetch"), "a connector segment holding __ throws");
throws(() => grantBorrowToolName("rowan_hale", "notion", "notion-fetch"), "an UNSLUGIFIED verb segment throws — the caller composes it with grantBorrowVerbSegment first");
throws(
  () => grantBorrowToolName("t".repeat(40), "notion", "notion_fetch_quarterly_report"),
  `a name past the ${String(GRANT_TOOL_NAME_MAX)}-character bound throws rather than mounting a tool a model provider would reject`,
);

{
  const ROW_A = "00000000-0000-4000-8000-000000000011";
  const ROW_B = "00000000-0000-4000-8000-000000000012";
  const first = nextGrantBorrowToolName("rowan_hale", "notion", "notion_fetch", "quarterly_report", ROW_A, []);
  eq(first, "grant__rowan_hale_notion__notion_fetch_quarterly_report", "with nothing claimed, the next name is the bare <tool>_<target> one — NO row-id suffix");
  eq(
    nextGrantBorrowToolName("rowan_hale", "notion", "notion_fetch", "team_okrs", ROW_B, [first!]),
    "grant__rowan_hale_notion__notion_fetch_team_okrs",
    "🔴 A SECOND GRANT OF THE SAME TOOL ON A DIFFERENT TARGET NEEDS NO SUFFIX — the two names differ by what they differ about",
  );
  eq(
    nextGrantBorrowToolName("rowan_hale", "notion", "notion_fetch", "quarterly_report", ROW_B, [first!]),
    "grant__rowan_hale_notion__notion_fetch_quarterly_report_cc33dd",
    "…and only a genuine same-tool-same-label collision pays for the row-id fragment",
  );
  eq(
    nextGrantBorrowToolName("rowan_hale", "notion", "notion_fetch", "quarterly_report", ROW_A, []),
    first,
    "the suffix is NOT applied when nothing is claimed, whatever the row id is",
  );
  eq(
    nextGrantBorrowToolName("rowan_hale", "notion", "notion_fetch", "quarterly_report", ROW_B, [
      "grant__someone_else_notion__notion_fetch_quarterly_report",
      "grant__rowan_hale_notion__notion_search_quarterly_report",
    ]),
    first,
    "another person's name and another tool's name claim nothing here — the collision is per (owner, connector, tool, target)",
  );
  eq(
    nextGrantBorrowToolName("rowan_hale", "notion", "notion_fetch", "quarterly_report", ROW_A, [first!, `${first!}_aa11bb`]),
    undefined,
    "🔴 BOTH CANDIDATES CLAIMED REFUSES — it needs one row id to have asked twice, so a name is never invented past the grammar",
  );
  eq(
    nextGrantBorrowToolName("rowan_hale", "notion", "notion_fetch", "quarterly_report", "----", []),
    undefined,
    "a row id with no usable characters refuses — the collision suffix must be available BEFORE the bare name is offered",
  );
  const longTarget = "a_very_long_target_label_that_will_certainly_be_truncated_somewhere";
  const bare = nextGrantBorrowToolName("rowan_hale", "notion", "notion_fetch", longTarget, ROW_A, []);
  const collided = nextGrantBorrowToolName("rowan_hale", "notion", "notion_fetch", longTarget, ROW_A, [bare!]);
  ok(bare !== undefined && collided !== undefined && collided === `${bare}_aa11bb`, "the collided name is the bare one plus the fragment — the truncation did not move");
  ok(collided!.length <= GRANT_TOOL_NAME_MAX, `…and it still fits the ${String(GRANT_TOOL_NAME_MAX)}-character bound`);
  ok(bare!.length <= GRANT_TOOL_NAME_MAX, "…as does the bare one");
}

eq(classifyConnectorOpTier(grantBorrowToolName("rowan_hale", "notion", "notion_fetch")), "read", "a borrow name for a read tool classifies read");
eq(
  classifyConnectorOpTier(grantBorrowToolName("delete_bot", "notion", "notion_fetch")),
  "read",
  "…and an owner segment spelling a DESTRUCTIVE verb leaves it read — the middle segment is inert",
);
eq(classifyConnectorOpTier(grantBorrowToolName("rowan_hale", "search", "notion_create_pages")), "write", "…and a CONNECTOR id spelling a read verb cannot open a write tool either");

eq(classifyConnectorOpTier(grantBorrowToolName("rowan_hale", "notion", "notion_fetch_quarterly_report")), "read", "a neutral target label leaves a read tool read");
eq(
  classifyConnectorOpTier(grantBorrowToolName("rowan_hale", "notion", "notion_fetch_delete_me")),
  "destructive",
  "🔴 a target label spelling a DESTRUCTIVE verb RAISES the mounted name's tier — friction in the safe direction",
);
eq(
  classifyConnectorOpTier(grantBorrowToolName("rowan_hale", "notion", "notion_create_pages_read_only")),
  "write",
  "…and a label spelling a READ verb cannot LOWER a write tool: `best` is already `write` when the tail is scanned",
);

eq(classifyConnectorOpTier(grantBorrowToolName("rowan_hale", "notion", "notion_frobnicate")), "destructive", "an UNRECOGNISED tool slug classifies destructive on its own…");
eq(
  classifyConnectorOpTier(grantBorrowToolName("rowan_hale", "notion", "notion_frobnicate_search_results")),
  "read",
  "🔴 …and a READ token in the target tail LOWERS it to read — the tail is NOT raise-only over an unrecognised head",
);

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

const baseBorrow: GrantMintInput = {
  borrow: { mcpTool: "notion-fetch", rowId: ROW_ID, takenToolNames: [], targetLabel: "Quarterly report" },
  connector: "notion",
  domainGrantsConnector: true,
  liveAsk: undefined,
  liveGrant: undefined,
  ownerHandle: "Rowan Hale",
  ownerPrincipalId: "slack/W1/U-owner",
  requesterPrincipalId: "slack/W1/U-req",
};

{
  const verdict = credentialGrantMintVerdict(baseBorrow);
  ok(verdict.ok, "a READ vendor tool, in a granting domain, with one verified requester, MINTS a borrow");
  eq(
    verdict.ok ? verdict.toolName : "",
    "grant__rowan_hale_notion__notion_fetch_quarterly_report",
    "…under the borrow grammar, with the handle slugified into the owner segment and the target label into the verb segment",
  );
  eq(verdict.ok ? verdict.tier : "", "read", "…and the tier is read");
}

const OPS: readonly string[] = ["notion-fetch", "notion-search", "notion-get-comments", "notion-create-pages", "notion-update-page", "notion-delete-block", "frobnicate"];
let readOps = 0;
let refusedOps = 0;
for (const op of OPS) {
  const dmTier = classifyConnectorOpTier(`notion__${op}`);
  const verdict = credentialGrantMintVerdict({ ...baseBorrow, borrow: { ...baseBorrow.borrow, mcpTool: op } });
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
  const unrecognised = credentialGrantMintVerdict({ ...baseBorrow, borrow: { ...baseBorrow.borrow, mcpTool: "notion-frobnicate" } });
  ok(!unrecognised.ok && unrecognised.reason === "write_verb_out_of_slice", "the mint REFUSES a vendor tool whose own classification is not read, so the head is never unrecognised");
  const recognised = credentialGrantMintVerdict({ ...baseBorrow, borrow: { ...baseBorrow.borrow, mcpTool: "notion-fetch" } });
  ok(recognised.ok, "…while a read tool mints, so the refusal above is discriminating rather than universal");
  eq(
    classifyConnectorOpTier(recognised.ok ? recognised.toolName : ""),
    "read",
    "…and the name it minted classifies read on the FLOOR its head supplies, whatever the target label says",
  );
}

{
  const verdict = credentialGrantMintVerdict({ ...baseBorrow, borrow: { ...baseBorrow.borrow, mcpTool: "!!!" } });
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
  const verdict = credentialGrantMintVerdict({
    ...baseBorrow,
    borrow: { ...baseBorrow.borrow, takenToolNames: ["grant__rowan_hale_notion__notion_fetch_quarterly_report"] },
  });
  eq(
    verdict.ok ? verdict.toolName : "",
    `grant__rowan_hale_notion__notion_fetch_quarterly_report_${ROW_ID.replace(/[^a-z0-9]/gu, "").slice(0, 6)}`,
    "a name already claimed in the chat pushes the mint onto the row-id fragment",
  );
}
{
  const verdict = credentialGrantMintVerdict({
    ...baseBorrow,
    borrow: { ...baseBorrow.borrow, takenToolNames: ["grant__rowan_hale_notion__notion_fetch_quarterly_report"], targetLabel: "Team OKRs" },
  });
  eq(verdict.ok ? verdict.toolName : "", "grant__rowan_hale_notion__notion_fetch_team_okrs", "…while a second grant of the same tool on a DIFFERENT target keeps a meaning-carrying name");
}
{
  const verdict = credentialGrantMintVerdict({ ...baseBorrow, borrow: { ...baseBorrow.borrow, targetLabel: "!!!" } });
  eq(verdict.ok ? verdict.toolName : "", "grant__rowan_hale_notion__notion_fetch", "an unslugifiable target label is NOT a refusal — the name falls back to the tool slug alone");
}
{
  const verdict = credentialGrantMintVerdict({ ...baseBorrow, borrow: { ...baseBorrow.borrow, rowId: "----" } });
  ok(!verdict.ok && verdict.reason === "illegal_tool_name", "a row id the collision suffix cannot be drawn from refuses BY NAME rather than throwing out of a pure verdict");
}
{
  const verdict = credentialGrantMintVerdict({ ...baseBorrow, ownerHandle: "t".repeat(48) });
  ok(!verdict.ok && verdict.reason === "illegal_tool_name", `an owner handle that pushes the name past ${String(GRANT_TOOL_NAME_MAX)} characters refuses rather than mounting an over-long name`);
}
{
  const verdict = credentialGrantMintVerdict(baseBorrow);
  ok(verdict.ok && verdict.toolName.split("__")[1] === "rowan_hale_notion", "every name the mint composes carries the connector in the middle segment — the borrow grammar and no other");
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

type NullBorrowColumns = (grantId: string) => Promise<void>;

async function backendLegs(store: OperationalStore, label: string, nullBorrowColumns: NullBorrowColumns): Promise<void> {
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

  await rejects(
    async () =>
      await store.addCredentialGrant(ORG, {
        ...grantRow("g-legacy", { scopeKey: "session-legacy" }),
        frozenArgs: undefined,
        inputSchema: undefined,
        mcpTool: undefined,
        toolName: undefined,
      }),
    `${label}: 🔴 a grant naming no vendor tool is refused at the insert — the verb-registry row shape is no longer legal`,
  );
  eq(await store.getCredentialGrant(ORG, "g-legacy"), null, `${label}: …and the refused insert wrote nothing`);

  await store.addCredentialGrant(ORG, grantRow("g-persisted-legacy", { scopeKey: "session-legacy" }));
  await nullBorrowColumns("g-persisted-legacy");
  const persisted = await store.getCredentialGrant(ORG, "g-persisted-legacy");
  ok(persisted !== null, `${label}: 🔴 a row an older build persisted still READS — a throwing reader would take down every caller of the scope read`);
  eq(persisted?.mcpTool, undefined, `${label}: …and names no vendor tool`);
  eq(persisted?.frozenArgs, undefined, `${label}: …and no frozen arguments — absent, never {}`);
  eq(persisted?.toolName, undefined, `${label}: …and no pinned mounted name`);
  eq(persisted?.inputSchema, undefined, `${label}: …and no schema snapshot`);
  ok(
    persisted?.verb === "read_page" && persisted.status === "active",
    `${label}: …while every column it DOES carry is unchanged, so the assertions above are not reading a row that failed to write`,
  );
  ok(
    (await store.credentialGrantsForScope(ORG, "session-legacy")).some((r) => r.id === "g-persisted-legacy"),
    `${label}: …and the SCOPE read returns it too — the mount's own read is the one a throw would break`,
  );

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
  await assert.rejects(
    () => store.addCredentialGrant(ORG, { ...grantRow("g-schema-only", { scopeKey: "session-half" }), frozenArgs: undefined, mcpTool: undefined, toolName: undefined }),
    /schema snapshot/u,
    `${label}: …and a schema snapshot with no vendor tool to snapshot, refused under THAT name rather than the generic missing-columns one`,
  );
  n++;
  eq(
    (await store.liveBorrowCredentialGrant(ORG, "slack/W1/U-owner", "notion", "notion-fetch", grantFrozenArgsDigest({}), "session-empty", iso(NOW)))?.id,
    "g-empty",
    `${label}: …while a row that froze {} IS found under the digest of {} — absence and {} are two different rows`,
  );

  await store.addCredentialGrantAsk(ORG, askRow("ask-scope-b", { id: "ask-scope-b", toolName: "grant__rowan_hale_notion__notion_fetch_b" }));
  await store.addCredentialGrantAsk(ORG, askRow("ask-scope-dead", { id: "ask-scope-dead", status: "declined", toolName: "grant__rowan_hale_notion__notion_fetch_dead" }));
  await store.addCredentialGrantAsk(ORG, askRow("ask-scope-other", { id: "ask-scope-other", scopeKey: "session-elsewhere", toolName: "grant__rowan_hale_notion__notion_fetch_other" }));
  const claimed = (await store.pendingCredentialGrantAsksForScope(ORG, "session-borrow", iso(NOW))).map((r) => r.toolName).sort();
  eq(claimed, ["grant__rowan_hale_notion__notion_fetch", "grant__rowan_hale_notion__notion_fetch_b"], `${label}: the scope read returns every PENDING ask in the chat, with its pinned name`);
  ok(!claimed.includes("grant__rowan_hale_notion__notion_fetch_dead"), `${label}: …never a DECLINED one — an ask that will not mount claims no name`);
  ok(!claimed.includes("grant__rowan_hale_notion__notion_fetch_other"), `${label}: …and never another chat's, so one room cannot rename another room's tool`);
  eq(
    (await store.pendingCredentialGrantAsksForScope(ORG, "session-borrow", iso(NOW + 120 * 60_000))).length,
    0,
    `${label}: a LAPSED pending ask reads as gone before any sweep has run — expiry is in the predicate`,
  );

  await store.addCredentialGrant(ORG, grantRow("g-refund", { mode: "once", scopeKey: "session-refund" }));
  const refundBurn = iso(NOW + 1_000);
  ok((await store.burnCredentialGrant(ORG, "g-refund", refundBurn)) !== null, `${label}: the once grant burns`);
  eq(await store.refundCredentialGrant(ORG, "g-refund", iso(NOW + 9_999)), false, `${label}: 🔴 a refund carrying ANOTHER call's burn stamp loses — a loser cannot un-spend the winner's burn`);
  eq((await store.getCredentialGrant(ORG, "g-refund"))?.status, "used", `${label}: …and the row stays spent`);
  eq(await store.refundCredentialGrant(ORG, "g-refund", refundBurn), true, `${label}: the caller that OWNS the stamp refunds it`);
  const refunded = await store.getCredentialGrant(ORG, "g-refund");
  eq(refunded?.status, "active", `${label}: …the grant is ACTIVE again`);
  eq(refunded?.usedAt, undefined, `${label}: …with the burn stamp CLEARED, so a later burn reads no leftover value`);
  ok((await store.burnCredentialGrant(ORG, "g-refund", iso(NOW + 2_000))) !== null, `${label}: …and it can be burned again, which is what makes the refund worth anything`);

  await store.addCredentialGrant(ORG, grantRow("g-refund-race", { mode: "once", scopeKey: "session-race" }));
  const raceBurn = iso(NOW + 1_000);
  ok((await store.burnCredentialGrant(ORG, "g-refund-race", raceBurn)) !== null, `${label}: the once grant burns, and the call is now in flight`);
  eq(await store.revokeCredentialGrant(ORG, "g-refund-race", iso(NOW + 1_500)), false, `${label}: the owner's revoke answers false — the row was already spent, so no LIVE grant was revoked`);
  eq((await store.getCredentialGrant(ORG, "g-refund-race"))?.revokedAt, iso(NOW + 1_500), `${label}: …but it stamped the owner's intent on the row`);
  eq((await store.getCredentialGrant(ORG, "g-refund-race"))?.status, "used", `${label}: …without rewriting the status, so which arm ended the grant is still readable`);
  eq(await store.refundCredentialGrant(ORG, "g-refund-race", raceBurn), false, `${label}: 🔴 the refund then LOSES — an owner's revoke is never undone by a call that refused after it`);
  eq((await store.getCredentialGrant(ORG, "g-refund-race"))?.status, "used", `${label}: …and the grant stays terminal`);

  await store.revokeCredentialGrant(ORG, "g-refund-race", iso(NOW + 5_000));
  eq((await store.getCredentialGrant(ORG, "g-refund-race"))?.revokedAt, iso(NOW + 1_500), `${label}: a second revoke leaves the first stamp alone`);

  ok(await store.revokeCredentialGrant(ORG, "g-full", iso(NOW + 60_000)), `${label}: the grant revokes`);
  eq(
    (await store.liveBorrowCredentialGrant(ORG, "slack/W1/U-owner", "notion", "notion-fetch", key, "session-borrow", iso(NOW + 120_000)))?.id,
    undefined,
    `${label}: …and a revoked grant is no longer the live borrow`,
  );
}

const NULL_BORROW_COLUMNS = "UPDATE credential_grant SET mcp_tool = NULL, frozen_args = NULL, tool_name = NULL, input_schema = NULL WHERE id =";

await backendLegs(sqliteOperationalStore, "sqlite", async (grantId) => {
  const db = new DatabaseSync(process.env.OE_SQLITE_PATH ?? "");
  db.prepare(`${NULL_BORROW_COLUMNS} ?`).run(grantId);
  db.close();
});

const pg = await openTestPg();
await initOperationalSchema(pg.client);
await backendLegs(makeOperationalPostgresStore(pg.client), "postgres", async (grantId) => {
  await pg.client.query(`${NULL_BORROW_COLUMNS} $1`, [grantId]);
});
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
  eq(legacy.mcpTool, undefined, "the carry copies an ABSENT vendor tool as absent — it never invents one");
  eq(legacy.frozenArgs, undefined, "…and absent frozen arguments stay absent, never {}");
  eq(legacy.toolName, undefined, "…and no pinned mounted name is composed in its place");
  eq(legacy.inputSchema, undefined, "…and no schema snapshot");
}

console.log(`\n✅ credential-grant borrow rows + grammar: ${String(n)} assertions passed`);

import {
  classifyConnectorOp,
  classifyConnectorOpTier,
  classifyConnectorOpTierVerdict,
  connectorOpName,
  CONNECTOR_DESTRUCTIVE_VERBS,
  CONNECTOR_READ_VERBS,
  CONNECTOR_WRITE_VERBS,
  isConnectorOpTool,
  isReservedNamespaceTool,
  parseQualifiedToolName,
  TOOL_CONSEQUENCE,
  type ConnectorOpTier,
  type ConnectorOpTierVerdict,
  type OpTierBasis,
} from "../agent/access/consequence.js";
import { WORKER_ONLY_TOOLS_STANDING, WORKER_ONLY_TOOLS_THREAD } from "../agent/access/worker-capability-index.generated.js";
import { connectorOpApproval, connectorApprovalPolicy } from "../agent/connections/connector-auth.js";
import { registerSettings, resetSettingsForTest } from "../agent/settings/settings.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("connector-op-tier");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

ok(isConnectorOpTool("notion__search"), "isConnectorOpTool true for a qualified op");
ok(!isConnectorOpTool("reply"), "isConnectorOpTool false for a bare tool name");
ok(!isConnectorOpTool("read_notion_page"), "isConnectorOpTool false for a single-underscore authored tool");
ok(connectorOpName("notion__create_page") === "create_page", "connectorOpName strips the connection prefix");
ok(connectorOpName("bare") === "bare", "connectorOpName returns the whole name when unqualified");

for (const op of ["notion__search", "notion__list_databases", "linear__get_issue", "gh__read_file", "x__query", "y__find", "z__describe_page", "a__fetch", "b__view_doc", "c__retrieve"]) {
  ok(classifyConnectorOp(op) === "open", `read op ${op} → open`);
}

for (const op of ["notion__create_page", "notion__update_page", "notion__append_block", "linear__create_issue", "gh__delete_branch", "x__post_message", "y__set_property", "z__move_card", "a__archive_page", "b__comment"]) {
  ok(classifyConnectorOp(op) === "gate:member", `write op ${op} → gate:member`);
}

ok(classifyConnectorOp("notion__frobnicate_widget") === "gate:member", "unknown verb → gate:member (fail-safe to gated)");
ok(classifyConnectorOp("notion__") === "gate:member", "empty op → gate:member (fail-safe)");

ok(classifyConnectorOp("notion__notion-fetch") === "open", "vendor-prefixed read (notion__notion-fetch) → open");
ok(classifyConnectorOp("notion__notion-search") === "open", "vendor-prefixed read (notion__notion-search) → open");
ok(classifyConnectorOp("notion__notion-create-pages") === "gate:member", "vendor-prefixed write (notion__notion-create-pages) → gate:member");
ok(classifyConnectorOp("notion__notionette") === "gate:member", "prefix strip requires a separator — notionette is not stripped (fail-safe)");

const approve = connectorOpApproval();
const noneApproved = new Set<string>();
ok(approve({ toolName: "notion__search", approvedTools: noneApproved } as never) === "not-applicable", "read op → not-applicable (no prompt)");
ok((await approve({ toolName: "notion__create_page", approvedTools: noneApproved } as never)) === "user-approval", "unapproved write → user-approval (prompt)");
const oneApproved = new Set<string>(["notion__create_page"]);
ok((await approve({ toolName: "notion__create_page", approvedTools: oneApproved } as never)) === "not-applicable", "already-approved write → not-applicable (once-per-op)");
ok((await approve({ toolName: "notion__delete_page", approvedTools: oneApproved } as never)) === "user-approval", "a DIFFERENT write still prompts (approval is per-op, not blanket)");
ok((await approve({ toolName: "notion__delete_page", approvedTools: new Set<string>(["notion__delete_page"]) } as never)) === "user-approval", "an already-approved DESTRUCTIVE op STILL prompts (per-call, OPE-11)");

resetSettingsForTest();
{
  const off = connectorApprovalPolicy();
  const read = await off({ toolName: "notion__search", approvedTools: new Set<string>() } as never);
  ok(read !== "not-applicable", "flag OFF → once(): an unapproved READ is not auto-allowed (blanket policy)");
}
registerSettings({ connectors: { opTiering: true } });
{
  const on = connectorApprovalPolicy();
  ok((await on({ toolName: "notion__search", approvedTools: new Set<string>() } as never)) === "not-applicable", "flag ON → tiered: a READ is auto-allowed");
  ok((await on({ toolName: "notion__create_page", approvedTools: new Set<string>() } as never)) === "user-approval", "flag ON → tiered: a WRITE prompts");
}
resetSettingsForTest();

{
  resetSettingsForTest();
  const builtBeforeRegistration = connectorApprovalPolicy();
  registerSettings({ connectors: { opTiering: true } });
  ok(
    (await builtBeforeRegistration({ toolName: "notion__search", approvedTools: new Set<string>() } as never)) === "not-applicable",
    "a policy BUILT before registerSettings() still honours the deployment's opTiering (OPE-1450)",
  );
  ok(
    (await builtBeforeRegistration({ toolName: "notion__create_page", approvedTools: new Set<string>() } as never)) === "user-approval",
    "negative control: the same deferred policy still PROMPTS on a write",
  );
  resetSettingsForTest();
}
{
  let reads = 0;
  registerSettings({
    connectors: {
      get opTiering(): boolean {
        reads++;
        return true;
      },
    },
  });
  const afterRegistration = reads;
  const policy = connectorApprovalPolicy();
  ok(reads === afterRegistration, "building the policy performs NO settings read (OPE-1450)");
  await policy({ toolName: "notion__search", approvedTools: new Set<string>() } as never);
  ok(reads > afterRegistration, "negative control: the CALL does read the flag — deferred, not dropped");
  resetSettingsForTest();
}

function oracleTier(toolName: string): ConnectorOpTier {
  let op = connectorOpName(toolName).toLowerCase();
  const sep = toolName.indexOf("__");
  if (sep > 0) {
    const conn = toolName.slice(0, sep).toLowerCase();
    if (op.startsWith(`${conn}-`) || op.startsWith(`${conn}_`)) op = op.slice(conn.length + 1);
  }
  let best: ConnectorOpTier | undefined;
  for (const token of op.split(/[_-]/)) {
    if (CONNECTOR_DESTRUCTIVE_VERBS.includes(token)) return "destructive";
    if (CONNECTOR_WRITE_VERBS.includes(token)) best = "write";
    else if (best === undefined && CONNECTOR_READ_VERBS.includes(token)) best = "read";
  }
  return best ?? "destructive";
}

const TIER_RANK: Readonly<Record<ConnectorOpTier, number>> = { read: 0, write: 1, destructive: 2 };

const BASIS_IMPLIED_TIER: Readonly<Record<OpTierBasis, ConnectorOpTier>> = {
  "read-verb": "read",
  "write-verb": "write",
  "destructive-verb": "destructive",
  unrecognised: "destructive",
};

function hasConnectionPath(toolName: string): boolean {
  const parsed = parseQualifiedToolName(toolName);
  return parsed?.connection !== undefined && parsed.connection.includes("__");
}

function checkedVerdict(toolName: string): ConnectorOpTierVerdict {
  const verdict = classifyConnectorOpTierVerdict(toolName);
  const viaTier = classifyConnectorOpTier(toolName);
  if (viaTier !== verdict.tier) {
    console.error(`✗ NOT OBSERVATION-EQUIVALENT: ${toolName} — classifyConnectorOpTier says ${viaTier}, the verdict says ${verdict.tier}`);
    process.exit(1);
  }
  const implied = BASIS_IMPLIED_TIER[verdict.basis];
  const broken = hasConnectionPath(toolName) ? TIER_RANK[verdict.tier] < TIER_RANK[implied] : verdict.tier !== implied;
  if (broken) {
    console.error(`✗ BASIS LAW BROKEN: ${toolName} — basis ${verdict.basis} implies ${implied}, tier is ${verdict.tier}`);
    process.exit(1);
  }
  return verdict;
}

for (const verb of CONNECTOR_READ_VERBS) {
  const v = checkedVerdict(`notion__${verb}`);
  ok(v.tier === "read" && v.basis === "read-verb", `read verb ${verb} → read on a read-verb basis`);
}
for (const verb of CONNECTOR_WRITE_VERBS) {
  const v = checkedVerdict(`notion__${verb}`);
  ok(v.tier === "write" && v.basis === "write-verb", `write verb ${verb} → write on a write-verb basis`);
}
for (const verb of CONNECTOR_DESTRUCTIVE_VERBS) {
  const v = checkedVerdict(`notion__${verb}`);
  ok(v.tier === "destructive" && v.basis === "destructive-verb", `destructive verb ${verb} → destructive on a destructive-verb basis`);
}

ok(classifyConnectorOpTierVerdict("notion__delete_page").basis === "destructive-verb", "a KNOWN destructive verb reports a destructive-verb basis");
ok(classifyConnectorOpTierVerdict("notion__frobnicate_widget").basis === "unrecognised", "…and an unknown verb at the SAME tier reports `unrecognised` — the fail-closed default, not a delete");
for (const unknown of ["notion__frobnicate", "notion__", "helpdesk__constructor", "sentinel__op", "grant__frobnicate", "grant__a__b__c", "grant__search"]) {
  const v = checkedVerdict(unknown);
  ok(v.tier === "destructive" && v.basis === "unrecognised", `${unknown} → destructive on an UNRECOGNISED basis`);
}

{
  const v = checkedVerdict("acme__delete__query");
  ok(v.tier === "destructive", "a destructive PATH token raises a read verb to destructive");
  ok(v.basis === "read-verb", "…and the basis still reports the VERB pass — the op's own verb reads, the connection path is what gated it");
}
{
  const v = checkedVerdict("acme__delete__create_page");
  ok(v.tier === "destructive" && v.basis === "write-verb", "a destructive path token over a WRITE verb keeps the write-verb basis");
}
{
  const v = checkedVerdict("acme__delete__frobnicate");
  ok(v.tier === "destructive" && v.basis === "unrecognised", "…and over an UNKNOWN verb the basis stays unrecognised — the path never rescues it into a named reason");
}
{
  const v = checkedVerdict("acme__create__query");
  ok(v.tier === "write" && v.basis === "read-verb", "a write path token raises a read verb to write, and the basis stays read-verb");
}
{
  const v = checkedVerdict("acme__search__query");
  ok(v.tier === "read" && v.basis === "read-verb", "a read path token changes neither tier nor basis");
}
{
  const v = checkedVerdict("grant__amy_delete__get_page");
  ok(v.tier === "read" && v.basis === "read-verb", "the reserved OWNER segment reaches neither tier nor basis — a handle is not a verb");
}
ok(classifyConnectorOpTierVerdict("notion__get_or_create_entity").basis === "write-verb", "a compound verb's write token supplies the basis, whatever its head token says");
ok(classifyConnectorOpTierVerdict("x__get_delete_marker").basis === "destructive-verb", "…and a destructive token in a compound verb wins the basis outright");
ok(classifyConnectorOpTierVerdict("search").basis === "read-verb", "an unqualified name is tokenised whole — `search` reads, on a read-verb basis");

for (const [name, tier, basis, was] of [
  ["acme__delete_search", "destructive", "destructive-verb", "destructive"],
  ["delete__delete_search", "destructive", "destructive-verb", "read"],
  ["delete__delete_page", "destructive", "destructive-verb", "destructive"],
  ["post__post_search", "write", "write-verb", "read"],
  ["get__get_frobnicate", "destructive", "unrecognised", "destructive"],
  ["post__post_frobnicate", "destructive", "unrecognised", "destructive"],
  ["notion__notion-fetch", "read", "read-verb", "read"],
] as const) {
  const v = checkedVerdict(name);
  ok(v.tier === tier, `head-prefix strip: ${name} → ${tier}`);
  ok(v.basis === basis, `…on a ${basis} basis (${name})`);
  ok(oracleTier(name) === was, `NEGATIVE CONTROL — the pre-fix classifier called ${name} ${was}`);
  ok(TIER_RANK[tier] >= TIER_RANK[was], `the row for ${name} does not ask for a DOWNWARD move (${was} → ${tier})`);
}
ok(
  classifyConnectorOpTier("delete__delete_search") === classifyConnectorOpTier("acme__delete_search"),
  "🔴 the SAME op name classifies the SAME whatever the CONNECTION SLUG spells — the false-OPEN OPE-1325 closed",
);
ok(classifyConnectorOpTier("delete__query") === "read", "an unstripped head is inert — `delete__query` is still a read");
ok(oracleTier("delete__query") === "read", "…which the pre-fix classifier also said, so this row moved nothing");

for (const falseOpen of [
  "grant__will_read__frobnicate",
  "grant__team_get__frobnicate",
  "acme__search__frobnicate",
  "wiki__list__frobnicate",
]) {
  ok(oracleTier(falseOpen) === "read", `NEGATIVE CONTROL — the pre-fix classifier called ${falseOpen} a READ, so the call took NO card`);
  const v = checkedVerdict(falseOpen);
  ok(v.tier === "destructive", `${falseOpen} → destructive: an unknown verb fails closed, whatever the middle segment spells`);
  ok(v.basis === "unrecognised", `…and the basis SAYS the verb was unrecognised, so no caller may read the gate as a delete (${falseOpen})`);
  ok(classifyConnectorOp(falseOpen) === "gate:member", `${falseOpen} → gate:member: the call now takes a card`);
}

ok(classifyConnectorOpTier("acme__delete__query") === "destructive", "a destructive token in the connection path still raises (read verb, destructive slug)");
ok(classifyConnectorOpTier("acme__create__query") === "write", "a write token in the connection path raises a read verb to write");
ok(classifyConnectorOpTier("acme__create__frobnicate") === "destructive", "…but a path raise never RESCUES an unknown verb from destructive");
ok(classifyConnectorOpTier("acme__search__query") === "read", "a read token in the connection path is ignored — the verb already reads");

ok(classifyConnectorOpTier("grant__amy__get_page") === "read", "a lent read classifies read from its VERB segment");
ok(classifyConnectorOpTier("grant__amy_delete__get_page") === "read", "an owner handle spelling `delete` does NOT gate a lent read — the owner segment never raises");
ok(classifyConnectorOpTier("grant__amy__create_page") === "write", "a lent write classifies write from its VERB segment");
ok(classifyConnectorOpTier("grant__amy__delete_page") === "destructive", "a lent destructive verb classifies destructive");
ok(oracleTier("grant__delete__query") === "destructive", "the pre-fix classifier read an owner handle `delete` as a destructive verb");
ok(classifyConnectorOpTier("grant__delete__query") === "read", "…and the fix does not — the owner segment is inert in BOTH directions (no grant tool ships yet)");

for (const malformed of ["grant__frobnicate", "grant__a__b__c", "grant__amy__", "grant__"]) {
  const v = checkedVerdict(malformed);
  ok(v.tier === "destructive", `malformed reserved name ${malformed} → destructive (fail-closed)`);
  ok(v.basis === "unrecognised", `…on an unrecognised basis: an unparseable name yields no verb tokens at all (${malformed})`);
  ok(classifyConnectorOp(malformed) === "gate:member", `malformed reserved name ${malformed} → gate:member`);
}
ok(classifyConnectorOpTier("grant__search") === "destructive", "🔴 a two-segment `grant__search` does NOT read as a connector op called `grant` — the reserved head fails closed");

ok(parseQualifiedToolName("reply") === undefined, "an unqualified name does not parse");
ok(parseQualifiedToolName("notion__create_page")?.verb === "create_page", "a two-segment name's verb is its second segment");
ok(parseQualifiedToolName("notion__create_page")?.connection === "notion", "…and its connection is the first");
ok(parseQualifiedToolName("acme__search__query")?.connection === "acme__search", "🔴 a plugin connection slug keeps its own `__` — the connection is EVERY segment before the verb");
ok(parseQualifiedToolName("acme__search__query")?.verb === "query", "…and only the trailing segment is the verb");
ok(parseQualifiedToolName("grant__amy__get_page")?.namespace === "grant", "a reserved name reports its namespace");
ok(parseQualifiedToolName("grant__amy__get_page")?.owner === "amy", "…its owner segment");
ok(parseQualifiedToolName("grant__amy__get_page")?.connection === undefined, "…and no connection: a grant tool is not a connector op");
ok(parseQualifiedToolName("grant__a__b__c") === undefined, "a reserved name of the wrong arity does not parse");

ok(isReservedNamespaceTool("grant__amy__get_page"), "a well-formed grant name sits in a reserved namespace");
ok(isReservedNamespaceTool("grant__Amy__get_page"), "🔴 …so does one no mint path could produce: the parser still reads its verb, so a narrower predicate would leave it classified `read`");
ok(isReservedNamespaceTool("grant__a__b__c"), "…and one the parser refuses to read at all");
ok(isReservedNamespaceTool("grant__search"), "…and a two-segment reserved name");
ok(!isReservedNamespaceTool("grants__amy__get_page"), "🔴 the match is the first SEGMENT, never the prefix `grant__`: `grants` is an ordinary connection name");
ok(!isReservedNamespaceTool("notion__grant__read"), "…and the word in the MIDDLE reserves nothing");
ok(!isReservedNamespaceTool("notion__search"), "an ordinary connector op is not in a reserved namespace");
ok(!isReservedNamespaceTool("grant"), "the bare namespace word carries no `__` and is not a qualified name");

const CONNECTION_HEADS: readonly string[] = [
  "notion", "linear", "gh", "slack", "acme", "wiki", "helpdesk", "forum", "x", "y", "z", "a", "b", "c",
  "acme-tools", "notion-tools", "linear-mcp", "acme-forms", "other", "custom", "bare", "sentinel", "fixture",
  "search", "list", "get", "read", "delete", "create", "post", "share", "link", "copy", "move", "mark",
];
const ALL_VERBS: readonly string[] = [...CONNECTOR_READ_VERBS, ...CONNECTOR_WRITE_VERBS, ...CONNECTOR_DESTRUCTIVE_VERBS];
const VERB_SHAPES: readonly string[] = [
  ...ALL_VERBS,
  ...ALL_VERBS.map((v) => `${v}_page`),
  ...ALL_VERBS.map((v) => `${v}-block`),
  ...ALL_VERBS.map((v) => `get_or_${v}_entity`),
  ...ALL_VERBS.map((v) => `check_and_${v}_message`),
  "frobnicate", "frobnicate_widget", "notionette", "", "constructor", "anything", "op", "api", "worker", "researcher",
];
const OBSERVED_QUALIFIED_NAMES: readonly string[] = [
  "a__archive_page", "a__erase_row", "a__fetch", "acme-forms__submit", "acme-tools__bare", "acme-tools__cmd-summary",
  "acme-tools__cmd-triage", "acme-tools__deploy-runbook", "acme-tools__lint", "acme-tools__researcher",
  "acme-tools__scribe", "acme-tools__search", "acme__api", "acme__forms", "acme__lint", "acme__list",
  "acme__search", "acme__search__query", "acme__worker", "acmelike__x", "b__comment", "b__view_doc", "b__wipe_db",
  "bare__fmt", "c__retrieve", "custom__tool", "fixture__cmd-ship", "fixture__greet", "forum__our_runbook",
  "forum__threads", "gh__delete_branch", "gh__destroy_repo", "gh__read_file", "helpdesk__anything",
  "helpdesk__constructor", "helpdesk__list_queues", "helpdesk__search", "helpdesk__search_tickets",
  "linear-mcp__issues", "linear__create_issue", "linear__get_issue", "linear__issues", "linear__list_issues",
  "linear__list_or_create_labels", "linear__remove_label", "linear__search", "notion-tools__search", "notion__",
  "notion__append_block", "notion__create_page", "notion__create_pages", "notion__delete_block",
  "notion__delete_page", "notion__frobnicate_widget", "notion__get_or_create_entity", "notion__get_page",
  "notion__list_databases", "notion__notion-create-pages", "notion__notion-fetch", "notion__notion-search",
  "notion__notion_delete_page", "notion__notionette", "notion__search", "notion__unarchive_page",
  "notion__update_page", "other__search", "sentinel__op", "slack__check_and_post_message", "wiki__fetch",
  "wiki__mirror", "wiki__mirror__fetch", "wiki__search", "x__drop_table", "x__fetch", "x__get_delete_marker",
  "x__get_or_delete_row", "x__post_message", "x__query", "y__find", "y__purge_cache", "y__retrieve",
  "y__set_property", "z__archive_page", "z__describe_page", "z__move_card", "z__query", "z__trash_doc",
];

let twoSegmentChecked = 0;
for (const head of CONNECTION_HEADS) {
  for (const verb of VERB_SHAPES) {
    const name = `${head}__${verb}`;
    const verdict = checkedVerdict(name);
    if (verdict.tier !== oracleTier(name)) {
      console.error(`✗ two-segment name changed tier: ${name} — was ${oracleTier(name)}, now ${verdict.tier}`);
      process.exit(1);
    }
    twoSegmentChecked++;
  }
}
ok(twoSegmentChecked > 3000, `two-segment corpus is real (${twoSegmentChecked} names, every shipped verb × every head shape)`);

let observedChanged = 0;
for (const name of OBSERVED_QUALIFIED_NAMES) {
  const verdict = checkedVerdict(name);
  if (verdict.tier !== oracleTier(name)) {
    console.error(`✗ an OBSERVED tool name changed tier: ${name} — was ${oracleTier(name)}, now ${verdict.tier}`);
    observedChanged++;
  }
}
ok(observedChanged === 0, `every one of the ${OBSERVED_QUALIFIED_NAMES.length} qualified names in the tree keeps its tier exactly`);

let threeSegmentChecked = 0;
let tightened = 0;
let raisedOffBasis = 0;
const basisByVerb = new Map<string, OpTierBasis>();
for (const head of ["acme", "wiki", "helpdesk", "notion", "search"]) {
  for (const middle of ["search", "list", "delete", "create", "mirror", "will_read", "amy", "team_get"]) {
    for (const verb of ["query", "get_page", "create_page", "delete_page", "frobnicate", ""]) {
      const name = `${head}__${middle}__${verb}`;
      const verdict = checkedVerdict(name);
      const now = verdict.tier;
      const was = oracleTier(name);
      if (TIER_RANK[now] < TIER_RANK[was]) {
        console.error(`✗ three-segment name got MORE OPEN: ${name} — was ${was}, now ${now}`);
        process.exit(1);
      }
      const settled = basisByVerb.get(verb);
      if (settled === undefined) basisByVerb.set(verb, verdict.basis);
      else if (settled !== verdict.basis) {
        console.error(`✗ the basis LEAKED a path token: ${name} — verb \`${verb}\` reported ${settled} elsewhere, ${verdict.basis} here`);
        process.exit(1);
      }
      if (TIER_RANK[now] > TIER_RANK[BASIS_IMPLIED_TIER[verdict.basis]]) raisedOffBasis++;
      if (TIER_RANK[now] > TIER_RANK[was]) tightened++;
      threeSegmentChecked++;
    }
  }
}
ok(threeSegmentChecked === 240, `three-segment corpus is complete (${threeSegmentChecked} names)`);
ok(tightened > 0, `…and the fix genuinely tightens ${tightened} of them — an all-equal result would mean the defect was never reachable`);
ok(basisByVerb.size === 6, `the three-segment corpus visited all 6 verb shapes (${basisByVerb.size})`);
ok(raisedOffBasis > 0, `…and the path pass really does raise ${raisedOffBasis} of them ABOVE their basis — an all-equal result would mean the tier/basis split was never exercised`);

const AUTHORED_AND_FRAMEWORK: readonly string[] = [
  ...Object.keys(TOOL_CONSEQUENCE),
  ...WORKER_ONLY_TOOLS_STANDING,
  ...WORKER_ONLY_TOOLS_THREAD,
];
ok(AUTHORED_AND_FRAMEWORK.length > 150, `the authored/framework inventory is real (${AUTHORED_AND_FRAMEWORK.length} names)`);
for (const name of AUTHORED_AND_FRAMEWORK) {
  ok(!isConnectorOpTool(name), `authored/framework tool ${name} is not a qualified name — the connector-op plane never sees it`);
  ok(parseQualifiedToolName(name) === undefined, `…and it does not parse as one either (${name})`);
}

console.log(`✓ connector-op-tier: ${passed} assertions passed`);

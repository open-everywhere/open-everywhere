import {
  classifyConnectorOpTier,
  classifyConnectorOpTierVerdict,
  connectorOpHintTier,
  defaultConnectorOpTierArm,
  type ConnectorOpToolHints,
} from "../agent/access/consequence.js";
import type { Bundle } from "../agent/access/bundle.js";
import { connectorOpTierParts, effectiveConnectorOpTier } from "../agent/access/connector-op-gating.js";
import { connectorOpToolHints, toolHintsOf } from "../agent/connections/connector-tool-hints.js";
import { recordConnectorListing, registerMountedConnector, resetConnectorCatalogue } from "../agent/connections/connector-catalogue.js";
import { connectorOpApproval } from "../agent/connections/connector-auth.js";
import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("connector-op-hint");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function eq<T>(got: T, want: T, label: string): void {
  ok(JSON.stringify(got) === JSON.stringify(want), `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

const READ_ONLY: ConnectorOpToolHints = { readOnlyHint: true };
const WRITE: ConnectorOpToolHints = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE: ConnectorOpToolHints = { readOnlyHint: false, destructiveHint: true };
const UNKNOWN = "notion__frobnicate_widget";

eq(connectorOpHintTier(READ_ONLY), "read", "map: readOnlyHint true → read");
eq(connectorOpHintTier(DESTRUCTIVE), "destructive", "map: destructiveHint true → destructive");
eq(connectorOpHintTier({ destructiveHint: true }), "destructive", "map: destructiveHint true alone → destructive");
eq(connectorOpHintTier(WRITE), "write", "map: both explicitly false → write");
eq(connectorOpHintTier({ readOnlyHint: true, destructiveHint: true }), "destructive", "map: a contradictory pair → destructive (the stricter)");
eq(connectorOpHintTier({ readOnlyHint: false }), undefined, "map: readOnlyHint false alone names no tier (the spec default is 'may be destructive')");
eq(connectorOpHintTier({ destructiveHint: false }), undefined, "map: destructiveHint false alone names no tier");
eq(connectorOpHintTier({}), undefined, "map: no annotations → no tier");
eq(connectorOpHintTier(undefined), undefined, "map: undefined → no tier");

{
  const plain = classifyConnectorOpTierVerdict(UNKNOWN);
  eq([plain.tier, plain.basis, plain.hintDecided], ["destructive", "unrecognised", false], "premise: an unknown verb with NO hint fails closed to destructive");
  ok(plain.hint === undefined, "premise: …and carries no hint");

  const read = classifyConnectorOpTierVerdict(UNKNOWN, READ_ONLY);
  eq([read.tier, read.basis, read.hint, read.hintDecided], ["read", "unrecognised", "read", true], "🔴 an unknown verb the server declares read-only → read, and the verdict says the hint decided");
  const write = classifyConnectorOpTierVerdict(UNKNOWN, WRITE);
  eq([write.tier, write.hintDecided], ["write", true], "an unknown verb the server declares non-destructive → write (hint decided)");
  const destructive = classifyConnectorOpTierVerdict(UNKNOWN, DESTRUCTIVE);
  eq([destructive.tier, destructive.hint, destructive.hintDecided], ["destructive", "destructive", false], "an unknown verb declared destructive stays destructive, and the hint decided nothing");
  eq(classifyConnectorOpTier(UNKNOWN, { readOnlyHint: false }), "destructive", "🔴 a hint that names no tier keeps the fail-closed default");
  eq(classifyConnectorOpTier(UNKNOWN, {}), "destructive", "…and so does an empty annotation object");

  eq(classifyConnectorOpTier("notion__delete_page", READ_ONLY), "destructive", "🔴 STRICTER WINS: a known delete the server calls read-only stays destructive");
  eq(classifyConnectorOpTierVerdict("notion__delete_page", READ_ONLY).hintDecided, false, "…and the hint decided nothing");
  eq(classifyConnectorOpTier("notion__create_page", READ_ONLY), "write", "STRICTER WINS: a known write the server calls read-only stays write");
  const raisedRead = classifyConnectorOpTierVerdict("notion__search", DESTRUCTIVE);
  eq([raisedRead.tier, raisedRead.basis, raisedRead.hintDecided], ["destructive", "read-verb", true], "🔴 STRICTER WINS: a read-named op the server calls destructive is RAISED to destructive (hint decided, basis still the name's)");
  eq(classifyConnectorOpTier("notion__search", WRITE), "write", "a read-named op the server calls a write is raised to write");
  eq(classifyConnectorOpTier("notion__search", READ_ONLY), "read", "agreement: a read the server calls read-only stays read");
  eq(classifyConnectorOpTierVerdict("notion__search", READ_ONLY).hintDecided, false, "…and an agreeing hint decided nothing");

  eq(classifyConnectorOpTier("acme__delete__frobnicate", READ_ONLY), "destructive", "🔴 a delete token in the connection PATH still raises over a read-only hint");
  eq(classifyConnectorOpTier("acme__create__frobnicate", READ_ONLY), "write", "a write token in the connection path still raises over a read-only hint");
  eq(classifyConnectorOpTier("post__post-frobnicate", READ_ONLY), "write", "🔴 a write token the vendor-prefix strip removed still raises over a read-only hint");
  eq(classifyConnectorOpTier("delete__delete-frobnicate", READ_ONLY), "destructive", "…and a stripped delete token raises to destructive");

  const reserved = classifyConnectorOpTierVerdict("grant__U0OWNER__frobnicate", READ_ONLY);
  eq([reserved.tier, reserved.hint, reserved.hintDecided], ["destructive", undefined, false], "🔴 a reserved grant__… name ignores a read-only hint");

  eq(defaultConnectorOpTierArm({ connection: "notion", verb: "frobnicate_widget", toolName: UNKNOWN, hints: READ_ONLY }), "read", "the default arm reads the question's hints");
  eq(defaultConnectorOpTierArm({ connection: "notion", verb: "frobnicate_widget", toolName: UNKNOWN }), "destructive", "…and with none it is the plain built-in");
}

{
  const parts = connectorOpTierParts(UNKNOWN, [], READ_ONLY);
  eq([parts.base, parts.basis, parts.hint, parts.hintDecided, parts.tier], ["read", "unrecognised", "read", true, "read"], "🔴 seam: the hint joins rung one and the audit parts show it decided");
  const noHint = connectorOpTierParts(UNKNOWN, []);
  eq([noHint.tier, noHint.hintDecided, noHint.hint], ["destructive", false, undefined], "seam: no hint → the fail-closed default, and the parts say no hint decided");
  const agreed = connectorOpTierParts("notion__search", [], READ_ONLY);
  eq([agreed.hint, agreed.hintDecided], ["read", false], "seam: an agreeing hint is RECORDED but did not decide");

  const bundles = [
    { name: "ops", connectorOps: [{ connector: "notion", gated: ["frobnicate_widget"], destructive: ["search"] }] },
  ] as unknown as readonly Bundle[];
  const raised = connectorOpTierParts(UNKNOWN, bundles, READ_ONLY);
  eq([raised.base, raised.declared, raised.tier], ["read", "write", "write"], "🔴 seam: an operator's `gated` raise applies over a read-only hint");
  eq(effectiveConnectorOpTier("notion__search", bundles, READ_ONLY), "destructive", "seam: an operator's `destructive` raise applies over a read verb and a read-only hint");
}

eq(toolHintsOf({ annotations: { readOnlyHint: "yes", destructiveHint: 1 } }), undefined, "reader: a non-boolean annotation is ignored");
eq(toolHintsOf({ annotations: { readOnlyHint: true, title: "x" } }), { readOnlyHint: true }, "reader: keeps the two consequence booleans only");
eq(toolHintsOf({ name: "x" }), undefined, "reader: a tool with no annotations has no hints");
const listing = (name: string, annotations?: Record<string, unknown>) => ({
  name,
  description: "",
  inputSchema: { type: "object" },
  hasOutputSchema: false,
  ...(annotations === undefined ? {} : { annotations }),
});
{
  resetConnectorCatalogue();
  eq(await connectorOpToolHints(UNKNOWN), undefined, "reader: no mounted connection → no hints (fail closed to the verb heuristic)");
  registerMountedConnector("notion");
  registerMountedConnector("plug__notion");
  eq(await connectorOpToolHints(UNKNOWN), undefined, "🔴 reader: a mounted connection that has not listed yet has no hints (fail closed)");
  recordConnectorListing("notion", [
    listing("frobnicate_widget", { readOnlyHint: true }),
    listing("notion-purge", { readOnlyHint: false, destructiveHint: true }),
  ]);
  recordConnectorListing("plug__notion", [listing("frobnicate_widget", { readOnlyHint: false, destructiveHint: false })]);
  recordConnectorListing("linear", [listing("frobnicate_widget", { readOnlyHint: true })]);
  eq(await connectorOpToolHints(UNKNOWN), { readOnlyHint: true }, "🔴 reader: the mount's listed annotations are found by the qualified name");
  eq(await connectorOpToolHints("notion__notion-purge"), { readOnlyHint: false, destructiveHint: true }, "reader: a vendor-prefixed tool name is matched whole");
  eq(await connectorOpToolHints("plug__notion__frobnicate_widget"), { readOnlyHint: false, destructiveHint: false }, "reader: the LONGEST mounted connection wins, so a plugin slug with `__` stays whole");
  eq(await connectorOpToolHints("notion__not_listed"), undefined, "reader: a tool the listing does not hold has no hints");
  eq(await connectorOpToolHints("linear__frobnicate_widget"), undefined, "reader: a listing for a connection the deployment did not mount gives no hints");
  eq(await connectorOpToolHints("grant__notion__frobnicate_widget"), undefined, "🔴 reader: a reserved grant__… name never takes hints");
  eq(await connectorOpToolHints("search"), undefined, "reader: an unqualified name has no hints");
}

{
  const ctx = (toolName: string) => ({ toolName }) as never;
  const withHints = (hints: ConnectorOpToolHints | undefined) => connectorOpApproval({ toolHints: async () => hints });
  eq(await withHints(READ_ONLY)(ctx(UNKNOWN)), "not-applicable", "🔴 approval: an unknown verb the org-admitted server declares read-only runs with no prompt");
  eq(await withHints(undefined)(ctx(UNKNOWN)), "user-approval", "🔴 approval: the SAME op with no hint still prompts (fail-closed)");
  eq(await withHints(READ_ONLY)(ctx("notion__delete_page")), "user-approval", "approval: a read-only hint never opens a known delete");
  eq(await withHints(DESTRUCTIVE)(ctx("notion__search")), "user-approval", "approval: a destructive hint makes a read-named op prompt");
  resetConnectorCatalogue();
  eq(await connectorOpApproval()(ctx(UNKNOWN)), "user-approval", "approval: with no listing, the default reader gives no hint and the op prompts");
  registerMountedConnector("notion");
  recordConnectorListing("notion", [listing("frobnicate_widget", { readOnlyHint: true })]);
  eq(await connectorOpApproval()(ctx(UNKNOWN)), "not-applicable", "🔴 approval: the DEFAULT reader is wired in — the mount's listed hint opens the read");
}

{
  const { withOeConnectorCard } = await import("../agent/connections/connector-auth.js");
  const { overrideSettingsForTest, resetSettingsForTest } = await import("../agent/settings/settings.js");
  const offered: Record<string, unknown>[] = [];
  const card = (hints: ConnectorOpToolHints | undefined) =>
    withOeConnectorCard(() => "user-approval" as never, {
      store: { getSessionApproval: async () => null, markEventSeen: async () => true, hasEventSeen: async () => false } as never,
      offer: (async (o: Record<string, unknown>) => {
        offered.push(o);
        return { outcome: "carded", pendingId: "p", where: "here" };
      }) as never,
      grantScope: () => ({ key: "slack/T1/C1/1700159720.000100", reach: "call" }),
      tainted: () => false,
      credentialOf: async () => "domain",
      toolHints: async () => hints,
    } as never);
  const call = (toolName: string) => ({ toolName, toolInput: { block: "b1" }, callId: "c1", session: { auth: {} } }) as never;
  overrideSettingsForTest({ connectors: { opTiering: true } } as never);
  await card(DESTRUCTIVE)(call("notion__update_block"));
  eq([offered.at(-1)?.grain, offered.at(-1)?.opTier], ["destructive", "destructive"], "🔴 card: a write-named op its server declares destructive takes the destructive grain and freezes opTier destructive");
  await card(undefined)(call("notion__update_block"));
  eq([offered.at(-1)?.grain, offered.at(-1)?.opTier], ["call", "write"], "card control: with no hint the same op is a write");
  overrideSettingsForTest({ connectors: { opTiering: false, userPrincipal: false } } as never);
  await card(DESTRUCTIVE)(call("notion__update_block"));
  eq([offered.at(-1)?.grain, offered.at(-1)?.opTier], ["call", "destructive"], "🔴 card: with op tiering OFF the grain is the blanket `call`, and opTier STILL says destructive");
  resetSettingsForTest();
}

console.log(`✓ connector-op-hint: ${passed} assertions passed`);

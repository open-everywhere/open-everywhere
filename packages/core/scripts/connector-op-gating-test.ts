pinSuiteStore("connector-op-gating");
overrideSettingsForTest({ connectors: { opTiering: true } });

import { assertBundlesValid, defineBundle, type Bundle } from "../agent/access/bundle.js";
import { classifyConnectorOpTier, type ConnectorOpTier } from "../agent/access/consequence.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
import { pinSuiteStore } from "./_suite-store.js";
import {
  declaredConnectorOpRaise,
  effectiveConnectorOpConsequence,
  effectiveConnectorOpTier,
  joinConnectorOpTiers,
} from "../agent/access/connector-op-gating.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function eq<T>(actual: T, expected: T, label: string): void {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function throws(fn: () => void, needle: string, label: string): void {
  try {
    fn();
  } catch (e) {
    ok(String(e).includes(needle), `${label} — message names the problem (got: ${String(e).slice(0, 220)})`);
    return;
  }
  ok(false, `${label} — expected a throw, got none`);
}

const READ_OP = "notion__search";
const WRITE_OP = "notion__create_page";
const DESTRUCTIVE_OP = "notion__delete_page";
eq(classifyConnectorOpTier(READ_OP), "read", "fixture: notion__search is a base READ");
eq(classifyConnectorOpTier(WRITE_OP), "write", "fixture: notion__create_page is a base WRITE");
eq(classifyConnectorOpTier(DESTRUCTIVE_OP), "destructive", "fixture: notion__delete_page is a base DESTRUCTIVE");

const TIERS: readonly ConnectorOpTier[] = ["read", "write", "destructive"];
const RANK: Record<ConnectorOpTier, number> = { read: 0, write: 1, destructive: 2 };
for (const a of TIERS) {
  for (const b of TIERS) {
    const j = joinConnectorOpTiers(a, b);
    ok(RANK[j] >= RANK[a] && RANK[j] >= RANK[b], `join(${a},${b}) = ${j} is ≥ both inputs`);
    eq(j, joinConnectorOpTiers(b, a), `join(${a},${b}) is commutative`);
  }
}

for (const op of [READ_OP, WRITE_OP, DESTRUCTIVE_OP]) {
  const bare = op.slice(op.indexOf("__") + 2);
  const base = classifyConnectorOpTier(op);
  for (const list of ["gated", "destructive"] as const) {
    for (const names of [[bare], ["*"]]) {
      const bundles = [defineBundle({ name: "b", connectorOps: [{ connector: "notion", [list]: names }] })];
      const eff = effectiveConnectorOpTier(op, bundles);
      ok(
        RANK[eff] >= RANK[base],
        `🔴 RAISE-ONLY: {${list}: ${JSON.stringify(names)}} leaves ${op} at ${eff} — never below its base ${base}`,
      );
    }
  }
}

{
  const bundles = [defineBundle({ name: "lower-attempt", connectorOps: [{ connector: "notion", gated: ["delete_page"] }] })];
  eq(
    effectiveConnectorOpTier(DESTRUCTIVE_OP, bundles),
    "destructive",
    "🔴 an attempt to LOWER destructive→write via `gated` is REFUSED (the join keeps the stricter side)",
  );
  eq(declaredConnectorOpRaise(DESTRUCTIVE_OP, bundles), "write", "…and the declaration itself really did say `write` — the refusal is the JOIN, not a parse failure");
}

{
  const bundles = [defineBundle({ name: "sweep", connectorOps: [{ connector: "notion", gated: ["*"] }] })];
  eq(effectiveConnectorOpTier(READ_OP, bundles), "write", "`gated: [\"*\"]` raises every READ op to write");
  eq(effectiveConnectorOpTier(DESTRUCTIVE_OP, bundles), "destructive", "🔴 …and leaves a DESTRUCTIVE op destructive (a wildcard cannot demote either)");
}

{
  const bundles = [defineBundle({ name: "b", connectorOps: [{ connector: "notion", gated: ["search"] }] })];
  eq(effectiveConnectorOpTier(READ_OP, bundles), "write", "a base READ named under `gated` is raised to write");
  eq(effectiveConnectorOpConsequence(READ_OP, bundles), "gate:member", "…so its consequence flips open → gate:member (the design's 'gate an open verb')");
}
{
  const bundles = [defineBundle({ name: "b", connectorOps: [{ connector: "notion", destructive: ["search"] }] })];
  eq(effectiveConnectorOpTier(READ_OP, bundles), "destructive", "a base READ named under `destructive` goes straight to destructive");
}
{
  const bundles = [defineBundle({ name: "b", connectorOps: [{ connector: "notion", destructive: ["create_page"] }] })];
  eq(effectiveConnectorOpTier(WRITE_OP, bundles), "destructive", "a base WRITE named under `destructive` is raised to per-call");
}

{
  const bundles = [defineBundle({ name: "b", connectorOps: [{ connector: "NOTION", destructive: ["Create-Page"] }] })];
  eq(effectiveConnectorOpTier(WRITE_OP, bundles), "destructive", "matching is case-insensitive and treats `-` and `_` as the same character");
}
{
  const bundles = [defineBundle({ name: "b", connectorOps: [{ connector: "notion", destructive: ["create_pages"] }] })];
  eq(effectiveConnectorOpTier("notion__notion-create-pages", bundles), "destructive", "a bare declared name matches a vendor-prefixed runtime op (notion__notion-create-pages)");
  eq(effectiveConnectorOpTier("notion__create_pages", bundles), "destructive", "…and the unprefixed form of the same op");
}
{
  const bundles = [defineBundle({ name: "b", connectorOps: [{ connector: "linear", gated: ["search"] }] })];
  eq(declaredConnectorOpRaise(READ_OP, bundles), undefined, "a declaration on connector `linear` does NOT reach connector `notion`");
  eq(effectiveConnectorOpTier(READ_OP, bundles), "read", "…so notion__search keeps its base tier");
  eq(effectiveConnectorOpTier("linear__search", bundles), "write", "…while linear__search is raised");
}
{
  const bundles = [defineBundle({ name: "b", connectorOps: [{ connector: "notion", gated: ["search"] }] })];
  eq(declaredConnectorOpRaise("plain_tool_name", bundles), undefined, "an UNQUALIFIED tool name (no `__`) matches no declaration — this plane is connector ops only");
}

{
  const bundles = [
    defineBundle({ name: "soft", connectorOps: [{ connector: "notion", gated: ["search"] }] }),
    defineBundle({ name: "hard", connectorOps: [{ connector: "notion", destructive: ["search"] }] }),
  ];
  eq(effectiveConnectorOpTier(READ_OP, bundles), "destructive", "two bundles naming one op keep the STRICTER declaration (join across bundles)");
  const reversed = [bundles[1]!, bundles[0]!];
  eq(effectiveConnectorOpTier(READ_OP, reversed), "destructive", "…independent of declaration order");
}

for (const op of [READ_OP, WRITE_OP, DESTRUCTIVE_OP]) {
  eq(declaredConnectorOpRaise(op), undefined, `no registered config ⇒ no declared raise for ${op}`);
  eq(effectiveConnectorOpTier(op), classifyConnectorOpTier(op), `🔴 …and ${op} falls back to the classifier's own fail-closed baseline, never to open`);
}
{
  const empty: Bundle[] = [];
  eq(effectiveConnectorOpTier(DESTRUCTIVE_OP, empty), "destructive", "an empty bundle list leaves the fail-closed baseline intact");
  const noOps = [defineBundle({ name: "b", connectors: [{ name: "notion", credential: "k", contentOrigin: "external" }] })];
  eq(effectiveConnectorOpTier(READ_OP, noOps), "read", "a bundle granting the connector but declaring no ops changes nothing (byte-identical to OPE-11)");
}

throws(
  () => assertBundlesValid([defineBundle({ name: "b", connectorOps: [{ connector: "  ", gated: ["x"] }] })]),
  "empty connector name",
  "an empty connector name is rejected at config load",
);
throws(
  () => assertBundlesValid([defineBundle({ name: "b", connectorOps: [{ connector: "notion" }] })]),
  "names no ops",
  "an entry that raises nothing is rejected (dead config)",
);
throws(
  () => assertBundlesValid([defineBundle({ name: "b", connectorOps: [{ connector: "notion", gated: [""] }] })]),
  "empty op name",
  "an empty op name is rejected",
);
throws(
  () =>
    assertBundlesValid([
      defineBundle({ name: "b", connectorOps: [{ connector: "notion", gated: ["a"] }, { connector: "notion", destructive: ["b"] }] }),
    ]),
  "more than once",
  "two entries for one connector in one bundle are rejected as ambiguous",
);
try {
  assertBundlesValid([defineBundle({ name: "b", connectors: [{ name: "notion", credential: "k", contentOrigin: "external" }], connectorOps: [{ connector: "notion", destructive: ["delete_page"], gated: ["*"] }] })]);
  ok(true, "a well-formed connectorOps declaration passes config-load validation");
} catch (e) {
  ok(false, `a well-formed connectorOps declaration must pass validation (threw: ${String(e).slice(0, 200)})`);
}
try {
  assertBundlesValid([defineBundle({ name: "b", connectorOps: [{ connector: "ungranted-thing", gated: ["x"] }] })]);
  ok(true, "a raise naming a connector this bundle does not grant is ALLOWED — it cannot widen anything, so refusing it would be a policy opinion");
} catch (e) {
  ok(false, `raising an ungranted connector must not be a config error (threw: ${String(e).slice(0, 200)})`);
}

const { registerConfig } = await import("../agent/access/config.js");
const gatingBundles = [
  defineBundle({
    name: "notion-gated",
    connectors: [{ name: "notion", credential: "k", contentOrigin: "external" }],
    connectorOps: [{ connector: "notion", gated: ["search"], destructive: ["create_page"] }],
  }),
];
registerConfig({
  loadBundles: () => gatingBundles,
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const { connectorOpApproval, withOeConnectorCard } = await import("../agent/connections/connector-auth.js");
const approve = connectorOpApproval();
const ctxFor = (toolName: string) => ({ toolName, callId: `c-${toolName}`, toolInput: {} }) as unknown as Parameters<typeof approve>[0];

eq(await approve(ctxFor("notion__get_page")), "not-applicable", "live gate: an unraised READ still sails through with no prompt");
eq(await approve(ctxFor(READ_OP)), "user-approval", "🔴 live gate: the READ raised by `gated` now PROMPTS — the declaration reaches the eve-native seam");
eq(await approve(ctxFor(WRITE_OP)), "user-approval", "live gate: the WRITE raised to `destructive` prompts");
{
  const grains: Record<string, string> = {};
  const carded = withOeConnectorCard(approve, {
    store: { getSessionApproval: async () => null, markEventSeen: async () => true, hasEventSeen: async () => false } as never,
    grantScope: () => ({ key: "win-gating", reach: "call" }) as never,
    credentialOf: async () => "domain",
    offer: (async (o: { tool: string; grain: string }) => {
      grains[o.tool] = o.grain;
      return { outcome: "carded", pendingId: "p-gating", where: "in this conversation" };
    }) as never,
  });
  await carded(ctxFor(READ_OP));
  await carded(ctxFor(WRITE_OP));
  eq(grains[READ_OP], "call", "live gate: the READ raised to `write` is carded at the one-call grain");
  eq(
    grains[WRITE_OP],
    "destructive",
    "🔴 live gate: the WRITE raised to `destructive` is carded at the DESTRUCTIVE grain (the card text and the audit row). The one-call memo gates every tier per call, as no-native-hitl §6 proves",
  );
}
eq(await approve(ctxFor("linear__search")), "not-applicable", "live gate: the same op name on an undeclared connector is untouched");

console.log(`✓ connector-op-gating: ${passed} assertions passed`);

// proves: AP-MOD-core-access-connector-op-gating

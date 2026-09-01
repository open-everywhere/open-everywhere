import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "oe-connector-op-arm-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_PLATFORM = "slack";
delete process.env.OE_ORG;

const { overrideSettingsForTest } = await import("../agent/settings/settings.js");
overrideSettingsForTest({ connectors: { opTiering: true } });

const { defineBundle } = await import("../agent/access/bundle.js");
const { classifyConnectorOpTier, classifyConnectorOpTierVerdict, connectorOpName } = await import("../agent/access/consequence.js");
const { connectorOpTierParts, effectiveConnectorOpConsequence, effectiveConnectorOpTier } = await import(
  "../agent/access/connector-op-gating.js"
);
const { allowedOnRestrictedJobWake, restrictToolsetForJobWake } = await import("../agent/access/job-posture.js");
const { registerConfig } = await import("../agent/access/config.js");

type Tier = "read" | "write" | "destructive";
type ArmFn = (op: { readonly connection: string; readonly verb: string; readonly toolName: string }) => Tier | undefined;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}
function eq<T>(actual: T, expected: T, label: string): void {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function config(connectorOpTier?: ArmFn) {
  return {
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
    ...(connectorOpTier ? { connectorOpTier } : {}),
  };
}

function capturingWarnings<T>(fn: () => T): { readonly result: T; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

const READ_OP = "notion__search";
const WRITE_OP = "notion__create_page";
const DESTRUCTIVE_OP = "notion__delete_page";
const UNKNOWN_OP = "notion__frobnicate_widget";
const ALL_OPS = [READ_OP, WRITE_OP, DESTRUCTIVE_OP, UNKNOWN_OP] as const;

eq(classifyConnectorOpTier(READ_OP), "read", "fixture: notion__search is a base READ");
eq(classifyConnectorOpTier(WRITE_OP), "write", "fixture: notion__create_page is a base WRITE");
eq(classifyConnectorOpTier(DESTRUCTIVE_OP), "destructive", "fixture: notion__delete_page is a base DESTRUCTIVE");
eq(classifyConnectorOpTier(UNKNOWN_OP), "destructive", "fixture: an unrecognised verb fails CLOSED to destructive");
eq(classifyConnectorOpTierVerdict(UNKNOWN_OP).basis, "unrecognised", "fixture: …on the `unrecognised` basis — the built-in ABSTAINED");
eq(classifyConnectorOpTierVerdict(DESTRUCTIVE_OP).basis, "destructive-verb", "fixture: …whereas delete_page is a RECOGNISED destructive verb");

for (const op of ALL_OPS) {
  eq(effectiveConnectorOpTier(op), classifyConnectorOpTier(op), `no config registered at all: ${op} is exactly the built-in verdict`);
}
{
  const parts = connectorOpTierParts(UNKNOWN_OP);
  eq(parts.armPresent, false, "no config registered: armPresent is false");
  eq(parts.arm, undefined, "no config registered: no arm answer");
  eq(parts.armLowered, false, "no config registered: nothing was lowered by an arm");
}

registerConfig(config());
for (const op of ALL_OPS) {
  eq(effectiveConnectorOpTier(op), classifyConnectorOpTier(op), `config registered but NO arm: ${op} is exactly the built-in verdict`);
}
{
  const parts = connectorOpTierParts(WRITE_OP);
  eq(parts.armPresent, false, "config with no arm: armPresent is false — distinguishable from an arm that abstained");
  eq(parts.base, "write", "parts carry the built-in's tier");
  eq(parts.basis, "write-verb", "parts carry the built-in's basis");
  eq(parts.tier, "write", "…and the effective tier is that same verdict");
}

registerConfig(config(({ verb }) => (verb === "frobnicate_widget" ? "read" : undefined)));
eq(effectiveConnectorOpTier(UNKNOWN_OP), "write", "🔴 an arm answering `read` for an unrecognised op is FLOORED at write — never the open tier");
eq(effectiveConnectorOpConsequence(UNKNOWN_OP), "gate:member", "🔴 …so the op still takes an approval card: a human sees it at least once");
{
  const parts = connectorOpTierParts(UNKNOWN_OP);
  eq(parts.base, "destructive", "the built-in's own answer is still reported as the base");
  eq(parts.arm, "read", "🔴 the arm's answer is reported AS GIVEN — the row shows it reaching for the open tier");
  eq(parts.basis, "unrecognised", "…on the basis that says the built-in abstained");
  eq(parts.armLowered, true, "…and armLowered marks that the effective tier sits BELOW the built-in");
}
eq(effectiveConnectorOpTier(READ_OP), "read", "…the same arm abstains on a recognised READ, which keeps its built-in tier");
eq(effectiveConnectorOpTier(DESTRUCTIVE_OP), "destructive", "…and on a recognised DESTRUCTIVE");

registerConfig(config(() => "write"));
eq(effectiveConnectorOpTier(UNKNOWN_OP), "write", "an arm may lower an unrecognised op to write directly");

const NOUN_COLLISION_OP = "acme__get_delete_marker";
eq(classifyConnectorOpTier(NOUN_COLLISION_OP), "destructive", "fixture: a noun collision reads as a delete to the built-in");
eq(classifyConnectorOpTierVerdict(NOUN_COLLISION_OP).basis, "destructive-verb", "fixture: …on a RECOGNISED destructive verb, not an abstention");

registerConfig(config(() => "read"));
eq(effectiveConnectorOpTier(NOUN_COLLISION_OP), "write", "🔴 an everything-is-read arm lowers a RECOGNISED destructive — to `write`, and no further");
eq(effectiveConnectorOpTier(DESTRUCTIVE_OP), "write", "🔴 …including a real delete_page: the floor is a floor, not a judgement about which delete is real");
eq(effectiveConnectorOpConsequence(DESTRUCTIVE_OP), "gate:member", "…so delete_page still takes a card");
eq(effectiveConnectorOpTier(WRITE_OP), "write", "an arm answering `read` for a recognised WRITE moves nothing — it is already at the floor");
eq(effectiveConnectorOpTier(READ_OP), "read", "🔴 …and an arm answering `read` about an already-OPEN op does not RAISE it: the floor clamps lowerings only");
{
  const parts = connectorOpTierParts(DESTRUCTIVE_OP);
  eq(parts.arm, "read", "the arm really did answer `read` — the legs above are not a silent no-call");
  eq(parts.armLowered, true, "…and the lowering is recorded");
  eq(parts.basis, "destructive-verb", "…on a RECOGNISED basis, which is the bucket the ruling opened");
  eq(parts.tier, "write", "…landing at the floor");
}
{
  const parts = connectorOpTierParts(READ_OP);
  eq(parts.arm, "read", "the arm answered `read` for the open op too");
  eq(parts.armLowered, false, "…and that is NOT a lowering — nothing moved");
}
registerConfig(config(() => "destructive"));
eq(effectiveConnectorOpTier(READ_OP), "destructive", "🔴 negative control: the arm CAN raise a recognised read to destructive");
eq(effectiveConnectorOpTier(WRITE_OP), "destructive", "…and a recognised write");

for (const armTier of ["read", "write", "destructive", undefined] as const) {
  registerConfig(config(() => armTier));
  for (const op of [READ_OP, WRITE_OP, DESTRUCTIVE_OP, UNKNOWN_OP, NOUN_COLLISION_OP] as const) {
    const eff = effectiveConnectorOpTier(op);
    ok(
      eff !== "read" || classifyConnectorOpTier(op) === "read",
      `🔴 FLOOR: a ${String(armTier)} arm never puts ${op} in the open tier (effective ${eff}, built-in ${classifyConnectorOpTier(op)})`,
    );
    ok(eff === "read" || eff === "write" || eff === "destructive", `…and the answer stays in vocabulary for ${op}`);
  }
}
registerConfig(config(() => "read"));
eq(effectiveConnectorOpTier("__frobnicate"), "write", "🔴 FLOOR: an EMPTY-connection name reaches the arm and is floored like any other");

const STRIPPED_DESTRUCTIVE_OP = "delete__delete_page";
{
  const verdict = classifyConnectorOpTierVerdict(STRIPPED_DESTRUCTIVE_OP);
  eq(verdict.basis, "destructive-verb", "🔴 a head that prefixes a destructive verb no longer leaves the basis `unrecognised`");
  eq(verdict.tier, "destructive", "…and the built-in tier is destructive, as it already was");
}
registerConfig(config(() => "read"));
{
  const parts = connectorOpTierParts(STRIPPED_DESTRUCTIVE_OP);
  eq(parts.arm, "read", "the everything-is-read arm really did answer on this op — the leg is not a silent no-call");
  eq(parts.basis, "destructive-verb", "🔴 …and the row says the built-in RECOGNISED the verb the strip used to eat");
  eq(parts.armLowered, true, "…so the arm's lowering here is the ruling's recognised bucket, not its abstention bucket");
  eq(parts.tier, "write", "…landing at the floor, like every other lowering");
}
eq(connectorOpTierParts(UNKNOWN_OP).basis, "unrecognised", "NEGATIVE CONTROL — a truly unrecognised verb still reports the abstention basis");

registerConfig(config(() => "read"));
eq(allowedOnRestrictedJobWake(DESTRUCTIVE_OP), false, "🔴 FLOOR: an everything-is-read arm does NOT admit delete_page to a restricted job wake");
eq(allowedOnRestrictedJobWake(UNKNOWN_OP), false, "🔴 FLOOR: …nor an UNRECOGNISED op, the very rung the arm may decide");
eq(allowedOnRestrictedJobWake(WRITE_OP), false, "🔴 FLOOR: …nor a write");
eq(effectiveConnectorOpTier(UNKNOWN_OP), "write", "…while the GATE plane really does see that arm move the op — the floor is a separate reading, not a dead arm");
eq(allowedOnRestrictedJobWake(NOUN_COLLISION_OP), false, "🔴 FLOOR: …and an arm-LOWERED recognised destructive is still kept out of a restricted job wake");
eq(allowedOnRestrictedJobWake(READ_OP), true, "…and a genuine built-in read is still admitted (the floor did not just deny everything)");
{
  const toolset: Record<string, unknown> = { [READ_OP]: {}, [WRITE_OP]: {}, [DESTRUCTIVE_OP]: {}, [UNKNOWN_OP]: {} };
  const removed = restrictToolsetForJobWake(toolset);
  ok(removed.includes(DESTRUCTIVE_OP) && removed.includes(UNKNOWN_OP) && removed.includes(WRITE_OP), "🔴 FLOOR: the toolset restriction still REMOVES all three under an everything-is-read arm");
  ok(Object.keys(toolset).length === 1 && READ_OP in toolset, "…leaving only the genuine read");
}

registerConfig(config(() => undefined));
for (const op of ALL_OPS) {
  eq(effectiveConnectorOpTier(op), classifyConnectorOpTier(op), `a deliberately abstaining arm leaves ${op} at the built-in verdict`);
}
{
  const { warnings } = capturingWarnings(() => effectiveConnectorOpTier(UNKNOWN_OP));
  eq(warnings.length, 0, "a deliberate `undefined` is NOT a defect — it logs no note");
  eq(connectorOpTierParts(UNKNOWN_OP).armPresent, true, "…but the row still records that an arm was registered");
}

registerConfig(
  config(() => {
    throw new Error("arm exploded");
  }),
);
{
  const { result, warnings } = capturingWarnings(() => effectiveConnectorOpTier(UNKNOWN_OP));
  eq(result, "destructive", "🔴 a THROWING arm leaves the built-in verdict standing — fail-closed, never `undefined`");
  eq(warnings.length, 1, "…and logs exactly one note for the call");
  ok(warnings[0]?.includes("arm exploded") === true && warnings[0]?.includes(UNKNOWN_OP) === true, "…naming the cause and the op");
}
{
  const { result } = capturingWarnings(() => effectiveConnectorOpTier(READ_OP));
  eq(result, "read", "…a throwing arm does not drag a recognised read anywhere either");
}

registerConfig(config(() => "READ" as unknown as Tier));
{
  const { result, warnings } = capturingWarnings(() => effectiveConnectorOpTier(UNKNOWN_OP));
  eq(result, "destructive", "🔴 an OUT-OF-VOCABULARY return is an abstention — `READ` is not `read`");
  eq(warnings.length, 1, "…and logs one note");
}
for (const bad of [null, 42, {}, [], "open", "toString", "gate:member", ""] as const) {
  registerConfig(config(() => bad as unknown as Tier));
  const { result } = capturingWarnings(() => effectiveConnectorOpTier(UNKNOWN_OP));
  eq(result, "destructive", `an arm returning ${JSON.stringify(bad)} abstains — the built-in verdict stands`);
  const { result: onRead } = capturingWarnings(() => effectiveConnectorOpTier(READ_OP));
  eq(onRead, "read", `…and ${JSON.stringify(bad)} does not disturb a recognised read either`);
}

{
  const seen: string[] = [];
  registerConfig(
    config(({ toolName }) => {
      seen.push(toolName);
      return "read";
    }),
  );
  eq(effectiveConnectorOpTier("grant__amy__frobnicate"), "destructive", "🔴 a RESERVED name keeps the built-in verdict — the arm cannot move a lent op at all");
  eq(seen.length, 0, "…because the arm is never called for one at all");
  eq(effectiveConnectorOpTier("notion"), "destructive", "an UNPARSEABLE name (no `__`) keeps its fail-closed verdict");
  eq(seen.length, 0, "…and the arm is not called for that either");
  eq(effectiveConnectorOpTier(UNKNOWN_OP), "write", "…while a real connector op DOES reach the arm — the two legs above are not a dead arm");
  eq(seen.length, 1, "…exactly once");
}

{
  const seen: { connection: string; verb: string; toolName: string }[] = [];
  registerConfig(
    config((op) => {
      seen.push({ ...op });
      return undefined;
    }),
  );
  effectiveConnectorOpTier(UNKNOWN_OP);
  eq(seen.length, 1, "the arm is called once for one op");
  eq(seen[0]?.toolName, UNKNOWN_OP, "…and receives the whole qualified tool name");
  eq(seen[0]?.connection, "notion", "…the CONNECTION segment (not the verb, not the whole name)");
  eq(seen[0]?.verb, "frobnicate_widget", "…and the VERB segment");

  seen.length = 0;
  effectiveConnectorOpTier("acme__server__frobnicate_widget");
  eq(seen.length, 1, "a three-segment name reaches the arm too");
  eq(seen[0]?.connection, "acme__server", "🔴 …with the MULTI-SEGMENT connection kept whole");
  eq(seen[0]?.verb, "frobnicate_widget", "…and the trailing segment as the verb");

  seen.length = 0;
  effectiveConnectorOpTier("notion__search");
  eq(seen[0]?.verb, "search", "a two-segment read op hands over its verb");
  eq(seen[0]?.connection, "notion", "…and its connection");
}

registerConfig(config(() => "read"));
{
  const bundles = [defineBundle({ name: "b", connectorOps: [{ connector: "notion", destructive: ["frobnicate_widget"] }] })];
  eq(
    effectiveConnectorOpTier(UNKNOWN_OP, bundles),
    "destructive",
    "🔴 a declared raise OVERRIDES an arm that lowered the op — the operator's declaration is last",
  );
  const parts = connectorOpTierParts(UNKNOWN_OP, bundles);
  eq(parts.arm, "read", "…the arm still answered `read`");
  eq(parts.armLowered, true, "…and still lowered its rung, below the declaration");
  eq(parts.declared, "destructive", "…but the declaration sits above it");
  eq(parts.tier, "destructive", "…and wins");
}
{
  const bundles = [defineBundle({ name: "b", connectorOps: [{ connector: "notion", gated: ["search"] }] })];
  eq(effectiveConnectorOpTier(READ_OP, bundles), "write", "a declared raise on a recognised read still applies with an arm registered");
}
for (const armTier of ["read", "write", "destructive"] as const) {
  registerConfig(config(() => armTier));
  const bundles = [defineBundle({ name: "b", connectorOps: [{ connector: "notion", destructive: ["*"] }] })];
  for (const op of ALL_OPS) {
    eq(effectiveConnectorOpTier(op, bundles), "destructive", `🔴 a wildcard destructive declaration holds ${op} at destructive under a ${armTier} arm`);
  }
}

const hookMod = await import("../agent/hooks/connector-audit.js");
const { readAudit } = await import("../agent/audit/audit.js");
const handler = (hookMod.default as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events["action.result"];
const auth = {
  current: {
    principalType: "service",
    principalId: "U_caller",
    authenticator: "slack",
    attributes: { team_id: "T_TEAM", channel_id: "D_DM", channel_type: "im", user_id: "U_caller" },
  },
};
const ctx = { session: { auth }, channel: { kind: "slack" }, agent: { name: "oe" } };
const ev = (toolName: string) => ({ type: "action.result", data: { status: "success", result: { kind: "tool-result", toolName, isError: false } } });

let auditCalls = 0;
async function rowFor(toolName: string): Promise<{ detail?: Record<string, unknown> } | undefined> {
  auditCalls++;
  const rows = await readAudit({ org: "default", action: "connector.op" });
  eq(rows.length, auditCalls, `audit: ${auditCalls} connector.op row(s) after ${auditCalls} op result(s)`);
  const row = rows[0] as { detail?: Record<string, unknown> } | undefined;
  eq(row?.detail?.op, connectorOpName(toolName), `audit: the newest row is the one just written (${toolName})`);
  return row;
}

registerConfig(config());
await handler(ev(WRITE_OP), ctx);
{
  const row = await rowFor(WRITE_OP);
  eq(row?.detail?.opTier, "write", "no arm: the row carries the built-in tier");
  eq(row?.detail?.baseOpTier, undefined, "…and stamps no baseOpTier, because nothing moved it");
  eq(row?.detail?.opTierArm, undefined, "…and no arm marker at all");
  eq(row?.detail?.armOpTier, undefined, "…and no arm answer");
  eq(row?.detail?.opTierArmLowered, undefined, "…and no lowered marker");
  eq(row?.detail?.opTierBasis, undefined, "…and no basis, because nothing needs separating");
}

registerConfig(config(({ verb }) => (verb === "frobnicate_widget" ? "read" : undefined)));
await handler(ev(UNKNOWN_OP), ctx);
{
  const row = await rowFor(UNKNOWN_OP);
  eq(row?.detail?.opTier, "write", "🔴 the row carries the FLOORED tier the seam settled on");
  eq(row?.detail?.baseOpTier, "destructive", "…with the built-in's own verdict alongside it");
  eq(row?.detail?.opTierArm, true, "…marked as a deployment that registered an arm");
  eq(row?.detail?.armOpTier, "read", "🔴 …and what the arm ASKED FOR, unfloored — so a row shows an arm reaching for the open tier");
  eq(row?.detail?.opTierArmLowered, true, "🔴 …and the query that matters: this arm lowered the op");
  eq(row?.detail?.opTierBasis, "unrecognised", "🔴 …in the ruling's ABSTENTION bucket — the built-in recognised no verb");
  eq(row?.detail?.tier, "gate:member", "…and the consequence collapse still says the op takes a card");
}

await handler(ev(DESTRUCTIVE_OP), ctx);
{
  const row = await rowFor(DESTRUCTIVE_OP);
  eq(row?.detail?.opTier, "destructive", "an abstaining arm on a recognised op: the built-in tier");
  eq(row?.detail?.opTierArm, true, "…the arm is still recorded as present");
  eq(row?.detail?.armOpTier, undefined, "…but it answered nothing");
  eq(row?.detail?.opTierArmLowered, undefined, "…and lowered nothing");
}

registerConfig(config(() => "read"));
await handler(ev(DESTRUCTIVE_OP), ctx);
{
  const row = await rowFor(DESTRUCTIVE_OP);
  eq(row?.detail?.opTier, "write", "an arm that lowered a RECOGNISED destructive: the row carries the floored tier");
  eq(row?.detail?.baseOpTier, "destructive", "…with the built-in's verdict beside it");
  eq(row?.detail?.armOpTier, "read", "…and the row shows what it asked for");
  eq(row?.detail?.opTierArmLowered, true, "…recording the lowering");
  eq(row?.detail?.opTierBasis, "destructive-verb", "🔴 …in the ruling's RECOGNISED bucket — separable from the abstention row above");
}

registerConfig(config(() => "destructive"));
await handler(ev(READ_OP), ctx);
{
  const row = await rowFor(READ_OP);
  eq(row?.detail?.opTier, "destructive", "an arm that RAISED an open op: the row carries the raise");
  eq(row?.detail?.opTierArmLowered, undefined, "…and marks no lowering, so the marker is not stamped on every arm row");
  eq(row?.detail?.opTierBasis, undefined, "…nor a basis");
}

registerConfig(config());
rmSync(tmp, { recursive: true, force: true });
console.log(`✓ connector-op-arm: ${passed} assertions passed`);

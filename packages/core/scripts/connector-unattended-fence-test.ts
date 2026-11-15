import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-unattended-fence-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
setPlatformStandInForTest("slack");
_setDeploymentIdentityForTest({ org: undefined });

import type { ApprovalPolicy, ApprovalStatus } from "eve/tools/approval";
import {
  ASK_UNATTENDED_SENTENCE,
  TAINTED_ASK_UNATTENDED_SENTENCE,
  connectorApprovalPolicy,
  connectorOpApproval,
  unattendedConnectorRefusalMessage,
  withUnattendedConnectorFence,
} from "../agent/connections/connector-auth.js";
import { classifyConnectorOpTier } from "../agent/access/consequence.js";
import { connectorSessionKind, connectorToolPermissionKind } from "../agent/approvals/session-grant.js";
import { ROUTINE_MARKER, routinePermissionKey, type Routine } from "../agent/routines/routine.js";
import { routineFireAttributes, webhookFireAttributes } from "../agent/routines/fire-auth.js";
import { declaredPermissionKinds, armDeclaredRoutinePermissions } from "../agent/routines/declared-permissions.js";
import { overrideSettingsForTest, registerSettings } from "../agent/settings/settings.js";
import { effectiveConnectorOpTier } from "../agent/access/connector-op-gating.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";
import { setPlatformStandInForTest } from "../agent/identity/binding.js";

const { registerConfig } = await import("../agent/access/config.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});
registerSettings({});

const { readAudit } = await import("../agent/audit/audit.js");

let passed = 0;
function fail(label: string): never {
  console.error(`✗ ${label}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
function ok(cond: boolean, label: string): void {
  if (!cond) fail(label);
  passed++;
}

const ROUTINE: Routine = {
  id: "r-fence",
  org: "default",
  surfaceKey: "slack/T0FENCE/C0FENCE",
  trigger: { kind: "cron", expr: "0 3 * * *" },
  prompt: "post the nightly digest to notion",
  createdBy: "U0CREATOR",
  createdAt: "2026-08-28T00:00:00.000Z",
  status: "active",
  consecutiveFailures: 0,
};
const DEST_ATTRS = { team_id: "T0FENCE", channel_id: "C0FENCE", channel_type: "channel" } as const;
const GRANT_KEY = routinePermissionKey(ROUTINE);
const OTHER_GENERATION_KEY = routinePermissionKey({ ...ROUTINE, promptGeneration: 2 });
const OTHER_ROUTINE_KEY = routinePermissionKey({ ...ROUTINE, id: "r-other" });

function fireAuth(grantKey: string | undefined = GRANT_KEY): unknown {
  const attributes = routineFireAttributes(ROUTINE, DEST_ATTRS, "channel", true);
  return {
    current: {
      attributes: grantKey === undefined ? attributes : { ...attributes, [ROUTINE_MARKER.permissionKey]: grantKey },
    },
  };
}

function webhookAuth(): unknown {
  return { current: { attributes: webhookFireAttributes("hook-1", "T0FENCE", "C0FENCE", false, true) } };
}

const HUMAN_AUTH = {
  current: {
    principalId: "U0HUMAN",
    attributes: { team_id: "T0FENCE", channel_id: "C0FENCE", channel_type: "channel", user_id: "U0HUMAN", trust_checked: "true" },
  },
};

const WRITE_OP = "notion__create_page";
const READ_OP = "notion__search";
const DESTRUCTIVE_OP = "notion__delete_page";
const WRITE_DECLARATION = `tool:${WRITE_OP}`;
const SHARE_OP = "notion__share_page";
const INVITE_OP = "notion__invite_user";

function approvalCtx(auth: unknown, toolName: string, approvedTools: ReadonlySet<string> = new Set<string>()): never {
  return {
    toolName,
    approvedTools,
    callId: `call-${toolName}`,
    toolInput: { title: "x" },
    session: { id: `sess-${toolName}`, auth },
  } as never;
}

async function ask(policy: ApprovalPolicy, auth: unknown, toolName: string, approvedTools?: ReadonlySet<string>): Promise<ApprovalStatus> {
  return await policy(approvalCtx(auth, toolName, approvedTools));
}

function isDeniedRaw(decision: ApprovalStatus): decision is { readonly type: "denied"; readonly reason?: string } {
  return typeof decision === "object" && decision !== null && decision.type === "denied";
}

const CARD_PROBE_ID = "card-probe";
function cardProbePolicy(): ApprovalPolicy {
  return connectorApprovalPolicy({
    store: { getSessionApproval: async () => null, markEventSeen: async () => true } as never,
    grantScope: () => ({ key: "oe-grant:slack/T1/C1:thread:probe", reach: "thread" }),
    offer: async () => ({ outcome: "carded", pendingId: CARD_PROBE_ID, where: "in this conversation" }),
  });
}
function carded(decision: ApprovalStatus): boolean {
  return isDeniedRaw(decision) && (decision.reason ?? "").includes(`pending ${CARD_PROBE_ID}`);
}
function isDenied(decision: ApprovalStatus): decision is { readonly type: "denied"; readonly reason?: string } {
  return isDeniedRaw(decision) && !carded(decision);
}

function fixedPolicy(answer: ApprovalStatus): ApprovalPolicy {
  return () => answer;
}

type Row = { readonly detail?: Readonly<Record<string, unknown>>; readonly principalId?: string; readonly surface?: string };

async function refusedRows(): Promise<readonly Row[]> {
  return await readAudit({ org: "default", action: "connector.refused" });
}
async function liftRows(): Promise<readonly Row[]> {
  return await readAudit({ org: "default", action: "connector.unattended_lift" });
}
function rowFor(rows: readonly Row[], op: string): Row | undefined {
  return rows.find((r) => r.detail?.["op"] === op);
}

console.log("§1 the ask-unattended sentence is flow.ts's, verbatim:");
{
  const here = dirname(fileURLToPath(import.meta.url));
  const flowSrc = readFileSync(join(here, "..", "agent", "approvals", "flow.ts"), "utf8");
  ok(
    flowSrc.includes(ASK_UNATTENDED_SENTENCE),
    "the plain constant appears VERBATIM in approvals/flow.ts (RED the moment either copy is edited)",
  );
  ok(
    flowSrc.includes(TAINTED_ASK_UNATTENDED_SENTENCE),
    "the TAINTED constant appears VERBATIM there too — flow.ts carries two unattended sentences, not one",
  );
  ok(ASK_UNATTENDED_SENTENCE.includes("arm the permission on the routine's creation card"), "the plain sentence tells the reader to arm the permission");
  ok(TAINTED_ASK_UNATTENDED_SENTENCE.includes("No standing grant lifts that"), "…and the tainted one says a standing grant does NOT lift it");
  const plain = unattendedConnectorRefusalMessage("notion", WRITE_OP, "write", false);
  const poisoned = unattendedConnectorRefusalMessage("notion", WRITE_OP, "write", true);
  ok(plain.includes(ASK_UNATTENDED_SENTENCE) && !plain.includes(TAINTED_ASK_UNATTENDED_SENTENCE), "an untainted refusal carries the PLAIN sentence and only that one");
  ok(poisoned.includes(TAINTED_ASK_UNATTENDED_SENTENCE) && !poisoned.includes(ASK_UNATTENDED_SENTENCE), "a tainted refusal carries the TAINTED sentence and only that one");
  ok(plain.includes(`Declare "${WRITE_DECLARATION}"`), "the plain refusal names the exact declaration string a human would arm (write tier)");
  ok(!plain.includes('Declare "tool:notion"'), "…and never a connection-shaped declaration, which names no tool");
  ok(!poisoned.includes(`Declare "${WRITE_DECLARATION}"`), "…and the tainted refusal offers no such advice, because arming the card would not lift it");
  ok(
    !unattendedConnectorRefusalMessage("notion", DESTRUCTIVE_OP, "destructive", false).includes("Declare "),
    "…nor does a destructive refusal, which no declared permission can lift",
  );
}

overrideSettingsForTest({ connectors: { opTiering: true } });

console.log("§2 an unattended write with no grant is refused:");
{
  const policy = cardProbePolicy();
  const unfenced = await ask(fixedPolicy("user-approval"), fireAuth(), WRITE_OP);
  ok(unfenced === "user-approval", "control: the wrapped policy answers user-approval — a card nobody can click");

  const before = (await refusedRows()).length;
  const decision = await ask(policy, fireAuth(), WRITE_OP);
  ok(isDenied(decision), "an unattended WRITE with no covering grant is DENIED, never parked on user-approval");
  ok(isDenied(decision) && (decision.reason ?? "").includes(ASK_UNATTENDED_SENTENCE), "…with the approvals plane's ask-unattended sentence");
  ok(isDenied(decision) && (decision.reason ?? "").includes(WRITE_OP), "…naming the op that was refused");

  const rows = await refusedRows();
  ok(rows.length === before + 1, "…and lands EXACTLY ONE connector.refused row");
  const row = rowFor(rows, WRITE_OP);
  ok(row !== undefined, "…for this op");
  ok(row?.detail?.["reason"] === "ask-unattended", "…the row carries reason ask-unattended");
  ok(row?.detail?.["connection"] === "notion" && row.detail?.["op"] === WRITE_OP && row.detail?.["tier"] === "write", "…ids and verbs: connection, op, tier");
  ok(row?.detail?.["routine"] === GRANT_KEY, "…and records the routine key the (absent) row was looked for under");
  ok(row?.detail?.["grant"] === connectorToolPermissionKind(WRITE_OP), "…and the PER-TOOL kind it looked for, not a per-connection one");
  ok(row?.principalId === "U0CREATOR", "…attributed to the fire's attested creator");
  ok(typeof row?.surface === "string" && row.surface.length > 0, "…and stamped with the surface it happened on");
  ok(!JSON.stringify(row?.detail ?? {}).includes("title"), "…and never the op's arguments");
}

console.log("§3 the routine's declared per-tool permission lifts the op:");
{
  const written = await armDeclaredRoutinePermissions({
    org: "default",
    routine: ROUTINE,
    declared: [WRITE_DECLARATION],
    grantedBy: "U0HUMAN",
    tainted: false,
    nowIso: new Date().toISOString(),
  });
  ok(
    JSON.stringify(written) === JSON.stringify([connectorToolPermissionKind(WRITE_OP)]),
    "the REAL arming path writes connector.tool:notion__create_page under the routine key",
  );

  const before = (await liftRows()).length;
  const decision = await ask(cardProbePolicy(), fireAuth(), WRITE_OP);
  ok(decision === "not-applicable", "…and the same unattended write now proceeds with NO card");

  const rows = await liftRows();
  ok(rows.length === before + 1, "…landing exactly one connector.unattended_lift row");
  const row = rowFor(rows, WRITE_OP);
  ok(row !== undefined, "…for this op");
  ok(row?.detail?.["grant"] === connectorToolPermissionKind(WRITE_OP), "…naming the per-tool kind that lifted it");
  ok(row?.detail?.["routine"] === GRANT_KEY, "…and the routine key it was read under");
  ok(row?.principalId === "U0CREATOR", "…attributed to the fire's attested creator");
}

console.log("§4 an attended human still gets the card:");
{
  ok(carded(await ask(cardProbePolicy(), HUMAN_AUTH, WRITE_OP)), "an attended WRITE still raises the card (an OE card, OPE-2340)");
  ok(carded(await ask(cardProbePolicy(), HUMAN_AUTH, DESTRUCTIVE_OP)), "an attended DESTRUCTIVE op still raises the card (an OE card, OPE-2340)");
  ok(
    (await ask(cardProbePolicy(), HUMAN_AUTH, WRITE_OP, new Set([WRITE_OP]))) === "not-applicable",
    "an attended write already approved this session is still silenced by the once-per-op memo",
  );
}

console.log("§5 reads are untouched under either flag state:");
{
  ok((await ask(cardProbePolicy(), fireAuth(), READ_OP)) === "not-applicable", "opTiering ON: an unattended READ never prompts and is never refused");

  overrideSettingsForTest({ connectors: { opTiering: false, userPrincipal: false } });
  {
    const residual = await ask(connectorApprovalPolicy(), fireAuth(), READ_OP);
    ok(isDeniedRaw(residual) && !carded(residual), "opTiering OFF: an unattended read is denied, never parked (the residual is closed, OPE-2340)");
  }
  ok(isDenied(await ask(cardProbePolicy(), fireAuth(OTHER_ROUTINE_KEY), WRITE_OP)), "opTiering OFF: an unattended, ungranted WRITE is still refused (the fence is not flag-gated)");
  overrideSettingsForTest({ connectors: { opTiering: true } });
}

console.log("§6 no declared permission lifts a destructive op:");
{
  const decision = await ask(cardProbePolicy(), fireAuth(), DESTRUCTIVE_OP);
  ok(isDenied(decision), "an unattended DESTRUCTIVE op is refused with the write tool's row live");
  ok(rowFor(await refusedRows(), DESTRUCTIVE_OP)?.detail?.["tier"] === "destructive", "…and its refusal row records the destructive tier");
  const rowAlwaysExists = withUnattendedConnectorFence(fixedPolicy("user-approval"), { grantExists: async () => true });
  ok(
    isDenied(await ask(rowAlwaysExists, fireAuth(), DESTRUCTIVE_OP)),
    "a row for the DELETE TOOL ITSELF does not lift it — the fence's tier branch, not the vocabulary, is what refuses",
  );
  ok((await ask(rowAlwaysExists, fireAuth(), WRITE_OP)) === "not-applicable", "control: the same always-true read lifts a WRITE");
  let declineMessage = "";
  try {
    declaredPermissionKinds([`tool:${DESTRUCTIVE_OP}`]);
  } catch (e: unknown) {
    declineMessage = e instanceof Error ? e.message : String(e);
  }
  ok(declineMessage.includes("DELETE-tier"), "declaring a delete-tier tool is refused at propose time, so no misleading row is ever written");
  const armed = await armDeclaredRoutinePermissions({
    org: "default",
    routine: ROUTINE,
    declared: [`tool:${DESTRUCTIVE_OP}`],
    grantedBy: "U0HUMAN",
    tainted: false,
    nowIso: new Date().toISOString(),
  });
  ok(armed.length === 0, "…and arming writes no row for it, without throwing the click away");
  ok(isDenied(await ask(cardProbePolicy(), fireAuth(), DESTRUCTIVE_OP)), "…so the delete is still refused after that arming attempt");
}

console.log("§7 the fence only ever replaces a park:");
{
  const memberPlaneDeny: ApprovalStatus = { type: "denied", reason: "member-plane: a personal write in a shared room" };
  const fenced = withUnattendedConnectorFence(fixedPolicy(memberPlaneDeny));
  const decision = await ask(fenced, fireAuth(), WRITE_OP);
  ok(isDenied(decision) && decision.reason === memberPlaneDeny.reason, "a wrapped DENY is returned verbatim on an unattended fire holding a covering grant");
  ok((await ask(withUnattendedConnectorFence(fixedPolicy("not-applicable")), fireAuth(), WRITE_OP)) === "not-applicable", "a wrapped NOT-APPLICABLE is returned verbatim (nothing is newly gated)");
}

console.log("§8 the row read is keyed, not merely present:");
{
  ok(isDenied(await ask(cardProbePolicy(), fireAuth(OTHER_GENERATION_KEY), WRITE_OP)), "a fire on a LATER prompt generation misses the row (edit_routine invalidates it)");
  ok(isDenied(await ask(cardProbePolicy(), fireAuth(OTHER_ROUTINE_KEY), WRITE_OP)), "another ROUTINE's key does not see this routine's row");
  ok(isDenied(await ask(cardProbePolicy(), fireAuth(), "linear__create_issue")), "a notion tool's row does not lift a write on linear");
  ok((await ask(cardProbePolicy(), fireAuth(), WRITE_OP)) === "not-applicable", "control: the correct key + connector still lifts");
}

console.log("§9 an unreadable bag stands the fence down:");
{
  const fenced = withUnattendedConnectorFence(fixedPolicy("user-approval"));
  ok((await fenced({ toolName: WRITE_OP, approvedTools: new Set<string>(), callId: "c", toolInput: {} } as never)) === "user-approval", "no session at all → the wrapped decision stands (the card is still raised)");
  ok((await ask(fenced, null, WRITE_OP)) === "user-approval", "a null auth → the wrapped decision stands");
  const unbindable = withUnattendedConnectorFence(fixedPolicy("user-approval"), { surfaceContext: async () => null });
  ok((await ask(unbindable, fireAuth(), WRITE_OP)) === "user-approval", "a surface that will not bind → the wrapped decision stands, and nothing is lifted");
  const brokenStore = withUnattendedConnectorFence(fixedPolicy("user-approval"), {
    grantExists: async () => {
      throw new Error("store down");
    },
  });
  ok(isDenied(await ask(brokenStore, fireAuth(), WRITE_OP)), "a failing row read refuses rather than lifting (fail closed on the read)");
  ok((await ask(fenced, fireAuth(), "post_file")) === "user-approval", "a non-connector tool is passed through untouched");
}

console.log("§10 an unattended run with no routine permission key:");
{
  let reads = 0;
  const fenced = withUnattendedConnectorFence(fixedPolicy("user-approval"), {
    grantExists: async () => {
      reads++;
      return true;
    },
  });
  const decision = await ask(fenced, webhookAuth(), WRITE_OP);
  ok(isDenied(decision), "a webhook fire (the REAL webhookFireAttributes bag carries no routine permission key) is refused");
  ok(reads === 0, "…and no row read is even attempted — there is no key to read one under");
  ok(rowFor(await refusedRows(), WRITE_OP) !== undefined, "…and the refusal is still audited");
}

console.log("§11 a poisoned turn is never lifted:");
{
  const clean = withUnattendedConnectorFence(fixedPolicy("user-approval"), { tainted: () => false });
  const poisoned = withUnattendedConnectorFence(fixedPolicy("user-approval"), { tainted: () => true });
  ok((await ask(clean, fireAuth(), WRITE_OP)) === "not-applicable", "control: the same fire, same row, UNtainted → lifted");
  const decision = await ask(poisoned, fireAuth(), WRITE_OP);
  ok(isDenied(decision), "a TAINTED fire is REFUSED, however live the row (TAINTED-NEVER, as tools/open_pull_request.ts reads it)");
  ok(isDenied(decision) && (decision.reason ?? "").includes(TAINTED_ASK_UNATTENDED_SENTENCE), "…with the approvals plane's TAINTED sentence, not the plain one");
  ok(isDenied(decision) && !(decision.reason ?? "").includes(`Declare "${WRITE_DECLARATION}"`), "…and no advice to arm a card that would not lift it");
  const row = rowFor(await refusedRows(), WRITE_OP);
  ok(row?.detail?.["reason"] === "ask-unattended-tainted" && row.detail["tainted"] === true, "…and the audit row says WHY it was refused");
  ok(isDenied(await ask(poisoned, fireAuth(), DESTRUCTIVE_OP)), "a tainted destructive op is refused as well");
  const thrownRows: Record<string, unknown>[] = [];
  const throwingTaint = withUnattendedConnectorFence(fixedPolicy("user-approval"), {
    tainted: () => {
      throw new Error("no session slot");
    },
    audit: (async (row: unknown) => {
      thrownRows.push(row as Record<string, unknown>);
    }) as never,
  });
  const thrownDecision = await ask(throwingTaint, fireAuth(), WRITE_OP);
  ok(isDenied(thrownDecision), "🔴 a THROWING taint read REFUSES — the row that lifted the control call above lifts nothing when the signal could not be read");
  ok(isDenied(thrownDecision) && (thrownDecision.reason ?? "").includes(TAINTED_ASK_UNATTENDED_SENTENCE), "…with the TAINTED sentence, because an unreadable signal is treated as poisoned rather than as clean");
  ok(thrownRows.length === 1, "…and it writes EXACTLY ONE audit row — a lift would have written a `connector.unattended_lift` instead, and no row at all would mean the refusal ran off a stand-down path");
  const thrownDetail = (thrownRows[0]?.["detail"] ?? {}) as Record<string, unknown>;
  ok(thrownDetail["tainted"] === true && thrownDetail["reason"] === "ask-unattended-tainted", "…and THAT row says why a live row did not lift — read off the injected sink, so no earlier leg's row can answer for it");
  ok((await ask(withUnattendedConnectorFence(fixedPolicy("user-approval"), { tainted: () => false }), fireAuth(), WRITE_OP)) === "not-applicable", "control: a read that ANSWERS false still lifts — the refusal above is the throw, not the fence");
  const settled = await ask(throwingTaint, fireAuth(), WRITE_OP).then(() => "resolved", () => "rejected");
  ok(settled === "resolved", "…and the throw is ANSWERED, never propagated to eve — the policy settles fulfilled");
}

console.log("§11b a poisoned fire is not told to declare the retired contentOrigin:");
{
  const poisoned = withUnattendedConnectorFence(fixedPolicy("user-approval"), { tainted: () => true });
  const decision = await ask(poisoned, fireAuth(), WRITE_OP);
  ok(isDenied(decision), "🔴 a tainted unattended write is still REFUSED — the fence decides as before");
  ok(isDenied(decision) && !(decision.reason ?? "").includes("contentOrigin"), "OPE-2723: …and the refusal no longer tells the operator to declare `contentOrigin`");
  ok(isDenied(decision) && (decision.reason ?? "").includes(TAINTED_ASK_UNATTENDED_SENTENCE), "…and the plane's own sentence still stands, unedited");
  ok(isDenied(decision) && !(decision.reason ?? "").includes(`Declare "${WRITE_DECLARATION}"`), "…and still no advice to arm a card that would not lift it");
  const cleanRefusal = await ask(withUnattendedConnectorFence(fixedPolicy("user-approval"), { tainted: () => false }), webhookAuth(), WRITE_OP);
  ok(isDenied(cleanRefusal) && (cleanRefusal.reason ?? "").includes(`Declare "${WRITE_DECLARATION}"`), "control: an UNtainted unattended refusal still names the declaration that would lift it");
}

console.log("§12 a <plugin>__<server> connection keys on its whole tool name:");
{
  const PLUGIN_OP = "acme__notes__create_page";
  ok(isDenied(await ask(cardProbePolicy(), fireAuth(), PLUGIN_OP)), "an undeclared write on `acme__notes` is refused");
  const row = rowFor(await refusedRows(), PLUGIN_OP);
  ok(row?.detail?.["connection"] === "acme__notes", "…and the audit row names the WHOLE slug, not its head segment");
  ok(row?.detail?.["grant"] === connectorToolPermissionKind(PLUGIN_OP), "…and the kind it looked for is the whole TOOL's, with nothing parsed out of it");
  await armDeclaredRoutinePermissions({
    org: "default",
    routine: ROUTINE,
    declared: [`tool:${PLUGIN_OP}`],
    grantedBy: "U0HUMAN",
    tainted: false,
    nowIso: new Date().toISOString(),
  });
  ok((await ask(cardProbePolicy(), fireAuth(), PLUGIN_OP)) === "not-applicable", "control: a `tool:acme__notes__create_page` row DOES lift it");
  ok(isDenied(await ask(cardProbePolicy(), fireAuth(), "acme__notes__share_page")), "…and nothing else on `acme__notes` rides it");
  ok((await ask(withUnattendedConnectorFence(fixedPolicy("user-approval")), fireAuth(), "grant__U0OWNER__create_page")) === "user-approval", "a reserved `grant__` name is passed through untouched");
}

console.log("§13 one declared row lifts one tool, and a legacy row lifts nothing:");
{
  await armDeclaredRoutinePermissions({
    org: "default",
    routine: ROUTINE,
    declared: [`tool:${SHARE_OP}`],
    grantedBy: "U0HUMAN",
    tainted: false,
    nowIso: new Date().toISOString(),
  });
  ok((await ask(cardProbePolicy(), fireAuth(), SHARE_OP)) === "not-applicable", "control: the declared tool `notion__share_page` lifts");
  ok(
    isDenied(await ask(cardProbePolicy(), fireAuth(), INVITE_OP)),
    "🔴 a declared permission for `notion__share_page` does NOT lift `notion__invite_user` — same connection, same tier, one row",
  );
  ok(rowFor(await refusedRows(), INVITE_OP)?.detail?.["tier"] === "write", "…and it is refused as a WRITE, so the leg is not passing on a tier misread");

  const { getOperationalStore } = await import("../agent/operational/provider.js");
  await getOperationalStore().setSessionApproval({
    org: "default",
    sessionId: OTHER_ROUTINE_KEY,
    kind: connectorSessionKind("notion"),
    grantedBy: "U0HUMAN",
    createdAt: new Date().toISOString(),
    expiresAt: "9999-12-31T23:59:59.999Z",
  });
  ok(
    isDenied(await ask(cardProbePolicy(), fireAuth(OTHER_ROUTINE_KEY), WRITE_OP)),
    "🔴 a legacy `connector.op:notion` row lifts NOTHING — refused, never widened into the connection's write class",
  );
  ok(
    isDenied(await ask(cardProbePolicy(), fireAuth(OTHER_ROUTINE_KEY), SHARE_OP)),
    "…on any tool of that connection",
  );
  const stored = await getOperationalStore().getSessionApproval("default", OTHER_ROUTINE_KEY, connectorSessionKind("notion"), new Date().toISOString());
  ok(stored !== null, "control: the legacy row really is live in the store under that routine key");
}

console.log("§14 the permission key is read off the same bag the plane would pick:");
{
  const attributes = routineFireAttributes(ROUTINE, DEST_ATTRS, "channel", true);
  const splitBag = { current: { principalId: "" }, initiator: { attributes } };

  const { getOperationalStore } = await import("../agent/operational/provider.js");
  const stored = await getOperationalStore().getSessionApproval(
    "default",
    GRANT_KEY,
    connectorToolPermissionKind(WRITE_OP),
    new Date().toISOString(),
  );
  ok(stored !== null, "control: the declared row for this tool really is live under the routine key");

  ok(
    isDenied(await ask(cardProbePolicy(), splitBag, WRITE_OP)),
    "🔴 a `current` with no attributes does NOT fall through to the initiator's permission key — refused",
  );
  ok(
    (await ask(cardProbePolicy(), { current: { attributes }, initiator: { attributes } }, WRITE_OP)) === "not-applicable",
    "control: the identical stamp on `current` DOES lift, so the refusal above is the bag choice and nothing else",
  );
}

console.log("§18 an arm cannot lift an op on an unattended fire:");
{
  const armed = (tier: "read" | "write" | "destructive" | undefined) => ({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
    connectorOpTier: () => tier,
  });
  const UNKNOWN_OP = "notion__frobnicate_widget";
  const NOUN_COLLISION_OP = "notion__get_delete_marker";
  ok(classifyConnectorOpTier(NOUN_COLLISION_OP) === "destructive", "fixture: the built-in reads get_delete_marker as a delete");

  registerConfig(armed(undefined));
  ok(isDenied(await ask(cardProbePolicy(), fireAuth(), UNKNOWN_OP)), "control: with no arm, an unrecognised op is refused on an unattended fire");

  registerConfig(armed("read"));
  ok(effectiveConnectorOpTier(UNKNOWN_OP) === "write", "the arm lowered the unrecognised op to `write` — floored, not opened");
  ok(effectiveConnectorOpTier(NOUN_COLLISION_OP) === "write", "…and lowered the RECOGNISED destructive to `write` too");

  const memo = new Set([NOUN_COLLISION_OP]);
  ok(
    (await ask(cardProbePolicy(), HUMAN_AUTH, NOUN_COLLISION_OP, memo)) === "not-applicable",
    "🔴 an attended human who already approved the arm-lowered op for the session is not asked again",
  );
  registerConfig(armed(undefined));
  ok(
    carded(await ask(cardProbePolicy(), HUMAN_AUTH, NOUN_COLLISION_OP, memo)),
    "🔴 NEGATIVE CONTROL: with no arm the SAME memo does not cover it — destructive prompts per call, so the leg above measured the arm",
  );
  registerConfig(armed("read"));

  const memoedFire = await ask(cardProbePolicy(), fireAuth(), NOUN_COLLISION_OP, memo);
  ok(isDenied(memoedFire), "🔴 an unattended fire holding the session memo for an arm-lowered DELETE is REFUSED, not executed");
  ok(isDenied(memoedFire) && (memoedFire.reason ?? "").includes(ASK_UNATTENDED_SENTENCE), "…with the plane's own ask-unattended sentence");
  ok(isDenied(memoedFire) && (memoedFire.reason ?? "").includes("destructive-tier"), "…naming the BUILT-IN's tier, which is the tier the arm could not lower");
  registerConfig(armed(undefined));
  ok(
    carded(await ask(cardProbePolicy(), HUMAN_AUTH, NOUN_COLLISION_OP, memo)),
    "control: the refusal above is the FIRE and not the memo — the same memo on a human turn is unaffected with no arm",
  );
  registerConfig(armed("read"));

  ok(isDenied(await ask(cardProbePolicy(), fireAuth(), UNKNOWN_OP)), "🔴 an everything-is-read arm does NOT open an unrecognised op on an unattended fire");
  ok(rowFor(await refusedRows(), UNKNOWN_OP)?.detail?.["tier"] === "destructive", "…and it is refused at the BUILT-IN's tier, not the arm's");
  ok(isDenied(await ask(cardProbePolicy(), fireAuth(), NOUN_COLLISION_OP)), "🔴 …and the arm-LOWERED recognised destructive is refused on the same fire");
  ok(rowFor(await refusedRows(), NOUN_COLLISION_OP)?.detail?.["tier"] === "destructive", "🔴 …also at the built-in's tier: the JOIN is what this fence gates on, not the seam");

  registerConfig(armed("write"));
  ok(effectiveConnectorOpTier(UNKNOWN_OP) === "write", "the arm really did answer `write` for the unrecognised op (the seam moved)");
  ok(effectiveConnectorOpTier(NOUN_COLLISION_OP) === "write", "…and for the recognised destructive");
  for (const op of [UNKNOWN_OP, NOUN_COLLISION_OP]) {
    let refusedDeclaration = false;
    try {
      declaredPermissionKinds([`tool:${op}`]);
    } catch {
      refusedDeclaration = true;
    }
    ok(refusedDeclaration, `🔴 the DECLARATION of ${op} is refused at propose time — the static tier, which no arm moves`);
  }
  ok(declaredPermissionKinds([`tool:${INVITE_OP}`]).length === 1, "control: a recognised write declares cleanly, so the refusals above are the tier and not the vocabulary");
  await armDeclaredRoutinePermissions({
    org: "default",
    routine: ROUTINE,
    declared: [`tool:${UNKNOWN_OP}`],
    grantedBy: "U0HUMAN",
    tainted: false,
    nowIso: new Date().toISOString(),
  });
  ok(isDenied(await ask(cardProbePolicy(), fireAuth(), UNKNOWN_OP)), "🔴 …so arming that declaration lifts nothing, and the fire is still refused");

  registerConfig(armed("read"));
  ok(effectiveConnectorOpTier(INVITE_OP) === "write", "a recognised write is already at the floor, so an everything-is-read arm leaves it there");
  ok(isDenied(await ask(cardProbePolicy(), fireAuth(), INVITE_OP)), "…and it is still refused on an unattended fire with no covering row");

  registerConfig(armed("read"));
  const openedPolicy = (deps: Parameters<typeof withUnattendedConnectorFence>[1] = {}) =>
    withUnattendedConnectorFence(fixedPolicy("not-applicable"), deps);
  ok(
    (await connectorOpApproval()(approvalCtx(fireAuth(), NOUN_COLLISION_OP, memo))) === "not-applicable",
    "🔴 precondition: the WRAPPED policy raises no card for a memo'd arm-lowered op — so a stand-down would return `not-applicable`, which RUNS it",
  );
  const noAuth = await ask(openedPolicy(), undefined, NOUN_COLLISION_OP);
  ok(isDenied(noAuth), "🔴 an unattended fire with NO `session.auth` is REFUSED on the arm-lowered path, not executed");
  ok(isDenied(noAuth) && (noAuth.reason ?? "").includes(ASK_UNATTENDED_SENTENCE), "…with the approvals plane's own ask-unattended sentence");
  ok(isDenied(await ask(openedPolicy(), null, NOUN_COLLISION_OP)), "a NULL auth bag refuses on the same path");
  const poisoned = await ask(openedPolicy({ tainted: () => true }), undefined, NOUN_COLLISION_OP);
  ok(isDenied(poisoned) && (poisoned.reason ?? "").includes(TAINTED_ASK_UNATTENDED_SENTENCE), "a TAINTED arm-lowered stand-down refuses with the plane's TAINTED sentence");
  ok(isDenied(poisoned) && !(poisoned.reason ?? "").includes(ASK_UNATTENDED_SENTENCE), "…and not the plain one, whose advice a poisoned turn cannot act on");
  const unbindable = await ask(openedPolicy({ surfaceContext: async () => null }), fireAuth(), NOUN_COLLISION_OP);
  ok(isDenied(unbindable), "🔴 a surface that will not bind is REFUSED under the same arm — an unprovable turn is not a proven attended one");
  ok(rowFor(await refusedRows(), "grant__U0OWNER__frobnicate") === undefined, "…and no `connector.refused` row is written for a stand-down there is no readable bag to attribute");
  ok((await ask(openedPolicy(), HUMAN_AUTH, NOUN_COLLISION_OP)) === "not-applicable", "a PROVEN attended turn still takes the arm's answer: the memo stands, no card");

  const RESERVED_OP = "grant__U0OWNER__frobnicate";
  const EMPTY_CONNECTION_OP = "__frobnicate";
  ok(effectiveConnectorOpTier(RESERVED_OP) === "destructive", "a RESERVED-namespace name is never moved by an arm — the arm is not consulted for a name that parses to NO connection");
  ok(effectiveConnectorOpTier(EMPTY_CONNECTION_OP) === "write", "🔴 …while an EMPTY connection IS passed to the arm, which lowers it — so this stand-down is arm-reachable and the two cases are not alike");
  ok(isDenied(await ask(openedPolicy(), fireAuth(), EMPTY_CONNECTION_OP)), "🔴 an unattended fire on an arm-lowered `__<verb>` name is REFUSED, not executed");
  ok((await ask(openedPolicy(), fireAuth(), RESERVED_OP)) === "not-applicable", "control: the RESERVED name still stands the fence down — no arm lowered it, so nothing changed for the credential-grant plane");

  registerConfig(armed(undefined));
  ok((await ask(openedPolicy(), undefined, NOUN_COLLISION_OP)) === "not-applicable", "no arm: a null-ish auth → the wrapped decision still stands, verbatim");
  ok(
    (await ask(withUnattendedConnectorFence(fixedPolicy("user-approval"), { surfaceContext: async () => null }), fireAuth(), NOUN_COLLISION_OP)) === "user-approval",
    "no arm: a surface that will not bind → the wrapped decision still stands, verbatim",
  );
  ok(isDenied(await ask(openedPolicy(), fireAuth(), EMPTY_CONNECTION_OP)) === false, "no arm: the `__<verb>` name stands the fence down again — the refusal above was the arm and nothing else");
}

console.log("§hints the server's annotations join the fence's built-in tier (2026-10-10):");
{
  const liftable = (toolHints?: () => Promise<{ readOnlyHint?: boolean; destructiveHint?: boolean } | undefined>) =>
    withUnattendedConnectorFence(fixedPolicy("user-approval"), { grantExists: async () => true, ...(toolHints ? { toolHints } : {}) });
  ok((await ask(liftable(), fireAuth(), WRITE_OP)) === "not-applicable", "control: with no hint, a declared WRITE lifts on its fire");
  ok(
    isDenied(await ask(liftable(async () => ({ readOnlyHint: false, destructiveHint: true })), fireAuth(), WRITE_OP)),
    "🔴 a write-named op its server declares DESTRUCTIVE is refused on an unattended fire, whatever the declared row says",
  );
  ok(
    (await ask(withUnattendedConnectorFence(fixedPolicy("user-approval"), { grantExists: async () => false, toolHints: async () => ({ readOnlyHint: true }) }), fireAuth(), "notion__frobnicate_widget")) === "user-approval",
    "an unrecognised op its server declares read-only is a READ to the fence: it stands down and returns the wrapped decision",
  );
  ok(
    isDenied(await ask(withUnattendedConnectorFence(fixedPolicy("user-approval"), { grantExists: async () => false }), fireAuth(), "notion__frobnicate_widget")),
    "…control: the same op with no hint stays fail-closed destructive and is refused",
  );
}

await removeTempDir(tmp);
console.log(`✓ connector-unattended-fence: ${passed} assertions passed (refuse + lift + attended/read untouched + destructive-never + TAINTED-never + per-tool keying + legacy refused + ordering + fail-soft + bag selection + the OPE-1321 arm floor)`);

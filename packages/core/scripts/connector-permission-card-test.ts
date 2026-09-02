import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-connector-permission-card-"));
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_PLATFORM = "slack";
process.env.OE_EGRESS_SPOOF = "1";
delete process.env.OE_ORG;

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();

import type { ApprovalStatus } from "eve/tools/approval";

const routineDispatch = await import("../agent/schedules/routine-dispatch.js");
const { connectorApprovalPolicy, ASK_UNATTENDED_SENTENCE, TAINTED_ASK_UNATTENDED_SENTENCE } = await import("../agent/connections/connector-auth.js");
const { registerConfig } = await import("../agent/access/config.js");
const { overrideSettingsForTest, registerSettings } = await import("../agent/settings/settings.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { addRoutine } = await import("../agent/routines/store.js");
const { ROUTINE_MARKER, routineGrantKey } = await import("../agent/routines/routine.js");
const { routineFireAttributes, webhookFireAttributes } = await import("../agent/routines/fire-auth.js");
const { ROUTINE_GRANT_NO_EXPIRY } = await import("../agent/routines/grants.js");
const { ROUTINE_PERMISSION_KIND } = await import("../agent/approvals/routine-permission.js");
const { connectorToolPermissionKind, describeGrantKind } = await import("../agent/approvals/session-grant.js");
const { resolveApprovalClick, requestApproval } = await import("../agent/approvals/flow.js");
const { consumeRoutineRunPermissionRefusals } = await import("../agent/approvals/card-signal.js");
const { RUN_REFUSAL_HEADING, withRunRefusalBlock } = await import("../agent/routines/report.js");
const { readAudit } = await import("../agent/audit/audit.js");

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
overrideSettingsForTest({ connectors: { opTiering: true } });

class FakeSession {
  private readonly slots = new Map<string, unknown>();
  get<T>(key: { name: string }): T | undefined {
    return this.slots.get(key.name) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.slots.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`missing ${key.name}`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
    const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
    this.slots.set(key.name, next);
    return next;
  }
  ensure<T>(key: { name: string }, create: () => T): T {
    return this.has(key) ? this.require(key) : this.set(key, create());
  }
  clearVirtualContext(): void {}
  setVirtualContext(): void {}
  *entries(): Generator<readonly [unknown, unknown]> {}
}
function eveContextStorage(): AsyncLocalStorage<unknown> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return g[key] as AsyncLocalStorage<unknown>;
}
async function inSession<T>(fn: () => T | Promise<T>): Promise<T> {
  return eveContextStorage().run(new FakeSession(), fn);
}

const ORG = "default";
const SURFACE = "slack/T0CARD/C0CARD";
const store = getOperationalStore();

routineDispatch.registerRoutineDispatch("slack", {
  resolveTarget: (r) => {
    const channelId = (r.target as { channelId?: string } | undefined)?.channelId;
    if (!channelId) return null;
    return { channel: {} as never, target: { channelId }, mode: "channel", attributes: {}, origin: { platform: "slack", channelId } };
  },
});

const routine = await addRoutine({ org: ORG, surfaceKey: SURFACE } as never, {
  id: "r-connector",
  org: ORG,
  surfaceKey: SURFACE,
  target: { channelId: "C0CARD" },
  trigger: { kind: "cron", cron: "0 3 * * *" },
  prompt: "Every night, publish the digest to Notion.",
  createdBy: "U0CREATOR",
  createdAt: new Date().toISOString(),
  status: "active",
} as never);
const KEY = routineGrantKey(routine);

const DEST_ATTRS = { team_id: "T0CARD", channel_id: "C0CARD", channel_type: "channel" } as const;
const WRITE_OP = "notion__create_page";
const OTHER_WRITE_OP = "notion__share_page";
const DELETE_OP = "notion__delete_page";
const WRITE_DECLARATION = `tool:${WRITE_OP}`;

function fireAuth(): unknown {
  const attributes = routineFireAttributes(routine as never, DEST_ATTRS, "channel", true);
  return { current: { attributes: { ...attributes, [ROUTINE_MARKER.grant]: KEY } } };
}
function webhookAuth(): unknown {
  return { current: { attributes: webhookFireAttributes("hook-1", "T0CARD", "C0CARD", false, true) } };
}

function approvalCtx(auth: unknown, toolName: string): never {
  return {
    toolName,
    approvedTools: new Set<string>(),
    callId: `call-${toolName}`,
    toolInput: { title: "x" },
    session: { id: `sess-${toolName}`, auth },
  } as never;
}

async function ask(auth: unknown, toolName: string): Promise<{ decision: ApprovalStatus; reason: string }> {
  const decision = await connectorApprovalPolicy()(approvalCtx(auth, toolName));
  const reason = typeof decision === "object" && decision !== null && "reason" in decision ? String((decision as { reason?: string }).reason ?? "") : "";
  return { decision, reason };
}
function isDenied(decision: ApprovalStatus): boolean {
  return typeof decision === "object" && decision !== null && (decision as { type?: string }).type === "denied";
}

type CardRow = { id: string; argsJson: string; channelId: string; expiresAt: string; postedTo: string | null };
async function cards(): Promise<CardRow[]> {
  return (await store.listPendingActions(ORG)).filter((r) => r.kind === ROUTINE_PERMISSION_KIND) as never;
}
function argsOf(row: CardRow): { grantKind?: string; declaration?: string; grantKey?: string; routineId?: string } {
  return JSON.parse(row.argsJson) as never;
}
async function liftRows(): Promise<readonly { detail?: Readonly<Record<string, unknown>> }[]> {
  return await readAudit({ org: ORG, action: "connector.unattended_lift" });
}

console.log("§card the fence offers the routine permission card:");
{
  const { decision, reason } = await ask(fireAuth(), WRITE_OP);
  ok(isDenied(decision), "§card: the unattended write is STILL refused — the card decides the NEXT fire, never this one");
  ok(reason.includes(ASK_UNATTENDED_SENTENCE), "§card: with the approvals plane's own ask-unattended sentence, unchanged");
  ok(reason.includes(`Declare "${WRITE_DECLARATION}"`), "§card: and the declaration advice, unchanged");
  ok(reason.includes("is now waiting in the routine's own room"), "🔴 §card: and the refusal now tells the model a card was posted");

  const rows = await cards();
  ok(rows.length === 1, "🔴 §card: EXACTLY ONE permission card row landed");
  const row = rows[0]!;
  ok(row.channelId === "C0CARD", "§card: it landed in the ROUTINE's own room");
  ok(row.expiresAt === ROUTINE_GRANT_NO_EXPIRY, "§card: with no clock expiry — the routine generation is its bound");
  const args = argsOf(row);
  ok(args.grantKind === connectorToolPermissionKind(WRITE_OP), "🔴 §card: the card decides the PER-TOOL kind the fence's lift arm reads");
  ok(args.declaration === WRITE_DECLARATION, "🔴 §card: and names `tool:<qualified op>` — the exact string the refusal coaches a human to declare");
  ok(args.grantKey === KEY, "§card: frozen with the routine generation the fire ran under");
  ok(args.routineId === "r-connector", "§card: and the routine it arms");
}

console.log("§dedup one card per permission per generation:");
{
  const again = await ask(fireAuth(), WRITE_OP);
  ok(isDenied(again.decision), "§dedup: the second refusal of the same op is still a refusal");
  ok((await cards()).length === 1, "🔴 §dedup: and posts NO second card — the planner's own de-dup, reached through the fence");
  ok(again.reason.includes("is already waiting"), "§dedup: the refusal re-points at the live card instead of claiming a fresh one");
  ok(!again.reason.includes("is now waiting"), "§dedup: and never says a card was just posted when none was");

  const other = await ask(fireAuth(), OTHER_WRITE_OP);
  ok(isDenied(other.decision), "§dedup: control — a different write op on the same connection is refused too");
  const rows = await cards();
  ok(rows.length === 2, "🔴 §dedup: and gets its OWN card — the de-dup is per PERMISSION, never 'one card ever'");
  ok(
    rows.some((r) => argsOf(r).grantKind === connectorToolPermissionKind(OTHER_WRITE_OP)),
    "§dedup: naming its own tool's kind",
  );
  ok(other.reason.includes("is now waiting in the routine's own room"), "§dedup: and its refusal says a card was posted");
}

console.log("§delete a delete-tier verb is never carded:");
{
  const before = (await cards()).length;
  const { decision, reason } = await ask(fireAuth(), DELETE_OP);
  ok(isDenied(decision), "§delete: the destructive op is refused");
  ok((await cards()).length === before, "🔴 §delete: and NO card is posted — a click could never lift it, so offering one would be theatre");
  ok(!reason.includes("waiting in the routine's own room"), "🔴 §delete: the refusal claims no card either");
  ok(reason.includes(ASK_UNATTENDED_SENTENCE), "§delete: it is the plain ask-unattended refusal, unchanged");
  ok(!reason.includes("Declare "), "§delete: which offers no declaration advice, because no declaration lifts a delete");
}

console.log("§click approving the card lets the next unattended fire run the op:");
{
  const row = (await cards()).find((r) => argsOf(r).grantKind === connectorToolPermissionKind(WRITE_OP))!;
  ok(row !== undefined, "§click: the write op's card is the one under test");

  const beforeLifts = (await liftRows()).length;
  ok(isDenied((await ask(fireAuth(), WRITE_OP)).decision), "§click: control — before the click the op is denied");
  ok((await liftRows()).length === beforeLifts, "§click: control — and nothing was lifted");
  ok((await store.getSessionApproval(ORG, KEY, connectorToolPermissionKind(WRITE_OP), new Date().toISOString())) === null, "§click: control — no standing row exists yet");

  const res = await resolveApprovalClick({ org: ORG, id: row.id, clickerId: "U0CLICKER", decision: "approve" } as never);
  ok(res.outcome === "decided", "§click: the approve decides the card");

  const granted = await store.getSessionApproval(ORG, KEY, connectorToolPermissionKind(WRITE_OP), new Date().toISOString());
  ok(granted !== null, "🔴 §click: and writes exactly the standing row the fence's lift arm reads");
  ok(granted?.grantedBy === "U0CLICKER", "§click: recorded against the human who armed it, never the fire");
  ok(granted?.expiresAt === ROUTINE_GRANT_NO_EXPIRY, "§click: with no TTL — the routine generation is the death mechanism");

  const after = await ask(fireAuth(), WRITE_OP);
  ok(after.decision === "not-applicable", "🔴 §click: the NEXT unattended fire's fence now LIFTS the op — the card was worth clicking");
  const lifts = await liftRows();
  ok(lifts.length === beforeLifts + 1, "§click: and lands one connector.unattended_lift row");
  ok(lifts.some((r) => r.detail?.["op"] === WRITE_OP && r.detail?.["routine"] === KEY), "§click: naming the op and the routine row that lifted it");

  ok(isDenied((await ask(fireAuth(), OTHER_WRITE_OP)).decision), "🔴 §click: one click arms ONE tool — the sibling op on the same connection is still refused");
}

console.log("§report the run's outcome summary lists a connector-plane refusal:");
{
  const quiet = await inSession(async () => {
    await ask(fireAuth(), WRITE_OP);
    return consumeRoutineRunPermissionRefusals();
  });
  ok(quiet.length === 0, "§report: a fire whose op was LIFTED lost no permission, so the ledger stays empty");

  const listed = await inSession(async () => {
    await ask(fireAuth(), OTHER_WRITE_OP);
    return consumeRoutineRunPermissionRefusals();
  });
  ok(listed.length === 1, "🔴 §report: the connector fence's refusal RECORDS the loss on this run's ledger");
  ok(listed[0]?.permission === describeGrantKind(connectorToolPermissionKind(OTHER_WRITE_OP)), "§report: named in the same plain language list_routines uses for a live grant");
  ok(listed[0]?.card !== null, "§report: with a pointer to the still-open card, which is what makes the line actionable");
  ok(listed[0]?.cardKnown === true, "§report: and the card's state was really read");

  const both = await inSession(async () => {
    await ask(fireAuth(), OTHER_WRITE_OP);
    await requestApproval(
      {
        org: ORG,
        kind: "pr.open",
        args: { org: ORG, scopeKey: SURFACE, sessionId: KEY, repo: "o/r", title: "t", body: "b", base: "main", head: "h" },
        scopeKey: SURFACE,
        requestedBy: "U0CREATOR",
        channelId: "C0CARD",
        threadTs: null,
      } as never,
      {},
    ).catch(() => undefined);
    return consumeRoutineRunPermissionRefusals();
  });
  ok(both.length === 2, "🔴 §report: one run refused by BOTH planes lists both losses");
  ok(both.some((e) => e.permission === "open pull requests"), "§report: the approvals plane's line");
  ok(both.some((e) => e.permission.includes(OTHER_WRITE_OP)), "§report: and the connector plane's line, beside it");
  const rendered = withRunRefusalBlock("The digest is published.", both);
  ok(rendered.includes(RUN_REFUSAL_HEADING), "🔴 §report: and the run's own report renders them under ONE heading");
  ok(rendered.includes("open pull requests") && rendered.includes(OTHER_WRITE_OP), "§report: with both permissions named in it");
}

console.log("§never a tainted turn and a non-routine fire card nothing:");
{
  const { withUnattendedConnectorFence, connectorOpApproval, unattendedConnectorRefusalMessage } = await import("../agent/connections/connector-auth.js");
  const before = (await cards()).length;
  const poisoned = withUnattendedConnectorFence(connectorOpApproval(), { tainted: () => true });
  const decision = await poisoned(approvalCtx(fireAuth(), "notion__update_page"));
  const reason = typeof decision === "object" && decision !== null && "reason" in decision ? String((decision as { reason?: string }).reason ?? "") : "";
  ok(isDenied(decision), "§never: a tainted turn is refused");
  ok(reason.includes(TAINTED_ASK_UNATTENDED_SENTENCE), "§never: with the plane's TAINTED sentence");
  ok((await cards()).length === before, "🔴 §never: and NO card — TAINTED-NEVER holds on the card side too, or fetched content would choose what a human is asked to arm");
  ok(!reason.includes("waiting in the routine's own room"), "§never: the refusal claims no card either");
  const clean = await ask(fireAuth(), "notion__update_page");
  ok(isDenied(clean.decision) && clean.reason.includes("is now waiting in the routine's own room"), "§never: control — the same op on a clean turn posts its card");
  ok((await cards()).length === before + 1, "§never: control — exactly one more card row");
  ok(
    unattendedConnectorRefusalMessage("notion", "notion__update_page", "write", true).includes(TAINTED_ASK_UNATTENDED_SENTENCE),
    "§never: and the tainted sentence is the message builder's, not this test's",
  );

  const hookBefore = (await cards()).length;
  const hook = await ask(webhookAuth(), "notion__append_block");
  ok(isDenied(hook.decision), "§never: a webhook fire's write is refused");
  ok((await cards()).length === hookBefore, "🔴 §never: and cards nothing — no routine holds the permission it would arm");
  ok(!hook.reason.includes("routine's own room"), "§never: its refusal is the byte-identical old one");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n✓ connector permission card: ${passed} assertions passed`);

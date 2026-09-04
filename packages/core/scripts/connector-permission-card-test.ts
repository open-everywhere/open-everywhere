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

const { resetTurnClock } = await import("../agent/observability/turn-clock.js");
const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();

import type { ApprovalStatus } from "eve/tools/approval";

const routineDispatch = await import("../agent/schedules/routine-dispatch.js");
const { connectorApprovalPolicy, ASK_UNATTENDED_SENTENCE, TAINTED_ASK_UNATTENDED_SENTENCE } = await import("../agent/connections/connector-auth.js");
const { registerConfig } = await import("../agent/access/config.js");
const { overrideSettingsForTest, registerSettings } = await import("../agent/settings/settings.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { addRoutine } = await import("../agent/routines/store.js");
const { ROUTINE_MARKER, routinePermissionKey } = await import("../agent/routines/routine.js");
const { routineFireAttributes, webhookFireAttributes } = await import("../agent/routines/fire-auth.js");
const { ROUTINE_PERMISSION_NO_EXPIRY } = await import("../agent/routines/declared-permissions.js");
const { ROUTINE_PERMISSION_KIND } = await import("../agent/approvals/routine-permission.js");
const { connectorToolPermissionKind, describeDeclaredPermissionKind } = await import("../agent/approvals/session-grant.js");
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
const KEY = routinePermissionKey(routine);

const DEST_ATTRS = { team_id: "T0CARD", channel_id: "C0CARD", channel_type: "channel" } as const;
const WRITE_OP = "notion__create_page";
const OTHER_WRITE_OP = "notion__share_page";
const DELETE_OP = "notion__delete_page";
const WRITE_DECLARATION = `tool:${WRITE_OP}`;

function fireAuth(): unknown {
  const attributes = routineFireAttributes(routine as never, DEST_ATTRS, "channel", true);
  return { current: { attributes: { ...attributes, [ROUTINE_MARKER.permissionKey]: KEY } } };
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
  ok(row.expiresAt === ROUTINE_PERMISSION_NO_EXPIRY, "§card: with no clock expiry — the routine generation is its bound");
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
  ok(granted?.expiresAt === ROUTINE_PERMISSION_NO_EXPIRY, "§click: with no TTL — the routine generation is the death mechanism");

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
  ok(listed[0]?.permission === describeDeclaredPermissionKind(connectorToolPermissionKind(OTHER_WRITE_OP)), "§report: named in the same plain language list_routines uses for a live grant");
  ok(listed[0]?.cardPosted === true, "🔴 §report: the line still records that a card IS waiting, which is what makes it actionable");
  ok(listed[0]?.card === null, "🔴 §report: and carries NO pointer on a surface that mints no permalink — never the room's internal ids");
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

console.log("§cap one fire posts at most MAX_RUN_REFUSALS cards:");
{
  const { MAX_RUN_REFUSALS } = await import("../agent/approvals/card-signal.js");
  const verbs = [
    "add", "insert", "post", "put", "patch", "set", "move", "comment", "edit",
    "write", "upload", "send", "assign", "label", "rename", "duplicate", "copy", "publish",
  ] as const;
  ok(verbs.length === MAX_RUN_REFUSALS + 2, "§cap: the fixture drives exactly two ops past the cap");
  const ops = verbs.map((v) => `notion__${v}_block`);

  const before = (await cards()).length;
  const reasons = await inSession(async () => {
    const out: string[] = [];
    for (const op of ops) {
      const { decision, reason } = await ask(fireAuth(), op);
      ok(isDenied(decision), `§cap: ${op} is refused`);
      out.push(reason);
    }
    return out;
  });

  const posted = (await cards()).length - before;
  ok(posted === MAX_RUN_REFUSALS, `🔴 §cap: exactly ${MAX_RUN_REFUSALS} cards landed for ${ops.length} refused ops — the post path is bounded per fire`);
  ok(reasons.length === ops.length, "🔴 §cap: and EVERY op was still refused — the cap drops cards, never refusals");
  const carded = reasons.filter((r) => r.includes("is now waiting in the routine's own room")).length;
  ok(carded === MAX_RUN_REFUSALS, "🔴 §cap: exactly the carded refusals claim a card — an over-cap refusal never claims one it did not get");
  ok(
    reasons.slice(MAX_RUN_REFUSALS).every((r) => !r.includes("waiting in the routine's own room")),
    "§cap: and it is the LAST two that go uncarded — the cap drops the newest asks, not arbitrary ones",
  );
  ok(
    reasons.slice(MAX_RUN_REFUSALS).every((r) => r.includes(ASK_UNATTENDED_SENTENCE) && r.includes("Declare ")),
    "§cap: an over-cap refusal keeps the plain ask-unattended sentence AND the declaration advice",
  );

  const capped = await inSession(async () => {
    resetTurnClock("turn_report", Date.now(), "sess-report");
    for (let i = 0; i < MAX_RUN_REFUSALS; i++) await ask(fireAuth(), ops[0]!);
    const overCap = await ask(fireAuth(), ops[1]!);
    return { entries: consumeRoutineRunPermissionRefusals(), overCap };
  });
  ok(isDenied(capped.overCap.decision), "§cap: the over-cap permission is refused");
  ok(capped.entries.length === 2, "🔴 §cap: BOTH permissions reach the run ledger — the capped one is recorded by the seam, not lost with its card");
  const cappedEntry = capped.entries.find((e) => e.cardCapped);
  ok(cappedEntry !== undefined, "🔴 §cap: and the over-cap one is marked as capped rather than as an ordinary absence");
  ok(capped.entries.filter((e) => !e.cardCapped).length === 1, "§cap: while the permission that did reach the card plane is not marked capped");
  ok(cappedEntry?.permission === describeDeclaredPermissionKind(connectorToolPermissionKind(ops[1]!)), "§cap: named in the SAME plain language every other report line uses");
  const cappedReport = withRunRefusalBlock("The digest is published.", capped.entries);
  ok(
    cappedReport.includes("no card was offered for it — this run reached its card limit"),
    "🔴 §cap: the report NAMES the capped loss and says why no card came",
  );
  ok(!cappedReport.includes("no card is waiting for it"), "🔴 §cap: …and never 'no card is waiting', which claims a fact nothing established and sends an owner to an edit_routine bump");
  ok(!cappedReport.includes("could not be read"), "§cap: …nor blames a store that was never asked");

  const sameSessionAfterNewTurn = await inSession(async () => {
    resetTurnClock("turn_cap_1", Date.now(), "sess-cap");
    for (const op of ops) await ask(fireAuth(), op);
    const spent = (await cards()).length;
    resetTurnClock("turn_cap_2", Date.now(), "sess-cap");
    await ask(fireAuth(), `notion__mark_block`);
    return (await cards()).length - spent;
  });
  ok(sameSessionAfterNewTurn === 1, "🔴 §cap: a SECOND TURN in the SAME session cards again — the budget is per turn, so a job routine's next fire is not silenced by its last one");

  const overCap = ops[ops.length - 1]!;
  const afterCap = (await cards()).length;
  const fresh = await inSession(async () => ask(fireAuth(), overCap));
  ok(isDenied(fresh.decision), "§cap: control — the over-cap op is refused on the next fire too");
  ok((await cards()).length === afterCap + 1, "🔴 §cap: control — and DOES card there, so the bound is per fire and not per op");
  ok(fresh.reason.includes("is now waiting in the routine's own room"), "§cap: control — and its refusal says so");
}

console.log("§timeout a stalled card post is dropped, not awaited:");
{
  const { registerRoutinePermissionCardOfferer, routinePermissionCardTimeoutMs, _setRoutinePermissionCardTimeoutMsForTest, _resetRoutinePermissionCardTimeoutMsForTest } =
    await import("../agent/approvals/routine-permission-offer.js");
  ok(routinePermissionCardTimeoutMs() === 8000, "§timeout: the shipped budget is 8s — the same number the result-reducing arm uses");

  registerRoutinePermissionCardOfferer(async () => ({ clause: " CLAUSE-FROM-STUB" }));
  const fast = await ask(fireAuth(), "notion__star_block");
  ok(isDenied(fast.decision), "§timeout: control — the op is refused");
  ok(fast.reason.includes("CLAUSE-FROM-STUB"), "🔴 §timeout: control — a prompt offerer's clause DOES reach the refusal through this path");

  let stalls = 0;
  registerRoutinePermissionCardOfferer(async () => {
    stalls++;
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    return { clause: " CLAUSE-FROM-STUB" };
  });
  _setRoutinePermissionCardTimeoutMsForTest(50);
  const startedAt = Date.now();
  const stalled = await ask(fireAuth(), "notion__attach_block");
  const elapsed = Date.now() - startedAt;
  _resetRoutinePermissionCardTimeoutMsForTest();

  ok(stalls === 1, "§timeout: the stalled offerer really was called — the leg measures the timeout, not a skipped call");
  ok(isDenied(stalled.decision), "🔴 §timeout: the refusal still refuses");
  ok(elapsed < 2_000, `🔴 §timeout: and returns in ${elapsed}ms, far inside the stub's 5s stall — the post cannot hold the durable step open`);
  ok(!stalled.reason.includes("CLAUSE-FROM-STUB"), "🔴 §timeout: with NO card clause — a timed-out post is a refusal without a card, never a claim of one");
  ok(stalled.reason.includes(ASK_UNATTENDED_SENTENCE), "§timeout: the plain ask-unattended sentence is untouched");
  ok(routinePermissionCardTimeoutMs() === 8000, "§timeout: and the test seam restored the shipped budget");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n✓ connector permission card: ${passed} assertions passed`);

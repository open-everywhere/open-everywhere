import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

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

const dir = join(tmpdir(), `open-everywhere-wake-accounting-turn-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });
const ORG = "acme";
const DOMAIN = "payments";

const { getOperationalStore } = await import("../agent/operational/provider.js");
const { registerUnifiedWakeTarget, mintWakeId } = await import("../agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { markWakeRepliedThisTurn, markWakeDeclinedThisTurn } = await import("../agent/channels/reply-signal.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { WAKE_ACCOUNTING_SKIPPED_AUDIT_ACTION, UNACCOUNTED_WAKES_AUDIT_ACTION } = await import("../agent/channels/wake-accounting.js");
const { auditUnaccountedWakesForTurn, auditLabels } = await import("../agent/channels/unified.js");
const wakeAccountingTurnModule = await import("../agent/hooks/wake-accounting-turn.js");
const wakeAccountingTurnHook = wakeAccountingTurnModule.default;
const { requestsHoldTheWorkerOpen } = wakeAccountingTurnModule;

const store = getOperationalStore();

class FakeSession {
  private readonly store = new Map<string, unknown>();
  get<T>(key: { name: string }): T | undefined {
    return this.store.get(key.name) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.store.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`missing ${key.name}`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
    const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
    this.store.set(key.name, next);
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
  const session = new FakeSession();
  return eveContextStorage().run(Object.assign(session, { context: session, values: new Map<unknown, unknown>() }), fn);
}

const EVENTS = wakeAccountingTurnHook.events as unknown as Record<string, (e: unknown, c: unknown) => unknown>;
const { interactionView } = await import("./_hook-view.js");
const fire = async (type: string, ctx: unknown, data?: unknown): Promise<void> => {
  const handler = EVENTS[type];
  if (typeof handler !== "function") throw new Error(`wake-accounting-turn does not bind ${type}`);
  await handler({ type, ...(data === undefined ? {} : { data }) }, ctx);
};
const settle = (ctx: unknown, turnId: string, outcome: "completed" | "failed" | "cancelled" = "completed"): Promise<void> => fire("turn.settled", ctx, { turnId, outcome });
const pause = (ctx: unknown, turnId: string, kind: "question" | "budget"): Promise<void> =>
  fire("turn.paused", { ...(ctx as object), view: interactionView(kind, `i-${kind}`, undefined, turnId) }, { turnId, awaiting: [{ interactionId: `i-${kind}` }] });

function hookCtx(token: string, turnId: string, wakeId: string | undefined): unknown {
  return {
    channel: { kind: "unified", continuationToken: `unified:${token}` },
    session: {
      id: `sess-${turnId}`,
      turn: { id: turnId },
      auth: { current: { attributes: wakeId ? { oe_wake_id: wakeId } : {} } },
    },
  };
}

const t = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
async function wakeAt(token: string, channelId: string, atIso: string, opts: { readonly addressing?: "direct-mention" } = {}): Promise<string> {
  const id = mintWakeId();
  await registerUnifiedWakeTarget(store, ORG, id, { platform: "slack", channelId }, atIso, token, true, opts.addressing);
  return id;
}

{
  for (const e of ["turn.started", "turn.paused", "turn.settled", "session.ended"]) {
    ok(typeof EVENTS[e] === "function", `§1: the hook binds ${e}`);
  }
  eq(EVENTS["content.completed"], undefined, "§1: content.completed is NOT bound here — that call site stays channels/unified.ts's own");
}

{
  const TOKEN = unifiedSupervisorToken(DOMAIN, 2);
  const turnId = "turn_200";
  const ignored = await wakeAt(TOKEN, "C_TURN2", t(-3000), { addressing: "direct-mention" });
  const turnWake = await wakeAt(TOKEN, "C_TURN2", t(-1000));

  await inSession(async () => {
    await fire("turn.started", hookCtx(TOKEN, turnId, turnWake));
    markWakeDeclinedThisTurn(turnId, turnWake);
    await settle(hookCtx(TOKEN, turnId, turnWake), turnId);
  });

  const rows = await readAudit({ org: ORG, action: UNACCOUNTED_WAKES_AUDIT_ACTION });
  const row = rows.find((r) => r.detail?.turnId === turnId);
  ok(row !== undefined, "§2: turn.settled alone (no reply call) still produces the unaccounted-wakes row");
  const unaccounted = (row?.detail?.unaccounted as { wakeId: string }[] | undefined) ?? [];
  ok(unaccounted.some((w) => w.wakeId === ignored), "§2: …naming the wake this turn never touched");
  ok(!unaccounted.some((w) => w.wakeId === turnWake), "§2/CONTROL: …but not the turn's own wake — turnStarted cleared the pause gate, so accounting ran");

  const stamped = await store.getUnifiedWakeRecord(ORG, turnWake);
  ok(stamped?.auditedAt !== undefined, "🔴 §2: the turn's OWN wake carries an `audited_at` STAMP — the exact prod symptom (zero stamps on a whole generation) is what this closes");
}

{
  const TOKEN = unifiedSupervisorToken(DOMAIN, 3);
  const turnId = "turn_300";
  const ignored = await wakeAt(TOKEN, "C_TURN3", t(-3000));
  const turnWake = await wakeAt(TOKEN, "C_TURN3", t(-1000));
  const { workspace, surface } = auditLabels(`unified:${TOKEN}`);

  await inSession(async () => {
    await auditUnaccountedWakesForTurn(ORG, workspace, surface, TOKEN, turnId, turnWake, false);
    await fire("turn.started", hookCtx(TOKEN, turnId, turnWake));
    await settle(hookCtx(TOKEN, turnId, turnWake), turnId);
  });

  const rows = (await readAudit({ org: ORG, action: UNACCOUNTED_WAKES_AUDIT_ACTION })).filter((r) => r.detail?.turnId === turnId);
  eq(rows.length, 1, "🔴 §3: exactly ONE unaccounted-wakes row for this turn, not two — the hook's later call found nothing left to stamp");
  ok((rows[0]?.detail?.unaccounted as { wakeId: string }[]).some((w) => w.wakeId === ignored), "§3: …and it is the FIRST call's row, naming the ignored wake");
}

{
  const TOKEN = unifiedSupervisorToken(DOMAIN, 4);
  const turnId = "turn_400";
  await wakeAt(TOKEN, "C_TURN4", t(-3000));
  const turnWake = await wakeAt(TOKEN, "C_TURN4", t(-1000));

  const before = (await readAudit({ org: ORG })).length;
  await inSession(async () => {
    await fire("turn.started", hookCtx(TOKEN, turnId, turnWake));
    await pause(hookCtx(TOKEN, turnId, turnWake), turnId, "question");
  });
  const after = (await readAudit({ org: ORG })).length;
  eq(after, before, "🔴 §4/NEGATIVE CONTROL: a turn paused on a real question writes NO row at turn.paused — the pass did not run prematurely");

  await inSession(async () => {
    await fire("turn.started", hookCtx(TOKEN, turnId, turnWake));
    await settle(hookCtx(TOKEN, turnId, turnWake), turnId);
  });
  const rows = (await readAudit({ org: ORG, action: UNACCOUNTED_WAKES_AUDIT_ACTION })).filter((r) => r.detail?.turnId === turnId);
  ok(rows.length === 1, "§4/POSITIVE CONTROL: …the same turn, with no pause, IS accounted for");
}

{
  const TOKEN = unifiedSupervisorToken(DOMAIN, 5);
  const turnId = "turn_500";
  await wakeAt(TOKEN, "C_TURN5", t(-3000));
  const turnWake = await wakeAt(TOKEN, "C_TURN5", t(-1000));

  await inSession(async () => {
    await fire("turn.started", hookCtx(TOKEN, turnId, turnWake));
    await pause(hookCtx(TOKEN, turnId, turnWake), turnId, "budget");
  });
  const rows = (await readAudit({ org: ORG, action: UNACCOUNTED_WAKES_AUDIT_ACTION })).filter((r) => r.detail?.turnId === turnId);
  ok(rows.length === 1, "§5: a turn paused only on eve's budget prompt does NOT hold this hook's gate open — accounting runs at turn.paused, because nothing ever answers that prompt");
}

{
  for (const [label, outcome] of [["cancelled", "cancelled"] as const, ["turn-failed", "failed"] as const, ["failed", "session-failed"] as const]) {
    const TOKEN = unifiedSupervisorToken(DOMAIN, 6);
    const turnId = `turn_600_${label}`;
    await wakeAt(TOKEN, `C_TURN6_${label}`, t(-3000));
    const turnWake = await wakeAt(TOKEN, `C_TURN6_${label}`, t(-1000));
    await inSession(async () => {
      await fire("turn.started", hookCtx(TOKEN, turnId, turnWake));
      if (outcome === "session-failed") await fire("session.ended", hookCtx(TOKEN, turnId, turnWake), { outcome: "failed" });
      else await settle(hookCtx(TOKEN, turnId, turnWake), turnId, outcome);
    });
    const rows = (await readAudit({ org: ORG, action: UNACCOUNTED_WAKES_AUDIT_ACTION })).filter((r) => r.detail?.turnId === turnId);
    ok(rows.length === 1, `§6: ${outcome} runs accounting exactly like a completed turn`);
  }
}

{
  const TOKEN = unifiedSupervisorToken(DOMAIN, 7);
  const turnWake = await wakeAt(TOKEN, "C_TURN7", t(-1000));
  const { workspace, surface } = auditLabels(`unified:${TOKEN}`);

  const skipRows = async (): Promise<{ reason?: string }[]> =>
    (await readAudit({ org: ORG, action: WAKE_ACCOUNTING_SKIPPED_AUDIT_ACTION })).filter((r) => r.workspace === workspace).map((r) => r.detail ?? {});

  await inSession(async () => {
    await auditUnaccountedWakesForTurn(ORG, workspace, surface, undefined, "turn_700a", turnWake, false);
    ok((await skipRows()).some((d) => d.reason === "no-window-token"), "§7: a missing windowToken writes reason `no-window-token`");

    await auditUnaccountedWakesForTurn(ORG, workspace, surface, TOKEN, undefined, turnWake, false);
    ok((await skipRows()).some((d) => d.reason === "no-turn-id"), "§7: a missing turnId writes reason `no-turn-id`");

    await auditUnaccountedWakesForTurn(ORG, workspace, surface, TOKEN, "turn_700c", undefined, false);
    ok((await skipRows()).some((d) => d.reason === "no-turn-wake"), "§7: a missing turnWake writes reason `no-turn-wake`");

    const before = (await readAudit({ org: ORG, action: WAKE_ACCOUNTING_SKIPPED_AUDIT_ACTION })).length;
    await auditUnaccountedWakesForTurn(ORG, workspace, surface, TOKEN, "turn_700d", turnWake, false);
    const after = (await readAudit({ org: ORG, action: WAKE_ACCOUNTING_SKIPPED_AUDIT_ACTION })).length;
    eq(after, before, "🔴 §7/NEGATIVE CONTROL: when every precondition resolves, NO `turn.wake_accounting_skipped` row is written — only the two bail rows above are");

    const solo = await wakeAt(TOKEN, "C_TURN7_SOLO", t(-500));
    markWakeRepliedThisTurn("turn_700e", solo);
    const beforeUn = (await readAudit({ org: ORG, action: UNACCOUNTED_WAKES_AUDIT_ACTION })).length;
    const beforeSkip = (await readAudit({ org: ORG, action: WAKE_ACCOUNTING_SKIPPED_AUDIT_ACTION })).length;
    await auditUnaccountedWakesForTurn(ORG, workspace, surface, TOKEN, "turn_700e", solo, false);
    eq((await readAudit({ org: ORG, action: UNACCOUNTED_WAKES_AUDIT_ACTION })).length, beforeUn, "§7: a fully-accounted turn writes no unaccounted-wakes row");
    eq((await readAudit({ org: ORG, action: WAKE_ACCOUNTING_SKIPPED_AUDIT_ACTION })).length, beforeSkip, "§7: …and no skipped row either — it genuinely ran, it just found nothing");
  });
}

{
  eq(requestsHoldTheWorkerOpen(["budget"]), false, "§8: a lone budget prompt does NOT hold the turn open — nothing ever answers it");
  eq(requestsHoldTheWorkerOpen(["budget", "budget"]), false, "§8: …nor do several of them");

  eq(requestsHoldTheWorkerOpen(["question"]), true, "§8: a real question HOLDS the turn open");
  eq(requestsHoldTheWorkerOpen(["budget", "question"]), true, "🔴 §8: a budget prompt BESIDE a real question still holds — `some` is the right quantifier, and `every` would strand the question");
  eq(requestsHoldTheWorkerOpen(["question", "budget"]), true, "§8: …in either order");
  eq(requestsHoldTheWorkerOpen(["approval"]), true, "§8: an approval holds");

  eq(requestsHoldTheWorkerOpen([]), true, "🔴 §8 FAIL-SOFT: an EMPTY awaiting list holds the turn open — no evidence it finished deciding");
  eq(requestsHoldTheWorkerOpen([undefined]), true, "🔴 §8 FAIL-SOFT: an interaction the view cannot name holds — an unrecognised kind is not a budget prompt");
}

{
  const { markNoReplyThisTurn, peekNoReplyThisTurn } = await import("../agent/channels/no-reply-signal.js");
  const { markReactedThisTurn, consumeReactedThisTurn } = await import("../agent/channels/react-signal.js");
  const TOKEN = unifiedSupervisorToken(DOMAIN, 9);
  await inSession(async () => {
    markNoReplyThisTurn("nothing_to_add");
    markReactedThisTurn();
    ok(peekNoReplyThisTurn() === "nothing_to_add", "§9 (precondition) the previous turn's silence reason is still set");
    await fire("turn.started", hookCtx(TOKEN, "turn_900", undefined));
    eq(peekNoReplyThisTurn(), null, "§9 🔴 turn.started clears a silence reason the previous turn never consumed");
    eq(consumeReactedThisTurn(), false, "§9 🔴 …and the react signal too");
    markNoReplyThisTurn("duplicate");
    eq(peekNoReplyThisTurn(), "duplicate", "§9 NEGATIVE CONTROL: this turn's own silence reason is untouched");
  });
}

{
  const noWindowCtx = (turnId: string): unknown => ({
    channel: { kind: "unified" },
    session: { id: `sess-${turnId}`, turn: { id: turnId }, auth: { current: { attributes: {} } } },
  });
  const skipCount = async (): Promise<number> =>
    (await readAudit({ org: ORG, action: WAKE_ACCOUNTING_SKIPPED_AUDIT_ACTION })).filter((r) => r.detail?.reason === "no-window-token").length;

  const before = await skipCount();
  await inSession(async () => {
    await fire("turn.started", noWindowCtx("turn_1000"));
    await settle(noWindowCtx("turn_1000"), "turn_1000", "failed");
    await fire("session.ended", noWindowCtx("turn_1000"), { outcome: "failed" });
  });
  eq((await skipCount()) - before, 1, "🔴 §10: turn.failed then session.failed for ONE turn writes ONE skip row — the pass ran once");

  const mid = await skipCount();
  await inSession(async () => {
    await fire("turn.started", noWindowCtx("turn_1001"));
    await settle(noWindowCtx("turn_1001"), "turn_1001", "failed");
    await fire("turn.started", noWindowCtx("turn_1002"));
    await settle(noWindowCtx("turn_1002"), "turn_1002", "failed");
  });
  eq((await skipCount()) - mid, 2, "§10 NEGATIVE CONTROL: two turns in one session write one skip row EACH — turn.started clears the guard");
}

console.log(`✓ wake-accounting-turn: ${passed} assertions passed`);

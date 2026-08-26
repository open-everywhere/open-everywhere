import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

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
process.env.OE_ORG = "acme";
const ORG = "acme";
const DOMAIN = "payments";

const { getOperationalStore } = await import("../agent/operational/provider.js");
const { registerUnifiedWakeTarget, mintWakeId } = await import("../agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { markWakeRepliedThisTurn, markWakeDeclinedThisTurn } = await import("../agent/channels/reply-signal.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { WAKE_ACCOUNTING_SKIPPED_AUDIT_ACTION, UNACCOUNTED_WAKES_AUDIT_ACTION } = await import("../agent/channels/wake-accounting.js");
const { auditUnaccountedWakesForTurn, auditLabels } = await import("../agent/channels/unified.js");
const { SESSION_LIMIT_CONTINUATION_TOOL_NAME } = await import("../agent/channels/session-park.js");
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
  return eveContextStorage().run(new FakeSession(), fn);
}

const EVENTS = wakeAccountingTurnHook.events as unknown as Record<string, (e: unknown, c: unknown) => unknown>;
const fire = async (type: string, ctx: unknown, data?: unknown): Promise<void> => {
  const handler = EVENTS[type];
  if (typeof handler !== "function") throw new Error(`wake-accounting-turn does not bind ${type}`);
  await handler({ type, ...(data === undefined ? {} : { data }) }, ctx);
};

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
const questionRequest = { requests: [{ requestId: "req-1", action: { toolName: "ask_question", input: { question: "which repo?" } } }] };
const parkRequest = { requests: [{ requestId: "s-limit:input:900000", action: { toolName: SESSION_LIMIT_CONTINUATION_TOOL_NAME, input: { kind: "input" } } }] };

{
  for (const e of ["turn.started", "input.requested", "authorization.required", "turn.completed", "turn.cancelled", "session.failed"]) {
    ok(typeof EVENTS[e] === "function", `§1: the hook binds ${e}`);
  }
  eq(EVENTS["session.completed"], undefined, "🔴 §1/NEGATIVE CONTROL: session.completed is NOT bound — it never reaches an authored hook on a conversation-mode session");
  eq(EVENTS["message.completed"], undefined, "§1: message.completed is NOT bound here — that call site stays channels/unified.ts's own");
}

{
  const TOKEN = unifiedSupervisorToken(DOMAIN, 2);
  const turnId = "turn_200";
  const ignored = await wakeAt(TOKEN, "C_TURN2", t(-3000), { addressing: "direct-mention" });
  const turnWake = await wakeAt(TOKEN, "C_TURN2", t(-1000));

  await inSession(async () => {
    await fire("turn.started", hookCtx(TOKEN, turnId, turnWake));
    markWakeDeclinedThisTurn(turnId, turnWake);
    await fire("turn.completed", hookCtx(TOKEN, turnId, turnWake));
  });

  const rows = await readAudit({ org: ORG, action: UNACCOUNTED_WAKES_AUDIT_ACTION });
  const row = rows.find((r) => r.detail?.turnId === turnId);
  ok(row !== undefined, "§2: turn.completed alone (no message.completed call) still produces the unaccounted-wakes row");
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
    await fire("turn.completed", hookCtx(TOKEN, turnId, turnWake));
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
    await fire("input.requested", hookCtx(TOKEN, turnId, turnWake), questionRequest);
    await fire("turn.completed", hookCtx(TOKEN, turnId, turnWake));
  });
  const after = (await readAudit({ org: ORG })).length;
  eq(after, before, "🔴 §4/NEGATIVE CONTROL: a turn paused on a real question writes NO row at turn.completed — the pass did not run prematurely");

  await inSession(async () => {
    await fire("turn.started", hookCtx(TOKEN, turnId, turnWake));
    await fire("turn.completed", hookCtx(TOKEN, turnId, turnWake));
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
    await fire("input.requested", hookCtx(TOKEN, turnId, turnWake), parkRequest);
    await fire("turn.completed", hookCtx(TOKEN, turnId, turnWake));
  });
  const rows = (await readAudit({ org: ORG, action: UNACCOUNTED_WAKES_AUDIT_ACTION })).filter((r) => r.detail?.turnId === turnId);
  ok(rows.length === 1, "§5: a session-limit park does NOT hold this hook's gate open — accounting still ran at turn.completed");
}

{
  for (const [label, event] of [["cancelled", "turn.cancelled"] as const, ["failed", "session.failed"] as const]) {
    const TOKEN = unifiedSupervisorToken(DOMAIN, 6);
    const turnId = `turn_600_${label}`;
    await wakeAt(TOKEN, `C_TURN6_${label}`, t(-3000));
    const turnWake = await wakeAt(TOKEN, `C_TURN6_${label}`, t(-1000));
    await inSession(async () => {
      await fire("turn.started", hookCtx(TOKEN, turnId, turnWake));
      await fire(event, hookCtx(TOKEN, turnId, turnWake));
    });
    const rows = (await readAudit({ org: ORG, action: UNACCOUNTED_WAKES_AUDIT_ACTION })).filter((r) => r.detail?.turnId === turnId);
    ok(rows.length === 1, `§6: ${event} runs accounting exactly like turn.completed`);
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
  const park = { action: { toolName: "session_limit_continuation" } };
  const question = { action: { toolName: "ask_question" } };

  eq(requestsHoldTheWorkerOpen([park]), false, "§8: a lone session-limit park does NOT hold the turn open — nothing ever answers it");
  eq(requestsHoldTheWorkerOpen([park, park]), false, "§8: …nor do several of them");

  eq(requestsHoldTheWorkerOpen([question]), true, "§8: a real question HOLDS the turn open");
  eq(requestsHoldTheWorkerOpen([park, question]), true, "🔴 §8: a park BESIDE a real question still holds — `some` is the right quantifier, and `every` would strand the question");
  eq(requestsHoldTheWorkerOpen([question, park]), true, "§8: …in either order");

  eq(requestsHoldTheWorkerOpen([]), true, "🔴 §8 FAIL-SOFT: an EMPTY request list holds the turn open — no evidence it finished deciding");
  eq(requestsHoldTheWorkerOpen(undefined), true, "🔴 §8 FAIL-SOFT: undefined holds");
  eq(requestsHoldTheWorkerOpen(null), true, "🔴 §8 FAIL-SOFT: null holds");
  eq(requestsHoldTheWorkerOpen("not-an-array"), true, "🔴 §8 FAIL-SOFT: a non-array holds");
  eq(requestsHoldTheWorkerOpen([{}]), true, "§8 FAIL-SOFT: a request with no `action` holds — an unrecognised shape is not a park");
  eq(requestsHoldTheWorkerOpen([null]), true, "§8 FAIL-SOFT: a null ENTRY holds");
  eq(requestsHoldTheWorkerOpen([{ action: { toolName: 42 } }]), true, "§8 FAIL-SOFT: a non-string toolName holds");
}

console.log(`✓ wake-accounting-turn: ${passed} assertions passed`);

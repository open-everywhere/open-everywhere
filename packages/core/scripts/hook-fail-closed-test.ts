import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { refuseTurn, HOOK_CANCELLABLE_EDGES, type RefusableContext } from "../agent/hooks/control-refusal.js";
import { EVE_PATCH_PARTS, _resetEvePatchTurnCheckForTest } from "../agent/access/eve-patch-probe.js";
import evePatchGate from "../agent/hooks/eve-patch-gate.js";
import egressHook, { enforceEgress } from "../agent/hooks/egress.js";
import bindingBridgeHook from "../agent/hooks/binding-bridge.js";
import type { AuditInput } from "../agent/audit/audit.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

type Row = { action: string; detail: Record<string, unknown> };

function spyCtx(extra: Record<string, unknown> = {}): RefusableContext & { cancels: number } {
  const ctx = { ...extra, cancels: 0, cancel: (): void => void ctx.cancels++ } as unknown as RefusableContext & { cancels: number };
  return ctx;
}

const handlerOf = (hook: unknown, event: string): ((e: unknown, ctx: unknown) => Promise<void>) =>
  (hook as { events: Record<string, (e: unknown, ctx: unknown) => Promise<void>> }).events[event]!;

{
  const rows: Row[] = [];
  const logs: string[] = [];
  const audit = async (e: AuditInput): Promise<void> => void rows.push({ action: e.action, detail: (e.detail ?? {}) as Record<string, unknown> });
  const log = (m: string): void => void logs.push(m);

  const ctx = spyCtx();
  const outcome = await refuseTurn(ctx, { hook: "probe", phase: "turn.started", reason: "probe-reason", message: "the sentence" }, { audit, log });
  ok(ctx.cancels === 1, "§1: refuseTurn calls ctx.cancel() exactly once");
  ok(outcome.cancelCalled && outcome.audited, "§1: it reports both halves landing");
  ok(rows.length === 1 && rows[0]!.action === "hook.refused", "§1: it writes ONE `hook.refused` row");
  ok(rows[0]!.detail.hook === "probe" && rows[0]!.detail.phase === "turn.started", "§1: the row NAMES the hook and the edge");
  ok(rows[0]!.detail.reason === "probe-reason", "§1: …and carries the stable machine reason an incident query filters on");
  ok(rows[0]!.detail.cancelCalled === true, "§1: …and records that the CALL was made — never that eve honoured it, which no hook can observe");
  ok(logs.some((l) => l.includes("turn CANCEL REQUESTED") && l.includes("the sentence")), "§1: the refusal is LOUD — eve logs nothing for a cancel it honoured, so a silent one is undiagnosable");

  {
    const slow = spyCtx();
    let released = (): void => {};
    const pending = new Promise<void>((r) => {
      released = r;
    });
    const refusal = refuseTurn(slow, { hook: "probe", phase: "session.started", reason: "r", message: "m" }, { audit: () => pending, log });
    await Promise.resolve();
    ok(slow.cancels === 1, "🔴 §1: the cancel lands BEFORE the audit await settles — a hanging store cannot hold the refusal open");
    released();
    await refusal;
  }

  {
    const broken = spyCtx();
    const out = await refuseTurn(
      broken,
      { hook: "probe", phase: "session.started", reason: "r", message: "m" },
      { audit: async () => { throw new Error("store down"); }, log },
    );
    ok(broken.cancels === 1 && out.cancelCalled && !out.audited, "🔴 §1: an audit failure costs the ROW, never the refusal");
    ok(logs.some((l) => l.includes("hook.refused row skipped")), "§1: …and says so");
  }

  {
    const hostile = { cancel: (): void => { throw new Error("no turn here"); } } as unknown as RefusableContext;
    const rows2: Row[] = [];
    const logs2: string[] = [];
    const out = await refuseTurn(
      hostile,
      { hook: "probe", phase: "turn.started", reason: "r", message: "m" },
      { audit: async (e) => void rows2.push({ action: e.action, detail: (e.detail ?? {}) as Record<string, unknown> }), log: (m) => void logs2.push(m) },
    );
    ok(!out.cancelCalled && out.audited, "§1: a cancel that throws is reported as NOT called");
    ok(rows2[0]!.detail.cancelCalled === false, "🔴 §1: …and the row says `cancelCalled: false` rather than claiming a call it did not make");
    ok(logs2.some((l) => l.includes("has NOT made the guarded act impossible")), "§1: …and the log names the consequence");
  }

  {
    const ctx2 = spyCtx();
    const rows3: Row[] = [];
    await refuseTurn(
      ctx2,
      { hook: "probe", phase: "turn.started", reason: "real-reason", message: "m", detail: { reason: "forged", cancelCalled: false, hook: "forged" } },
      { audit: async (e) => void rows3.push({ action: e.action, detail: (e.detail ?? {}) as Record<string, unknown> }), log },
    );
    ok(rows3[0]!.detail.reason === "real-reason", "🔴 §1: a caller's detail cannot overwrite the measured `reason`");
    ok(rows3[0]!.detail.cancelCalled === true, "🔴 §1: …nor the measured `cancelCalled`");
    ok(rows3[0]!.detail.hook === "probe", "🔴 §1: …nor the hook's own name");
  }

  ok(
    HOOK_CANCELLABLE_EDGES.length === 3 && HOOK_CANCELLABLE_EDGES.every((e) => ["session.started", "turn.started", "step.started"].includes(e)),
    "§1: HOOK_CANCELLABLE_EDGES is exactly the three edges that cancel BEFORE the step's model call — a tool event can never be a gate",
  );
}

{
  const bag = globalThis as Record<string, unknown>;
  const saved = new Map(EVE_PATCH_PARTS.map((p) => [p.marker, bag[p.marker]]));
  const restore = (): void => {
    for (const [k, v] of saved) {
      if (v === undefined) delete bag[k];
      else bag[k] = v;
    }
  };
  const turnStarted = handlerOf(evePatchGate, "turn.started");
  try {
    for (const p of EVE_PATCH_PARTS) bag[p.marker] = true;
    _resetEvePatchTurnCheckForTest();
    const healthy = spyCtx();
    await turnStarted({}, healthy);
    ok(healthy.cancels === 0, "🔴 §2 negative control: a patched eve is NOT cancelled — the gate lets correct work through");

    for (const part of EVE_PATCH_PARTS) {
      for (const p of EVE_PATCH_PARTS) bag[p.marker] = true;
      delete bag[part.marker];
      _resetEvePatchTurnCheckForTest();
      const ctx = spyCtx();
      let threw = false;
      try {
        await turnStarted({}, ctx);
      } catch {
        threw = true;
      }
      ok(!threw, `§2 part ${part.part}: the gate does NOT throw — eve 0.68+ swallows a hook throw, so a throw would refuse nothing`);
      ok(ctx.cancels === 1, `🔴 §2 part ${part.part}: a missing ${part.marker} CANCELS the turn at turn.started`);
    }

    for (const p of EVE_PATCH_PARTS) bag[p.marker] = true;
    delete bag[EVE_PATCH_PARTS[0]!.marker];
    _resetEvePatchTurnCheckForTest();
    const first = spyCtx();
    const second = spyCtx();
    await turnStarted({}, first);
    await turnStarted({}, second);
    ok(first.cancels === 1 && second.cancels === 1, "🔴 §2: a FAILURE is never memoised as a pass — the second turn is refused too");
  } finally {
    restore();
    _resetEvePatchTurnCheckForTest();
  }
}

{
  const SCOPE = { org: "o", platform: "p", workspace: "w", surface: "s", principalId: "P" };
  function rig(opts: { failApply?: boolean } = {}) {
    const applied: unknown[] = [];
    const rows: Row[] = [];
    let fingerprint: string | undefined;
    let connectors: string | undefined;
    let failApply = opts.failApply ?? false;
    let secret = "OLD";
    let widened = false;
    let shape: unknown;
    const deps = {
      resolve: () => ({
        scopeKey: "p/w/s",
        connectors: [] as string[],
        connectorContentOrigin: {},
        reachableHosts: [] as unknown[],
        ownAccountEgressRefusals: [] as unknown[],
      }),
      compile: async () => ({
        allow: {
          "api.acme.test": [{ transform: [{ headers: { authorization: `Bearer ${secret}` } }] }],
          ...(widened ? { "new.acme.test": [] } : {}),
        },
      }),
      apply: async (policy: unknown) => {
        if (failApply) throw new Error("sandbox.update blipped");
        applied.push(policy);
      },
      lastApplied: () => fingerprint,
      rememberApplied: (f: string) => {
        fingerprint = f;
      },
      lastEnforcedShape: () => shape,
      rememberEnforcedShape: (v: unknown) => {
        shape = v;
      },
      lastConnectors: () => connectors,
      rememberConnectors: (c: string) => {
        connectors = c;
      },
      scope: () => SCOPE,
      audit: async (e: AuditInput) => void rows.push({ action: e.action, detail: (e.detail ?? {}) as Record<string, unknown> }),
      stamp: () => {},
    };
    return {
      deps,
      applied,
      rows,
      breakApply: (v: boolean) => { failApply = v; },
      rotate: (v: string) => { secret = v; },
      widen: () => { widened = true; },
      appliedFingerprint: () => fingerprint,
    };
  }

  {
    const r = rig({ failApply: true });
    const res = await enforceEgress("session.started", r.deps as never);
    ok(res.abortError !== undefined, "§3a: a failed apply at session.started aborts (unchanged posture)");
    ok(res.abortReason === "enforce-failed", "§3a: …and names the reason `enforce-failed`, so the refusal's row carries it unparsed");
  }

  {
    const r = rig({ failApply: true });
    const start = await enforceEgress("session.started", r.deps as never);
    ok(start.abortReason === "enforce-failed" && r.appliedFingerprint() === undefined, "§3b: the failed session start records NO fingerprint, so nothing is in force");
    const turn = await enforceEgress("turn.started", r.deps as never);
    ok(turn.abortError !== undefined, "🔴 §3b: the TURN edge refuses too when no policy is in force — the P0, one turn later");
    ok(turn.abortReason === "unenforced-no-policy-in-force", "🔴 §3b: …under its own reason, kept apart from ordinary staleness");
  }

  {
    const r = rig();
    await enforceEgress("session.started", r.deps as never);
    ok(r.appliedFingerprint() !== undefined, "§3c: the session start applied, so a policy IS in force");
    r.breakApply(true);
    r.widen();
    const turn = await enforceEgress("turn.started", r.deps as never);
    ok(turn.enforceError !== undefined, "§3c: a failed re-apply over a live policy is reported");
    ok(turn.abortError === undefined && turn.abortReason === undefined, "🔴 §3c negative control: …and does NOT refuse — the previous policy stands and the new one covers it, so this is staleness, not an unfirewalled turn");
  }

  {
    const r = rig();
    await enforceEgress("session.started", r.deps as never);
    r.breakApply(true);
    r.rotate("ROTATED");
    const turn = await enforceEgress("turn.started", r.deps as never);
    ok(turn.abortError !== undefined, "🔴 §3c.2: a failed re-apply whose new policy does NOT cover the one in force refuses the turn");
    ok(turn.abortReason === "reapply-narrows-policy-in-force", "🔴 §3c.2: …under its own reason, kept apart from the no-policy-in-force arm");
  }

  {
    const r = rig();
    const start = await enforceEgress("session.started", r.deps as never);
    r.rotate("ROTATED");
    const turn = await enforceEgress("turn.started", r.deps as never);
    ok(start.abortError === undefined && turn.abortError === undefined, "§3d negative control: a healthy session aborts on neither edge");
    ok(start.enforced === true && turn.enforced === true, "§3d negative control: …and both passes really enforced, so the rows above are not vacuous");
    ok(r.applied.length === 2, "§3d negative control: …having reached the firewall twice");
  }
}

{
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
  const g = globalThis as Record<PropertyKey, unknown>;
  const storageKey = Symbol.for("eve.context-storage");
  g[storageKey] ??= new AsyncLocalStorage();
  const storage = g[storageKey] as AsyncLocalStorage<unknown>;
  const inSession = <T>(fn: () => T | Promise<T>): Promise<T> => Promise.resolve(storage.run(new FakeSession(), fn));

  for (const edge of ["session.started", "turn.started"] as const) {
    await inSession(async () => {
      const ctx = spyCtx({ session: { id: "s-unit" } });
      let threw: string | undefined;
      try {
        await handlerOf(egressHook, edge)({}, ctx);
      } catch (err) {
        threw = err instanceof Error ? err.message : String(err);
      }
      ok(threw === undefined, `🔴 §4a ${edge}: the egress hook does NOT throw (threw: ${threw ?? "nothing"}) — a throw is logged and swallowed by eve 0.68+, which is the P0`);
      ok(ctx.cancels === 1, `🔴 §4a ${edge}: the egress hook CANCELS the turn when the firewall cannot be applied — the turn never runs on eve's allow-all default`);
    });
  }

  {
    const { registerSandboxFirewall } = await import("../agent/sandbox/network-policy.js");
    const applied: unknown[] = [];
    registerSandboxFirewall({
      carries: "full",
      environment: {} as never,
    });
    for (const edge of ["session.started", "turn.started"] as const) {
      await inSession(async () => {
        const ctx = spyCtx({
          session: { id: "s-unit-ok" },
          getSandbox: async () => ({ setNetworkPolicy: async (p: unknown) => void applied.push(p) }),
        });
        let threw: string | undefined;
        try {
          await handlerOf(egressHook, edge)({}, ctx);
        } catch (err) {
          threw = err instanceof Error ? err.message : String(err);
        }
        ok(threw === undefined, `§4b ${edge}: the healthy edge does not throw (threw: ${threw ?? "nothing"})`);
        ok(ctx.cancels === 0, `🔴 §4b ${edge} NEGATIVE CONTROL: an apply that SUCCEEDS is NOT cancelled — without this row §4a would also pass on a hook that cancels every turn`);
      });
    }
    ok(applied.length > 0, "§4b: …and the firewall really was reached, so the rows above are not vacuous");
  }
}

{
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const distOf = (rel: string): string => {
    const root = req.resolve("eve/package.json").replace(/package\.json$/, "");
    const path = `${root}dist/src/${rel}`;
    return readFileSync(path, "utf8");
  };

  const lifecycle = distOf("context/hook-lifecycle.js");
  ok(/await a\.handler\(/.test(lifecycle), "🔴 §5a: eve still awaits the authored handler in `dispatchStreamEventHooks` — if this moved, re-read the whole file before trusting any comment in this ticket");
  const caught = lifecycle.slice(lifecycle.indexOf("await a.handler("));
  ok(
    /catch\([^)]*\)\{logError\(log,`stream event hook failed`/.test(caught),
    "🔴 §5a: eve STILL swallows an authored hook's throw — it logs `stream event hook failed` and does not rethrow. If this row ever reds, a throw may stop a turn again and `refuseTurn`'s whole premise needs re-deriving (it would NOT be a reason to go back to throwing without measuring)",
  );

  const handler = distOf("execution/session/turn-event-handler.js");
  const start = handler.indexOf("const HOOK_CANCELLABLE_EVENTS=");
  ok(start !== -1, "🔴 §5b: eve still declares HOOK_CANCELLABLE_EVENTS — a rename means the cancel contract moved");
  const table = handler.slice(start, handler.indexOf("};", start) + 1);
  for (const edge of HOOK_CANCELLABLE_EDGES) {
    ok(
      new RegExp(`"${edge}":!0`).test(table),
      `🔴 §5b: eve still answers TRUE for "${edge}", so a hook may cancel there. A false here means this product gates on an edge eve ignores, and eve only warns — the refusal would be silent`,
    );
  }
  ok(/"turn\.waiting":!1/.test(table), "§5b negative control: eve answers FALSE for `turn.waiting`, so the table really discriminates");
  ok(/"task\.settled":!1/.test(table), "§5b negative control: …and for `task.settled`");
}

{
  for (const edge of ["session.started", "turn.started"] as const) {
    const rows: Row[] = [];
    const ctx = {
      cancels: 0,
      cancel(): void {
        ctx.cancels++;
      },
      session: { id: "bb-spine", auth: { current: { attributes: {} } } },
      get channel(): never {
        throw new Error("spine read failed: channel unreadable");
      },
    } as unknown as RefusableContext & { cancels: number };
    let threw: string | undefined;
    try {
      await handlerOf(bindingBridgeHook, edge)({}, ctx);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    ok(threw === undefined, `🔴 §6a ${edge}: binding-bridge does NOT let a spine failure escape (threw: ${threw ?? "nothing"}) — eve would log and drop it, and the lost-binding guard would never run`);
    ok((ctx as unknown as { cancels: number }).cancels === 1, `🔴 §6a ${edge}: …it CANCELS instead, so an unreadable context cannot put a child on whatever surface the standing seat holds`);
    void rows;
  }

  for (const edge of ["session.started", "turn.started"] as const) {
    const ctx = spyCtx({ session: { id: "eg-no-als" } });
    let threw: string | undefined;
    try {
      await handlerOf(egressHook, edge)({}, ctx);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    ok(threw === undefined, `🔴 §6b ${edge}: egress does NOT let a spine failure escape (threw: ${threw ?? "nothing"})`);
    ok(ctx.cancels === 1, `🔴 §6b ${edge}: …it CANCELS, so a turn whose firewall could not even be computed does not run`);
  }
}

console.log(`\n✓ hook-fail-closed: ${n} assertions passed (refusal helper, eve-patch gate, egress abort reasons incl. the cross-turn arm, both egress hook edges with their negative control, eve's own dispatch bytes, and no escape from either handler's spine)\n`);

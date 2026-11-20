import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-invoker-posture-")), "ops.sqlite3");

import {
  INVOKER_POSTURE_ATTR,
  UNTRUSTED_REMOTE_WITHHELD_TOOLS,
  narrowerInvokerPosture,
  resolveInvokerPosture,
  restrictToolsetForInvokerPosture,
  withheldForInvokerPosture,
  type InvokerPosture,
} from "../agent/access/invoker-posture.js";
import { currentInvokerPosture, setInvokerPosture } from "../agent/access/invoker-posture-state.js";
import { fullKit, WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS } from "../agent/access/window-gate-manifest.js";
import { seatCutToolset } from "../agent/access/seat-cut.js";
import { nativeAgentAllowedNow, setNativeDelegationSeat } from "../agent/access/native-delegation-state.js";
import { currentLeanSeatPosture } from "../agent/access/lean-seat-state.js";
import { allowedOnLeanSeat } from "../agent/access/lean-seat.js";
import { webhookFireAttributes, WEBHOOK_MARKER_ATTR } from "../agent/routines/fire-auth.js";
import { FIRE_UNATTENDED_ATTR, windowGrainOf, type BindableContext } from "../agent/identity/binding.js";
import { ROUTINE_MARKER } from "../agent/routines/routine.js";
import { OE_GRAIN_ATTR } from "../agent/channels/unified-window.js";
import { formatWindowToken, taskWindowId, threadSeatWindowId, workWindowId } from "../agent/channels/window-key.js";
import { WORKER_WITHHELD_TOOLS } from "../agent/access/worker-seat.js";
import { currentWorkerWake } from "../agent/access/worker-seat-state.js";
import { v27Hooks } from "./_hook-view.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const base = { webhookFire: false, eventSubFire: false, unattendedFire: false, manualFire: false };

ok(resolveInvokerPosture({ ...base }) === "interactive", "a plain human delivery is `interactive` — today's behaviour, unchanged");
ok(resolveInvokerPosture({ ...base, webhookFire: true, unattendedFire: true }) === "untrusted-remote", "a WEBHOOK fire is `untrusted-remote`");
ok(resolveInvokerPosture({ ...base, eventSubFire: true, unattendedFire: true }) === "untrusted-remote", "an EVENT-SUBSCRIPTION fire is `untrusted-remote`");
ok(resolveInvokerPosture({ ...base, unattendedFire: true }) === "unattended-fire", "a clock/watch/job fire is `unattended-fire`");
ok(resolveInvokerPosture({ ...base, unattendedFire: true, manualFire: true }) === "attended-fire", "a MANUAL fire is `attended-fire` — OPE-147's marker reaching a posture decision for the first time");

ok(
  resolveInvokerPosture({ ...base, webhookFire: true, unattendedFire: true, manualFire: true }) === "untrusted-remote",
  "REMOTE ORIGIN WINS: a webhook fire is not un-remoted by any other marker",
);

ok(narrowerInvokerPosture("interactive", "untrusted-remote") === "untrusted-remote", "narrowerInvokerPosture takes the NARROWER of two classes");
ok(
  resolveInvokerPosture({ ...base, webhookFire: true, unattendedFire: true, stamped: "interactive" }) === "untrusted-remote",
  "🔴 a forged/stale WIDE stamp cannot widen a delivery whose own markers say remote — the stamp is belt, never braces",
);
ok(
  resolveInvokerPosture({ ...base, stamped: "untrusted-remote" }) === "untrusted-remote",
  "…while a NARROW stamp does carry down a delegation edge (the event-sub case, whose raw marker cannot survive the hop)",
);
ok(resolveInvokerPosture({ ...base, stamped: "nonsense-value" }) === "interactive", "an unparseable stamp is a no-op, not a crash and not a narrowing");
ok(resolveInvokerPosture({ ...base, stamped: undefined }) === "interactive", "an absent stamp is a no-op");

const manifestWideHands = new Set(
  Object.entries(WINDOW_GATED_TOOLS)
    .filter(([, grains]) => grains === fullKit())
    .map(([name]) => name),
);
ok(manifestWideHands.size === UNTRUSTED_REMOTE_WITHHELD_TOOLS.size, `the withheld set is the same SIZE as the manifest's wide-hands rows (${manifestWideHands.size})`);
ok([...manifestWideHands].every((k) => UNTRUSTED_REMOTE_WITHHELD_TOOLS.has(k)), "every wide-hands manifest row is withheld from an untrusted-remote run");
ok([...UNTRUSTED_REMOTE_WITHHELD_TOOLS].every((k) => manifestWideHands.has(k)), "…and nothing is withheld that the manifest does not call wide-hands");
ok(UNTRUSTED_REMOTE_WITHHELD_TOOLS.has("bash"), "`bash` is in the withheld set — the headline name");
ok(withheldForInvokerPosture("interactive").size === 0 && withheldForInvokerPosture("attended-fire").size === 0, "interactive and attended-fire withhold NOTHING — byte-identical to today");
ok(withheldForInvokerPosture("unattended-fire").size === 0, "unattended-fire withholds NOTHING today (a clock fire's cut is a different question — see the header)");
ok(withheldForInvokerPosture("untrusted-remote", true).size === 0, "⭐ `untrusted-remote` withholds NOTHING from a DELEGATED WORKER — wide hands are reached by delegating, for every invoker class alike");
ok(withheldForInvokerPosture("untrusted-remote") === withheldForInvokerPosture("untrusted-remote", false), "…and the parameter DEFAULTS to the withholding answer, so a caller that does not know is treated as the window");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};
function inSession<T>(fn: () => T): T {
  return contextStorage.run(new ContextContainer(), fn);
}

const leanSeatHook = (await import("../agent/hooks/lean-seat.js")).default as unknown as {
  events: Record<string, (event: unknown, ctx: unknown) => unknown>;
};
ok(typeof leanSeatHook.events["turn.started"] === "function", "the lean-seat hook registers a turn.started handler — the classification is WIRED, not just written");

function makeToolset(): Record<string, { description: string; execute: () => unknown }> {
  const names = [...Object.keys(WINDOW_GATED_TOOLS), ...WINDOW_UNGATED_TOOLS, "ask_question", "todo", "eve__reply"];
  const out: Record<string, { description: string; execute: () => unknown }> = {};
  for (const name of names) out[name] = { description: `${name} tool`, execute: () => ({ ok: true }) };
  return out;
}

async function kitForDelivery(ctx: unknown): Promise<{ toolset: Record<string, unknown>; posture: InvokerPosture; lean: string; worker: boolean }> {
  return await inSession(async () => {
    setNativeDelegationSeat("allow");
    await leanSeatHook.events["turn.started"]!({}, ctx);
    const posture = currentInvokerPosture();
    const lean = currentLeanSeatPosture();
    const worker = currentWorkerWake();
    const toolset = makeToolset() as unknown as Record<string, unknown>;
    seatCutToolset(toolset);
    return { toolset, posture, lean, worker };
  });
}

const STANDING_TOKEN = `unified:${formatWindowToken({ domain: "acme", windowId: "acme", generation: 3 })}`;

const deliveryCtx = (
  attributes: Record<string, unknown>,
  principal?: { principalId?: string; principalType?: string; authenticator?: string },
  token: string = STANDING_TOKEN,
) => ({
  channel: { kind: "slack", continuationToken: token },
  session: { id: `sess-${Math.random().toString(36).slice(2)}`, auth: { current: { attributes, ...(principal ?? {}) } } },
});

const grainFixtureCheck = (ctx: unknown, expected: string, label: string) =>
  ok(windowGrainOf(ctx as BindableContext) === expected, `fixture provenance: ${label} really resolves grain \`${expected}\``);

const webhookBag = webhookFireAttributes("hook-abc", "T1", "C1", false, false) as Record<string, unknown>;
ok(webhookBag[WEBHOOK_MARKER_ATTR] === "hook-abc", "fixture provenance: the real webhookFireAttributes bag carries the webhook marker");
ok(webhookBag[FIRE_UNATTENDED_ATTR] === "true", "fixture provenance: …and the unconditional unattended-origin stamp");

{
  const ctx = deliveryCtx(webhookBag, { authenticator: "webhook", principalId: "webhook:hook-abc", principalType: "service" });
  ok(windowGrainOf(ctx as BindableContext) !== "task", "fixture provenance: a fire's OWN delivery never resolves grain `task` — the worker exemption cannot reach the window it is scoped away from");
  const { toolset, posture, worker } = await kitForDelivery(ctx);
  ok(posture === "untrusted-remote", "a REAL webhook fire delivery classifies `untrusted-remote` through the real hook");
  ok(worker === false, "…and the fire's own WINDOW is NOT a delegated worker — the per-wake bit is `false`");
  ok(!("bash" in toolset), "⭐ THE PROPERTY: a webhook fire's assembled toolset has NO `bash` — asserted at the model-call seam that decides");
  ok([...UNTRUSTED_REMOTE_WITHHELD_TOOLS].every((k) => !(k in toolset)), "…and no other wide-hands tool either (checkout_repo, write_file, web_fetch, open_pull_request, create_skill, …)");
  ok("reply" in toolset && "eve__reply" in toolset, "…while the fire keeps the verbs its job consists of — this is a bounded subtraction, not a roster swap");
  ok("remember" in toolset || "read_channel" in toolset, "…including the reads/memory a fire is FOR (it was not collapsed onto the lean conversational roster)");
}

const childBag = (parent: Record<string, unknown>, stamp?: InvokerPosture, grain: "task" | "thread" = "task"): Record<string, unknown> => ({
  ...parent,
  [OE_GRAIN_ATTR]: grain,
  ...(stamp !== undefined ? { [INVOKER_POSTURE_ATTR]: stamp } : {}),
});
const TASK_TOKEN = `unified:${formatWindowToken({ domain: "acme", windowId: taskWindowId("slack/C1", "1720.5", "n1"), generation: 3 })}`;
const THREAD_SEAT_TOKEN = `unified:${formatWindowToken({ domain: "acme", windowId: threadSeatWindowId("slack/C1", "1720.5"), generation: 3 })}`;

{
  const ctx = deliveryCtx(childBag(webhookBag, "untrusted-remote"), undefined, TASK_TOKEN);
  grainFixtureCheck(ctx, "task", "the dispatchTaskWindow child (task stamp + task token)");
  const { toolset, posture, worker } = await kitForDelivery(ctx);
  ok(posture === "untrusted-remote", "a webhook fire's DELEGATED CHILD still CLASSIFIES `untrusted-remote` — the class survives the hop; what changes is what it withholds");
  ok("bash" in toolset, "⭐⭐ THE SECOND HALF: the `task`-grain child of a webhook fire DOES hold `bash` — a fire reaches a shell by delegating, exactly like every other seat");
  ok(
    [...UNTRUSTED_REMOTE_WITHHELD_TOOLS].every((k) => k in toolset),
    "…and the WHOLE wide-hands family, not just bash (write_file, web_fetch, checkout_repo, open_pull_request, create_skill, …) — the worker kit is the same one any seat's worker gets",
  );
  ok(worker === true, "…and the wake really WAS classified a delegated worker (the per-wake bit is `true`) — which is what makes the wide-hands exemption above meaningful");
  ok(
    !WORKER_WITHHELD_TOOLS.has("ask_question") && "ask_question" in toolset,
    "…and the worker holds `ask_question` (OPE-565 took it out of the withheld set and built the answer's return leg)",
  );
  ok(
    !("no_reply" in toolset) && !("stand_down" in toolset),
    "…and the worker holds NEITHER no_reply NOR stand_down (OPE-877) — the two seat-conversational verbs leave at this same seam, under the invoker-posture cut, not instead of it",
  );
}

{
  const ctx = deliveryCtx(childBag(webhookBag), undefined, TASK_TOKEN);
  const { toolset, posture } = await kitForDelivery(ctx);
  ok(posture === "untrusted-remote", "…and it classifies `untrusted-remote` with NO stamp at all — the webhook marker rides the attributes bag on its own");
  ok("bash" in toolset, "…and holds `bash` regardless, because the exemption keys on the `task` GRAIN, never on the stamp");
}

{
  const eventSubChild = childBag({ [FIRE_UNATTENDED_ATTR]: "true" }, "untrusted-remote");
  const { toolset, posture } = await kitForDelivery(deliveryCtx(eventSubChild, undefined, TASK_TOKEN));
  ok(posture === "untrusted-remote", "an EVENT-SUB fire's child classifies `untrusted-remote` via the stamp — the class whose raw marker cannot survive the hop");
  ok("bash" in toolset, "…and it too holds `bash`: a worker is a worker whichever remote class caused the run");
}

{
  const ctx = deliveryCtx(childBag(webhookBag, "untrusted-remote", "thread"), undefined, THREAD_SEAT_TOKEN);
  grainFixtureCheck(ctx, "thread", "the spawn_thread_session child (thread stamp + thread-seat token)");
  const { toolset, posture } = await kitForDelivery(ctx);
  ok(posture === "untrusted-remote", "a webhook fire's THREAD-SEAT child classifies `untrusted-remote`");
  ok(!("bash" in toolset), "⭐ …and holds NO `bash`: only a `task`-grain WORKER is exempt, so a non-worker descendant stays narrowed");
}

{
  const { toolset, posture, lean } = await kitForDelivery(
    deliveryCtx({ channel_id: "C1" }, { principalId: "U1", principalType: "slack-user" }),
  );
  ok(posture === "interactive", "a HUMAN delivery into a parked fire session is `interactive` — it does not inherit the fire that opened the session");
  ok(lean === "lean", "…and still comes out LEAN, exactly as before this cut");
  ok(!("bash" in toolset), "…so it holds no `bash` either — but for the LEAN roster's reason, not this one");
  ok("reply" in toolset && "work" in toolset && !("agent" in toolset), "…and keeps the conversational roster of a forwarding standing seat (`work`, no `agent`)");
}

{
  const clockBag = { [FIRE_UNATTENDED_ATTR]: "true", [ROUTINE_MARKER.id]: "r1", [ROUTINE_MARKER.surface]: "slack/T1", [ROUTINE_MARKER.org]: "default" };
  const { toolset, posture } = await kitForDelivery(deliveryCtx(clockBag));
  ok(posture === "unattended-fire", "a CLOCK fire classifies `unattended-fire`");
  ok("bash" in toolset, "…and is byte-identical to today (the clock cut is a separate question with its own blast radius — see the module header)");
}

{
  const manualBag = { [FIRE_UNATTENDED_ATTR]: "true", [ROUTINE_MARKER.id]: "r1", [ROUTINE_MARKER.surface]: "slack/T1", [ROUTINE_MARKER.org]: "default", [ROUTINE_MARKER.manual]: "true" };
  const { posture } = await kitForDelivery(deliveryCtx(manualBag));
  ok(posture === "attended-fire", "a MANUAL fire (`run_routine_now`) classifies `attended-fire` — a human pressed the button");
}

{
  const hostile = {
    channel: { kind: "slack", continuationToken: "unified:oe-dom:acme:oe-sup:g3" },
    session: {
      id: "sess-hostile",
      get auth(): never {
        throw new Error("unreadable auth");
      },
    },
  };
  const posture = await inSession(async () => {
    setNativeDelegationSeat("allow");
    await leanSeatHook.events["turn.started"]!({}, hostile);
    return currentInvokerPosture();
  });
  ok(posture === "untrusted-remote", "🔴 an UNREADABLE delivery lands on the NARROWEST class — a posture decision fails narrow (the OPE-421 inversion, removed)");
}

inSession(() => {
  setInvokerPosture("interactive");
  void v27Hooks(leanSeatHook).turnSettled("completed")({});
  ok(currentInvokerPosture() === "untrusted-remote", "a completed turn.settled drops the posture back to the NARROWEST class, never to a stale wide one");
  setInvokerPosture("interactive");
  void v27Hooks(leanSeatHook).turnSettled("failed")({});
  ok(currentInvokerPosture() === "untrusted-remote", "a failed turn.settled does the same");
});

ok(currentInvokerPosture() === "interactive", "outside an eve context the posture read fails soft to `interactive` — no session, no invoker (see the state module's header)");

{
  const toolset = makeToolset() as unknown as Record<string, unknown>;
  const before = { ...toolset };
  const removed = restrictToolsetForInvokerPosture(toolset, "untrusted-remote");
  ok(removed.join(",") === [...removed].sort().join(","), "the removed list is sorted");
  ok(removed.every((k) => !(k in toolset)), "every reported name really is gone");
  ok(Object.keys(toolset).every((k) => toolset[k] === before[k]), "surviving tool OBJECTS keep their identity — eve keys approvals in a WeakMap on them");
  ok(restrictToolsetForInvokerPosture(makeToolset() as unknown as Record<string, unknown>, "interactive").length === 0, "an interactive run's toolset is not touched at all");
  const workerSet = makeToolset() as unknown as Record<string, unknown>;
  const workerBefore = Object.keys(workerSet).length;
  ok(
    restrictToolsetForInvokerPosture(workerSet, "untrusted-remote", true).length === 0 && Object.keys(workerSet).length === workerBefore,
    "…and an untrusted-remote WORKER's toolset is not touched at all either — the exemption is a genuine no-op, not a re-add",
  );
}

{
  const { currentJobWakePosture, isJobSession, markJobSession, setJobWakeEscalated } = await import("../agent/access/job-session-state.js");
  const { currentLeanSeatPosture: leanPosture, setLeanSeatWake } = await import("../agent/access/lean-seat-state.js");
  const { currentHaltStamp, stampHalted } = await import("../agent/access/halt-state.js");
  const { setInvokerPosture: setPosture } = await import("../agent/access/invoker-posture-state.js");
  const { eveContextActive, WakeSlotWriteError } = await import("../agent/access/wake-slot.js");

  ok(eveContextActive() === false, "OPE-2157: the probe reads eve's own store — no context is active here");
  ok(currentInvokerPosture() === "interactive", "OPE-2157: a context-less read keeps `interactive` (no delivery ⇒ no invoker)");
  ok(currentJobWakePosture() === "unrestricted" && isJobSession() === false, "OPE-2157: a context-less read keeps `unrestricted`");
  ok(currentLeanSeatPosture() === "full", "OPE-2157: a context-less read keeps `full`");
  ok(currentHaltStamp() === null, "OPE-2157: a context-less read keeps `null` (no halt read has run)");
  let contextlessThrew = false;
  try {
    setPosture("untrusted-remote");
    markJobSession();
    setJobWakeEscalated(false);
    setLeanSeatWake(false);
    stampHalted(false);
  } catch {
    contextlessThrew = true;
  }
  ok(!contextlessThrew, "OPE-2157: a context-less write is a no-op, never a throw");
  inSession(() => {
    ok(eveContextActive() === true, "OPE-2157: inside a live context the probe answers true");
  });
  {
    // eve 1.x can hold a live store with no context (a scope value set outside any eve context). The
    // probe counts it as a context, so an unreadable slot there takes the RESTRICTING answer.
    const storage = (globalThis as Record<symbol, unknown>)[Symbol.for("eve.context-storage")] as { run<T>(store: unknown, fn: () => T): T };
    storage.run({ context: undefined, values: new Map<unknown, unknown>() }, () => {
      ok(eveContextActive() === true, "a live eve store with no context still counts as a context for the probe");
      ok(currentHaltStamp() === true, "…so an unreadable halt slot there reads as HALTED (restricting), never as the context-less null");
    });
  }

  const broken = {
    get: () => undefined,
    has: () => false,
    require: () => {
      throw new Error("slot store unavailable");
    },
    ensure: () => {
      throw new Error("slot store unavailable");
    },
    set: () => {
      throw new Error("slot store unavailable");
    },
  };
  contextStorage.run(broken, () => {
    ok(currentInvokerPosture() === "untrusted-remote", "OPE-2157: 🔴 a failed invoker-posture read INSIDE a context answers `untrusted-remote`, not the wide-hands `interactive`");
    ok(currentJobWakePosture() === "restricted", "OPE-2157: 🔴 a failed job-session read inside a context answers `restricted`, not `unrestricted`");
    ok(isJobSession() === true, "OPE-2157: …and `isJobSession` answers true, the restricting value");
    ok(currentLeanSeatPosture() === "lean", "OPE-2157: a failed lean-seat read inside a context answers `lean`, not `full`");
    ok(currentHaltStamp() === true, "OPE-2157: 🔴 a failed halt read inside a context answers HALTED, not `null`");

    const writes: [string, () => void][] = [
      ["setInvokerPosture", () => setPosture("untrusted-remote")],
      ["markJobSession", () => markJobSession()],
      ["setJobWakeEscalated", () => setJobWakeEscalated(false)],
      ["setLeanSeatWake", () => setLeanSeatWake(false)],
      ["stampHalted", () => stampHalted(true)],
    ];
    for (const [name, write] of writes) {
      let thrown: unknown;
      try {
        write();
      } catch (err) {
        thrown = err;
      }
      ok(thrown instanceof WakeSlotWriteError, `OPE-2157: 🔴 a failed ${name} write inside a context THROWS WakeSlotWriteError — the clear-first argument must not rest on a write the code tolerates losing`);
    }

  });

  const Base = ContextContainer as unknown as new () => { ensure(key: { name: string }, init: () => unknown): unknown };
  function brokenOnly(slotName: string): unknown {
    return new (class extends Base {
      override ensure(key: { name: string }, init: () => unknown): unknown {
        if (key.name === slotName) throw new Error(`slot ${slotName} unavailable`);
        return super.ensure(key, init);
      }
    })();
  }
  const projectUnder = (store: unknown): Record<string, unknown> =>
    contextStorage.run(store, () => {
      setNativeDelegationSeat("allow");
      const toolset = makeToolset() as unknown as Record<string, unknown>;
      toolset["web_fetch"] = { description: "web_fetch", execute: () => ({ ok: true }) };
      seatCutToolset(toolset);
      return toolset;
    });
  const control = projectUnder(new ContextContainer());
  ok(control["bash"] !== undefined && control["web_fetch"] !== undefined, "OPE-2157 negative control: with healthy slots the interactive default keeps `bash` and `web_fetch`");
  const postureBroken = projectUnder(brokenOnly("open-everywhere.invoker-posture"));
  ok(postureBroken["bash"] === undefined, "OPE-2157: 🔴 a failed invoker-posture read ALONE withholds `bash` at the projection — the untrusted-remote cut lands");
  const haltBroken = projectUnder(brokenOnly("open-everywhere.halted"));
  ok(haltBroken["web_fetch"] === undefined && haltBroken["bash"] !== undefined, "OPE-2157: 🔴 a failed halt read ALONE withholds `web_fetch` (and nothing else changes) — the halt name the seat cut reaches on eve 1.x");
}

{
  const agentVerdictFor = async (ctx: unknown): Promise<{ allowed: boolean; lean: string; toolset: Record<string, unknown> }> =>
    await inSession(async () => {
      setNativeDelegationSeat("allow");
      await leanSeatHook.events["turn.started"]!({}, ctx);
      const allowed = nativeAgentAllowedNow();
      const lean = currentLeanSeatPosture();
      const toolset = { ...makeToolset(), agent: { description: "agent tool", execute: () => ({ ok: true }) } } as unknown as Record<string, unknown>;
      seatCutToolset(toolset);
      return { allowed, lean, toolset };
    });
  const W_TOKEN = `unified:${formatWindowToken({ domain: "acme", windowId: workWindowId("acme"), generation: 3 })}`;
  const w = await agentVerdictFor(deliveryCtx({}, undefined, W_TOKEN));
  ok(w.allowed && "agent" in w.toolset, "OPE-2351: the WORK SESSION holds `agent` — the one wake that runs a job (positive control)");
  const seat = await agentVerdictFor(deliveryCtx({}, undefined, STANDING_TOKEN));
  ok(!seat.allowed && !("agent" in seat.toolset), "OPE-2351: a domain seat holds no `agent` — it forwards with `work`");
  const tokenless = { channel: { kind: "slack" }, session: { id: "sess-tokenless", auth: { current: { attributes: { [OE_GRAIN_ATTR]: "standing" } } } } };
  grainFixtureCheck(tokenless, "standing", "the token-less seat (a `standing` stamp, no token)");
  const bare = await agentVerdictFor(tokenless);
  ok(!bare.allowed && !("agent" in bare.toolset), "OPE-2351: 🔴 a seat whose token the hook cannot read holds no `agent` either — no wake but W delegates natively");
  ok(bare.lean === "lean" && Object.keys(bare.toolset).every((name) => allowedOnLeanSeat(name)), "OPE-2351: …and it still runs lean, as before: the narrow direction, which the execute backstop agrees with");
  const { seatDelegationVerb, seatHoldsDelegationVerb, seatMemoryRecallRoute } = await import("../agent/access/work-session.js");
  ok(!seatHoldsDelegationVerb(tokenless as unknown as BindableContext), "OPE-2351: the token-less seat holds no delegation verb…");
  ok(seatMemoryRecallRoute(tokenless as unknown as BindableContext) !== "agent", "…so its prompt's memory route does not name `agent`");
  const forwarding = deliveryCtx({}, undefined, STANDING_TOKEN) as unknown as BindableContext;
  const workSession = deliveryCtx({}, undefined, W_TOKEN) as unknown as BindableContext;
  ok(seatHoldsDelegationVerb(forwarding) && seatHoldsDelegationVerb(workSession), "…while a forwarding seat and the work session do (the controls)");
  ok(seatDelegationVerb(forwarding) === "work" && seatDelegationVerb(workSession) === "agent", "OPE-2795: 🔴 a forwarding seat's hand-off verb is `work`, and only the work session's is `agent`");
  ok(seatMemoryRecallRoute(forwarding) === "work", "OPE-2795: 🔴 a forwarding seat's memory route is `work` — never `agent`, which its per-wake verdict refuses, and never `none`, which loses its memory road");
  ok(seatMemoryRecallRoute(workSession) === "agent", "OPE-2795: …and the work session's route is `agent`, which its verdict admits (the control)");
  ok(seatMemoryRecallRoute(tokenless as unknown as BindableContext) === "none", "OPE-2795: …and the token-less seat has no memory road at all");
  {
    const { nativeDelegationVerdictFor } = await import("../agent/hooks/lean-seat.js");
    const { threadSeatWindowId } = await import("../agent/channels/window-key.js");
    const cases: readonly [string, BindableContext][] = [
      ["token-less", tokenless as unknown as BindableContext],
      ["forwarding", forwarding],
      ["work session", workSession],
      ["thread seat", deliveryCtx({}, undefined, `unified:${formatWindowToken({ domain: "acme", windowId: threadSeatWindowId("slack/T1/C1", "1700000000.000100"), generation: 3 })}`) as unknown as BindableContext],
    ];
    for (const [name, c] of cases) {
      ok((nativeDelegationVerdictFor(c) === "allow") === (seatMemoryRecallRoute(c) === "agent"), `OPE-2795: 🔴 ${name}: the \`agent\` verdict is \`allow\` exactly when the memory route names \`agent\` (one predicate)`);
    }
    ok(nativeDelegationVerdictFor(forwarding) === "no-seat" && nativeDelegationVerdictFor(workSession) === "allow", "OPE-2795: the forwarding seat's verdict stays `no-seat`, and the work session's is `allow`");
  }
  {
    const { readFileSync } = await import("node:fs");
    const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    const access = src("../agent/instructions/access.ts");
    const routing = src("../agent/hooks/window-routing.ts");
    const seatRoute = src("../agent/access/work-session.ts");
    ok((access.match(/seatMemoryRecallRoute\(ctx\)/g) ?? []).length === 2, "OPE-2351: both prompt recall routes in instructions/access.ts read seatMemoryRecallRoute");
    ok(/seatMemoryRecallRoute\(c\)/.test(routing), "OPE-2351: …and so does the routing audit row (hooks/window-routing.ts)");
    ok(!access.includes("memoryRecallRouteFor(") && !routing.includes("memoryRecallRouteFor("), "OPE-2795: 🔴 no seat route bypasses seatMemoryRecallRoute, whose verb is the seat's own");
    const recallLines = seatRoute.split("\n").filter((line) => line.includes("memoryRecallRouteFor("));
    ok(recallLines.length === 1 && recallLines.every((line) => !line.includes("canDelegateFromSeat") && line.includes("verb")), "OPE-2351: 🔴 the seat route passes the seat's own delegation verb, never the bare canDelegateFromSeat");
  }
  {
    const { workTierSectionFor } = await import("../agent/instructions/access.js");
    const { NO_HANDOFF_SECTION, WORK_FORWARD_SECTION, WORK_SESSION_SECTION } = await import("../agent/instructions/seat-prompt.js");
    const tokenlessAttended = { channel: { kind: "slack" }, session: { id: "sess-tokenless-attended", auth: { current: { attributes: { [OE_GRAIN_ATTR]: "standing", team_id: "T1", channel_id: "C1" }, principalId: "U1", principalType: "slack-user" } } } };
    ok(workTierSectionFor(tokenlessAttended as unknown as BindableContext) === NO_HANDOFF_SECTION, "OPE-2351: 🔴 the token-less lean seat's prompt says it holds no hand-off verb");
    ok(workTierSectionFor(deliveryCtx({}, undefined, STANDING_TOKEN) as unknown as BindableContext) === WORK_FORWARD_SECTION, "…a forwarding seat reads its `work` block (control)");
    ok(workTierSectionFor(deliveryCtx({}, undefined, W_TOKEN) as unknown as BindableContext) === WORK_SESSION_SECTION, "…and the work session reads its own (control)");
  }
}

console.log(
  `\n✓ invoker-posture (OPE-421): ${n} assertions passed (truth table + minimum composition, withheld-set = manifest wide-hands, the fire's OWN window narrowed and its task-grain WORKER wide — both proven at the model-call seam on real tokens — the thread-seat child still narrowed, the human-into-parked-fire arm, clock/manual classes, fail-narrow directions)\n`,
);

// proves: AP-MOD-core-access-invoker-posture, AP-MOD-core-access-invoker-posture-state, AP-MOD-core-access-wake-slot

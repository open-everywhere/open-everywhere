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
import { FULL_KIT, WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS } from "../agent/access/window-gate-manifest.js";
import { projectToolSet } from "../agent/access/untrusted-projection.js";
import { setNativeDelegationSeat } from "../agent/access/native-delegation-state.js";
import { currentLeanSeatPosture } from "../agent/access/lean-seat-state.js";
import { webhookFireAttributes, WEBHOOK_MARKER_ATTR } from "../agent/routines/fire-auth.js";
import { FIRE_UNATTENDED_ATTR } from "../agent/identity/binding.js";
import { ROUTINE_MARKER } from "../agent/routines/routine.js";
import { OE_GRAIN_ATTR } from "../agent/channels/unified-window.js";

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
    .filter(([, grains]) => grains === FULL_KIT)
    .map(([name]) => name),
);
ok(manifestWideHands.size === UNTRUSTED_REMOTE_WITHHELD_TOOLS.size, `the withheld set is the same SIZE as the manifest's wide-hands rows (${manifestWideHands.size})`);
ok([...manifestWideHands].every((k) => UNTRUSTED_REMOTE_WITHHELD_TOOLS.has(k)), "every wide-hands manifest row is withheld from an untrusted-remote run");
ok([...UNTRUSTED_REMOTE_WITHHELD_TOOLS].every((k) => manifestWideHands.has(k)), "…and nothing is withheld that the manifest does not call wide-hands");
ok(UNTRUSTED_REMOTE_WITHHELD_TOOLS.has("bash"), "`bash` is in the withheld set — the headline name");
ok(withheldForInvokerPosture("interactive").size === 0 && withheldForInvokerPosture("attended-fire").size === 0, "interactive and attended-fire withhold NOTHING — byte-identical to today");
ok(withheldForInvokerPosture("unattended-fire").size === 0, "unattended-fire withholds NOTHING today (a clock fire's cut is a different question — see the header)");

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
  const names = [...Object.keys(WINDOW_GATED_TOOLS), ...WINDOW_UNGATED_TOOLS, "ask_question", "todo", "final_output"];
  const out: Record<string, { description: string; execute: () => unknown }> = {};
  for (const name of names) out[name] = { description: `${name} tool`, execute: () => ({ ok: true }) };
  return out;
}

async function kitForDelivery(ctx: unknown): Promise<{ toolset: Record<string, unknown>; posture: InvokerPosture; lean: string }> {
  return await inSession(async () => {
    setNativeDelegationSeat("allow");
    await leanSeatHook.events["turn.started"]!({}, ctx);
    const posture = currentInvokerPosture();
    const lean = currentLeanSeatPosture();
    const toolset = makeToolset() as unknown as Record<string, unknown>;
    projectToolSet(toolset);
    return { toolset, posture, lean };
  });
}

const deliveryCtx = (attributes: Record<string, unknown>, principal?: { principalId?: string; principalType?: string; authenticator?: string }) => ({
  channel: { kind: "slack", continuationToken: "unified:oe-dom:acme:oe-sup:g3" },
  session: { id: `sess-${Math.random().toString(36).slice(2)}`, auth: { current: { attributes, ...(principal ?? {}) } } },
});

const webhookBag = webhookFireAttributes("hook-abc", "T1", "C1", false, false) as Record<string, unknown>;
ok(webhookBag[WEBHOOK_MARKER_ATTR] === "hook-abc", "fixture provenance: the real webhookFireAttributes bag carries the webhook marker");
ok(webhookBag[FIRE_UNATTENDED_ATTR] === "true", "fixture provenance: …and the unconditional unattended-origin stamp");

{
  const { toolset, posture } = await kitForDelivery(deliveryCtx(webhookBag, { authenticator: "webhook", principalId: "webhook:hook-abc", principalType: "service" }));
  ok(posture === "untrusted-remote", "a REAL webhook fire delivery classifies `untrusted-remote` through the real hook");
  ok(!("bash" in toolset), "⭐ THE PROPERTY: a webhook fire's assembled toolset has NO `bash` — asserted at the model-call seam that decides");
  ok([...UNTRUSTED_REMOTE_WITHHELD_TOOLS].every((k) => !(k in toolset)), "…and no other wide-hands tool either (checkout_repo, write_file, web_fetch, open_pull_request, create_skill, …)");
  ok("reply" in toolset && "final_output" in toolset, "…while the fire keeps the verbs its job consists of — this is a bounded subtraction, not a roster swap");
  ok("remember" in toolset || "read_channel" in toolset, "…including the reads/memory a fire is FOR (it was not collapsed onto the lean conversational roster)");
}

const childBag = (parent: Record<string, unknown>, stamp?: InvokerPosture): Record<string, unknown> => ({
  ...parent,
  [OE_GRAIN_ATTR]: "task",
  ...(stamp !== undefined ? { [INVOKER_POSTURE_ATTR]: stamp } : {}),
});

{
  const { toolset, posture } = await kitForDelivery(deliveryCtx(childBag(webhookBag, "untrusted-remote")));
  ok(posture === "untrusted-remote", "a webhook fire's DELEGATED CHILD classifies `untrusted-remote`");
  ok(!("bash" in toolset), "⭐ THE PROPERTY, SECOND ROUTE: the `task`-grain child of a webhook fire has NO `bash` — remote input cannot reach the shell one hop later either");
}

{
  const { toolset, posture } = await kitForDelivery(deliveryCtx(childBag(webhookBag)));
  ok(posture === "untrusted-remote", "…and it classifies `untrusted-remote` with NO stamp at all — the webhook marker rides the attributes bag on its own");
  ok(!("bash" in toolset), "⭐ so the property does NOT rest on the delegation stamp being present or honest");
}

{
  const eventSubChild = childBag({ [FIRE_UNATTENDED_ATTR]: "true" }, "untrusted-remote");
  const { toolset, posture } = await kitForDelivery(deliveryCtx(eventSubChild));
  ok(posture === "untrusted-remote", "an EVENT-SUB fire's child classifies `untrusted-remote` via the stamp — the class whose raw marker cannot survive the hop");
  ok(!("bash" in toolset), "…and holds no `bash`");
}

{
  const { toolset, posture, lean } = await kitForDelivery(
    deliveryCtx({ channel_id: "C1" }, { principalId: "U1", principalType: "slack-user" }),
  );
  ok(posture === "interactive", "a HUMAN delivery into a parked fire session is `interactive` — it does not inherit the fire that opened the session");
  ok(lean === "lean", "…and still comes out LEAN, exactly as before this cut");
  ok(!("bash" in toolset), "…so it holds no `bash` either — but for the LEAN roster's reason, not this one");
  ok("reply" in toolset && "agent" in toolset, "…and keeps the conversational roster it always had");
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
  (leanSeatHook.events["turn.completed"] as () => void)();
  ok(currentInvokerPosture() === "untrusted-remote", "turn.completed drops the posture back to the NARROWEST class, never to a stale wide one");
  setInvokerPosture("interactive");
  (leanSeatHook.events["turn.failed"] as () => void)();
  ok(currentInvokerPosture() === "untrusted-remote", "turn.failed does the same");
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
}

console.log(`\n✓ invoker-posture (OPE-421): ${n} assertions passed (truth table + minimum composition, withheld-set = manifest wide-hands, the DIRECT and DELEGATED webhook routes proven at the model-call seam, the human-into-parked-fire arm, clock/manual classes, fail-narrow directions)\n`);

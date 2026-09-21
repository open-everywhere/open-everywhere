import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindFrom, windowGrainOf, type BindableContext } from "../agent/identity/binding.js";
import { adoptDelegatedAuthority } from "../agent/identity/delegated-binding.js";
import { FakeEveContext, inEveContext } from "./_eve-context-stub.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-conv-scope-")), "ops.sqlite3");
delete process.env.OE_TRUST;
delete process.env.OE_PLATFORM;

const { registerConfig } = await import("../agent/access/config.js");
const { registerIdentityMapper } = await import("../agent/identity/binding.js");
const { grantDomainScopeKey, grantDomainScopeVerdict, grantScopeAdmits, grantScopeKeyForMode, grantScopeReachOf } = await import("../agent/access/credential-grant-scope.js");
const { routineFireAttributes, webhookFireAttributes } = await import("../agent/routines/fire-auth.js");
const { _setDeploymentIdentityForTest } = await import("../agent/identity/deployment-identity.js");
const { windowedSupervisorEnabled } = await import("../agent/memory/domain.js");
const { classifyWindowRouting } = await import("../agent/access/window-routing.js");
const { registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");

_setDeploymentIdentityForTest({ org: undefined });

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const PLATFORM = "grantconvscopetestplatform";
const WS = "W1";
const ROOM = "C_GRANTED";
const OUTSIDE = "C_NO_DOMAIN";
const ROOM2 = "C_GRANTED_SIBLING";
const DOMAIN = "granted-domain";
const HUMAN = "U_HUMAN";
const CREATOR = "U_CREATOR";
const KEY = `oe-grant-domain::${DOMAIN}`;
const ROOM_KEY = `oe-grant-room::${DOMAIN}::${PLATFORM}/${WS}/${ROOM}`;
const ROOM2_KEY = `oe-grant-room::${DOMAIN}::${PLATFORM}/${WS}/${ROOM2}`;

registerIdentityMapper(PLATFORM, (c) => {
  const a = (c as BindableContext).session?.auth?.current?.attributes as Record<string, string> | undefined;
  return {
    mode: a?.["room"] === undefined ? "dm" : "channel",
    surface: a?.["room"] ?? a?.["dm"],
    trust: "internal",
    visibility: "public",
    workspace: a?.["ws"],
    ...(a?.["actor"] === undefined ? {} : { principalId: a["actor"] }),
  };
});

const useDomains = (domains: readonly { readonly name: string; readonly reach: readonly string[] }[]): void => {
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domains as never,
    loadSilos: () => [],
    domainsForSurface: () => [],
  });
};
const DECLARED = [{ name: DOMAIN, reach: [`${PLATFORM}/${WS}/${ROOM}`, `${PLATFORM}/${WS}/${ROOM2}`] }];
useDomains(DECLARED);

type Attrs = Record<string, string>;

const ctxOf = (attributes: Attrs, slot: Record<string, unknown> = {}, id = "wrun_live", continuationToken?: string): unknown => ({
  channel: { kind: PLATFORM, ...(continuationToken === undefined ? {} : { continuationToken }) },
  session: { auth: { current: { attributes, ...slot } }, id },
});

const liveCtx = (grain: string, room = ROOM, id = "wrun_live"): unknown =>
  ctxOf({ actor: HUMAN, oe_grain: grain, room, ws: WS }, { principalId: HUMAN, principalType: "test-user" }, id);

const fireCtx = (attributes: Attrs, principalId = "eve:app"): unknown =>
  ctxOf(attributes, { authenticator: "app", principalId, principalType: "runtime" }, "wrun_fire");

const destAttrs = { room: ROOM, ws: WS };
const routine = { createdBy: CREATOR, id: "r1", org: "o", promptGeneration: 1, surfaceKey: `${PLATFORM}/${WS}/${ROOM}` } as never;

const standingSeat = liveCtx("standing");
const admitted = grantDomainScopeVerdict(standingSeat as never);
ok(admitted.admitted, "§admit: an ATTENDED turn at the domain's STANDING grain is admitted — OPE-1950's survival is intact");
ok(admitted.scopeKey === KEY, `§admit: …and carries the domain key ${KEY} (got ${String(admitted.scopeKey)})`);

const threadSeat = liveCtx("thread");
const threadVerdict = grantDomainScopeVerdict(threadSeat as never);
ok(!threadVerdict.admitted, "§grain: 🔴 a THREAD seat of the SAME declared room is REFUSED the domain key (a live run leg 51's leak)");
ok(!threadVerdict.admitted && threadVerdict.gate === "non_standing_grain", `§grain: …and names the grain as the reason (got ${String(!threadVerdict.admitted && threadVerdict.gate)})`);
ok(
  !threadVerdict.admitted && threadVerdict.scopeKey === KEY,
  "§grain: …and REPORTS the key it withheld, because the mount's audit row names the grants that key would have reached",
);
ok(grantDomainScopeVerdict(liveCtx("task") as never).admitted === false, "§grain: a `task` (worker) grain is refused too — the gate admits one grain on the DOMAIN key, it does not exclude a list");
ok(grantDomainScopeVerdict(liveCtx("native") as never).scopeKey !== KEY, "§grain: 🔴 a `native` grain never reaches the DOMAIN key — a lost stamp fail-softs to that grain, and the domain's grants are not its to hold");

const standingFire = fireCtx({ ...routineFireAttributes(routine, destAttrs, "channel", true, true), oe_grain: "standing" });
const standingFireVerdict = grantDomainScopeVerdict(standingFire as never);
ok(!standingFireVerdict.admitted, "§attend: 🔴 an UNATTENDED delivery at the STANDING grain is refused — the grain gate alone would have admitted it");
ok(
  !standingFireVerdict.admitted && standingFireVerdict.gate === "unattended",
  `§attend: …and names ATTENDANCE as the reason (got ${String(!standingFireVerdict.admitted && standingFireVerdict.gate)})`,
);
ok(!standingFireVerdict.admitted && standingFireVerdict.scopeKey === KEY, "§attend: …and reports the key it withheld");

const webhookFire = fireCtx({ ...webhookFireAttributes("inbound", WS, ROOM, false, true), ...destAttrs, oe_grain: "standing" }, "webhook:inbound");
ok(grantDomainScopeVerdict(webhookFire as never).admitted === false, "§attend: a WEBHOOK fire is refused too — the family whose `webhook:<hookId>` principal satisfies a bare presence check");

const dispatchedFire = fireCtx({ ...routineFireAttributes(routine, destAttrs, "channel", true, true), oe_grain: "thread" });
const dispatched = grantDomainScopeVerdict(dispatchedFire as never);
ok(!dispatched.admitted, "§fire: a one-shot routine fire as DISPATCHED (thread grain, fire bag) is refused the domain key");
ok(
  !dispatched.admitted && dispatched.gate === "unattended",
  `§fire: …and ATTENDANCE answers first, so the row says nobody was there rather than blaming the grain (got ${String(!dispatched.admitted && dispatched.gate)})`,
);

const outsideRoom = grantDomainScopeVerdict(liveCtx("standing", OUTSIDE) as never);
ok(!outsideRoom.admitted && outsideRoom.gate === "no_domain", "§keyless: a room the config never declared into a domain answers `no_domain`");
ok(!outsideRoom.admitted && outsideRoom.scopeKey === undefined, "§keyless: …and carries NO key, so the mount writes no row for it");

const dm = ctxOf({ actor: HUMAN, dm: "D_OWNER", oe_grain: "standing", ws: WS }, { principalId: HUMAN, principalType: "test-user" }, "wrun_dm");
const dmVerdict = grantDomainScopeVerdict(dm as never);
ok(!dmVerdict.admitted && dmVerdict.gate === "dm", "§keyless: a DIRECT MESSAGE binds nothing — the pre-existing arm, unmoved by this change");
ok(!dmVerdict.admitted && dmVerdict.scopeKey === undefined, "§keyless: …and carries no key either");

const unmapped = {
  channel: { kind: "grantconvscopetestplatform-unregistered" },
  session: { auth: { current: { attributes: { actor: HUMAN, oe_grain: "standing", room: ROOM, ws: WS } } }, id: "wrun_example26" },
};
const unmappedVerdict = grantDomainScopeVerdict(unmapped as never);
ok(!unmappedVerdict.admitted && unmappedVerdict.gate === "unresolved_mode", `§keyless: a conversation no mapper classified answers \`unresolved_mode\` (got ${String(!unmappedVerdict.admitted && unmappedVerdict.gate)})`);
ok(!unmappedVerdict.admitted && unmappedVerdict.scopeKey === undefined, "§keyless: …and carries no key, so a gap-filled mode can never mint a domain binding");

const hostile = {
  get channel(): never {
    throw new Error("unreadable binding");
  },
};
const hostileVerdict = grantDomainScopeVerdict(hostile as never);
ok(!hostileVerdict.admitted && hostileVerdict.gate === "unreadable", `§keyless: a context that THROWS answers \`unreadable\` rather than a key (got ${String(!hostileVerdict.admitted && hostileVerdict.gate)})`);
ok(!hostileVerdict.admitted && hostileVerdict.scopeKey === undefined, "§keyless: …and carries no key — the catch fails CLOSED");

ok(grantDomainScopeKey(standingSeat as never) === KEY, "§wrapper: grantDomainScopeKey answers the key on the admitted seat");
ok(grantDomainScopeKey(threadSeat as never) === undefined, "§wrapper: 🔴 …and `undefined` on the thread seat, which drops every call site to the exact-session rule");
ok(grantDomainScopeKey(standingFire as never) === undefined, "§wrapper: …and `undefined` on the unattended delivery");
ok(grantDomainScopeKey(dispatchedFire as never) === undefined, "§wrapper: …and `undefined` on the dispatched fire");

const nativeSeat = liveCtx("native");
const nativeVerdict = grantDomainScopeVerdict(nativeSeat as never);
ok(nativeVerdict.admitted, "§solo: 🔴 an ATTENDED `native` turn in a declared room IS admitted — the room's own conversation under the shipped topology");
ok(nativeVerdict.scopeKey === ROOM_KEY, `§solo: …and the key names the DOMAIN AND THE ROOM (want ${ROOM_KEY}, got ${String(nativeVerdict.scopeKey)})`);
ok(nativeVerdict.scopeKey !== KEY, "§solo: 🔴 …and is NOT the domain key, so this arm can never reach a grant tapped in a sibling room");

const before = liveCtx("native", ROOM, "wrun_before");
const after = liveCtx("native", ROOM, "wrun_after");
const keyBefore = grantDomainScopeKey(before as never);
ok(keyBefore === grantDomainScopeKey(after as never) && keyBefore === ROOM_KEY, "§solo: 🔴 two sessions of the SAME room resolve the SAME key — a 30-day tap outlives the rotation that retires the asking session");
const roomGrant = { mode: "standing", scopeKey: ROOM_KEY } as const;
ok(grantScopeAdmits(roomGrant, "wrun_after", grantDomainScopeKey(after as never)), "§solo: …so the LATER session reaches a standing grant the EARLIER one's tap minted");
ok(!grantScopeAdmits({ mode: "standing", scopeKey: "wrun_before" }, "wrun_after", grantDomainScopeKey(after as never)), "§solo: NEGATIVE CONTROL: a row keyed to the earlier SESSION is not reachable from the later one — which is the orphaning this arm removes");

const sibling = liveCtx("native", ROOM2);
ok(grantDomainScopeKey(sibling as never) === ROOM2_KEY, `§solo: a SECOND declared room of the same domain mints its OWN key (got ${String(grantDomainScopeKey(sibling as never))})`);
ok(!grantScopeAdmits(roomGrant, "wrun_sibling", grantDomainScopeKey(sibling as never)), "§solo: 🔴 …and cannot reach the first room's standing grant — the key is at most as wide as the domain key, never wider");
ok(!grantScopeAdmits(roomGrant, "wrun_example37", KEY), "§solo: 🔴 …and the DOMAIN's standing seat cannot reach a room-keyed row either — the two shapes never join");
ok(!grantScopeAdmits({ mode: "session", scopeKey: ROOM_KEY }, "wrun_after", grantDomainScopeKey(after as never)), "§solo: a `session`-mode row spelled with a ROOM key is still refused — the MODE decides, never the shape of the string");

registerSettings({ window: { topology: true } });
try {
  const seatedNative = grantDomainScopeVerdict(liveCtx("native") as never);
  ok(!seatedNative.admitted && seatedNative.gate === "non_standing_grain", `§solo: 🔴 a \`native\` wake in a SEATED room mints NO room key (got ${String(seatedNative.admitted ? "admitted" : seatedNative.gate)})`);
  ok(!seatedNative.admitted && seatedNative.scopeKey === KEY, "§solo: …and reports the DOMAIN key it was withheld, unchanged from before this arm");
} finally {
  resetSettingsForTest();
}
ok(grantDomainScopeKey(liveCtx("native") as never) === ROOM_KEY, "§solo: NEGATIVE CONTROL: the SAME wake in the SAME room IS admitted once the room is unseated — the leg above measures the seat, not a broken context");

const nativeOutside = grantDomainScopeVerdict(liveCtx("native", OUTSIDE) as never);
ok(!nativeOutside.admitted && nativeOutside.gate === "no_domain", "§solo: 🔴 a `native` seat in a room NO domain declares is refused — fail closed, and it is the majority of rooms");
ok(!nativeOutside.admitted && nativeOutside.scopeKey === undefined, "§solo: …and carries no key, so the mount writes no row for it");
const nativeDm = ctxOf({ actor: HUMAN, dm: "D_OWNER", oe_grain: "native", ws: WS }, { principalId: HUMAN, principalType: "test-user" }, "wrun_dm_native");
ok(grantDomainScopeVerdict(nativeDm as never).admitted === false, "§solo: a DIRECT MESSAGE binds nothing at this grain either — the DM arm runs above the grain split");
const nativeFire = fireCtx({ ...routineFireAttributes(routine, destAttrs, "channel", true, true), oe_grain: "native" });
const nativeFireVerdict = grantDomainScopeVerdict(nativeFire as never);
ok(!nativeFireVerdict.admitted && nativeFireVerdict.gate === "unattended", "§solo: 🔴 an UNATTENDED delivery at the `native` grain is refused — nobody is in the room to be asking");
ok(!nativeFireVerdict.admitted && nativeFireVerdict.scopeKey === ROOM_KEY, "§solo: …and reports the ROOM key it withheld, which is what the mount's audit row names");
const soloThread = ctxOf({ actor: HUMAN, room: ROOM, ws: WS }, { principalId: HUMAN, principalType: "test-user" }, "wrun_thread_reply", `${ROOM}:1726900000.0001`);
ok(grantDomainScopeKey(soloThread as never) === ROOM_KEY, `§solo: 🔴 an UNSTAMPED thread reply in the room resolves the room's OWN key — the room, not its main conversation, is the boundary this key can honestly name (got ${String(grantDomainScopeKey(soloThread as never))})`);
ok(
  grantDomainScopeVerdict(soloThread as never).admitted && grantDomainScopeVerdict(liveCtx("thread") as never).admitted === false,
  "§solo: …while a STAMPED `thread` seat is still refused, so the grain gate is intact for the seated deployment that produces one",
);
ok(grantDomainScopeVerdict(liveCtx("thread") as never).scopeKey === KEY, "§solo: …and that refusal reports the DOMAIN key, which is the reach a seated deployment's thread seat was withheld");

useDomains([{ name: `odd::name`, reach: [`${PLATFORM}/${WS}/${ROOM}`] }]);
const ambiguous = grantDomainScopeVerdict(liveCtx("native") as never);
ok(!ambiguous.admitted && ambiguous.gate === "ambiguous_domain_name", `§solo: 🔴 a domain name carrying "::" refuses the room key rather than packing an unrecoverable pair (got ${String(!ambiguous.admitted && ambiguous.gate)})`);
ok(!ambiguous.admitted && ambiguous.scopeKey === undefined, "§solo: …and mints no key at all, so the seat keeps the exact-session rule");
ok(grantDomainScopeKey(liveCtx("standing") as never) === "oe-grant-domain::odd::name", "§solo: NEGATIVE CONTROL: the STANDING arm still mints for the same domain — the refusal is about the PAIR, not about the name being odd");
useDomains(DECLARED);

ok(grantScopeReachOf(ROOM_KEY) === "room", "§solo: grantScopeReachOf reads a room key as `room`");
ok(grantScopeReachOf(KEY) === "domain", "§solo: …a domain key as `domain`");
ok(grantScopeReachOf(undefined) === "session" && grantScopeReachOf("") === "session", "§solo: …and no key at all as `session`, which is the exact-session rule");
ok(grantScopeReachOf("wrun_example38_unrecognised") === "domain", "§solo: 🔴 …while an UNRECOGNISED shape reads as the WIDEST keyed reach — the card may under-promise a boundary and must never claim one the row has not got");
ok(grantScopeKeyForMode("standing", "wrun_after", ROOM_KEY) === ROOM_KEY, "§solo: the mint binds an approved `standing` tap to the room key …");
ok(grantScopeKeyForMode("once", "wrun_after", ROOM_KEY) === "wrun_after", "§solo: … and a `once` tap to the asking session, whatever key the ask recorded");

ok(!windowedSupervisorEnabled(`${PLATFORM}/${WS}/${ROOM}`, DECLARED as never), "§solo: 🔴 on the SHIPPED default no seat stands for a declared room — which is why its own wake is `native`");
ok(classifyWindowRouting("native", `${PLATFORM}/${WS}/${ROOM}`, DECLARED as never) === "native-by-design", "§solo: …and the router calls that `native` wake BY DESIGN, not a degradation");
registerSettings({ window: { topology: true } });
try {
  ok(windowedSupervisorEnabled(`${PLATFORM}/${WS}/${ROOM}`, DECLARED as never), "§solo: NEGATIVE CONTROL: ARMING the topology does seat the same room — the leg above measures the capability, not a broken config");
  ok(classifyWindowRouting("native", `${PLATFORM}/${WS}/${ROOM}`, DECLARED as never) === "native-degraded", "§solo: …and a `native` wake there is a DEGRADATION instead, which is the armed deployment's own road — and the arm above refuses exactly that wake");
  ok(grantDomainScopeVerdict(liveCtx("standing") as never).scopeKey === KEY, "§solo: …while the armed topology's STANDING seat still answers the DOMAIN key, unchanged by this arm");
} finally {
  resetSettingsForTest();
}

{
  const workerOf = (seatGrain: string, room = ROOM, parent = "wrun_live"): unknown => ({
    channel: { kind: PLATFORM },
    session: {
      auth: { current: { attributes: { actor: HUMAN, oe_grain: seatGrain, room, ws: WS }, principalId: HUMAN, principalType: "test-user" } },
      id: `worker-of-${parent}`,
      parent: { callId: "call-1", sessionId: parent },
    },
  });
  ok(windowGrainOf(workerOf("standing") as never) === "task", "§worker: the worker fixture does not resolve grain `task` — the subagent-child override is what makes this section the right test");

  const workerVerdict = async (seatGrain: string, room = ROOM): Promise<ReturnType<typeof grantDomainScopeVerdict>> =>
    await inEveContext(new FakeEveContext(), async () => {
      adoptDelegatedAuthority({ binding: bindFrom(liveCtx(seatGrain, room) as never), nonMemberWake: false, requester: { kind: "requester", principalId: HUMAN } }, undefined);
      return grantDomainScopeVerdict(workerOf(seatGrain, room) as never);
    });

  const seatStanding = await workerVerdict("standing");
  ok(seatStanding.scopeKey === KEY, "🔴 §worker: a worker of the domain's STANDING seat does not reach the DOMAIN key — a standing grant is then reachable by nothing, since the seat mounts none either");
  ok(seatStanding.admitted, "§worker: …and it is ADMITTED, not merely reported as withheld");

  const seatNative = await workerVerdict("native");
  ok(seatNative.scopeKey === ROOM_KEY, "🔴 §worker: a worker of an UNSEATED room's own `native` seat does not reach that ROOM's key — this is the shipped default, so this is the common live path");
  ok(seatNative.admitted, "§worker: …and it is ADMITTED");
  ok(
    seatNative.scopeKey !== KEY,
    "🔴 §worker: an unseated room's worker reaches the DOMAIN key — that is every room of the domain instead of the one its conversation binds to, which is the widening OPE-2012 narrowed",
  );
  ok((await workerVerdict("native", ROOM2)).scopeKey === ROOM2_KEY, "§worker: …and a worker of a DIFFERENT unseated room reaches that room's key, so the room segment is real");

  const thread = await workerVerdict("thread");
  ok(!thread.admitted, "🔴 §worker: a worker of a THREAD seat reaches a key — the cross-room spend a live run leg 51 measured reopens through the delegation");
  ok(!thread.admitted && thread.gate === "non_standing_grain", "§worker: …and it is refused for the GRAIN, naming the seat shape rather than attendance or a missing domain");
  const unstampedWorker = (): unknown => ({
    channel: { kind: PLATFORM },
    session: { auth: { current: { attributes: { actor: HUMAN, room: ROOM, ws: WS }, principalId: HUMAN, principalType: "test-user" } }, id: "w", parent: { callId: "c", sessionId: "p" } },
  });
  const unstampedIn = async (): Promise<ReturnType<typeof grantDomainScopeVerdict>> =>
    await inEveContext(new FakeEveContext(), async () => {
      adoptDelegatedAuthority({ binding: bindFrom(liveCtx("native") as never), nonMemberWake: false, requester: { kind: "requester", principalId: HUMAN } }, undefined);
      return grantDomainScopeVerdict(unstampedWorker() as never);
    });
  const unstampedUnseated = await unstampedIn();
  ok(unstampedUnseated.admitted, "🔴 §worker: a worker carrying NO grain stamp is REFUSED on an unseated deployment — that is every worker the shipped default ever spawns, so the room arm would be reachable by nothing");
  ok(unstampedUnseated.scopeKey === ROOM_KEY, "§worker: …and it reaches its own ROOM's key, which is what OPE-2012 bound a standing grant to there");

  registerSettings({ window: { topology: true } });
  try {
    const unstampedSeated = await unstampedIn();
    ok(!unstampedSeated.admitted, "🔴 §worker: an unstamped worker in a SEATED room is admitted — the `native` fallback has widened the very topology OPE-1972 narrowed");
    ok(!unstampedSeated.admitted && unstampedSeated.gate === "non_standing_grain", "§worker: …and it is the GRAIN that refuses it, naming the seat shape rather than an unreadable binding");
  } finally {
    resetSettingsForTest();
  }

  ok(!grantDomainScopeVerdict(liveCtx("task") as never).admitted, "§worker: control — a `task` session that is NOBODY'S CHILD is still refused, so the stamp is read only for a real delegated worker");
}

console.log(`credential-grant-conversation-scope: ${String(n)} assertions passed`);

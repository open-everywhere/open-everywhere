import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindableContext } from "../agent/identity/binding.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-conv-scope-")), "ops.sqlite3");
delete process.env.OE_TRUST;
delete process.env.OE_PLATFORM;

const { registerConfig } = await import("../agent/access/config.js");
const { registerIdentityMapper } = await import("../agent/identity/binding.js");
const { grantDomainScopeKey, grantDomainScopeVerdict } = await import("../agent/access/credential-grant-scope.js");
const { routineFireAttributes, webhookFireAttributes } = await import("../agent/routines/fire-auth.js");
const { _setDeploymentIdentityForTest } = await import("../agent/identity/deployment-identity.js");

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
const DOMAIN = "granted-domain";
const HUMAN = "U_HUMAN";
const CREATOR = "U_CREATOR";
const KEY = `oe-grant-domain::${DOMAIN}`;

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

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [{ name: DOMAIN, reach: [`${PLATFORM}/${WS}/${ROOM}`] }],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

type Attrs = Record<string, string>;

const ctxOf = (attributes: Attrs, slot: Record<string, unknown> = {}, id = "wrun_live"): unknown => ({
  channel: { kind: PLATFORM },
  session: { auth: { current: { attributes, ...slot } }, id },
});

const liveCtx = (grain: string, room = ROOM): unknown => ctxOf({ actor: HUMAN, oe_grain: grain, room, ws: WS }, { principalId: HUMAN, principalType: "test-user" });

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
ok(grantDomainScopeVerdict(liveCtx("task") as never).admitted === false, "§grain: a `task` (worker) grain is refused too — the gate admits one grain, it does not exclude a list");
ok(grantDomainScopeVerdict(liveCtx("native") as never).admitted === false, "§grain: a `native` grain is refused — and it is what an unclassifiable token fail-softs to, so this is the fail-closed direction");

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

console.log(`credential-grant-conversation-scope: ${String(n)} assertions passed`);

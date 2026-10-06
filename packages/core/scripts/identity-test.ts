import { bindFrom, bindBridged, registerIdentityMapper, type BindableContext, type IdentityMapper } from "../agent/identity/binding.js";
import { normalizePlatform } from "../agent/identity/platform.js";
import {
  principalKey,
  tryPrincipalKey,
  isQualifiedPrincipalKey,
  parsePrincipalKey,
  principalKeyReplacementHint,
  rosterHasPrincipal,
  principalIdsOnPlatform,
  UNNAMED_TENANT,
} from "../agent/identity/principal-key.js";
import { readBindingBridge, stampBindingBridge, bridgedContext } from "../agent/identity/binding-bridge.js";
import { adoptDelegatedAuthority } from "../agent/identity/delegated-binding.js";
import { carriesPlatformIdentity, healDeliveryIdentity, refreshBindingStamp, subagentBindingLost } from "../agent/identity/binding.js";
import bindingBridgeHook from "../agent/hooks/binding-bridge.js";
import { resolvePartition } from "../agent/memory/partition.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { _resetDeploymentIdentityForTest, _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

_resetDeploymentIdentityForTest();
for (const k of [
  "OE_PLATFORM", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST",
]) {
  delete process.env[k];
}

ok(
  bindFrom({ channel: { kind: "slack" }, session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C9", channel_type: "channel", is_private: "false" }, principalId: "", principalType: "slack-user" } } } }).trust === "external",
  "slack UNREGISTERED (core alone): binds fail-closed external through bindLocal",
)

_setDeploymentIdentityForTest({ workspace: "acme", surface: "alpha" });
process.env.OE_MODE = "dm";
process.env.OE_VISIBILITY = "private";
const local = bindFrom({});
ok(local.platform === "local" && local.workspace === "acme" && local.surface === "alpha", "local: identity from the declared ambient workspace/surface");
ok(local.mode === "dm" && local.visibility === "private", "local: mode/visibility from env");
ok(local.target === undefined, "local: no post-back target");
_setDeploymentIdentityForTest({ surface: undefined });
const defaults = bindFrom({ channel: { kind: "local" } });
ok(defaults.surface === "default", "local: surface defaults when the declaration names none");

ok(bindFrom({}).trust === "internal", "bindFrom: local/dev defaults internal");
process.env.OE_TRUST = "external";
ok(bindFrom({}).trust === "external", "bindFrom: OE_TRUST=external forces external (gate testing)");
delete process.env.OE_TRUST;
ok(bindFrom({ channel: { kind: "myspace" } }).trust === "external", "bindFrom: unknown platform fails closed to external");

process.env.OE_MODE = "dm";
ok(bindFrom({}).trust === "internal", "bindFrom: local/dev DM stays internal (platform-exempt)");
delete process.env.OE_MODE;

ok(readBindingBridge() === null, "binding-bridge: read outside a session context → null (fail-soft)");
stampBindingBridge({
  channel: { kind: "local" },
  session: { auth: { current: { attributes: { ws: "W", sfc: "S" }, principalId: "", principalType: "user" } } },
});
ok(readBindingBridge() === null, "binding-bridge: stamp outside a session context is a no-op");
const bridgedSlug = bindFrom(
  bridgedContext({
    platform: "discord-gateway",
    principalId: "U_dg",
    principalType: "discord-user",
    attributes: { guild_id: "G7", channel_id: "C7", channel_type: "0", user_id: "U_dg" },
  }),
);
ok(bridgedSlug.platform === "discord",
  "binding-bridge: a channel-slug platform stamp ('discord-gateway') normalizes to the discord platform (mapper dispatch is app-tier — bundle-registered)");

const uniNoStamp = bindBridged({
  platform: "unified",
  principalId: "U1",
  principalType: "slack-user",
  attributes: { team_id: "T9", channel_id: "C9", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" },
});
ok(uniNoStamp.platform === "unified",
  "binding-bridge: a unified stamp WITHOUT oe_platform stays 'unified' — no origin to hop to, so no surface mapper resolves (falls to the env stand-in → bindFrom fails it closed to external, asserted below)");
ok(bindFrom(bridgedContext({
  platform: "unified",
  principalId: "U1",
  principalType: "slack-user",
  attributes: { team_id: "T9", channel_id: "C9", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" },
})).trust === "external",
  "binding-bridge: bindFrom on a unified stamp WITHOUT oe_platform fails closed to external (no origin recovered)");

ok(normalizePlatform("slack-qabot") === "slack", "platform: slack-* slug collapses via the prefix rule");
ok(normalizePlatform("discord-databot") === "discord", "platform: discord-* slug collapses via the prefix rule");
ok(normalizePlatform("teams-support") === "teams", "platform: teams-* slug collapses via the prefix rule");
ok(normalizePlatform("discord-gateway") === "discord", "platform: the explicit alias still wins (map before prefix)");
ok(normalizePlatform("slack") === "slack", "platform: a bare platform passes through unchanged");
ok(normalizePlatform("slackish") === "slackish", "platform: prefix rule needs the hyphen — no substring false-positives");
ok(normalizePlatform("linear-bot") === "linear", "platform: linear-* slug collapses via the prefix rule");

const fakeMapper: IdentityMapper = (ctx) => {
  const a = ctx.session?.auth?.current?.attributes;
  const ws = a?.["ws"];
  const sfc = a?.["sfc"];
  return {
    workspace: typeof ws === "string" ? ws : "WSX",
    surface: typeof sfc === "string" ? sfc : "SFX",
    mode: "channel",
    trust: "internal",
  };
};
registerIdentityMapper("regtest", fakeMapper);
const reg = bindFrom({ channel: { kind: "regtest" }, session: { auth: { current: { attributes: { ws: "WSX", sfc: "SFX" } } } } });
ok(
  reg.platform === "regtest" && reg.workspace === "WSX" && reg.surface === "SFX" && reg.trust === "internal",
  "register seam: a mapper registered via registerIdentityMapper is resolvable by bindFrom",
);
ok(
  bindFrom({ channel: { kind: "neverregistered" } }).trust === "external",
  "register seam: an unregistered platform still falls through to bindLocal + fail-closed external",
);

{
  ok(principalKey("slack", "T1", "U0EXOWNER") === "slack/T1/U0EXOWNER", "principalKey composes <platform>/<tenant>/<id> on a TENANT-SCOPED platform");
  ok(principalKey("discord", undefined, "300000000000000104") === "discord/300000000000000104", "…and <platform>/<id> everywhere else");
  ok(principalKey("Slack", "T1", "U1") === "Slack/U1", "principalKey does NOT normalize — an un-normalized platform token is not in the tenant-scoped set, so it composes the two-segment shape and the validator is the gate");

  for (const p of ["discord", "teams", "github", "linear", "notion"]) {
    ok(principalKey(p, "IGNORED", "U1") === `${p}/U1`, `${p} keys are unchanged by the rung — the tenant argument is IGNORED, not defaulted`);
  }

  ok(principalKey("discord", "GUILD1", "U1") === principalKey("discord", "U1", "U1"), "🔴 a Discord channel binding and its DM binding compose the SAME key (the workspace fallback cannot split one human in two)");

  ok(principalKey("slack", "T_ACME", "U1") !== principalKey("slack", "T_BETA", "U1"), "🔴 the SAME Slack member id in two workspaces composes two DIFFERENT keys (OPE-309: two humans, two keys)");

  let threw = false;
  try { principalKey("slack", undefined, "U1"); } catch { threw = true; }
  ok(threw, "🔴 the composer THROWS for a tenant-scoped platform with no tenant — an invented tenant segment is an identity claim");
  threw = false;
  try { principalKey("slack", "   ", "U1"); } catch { threw = true; }
  ok(threw, "…and for a whitespace-only tenant");
  threw = false;
  try { principalKey("slack", UNNAMED_TENANT, "U1"); } catch { threw = true; }
  ok(threw, `🔴 …and for the "${UNNAMED_TENANT}" binding fallback, which is the string for "nobody said" and would be ONE aliasing bucket every unnamed delivery lands in`);
  ok(tryPrincipalKey("slack", undefined, "U1") === undefined, "tryPrincipalKey is the same decision as a VALUE — for the matchers and label paths that must refuse rather than throw");

  ok(isQualifiedPrincipalKey("discord/300000000000000104"), "a two-segment key validates on a vendor-global platform");
  ok(isQualifiedPrincipalKey("slack/T1/U1"), "…and the three-segment key validates on a tenant-scoped one");
  ok(isQualifiedPrincipalKey("discord-gateway/1"), "a hyphenated platform token validates");
  ok(!isQualifiedPrincipalKey("slack/U1"), "🔴 a PRE-RUNG two-segment slack key does NOT validate — the composer can no longer mint it, so the entry is inert and config load must say so");
  ok(!isQualifiedPrincipalKey("discord/G1/U1"), "…and a three-segment key on a vendor-global platform does not validate either (the rung is per-platform, not optional)");
  ok(!isQualifiedPrincipalKey(`slack/${UNNAMED_TENANT}/U1`), `…nor a key whose tenant rung is "${UNNAMED_TENANT}" — well-shaped, matches nobody, so it belongs on the loud side of the line`);
  ok(!isQualifiedPrincipalKey("U1"), "a BARE id does not validate (the pre-P0 form)");
  ok(!isQualifiedPrincipalKey("300000000000000104"), "…nor a bare digit string");
  ok(!isQualifiedPrincipalKey("slack/"), "…nor an empty id");
  ok(!isQualifiedPrincipalKey("/U1"), "…nor an empty platform");
  ok(!isQualifiedPrincipalKey("Slack/U1"), "…nor an upper-cased platform token (platforms are normalized lowercase everywhere)");
  ok(!isQualifiedPrincipalKey("slack/T1/U 1"), "…nor an id with whitespace");
  ok(!isQualifiedPrincipalKey(undefined), "…nor undefined");

  const parsed = parsePrincipalKey("discord/300000000000000104");
  ok(parsed?.platform === "discord" && parsed.id === "300000000000000104" && parsed.tenant === undefined, "parsePrincipalKey splits a valid key, with NO tenant on a vendor-global platform");
  const parsedTenant = parsePrincipalKey("slack/T1/U1");
  ok(parsedTenant?.platform === "slack" && parsedTenant.tenant === "T1" && parsedTenant.id === "U1", "…and all three parts on a tenant-scoped one");
  ok(parsePrincipalKey("U1") === undefined, "parsePrincipalKey returns a VALUE (undefined) for a malformed key — display/filter paths skip, they never throw");

  const roster = ["slack/T1/U_ADMIN", "discord/300000000000000104"];
  ok(rosterHasPrincipal(roster, "slack", "T1", "U_ADMIN"), "rosterHasPrincipal matches the qualified entry");
  ok(rosterHasPrincipal(roster, "discord", undefined, "300000000000000104"), "…on either platform in one roster");
  ok(!rosterHasPrincipal(roster, "teams", undefined, "300000000000000104"), "🔴 …and NOT the same digits on another platform — the collision this grammar exists to delete");
  ok(!rosterHasPrincipal(roster, "slack", "T_OTHER", "U_ADMIN"), "🔴 …and NOT the same member id from ANOTHER WORKSPACE (OPE-309 — the collision the rung exists to delete)");
  ok(!rosterHasPrincipal(roster, "slack", undefined, "U_ADMIN"), "…and fails CLOSED, not throws, when the tenant cannot be named on a tenant-scoped platform");
  ok(!rosterHasPrincipal(roster, undefined, "T1", "U_ADMIN"), "rosterHasPrincipal FAILS CLOSED with no platform");
  ok(!rosterHasPrincipal(roster, "slack", "T1", undefined), "…and with no id");
  ok(!rosterHasPrincipal(undefined, "slack", "T1", "U_ADMIN"), "…and with no roster at all");
  ok(!rosterHasPrincipal(["U_ADMIN"], "slack", "T1", "U_ADMIN"), "…and a BARE roster entry never matches (which is why config load refuses one)");
  ok(!rosterHasPrincipal(["slack/U_ADMIN"], "slack", "T1", "U_ADMIN"), "🔴 an UNQUALIFIED roster entry does not match a qualified lookup (a missed matcher costs standing…)");
  ok(!rosterHasPrincipal(["slack/T1/U_ADMIN"], "discord", undefined, "T1"), "🔴 …and no lookup can be shaped to match a qualified entry from the other direction either");

  ok(JSON.stringify(principalIdsOnPlatform(roster, "slack", "T1")) === JSON.stringify(["U_ADMIN"]), "principalIdsOnPlatform projects the roster down to one platform's bare ids");
  ok(principalIdsOnPlatform(roster, "teams", undefined).length === 0, "…dropping every other platform's entries");
  ok(principalIdsOnPlatform(roster, "slack", "T_OTHER").length === 0, "🔴 …and every other WORKSPACE's entries — the one function that legitimately UNQUALIFIES must not hand a foreign workspace's bare id to a membership comparison");
  ok(principalIdsOnPlatform(roster, "slack", undefined).length === 0, "…and yielding nothing at all when the tenant cannot be named (fail closed)");
  ok(principalIdsOnPlatform([...roster, "junk"], "slack", "T1").length === 1, "…and malformed entries");
  ok(principalIdsOnPlatform(roster, undefined, "T1").length === 0, "…and yielding nothing at all with no platform (fail closed)");

  ok(
    principalKeyReplacementHint("slack/U1", "T_ACME").includes(`"slack/T_ACME/U1"`),
    "🔴 the config-load hint computes the EXACT three-segment replacement when the deployment names one workspace",
  );
  ok(
    principalKeyReplacementHint("slack/U1", undefined).includes(`"slack/<tenant-id>/U1"`),
    "…and the shape plus where to find the segment when it does not — never a guessed workspace",
  );
}

{
  _resetDeploymentIdentityForTest();
  for (const k of ["OE_PLATFORM", "OE_TRUST", "OE_MODE"]) delete process.env[k];

  const surfaceMapper: IdentityMapper = (ctx) => {
    const a = ctx.session?.auth?.current?.attributes;
    const ws = typeof a?.["ws"] === "string" ? (a["ws"] as string) : undefined;
    const sfc = typeof a?.["sfc"] === "string" ? (a["sfc"] as string) : undefined;
    const pid = typeof a?.["pid"] === "string" ? (a["pid"] as string) : undefined;
    return { workspace: ws, surface: sfc, principalId: pid, mode: "channel", ...(ws !== undefined ? { trust: "internal" as const } : {}) };
  };
  registerIdentityMapper("ope603a", surfaceMapper);
  registerIdentityMapper("ope603b", surfaceMapper);

  const scopeKeyOf = (ctx: BindableContext): string => {
    const b = bindFrom(ctx);
    return `${b.platform}/${b.workspace}/${b.domainSurface ?? b.surface}`;
  };

  const makeDeliveryA = (): BindableContext => ({
    channel: { kind: "channel:unified" },
    session: { auth: { current: { attributes: { oe_platform: "ope603a", oe_wake_id: "w-a", oe_grain: "standing", ws: "W_A", sfc: "S_A", pid: "P_A" }, principalId: "U_A", principalType: "user" } } },
  });
  const makeDeliveryB = (): BindableContext => ({
    channel: { kind: "channel:unified" },
    session: { auth: { current: { attributes: { oe_platform: "ope603b", oe_wake_id: "w-b", oe_grain: "standing", ws: "W_B", sfc: "S_B" }, principalId: "U_B", principalType: "user" } } },
  });
  const makeInternalWakeA = (): BindableContext => ({
    channel: { kind: "channel:unified" },
    session: { auth: { current: { attributes: { oe_platform: "ope603a", oe_wake_id: "w-decision", oe_grain: "standing", oe_window_token: "oe-domain::d:oe-sup:g1", oe_sources: "ope603a" } } } },
  });
  const makeInternalWakeB = (): BindableContext => ({
    channel: { kind: "channel:unified" },
    session: { auth: { current: { attributes: { oe_platform: "ope603b", oe_wake_id: "w-decision", oe_grain: "standing", oe_window_token: "oe-domain::d:oe-sup:g1", oe_sources: "ope603b" } } } },
  });
  const deliveryA = makeDeliveryA();
  const deliveryB = makeDeliveryB();
  const internalWakeA = makeInternalWakeA();
  const internalWakeB = makeInternalWakeB();
  const toolCtx: BindableContext = {};

  ok(carriesPlatformIdentity(deliveryA), "OPE-603: a real surface delivery CARRIES a platform identity");
  ok(!carriesPlatformIdentity(internalWakeA), "🔴 OPE-603: an internal wake's five oe_* stamps are NOT a platform identity — non-empty, and still nothing to bind");
  ok(!carriesPlatformIdentity(toolCtx), "OPE-603: an identity-less tool context carries none either");

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

  const hookEvents = (bindingBridgeHook as { events: Record<string, (e: unknown, ctx: unknown) => Promise<void>> }).events;
  const sessionStarted = (ctx: BindableContext): Promise<void> => hookEvents["session.started"]!({}, ctx);
  const turnStarted = (ctx: BindableContext): Promise<void> => hookEvents["turn.started"]!({}, ctx);

  await inSession(async () => {
    const deliveryA = makeDeliveryA();
    const deliveryB = makeDeliveryB();
    const internalWakeA = makeInternalWakeA();
    const internalWakeB = makeInternalWakeB();
    await sessionStarted(deliveryA);
    ok(scopeKeyOf(deliveryA) === "ope603a/W_A/S_A", "OPE-603 §1: the seat's first delivery binds its own surface");
    ok(scopeKeyOf(toolCtx) === "ope603a/W_A/S_A", "OPE-603 §1: …and its identity-less tool contexts bridge to the same surface");

    await turnStarted(internalWakeA);
    ok(scopeKeyOf(internalWakeA) === "ope603a/W_A/S_A", "🔴 OPE-603 §1: an INTERNAL WAKE's turn binds the ORIGIN surface, not the env stand-in");
    ok(bindFrom(internalWakeA).trust === "internal", "🔴 OPE-603 §1: …so it keeps the surface's trust verdict too");
    ok(scopeKeyOf(toolCtx) === "ope603a/W_A/S_A", "🔴 OPE-603 §1: …and the tools + delegated workers on that turn still resolve the surface");

    ok(refreshBindingStamp(deliveryB) === "stamped", "OPE-603 §1: a delivery that carries an identity STILL writes the stamp");
    ok(scopeKeyOf(toolCtx) === "ope603b/W_B/S_B", "OPE-603 §1: …and the seat re-binds to the surface that just spoke");
    ok(refreshBindingStamp(internalWakeB) === "kept", "OPE-603 §1: an identity-less wake reports `kept` — it wrote nothing");
    ok(scopeKeyOf(toolCtx) === "ope603b/W_B/S_B", "OPE-603 §1: …and the stamp is unchanged");
  });

  await inSession(async () => {
    const internalWakeA = makeInternalWakeA();
    await sessionStarted(internalWakeA);
    const stamped = readBindingBridge();
    ok(stamped !== null && !carriesPlatformIdentity(bridgedContext(stamped)), "🔴 OPE-603 §2 negative control: a session that only ever saw an identity-less delivery holds a stamp that NAMES NO SURFACE");
    ok(scopeKeyOf(internalWakeA) === "ope603a/dev/default", "🔴 OPE-603 §2: …so it binds the ambient gap-filler default, inventing no surface");
    ok(bindFrom(internalWakeA).trust === "external", "🔴 OPE-603 §2: …and FAILS CLOSED to external");
    ok(scopeKeyOf(toolCtx) === "ope603a/dev/default", "🔴 OPE-603 §2: …and its tools resolve nothing either — never a borrowed surface");
  });
  await inSession(async () => {
    const deliveryA = makeDeliveryA();
    const internalWakeA = makeInternalWakeA();
    ok(readBindingBridge() === null, "🔴 OPE-603 §2: a NEIGHBOURING session sees none of §1's stamp — no cross-session bleed");
    ok(scopeKeyOf(deliveryA) === "ope603a/W_A/S_A", "OPE-603 §2: …its OWN delivery still binds its own surface (the fence costs a real delivery nothing)");
    ok(bindFrom(internalWakeA).trust === "external", "🔴 OPE-603 §2: …but an identity-less wake here binds fail-closed, never the neighbour's internal surface");
  });

  await inSession(async () => {
    const deliveryA = makeDeliveryA();
    const internalWakeB = makeInternalWakeB();
    await sessionStarted(deliveryA);
    ok(scopeKeyOf(deliveryA) === "ope603a/W_A/S_A", "OPE-603 §3: the seat establishes surface A");
    await turnStarted(internalWakeB);
    ok(scopeKeyOf(internalWakeB) !== "ope603a/W_A/S_A", "🔴 OPE-603 §3: an identity-less wake naming platform B does NOT inherit platform A's surface");
    ok(scopeKeyOf(internalWakeB) === "ope603b/dev/default", "🔴 OPE-603 §3: …it falls to the env stand-in on its OWN platform");
    ok(bindFrom(internalWakeB).trust === "external", "🔴 OPE-603 §3: …and fails closed");
    ok(scopeKeyOf(toolCtx) === "ope603a/W_A/S_A", "🔴 OPE-603 §3: …while the identity-less TOOL context still bridges — the fence tests a named platform, not the absence of one");
  });

  const wakeP = (pid: string): BindableContext => ({
    channel: { kind: "channel:unified" },
    session: { auth: { current: { attributes: { oe_platform: "ope603a", oe_wake_id: `w-${pid}`, oe_grain: "standing", pid } } } },
  });
  await inSession(async () => {
    const deliveryA = makeDeliveryA();
    await sessionStarted(wakeP("P1"));
    ok(bindFrom(toolCtx).principalId === "P1", "OPE-603 §4: with NO surface established, an identity-less delivery still writes its stamp");
    await turnStarted(wakeP("P2"));
    ok(bindFrom(toolCtx).principalId === "P2", "🔴 OPE-603 §4: …and a later one still REFRESHES it — the rule refuses a downgrade, never every identity-less write");
    await turnStarted(deliveryA);
    ok(bindFrom(toolCtx).principalId === "P_A", "OPE-603 §4: a real delivery establishes the surface and its own attestation");
    await turnStarted(wakeP("P3"));
    ok(bindFrom(toolCtx).principalId === "P_A", "🔴 OPE-603 §4: …and from then on an identity-less delivery overwrites NOTHING");
    ok(scopeKeyOf(toolCtx) === "ope603a/W_A/S_A", "🔴 OPE-603 §4: …so the surface holds");
  });

  const makeChild = (attributes: Record<string, string>): BindableContext => ({
    channel: { kind: "subagent" },
    session: { parent: { sessionId: "wrun_PARENT" }, auth: { current: { attributes } } },
  });
  const copyOfBag = (ctx: BindableContext): Record<string, string> =>
    Object.fromEntries(Object.entries(ctx.session?.auth?.current?.attributes ?? {}).map(([k, v]) => [k, String(v)]));

  let healedBagOut: Record<string, string> = {};
  let dispatchBindingOut: ReturnType<typeof bindFrom> | undefined;
  await inSession(async () => {
    const deliveryA = makeDeliveryA();
    const internalWakeA = makeInternalWakeA();
    await sessionStarted(deliveryA);
    ok(!carriesPlatformIdentity(internalWakeA), "OPE-681 §5: the internal wake arrives with NO platform identity");

    await turnStarted(internalWakeA);
    ok(carriesPlatformIdentity(internalWakeA), "🔴 OPE-681 §5: after the hook its OWN bag names the seat's surface");
    const healedBag = copyOfBag(internalWakeA);
    ok(healedBag["ws"] === "W_A" && healedBag["sfc"] === "S_A", "🔴 OPE-681 §5: …with the platform's own attribute keys, not a core-derived summary");
    ok(healedBag["pid"] === "P_A", "🔴 OPE-681 §5: …including the ACTING PRINCIPAL, which the child also loses without it");

    ok(healedBag["oe_wake_id"] === "w-decision", "🔴 OPE-681 §5: the delivery's OWN oe_wake_id survives — the stamp is never overwritten");
    ok(healedBag["oe_window_token"] === "oe-domain::d:oe-sup:g1", "🔴 OPE-681 §5: …and its own window token too");

    healedBagOut = healedBag;
    dispatchBindingOut = bindFrom(deliveryA);
  });

  await inSession(() => {
    ok(readBindingBridge() === null, "OPE-681 §5: the child's own session starts with an EMPTY bridge slot");
    const child = makeChild(healedBagOut);
    ok(scopeKeyOf(child) === "subagent/dev/unresolved", "🔴 OPE-681 §5: a raw inherited bag is not child authority before the dispatch snapshot is adopted");
    ok(
      dispatchBindingOut !== undefined &&
        adoptDelegatedAuthority(
          { binding: dispatchBindingOut, requester: { kind: "requester", principalId: "P_A" }, nonMemberWake: false },
          undefined,
        ),
      "OPE-681 §5: the child adopts the host-captured dispatch authority",
    );
    ok(scopeKeyOf(child) === "ope603a/W_A/S_A", "🔴 OPE-681 §5: the adopted child binds the DISPATCH surface");
    ok(bindFrom(child).principalId === "P_A", "🔴 OPE-681 §5: …with the dispatch-time acting principal");
    ok(bindFrom(child).mode === "channel", "🔴 OPE-681 §5: …and the dispatch-time mode");
  });

  await inSession(() => {
    const lost = makeChild(copyOfBag(makeInternalWakeA()));
    ok(scopeKeyOf(lost) === "subagent/dev/unresolved", "🔴 OPE-681 §5: a child with no dispatch snapshot fails closed to the unresolved child sentinel");
  });

  let crossBagOut: Record<string, string> = {};
  await inSession(async () => {
    const deliveryA = makeDeliveryA();
    const deliveryB = makeDeliveryB();
    const internalWakeB = makeInternalWakeB();
    await sessionStarted(deliveryA);

    ok(healDeliveryIdentity(internalWakeB) === "cross-platform", "🔴 OPE-681 §6①: a wake on ANOTHER platform is refused the heal");
    ok(!carriesPlatformIdentity(internalWakeB), "🔴 OPE-681 §6①: …and its bag is left exactly as it arrived");
    crossBagOut = copyOfBag(internalWakeB);

    ok(healDeliveryIdentity(deliveryB) === "not-needed", "🔴 OPE-681 §6②: a delivery that names a surface is not healed");
    ok(copyOfBag(deliveryB)["ws"] === "W_B", "🔴 OPE-681 §6②: …and keeps its own workspace, never the established one");
  });
  await inSession(() => {
    ok(scopeKeyOf(makeChild(crossBagOut)) === "subagent/dev/unresolved", "🔴 OPE-681 §6①: …so its child fails closed rather than binding the neighbour's surface");
  });

  let lostBagOut: Record<string, string> = {};
  await inSession(async () => {
    const internalWakeA = makeInternalWakeA();
    await sessionStarted(internalWakeA);
    ok(healDeliveryIdentity(internalWakeA) === "no-stamp", "🔴 OPE-681 §7: a seat that never established a surface heals nothing");
    ok(!carriesPlatformIdentity(internalWakeA), "🔴 OPE-681 §7: …the bag is unchanged");
    lostBagOut = copyOfBag(internalWakeA);
  });
  await inSession(() => {
    ok(subagentBindingLost(makeChild(lostBagOut)) === true, "🔴 OPE-681 §7: …and its child, in its own fresh session, is refused rather than run on the org default");
  });

  ok(subagentBindingLost(makeDeliveryA()) === false, "🔴 OPE-681 §8: a ROOT session is never refused, whatever it binds");
  ok(subagentBindingLost(makeInternalWakeA()) === false, "🔴 OPE-681 §8: an identity-less ROOT turn is never refused either — the seat's own bridge answers for it");
  ok(
    subagentBindingLost({ channel: { kind: "subagent" }, session: { parent: { sessionId: "wrun_P" }, auth: { current: { attributes: {} } } } }) === false,
    "🔴 OPE-681 §8: a child with NO platform stamp resolves no mapper — the local stand-in stays reachable for `eve dev` and evals",
  );
  ok(
    subagentBindingLost(makeChild({ oe_platform: "ope603a", oe_wake_id: "w", oe_grain: "task" })) === true,
    "🔴 OPE-681 §8: …but a child that DOES name a registered platform and no surface is refused",
  );

  const withCancel = (ctx: BindableContext): BindableContext & { cancel: () => void; cancels: number } => {
    const spy = ctx as BindableContext & { cancel: () => void; cancels: number };
    spy.cancels = 0;
    spy.cancel = () => {
      spy.cancels++;
    };
    return spy;
  };
  await inSession(async () => {
    const child = withCancel(makeChild({ oe_platform: "ope603a", oe_wake_id: "w", oe_grain: "task" }));
    let threw: string | undefined;
    try {
      await sessionStarted(child);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    ok(threw === undefined, "🔴 OPE-2249 §9: the binding-bridge hook does NOT throw — eve 0.68+ logs and swallows a hook throw, so a throw here would refuse nothing");
    ok(child.cancels === 1, "🔴 OPE-2249 §9: the binding-bridge hook CANCELS the turn of a lost child at session.started — exactly once");
  });
  await inSession(async () => {
    const child = withCancel(makeChild({ oe_platform: "ope603a", oe_wake_id: "w", oe_grain: "task" }));
    await turnStarted(child);
    ok(child.cancels === 1, "🔴 OPE-2249 §9: …and at turn.started too, which is the edge a DELAYED child arrives on");
  });
  await inSession(async () => {
    let threw: string | undefined;
    const child = withCancel(makeChild(healedBagOut));
    try {
      if (dispatchBindingOut === undefined) throw new Error("missing dispatch binding fixture");
      adoptDelegatedAuthority(
        { binding: dispatchBindingOut, requester: { kind: "requester", principalId: "P_A" }, nonMemberWake: false },
        undefined,
      );
      await sessionStarted(child);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    ok(threw === undefined, "🔴 OPE-681 §9 negative control: a child with adopted dispatch authority is NOT refused — the hook lets correct work through");
    ok(child.cancels === 0, "🔴 OPE-2249 §9 negative control: …and its turn is NOT cancelled, so the refusal is not firing on every child");
  });
}

{
  const { turnSurfaceMode } = await import("../agent/hooks/spend.js");
  const { maskedSurfaceKeyOf } = await import("../agent/spend/dm-mask.js");

  const PLATFORM = "provenance-probe";
  const mapperFor = (mode: "dm" | "channel" | undefined): IdentityMapper => () => ({
    workspace: "W1",
    surface: "S1",
    ...(mode === undefined ? {} : { mode }),
    visibility: "private",
    trust: "external",
    principalId: "U_P",
  });
  const ctx = { channel: { kind: PLATFORM } } as unknown as BindableContext;
  const surfaceKey = `${PLATFORM}/W1/S1`;

  registerIdentityMapper(PLATFORM, mapperFor("dm"));
  const resolvedDm = bindFrom(ctx);
  ok(resolvedDm.mode === "dm" && resolvedDm.modeResolved === true, "OPE-1867: a mapper that classifies the conversation marks the binding's mode RESOLVED");
  ok(turnSurfaceMode(ctx) === "dm", "OPE-1867: a resolved mode reaches the spend stamp, so the row is classifiable");
  ok(maskedSurfaceKeyOf({ surfaceKey, surfaceMode: turnSurfaceMode(ctx) }) === `${PLATFORM}/W1/(dms)`, "OPE-1867: a resolved DM masks into the (dms) bucket — the road still works");

  registerIdentityMapper(PLATFORM, mapperFor("channel"));
  const resolvedChannel = bindFrom(ctx);
  ok(resolvedChannel.mode === "channel" && resolvedChannel.modeResolved === true, "OPE-1867: a positively-identified room is RESOLVED too — the flag is about provenance, not about being a DM");
  ok(turnSurfaceMode(ctx) === "channel", "OPE-1867: a resolved channel still stamps 'channel'");
  ok(maskedSurfaceKeyOf({ surfaceKey, surfaceMode: turnSurfaceMode(ctx) }) === surfaceKey, "🔴 OPE-1867 NEGATIVE CONTROL: a resolved room still PUBLISHES its key — the fix narrowed the stamp, it did not mask everything");

  registerIdentityMapper(PLATFORM, mapperFor(undefined));
  const gapFilled = bindFrom(ctx);
  ok(gapFilled.mode === "channel", "OPE-1867: an unclassifiable conversation still gap-fills `channel` — every OTHER reader keeps a usable value, which is why this is a separate flag and not an optional mode");
  ok(gapFilled.modeResolved === undefined, "🔴 OPE-1867: …and the binding SAYS it was gap-filled, which is the fact nothing downstream could learn before");
  ok(turnSurfaceMode(ctx) === undefined, "🔴 OPE-1867: the spend stamp refuses a gap-filled mode — the row is written UNCLASSIFIED rather than as a room");
  ok(maskedSurfaceKeyOf({ surfaceKey, surfaceMode: turnSurfaceMode(ctx) }) === `${PLATFORM}/W1/(unclassified)`, "🔴 OPE-1867: so the report masks the surface instead of naming a conversation nothing could classify");

  const { turnKind } = await import("../agent/hooks/spend.js");
  ok(turnKind(ctx) === "unclassified", "🔴 OPE-1867: an unresolvable turn's ORIGIN TAG says unclassified, not 'channel'");
  ok(
    maskedSurfaceKeyOf({ surfaceKey, ...(turnSurfaceMode(ctx) ? { surfaceMode: turnSurfaceMode(ctx)! } : {}), kind: turnKind(ctx) }) === `${PLATFORM}/W1/(unclassified)`,
    "🔴 OPE-1867: the WHOLE row — stamp and origin tag together, exactly as the spend hook writes it — masks. This is the assertion the mode-only fix passed while the surface was still published.",
  );

  registerIdentityMapper(PLATFORM, mapperFor("channel"));
  ok(turnKind(ctx) === "channel", "🔴 OPE-1867 NEGATIVE CONTROL: a RESOLVED room still tags 'channel', so the legacy fallback keeps working and reports keep naming real rooms");
  registerIdentityMapper(PLATFORM, mapperFor("dm"));
  ok(turnKind(ctx) === "dm", "OPE-1867 NEGATIVE CONTROL: a resolved DM still tags 'dm'");
  registerIdentityMapper(PLATFORM, mapperFor(undefined));

  ok(!("modeResolved" in gapFilled), "OPE-1867: a gap-filled binding OMITS the key rather than carrying `false` — one spelling, so a deep-equal over a binding is stable");

  const { isFrozenSurfaceBinding } = await import("../agent/identity/frozen-surface-binding.internal.js");
  ok(isFrozenSurfaceBinding({ ...resolvedDm, modeResolved: true }), "🔴 OPE-1867: the frozen-binding grammar ADMITS modeResolved — an unlisted key is rejected outright, so omitting it here would silently drop every frozen binding");
  ok(!isFrozenSurfaceBinding({ ...resolvedDm, modeResolved: false }), "OPE-1867: the grammar refuses `false` — true-or-absent, like principalAttested");
  ok(isFrozenSurfaceBinding({ ...gapFilled, principalId: "U_P" }), "OPE-1867: a gap-filled binding freezes fine without the key");
}

console.log(`✓ identity: ${passed} assertions passed`);

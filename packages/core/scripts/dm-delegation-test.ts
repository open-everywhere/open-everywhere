import assert from "node:assert/strict";

const __slackStubs = await import("./_slack-test-stubs.js");
__slackStubs.registerSlackFixtureMapper();
__slackStubs.registerSlackFixtureCodec();

delete process.env.OE_ORG;
delete process.env.OE_ONESHOT_AGENT;

import {
  DM_ANCHOR_DOMAIN_PREFIX,
  DM_ANCHOR_GENERATION,
  classifySessionId,
  dmAnchorDomain,
  dmAnchorWindowKey,
  dmSurfaceKeyFromAnchorDomain,
  formatWindowToken,
  isDmAnchorDomain,
  isDmAnchoredTaskToken,
  isTaskWindowToken,
  parseWindowToken,
  sessionGrantKeyFromToken,
  taskWindowId,
} from "../agent/channels/window-key.js";
import { assertDomainsValid, defineDomain, domainForChannel } from "../agent/memory/domain.js";
import { canDelegateFromSeat, resolveDmDelegationAnchor } from "../agent/access/delegation-mount.js";
import { DM_SEAT_CARVE_IN, LEAN_SEAT_TOOLS, allowedOnLeanSeat, resolveLeanSeatPosture, restrictToolsetForLeanSeat } from "../agent/access/lean-seat.js";
import { memoryRecallRouteFor } from "../agent/access/window-gate-manifest.js";
import { workerOnlyTools } from "../agent/access/worker-capabilities.js";
import { OE_ONESHOT_AGENT_ENV } from "../agent/access/delegation-flag.js";
import { registerIdentityMapper } from "../agent/identity/binding.js";
import { registerWakeOriginCodec } from "../agent/channels/wake-origin-codec.js";
import type { BindableContext } from "../agent/identity/binding.js";

let n = 0;
const ok = (cond: boolean, label: string) => { assert.ok(cond, label); n++; };
const eq = (a: unknown, b: unknown, label: string) => { assert.deepStrictEqual(a, b, label); n++; };
const throws = (fn: () => unknown, label: string) => { assert.throws(fn); n++; };

async function withEnv<T>(key: string, value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

function seatCtx(opts: { channelId: string; channelType?: string; token?: string; threadTs?: string; userId?: string }): BindableContext {
  const attributes: Record<string, string> = {
    team_id: "T1",
    channel_id: opts.channelId,
    user_id: opts.userId ?? "U_ASKER",
    dm_partner_trust: "internal",
    trust_checked: "true",
    is_ext_shared: "false",
    oe_platform: "slack",
    oe_grain: "standing",
  };
  if (opts.channelType) attributes["channel_type"] = opts.channelType;
  if (opts.threadTs) attributes["thread_ts"] = opts.threadTs;
  return {
    channel: { kind: "slack", continuationToken: opts.token ?? "" },
    session: { id: `sess-${opts.channelId}`, auth: { current: { principalId: opts.userId ?? "U_ASKER", attributes } } },
  } as unknown as BindableContext;
}

const DM_SURFACE_KEY = "slack/T1/D_ASKER";
const DM_TOKEN = "slack:D_ASKER:oe-dm:g2";

const TARGETY_PLATFORM = "oe-test-targety";
const DM_FLAGGED_PLATFORM = "oe-test-dmflag";
const ARMLESS_PLATFORM = "oe-test-armless";
const NOCODEC_PLATFORM = "oe-test-nocodec";

interface StubRaw {
  readonly surface: string;
  readonly mode: "dm" | "mpim" | "channel";
  readonly target?: Record<string, unknown>;
  readonly threadTs?: string;
  readonly workspace?: string;
}

function stubCtx(platform: string, raw: StubRaw, token = ""): BindableContext {
  return {
    channel: { kind: platform, continuationToken: token },
    session: {
      id: `sess-${raw.surface}`,
      auth: { current: { principalId: "U_STUB", attributes: { oe_platform: platform, oe_grain: "standing", stub_raw: JSON.stringify(raw) } } },
    },
  } as unknown as BindableContext;
}

for (const platform of [TARGETY_PLATFORM, DM_FLAGGED_PLATFORM, ARMLESS_PLATFORM, NOCODEC_PLATFORM]) {
  registerIdentityMapper(platform, (c) => {
    const a = (c.session?.auth?.current?.attributes ?? {}) as Record<string, string>;
    const raw = JSON.parse(a["stub_raw"] ?? "{}") as StubRaw;
    return {
      workspace: raw.workspace ?? "W1",
      surface: raw.surface,
      mode: raw.mode,
      visibility: "private",
      trust: "internal",
      trustVerified: true,
      principalId: "U_STUB",
      target: raw.target,
      threadTs: raw.threadTs,
    };
  });
}

const registerStubCodec = (platform: string, codec: Record<string, unknown>): void =>
  registerWakeOriginCodec(platform as "slack", codec as never);

const stubDerivations = {
  validate: () => true,
  threadRef: (o: { channelId?: string; conversationId?: string }) => ({ channelKey: `stub/${o.channelId ?? o.conversationId}`, threadKey: `${o.channelId ?? o.conversationId}` }),
  isThreadScoped: () => false,
  containerId: (o: { channelId?: string; conversationId?: string }) => `${o.channelId ?? o.conversationId}`,
};

registerStubCodec(TARGETY_PLATFORM, {
  ...stubDerivations,
  dmOrigin: (b: { target?: Record<string, unknown> }) => {
    const serviceUrl = b.target?.["serviceUrl"];
    const conversationId = b.target?.["conversationId"];
    return typeof serviceUrl === "string" && serviceUrl.length > 0 && typeof conversationId === "string" && conversationId.length > 0
      ? { platform: TARGETY_PLATFORM, serviceUrl, conversationId }
      : undefined;
  },
});

registerStubCodec(DM_FLAGGED_PLATFORM, {
  ...stubDerivations,
  dmOrigin: (b: { target?: Record<string, unknown> }) => {
    const channelId = b.target?.["channelId"];
    return typeof channelId === "string" && channelId.length > 0 ? { platform: DM_FLAGGED_PLATFORM, channelId, dm: true } : undefined;
  },
});

registerStubCodec(ARMLESS_PLATFORM, { ...stubDerivations });

console.log("1. token grammar (dm anchor pseudo-domain):");
{
  const domain = dmAnchorDomain(DM_SURFACE_KEY);
  eq(domain, `${DM_ANCHOR_DOMAIN_PREFIX}${DM_SURFACE_KEY}`, "dmAnchorDomain prefixes the surface key with the reserved namespace");
  ok(isDmAnchorDomain(domain), "isDmAnchorDomain recognises its own mint");
  eq(dmSurfaceKeyFromAnchorDomain(domain), DM_SURFACE_KEY, "the inversion recovers the EXACT surface key (the dispatch carve-in matches on it)");

  ok(!isDmAnchorDomain("payments"), "a plain domain name is not an anchor");
  eq(dmSurfaceKeyFromAnchorDomain("payments"), undefined, "the inversion answers undefined for a real domain name");
  ok(!isDmAnchorDomain(DM_ANCHOR_DOMAIN_PREFIX), "the bare prefix with no surface key is NOT an anchor (it names nothing)");
  eq(dmSurfaceKeyFromAnchorDomain(undefined), undefined, "the inversion is fail-soft on a non-string");

  throws(() => dmAnchorDomain("slack/T1/D:1"), "dmAnchorDomain THROWS on a colon-bearing surface key");
  throws(() => dmAnchorDomain(""), "dmAnchorDomain THROWS on an empty surface key");

  const key = dmAnchorWindowKey(DM_SURFACE_KEY);
  eq(key.generation, DM_ANCHOR_GENERATION, "a DM anchor's generation is the constant");
  eq(DM_ANCHOR_GENERATION, 0, "…and the constant is 0 — UNREACHABLE by rotateChannelSession, which mints >= 1, so an anchor token can never collide with a rotated one");
  eq(key.windowId, key.domain, "the anchor key is DEGENERATE (windowId === domain) — the spawn replaces the windowId with a task one");

  const workerToken = formatWindowToken({ domain: key.domain, windowId: taskWindowId("slack/D_ASKER", "D_ASKER", "nonce1"), generation: key.generation });
  const parsed = parseWindowToken(workerToken);
  eq(parsed?.domain, key.domain, "a DM-anchored worker token round-trips its pseudo-domain through the ordinary window parse");
  eq(parsed?.generation, 0, "…and its generation");
  ok(isTaskWindowToken(workerToken), "a DM-anchored worker token is a TASK window token — the grain matrix is untouched");
  eq(classifySessionId(workerToken).kind, "task", "classifySessionId gives it the EXISTING task arm — the reserved namespace lives INSIDE the domain field, it is not a new session kind");
  eq(classifySessionId(workerToken).grain, "task", "…with the task grain, so the worker keeps the full kit exactly like any other worker");
  ok(isDmAnchoredTaskToken(workerToken), "isDmAnchoredTaskToken recognises it");
  ok(isDmAnchoredTaskToken(`unified:${workerToken}`), "…including through eve's `unified:` send prefix");

  const domainWorker = formatWindowToken({ domain: "payments", windowId: taskWindowId("slack/C1", "17.5", "n"), generation: 3 });
  ok(!isDmAnchoredTaskToken(domainWorker), "a NAMED-domain worker token is not DM-anchored");
  const anchorStanding = formatWindowToken(key);
  ok(!isDmAnchoredTaskToken(anchorStanding), "a STANDING window on an anchor domain is NOT a DM-anchored TASK token — the predicate is grain-specific, so a DM's seat can never be mistaken for one of its workers");
  ok(!isDmAnchoredTaskToken("D_ASKER:oe-dm:g2"), "a DM-SEAT token is not a DM-anchored worker token");
  ok(!isDmAnchoredTaskToken(undefined), "fail-soft on a non-string");

  eq(sessionGrantKeyFromToken(workerToken), anchorStanding, "a DM-anchored worker's session-grant key collapses to the ANCHOR (per-DM grant scope, not per-worker)");
}

console.log("2. reserved-namespace exclusivity:");
{
  assertDomainsValid([defineDomain({ name: "payments", channels: ["slack/T1/C1"] })]);
  n++;
  throws(
    () => assertDomainsValid([defineDomain({ name: `${DM_ANCHOR_DOMAIN_PREFIX}slack/T1/D_ASKER`, channels: ["slack/T1/C1"] })]),
    "assertDomainsValid REFUSES a domain name in the reserved oe-dm/ namespace — the exclusivity that makes the inversion unambiguous",
  );
  try {
    assertDomainsValid([defineDomain({ name: "oe-dm/x", channels: ["slack/T1/C1"] })]);
    assert.fail("expected a throw");
  } catch (e) {
    ok(String((e as Error).message).includes(DM_ANCHOR_DOMAIN_PREFIX), "…and it names the reserved prefix in the error, so an operator can act on it");
  }
}

console.log("3. anchor resolution:");
await withEnv(OE_ONESHOT_AGENT_ENV, "1", () => {
  const dm = seatCtx({ channelId: "D_ASKER", channelType: "im", token: DM_TOKEN });
  const anchor = resolveDmDelegationAnchor(dm);
  ok(anchor !== undefined, "a 1:1 DM root resolves a delegation anchor");
  eq(anchor?.surfaceKey, DM_SURFACE_KEY, "…keyed on the DM's OWN partition surface key");
  eq(anchor?.key.domain, dmAnchorDomain(DM_SURFACE_KEY), "…and its pseudo-domain is derived from exactly that key");
  eq(anchor?.origin, { platform: "slack", channelId: "D_ASKER" }, "…with an origin derived from the binding by the platform's dmOrigin codec arm (no stored wake row — a DM has none)");
  ok(canDelegateFromSeat(dm), "canDelegateFromSeat flips TRUE for a DM root — the OPE-301 lean filter narrows it from here with no edit of its own");

  const groupDm = seatCtx({ channelId: "G_TEAM", channelType: "mpim", token: "slack:G_TEAM:oe-dm:g1", userId: "U_SENDER" });
  const groupAnchor = resolveDmDelegationAnchor(groupDm);
  ok(groupAnchor !== undefined, "a GROUP DM (mpim) root resolves an anchor too — the same class of closed conversation");
  eq(groupAnchor?.surfaceKey, "slack/T1/G_TEAM", "…on the group DM's own surface key");
  eq((groupDm.session?.auth?.current?.attributes as Record<string, string>)["user_id"], "U_SENDER", "a group-DM turn's acting principal is the VERIFIED SENDER (host-stamped), which is what the worker inherits — never the room");

  const threaded = resolveDmDelegationAnchor(seatCtx({ channelId: "D_ASKER", channelType: "im", token: DM_TOKEN, threadTs: "1720.5" }));
  eq(threaded?.origin, { platform: "slack", channelId: "D_ASKER", threadTs: "1720.5" }, "a threaded DM turn carries its thread anchor into the origin, so the worker answers in the same thread");

  eq(resolveDmDelegationAnchor(seatCtx({ channelId: "C1", channelType: "channel", token: "slack:C1:oe-sup:g1" })), undefined, "a CHANNEL standing root is not a DM anchor");
  eq(
    resolveDmDelegationAnchor(seatCtx({ channelId: "D_ASKER", channelType: "im", token: `unified:${formatWindowToken({ domain: "payments", windowId: "payments", generation: 3 })}` })),
    undefined,
    "a seat that HAS a window token is never an anchor — the real window always wins",
  );
  eq(resolveDmDelegationAnchor({} as BindableContext), undefined, "an unreadable ctx resolves nothing (fail-closed — a mount predicate may not invent a seat)");
  eq(
    resolveDmDelegationAnchor(stubCtx(ARMLESS_PLATFORM, { surface: "D_ARMLESS", mode: "dm" })),
    undefined,
    "a DM on a platform whose codec has NO dmOrigin arm resolves nothing: omission is the fail-closed default",
  );
  eq(
    resolveDmDelegationAnchor(stubCtx(NOCODEC_PLATFORM, { surface: "D_NONE", mode: "dm" })),
    undefined,
    "…and so does a platform with no registered codec AT ALL (the registry miss is the same fail-closed answer)",
  );

  {
    const RAW_CONV = "19:1on1-frank@thread.v2;messageid=99";
    const ctx = stubCtx(TARGETY_PLATFORM, { surface: RAW_CONV, mode: "dm", target: { serviceUrl: "https://svc.example/", conversationId: RAW_CONV } });
    const anchor = resolveDmDelegationAnchor(ctx);
    ok(anchor !== undefined, "a conversation-reference platform's DM root resolves an anchor (the OPE-315 parity landing)");
    eq(anchor?.origin, { platform: TARGETY_PLATFORM, serviceUrl: "https://svc.example/", conversationId: RAW_CONV }, "…with the RAW conversation id off `target` — the address the reply actually needs");
    ok(anchor?.surfaceKey.includes(RAW_CONV) === false, "…and the surfaceKey is the SANITISED one, which is exactly why the origin could not have come from it");
    eq(resolveDmDelegationAnchor(stubCtx(TARGETY_PLATFORM, { surface: RAW_CONV, mode: "dm" })), undefined, "…and WITHOUT a target the same DM resolves nothing — the plumbing is load-bearing, not decorative");
  }

  {
    const dmCtx = stubCtx(DM_FLAGGED_PLATFORM, { surface: "D_DM", mode: "dm", target: { channelId: "D_DM" } });
    const anchor = resolveDmDelegationAnchor(dmCtx);
    eq(anchor?.origin, { platform: DM_FLAGGED_PLATFORM, channelId: "D_DM", dm: true }, "a discriminated DM-variant origin rides through the resolver with its discriminant intact");
    eq(anchor?.surfaceKey, `${DM_FLAGGED_PLATFORM}/W1/D_DM`, "…anchored on the DM's OWN surface key (the pseudo-domain is surface-derived on every platform alike)");
    ok(canDelegateFromSeat(dmCtx), "…so a DM root on a variant platform can delegate, exactly like a Slack one");
    ok(resolveDmDelegationAnchor(stubCtx(DM_FLAGGED_PLATFORM, { surface: "G_GRP", mode: "mpim", target: { channelId: "G_GRP" } })) !== undefined, "…and so does a group DM (mpim)");
    eq(resolveDmDelegationAnchor(stubCtx(DM_FLAGGED_PLATFORM, { surface: "C_ENG", mode: "channel", target: { channelId: "C_ENG" } })), undefined, "…while a CHANNEL binding on that same platform resolves nothing");
  }

  eq(memoryRecallRouteFor("standing", ["task"], true, canDelegateFromSeat(dm)), "agent", "the memory index now names a REAL route on a DM seat (it said \"none\" before — the honest dead end OPE-299 wrote)");
  eq(memoryRecallRouteFor("standing", ["task"], true, false), "none", "…and still says \"none\" for a seat with no route at all");
});

await withEnv(OE_ONESHOT_AGENT_ENV, undefined, () => {
  const dm = seatCtx({ channelId: "D_ASKER", channelType: "im", token: DM_TOKEN });
  ok(resolveDmDelegationAnchor(dm) !== undefined, "the RESOLVER itself is flag-free (it is a pure identity question)");
  ok(!canDelegateFromSeat(dm), "but canDelegateFromSeat's DM arm is FLAG-GATED: flag-OFF a DM root still cannot delegate — the anchor widened `agent`'s wall, NOT spawn_task's, so mounting there would be the dead affordance OPE-299 removed");
  eq(memoryRecallRouteFor("standing", ["task"], false, canDelegateFromSeat(dm)), "none", "…so the flag-off memory index is byte-identical to before");
  eq(resolveLeanSeatPosture({ grain: "standing", canDelegate: canDelegateFromSeat(dm), unattendedFire: false }), "full", "…and the flag-off lean filter still leaves a DM seat whole");
});

console.log("4. inherit-never-escalate:");
{
  const domains = [defineDomain({ name: "payments", channels: ["slack/T1/C1"], ambientSupervisor: true, mode: "unified" })];
  const anchorDomain = dmAnchorDomain(DM_SURFACE_KEY);
  ok(anchorDomain !== "payments", "a DM's anchor domain is not the named domain that exists in config");
  eq(domainForChannel(DM_SURFACE_KEY, domains), undefined, "the DM's own surface is in NO domain's channel roster — so a DM-spawned worker, whose binding resolves off that surface, picks up no named domain's bundle grants");
  eq(domainForChannel(anchorDomain, domains), undefined, "and the anchor domain matches no roster either — the channel→domain hop can never turn it into a real domain");
  eq(domains.find((d) => d.name === anchorDomain), undefined, "…nor is it a domain by name (assertDomainsValid refuses the namespace, §2)");
  eq(domainForChannel("slack/T1/C1", domains), domains[0], "…while a real channel still resolves its real domain (no over-reach in the other direction)");

  const discordDmKey = "discord/U_bob/D_bob";
  const discordGuildDomains = [defineDomain({ name: "eng", channels: ["discord/G_ACME/C_ENG"], mode: "unified" })];
  const discordAnchorDomain = dmAnchorDomain(discordDmKey);
  eq(domainForChannel(discordDmKey, discordGuildDomains), undefined, "a DISCORD DM surface (workspace = the caller's user id, not a guild) is in no domain's roster either");
  eq(domainForChannel(discordAnchorDomain, discordGuildDomains), undefined, "…and its anchor domain matches no roster — the channel→domain hop cannot turn a per-user DM key into a guild domain");
  eq(domainForChannel("discord/G_ACME/C_ENG", discordGuildDomains), discordGuildDomains[0], "…while the real GUILD channel still resolves its domain (the DM key did not shadow it)");
  ok(discordAnchorDomain !== dmAnchorDomain(DM_SURFACE_KEY), "…and two platforms' DM anchors are distinct domains — the pseudo-domain carries the platform, so a Slack DM and a Discord DM never share a partition");
}

console.log("5. lean-seat interplay:");
{
  eq(resolveLeanSeatPosture({ grain: "standing", canDelegate: true, unattendedFire: false }), "lean", "a DELEGATING standing seat is narrowed — which now includes an armed DM root, with NO edit to the filter itself");

  for (const name of DM_SEAT_CARVE_IN) {
    ok(!LEAN_SEAT_TOOLS.has(name), `${name} is NOT in the seat-independent roster (a channel seat could never call it — the DM wall refuses)`);
    ok(!allowedOnLeanSeat(name), `a narrowed CHANNEL standing seat does NOT hold ${name}`);
    ok(allowedOnLeanSeat(name, true), `a narrowed DM seat DOES hold ${name} — an interactive challenge verb cannot be relocated to a one-shot worker`);
  }
  eq([...DM_SEAT_CARVE_IN].sort(), ["confirm_link", "link_identity", "unlink_identity"], "the carve-in is EXACTLY the identity trio — nothing else is seat-shaped");

  ok(!allowedOnLeanSeat("remember", true), "a DM seat does NOT keep `remember` — the memory write relocates cleanly (the worker inherits the DM binding, so its trust gate is the same one)");
  ok(!allowedOnLeanSeat("connection_search", true), "…nor `connection_search` — a DM-spawned worker inherits mode \"dm\", so the DM-only connector wall passes inside it");
  ok(!allowedOnLeanSeat("aws", true) && !allowedOnLeanSeat("notion__search", true), "…nor anything else: default-deny is unchanged for a DM seat");
  ok(allowedOnLeanSeat("reply", true) && allowedOnLeanSeat("agent", true), "the base roster still applies on a DM seat");

  const toolset: Record<string, unknown> = { reply: {}, no_reply: {}, agent: {}, remember: {}, aws: {}, link_identity: {}, confirm_link: {}, unlink_identity: {}, notion__search: {} };
  const dmSet = { ...toolset };
  const removedOnDm = restrictToolsetForLeanSeat(dmSet, true);
  eq(Object.keys(dmSet).sort(), ["agent", "confirm_link", "link_identity", "no_reply", "reply", "unlink_identity"], "a delegating DM seat keeps the speak verbs, the delegation verb AND the identity trio");
  ok(removedOnDm.includes("remember") && removedOnDm.includes("aws") && removedOnDm.includes("notion__search"), "…and loses everything worker-shaped");

  const channelSet = { ...toolset };
  restrictToolsetForLeanSeat(channelSet);
  eq(Object.keys(channelSet).sort(), ["agent", "no_reply", "reply"], "a delegating CHANNEL standing seat does NOT get the trio — the carve-in is a property of the seat, not of the tools");

  const workerOnly = workerOnlyTools("standing");
  for (const name of DM_SEAT_CARVE_IN) {
    ok(!workerOnly.includes(name), `the worker-capability index does NOT list ${name} as routable — an interactive challenge is not a thing a leaf worker can carry out`);
  }
  ok(workerOnly.includes("remember") && workerOnly.includes("connection_search"), "…while everything that genuinely DOES relocate is still listed (the index stays a complete routing table)");
}

console.log(`\n✓ dm-delegation: ${n} assertions passed (OPE-306 token grammar · namespace exclusivity · anchor resolution · inherit-never-escalate · lean-seat interplay)`);

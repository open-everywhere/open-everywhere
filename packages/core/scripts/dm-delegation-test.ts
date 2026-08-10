import assert from "node:assert/strict";

const __slackStubs = await import("./_slack-test-stubs.js");
__slackStubs.registerSlackFixtureMapper();
__slackStubs.registerSlackFixtureCodec();

delete process.env.OE_ORG;
process.env.OE_ONESHOT_AGENT = "0";

import {
  DM_ANCHOR_DOMAIN_PREFIX,
  DM_ANCHOR_GENERATION,
  classifySessionId,
  dmAnchorDomain,
  dmAnchorWindowKey,
  dmAnchorSurfaceForToken,
  dmSurfaceKeyFromAnchorDomain,
  dmWindowKey,
  isDmAnchorWindowToken,
  formatWindowToken,
  isDmAnchorDomain,
  isDmAnchoredTaskToken,
  isTaskWindowToken,
  parseWindowToken,
  sessionGrantKeyFromToken,
  taskWindowId,
} from "../agent/channels/window-key.js";
import { assertDomainsValid, defineDomain, domainForChannel } from "../agent/memory/domain.js";
import { canDelegateFromSeat } from "../agent/access/delegation-mount.js";
import { DM_SEAT_CARVE_IN, LEAN_SEAT_TOOLS, allowedOnLeanSeat, resolveLeanSeatPosture, restrictToolsetForLeanSeat } from "../agent/access/lean-seat.js";
import { memoryRecallRouteFor } from "../agent/access/window-gate-manifest.js";
import { workerOnlyTools } from "../agent/access/worker-capabilities.js";
import { OE_ONESHOT_AGENT_ENV } from "../agent/access/delegation-flag.js";
import { bindFrom } from "../agent/identity/binding.js";
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

console.log("3. delegation predicate (window token, no anchor):");
{
  const dmWindowSeat = seatCtx({ channelId: "D_ASKER", channelType: "im", token: `unified:${formatWindowToken(dmWindowKey(DM_SURFACE_KEY, 4))}` });
  ok(canDelegateFromSeat(dmWindowSeat), "a first-class DM WINDOW seat can delegate — through the window arm, the only arm");
  eq(memoryRecallRouteFor("standing", ["task"], true, canDelegateFromSeat(dmWindowSeat)), "agent", "…and the memory index names that real route");

  const dmNativeSeat = seatCtx({ channelId: "D_ASKER", channelType: "im", token: DM_TOKEN });
  ok(!canDelegateFromSeat(dmNativeSeat), "a DM on a NATIVE token CANNOT delegate — the OPE-306 anchor arm is gone (OPE-368), so a seat with no window token has no route");
  eq(memoryRecallRouteFor("standing", ["task"], true, canDelegateFromSeat(dmNativeSeat)), "none", "…and the memory index says \"none\" rather than naming a verb that would throw");
  eq(resolveLeanSeatPosture({ grain: "standing", canDelegate: canDelegateFromSeat(dmNativeSeat), unattendedFire: false }), "full", "…and the lean filter leaves it WHOLE — a seat that cannot delegate keeps what it would have delegated (access/lean-seat.ts property 1)");
  const groupNativeSeat = seatCtx({ channelId: "G_TEAM", channelType: "mpim", token: "slack:G_TEAM:oe-dm:g1", userId: "U_SENDER" });
  ok(!canDelegateFromSeat(groupNativeSeat), "…and a GROUP DM on a native token is the same answer (the anchor served both, and serves neither now)");

  ok(!canDelegateFromSeat(seatCtx({ channelId: "C1", channelType: "channel", token: "slack:C1:oe-sup:g1" })), "a per-container CHANNEL standing root still cannot delegate (OPE-299, unchanged)");

  ok(canDelegateFromSeat(seatCtx({ channelId: "D_ASKER", channelType: "im", token: "" })), "a BLANK token fails OPEN — no readable identity is the §S3 degradation, not a \"not a window seat\" signal");
  ok(canDelegateFromSeat({} as BindableContext), "…and so does a wholly unreadable ctx");
}

for (const flag of ["1", "0"]) {
  await withEnv(OE_ONESHOT_AGENT_ENV, flag, () => {
    const win = seatCtx({ channelId: "D_ASKER", channelType: "im", token: `unified:${formatWindowToken(dmWindowKey(DM_SURFACE_KEY, 4))}` });
    const native = seatCtx({ channelId: "D_ASKER", channelType: "im", token: DM_TOKEN });
    ok(canDelegateFromSeat(win), `OE_ONESHOT_AGENT=${flag}: a DM WINDOW seat delegates`);
    ok(!canDelegateFromSeat(native), `OE_ONESHOT_AGENT=${flag}: a NATIVE-token DM does not — the predicate has no flag-gated arm left`);
  });
}

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

console.log("6. OPE-351 fences (capacity only — nothing mints a DM window token yet):");
{
  const dmWindow = formatWindowToken(dmWindowKey(DM_SURFACE_KEY, 3));

  ok(isDmAnchorWindowToken(dmWindow), "the DM SEAT window is recognised as such");
  ok(!isDmAnchoredTaskToken(dmWindow), "…and is NOT a DM-anchored worker (so ownership/recursion routing can't confuse the two)");
  const dmWorker = formatWindowToken({ domain: dmAnchorDomain(DM_SURFACE_KEY), windowId: taskWindowId("slack/D_ASKER", "D_ASKER", "n1"), generation: DM_ANCHOR_GENERATION });
  ok(isDmAnchoredTaskToken(dmWorker) && !isDmAnchorWindowToken(dmWorker), "…and the reverse holds for a worker — the two predicates partition the pseudo-domain");
  eq(dmAnchorSurfaceForToken(dmWindow), dmAnchorSurfaceForToken(dmWorker), "both resolve the SAME admission surface — a DM's seat and its workers are deliverable to exactly one place, that DM");

  const named = [defineDomain({ name: "payments", channels: ["slack/T1/C_PAY"], mode: "unified" })];
  eq(domainForChannel(parseWindowToken(dmWindow)!.domain, named), undefined, "a DM SEAT window's domain matches no configured domain — the seat inherits the DM's partition, never a named domain's grants");
  eq(domainForChannel(DM_SURFACE_KEY, named), undefined, "…and the DM surface it names is in no roster either (both halves of the fence)");

  ok(sessionGrantKeyFromToken(dmWorker).startsWith(`oe-dom:${dmAnchorDomain(DM_SURFACE_KEY)}:`), "a DM worker's session-grant key still collapses onto the DM's own pseudo-domain");
  eq(sessionGrantKeyFromToken(dmWindow), dmWindow, "…and a DM SEAT window keys as itself, so its grants rotate with its generation like any standing seat's");
}

console.log("7. OPE-351 stage 4 — a group DM on a window token:");
await withEnv(OE_ONESHOT_AGENT_ENV, "1", () => {
  const MPIM_SURFACE_KEY = "slack/T1/G_TEAM";
  const mpimSeat = seatCtx({ channelId: "G_TEAM", channelType: "mpim", token: `unified:${formatWindowToken(dmWindowKey(MPIM_SURFACE_KEY, 2))}`, userId: "U_SENDER" });

  eq(bindFrom(mpimSeat).mode, "mpim", "🔴 a first-classed group DM still binds mode `mpim` — the divert stamps channel_type on the wake auth, so the mode is invariant across the re-seat even though the token is not");

  ok(canDelegateFromSeat(mpimSeat), "a first-classed group DM delegates through the WINDOW arm — the affordance moved off the retired anchor, it did not disappear");

  const dmSeatBit = bindFrom(mpimSeat).mode === "dm" || bindFrom(mpimSeat).mode === "mpim";
  ok(dmSeatBit, "the hooks/lean-seat.ts DM bit (mode-keyed) is TRUE for the group-DM window seat");
  for (const name of DM_SEAT_CARVE_IN) {
    ok(allowedOnLeanSeat(name, dmSeatBit), `…so a narrowed group-DM window seat still holds ${name} — the interactive trio no worker can carry`);
  }

  eq(memoryRecallRouteFor("standing"), "agent", "a standing seat's recall route is delegation (unchanged) — the group DM's own memory verdict is mode-keyed and stays NONE (scripts/memory-resolve-test.ts)");

  eq(dmAnchorSurfaceForToken(mpimSeat.channel!.continuationToken), MPIM_SURFACE_KEY, "the admission seam strips eve's `unified:` prefix and recovers the group DM's OWN surface — byte-exact, on the live spelling");
  ok(dmAnchorSurfaceForToken(mpimSeat.channel!.continuationToken) !== DM_SURFACE_KEY, "…never a 1:1 DM's surface in the same workspace");
});

console.log(`\n✓ dm-delegation: ${n} assertions passed (OPE-306 token grammar · namespace exclusivity · delegation predicate (window-only, no anchor) · inherit-never-escalate · lean-seat interplay · OPE-351 fences · stage-4 group-DM window composition)`);

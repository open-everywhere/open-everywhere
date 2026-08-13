import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-native-subagent-")), "ops.sqlite3");
process.env.OE_WORKSPACE = "dev";

const __slackStubs = await import("./_slack-test-stubs.js");
__slackStubs.registerSlackFixtureMapper();

import {
  bindFrom,
  channelPlatform,
  currentTurnAddressed,
  currentTurnAddressing,
  currentWakeId,
  isSubagentChildContext,
  proposingSessionId,
  subagentParentSessionId,
  windowGrainOf,
  SUBAGENT_CHANNEL_KIND,
  type BindableContext,
} from "../agent/identity/binding.js";
import { OE_SPAWN_TAINTED_ATTR } from "../agent/channels/unified.js";
import { canDelegateFromSeat, resolveOwnWindowToken } from "../agent/access/delegation-mount.js";
import { resolveLeanSeatPosture } from "../agent/access/lean-seat.js";
import { SETTINGS, getSettings, nativeSubagentAtBuild, registerSettings, resetSettingsForTest } from "../agent/settings/settings.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (actual: unknown, expected: unknown, label: string) => {
  assert.deepStrictEqual(actual, expected, label);
  n++;
};

const PARENT_TOKEN = "oe-dom:e2e-unified:oe-sup:g1784858540866-a6cc41";
const PARENT_ATTRS = {
  oe_platform: "slack",
  oe_grain: "standing",
  oe_window_token: PARENT_TOKEN,
  oe_wake_id: "wake_probe_393",
  oe_addressing: "direct-mention",
  oe_addressed: "1",
  team_id: "T0EXAMPLE",
  channel_id: "C0EXCHAN003",
  trust_checked: "true",
} as const;

const parentCtx = {
  channel: { kind: "channel:slack", continuationToken: `unified:${PARENT_TOKEN}` },
  session: { id: "sess-parent", auth: { current: { attributes: { ...PARENT_ATTRS }, principalId: "UPROBE393", principalType: "slack-user" } } },
} as unknown as BindableContext;

const childCtx = {
  channel: { kind: "subagent", continuationToken: "subagent:sess-parent:call_1" },
  session: {
    id: "sess-child",
    parent: { sessionId: "sess-parent", callId: "call_1", rootSessionId: "sess-parent", turn: { id: "turn_1", sequence: 1 } },
    auth: { current: { attributes: { ...PARENT_ATTRS }, principalId: "UPROBE393", principalType: "slack-user" } },
  },
} as unknown as BindableContext;

const childToolCtx = {
  session: {
    id: "sess-child",
    parent: { sessionId: "sess-parent", callId: "call_1", rootSessionId: "sess-parent" },
    auth: { current: { attributes: { ...PARENT_ATTRS }, principalId: "UPROBE393", principalType: "slack-user" } },
  },
} as unknown as BindableContext;

const childResolverCtx = {
  channel: { kind: "subagent", continuationToken: "subagent:sess-parent:call_1" },
  session: { id: "sess-child", auth: { current: { attributes: { ...PARENT_ATTRS } } } },
} as unknown as BindableContext;

const unstampedChildCtx = {
  channel: { kind: "subagent", continuationToken: "subagent:sess-parent:call_2" },
  session: {
    id: "sess-child-unstamped",
    parent: { sessionId: "sess-parent", callId: "call_2" },
    auth: { current: { attributes: { team_id: "T0EXAMPLE", channel_id: "C0EXCHAN003" } } },
  },
} as unknown as BindableContext;

ok(isSubagentChildContext(childCtx), "a hook-shaped child context is recognised (kind + parent + token all agree)");
ok(isSubagentChildContext(childToolCtx), "🔴 a TOOL context is recognised through `session.parent` alone — eve gives a tool execute no channel, so a kind-only predicate would miss every tool call in a child");
ok(isSubagentChildContext(childResolverCtx), "🔴 a DYNAMIC-RESOLVER context is recognised through kind/token alone — eve does not expose `session.parent` there, so a parent-only predicate would miss every mount decision");
ok(!isSubagentChildContext(parentCtx), "a root session is NOT a child — no false positive from an ordinary standing seat");
ok(!isSubagentChildContext({} as BindableContext), "an empty context is not a child (fail-soft, never throws)");
ok(subagentParentSessionId(childCtx) === "sess-parent", "the typed linkage names the parent session");
ok(subagentParentSessionId(parentCtx) === undefined, "…and is absent on a root run");
ok(SUBAGENT_CHANNEL_KIND === "subagent", "the framework channel kind constant matches eve's FRAMEWORK_CHANNEL_KINDS spelling");

ok(channelPlatform(childCtx) === "slack", "🔴 D1: a child's channelPlatform resolves the PARENT's origin platform from the inherited oe_platform stamp — not the literal `subagent` kind");
ok(channelPlatform(unstampedChildCtx) === "subagent", "🔴 D1 FAIL-CLOSED: with no inherited stamp it stays `subagent` — no mapper, so bindFrom falls through to bindLocal exactly as any unknown kind does; never a GUESSED platform");

{
  const parent = bindFrom(parentCtx);
  const child = bindFrom(childCtx);
  eq(
    { platform: child.platform, workspace: child.workspace, surface: child.surface, mode: child.mode, visibility: child.visibility, trust: child.trust, principalId: child.principalId },
    { platform: parent.platform, workspace: parent.workspace, surface: parent.surface, mode: parent.mode, visibility: parent.visibility, trust: parent.trust, principalId: parent.principalId },
    "🔴 D1: a native child binds IDENTICALLY to its parent — workspace, surface, mode, visibility, trust AND principal. This is the invariant the shared sandbox makes load-bearing (hooks/egress.ts asserts it at runtime)",
  );
  ok(child.platform === "slack" && child.workspace === "T0EXAMPLE" && child.surface === "C0EXCHAN003", "…and the values are the PARENT's real surface, so connector grants / memory / egress / spend all resolve against it");

  ok(channelPlatform(childToolCtx) === undefined || channelPlatform(childToolCtx) !== "slack", "a child TOOL context carries no channel, so channelPlatform cannot hop directly — the binding bridge is what heals it, and the bridge re-enters this function with kind `subagent`");
}

{
  const unstamped = bindFrom(unstampedChildCtx);
  ok(unstamped.platform === "subagent", `🔴 D1 RED (the pre-fix world, still the answer when nothing stamped the origin): platform "subagent" (got "${unstamped.platform}")`);
  ok(unstamped.workspace === "dev", `…workspace literally "dev" — bindLocal's OE_WORKSPACE stand-in, NOT the unnamed-tenant literal (got "${unstamped.workspace}"; correcting the first written account of this bug)`);
  ok(unstamped.surface === "default", "…surface `default`");
  ok(unstamped.principalId === undefined, "…and NO principal — which is why its spend rows were unattributed as well as mis-partitioned (OPE-394)");
  ok(unstamped.trust === "external", "…and trust fails CLOSED to external, so the memory gate grants it nothing");
}

ok(windowGrainOf(parentCtx) === "standing", "the parent is a STANDING seat (the stamp, corroborated by its window token)");
ok(windowGrainOf(childCtx) === "task", "🔴 D3a: the child overrides the inherited `standing` stamp to TASK — measured 2026-08-11, without this the child ran LEAN and was stripped to the conversational roster, i.e. a worker with no hands");
ok(windowGrainOf(childToolCtx) === "task", "…in a tool context too (the linkage arm)");
ok(windowGrainOf(childResolverCtx) === "task", "…and in a resolver context (the kind/token arm), which is where the MOUNT decision is made");
ok(windowGrainOf(unstampedChildCtx) === "task", "🔴 D3a, the other direction: a child with NOTHING inherited is still `task` — the override is positive, not a correction of a bad stamp");
ok(
  resolveLeanSeatPosture({ grain: windowGrainOf(childCtx), canDelegate: canDelegateFromSeat(childCtx), unattendedFire: false }) === "full",
  "🔴 D3a consequence: a child is therefore never narrowed to the lean roster — `task` is not a conversational-root grain, so it keeps the full worker kit",
);

ok(resolveOwnWindowToken(childCtx) === PARENT_TOKEN, "🔴 the measured hazard, reproduced: a child RESOLVES ITS PARENT'S WINDOW TOKEN verbatim (via the inherited oe_window_token attr) — so nothing token-derived can tell them apart");
ok(canDelegateFromSeat(parentCtx), "the parent can delegate (it is a real window seat)");
ok(!canDelegateFromSeat(childCtx), "🔴 D3b: the child CANNOT — the leaf rule refuses on the host-set subagent signal, ahead of the token read that would otherwise say yes and mint a worker whose completion wakes a conversation that never asked");
ok(!canDelegateFromSeat(childToolCtx), "…in a tool context (where `agent`'s execute-time wall lives)");
ok(!canDelegateFromSeat(childResolverCtx), "…and in a resolver context (where the mount predicate runs)");

ok(currentWakeId(parentCtx) === "wake_probe_393", "the parent holds this turn's wake id");
ok(currentWakeId(childCtx) === undefined, "🔴 D3c: the child holds NONE — the inherited stamp is the parent's (measured: the child's turn.tool_gated rows carried the parent's wakeId), so a child with `reply` had a valid address into the human's thread");
ok(currentWakeId(childToolCtx) === undefined, "…in a tool context too, which is where `reply` actually reads it");
ok(currentTurnAddressing(parentCtx) === "direct-mention", "the parent's turn was addressed");
ok(currentTurnAddressing(childCtx) === undefined, "🔴 D3c: the child's is neutralised — nobody addressed the child, it was handed a brief");
ok(currentTurnAddressed(parentCtx), "…the boolean form agrees on the parent");
ok(!currentTurnAddressed(childCtx), "…and is false in the child, which is the fail-closed direction for its one consumer (the relaxed link-claim recogniser)");

{
  const { enforceEgress } = await import("../agent/hooks/egress.js");
  const { egressPolicyFingerprint } = await import("../agent/hooks/egress.js");

  const policy = { allow: { "api.example.com": [{ match: { method: ["GET"] } }] } } as never;
  const scope = () => ({ org: "default", platform: "slack", workspace: "T0EXAMPLE", surface: "C0EXCHAN003", principalId: "UPROBE393" });
  const baseDeps = (parentFingerprint: string | undefined | (() => Promise<string | undefined>)) => {
    const applied: unknown[] = [];
    return {
      applied,
      deps: {
        resolve: () => ({}) as never,
        compile: async () => policy,
        apply: async (p: unknown) => void applied.push(p),
        lastApplied: () => undefined,
        rememberApplied: () => undefined,
        lastConnectors: () => undefined,
        rememberConnectors: () => undefined,
        scope,
        audit: async () => undefined,
        stamp: () => undefined,
        stampConnectorContentOrigin: () => undefined,
        parentPublishedFingerprint:
          typeof parentFingerprint === "function" ? parentFingerprint : async () => parentFingerprint,
      },
    };
  };

  const ownFingerprint = egressPolicyFingerprint(policy);

  const match = baseDeps(ownFingerprint);
  const matched = await enforceEgress("session.started", match.deps as never);
  ok(matched.abortError === undefined && match.applied.length === 1, "🔴 D5: a child whose compiled policy MATCHES what its parent published applies normally — post-hop the two bindings are identical, so the re-apply is idempotent rather than destructive");

  const diverge = baseDeps("d228cd75deadbeef");
  const diverged = await enforceEgress("session.started", diverge.deps as never);
  ok(diverged.abortError !== undefined, "🔴 D5: a DIVERGENT fingerprint FAILS the child (fail-closed) — the measured clobber was a mis-bound child replacing its parent's published firewall state mid-turn in the sandbox they share");
  ok(diverge.applied.length === 0, "…and NOTHING was applied: the check runs before the apply, the publish and the stamp, so a violating child touches the shared sandbox not at all");
  ok(diverged.abortError!.message.includes("identical-binding invariant VIOLATED"), "…with the message the turn.started edge keys its one re-throw on");

  const unreadable = baseDeps(undefined);
  const unread = await enforceEgress("session.started", unreadable.deps as never);
  ok(unread.abortError === undefined && unreadable.applied.length === 1, "🔴 D5 fail direction: an ABSENT parent fingerprint is NOT a violation — an unpublished parent or an unreadable diagnostics file must never take a child down, and the invariant can only be asserted where both sides are readable");

  const throwing = baseDeps(async () => {
    throw new Error("sandbox gone");
  });
  const threw = await enforceEgress("session.started", throwing.deps as never);
  ok(threw.abortError === undefined && throwing.applied.length === 1, "…and a THROWING read degrades the same way, for the same reason");

  const root = baseDeps(undefined);
  const rootDeps = { ...root.deps } as Record<string, unknown>;
  delete rootDeps.parentPublishedFingerprint;
  const rootRes = await enforceEgress("session.started", rootDeps as never);
  ok(rootRes.abortError === undefined && root.applied.length === 1, "a root session's deps carry no parentPublishedFingerprint, so the tripwire costs it not even a read");
}

ok(SETTINGS.delegation.nativeSubagent.shipped === true, "🔴 D6 (OPE-396): the shipped default is ON — a fresh clone gets eve-native delegation, which is what we run");
{
  const spec = SETTINGS.delegation.nativeSubagent as { env?: string; parseEnv?: unknown };
  ok(spec.env === undefined, "🔴 D6 (OPE-411): the setting declares NO env override — the off-only kill switch is deleted, not merely undocumented");
  ok(spec.parseEnv === undefined, "…and no parser either, which is the STRUCTURAL half: there is nothing for a string to be read by");
}
{
  resetSettingsForTest();
  ok(getSettings({}).delegation.nativeSubagent === true, "…so with nothing registered the resolved value is the shipped ON");
  ok(getSettings({ OE_NATIVE_SUBAGENT: "0" }).delegation.nativeSubagent === true, "🔴 D6: `OE_NATIVE_SUBAGENT=0` no longer disarms anything — the deleted mirror is inert in BOTH directions");
  registerSettings({ delegation: { nativeSubagent: false } });
  ok(getSettings({}).delegation.nativeSubagent === false, "…and a REGISTERED override is what disarms it, which is the only route left");
  ok(getSettings({ OE_NATIVE_SUBAGENT: "1" }).delegation.nativeSubagent === false, "…with no environment able to pull it back either");
  resetSettingsForTest();
}
{
  ok(nativeSubagentAtBuild({}) === true, "🔴 D6 BUILD (OPE-396): with no app override the build-time value is the shipped ON ⇒ roster.config.ts omits the `agent` disable sentinel ⇒ eve's built-in IS injected");
  ok(nativeSubagentAtBuild({ delegation: { nativeSubagent: false } }) === false, "…and an app override in agent/settings.ts is what RE-EMITS it — a reviewed diff, paired with `oe build --accept` in the same PR");
  const saved = process.env.OE_NATIVE_SUBAGENT;
  process.env.OE_NATIVE_SUBAGENT = "0";
  ok(nativeSubagentAtBuild({}) === true, "🔴 D6: the BUILD resolver is ENV-BLIND — a stray OE_NATIVE_SUBAGENT in whoever ran `oe build --accept` must never rewrite the committed roster.lock.json for everyone else. (Since OPE-411 the RUNTIME resolver is env-blind too, so this now pins the weaker of two walls — it stays because roster.lock.json is a committed artefact and that argument is independent of the mirrors.)");
  if (saved === undefined) delete process.env.OE_NATIVE_SUBAGENT;
  else process.env.OE_NATIVE_SUBAGENT = saved;
}

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};
function inSession<T>(fn: () => T): T {
  return contextStorage.run(new ContextContainer(), fn);
}

{
  const { projectToolSet } = await import("../agent/access/untrusted-projection.js");
  const { setNativeDelegationSeat, nativeAgentAllowedNow } = await import("../agent/access/native-delegation-state.js");
  const { markUntrustedIngestedThisTurn } = await import("../agent/access/taint-signal.js");
  const { resolveWindowGated } = await import("../agent/access/window-gated.js");

  const makeToolset = () => ({ agent: { execute: () => undefined }, reply: { execute: () => undefined }, no_reply: { execute: () => undefined } });

  registerSettings({ delegation: { nativeSubagent: false } });
  inSession(() => {
    setNativeDelegationSeat("no-seat");
    const toolset = makeToolset();
    projectToolSet(toolset as unknown as Record<string, unknown>);
    ok("agent" in toolset, "🔴 D6 OFF: with the regime disarmed the projection seam never withdraws `agent` — the world is byte-identical, and the slot is not even read");
  });

  resetSettingsForTest();
  ok(getSettings({}).delegation.nativeSubagent === true, "the SHIPPED default is what the remaining legs run under (no override needed since OPE-396)");

  inSession(() => {
    setNativeDelegationSeat("allow");
    ok(nativeAgentAllowedNow(), "an allowed seat on a clean turn may hold the built-in");
    const toolset = makeToolset();
    projectToolSet(toolset as unknown as Record<string, unknown>);
    ok("agent" in toolset, "🔴 D6 ARMED, CLEAN: a delegating conversational seat keeps `agent`, and it is eve's built-in — OE mounts nothing under that name (a dynamic `agent` would COLLIDE with the runtime-visible subagent and throw)");
  });

  inSession(() => {
    setNativeDelegationSeat("allow");
    markUntrustedIngestedThisTurn();
    eq(nativeAgentAllowedNow(), true, "🔴 D6 TAINT IS NOT A CONJUNCT (OPE-471): a tainted turn KEEPS its delegation verb, because the forward leg stamps the child's opening auth — asserted `=== true`, not merely truthy");
    const toolset = makeToolset();
    projectToolSet(toolset as unknown as Record<string, unknown>);
    ok("agent" in toolset, "…and the projection seam leaves `agent` in place on a tainted turn");
    ok("reply" in toolset && "no_reply" in toolset, "…with nothing else touched either");
  });

  inSession(() => {
    setNativeDelegationSeat("no-seat");
    markUntrustedIngestedThisTurn();
    eq(nativeAgentAllowedNow(), false, "🔴 D6 SEAT HALF STILL FIRES: an unclassified seat is refused `agent` on the same tainted turn — so (c) reads 'taint stopped gating', never 'the gate is dead'");
    const toolset = makeToolset();
    projectToolSet(toolset as unknown as Record<string, unknown>);
    ok(!("agent" in toolset), "…and the projection seam really removes it");
  });

  inSession(() => {
    setNativeDelegationSeat("leaf");
    const toolset = makeToolset();
    projectToolSet(toolset as unknown as Record<string, unknown>);
    ok(!("agent" in toolset), "🔴 D6 LEAF: a native child never sees `agent` — eve blocks its own built-in's recursion, and this is the belt (the roll-own route is closed separately by canDelegateFromSeat)");
  });

  inSession(() => {
    setNativeDelegationSeat("leaf");
    const toolset: Record<string, unknown> = {
      agent: { execute: () => undefined },
      describe_image: { execute: () => undefined },
      read_file_upload: { execute: () => undefined },
      bash: { execute: () => undefined },
      post_file: { execute: () => undefined },
      return_result: { execute: () => undefined },
    };
    projectToolSet(toolset);
    eq(Object.keys(toolset).sort(), ["bash", "describe_image", "post_file", "read_file_upload", "return_result"], "🔴 D6 LEAF, WHOLE KIT: the leaf withdrawal removes `agent` and NOTHING ELSE — a native child keeps its vision read, its upload read, its sandbox and its return leg");
  });

  inSession(() => {
    const toolset = makeToolset();
    projectToolSet(toolset as unknown as Record<string, unknown>);
    ok(!("agent" in toolset), "🔴 D6 FAIL-CLOSED: a wake nothing classified loses `agent` — the OPPOSITE default from the lean slot next door, because a wrongly-allowed delegation route is worse than a turn that has to do its own work");
  });

  {
    const delegationKit = (await import("../agent/tools/delegation_tools.js")).default;
    const resolvedOnParent = await resolveWindowGated(delegationKit, parentCtx);
    ok(resolvedOnParent === null, "🔴 D6 THE COLLISION WALL: armed, OE's dynamic `agent` resolves to NOTHING even on a seat that would otherwise mount it. eve's harness/tool-loop.js throws `Dynamic tool \"agent\" collides with a runtime-visible subagent.` when a dynamic name meets the built-in's runtimeAction — a dynamic tool does NOT shadow the built-in, it kills the model call");
  }

  registerSettings({ delegation: { nativeSubagent: false } });
  ok(getSettings({}).delegation.nativeSubagent === false, "…and a registered disarm puts the regime back off for the remaining sections");

  {
    const delegationKit = (await import("../agent/tools/delegation_tools.js")).default;
    const resolved = (await resolveWindowGated(delegationKit, parentCtx)) as Record<string, unknown> | null;
    ok(resolved !== null && "agent" in resolved, "🔴 D6 OFF: disarmed, OE's roll-own `agent` mounts on a delegating standing seat — this is what disarming actually buys, asserted rather than argued");
    const shape = (resolved as Record<string, { inputSchema?: { shape?: Record<string, unknown> } }>).agent?.inputSchema?.shape ?? {};
    eq(Object.keys(shape).sort(), ["brief", "thread"], "🔴 OPE-396: the roll-own fallback is ASYNC-ONLY — no `mode` argument exists, so disarming the native route REMOVES synchronous delegation rather than restoring it");
    const onChild = await resolveWindowGated(delegationKit, childResolverCtx);
    ok(onChild === null, "…and it does NOT mount inside a native child, in either regime: `task` grain is not on the `agent` row of the window-gate manifest, and the leaf rule refuses underneath it");
  }
  resetSettingsForTest();
}

{
  const { markSubagentTainted, subagentWasTainted, subagentTaintKey, subagentCallTaintKey, subagentCallTaintStatus, claimSubagentCallClean, markSubagentCallTainted } =
    await import("../agent/access/subagent-taint.js");
  const { getOperationalStore } = await import("../agent/operational/provider.js");
  const { untrustedIngestedThisTurn, markUntrustedIngestedThisTurn } = await import("../agent/access/taint-signal.js");
  const spawnTaint = await import("../agent/hooks/spawn-taint.js");

  ok(subagentTaintKey("sess-child").startsWith("oe-subagent-taint:"), "the marker key is NAMESPACED, so it can never collide with a minted one-shot task token in the slice they share");

  ok(!(await subagentWasTainted("default", "sess-clean-child")), "an unmarked child reads as NOT tainted");
  await markSubagentTainted("default", "sess-dirty-child");
  ok(await subagentWasTainted("default", "sess-dirty-child"), "🔴 D7: a marked child reads back as tainted, durably and cross-session — the parent runs in a different session and cannot see the child's in-memory slot");
  ok(!(await subagentWasTainted("default", "sess-clean-child")), "…and the marker is per-child, not a global bit");

  const undelivered = await getOperationalStore().listUndeliveredTaskResults("default", PARENT_TOKEN, 50);
  ok(undelivered.every((r) => !r.taskId.startsWith("oe-subagent-taint:")), "🔴 D7: the marker carries NO callerToken, so it never appears in listUndeliveredTaskResults — it is a marker, not a result, and nothing will try to deliver it");

  ok(subagentCallTaintKey("sess-parent", "call_x").startsWith("oe-subagent-taint-by-call:"), "🔴 D7 OPE-437: the call-keyed marker is namespaced SEPARATELY from the session-keyed one, so the two rows for one delegation never collide");
  ok((await subagentCallTaintStatus("default", "sess-parent", "call_never_written")) === undefined, "🔴 D7 OPE-437: an unwritten call marker reads back `undefined`, distinct from `false` — this is the bit the fail-closed read below depends on");
  await claimSubagentCallClean("default", "sess-parent", "call_probe");
  eq(await subagentCallTaintStatus("default", "sess-parent", "call_probe"), false, "…a CLEAN claim reads back as the literal boolean `false`, not `undefined`");
  await markSubagentCallTainted("default", "sess-parent", "call_probe");
  eq(await subagentCallTaintStatus("default", "sess-parent", "call_probe"), true, "…and the tainted write (the flip observer's) overwrites it to `true`");

  await claimSubagentCallClean("default", "sess-parent", "call_probe");
  eq(await subagentCallTaintStatus("default", "sess-parent", "call_probe"), true, "🔴 D7 OPE-437 MONOTONIC: a CLEAN claim arriving AFTER a tainted write does NOT clobber it — the claim is put-if-absent, so the row settles on tainted whichever of the two lands last");

  const undeliveredCall = await getOperationalStore().listUndeliveredTaskResults("default", PARENT_TOKEN, 50);
  ok(undeliveredCall.every((r) => !r.taskId.startsWith("oe-subagent-taint-by-call:")), "…and the call-keyed row is ALSO invisible to the undelivered-result reader, same reasoning as the session-keyed one");

  await (async () => {
    const childHookCtx = { ...(childCtx as unknown as Record<string, unknown>), agent: { name: "oe", nodeId: "__root__" } };
    inSession(() => {
      spawnTaint.openTaintTurn(childHookCtx as never);
      markUntrustedIngestedThisTurn();
    });
    await new Promise((r) => setTimeout(r, 50));
    ok(await subagentWasTainted("default", "sess-child"), "🔴 D7 CHILD SIDE: a child that taints itself persists the session-keyed marker at MARK time, through the taint-signal flip observer — no dependence on any child lifecycle event");
    eq(await subagentCallTaintStatus("default", "sess-parent", "call_1"), true, "🔴 D7 OPE-437 CHILD SIDE: the SAME flip ALSO persists the call-keyed marker, addressed by the PARENT's own session id + callId taken from `ctx.session.parent` — no `subagent.called` event involved anywhere in this path");
  })();

  await (async () => {
    const seededChildHookCtx = {
      channel: { kind: "subagent", continuationToken: "subagent:sess-parent:call_seeded" },
      session: {
        id: "sess-seeded-child",
        parent: { sessionId: "sess-parent", callId: "call_seeded", rootSessionId: "sess-parent", turn: { id: "turn_1", sequence: 1 } },
        auth: { current: { attributes: { ...PARENT_ATTRS, oe_result_tainted: "true" }, principalId: "UPROBE393", principalType: "slack-user" } },
      },
      agent: { name: "oe", nodeId: "__root__" },
    };
    inSession(() => {
      spawnTaint.openTaintTurn(seededChildHookCtx as never);
      ok(untrustedIngestedThisTurn(), "precondition: the seed attribute taints the child INSIDE openTaintTurn — the clean claim and the tainted write are issued on the same tick");
    });
    await new Promise((r) => setTimeout(r, 50));
    eq(await subagentCallTaintStatus("default", "sess-parent", "call_seeded"), true, "🔴 D7 OPE-437 SAME TICK: a child tainted from its very first turn settles the call marker on TAINTED — the eager clean claim cannot win the race, because it is put-if-absent and the tainted write is an upsert");
  })();

  inSession(() => {
    const parentHookCtx = { ...(parentCtx as unknown as Record<string, unknown>), agent: { name: "oe", nodeId: "__root__" } };
    spawnTaint.openTaintTurn(parentHookCtx as never);
    markUntrustedIngestedThisTurn();
  });
  await new Promise((r) => setTimeout(r, 50));
  ok(!(await subagentWasTainted("default", "sess-parent")), "…and a ROOT session's own taint writes no session-keyed marker: one slot read, no I/O, on every ordinary turn in the deployment");

  await (async () => {
    let adopted = false;
    await contextStorage.run(new ContextContainer(), async () => {
      const parentHookCtx = { ...(parentCtx as unknown as Record<string, unknown>), agent: { name: "oe", nodeId: "__root__" } };
      spawnTaint.openTaintTurn(parentHookCtx as never);
      ok(!untrustedIngestedThisTurn(), "the parent's turn starts CLEAN");
      adopted = await spawnTaint.adoptSubagentTaint("call_1", "sess-parent");
      ok(untrustedIngestedThisTurn(), "🔴 D7 PARENT SIDE: a TAINTED child's result marks the parent's own turn — the subagent-result lands RAW in the parent's history with no toModelOutput seam (OPE-73 class), so without this the parent would `remember`, `create_routine` and `create_skill` over hostile-derived prose with a clean signal");
    });
    eq(adopted, true, "…and the adoption reports that it fired");
  })();

  await contextStorage.run(new ContextContainer(), async () => {
    const cleanChildHookCtx = {
      channel: { kind: "subagent", continuationToken: "subagent:sess-parent:call_clean" },
      session: {
        id: "sess-clean-child-2",
        parent: { sessionId: "sess-parent", callId: "call_clean", rootSessionId: "sess-parent", turn: { id: "turn_1", sequence: 1 } },
        auth: { current: { attributes: { ...PARENT_ATTRS }, principalId: "UPROBE393", principalType: "slack-user" } },
      },
      agent: { name: "oe", nodeId: "__root__" },
    };
    inSession(() => spawnTaint.openTaintTurn(cleanChildHookCtx as never));
    await new Promise((r) => setTimeout(r, 50));
    eq(await subagentCallTaintStatus("default", "sess-parent", "call_clean"), false, "the eager claim leaves a POSITIVE known-clean row for a child that never taints");

    const parentHookCtx = { ...(parentCtx as unknown as Record<string, unknown>), agent: { name: "oe", nodeId: "__root__" } };
    spawnTaint.openTaintTurn(parentHookCtx as never);
    const adopted = await spawnTaint.adoptSubagentTaint("call_clean", "sess-parent");
    eq(adopted, false, "🔴 D7 NEGATIVE CONTROL: a CLEAN child does NOT taint the parent — asserted `=== false`, not merely falsy or absent");
    eq(untrustedIngestedThisTurn(), false, "…and the parent's own turn signal reads `=== false` too — the bit is the child's own judgement about its own turn, and over-tainting is the failure mode OPE-299 removed");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    ok((await subagentCallTaintStatus("default", "sess-parent", "call_lost")) === undefined, "…precondition: no marker exists for this call at all — the exact 'signal cannot be established' case");
    const parentHookCtx = { ...(parentCtx as unknown as Record<string, unknown>), agent: { name: "oe", nodeId: "__root__" } };
    spawnTaint.openTaintTurn(parentHookCtx as never);
    ok(!untrustedIngestedThisTurn(), "the parent's turn starts CLEAN");
    const adopted = await spawnTaint.adoptSubagentTaint("call_lost", "sess-parent");
    eq(adopted, true, "🔴 D7 OPE-437 FAIL CLOSED: a subagent-result whose taint record was lost marks the parent tainted — the return leg no longer answers 'not tainted' for a signal it could not establish");
    eq(untrustedIngestedThisTurn(), true, "…and the parent's own turn signal is set, so every downstream consequential sink (remember, create_routine, create_skill) gates as if the parent had read untrusted content");
  });
}

{
  const { subagentTaintKey, subagentCallTaintKey } = await import("../agent/access/subagent-taint.js");
  const { untrustedIngestedThisTurn, markUntrustedIngestedThisTurn } = await import("../agent/access/taint-signal.js");
  const spawnTaint = await import("../agent/hooks/spawn-taint.js");
  const { readFileSync } = await import("node:fs");

  const ATTR = spawnTaint.OE_PARENT_TURN_TAINTED_ATTR;

  const hook = spawnTaint.default as unknown as {
    events: {
      "turn.started": (event: unknown, ctx: unknown) => Promise<void> | void;
      "action.result": (event: unknown, ctx: unknown) => Promise<void> | void;
    };
  };
  const turnStarted = (ctx: unknown) => hook.events["turn.started"](undefined, ctx);

  const fwdCtx = (input: {
    id: string;
    turn?: { id: string; sequence: number };
    parent?: { sessionId: string; callId: string; turn: { id: string; sequence: number } };
    attributes?: Record<string, string>;
  }) => ({
    channel:
      input.parent === undefined
        ? { kind: "channel:slack", continuationToken: `unified:${PARENT_TOKEN}` }
        : { kind: "subagent", continuationToken: `subagent:${input.parent.sessionId}:${input.parent.callId}` },
    session: {
      id: input.id,
      ...(input.turn !== undefined ? { turn: input.turn } : {}),
      ...(input.parent !== undefined
        ? { parent: { sessionId: input.parent.sessionId, callId: input.parent.callId, rootSessionId: input.parent.sessionId, turn: input.parent.turn } }
        : {}),
      auth: { current: { attributes: { ...PARENT_ATTRS, ...(input.attributes ?? {}) } as Record<string, unknown>, principalId: "UPROBE393", principalType: "slack-user" } },
    },
    agent: { name: "oe", nodeId: "__root__" },
  });

  const bagOf = (ctx: ReturnType<typeof fwdCtx>): Record<string, unknown> => ctx.session.auth.current.attributes;

  {
    const dist = (rel: string) => readFileSync(join(eveRoot, "dist/src", rel), "utf8");

    const keys = dist("context/keys.js");
    ok(
      keys.includes("AuthKey=new ContextKey(`eve.auth`)"),
      "🔴 D9 TRIPWIRE 1/4: eve declares `AuthKey` with NO CODEC, so `serializeContext` passes the auth object through unchanged (`context/serialize.js`: `t[n.name]=n.codec?n.codec.serialize(r):r`). A codec here would copy or transform the bag and the stamp would stop travelling",
    );

    const provider = dist("context/providers/session.js");
    const bound = /let (\w+)=\w+\.require\(AuthKey\)/.exec(provider);
    ok(bound !== null, "🔴 D9 TRIPWIRE 2/4a: `sessionProvider.create` still resolves the session's auth from the `AuthKey` context value");
    ok(
      bound !== null && provider.includes(`auth:{current:${bound[1]},`),
      "🔴 D9 TRIPWIRE 2/4b: …and hands that value out as `session.auth.current` BY REFERENCE, which is what makes `ctx.session.auth.current.attributes` the same bag eve later serializes",
    );
    ok(
      !provider.includes("attributes"),
      "🔴 D9 TRIPWIRE 2/4c: …and it does not touch `attributes` at all — no freeze, no copy. `Object.freeze` there is shallow today; a deep freeze or a spread would kill the carriage silently",
    );

    const dispatch = dist("execution/dispatch-runtime-actions-step.js");
    ok(
      dispatch.includes("deserializeContext(") && dispatch.includes("serializedContext") && dispatch.includes("get(AuthKey)"),
      "🔴 D9 TRIPWIRE 3/4: the dispatch step still builds the child's auth from the PARENT's serialized context (`deserializeContext(e.serializedContext)` then `.get(AuthKey)`) — NOT from the tool call, which is why a hook can reach it and a tool cannot",
    );

    const subagentTool = dist("execution/subagent-tool.js");
    const authParam = /,auth:(\w+),batchEvent:/.exec(subagentTool);
    ok(authParam !== null, "🔴 D9 TRIPWIRE 4/4a: `buildSubagentRunInput` still destructures an `auth` input");
    ok(
      authParam !== null && subagentTool.includes(`,auth:${authParam[1]},capabilities:`),
      "🔴 D9 TRIPWIRE 4/4b: …and puts it into the child's `runInput.auth` verbatim, with no filtering of the attributes bag",
    );

    const steps = dist("execution/workflow-steps.js");
    eq(
      steps.split("set(AuthKey,").length - 1,
      1,
      "🔴 D9 TRIPWIRE, TURN SCOPING: `AuthKey` is written in exactly ONE place in the turn step, the `deliver` arm. A second writer would mean the bag can be replaced mid-turn and the stamp could vanish before dispatch",
    );
    ok(
      /kind===`deliver`&&[^;]*auth!==void 0&&\w+\.set\(AuthKey,/.test(steps),
      "…and that one writer fires only on a delivery that CARRIES auth — which is why a new turn gets a fresh bag and last turn's stamp does not survive it (measured on the real host, OPE-471)",
    );
  }

  await contextStorage.run(new ContextContainer(), async () => {
    const parent = fwdCtx({ id: "sess-fwd-parent", turn: { id: "turn_7", sequence: 7 }, attributes: { oe_result_tainted: "true" } });
    await turnStarted(parent);
    ok(untrustedIngestedThisTurn(), "precondition: the seed attribute tainted the parent's turn — synchronously, inside openTaintTurn");
    eq(
      bagOf(parent)[ATTR],
      "sess-fwd-parent|turn_7",
      "🔴 D9 PARENT SIDE: a tainted turn stamps `<sessionId>|<turnId>` onto its OWN auth attributes — the bag eve copies verbatim into every native child it dispatches",
    );
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const clean = fwdCtx({ id: "sess-fwd-clean", turn: { id: "turn_1", sequence: 1 } });
    await turnStarted(clean);
    eq(untrustedIngestedThisTurn(), false, "the clean parent's own turn signal reads `=== false`");
    eq(bagOf(clean)[ATTR], undefined, "🔴 D9 NEGATIVE CONTROL: a CLEAN turn writes NO stamp — asserted `=== undefined`, not merely falsy");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const mid = fwdCtx({ id: "sess-fwd-midturn", turn: { id: "turn_2", sequence: 2 } });
    await turnStarted(mid);
    eq(bagOf(mid)[ATTR], undefined, "precondition: the turn started clean and stamped nothing");
    markUntrustedIngestedThisTurn("web");
    eq(
      bagOf(mid)[ATTR],
      "sess-fwd-midturn|turn_2",
      "🔴 D9 PARENT SIDE, MID-TURN: a taint arriving after the turn began stamps the bag too, through the taint-signal flip observer — SYNCHRONOUSLY, so it is in place before the next model call can emit a delegation",
    );
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const again = fwdCtx({ id: "sess-fwd-again", turn: { id: "turn_5", sequence: 5 } });
    await turnStarted(again);
    markUntrustedIngestedThisTurn("web");
    eq(spawnTaint.recordTurnTaintForChildren(), true, "🔴 D9: a second writer for the same turn reports the stamp in place rather than skipping — the `action.result` belt is never a lie");
    eq(bagOf(again)[ATTR], "sess-fwd-again|turn_5", "…and the bag still carries exactly one stamp, of identical bytes");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const cleanWriter = fwdCtx({ id: "sess-fwd-clean-writer", turn: { id: "turn_6", sequence: 6 } });
    await turnStarted(cleanWriter);
    eq(spawnTaint.recordTurnTaintForChildren(), false, "🔴 D9: the writer refuses on a CLEAN turn even when called directly — asserted `=== false`");
    eq(bagOf(cleanWriter)[ATTR], undefined, "…and stamps nothing");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const child = fwdCtx({
      id: "sess-fwd-child",
      turn: { id: "turn_0", sequence: 0 },
      parent: { sessionId: "sess-fwd-parent", callId: "call_f1", turn: { id: "turn_7", sequence: 7 } },
      attributes: { [ATTR]: "sess-fwd-parent|turn_7" },
    });
    await turnStarted(child);
    eq(
      untrustedIngestedThisTurn(),
      true,
      "🔴 D9 CHILD SIDE: a child whose opening auth names the parent turn that dispatched it ADOPTS that turn's taint at `turn.started` — the launder path (untrusted content → parent brief → child acts on a clean signal) closed on the native route",
    );
  });

  {
    let stamped: Record<string, unknown> = {};
    await contextStorage.run(new ContextContainer(), async () => {
      const parent = fwdCtx({ id: "sess-fwd-journey", turn: { id: "turn_3", sequence: 3 } });
      await turnStarted(parent);
      markUntrustedIngestedThisTurn("web");
      stamped = { ...bagOf(parent) };
    });
    ok(stamped[ATTR] !== undefined, "precondition: the parent turn stamped its bag");
    await contextStorage.run(new ContextContainer(), async () => {
      const child = fwdCtx({
        id: "sess-fwd-journey-child",
        turn: { id: "turn_0", sequence: 0 },
        parent: { sessionId: "sess-fwd-journey", callId: "call_j1", turn: { id: "turn_3", sequence: 3 } },
        attributes: stamped as Record<string, string>,
      });
      await turnStarted(child);
      eq(untrustedIngestedThisTurn(), true, "🔴 D9 JOURNEY: the bag a tainted parent turn stamped, copied verbatim as eve copies it, taints the child that receives it");
    });
  }

  await contextStorage.run(new ContextContainer(), async () => {
    const child = fwdCtx({
      id: "sess-fwd-child-2",
      turn: { id: "turn_0", sequence: 0 },
      parent: { sessionId: "sess-fwd-clean", callId: "call_f2", turn: { id: "turn_1", sequence: 1 } },
    });
    await turnStarted(child);
    eq(untrustedIngestedThisTurn(), false, "🔴 D9 NEGATIVE CONTROL: a child of a CLEAN parent turn carries no stamp and does NOT adopt — asserted `=== false`, not merely falsy");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const wrongTurn = fwdCtx({
      id: "sess-fwd-wrong-turn",
      turn: { id: "turn_0", sequence: 0 },
      parent: { sessionId: "sess-fwd-parent", callId: "call_f6", turn: { id: "turn_8", sequence: 8 } },
      attributes: { [ATTR]: "sess-fwd-parent|turn_7" },
    });
    await turnStarted(wrongTurn);
    eq(
      untrustedIngestedThisTurn(),
      false,
      "🔴 D9 DISCRIMINATOR, TURN HALF: a stamp naming turn_7 does NOT taint a child dispatched from turn_8 of the same session — this is what stops a stale stamp re-tainting a later turn",
    );
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const wrongSession = fwdCtx({
      id: "sess-fwd-wrong-session",
      turn: { id: "turn_0", sequence: 0 },
      parent: { sessionId: "sess-fwd-other", callId: "call_f7", turn: { id: "turn_7", sequence: 7 } },
      attributes: { [ATTR]: "sess-fwd-parent|turn_7" },
    });
    await turnStarted(wrongSession);
    eq(
      untrustedIngestedThisTurn(),
      false,
      "🔴 D9 DISCRIMINATOR, SESSION HALF: a stamp naming another session's turn_7 does not taint. Both halves are load-bearing — eve mints `turn.id` as `turn_<sequence>`, so EVERY session's first turn is `turn_0`",
    );
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const root = fwdCtx({ id: "sess-fwd-root", turn: { id: "turn_9", sequence: 9 }, attributes: { [ATTR]: "sess-fwd-root|turn_8" } });
    await turnStarted(root);
    eq(untrustedIngestedThisTurn(), false, "🔴 D9: a session with NO `session.parent` never adopts, whatever its bag carries — the seat's own next turn and a roll-own worker are both this case");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const later = fwdCtx({
      id: "sess-fwd-persistent",
      turn: { id: "turn_3", sequence: 3 },
      parent: { sessionId: "sess-fwd-parent", callId: "call_f3", turn: { id: "turn_7", sequence: 7 } },
      attributes: { [ATTR]: "sess-fwd-parent|turn_7" },
    });
    await turnStarted(later);
    eq(untrustedIngestedThisTurn(), false, "🔴 D9: a persistent child's LATER turn does not re-adopt its dispatching turn's taint — the gate is the child's OWN `turn.sequence`");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const first = fwdCtx({
      id: "sess-fwd-persistent",
      turn: { id: "turn_0", sequence: 0 },
      parent: { sessionId: "sess-fwd-parent", callId: "call_f3", turn: { id: "turn_7", sequence: 7 } },
      attributes: { [ATTR]: "sess-fwd-parent|turn_7" },
    });
    await turnStarted(first);
    eq(untrustedIngestedThisTurn(), true, "…the SAME child on its FIRST turn adopts — the discriminator is the sequence, nothing else");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const arrayForm = fwdCtx({
      id: "sess-fwd-array",
      turn: { id: "turn_0", sequence: 0 },
      parent: { sessionId: "sess-fwd-parent", callId: "call_f8", turn: { id: "turn_7", sequence: 7 } },
    });
    bagOf(arrayForm)[ATTR] = ["sess-fwd-parent|turn_7"];
    await turnStarted(arrayForm);
    eq(untrustedIngestedThisTurn(), true, "🔴 D9: the ARRAY spelling of the stamp adopts too — eve can hand any attribute back as `string[]`");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const child = fwdCtx({
      id: "sess-fwd-child-3",
      turn: { id: "turn_0", sequence: 0 },
      parent: { sessionId: "sess-fwd-parent", callId: "call_f4", turn: { id: "turn_7", sequence: 7 } },
      attributes: { [ATTR]: "sess-fwd-parent|turn_7" },
    });
    await turnStarted(child);
    ok(untrustedIngestedThisTurn(), "precondition: the child adopted");
    eq(
      bagOf(child)[ATTR],
      "sess-fwd-child-3|turn_0",
      "🔴 D9 HOP: the adopting child OVERWRITES the inherited stamp with its OWN (session, turn) pair, in the same handler — so a grandchild inherits, and cannot instead match the GRANDPARENT's pair",
    );
  });

  const twoKeys = [subagentTaintKey("A"), subagentCallTaintKey("A", "B")];
  ok(
    twoKeys.every((a, i) => twoKeys.every((b, j) => i === j || (!a.startsWith(b) && !b.startsWith(a)))),
    "🔴 D9: the two return-leg marker keys are mutually non-prefixing, so one delegation's rows can never be mistaken for each other",
  );

  registerSettings({ taint: { mode: "off" } });
  await contextStorage.run(new ContextContainer(), async () => {
    const child = fwdCtx({
      id: "sess-fwd-child-off",
      turn: { id: "turn_0", sequence: 0 },
      parent: { sessionId: "sess-fwd-parent", callId: "call_f5", turn: { id: "turn_7", sequence: 7 } },
      attributes: { [ATTR]: "sess-fwd-parent|turn_7" },
    });
    await turnStarted(child);
    eq(untrustedIngestedThisTurn(), false, "🔴 D9 OPE-399: `taint.mode: \"off\"` makes the forward adoption inert — the child of a tainted parent turn is not marked, which is the deployer's reviewed choice");
    eq(spawnTaint.adoptParentTurnTaint(child as never), false, "…asserted on the exported consumer too, `=== false`");
  });
  resetSettingsForTest();
}

ok(proposingSessionId(parentCtx) !== undefined, "the parent resolves a session-approval key (it has a window token)");
eq(
  proposingSessionId(childCtx),
  proposingSessionId(parentCtx),
  "🔴 D8: a native child keys the SAME session-approval memo as its parent — session grants are INHERITED, deliberately. One memo, so one revoke takes it back on both sides",
);
eq(proposingSessionId(childToolCtx), proposingSessionId(parentCtx), "…in a tool context too, which is where a card is actually consulted (open_pull_request, the connector write path)");
eq(
  proposingSessionId(childResolverCtx),
  proposingSessionId(parentCtx),
  "🔴 D8, and this one was a LIVE FIND: the answer is the same in EVERY context surface. Without the explicit subagent arm, a hook/resolver context's own `subagent:<parent>:<callId>` token won and the child keyed a DIFFERENT memo, while a tool context fell back to the inherited stamp and keyed the parent's — two answers for one session decided by who is asking",
);

{
  const memoryHook = (await import("../agent/hooks/memory.js")).default;
  const { registerConfig } = await import("../agent/access/config.js");
  const { registerProvider } = await import("../agent/memory/provider.js");

  const calls = { readTier: 0, ensureTier: 0, writeTier: 0 };
  const files: Record<string, string> = { "MEMORY.md": "# brain\n" };
  registerProvider({
    id: "ns-brain",
    async readTier() {
      calls.readTier++;
      return { ...files };
    },
    async ensureTier() {
      calls.ensureTier++;
      return { ...files };
    },
    async writeTier() {
      calls.writeTier++;
      return null;
    },
    async deleteTier() {},
  } as never);

  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [{ name: "ns", channels: ["slack/T0EXAMPLE/C0EXCHAN003"], memory: ["ns-brain-silo"] }],
    loadSilos: () => [{ name: "ns-brain-silo", provider: "ns-brain" }],
    domainsForSurface: () => ["ns"],
  } as never);

  class FakeSandbox {
    writes = 0;
    runs = 0;
    readonly store = new Map<string, string>();
    async writeTextFile({ path, content }: { path: string; content: string }): Promise<void> {
      this.writes++;
      this.store.set(path, content);
    }
    async readTextFile({ path }: { path: string }): Promise<string | null> {
      return this.store.get(path) ?? null;
    }
    async run(): Promise<{ stdout: string }> {
      this.runs++;
      return { stdout: "" };
    }
  }

  const hook = memoryHook as unknown as { events: Record<string, (e: unknown, ctx: unknown) => Promise<void> | void> };
  const withSandbox = (base: BindableContext, sandbox: FakeSandbox) => ({
    ...(base as unknown as Record<string, unknown>),
    agent: { name: "oe", nodeId: "__root__" },
    getSandbox: async () => sandbox,
  });

  const reset = () => {
    calls.readTier = 0;
    calls.ensureTier = 0;
    calls.writeTier = 0;
  };

  {
    reset();
    const sandbox = new FakeSandbox();
    await contextStorage.run(new ContextContainer(), async () => {
      await hook.events["session.started"]({ type: "session.started" }, withSandbox(parentCtx, sandbox) as never);
    });
    ok(calls.readTier + calls.ensureTier > 0 && sandbox.writes > 0, `the negative control works: a ROOT session DOES materialise (reads=${calls.readTier + calls.ensureTier}, sandbox writes=${sandbox.writes})`);
  }
  {
    reset();
    const sandbox = new FakeSandbox();
    await contextStorage.run(new ContextContainer(), async () => {
      await hook.events["session.completed"]({ type: "session.completed" }, withSandbox(parentCtx, sandbox) as never);
    });
    ok(calls.writeTier > 0, `…and a ROOT session DOES persist at session end (writeTier=${calls.writeTier})`);
  }

  {
    reset();
    const sandbox = new FakeSandbox();
    await contextStorage.run(new ContextContainer(), async () => {
      await hook.events["session.started"]({ type: "session.started" }, withSandbox(childCtx, sandbox) as never);
    });
    ok(
      calls.readTier === 0 && calls.ensureTier === 0 && sandbox.writes === 0,
      `🔴 D4: a native child MATERIALISES NOTHING — it inherits the parent's already-materialised tree. Re-pulling would write the host store's older bytes over the parent's UNPERSISTED in-sandbox edits, in the sandbox they share, mid-turn (reads=${calls.readTier + calls.ensureTier}, sandbox writes=${sandbox.writes})`,
    );
  }
  {
    reset();
    const sandbox = new FakeSandbox();
    await contextStorage.run(new ContextContainer(), async () => {
      await hook.events["session.completed"]({ type: "session.completed" }, withSandbox(childCtx, sandbox) as never);
    });
    ok(calls.writeTier === 0, `🔴 D4: a native child PERSISTS NOTHING — the parent owns its own tree, and a second writer through mergePreservingConflicts/guardDestructiveWrites (with a different sessionId and no baseline) would file the parent's in-flight edits as conflict siblings of themselves (writeTier=${calls.writeTier})`);
  }
  {
    reset();
    const sandbox = new FakeSandbox();
    await contextStorage.run(new ContextContainer(), async () => {
      await hook.events["session.failed"]({ type: "session.failed" }, withSandbox(childCtx, sandbox) as never);
    });
    ok(calls.writeTier === 0, "…on the FAILED edge too, which shares the same persist path");
  }

}

console.log(`✓ native-subagent: ${n} assertions passed`);

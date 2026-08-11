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
import { canDelegateFromSeat, resolveOwnWindowToken } from "../agent/access/delegation-mount.js";
import { resolveLeanSeatPosture } from "../agent/access/lean-seat.js";
import { SETTINGS, getSettings, nativeSubagentAtBuild } from "../agent/settings/settings.js";

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

ok(SETTINGS.delegation.nativeSubagent.shipped === false, "🔴 D6: the shipped default is OFF — everything below is behind it, and a fresh clone gets today's world byte-identical");
ok(SETTINGS.delegation.nativeSubagent.env === "OE_NATIVE_SUBAGENT", "…with the declared ops override name");
{
  const parse = SETTINGS.delegation.nativeSubagent.parseEnv;
  for (const off of ["", "0", "false", "off", "no", "OFF", " false "]) {
    ok(parse(off) === false, `🔴 D6: "${off}" resolves FALSE — the off vocabulary is a real, redeploy-free kill switch`);
  }
  for (const on of ["1", "true", "on", "yes", "banana"]) {
    ok(parse(on) === undefined, `🔴 D6: "${on}" FALLS THROUGH (undefined), it does not arm — arming has a BUILD half (the generated sentinel) that no env var can perform, so an env-armed setting on a sentinel'd tree would leave the seat with no delegation verb at all`);
  }
  ok(getSettings({}).delegation.nativeSubagent === false, "…and with a blank environment the resolved value is the shipped OFF");
  ok(getSettings({ OE_NATIVE_SUBAGENT: "1" }).delegation.nativeSubagent === false, "🔴 …so `OE_NATIVE_SUBAGENT=1` on a default deployment does NOT arm it (fall-through to the shipped default)");
}
{
  ok(nativeSubagentAtBuild({}) === false, "🔴 D6 BUILD: with no app override the build-time value is the shipped OFF ⇒ roster.config.ts emits the `agent` disable sentinel ⇒ eve's built-in is never injected");
  ok(nativeSubagentAtBuild({ delegation: { nativeSubagent: true } }) === true, "…and an app override in agent/settings/settings.ts is what drops it — a reviewed diff, paired with `oe build --accept` in the same PR");
  const saved = process.env.OE_NATIVE_SUBAGENT;
  process.env.OE_NATIVE_SUBAGENT = "0";
  ok(nativeSubagentAtBuild({ delegation: { nativeSubagent: true } }) === true, "🔴 D6: the BUILD resolver is ENV-BLIND — a stray OE_NATIVE_SUBAGENT in whoever ran `oe build --accept` must never rewrite the committed roster.lock.json for everyone else");
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

  delete process.env.OE_NATIVE_SUBAGENT;
  inSession(() => {
    setNativeDelegationSeat("no-seat");
    const toolset = makeToolset();
    projectToolSet(toolset as unknown as Record<string, unknown>);
    ok("agent" in toolset, "🔴 D6 OFF: with the regime disarmed the projection seam never withdraws `agent` — the world is byte-identical, and the slot is not even read");
  });

  const { registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");
  registerSettings({ delegation: { nativeSubagent: true } });
  ok(getSettings({}).delegation.nativeSubagent === true, "the app-override arming path is what the remaining legs run under");

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
    ok(!nativeAgentAllowedNow(), "a tainted turn may not delegate natively — eve has no seam to forward the parent's live taint into a child's opening auth");
    const toolset = makeToolset();
    projectToolSet(toolset as unknown as Record<string, unknown>);
    ok(!("agent" in toolset), "🔴 D6 TAINT GATE: `agent` is WITHDRAWN for the rest of a tainted turn — this is what structurally closes the launder chain (untrusted read → native delegate → child acts on a clean signal)");
    ok("reply" in toolset && "no_reply" in toolset, "…and nothing else is touched: the seat can still speak, it just cannot delegate");
  });

  inSession(() => {
    setNativeDelegationSeat("leaf");
    const toolset = makeToolset();
    projectToolSet(toolset as unknown as Record<string, unknown>);
    ok(!("agent" in toolset), "🔴 D6 LEAF: a native child never sees `agent` — eve blocks its own built-in's recursion, and this is the belt (the roll-own route is closed separately by canDelegateFromSeat)");
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

  resetSettingsForTest();
  ok(getSettings({}).delegation.nativeSubagent === false, "…and the regime is disarmed again for the remaining sections");

  {
    const delegationKit = (await import("../agent/tools/delegation_tools.js")).default;
    const resolved = (await resolveWindowGated(delegationKit, parentCtx)) as Record<string, unknown> | null;
    ok(resolved !== null && "agent" in resolved, "🔴 D6 OFF: disarmed, OE's roll-own `agent` mounts on a delegating standing seat exactly as before — the byte-identical claim, asserted rather than argued");
    const onChild = await resolveWindowGated(delegationKit, childResolverCtx);
    ok(onChild === null, "…and it does NOT mount inside a native child, in either regime: `task` grain is not on the `agent` row of the window-gate manifest, and the leaf rule refuses underneath it");
  }
}

{
  const { markSubagentTainted, subagentWasTainted, subagentTaintKey } = await import("../agent/access/subagent-taint.js");
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

  await (async () => {
    const childHookCtx = { ...(childCtx as unknown as Record<string, unknown>), agent: { name: "oe", nodeId: "__root__" } };
    inSession(() => {
      spawnTaint.openTaintTurn(childHookCtx as never);
      markUntrustedIngestedThisTurn();
    });
    await new Promise((r) => setTimeout(r, 50));
    ok(await subagentWasTainted("default", "sess-child"), "🔴 D7 CHILD SIDE: a child that taints itself persists the marker at MARK time, through the taint-signal flip observer — no dependence on any child lifecycle event");
  })();

  inSession(() => {
    const parentHookCtx = { ...(parentCtx as unknown as Record<string, unknown>), agent: { name: "oe", nodeId: "__root__" } };
    spawnTaint.openTaintTurn(parentHookCtx as never);
    markUntrustedIngestedThisTurn();
  });
  await new Promise((r) => setTimeout(r, 50));
  ok(!(await subagentWasTainted("default", "sess-parent")), "…and a ROOT session's own taint writes no marker: one slot read, no I/O, on every ordinary turn in the deployment");

  await (async () => {
    let adopted = false;
    await contextStorage.run(new ContextContainer(), async () => {
      const parentHookCtx = { ...(parentCtx as unknown as Record<string, unknown>), agent: { name: "oe", nodeId: "__root__" } };
      spawnTaint.openTaintTurn(parentHookCtx as never);
      ok(!untrustedIngestedThisTurn(), "the parent's turn starts CLEAN");
      spawnTaint.rememberDispatchedChild("call_1", "sess-dirty-child");
      adopted = await spawnTaint.adoptSubagentTaint("call_1");
      ok(untrustedIngestedThisTurn(), "🔴 D7 PARENT SIDE: a TAINTED child's result marks the parent's own turn — the subagent-result lands RAW in the parent's history with no toModelOutput seam (OPE-73 class), so without this the parent would `remember`, `create_routine` and `create_skill` over hostile-derived prose with a clean signal");
    });
    ok(adopted, "…and the adoption reports that it fired");
  })();

  await contextStorage.run(new ContextContainer(), async () => {
    const parentHookCtx = { ...(parentCtx as unknown as Record<string, unknown>), agent: { name: "oe", nodeId: "__root__" } };
    spawnTaint.openTaintTurn(parentHookCtx as never);
    spawnTaint.rememberDispatchedChild("call_9", "sess-clean-child");
    const adopted = await spawnTaint.adoptSubagentTaint("call_9");
    ok(!adopted && !untrustedIngestedThisTurn(), "🔴 D7: a CLEAN child does NOT taint the parent — the bit is the child's own judgement about its own turn, and over-tainting is the failure mode OPE-299 removed");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    const parentHookCtx = { ...(parentCtx as unknown as Record<string, unknown>), agent: { name: "oe", nodeId: "__root__" } };
    spawnTaint.openTaintTurn(parentHookCtx as never);
    const adopted = await spawnTaint.adoptSubagentTaint("call_never_dispatched");
    ok(!adopted && !untrustedIngestedThisTurn(), "…and an unrecognised callId is a strict no-op (an `action.result` for any other runtime action never reaches the marker read)");
  });
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

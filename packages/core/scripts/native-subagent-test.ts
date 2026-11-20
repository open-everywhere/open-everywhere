// proves: AP-MOD-core-access-delegation-mount
// proves: AP-MOD-core-access-native-delegation-state

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { filesContainingAll, filesMatching } from "./eve-dist-search.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-native-subagent-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ workspace: "dev" });

const __slackStubs = await import("./_slack-test-stubs.js");
__slackStubs.registerSlackFixtureMapper();
__slackStubs.registerSlackFixtureCodec();

import {
  bindFrom,
  channelPlatform,
  currentTurnAddressed,
  currentTurnAddressing,
  currentWakeId,
  isSubagentChildContext,
  proposingGrantKey,
  subagentParentSessionId,
  windowGrainOf,
  SUBAGENT_CHANNEL_KIND,
  type BindableContext,
} from "../agent/identity/binding.js";
import { OE_NON_REQUESTER_ATTR } from "../agent/identity/non-requester.js";
import { canDelegateFromSeat, resolveOwnWindowToken } from "../agent/access/delegation-mount.js";
import { resolveLeanSeatPosture } from "../agent/access/lean-seat.js";
import { registerSettings, resetSettingsForTest } from "../agent/settings/settings.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { v27Hooks } from "./_hook-view.js";
const { callRequested } = await import("./_hook-view.js");

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
  session: { id: "sess-parent", turn: { id: "turn_parent", sequence: 1 }, auth: { current: { attributes: { ...PARENT_ATTRS }, principalId: "UPROBE393", principalType: "slack-user" } } },
} as unknown as BindableContext;

const childCtx = {
  channel: { kind: "subagent", continuationToken: "subagent:sess-parent:call_1" },
  session: {
    id: "sess-child",
    turn: { id: "turn_child", sequence: 0 },
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

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};
function inSession<T>(fn: () => T): T {
  return contextStorage.run(new ContextContainer(), fn);
}

ok(channelPlatform(childCtx) === "slack", "D1: the inherited platform stamp remains available as a compatibility label before the opening hook; bindFrom below still requires durable authority");
ok(channelPlatform(unstampedChildCtx) === "subagent", "🔴 D1 FAIL-CLOSED: with no inherited stamp it stays `subagent` — no mapper, so bindFrom falls through to bindLocal exactly as any unknown kind does; never a GUESSED platform");

await inSession(async () => {
  const parent = bindFrom(parentCtx);
  const { registerUnifiedWakeTarget } = await import("../agent/channels/unified-window.js");
  const { getOperationalStore } = await import("../agent/operational/provider.js");
  const { recordDeliveredWakes } = await import("../agent/access/dispatch-origin-signal.js");
  const { recordRequesterIdentity } = await import("../agent/access/requester-identity.js");
  const envelope = `<wake wake-id="wake_probe_393"><channel><message from="human" author-id="UPROBE393" trigger="true">delegate</message></channel></wake>`;
  await registerUnifiedWakeTarget(
    getOperationalStore(),
    parent.org,
    "wake_probe_393",
    { platform: "slack", channelId: parent.surface },
    new Date().toISOString(),
    PARENT_TOKEN,
    true,
    undefined,
    `${parent.platform}/${parent.workspace}/${parent.surface}`,
    parent,
    { binding: parent, requester: { kind: "requester", principalId: "UPROBE393" }, nonMemberWake: false },
  );
  recordDeliveredWakes("turn_parent", envelope);
  recordRequesterIdentity(parentCtx, "turn_parent", envelope);
  const spawnEvents = (
    (await import("../agent/hooks/delegation-settlement.js")).default as unknown as {
      events: Record<string, (e: unknown, c: unknown) => Promise<void> | void>;
    }
  ).events;
  await spawnEvents["call.requested"]!(
    callRequested("call_1", "agent", "agent"),
    parentCtx,
  );
  const bindingStarted = (
    (await import("../agent/hooks/binding-bridge.js")).default as unknown as {
      events: Record<string, (e: unknown, c: unknown) => Promise<void> | void>;
    }
  ).events["turn.started"]!;
  await bindingStarted({}, childCtx);
  const child = bindFrom(childCtx);
  eq(
    { platform: child.platform, workspace: child.workspace, surface: child.surface, mode: child.mode, visibility: child.visibility, trust: child.trust, principalId: child.principalId },
    { platform: parent.platform, workspace: parent.workspace, surface: parent.surface, mode: parent.mode, visibility: parent.visibility, trust: parent.trust, principalId: parent.principalId },
    "🔴 D1: a native child binds IDENTICALLY to its parent — workspace, surface, mode, visibility, trust AND principal. This is the invariant the shared sandbox makes load-bearing (hooks/egress.ts asserts it at runtime)",
  );
  ok(child.platform === "slack" && child.workspace === "T0EXAMPLE" && child.surface === "C0EXCHAN003", "…and the values are the PARENT's real surface, so connector grants / memory / egress / spend all resolve against it");

  ok(channelPlatform(childToolCtx) === undefined || channelPlatform(childToolCtx) !== "slack", "a child TOOL context carries no channel, so channelPlatform cannot hop directly — the binding bridge is what heals it, and the bridge re-enters this function with kind `subagent`");
});

{
  const unstamped = bindFrom(unstampedChildCtx);
  ok(unstamped.platform === "subagent", `🔴 D1 FAIL-CLOSED: without restored durable authority the platform stays "subagent" (got "${unstamped.platform}")`);
  ok(unstamped.workspace === "dev", `…workspace literally "dev" — bindFrom's declared ambient-workspace rung, NOT the unnamed-tenant literal (got "${unstamped.workspace}"; correcting the first written account of this bug)`);
  ok(unstamped.surface === "unresolved", "…surface `unresolved`, so no deployment scope can treat the missing authority as a real room");
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
  const { egressPolicyFingerprint, EgressBindingDivergenceError } = await import("../agent/hooks/egress.js");

  const policy = { allow: { "api.example.com": [{ match: { method: ["GET"] } }] } } as never;
  const scope = () => ({ org: "default", platform: "slack", workspace: "T0EXAMPLE", surface: "C0EXCHAN003", principalId: "UPROBE393" });
  const STAND_IN_SCOPE_KEY = "slack/dev/default";
  const baseDeps = (
    parentFingerprint: string | undefined | (() => Promise<string | undefined>),
    scopeKey = "slack/T0EXAMPLE/C0EXCHAN003",
  ) => {
    const applied: unknown[] = [];
    const audited: { action: string; detail: Record<string, unknown> }[] = [];
    return {
      applied,
      audited,
      deps: {
        resolve: () => ({ scopeKey, connectors: [], connectorContentOrigin: {} }) as never,
        compile: async () => policy,
        apply: async (p: unknown) => void applied.push(p),
        lastApplied: () => undefined,
        rememberApplied: () => undefined,
        lastConnectors: () => undefined,
        rememberConnectors: () => undefined,
        scope,
        audit: async (entry: { action: string; detail?: Record<string, unknown> }) => {
          audited.push({ action: entry.action, detail: entry.detail ?? {} });
        },
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

  const diverge = baseDeps("d228cd75deadbeef", STAND_IN_SCOPE_KEY);
  const diverged = await enforceEgress("session.started", diverge.deps as never);
  ok(diverged.abortError !== undefined, "🔴 D5: a DIVERGENT fingerprint FAILS the child (fail-closed) — the measured clobber was a mis-bound child replacing its parent's published firewall state mid-turn in the sandbox they share");
  ok(diverge.applied.length === 0, "…and NOTHING was applied: the check runs before the apply, the publish and the stamp, so a violating child touches the shared sandbox not at all");
  ok(diverged.abortError!.message.includes("identical-binding invariant VIOLATED"), "…naming the invariant it violated, which is what a transcript reader sees");
  ok(diverged.abortError instanceof EgressBindingDivergenceError, "…as the TYPED error the turn.started edge keys its one re-throw on");

  const divergeRow = diverge.audited.find((r) => r.action === "egress.policy" && r.detail["reason"] === "subagent-binding-divergence");
  ok(divergeRow !== undefined, "🔴 D5/OPE-680: a divergence writes an `egress.policy` row before the child is failed");
  ok(divergeRow!.detail["scopeKey"] === STAND_IN_SCOPE_KEY, "🔴 D5/OPE-680: the abort row names the CHILD's own scope key — `slack/dev/default` here, the env stand-in the prod rows carried, which is what identifies a mis-bound child rather than a moved policy");
  ok(divergeRow!.detail["hosts"] === 1, "…and the child's host count, so a reader sees WHAT the child compiled without holding a byte of it");
  ok(typeof divergeRow!.detail["summary"] === "string" && (divergeRow!.detail["summary"] as string).includes("default-deny"), "…and the same one-line summary an ordinary row carries");
  ok(diverged.abortError!.message.includes(STAND_IN_SCOPE_KEY), "🔴 D5/OPE-680: the THROWN message names it too — the message is what a transcript reader sees, and it is where the OPE-680 investigation started");

  ok(match.audited.every((r) => r.detail["reason"] !== "subagent-binding-divergence"), "…and a child whose fingerprint MATCHES writes no divergence row — the row is the abort's own, not a field every pass carries");

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

{
  const { seatCutToolset } = await import("../agent/access/seat-cut.js");
  const { setNativeDelegationSeat, nativeAgentAllowedNow } = await import("../agent/access/native-delegation-state.js");
  const { noteEnvelopeWrapThisTurn } = await import("../agent/memory/turn-provenance.js");

  const makeToolset = () => ({ agent: { execute: () => undefined }, reply: { execute: () => undefined }, no_reply: { execute: () => undefined } });

  inSession(() => {
    setNativeDelegationSeat("allow");
    ok(nativeAgentAllowedNow(), "an allowed seat on a clean turn may hold the built-in");
    const toolset = makeToolset();
    seatCutToolset(toolset as unknown as Record<string, unknown>);
    ok("agent" in toolset, "🔴 D6 ARMED, CLEAN: a delegating conversational seat keeps `agent`, and it is eve's built-in — OE mounts nothing under that name (a dynamic `agent` would COLLIDE with the runtime-visible subagent and throw)");
  });

  inSession(() => {
    setNativeDelegationSeat("allow");
    noteEnvelopeWrapThisTurn();
    eq(nativeAgentAllowedNow(), true, "🔴 D6 TAINT IS NOT A CONJUNCT (OPE-471): a tainted turn KEEPS its delegation verb, because taint is not a delegation condition — asserted `=== true`, not merely truthy");
    const toolset = makeToolset();
    seatCutToolset(toolset as unknown as Record<string, unknown>);
    ok("agent" in toolset, "…and seatCutToolset (the pure rule) leaves `agent` in place on a tainted turn (on eve 1.x no file reaches `agent` — seat-cut-test §5)");
    ok("reply" in toolset && "no_reply" in toolset, "…with nothing else touched either");
  });

  inSession(() => {
    setNativeDelegationSeat("no-seat");
    noteEnvelopeWrapThisTurn();
    eq(nativeAgentAllowedNow(), false, "🔴 D6 SEAT HALF STILL FIRES: an unclassified seat is refused `agent` on the same tainted turn — so (c) reads 'taint stopped gating', never 'the gate is dead'");
    const toolset = makeToolset();
    seatCutToolset(toolset as unknown as Record<string, unknown>);
    ok(!("agent" in toolset), "…and seatCutToolset (the pure rule) really removes it (on eve 1.x no file reaches `agent` — seat-cut-test §5)");
  });

  inSession(() => {
    setNativeDelegationSeat("leaf");
    const toolset = makeToolset();
    seatCutToolset(toolset as unknown as Record<string, unknown>);
    ok(!("agent" in toolset), "🔴 D6 LEAF: seatCutToolset (the pure rule) withholds `agent` from a native child — eve blocks its own built-in's recursion; on eve 1.x the rule reaches no `agent` slot (seat-cut-test §5), and the roll-own route is closed separately by canDelegateFromSeat");
  });

  inSession(() => {
    setNativeDelegationSeat("leaf");
    const toolset: Record<string, unknown> = {
      agent: { execute: () => undefined },
      describe_image: { execute: () => undefined },
      read_file_upload: { execute: () => undefined },
      bash: { execute: () => undefined },
      post_file: { execute: () => undefined },
      update_status: { execute: () => undefined },
    };
    seatCutToolset(toolset);
    eq(Object.keys(toolset).sort(), ["bash", "describe_image", "post_file", "read_file_upload", "update_status"], "🔴 D6 LEAF, WHOLE KIT: the leaf withdrawal removes `agent` and NOTHING ELSE — a native child keeps its vision read, its upload read, its sandbox and its return leg");
  });

  const { setWorkerWake } = await import("../agent/access/worker-seat-state.js");
  const { TASK_PARENT_TOOL_NAMES } = await import("../agent/access/background-tasks.js");
  const makeTaskToolset = () => ({
    agent: { execute: () => undefined },
    reply: { execute: () => undefined },
    eve__task_wait: { execute: () => undefined },
    eve__task_cancel: { execute: () => undefined },
  });

  eq([...TASK_PARENT_TOOL_NAMES], ["eve__task_wait", "eve__task_cancel"], "🔴 D6 TASKS: the PARENT list is eve 0.70's mounted set, in eve's order. This leg asserts a LITERAL and reads no eve bytes, so it pins the list against an accidental edit only — `scripts/background-task-taint-test.ts` PART 0B is the leg that reads `protocol/task-tools.js` and reds when eve moves");

  inSession(() => {
    setNativeDelegationSeat("allow");
    setWorkerWake(false);
    const toolset = makeTaskToolset();
    seatCutToolset(toolset as unknown as Record<string, unknown>);
    eq(
      Object.keys(toolset).sort(),
      ["agent", "eve__task_cancel", "eve__task_wait", "reply"],
      "🔴 D6 TASKS, DELEGATING SEAT: it keeps `agent` and both parent lifecycle verbs — the verbs that wait on and stop work THIS seat started",
    );
  });

  inSession(() => {
    setNativeDelegationSeat("no-seat");
    setWorkerWake(false);
    const toolset = makeTaskToolset();
    seatCutToolset(toolset as unknown as Record<string, unknown>);
    eq(
      Object.keys(toolset).sort(),
      ["reply"],
      "🔴 D6 TASKS, NON-DELEGATING SEAT: `agent` and both `task_*` verbs go — waiting on and cancelling work this seat could never have started are dead weight, and dead weight on an unclassified seat is the OPE-421 inversion",
    );
  });

  inSession(() => {
    setWorkerWake(false);
    const toolset = makeTaskToolset();
    seatCutToolset(toolset as unknown as Record<string, unknown>);
    eq(Object.keys(toolset).sort(), ["reply"], "🔴 D6 TASKS, FAIL-CLOSED: a wake nothing classified loses the whole family — the clear-first default is DENY here too");
  });

  inSession(() => {
    setNativeDelegationSeat("leaf");
    setWorkerWake(true);
    const toolset = makeTaskToolset();
    seatCutToolset(toolset as unknown as Record<string, unknown>);
    eq(
      Object.keys(toolset).sort(),
      ["reply"],
      "🔴 D6 TASKS, WORKER: a delegated child keeps NOTHING of the task family — it loses the three parent verbs, and eve 0.54.1 removed the child's own `task_update`. Its return leg `reply` survives",
    );
  });

  inSession(() => {
    setNativeDelegationSeat("allow");
    setWorkerWake(false);
    const toolset = makeToolset();
    seatCutToolset(toolset as unknown as Record<string, unknown>);
    eq(Object.keys(toolset).sort(), ["agent", "no_reply", "reply"], "🔴 D6 TASKS, NO TASK NAME: a set carrying no `task_*` name comes back untouched — the subtraction removes only names it was given");
  });

  inSession(() => {
    const toolset = makeToolset();
    seatCutToolset(toolset as unknown as Record<string, unknown>);
    ok(!("agent" in toolset), "🔴 D6 FAIL-CLOSED: seatCutToolset (the pure rule) withholds `agent` from a wake nothing classified (on eve 1.x no file reaches `agent` — seat-cut-test §5) — the OPPOSITE default from the lean slot next door, because a wrongly-allowed delegation route is worse than a turn that has to do its own work");
  });

  {
    const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "tools");
    const importAt = async (file: string): Promise<{ resolved: boolean; code?: unknown }> => {
      try {
        await import(pathToFileURL(join(toolsDir, file)).href);
        return { resolved: true };
      } catch (err) {
        return { resolved: false, code: (err as { code?: unknown }).code };
      }
    };
    const sibling = await importAt("reply.js");
    ok(sibling.resolved, "positive control: the SAME construction resolves a surviving sibling (tools/reply.js) — so the refusal below is about the deleted file, not a broken path");
    const { resolved, code } = await importAt("delegation_tools.js");
    ok(!resolved, "🔴 D6 THE COLLISION WALL IS ABSENCE: tools/delegation_tools.ts does not exist, so no dynamic `agent` can resolve beside eve's built-in and the tool-loop collision is unreachable");
    eq(code, "ERR_MODULE_NOT_FOUND", "…and it failed because the MODULE is gone, not because importing it threw for some other reason (which would leave the file — and the collision — in the tree)");
  }
  resetSettingsForTest();
}

{
  const hub = await import("../agent/hooks/delegation-settlement.js");
  const { readFileSync } = await import("node:fs");

  const hook = hub.default as unknown as {
    events: {
      "turn.started": (event: unknown, ctx: unknown) => Promise<void> | void;
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

    const dispatchCarriers = filesContainingAll("deserializeContext(", "serializedContext", "get(AuthKey)??null");
    ok(
      dispatchCarriers.length > 0,
      "🔴 D9 TRIPWIRE 3/4: the dispatch step still builds the child's auth from the PARENT's serialized context (`deserializeContext(…serializedContext)` then `.get(AuthKey)`) — NOT from the tool call, which is why a hook can reach it and a tool cannot. The shape is absent from the whole installed eve.",
    );

    const subagentTool = dist("subagents/tool.js");
    const authParam = /function buildSubagentRunInput\(\w+\)\{let\{action:\w+,auth:(\w+)[,}]/.exec(subagentTool);
    ok(authParam !== null, "🔴 D9 TRIPWIRE 4/4a: `buildSubagentRunInput` still destructures an `auth` input");
    ok(
      authParam !== null && new RegExp(`\\{kind:SUBAGENT_ADAPTER_KIND,state:\\w+\\},auth:${authParam[1]}[,}]`).test(subagentTool),
      "🔴 D9 TRIPWIRE 4/4b: …and puts it into the child's `runInput.auth` verbatim, with no filtering of the attributes bag",
    );

    const turnStepFiles = filesMatching(/export\{turnStep\}/);
    eq(turnStepFiles.length, 1, "🔴 D9 TURN SCOPING: exactly one eve module exports `turnStep` — the module whose `AuthKey` writers this leg counts");
    const wrapper = dist(turnStepFiles[0]!);
    const delegated = /import\{turnStepOn\}from"#(execution\/session\/turn-step)\.js"/.exec(wrapper);
    if (delegated !== null) {
      eq(
        (wrapper.match(/\.(?:set|setVirtualContext|ensure)\(\s*AuthKey\s*,|\.delete\(\s*AuthKey\s*\)|[{,]\s*\[AuthKey\.name\]\s*:|\[AuthKey\.name\]\s*(?:\?\?|\|\||&&)?=(?!=)/g) ?? []).length,
        0,
        "🔴 D9 TURN SCOPING (eve 1.x): the exported `turnStep` is a wrapper that writes no `AuthKey` itself — it delegates to `turnStepOn`, the module this leg counts instead",
      );
    }
    const steps = delegated === null ? wrapper : dist(`${delegated[1]}.js`);
    eq(
      steps.split("set(AuthKey,").length - 1,
      3,
      "🔴 D9 TURN SCOPING: the turn step `.set`s `AuthKey` in exactly THREE places (eve 1.0.0-rc.18) — the delivery writer, the authorization-resume writer and the closing writer. A fourth writer is a new road for the bag to be replaced before a dispatch reads it",
    );
    const w1 = /let (\w+)=(\w+)\.get\(AuthKey\);(?:let \w+=\2\.has\(InitiatorAuthKey\);)?(\w+)\?\.auth!==void 0&&\(\2\.set\(AuthKey,\3\.auth\?\?null\)/.exec(steps);
    ok(
      w1 !== null,
      "🔴 D9 TURN SCOPING W1: the delivery writer fires on EVERY delivery that carries auth, mid-turn included, and the step captures the previous value before it writes",
    );
    ok(
      w1 !== null &&
        new RegExp(
          `let (\\w+)=${w1[3]}===void 0\\?[^;]*\\.challenge\\.requester:void 0;\\1!==void 0&&${w1[2]}\\.set\\(AuthKey,\\1\\)`,
        ).test(steps),
      "🔴 D9 TURN SCOPING W2: the authorization-resume writer fires only when no delivery is left, and writes the pending challenge's recorded requester",
    );
    const w3 =
      w1 === null
        ? null
        : new RegExp(
            `let (\\w+)=${w1[2]}\\.get\\(AuthKey\\);if\\((\\w+)!==void 0\\|\\|(\\w+)\\?\\1=${w1[1]}:${w1[3]}!==void 0&&!(\\w+)&&\\(\\1=(\\w+)\\?\\.message===void 0\\?${w1[1]}:continueTurnAuth\\(${w1[1]},\\1\\)\\),\\1===void 0\\?${w1[2]}\\.delete\\(AuthKey\\):${w1[2]}\\.set\\(AuthKey,\\1\\)`,
          ).exec(steps);
    ok(
      w3 !== null,
      "🔴 D9 TURN SCOPING W3 (eve 1.x): the closing writer restores exactly the value captured before W1 — the same bag by reference — after an attributed answer, after a mid-turn delivery with no turn input, and after a mid-turn input with no message",
    );
    ok(
      w1 !== null &&
        w3 !== null &&
        new RegExp(`let ${w3[3]}=${w1[3]}!==void 0&&${w3[5]}===void 0&&!${w3[4]};`).test(steps) &&
        new RegExp(`let ${w3[4]}=isBetweenTurns\\(currentProjection\\(${w1[2]}\\)\\)`).test(steps),
      "D9 TURN SCOPING W3: …where the rollback flag means a delivery that yields no turn input while a turn runs",
    );
    ok(
      /function continueTurnAuth\((\w+),(\w+)\)\{if\(\2===void 0\)return \1;if\(principalOf\(\2\)!==principalOf\(\1\)\)throw Error\(`[^`]*`\);return \2\}/.test(dist("execution/session/principal.js")),
      "🔴 D9 TURN SCOPING W3: a mid-turn MESSAGE of the same principal keeps continueTurnAuth's result (a message with no auth keeps the earlier bag) — the same principal or a throw, but the LATER delivery's bag, a new object. OE's turn-start writes on the earlier bag do not ride a dispatch after it. On a seat window OE's join issuer admits such a message only when its authority attributes match the turn's (OPE-2789); a work window joins by design",
    );
  }

  {
    const { captureEligible } = await import("../agent/hooks/requester-messages.js");

    await contextStorage.run(new ContextContainer(), async () => {
      const seat = fwdCtx({ id: "sess-fence-seat", turn: { id: "turn_0", sequence: 0 } });
      await turnStarted(seat);
      eq(captureEligible(seat as never), true, "🔴 D9 FENCE NEGATIVE CONTROL: an ordinary seat wake IS capture-eligible — asserted `=== true`, so the fence below reads 'refused this case', not 'refuses everything'");
    });

    await contextStorage.run(new ContextContainer(), async () => {
      const child = fwdCtx({
        id: "sess-fence-clean-child",
        turn: { id: "turn_0", sequence: 0 },
        parent: { sessionId: "sess-fwd-clean", callId: "call_g2", turn: { id: "turn_1", sequence: 1 } },
      });
      await turnStarted(child);
      eq(captureEligible(child as never), false, "🔴 D9 FENCE (OPE-473): a native child is NOT capture-eligible — the brief is the parent MODEL's words, so the approval judge must never read it as a requester's");
    });

    await contextStorage.run(new ContextContainer(), async () => {
      const child = fwdCtx({ id: "sess-fence-token-child", turn: { id: "turn_0", sequence: 0 } });
      child.channel.continuationToken = "subagent:sess-fwd-clean:call_g2b";
      await turnStarted(child);
      eq(captureEligible(child as never), false, "🔴 D9 FENCE (OPE-473): a child recognised ONLY by eve's `subagent:` continuation token is refused too — the fence is not keyed on `session.parent` alone");
    });

    await contextStorage.run(new ContextContainer(), async () => {
      const brief = fwdCtx({ id: "sess-fence-brief", turn: { id: "turn_0", sequence: 0 }, attributes: { [OE_NON_REQUESTER_ATTR]: "task-brief" } });
      await turnStarted(brief);
      eq(captureEligible(brief as never), false, "🔴 D9 FENCE: an `oe_non_requester` delivery is refused AFTER the turn preamble has run, not only before it");
    });
    await contextStorage.run(new ContextContainer(), async () => {
      const spawned = fwdCtx({ id: "sess-fence-spawn", turn: { id: "turn_0", sequence: 0 }, attributes: { oe_spawn_tainted: "true" } });
      await turnStarted(spawned);
      eq(captureEligible(spawned as never), true, "D9 FENCE (OPE-2713, OPE-2720): a bare, retired `oe_spawn_tainted` stamp decides nothing — no producer writes it and no reader reads it, so the seat turn runs normally");
    });
  }
}

{
  const { adoptDelegatedAuthority } = await import("../agent/identity/delegated-binding.js");
  const { proposingGrantScope } = await import("../agent/identity/binding.js");
  const THREAD_TS = "1769312300.000100";
  const threadAttrs = { ...PARENT_ATTRS, thread_ts: THREAD_TS };
  const withAttrs = <T extends object>(ctx: T): T => {
    const c = ctx as unknown as { session: { auth: { current: Record<string, unknown> } } };
    return { ...ctx, session: { ...c.session, auth: { current: { ...c.session.auth.current, attributes: { ...threadAttrs } } } } } as T;
  };
  const threadedParent = withAttrs(parentCtx);
  eq(proposingGrantKey(threadedParent), undefined, "🔴 OPE-2363: the parent in a THREAD has NO grant key — a click there keeps no grant");
  const parentScope = proposingGrantScope(threadedParent);
  ok(parentScope?.reach === "call" && parentScope.key.endsWith(`:thread:${THREAD_TS}`), "the parent's one-call approval waits under its THREAD's key");
  ok(!parentScope!.key.startsWith("oe-dom:"), "🔴 OPE-2363: …and that key is never a session or window token");
  inSession(() => {
    ok(adoptDelegatedAuthority({ binding: bindFrom(threadedParent), requester: { kind: "requester", principalId: "UPROBE393" }, nonMemberWake: false }, "turn_child"), "precondition: the child adopted the dispatch binding");
    eq(proposingGrantKey(withAttrs(childCtx)), undefined, "🔴 D8: the native child has NO grant key either");
    eq(proposingGrantScope(withAttrs(childCtx))?.key, parentScope!.key, "🔴 D8: the child's one-call approval waits under the SAME thread key as its parent's");
    eq(proposingGrantScope(withAttrs(childToolCtx))?.key, parentScope!.key, "…in a tool context too, which is where a card is actually consulted (the connector write path)");
    eq(proposingGrantScope(withAttrs(childResolverCtx))?.key, parentScope!.key, "🔴 D8: the answer is the same in EVERY context surface — the child reads its dispatch binding, never whichever token the context happens to carry");
  });
  inSession(() => {
    eq(proposingGrantScope(withAttrs(childToolCtx)), undefined, "🔴 a child with NO adopted dispatch binding keeps no approval (fail closed)");
  });
}

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
    loadDomains: () => [{ name: "ns", reach: ["slack/T0EXAMPLE/C0EXCHAN003"], memory: ["ns-brain-silo"] }],
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

  const { formatWindowToken: fmt, workWindowId: workId } = await import("../agent/channels/window-key.js");
  const ROOT_TOKEN = fmt({ domain: "e2e-unified", windowId: workId("slack_T0EXAMPLE_C0EXCHAN003"), generation: 1 });
  const rootCtx = {
    channel: { kind: "channel:slack", continuationToken: `unified:${ROOT_TOKEN}` },
    session: { id: "sess-root", turn: { id: "turn_root", sequence: 1 }, auth: { current: { attributes: { ...PARENT_ATTRS, oe_grain: "standing", oe_window_token: ROOT_TOKEN }, principalId: "UPROBE393", principalType: "slack-user" } } },
  } as unknown as BindableContext;

  {
    reset();
    const sandbox = new FakeSandbox();
    await contextStorage.run(new ContextContainer(), async () => {
      await hook.events["session.started"]({ type: "session.started" }, withSandbox(rootCtx, sandbox) as never);
    });
    ok(calls.readTier + calls.ensureTier > 0 && sandbox.writes > 0, `the negative control works: a ROOT session DOES materialise (reads=${calls.readTier + calls.ensureTier}, sandbox writes=${sandbox.writes})`);
  }
  {
    reset();
    const sandbox = new FakeSandbox();
    await contextStorage.run(new ContextContainer(), async () => {
      await v27Hooks(hook).sessionEnded("completed")({}, withSandbox(rootCtx, sandbox) as never);
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
      await v27Hooks(hook).sessionEnded("completed")({}, withSandbox(childCtx, sandbox) as never);
    });
    ok(calls.writeTier === 0, `🔴 D4: a native child PERSISTS NOTHING — the parent owns its own tree, and a second writer through mergePreservingConflicts/guardDestructiveWrites (with a different sessionId and no baseline) would file the parent's in-flight edits as conflict siblings of themselves (writeTier=${calls.writeTier})`);
  }
  {
    reset();
    const sandbox = new FakeSandbox();
    await contextStorage.run(new ContextContainer(), async () => {
      await v27Hooks(hook).sessionEnded("failed")({}, withSandbox(childCtx, sandbox) as never);
    });
    ok(calls.writeTier === 0, "…on the FAILED edge too, which shares the same persist path");
  }

}

console.log(`✓ native-subagent: ${n} assertions passed`);

// proves: TOOL-agent, TOOL-eve__task_cancel

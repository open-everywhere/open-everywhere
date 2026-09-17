import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-coalesced-scope-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ workspace: "dev" });

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (actual: unknown, expected: unknown, label: string) => {
  assert.deepStrictEqual(actual, expected, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};

const __slackStubs = await import("./_slack-test-stubs.js");
__slackStubs.registerSlackFixtureCodec();

const { registerUnifiedWakeTarget, wakeSurfaceKeyFromTargetJson } = await import("../agent/channels/unified-window.js");
const { proposalScopeKey } = await import("../agent/channels/propose-scope.js");
const { partialHaltPrefix, resolveTurnHaltReach } = await import("../agent/channels/halt-per-wake.js");
const { claimTasksForAddressedWake, addressedWakeThisTurn } = await import("../agent/access/dispatch-origin-signal.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { haltSeatParagraph } = await import("../agent/access/halt.js");
import type { HaltRow } from "../agent/operational/store.js";

const ORG = "default";
const WINDOW = "oe-dom:e2e:oe-sup:g1";
const store = getOperationalStore();
const iso = () => new Date().toISOString();

const A_SURFACE = "slack/T_ACME/C_ASKED";
const A_ORIGIN = { platform: "slack", channelId: "C_ASKED", threadTs: "700.1" } as const;
const B_SURFACE = "slack/T_ACME/C_ASIDE";
const B_ORIGIN = { platform: "slack", channelId: "C_ASIDE", threadTs: "800.1" } as const;

const W_A = "wake-coalesced-a";
const W_B = "wake-coalesced-b";

await registerUnifiedWakeTarget(store, ORG, W_A, A_ORIGIN, iso(), WINDOW, true, "direct-mention", A_SURFACE);
await registerUnifiedWakeTarget(store, ORG, W_B, B_ORIGIN, iso(), WINDOW, true, "channel-watch", B_SURFACE);

function seatCtx(turnId: string) {
  return {
    channel: { kind: "unified", continuationToken: `unified:${WINDOW}` },
    session: {
      id: "sess-seat",
      turn: { id: turnId, sequence: 1 },
      auth: {
        current: {
          attributes: { oe_platform: "slack", oe_grain: "standing", oe_window_token: WINDOW, oe_wake_id: W_B, channel_id: "C_ASIDE", team_id: "T_ACME" },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
    agent: { name: "oe", nodeId: "__root__" },
  } as never;
}

{
  const rowA = await store.getUnifiedWakeTarget(ORG, W_A);
  ok(rowA !== null, "§0: the wake row is readable");
  eq(wakeSurfaceKeyFromTargetJson(rowA!), A_SURFACE, "🔴 §0: the divert's own surface key rides the wake row as a tolerated extra field");
  const { resolveUnifiedWakeTarget } = await import("../agent/channels/unified-window.js");
  eq(await resolveUnifiedWakeTarget(store, ORG, W_A), A_ORIGIN, "§0: the origin still validates with routing metadata present, and returns only the provider post target");
  eq(wakeSurfaceKeyFromTargetJson("not json"), undefined, "§0: a malformed row names no surface key — total, never a throw");
  eq(wakeSurfaceKeyFromTargetJson(JSON.stringify(A_ORIGIN)), undefined, "🔴 §0: a row minted BEFORE this field existed names none either — the fallback arm, asserted rather than assumed");
}

await contextStorage.run(new ContextContainer(), async () => {
  const ctx = seatCtx("turn_propose");
  const TURN_PARTITION = { org: ORG, surfaceKey: B_SURFACE };

  eq(addressedWakeThisTurn("turn_propose"), undefined, "§1 precondition: the turn has addressed nothing yet");
  eq(
    await proposalScopeKey(ctx, TURN_PARTITION),
    B_SURFACE,
    "🔴 §1 THE MEASURED DEFECT: with nothing addressed, the propose scope is the LAST merged delivery's room — the room that asked nothing",
  );

  claimTasksForAddressedWake("turn_propose", W_A);
  eq(addressedWakeThisTurn("turn_propose"), W_A, "§1: the addressed wake is recorded for this turn");

  eq(
    await proposalScopeKey(ctx, TURN_PARTITION),
    A_SURFACE,
    "🔴 §1 THE FIX: the propose scope is now the ADDRESSED wake's room — the approver chain, the pre-approval rules and the halt address all key on this string",
  );

  const ctx2 = seatCtx("turn_missing");
  claimTasksForAddressedWake("turn_missing", "wake-that-does-not-exist");
  eq(await proposalScopeKey(ctx2, TURN_PARTITION), B_SURFACE, "🔴 §1 CONTROL: an unresolvable addressed wake falls back to the caller's partition — this can move a proposal, never lose one");

  const W_BAD = "wake-bad-key";
  await registerUnifiedWakeTarget(store, ORG, W_BAD, A_ORIGIN, iso(), WINDOW, true, undefined, "slack/T_ACME");
  const ctx3 = seatCtx("turn_badkey");
  claimTasksForAddressedWake("turn_badkey", W_BAD);
  eq(await proposalScopeKey(ctx3, TURN_PARTITION), B_SURFACE, "🔴 §1 CONTROL: a stored value that is not a surface key is refused — a two-segment string is a DIFFERENT address shape, never a scope");
});

{
  const HALTED_A: HaltRow = { org: ORG, address: { orgWide: false, level: "surface", scopeKey: A_SURFACE }, setAt: iso() } as unknown as HaltRow;
  const rowsWithA = async () => [HALTED_A];
  const rowsEmpty = async () => [] as readonly HaltRow[];
  const bothRooms = async () => [
    { wakeId: W_A, targetJson: JSON.stringify({ ...A_ORIGIN, surfaceKey: A_SURFACE }), createdAt: iso() },
    { wakeId: W_B, targetJson: JSON.stringify({ ...B_ORIGIN, surfaceKey: B_SURFACE }), createdAt: iso() },
  ];
  const oneRoom = async () => [{ wakeId: W_A, targetJson: JSON.stringify({ ...A_ORIGIN, surfaceKey: A_SURFACE }), createdAt: iso() }];

  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = seatCtx("turn_halt");

    const turnStateHalted = { halted: true, row: HALTED_A } as const;
    const wideOnly = await resolveTurnHaltReach(ctx, turnStateHalted, ORG, { rows: rowsWithA, pendingWakes: oneRoom });
    eq(wideOnly.kind, "all", "§2 precondition: a turn holding ONE room answers exactly as the single-address read did — the fallback is byte-identical");

    const reach = await resolveTurnHaltReach(ctx, turnStateHalted, ORG, { rows: rowsWithA, pendingWakes: bothRooms });
    eq(reach.kind, "partial", "🔴 §2 THE FIX: a turn holding two rooms, one halted, reports the pause as PARTIAL rather than turn-wide");
    eq(reach.kind === "partial" ? [reach.haltedRooms, reach.totalRooms] : null, [1, 2], "§2: …and it counts the rooms, which is what the seat copy states");

    const prefix = partialHaltPrefix(reach);
    ok(prefix !== null && prefix.includes("does NOT cover every conversation"), "🔴 §2: the seat is told the claim is not turn-wide — the sentence is the whole of what the room can see");
    ok(prefix !== null && !prefix.includes(A_SURFACE) && !prefix.includes(B_SURFACE), "🔴 §2: …and it names NO scope key — the paragraph's own product-copy rule, asserted rather than trusted");

    const clear = await resolveTurnHaltReach(ctx, { halted: false }, ORG, { rows: rowsEmpty, pendingWakes: bothRooms });
    eq(clear.kind, "none", "🔴 §2 NEGATIVE CONTROL: two rooms, no halt ⇒ nothing is rendered — asserted `=== \"none\"`");
    eq(partialHaltPrefix(clear), null, "§2 NEGATIVE CONTROL: …and no prefix either");
    eq(haltSeatParagraph({ halted: false }), null, "§2 NEGATIVE CONTROL: the standing paragraph is itself null when nothing is halted");

    const HALTED_B: HaltRow = { org: ORG, address: { orgWide: false, level: "surface", scopeKey: B_SURFACE }, setAt: iso() } as unknown as HaltRow;
    const both = await resolveTurnHaltReach(ctx, turnStateHalted, ORG, { rows: async () => [HALTED_A, HALTED_B], pendingWakes: bothRooms });
    eq(both.kind, "all", "🔴 §2 CONTROL: two rooms BOTH halted is `all` — the turn-wide sentence is correct there and must stay");
    eq(partialHaltPrefix(both), null, "§2 CONTROL: …so no partial prefix is added to it");

    const personHalt: HaltRow = { org: ORG, address: { orgWide: false, level: "user", scopeKey: "user:slack/T_ACME/U1" }, setAt: iso() } as unknown as HaltRow;
    const personScoped = await resolveTurnHaltReach(ctx, { halted: true, row: personHalt }, ORG, { rows: async () => [personHalt], pendingWakes: bothRooms });
    eq(personScoped.kind, "all", "🔴 §2 THE FAIL-OPEN ARM: a halt NO room's surface key can match keeps the turn-wide paragraph — a pause is never dropped because this module could not re-derive its address");
    ok(partialHaltPrefix(personScoped) === null, "§2: …and it is not mislabelled partial either — nothing here says the pause reaches only some rooms");

    const down = await resolveTurnHaltReach(ctx, turnStateHalted, ORG, {
      rows: rowsWithA,
      pendingWakes: () => Promise.reject(new Error("store is down")),
    });
    eq(down.kind, "all", "🔴 §2 FAIL-SOFT: an unreadable pending-wake read degrades to the turn-wide paragraph, never to silence");
  });
}

console.log(`coalesced-turn-scope: ${n} assertions passed`);

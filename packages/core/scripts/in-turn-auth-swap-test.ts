import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-in-turn-auth-swap-")), "ops.sqlite3");
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
__slackStubs.registerSlackFixtureMapper();

const { ANSWER_DELIVERED_REFUSAL_REASON, proseBlockingRefusal, registerUnifiedWakeTarget, replyRefusalMessage, resolveAnswerableReplyTarget } = await import("../agent/channels/unified-window.js");
const { authPrincipalId, currentWakeId, deliveryStampOf } = await import("../agent/identity/binding.js");
const { adoptTaskWakeThisTurn, deliveryChangedThisTurn, noteTurnBoundary, uningressedTurn } = await import("../agent/access/task-wake-signal.js");
const { markWakeRepliedThisTurn } = await import("../agent/channels/reply-signal.js");
const { answeredContainerVia, proseDropMayRedrive } = await import("../agent/channels/unified.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");

const ORG = "default";
const WINDOW = "oe-dom:e2e:oe-sup:g1";
const SESSION = "sess-swap";
const store = getOperationalStore();
const iso = () => new Date().toISOString();

const ROOM = { platform: "slack", channelId: "C_ROOM", threadTs: "111.1" } as const;

function stepCtx(turnId: string, bag: { principal: string; wakeId?: string; deliveryId?: string }) {
  return {
    channel: { kind: "unified", continuationToken: `unified:${WINDOW}` },
    session: {
      id: SESSION,
      turn: { id: turnId, sequence: 1 },
      auth: {
        current: {
          attributes: {
            oe_platform: "slack",
            oe_grain: "standing",
            oe_window_token: WINDOW,
            ...(bag.wakeId === undefined ? {} : { oe_wake_id: bag.wakeId }),
            ...(bag.deliveryId === undefined ? {} : { oe_delivery_id: bag.deliveryId }),
          },
          principalId: bag.principal,
          principalType: "slack-user",
        },
      },
    },
    agent: { name: "oe", nodeId: "__root__" },
  } as never;
}

const settlementHook = (await import("../agent/hooks/delegation-settlement.js")).default as unknown as {
  events: Record<string, (e: unknown, c: unknown) => unknown>;
};
function turnStarted(ctx: never, _turnId: string): void {
  settlementHook.events["turn.started"]!({}, ctx);
  settlementHook.events["model.requested"]!({}, ctx);
}
function stepStarted(ctx: never, _turnId: string): void {
  settlementHook.events["model.requested"]!({}, ctx);
}

const A = { principal: "U_A", wakeId: "wake-A-0001", deliveryId: "dlv-A-0001" };
const B = { principal: "U_B", wakeId: "wake-B-0002", deliveryId: "dlv-B-0002" };

{
  const before = stepCtx("turn_s1", A);
  const after = stepCtx("turn_s1", B);
  eq(deliveryStampOf(before), A.deliveryId, "S1: the first step's stamp is A's delivery nonce");
  eq(deliveryStampOf(after), B.deliveryId, "🔴 S1: after the in-turn swap the SAME turn id reads B's nonce — a per-step read, not a per-turn cache");
  eq(authPrincipalId(after), B.principal, "S1: …and the live principal is B — eve wrote the answerer's bag, which is the premise of every section below");
}

await contextStorage.run(new ContextContainer(), async () => {
  turnStarted(stepCtx("turn_1", A), "turn_1");
  eq(deliveryChangedThisTurn("turn_1"), false, "S2 precondition: no swap yet");
  stepStarted(stepCtx("turn_1", B), "turn_1");
  eq(deliveryChangedThisTurn("turn_1"), true, "S2 precondition: the step record saw B's delivery in turn 1");

  const settle = stepCtx("turn_2", B);
  turnStarted(settle, "turn_2");
  eq(uningressedTurn("turn_2"), true, "🔴 S2 THE FIX: a turn carrying the previous turn's LAST stamp brought no delivery of its own — UNINGRESSED");
  eq(currentWakeId(settle), undefined, "🔴 S2: …so it holds NO address, and never B's wake — B's answer is not a wake this settlement may speak under");
  eq(deliveryChangedThisTurn("turn_2"), false, "S2: the swap belongs to turn 1 alone — the new boundary carries no step record forward");

  turnStarted(stepCtx("turn_3", { principal: "U_C", wakeId: "wake-C-0003", deliveryId: "dlv-C-0003" }), "turn_3");
  eq(uningressedTurn("turn_3"), false, "S2 control: a fresh nonce is a real delivery — INGRESSED");
});

await contextStorage.run(new ContextContainer(), async () => {
  noteTurnBoundary("turn_old", A.deliveryId);
  noteTurnBoundary("turn_old_settle", A.deliveryId);
  eq(uningressedTurn("turn_old_settle"), true, "S2b: with no step record the boundary compares against the first stamp, as before");
});

await contextStorage.run(new ContextContainer(), async () => {
  eq(deliveryChangedThisTurn(undefined), false, "S3: an unreadable turn id proves nothing");
  stepStarted(stepCtx("turn_unseen", B), "turn_unseen");
  eq(deliveryChangedThisTurn("turn_unseen"), false, "S3: a step with no boundary for its turn records nothing");
  turnStarted(stepCtx("turn_s3", A), "turn_s3");
  stepStarted(stepCtx("turn_s3", A), "turn_s3");
  eq(deliveryChangedThisTurn("turn_s3"), false, "S3: a later step of the SAME delivery is not a change");
  stepStarted(stepCtx("turn_s3", B), "turn_s3");
  eq(deliveryChangedThisTurn("turn_s3"), true, "S3: a step carrying another delivery is");
  eq(deliveryChangedThisTurn("turn_other"), false, "S3: …and only for the turn that had it");
});
eq(deliveryChangedThisTurn("turn_s3"), false, "S3: outside an eve context the read answers false and never throws");

await contextStorage.run(new ContextContainer(), async () => {
  const wA = "wake-A-s4";
  const wB = "wake-B-s4";
  await registerUnifiedWakeTarget(store, ORG, wA, ROOM, iso(), WINDOW);
  await registerUnifiedWakeTarget(store, ORG, wB, ROOM, iso(), WINDOW);
  await store.markUnifiedWakeAnswered(ORG, wB, iso());
  ok((await store.getUnifiedWakeRecord(ORG, wB))?.answeredTurnId === undefined, "S4 precondition: B's wake is settled, with no turn id");

  turnStarted(stepCtx("turn_s4_ctl", { principal: B.principal, wakeId: wB, deliveryId: "dlv-s4-ctl" }), "turn_s4_ctl");
  const ctl = await resolveAnswerableReplyTarget(store, ORG, wB, WINDOW, "turn_s4_ctl", wB);
  eq(ctl.ok && ctl.via, "turn", "S4 control: with no in-turn swap arm 2 does not read the answered mark — unchanged behaviour");

  turnStarted(stepCtx("turn_s4", { principal: A.principal, wakeId: wA, deliveryId: "dlv-s4-A" }), "turn_s4");
  const swapped = stepCtx("turn_s4", { principal: B.principal, wakeId: wB, deliveryId: "dlv-s4-B" });
  stepStarted(swapped, "turn_s4");
  eq(currentWakeId(swapped), wB, "S4 precondition: after the swap the turn's wake is B's — the live stamp");
  eq(
    await resolveAnswerableReplyTarget(store, ORG, wB, WINDOW, "turn_s4", wB),
    { ok: false, reason: "answer-delivered" },
    "🔴 S4 THE FIX: A's turn may NOT post under B's settled answer wake through the `via:\"turn\"` arm",
  );
  const copy = replyRefusalMessage("answer-delivered", wB);
  ok(copy.includes("carried an answer") && !copy.includes("you already replied"), "S4: the refusal copy says what happened — the wake carried an answer — and never claims the model replied to it");

  const wC = "wake-C-s4";
  await registerUnifiedWakeTarget(store, ORG, wC, ROOM, iso(), WINDOW);
  await store.markUnifiedWakeAnswered(ORG, wC, iso(), "turn_earlier");
  eq(await resolveAnswerableReplyTarget(store, ORG, wC, WINDOW, "turn_s4", wC), { ok: false, reason: "answered" }, "S4: a swapped-in wake an EARLIER turn answered refuses as `answered`, as arm 4 does");
  const wD = "wake-D-s4";
  await registerUnifiedWakeTarget(store, ORG, wD, ROOM, iso(), WINDOW);
  await store.markUnifiedWakeAnswered(ORG, wD, iso(), "turn_s4");
  const mine = await resolveAnswerableReplyTarget(store, ORG, wD, WINDOW, "turn_s4", wD);
  eq(mine.ok && mine.via, "turn", "S4: a wake THIS turn answered stays answerable through arm 2 after the swap");
  const own = await resolveAnswerableReplyTarget(store, ORG, wB, WINDOW, "turn_s4", wA);
  ok(own.ok, "S4: A's own wake stays answerable after the swap (the same-conversation arm) — the fix narrows nothing A held");
});

await contextStorage.run(new ContextContainer(), async () => {
  const wA = "wake-A-s5";
  const wB = "wake-B-s5";
  await registerUnifiedWakeTarget(store, ORG, wA, ROOM, iso(), WINDOW);
  await registerUnifiedWakeTarget(store, ORG, wB, ROOM, iso(), WINDOW);

  turnStarted(stepCtx("turn_s5_ctl", { principal: A.principal, wakeId: wB, deliveryId: "dlv-s5-ctl" }), "turn_s5_ctl");
  markWakeRepliedThisTurn("turn_s5_ctl", wA);
  eq(await answeredContainerVia(ORG, "turn_s5_ctl", wB, ROOM), "turn", "S5 control: with no swap the in-turn arm credits the sibling reply — unchanged behaviour");

  turnStarted(stepCtx("turn_s5", { principal: A.principal, wakeId: wA, deliveryId: "dlv-s5-A" }), "turn_s5");
  markWakeRepliedThisTurn("turn_s5", wA);
  stepStarted(stepCtx("turn_s5", { principal: B.principal, wakeId: wB, deliveryId: "dlv-s5-B" }), "turn_s5");
  eq(
    await answeredContainerVia(ORG, "turn_s5", wB, ROOM),
    undefined,
    "🔴 S5 THE FIX: a reply posted before B's wake arrived is NOT credited to B — the in-turn arm stands aside and the durable at-or-after arm finds nothing",
  );
});

await contextStorage.run(new ContextContainer(), async () => {
  turnStarted(stepCtx("turn_s6_prev", A), "turn_s6_prev");
  turnStarted(stepCtx("turn_s6", A), "turn_s6");
  eq(uningressedTurn("turn_s6"), true, "S6 precondition: a settlement turn");
  ok(adoptTaskWakeThisTurn("turn_s6", "agent-s6", "wake-task-s6"), "S6 precondition: the settlement adopted the task's wake");
  const swapped = stepCtx("turn_s6", B);
  stepStarted(swapped, "turn_s6");
  eq(currentWakeId(swapped), "wake-task-s6", "🔴 S6: after B's bag arrives the turn still answers under the TASK's wake, never B's");
});

await contextStorage.run(new ContextContainer(), async () => {
  const base = { replied: false, blockingRefusal: undefined, token: `unified:${WINDOW}` } as const;
  turnStarted(stepCtx("turn_s7_ctl", A), "turn_s7_ctl");
  eq(proseDropMayRedrive({ ...base, turnId: "turn_s7_ctl" }), true, "S7 control: a turn that kept ONE delivery still redrives its dropped prose — unchanged behaviour");
  turnStarted(stepCtx("turn_s7", A), "turn_s7");
  stepStarted(stepCtx("turn_s7", B), "turn_s7");
  eq(proseDropMayRedrive({ ...base, turnId: "turn_s7" }), false, "🔴 S7 THE FIX: a swapped turn's prose drop is FINAL — no corrective wake under B's settled answer wake and B's bag");
  eq(proseDropMayRedrive({ ...base, turnId: "turn_s7_ctl", replied: true }), false, "S7: the existing conjuncts still hold — a turn that replied never redrives");
  eq(proseBlockingRefusal([ANSWER_DELIVERED_REFUSAL_REASON]), ANSWER_DELIVERED_REFUSAL_REASON, "S7: the arm-2 refusal BLOCKS the redrive too, so the correction never contradicts it");
});
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../agent/channels/unified.ts", import.meta.url), "utf8");
  ok(/if \(proseDropMayRedrive\(\{ replied, blockingRefusal, token: channel\.continuation\?\.token, turnId: currentTurnId\(bind\) \}\)/.test(src), "S7: the drop branch's redrive gate IS `proseDropMayRedrive` — a lost call reds here");
}

console.log(`✓ in-turn-auth-swap: ${n} assertions passed`);

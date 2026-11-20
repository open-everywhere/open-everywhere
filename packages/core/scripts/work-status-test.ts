import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-work-status-")), "ops.sqlite3");

const { _setDeploymentIdentityForTest } = await import("../agent/identity/deployment-identity.js");
_setDeploymentIdentityForTest({ workspace: "dev" });
const __slackStubs = await import("./_slack-test-stubs.js");
__slackStubs.registerSlackFixtureCodec();

const status = await import("../agent/hooks/work-status.js");
const workCancel = await import("../agent/channels/work-cancel.js");
const work = await import("../agent/channels/work.js");
const cancelTool = await import("../agent/tools/cancel_work.js");
const { cancelAnchoredTurn } = await import("../agent/channels/turn-cancel.js");
const { registerUnifiedWakeTarget } = await import("../agent/channels/unified-window.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { turnAnchorKey } = await import("../agent/channels/turn-registry.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};
const rejects = async (fn: () => Promise<unknown>, match: RegExp | ((e: Error) => boolean), label: string): Promise<void> => {
  await assert.rejects(fn, match as never, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveDist = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveDist, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};
const inSession = <T>(fn: () => T): T => contextStorage.run(new ContextContainer(), fn);

const ORG = "default";
const store = getOperationalStore();
const SEAT_TOKEN = "oe-dom:e2e-unified:oe-sup:g7";
const ORIGIN = { platform: "slack", channelId: "C_ROOM", threadTs: "100.1" } as const;
const WAKE_A = "11111111-2222-4333-8444-555555555555";
const WAKE_B = "22222222-3333-4444-8555-666666666666";
const bindingFor = (principalId: string) =>
  ({
    org: ORG,
    platform: "slack",
    workspace: "TW",
    surface: "C_ROOM",
    mode: "channel",
    visibility: "private",
    trust: "internal",
    principalId,
    target: { channelId: "C_ROOM" },
    threadTs: "100.1",
  }) as const;
for (const [wake, who] of [
  [WAKE_A, "U_ALICE"],
  [WAKE_B, "U_BOB"],
] as const) {
  await registerUnifiedWakeTarget(store, ORG, wake, ORIGIN, new Date().toISOString(), SEAT_TOKEN, true, "direct-mention", "slack/TW/C_ROOM", bindingFor(who), {
    binding: bindingFor(who),
    requester: { kind: "requester", principalId: who },
    nonMemberWake: false,
  });
}

async function forward(requestId: string, who: "U_ALICE" | "U_BOB", origin: typeof ORIGIN | Record<string, unknown> = ORIGIN): Promise<void> {
  await work.rememberWorkRequest(store, ORG, {
    requestId,
    seatToken: SEAT_TOKEN,
    wakeId: who === "U_ALICE" ? WAKE_A : WAKE_B,
    origin: origin as never,
    surfaceKey: "slack/TW/C_ROOM",
    binding: bindingFor(who) as never,
    requester: { kind: "requester", principalId: who },
    nonMemberWake: false,
    atIso: new Date().toISOString(),
  });
}

const reactions: { platform: string; channelId: string; messageId: string; on: boolean }[] = [];
const audits: { action?: string; detail?: Record<string, unknown> }[] = [];
const statusDeps = {
  org: () => ORG,
  store: () => store,
  react: async (platform: string, ref: { channelId: string; messageId: string }, on: boolean) => {
    reactions.push({ platform, ...ref, on });
    return true;
  },
  audit: async (row: unknown) => {
    audits.push(row as never);
  },
  now: () => new Date(),
};
const ANCHOR = turnAnchorKey("slack", "C_ROOM", "100.1")!;

console.log("§1 the ✋ sits on the asking message the room's wake names:");
eq(status.askingMessageOf({ platform: "discord", channelId: "D1", guildId: "G1", messageId: "M1" }), { platform: "discord", channelId: "D1", messageId: "M1" }, "a Discord job's ✋ goes on its trigger message");
eq(status.askingMessageOf({ platform: "slack", channelId: "C1", threadTs: "1.1", replyAnchorTs: "2.2" }), { platform: "slack", channelId: "C1", messageId: "1.1" }, "a Slack job in a thread: on the thread root, where the seat's own ✋ sits");
eq(status.askingMessageOf({ platform: "slack", channelId: "C1", replyAnchorTs: "2.2" }), { platform: "slack", channelId: "C1", messageId: "2.2" }, "a top-level Slack job: on its trigger");
eq(status.askingMessageOf({ platform: "slack", channelId: "C1" }), undefined, "a Slack origin with no message (a routine fire) has no asking message");
eq(status.askingMessageOf({ platform: "discord", channelId: "D1", guildId: "G1" }), undefined, "…nor a Discord one");
eq(status.askingMessageOf({ platform: "github", owner: "o", repo: "r", issueNumber: 1 } as never), undefined, "a surface with no reaction target places no ✋");

console.log("§2 W's task.started writes `working`, lists the job and places the ✋:");
const REQ_A = "aaaaaaaa-1111-4222-8333-444444444444";
const REQ_B = "bbbbbbbb-1111-4222-8333-444444444444";
const TASK_A = "agent-aaaaaa";
const TASK_B = "agent-bbbbbb";
await forward(REQ_A, "U_ALICE");
await forward(REQ_B, "U_BOB");
eq(await status.readWorkJobStatus(store, ORG, REQ_A), undefined, "before the task starts there is no status row");
const placed = await status.noteWorkJobStarted({ requestId: REQ_A, taskId: TASK_A }, statusDeps);
ok(placed, "🔴 the ✋ is placed when the job's task starts (D17)");
eq(reactions, [{ platform: "slack", channelId: "C_ROOM", messageId: "100.1", on: true }], "…once, on the asking message");
const startedA = await status.readWorkJobStatus(store, ORG, REQ_A);
eq([startedA?.state, startedA?.taskId, startedA?.anchorKey], ["working", TASK_A, ANCHOR], "🔴 the status row says `working`, names the task, and records the ✋'s anchor");
eq(await status.readAnchoredWorkJobs(store, ORG, ANCHOR), [{ requestId: REQ_A, taskId: TASK_A }], "the job is listed on its asking message");
const startRow = audits.find((a) => a.action === status.WORK_STATUS_ACTION);
eq(startRow?.detail, { requestId: REQ_A, taskId: TASK_A, state: "working", hand: "placed" }, "one work.status row: ids, the state and the ✋, nothing else");
await status.noteWorkJobStarted({ requestId: REQ_B, taskId: TASK_B }, statusDeps);
eq((await status.readAnchoredWorkJobs(store, ORG, ANCHOR)).map((j) => j.requestId), [REQ_A, REQ_B], "a second job on the same message is listed beside the first");
const before = reactions.length;
eq(await status.noteWorkJobStarted({ requestId: "cccccccc-1111-4222-8333-444444444444", taskId: "agent-cccccc" }, statusDeps), false, "a job with no request row places no ✋");
eq(reactions.length, before, "…and makes no reaction call");

console.log("§3 the ✋ comes off with the last job on the message:");
const r0 = reactions.length;
await status.noteWorkJobSettled({ requestId: REQ_B, taskId: TASK_B, status: "completed" }, statusDeps);
eq(reactions.length, r0, "🔴 the ✋ STAYS while another job on the message still works");
eq((await status.readWorkJobStatus(store, ORG, REQ_B))?.state, "completed", "the settled job's status says `completed`");
eq((await status.readAnchoredWorkJobs(store, ORG, ANCHOR)).map((j) => j.requestId), [REQ_A], "…and it leaves the message's list");
eq(audits.at(-1)?.detail?.hand, "kept", "its status row says the ✋ was kept");

console.log("§4 cancel_work stops a job by the request id its receipt named:");
type Delivered = Parameters<typeof cancelTool.cancelWork>[2] extends infer D ? (D extends { dispatch: (i: infer I) => unknown } ? I : never) : never;
const delivered: Delivered[] = [];
const cancelDeps = (isAdmin = false) => ({
  forwards: () => true,
  org: () => ORG,
  store: () => store,
  dispatch: async (input: Delivered) => {
    delivered.push(input);
  },
  isAdmin: () => isAdmin,
  audit: async (row: unknown) => {
    audits.push(row as never);
  },
});
const seatCtx = (callId: string, wake = WAKE_A) => ({
  channel: { kind: "unified", continuationToken: `unified:${SEAT_TOKEN}` },
  session: { id: "sess-seat", turn: { id: `turn-${callId}` }, auth: { current: { attributes: { oe_wake_id: wake } } } },
  callId,
});
const REQ_EARLY = "dddddddd-1111-4222-8333-444444444444";
await forward(REQ_EARLY, "U_ALICE");
await rejects(() => inSession(() => cancelTool.cancelWork({ requestId: REQ_EARLY }, seatCtx("c-early"), cancelDeps())), /has not started in the work session yet/, "🔴 a job whose task has not started yet has nothing to stop, and says so");
eq(delivered.length, 0, "…and nothing is relayed");
const byRequest = await inSession(() => cancelTool.cancelWork({ requestId: REQ_A }, seatCtx("c-req"), cancelDeps()));
eq(byRequest.taskId, TASK_A, "🔴 a working job's request id resolves to its task");
eq(delivered.length, 1, "…and ONE cancel is relayed");
eq(work.parseWorkCancels(delivered[0]!.message), [{ cancelId: byRequest.cancelId, taskId: TASK_A }], "…for exactly that task");
const settled = await inSession(() => cancelTool.cancelWork({ requestId: REQ_B }, seatCtx("c-done", WAKE_B), cancelDeps()));
ok(settled.note.includes("finished") && settled.note.includes("nothing left to stop"), "🔴 the receipt for a settled job says it already finished");
eq(settled.taskId, TASK_B, "…and still names its task");
eq(delivered.length, 2, "…and the cancel is still relayed: W's eve__task_cancel answers it (the decision-wake brake pins that path)");
await work.rememberWorkTask(store, ORG, TASK_B, REQ_B, new Date().toISOString());
const settledByTask = await inSession(() => cancelTool.cancelWork({ taskId: TASK_B }, seatCtx("c-done-t", WAKE_B), cancelDeps()));
ok(settledByTask.note.includes("nothing left to stop"), "…by its task id as well");
eq(delivered.length, 3, "…relayed the same way");
await rejects(() => inSession(() => cancelTool.cancelWork({ requestId: REQ_A, taskId: TASK_A } as never, seatCtx("c-both"), cancelDeps())), /exactly one of/, "both ids at once are refused");
await rejects(() => inSession(() => cancelTool.cancelWork({} as never, seatCtx("c-none"), cancelDeps())), /exactly one of/, "…and so is neither");
await rejects(() => inSession(() => cancelTool.cancelWork({ requestId: REQ_A }, seatCtx("c-bob", WAKE_B), cancelDeps())), (e: Error) => e.message === cancelTool.CANCEL_WORK_NOT_YOURS_MESSAGE, "🔴 D10 holds by request id: Bob cannot stop Alice's job");
await rejects(() => inSession(() => cancelTool.cancelWork({ requestId: "eeeeeeee-1111-4222-8333-444444444444" }, seatCtx("c-nosuch"), cancelDeps())), /forwarded no job with request id/, "a request this seat never forwarded is refused");
eq(delivered.length, 3, "…and no refusal relays anything");

console.log("§5 a ✋ click stops the jobs on its message that the clicker may stop, and only those:");
const REQ_C = "ffffffff-1111-4222-8333-444444444444";
const TASK_C = "agent-cccccd";
await forward(REQ_C, "U_BOB");
await status.noteWorkJobStarted({ requestId: REQ_C, taskId: TASK_C }, statusDeps);
eq((await status.readAnchoredWorkJobs(store, ORG, ANCHOR)).map((j) => j.requestId).sort(), [REQ_A, REQ_C].sort(), "two live jobs on the message: Alice's and Bob's");
const clickDeps = (isAdmin = false) => ({
  store,
  dispatch: async (input: Delivered) => {
    delivered.push(input);
  },
  audit: async (row: unknown) => {
    audits.push(row as never);
  },
  isAdmin: () => isAdmin,
  now: () => new Date(),
});
const actor = (principalId: string, workspace = "TW") => ({ requester: { kind: "requester" as const, principalId }, binding: { platform: "slack", workspace } });
const d0 = delivered.length;
const alice = await workCancel.stopAnchoredWorkJobs({ org: ORG, anchorKey: ANCHOR, actor: actor("U_ALICE"), clickId: "click-alice" }, clickDeps());
eq(alice, { listed: 2, relayed: 1, refused: 1, repeated: 0 }, "🔴 Alice's click stops HER job and refuses Bob's");
eq(delivered.slice(d0).flatMap((d) => work.parseWorkCancels(d.message).map((c) => c.taskId)), [TASK_A], "🔴 …and the one cancel names only her task");
const aliceToken = work.workTokenForSeat(SEAT_TOKEN)!;
ok(await work.takeWorkCancel(store, ORG, aliceToken, TASK_A, "turn-W-redeem"), "W redeems the ticket the click wrote");
const aliceAgain = await workCancel.stopAnchoredWorkJobs({ org: ORG, anchorKey: ANCHOR, actor: actor("U_ALICE"), clickId: "click-alice" }, clickDeps());
eq([aliceAgain.relayed, aliceAgain.repeated], [0, 1], "🔴 a second click by the same person counts as a REPEAT, never as a new relay");
eq(delivered.length, d0 + 1, "🔴 …and relays nothing new (postOnce on the click)");
ok(await work.workCancelRedeemed(store, ORG, aliceToken, TASK_A), "🔴 …and leaves the SPENT ticket spent: a repeat never re-arms W's stop");
ok(!(await work.takeWorkCancel(store, ORG, aliceToken, TASK_A, "turn-W-other")), "…so another W turn cannot redeem it again");
const flaky = { ...clickDeps(), dispatch: async () => {
  throw new Error("the self-dispatch hop is down");
} };
const failed = await workCancel.stopAnchoredWorkJobs({ org: ORG, anchorKey: ANCHOR, actor: actor("U_BOB"), clickId: "click-bob-flaky" }, flaky);
eq([failed.relayed, failed.repeated], [0, 0], "a click whose relay threw counts neither as relayed nor as a repeat");
const d1 = delivered.length;
const retried = await workCancel.stopAnchoredWorkJobs({ org: ORG, anchorKey: ANCHOR, actor: actor("U_BOB"), clickId: "click-bob-flaky" }, clickDeps());
eq([retried.relayed, retried.repeated], [1, 0], "🔴 the same person's retry after a failed relay DELIVERS, never reads as a repeat");
eq(delivered.slice(d1).flatMap((d) => work.parseWorkCancels(d.message).map((c) => c.taskId)), [TASK_C], "…for Bob's own job");
const stranger = await workCancel.stopAnchoredWorkJobs({ org: ORG, anchorKey: ANCHOR, actor: actor("U_MALLORY"), clickId: "click-mallory" }, clickDeps());
eq(stranger, { listed: 2, relayed: 0, refused: 2, repeated: 0 }, "🔴 a stranger's click stops nothing");
const lookalike = await workCancel.stopAnchoredWorkJobs({ org: ORG, anchorKey: ANCHOR, actor: actor("U_ALICE", "TW-OTHER"), clickId: "click-lookalike" }, clickDeps());
eq(lookalike.relayed, 0, "🔴 the same user id in another workspace is not the requester");
eq(delivered.length, d0 + 2, "…and neither refusal relays anything (the one extra is Bob's retried relay)");
const refusedRows = audits.filter((a) => a.action === work.WORK_CANCEL_ACTION && a.detail?.via === "reaction" && a.detail?.outcome === "refused");
ok(refusedRows.length >= 3, "every refused click writes a work.cancel_relayed row with `refused`, so it can be counted");
const admin = await workCancel.stopAnchoredWorkJobs({ org: ORG, anchorKey: ANCHOR, actor: actor("U_ADMIN"), clickId: "click-admin" }, clickDeps(true));
eq(admin, { listed: 2, relayed: 2, refused: 0, repeated: 0 }, "🔴 an admin's click stops both jobs");
await status.noteWorkJobSettled({ requestId: REQ_C, taskId: TASK_C, status: "cancelled" }, statusDeps);
eq((await workCancel.stopAnchoredWorkJobs({ org: ORG, anchorKey: ANCHOR, actor: actor("U_BOB"), clickId: "click-bob" }, clickDeps())).listed, 1, "a settled job is not live: only Alice's job is still listed");
eq(await workCancel.stopAnchoredWorkJobs({ org: ORG, anchorKey: "slack:C_ROOM:999.9", actor: actor("U_ALICE"), clickId: "click-elsewhere" }, clickDeps()), { listed: 0, relayed: 0, refused: 0, repeated: 0 }, "a message with no job lists nothing");
const r1 = reactions.length;
await status.noteWorkJobSettled({ requestId: REQ_A, taskId: TASK_A, status: "cancelled" }, statusDeps);
eq(reactions.slice(r1), [{ platform: "slack", channelId: "C_ROOM", messageId: "100.1", on: false }], "🔴 the LAST job's settlement takes the ✋ off the asking message");
eq((await status.readWorkJobStatus(store, ORG, REQ_A))?.state, "cancelled", "…and its status says `cancelled`");
const r2 = reactions.length;
await status.noteWorkJobSettled({ requestId: REQ_A, taskId: TASK_A, status: "cancelled" }, statusDeps);
eq(reactions.length, r2 + 1, "a replayed settlement only repeats the idempotent removal");
eq(await status.readAnchoredWorkJobs(store, ORG, ANCHOR), [], "…and the list stays empty");
await status.noteWorkJobSettled({ requestId: REQ_B, taskId: TASK_B, status: "cancelled" }, statusDeps);
eq((await status.readWorkJobStatus(store, ORG, REQ_B))?.state, "completed", "🔴 a replayed settlement never turns a `completed` job into `cancelled`");
const r3 = reactions.length;
eq(await status.noteWorkJobStarted({ requestId: REQ_B, taskId: TASK_B }, statusDeps), false, "🔴 a replayed task.started of a settled job places no ✋");
eq(reactions.length, r3, "…makes no reaction call");
eq((await status.readWorkJobStatus(store, ORG, REQ_B))?.state, "completed", "…and leaves the settled state");
eq((await status.readAnchoredWorkJobs(store, ORG, ANCHOR)).map((j) => j.requestId), [], "…and does not list the job again");
eq(status.settledWorkJobStateFor("completed", true), "cancelled", "🔴 eve's `completed` with a redeemed cancel ticket is a STOP");
eq(status.settledWorkJobStateFor("completed", false), "completed", "…and `completed` with no ticket stays a completion");
eq(status.settledWorkJobStateFor("failed", true), "failed", "a redeemed ticket never turns a failure into a stop");
eq(status.settledWorkJobStateFor("cancelled", false), "cancelled", "eve's own `cancelled` passes through");
eq(status.settledWorkJobState("failed"), "failed", "eve's `failed` is a failure");
eq(status.settledWorkJobState("timed_out"), "failed", "…and so is any other non-completion");

console.log("§6 cancelAnchoredTurn takes the job arm for a ✋ on a job's message:");
let attached = 0;
const door = (() => {
  attached++;
  return { cancel: async () => ({ status: "accepted" }) };
}) as never;
const seen: unknown[] = [];
const stopper = (answer: { listed: number; relayed: number; refused: number }) => async (input: unknown) => {
  seen.push(input);
  return answer;
};
const jobArm = await cancelAnchoredTurn({ org: ORG, platform: "slack", workspace: "TW", requestedBy: "U_ALICE", via: "reaction", query: { anchorKey: ANCHOR }, attachSession: door, stopForwardedJobs: stopper({ listed: 1, relayed: 1, refused: 0 }) });
eq(jobArm.outcome, "requested", "🔴 a ✋ on a message with a live job stops the job");
eq(attached, 0, "🔴 …and never reaches eve's TURN cancel door: a W turn cancel would stop every job in the conversation");
eq(seen[0], { org: ORG, anchorKey: ANCHOR, actor: { requester: { kind: "requester", principalId: "U_ALICE" }, binding: { platform: "slack", workspace: "TW" } }, clickId: `${ANCHOR}:slack:TW:U_ALICE` }, "the job arm gets the reactor as the actor, in its own namespace");
const refusedArm = await cancelAnchoredTurn({ org: ORG, platform: "slack", workspace: "TW", requestedBy: "U_MALLORY", via: "reaction", query: { anchorKey: ANCHOR }, attachSession: door, stopForwardedJobs: stopper({ listed: 1, relayed: 0, refused: 1 }) });
eq(refusedArm.outcome, "refused", "a click by someone who may stop nothing is refused");
eq(attached, 0, "…and still cancels no turn");
const noJob = await cancelAnchoredTurn({ org: ORG, platform: "slack", workspace: "TW", requestedBy: "U_ALICE", via: "reaction", query: { anchorKey: "slack:C_ROOM:999.9" }, attachSession: door, stopForwardedJobs: stopper({ listed: 0, relayed: 0, refused: 0 }) });
eq(noJob.outcome, "no_turn_found", "a message with no live job falls through to the turn arm, unchanged");
const { recordTurnAnchor } = await import("../agent/channels/turn-registry.js");
const W_ANCHOR = turnAnchorKey("slack", "C_ROOM", "300.3")!;
await recordTurnAnchor(ORG, { windowKey: `unified:${work.workTokenForSeat(SEAT_TOKEN)!}`, anchorKey: W_ANCHOR, sessionId: "sess-W", turnId: "turn-W", surfaceKey: "slack/TW/C_ROOM" }, new Date().toISOString());
const wTurn = await cancelAnchoredTurn({ org: ORG, platform: "slack", workspace: "TW", requestedBy: "U_MALLORY", via: "reaction", query: { anchorKey: W_ANCHOR }, attachSession: door, stopForwardedJobs: stopper({ listed: 0, relayed: 0, refused: 0 }) });
eq([wTurn.outcome, wTurn.sessionId], ["refused", "sess-W"], "🔴 a click that resolves to the WORK SESSION's turn is refused");
eq(attached, 0, "🔴 …and never reaches eve's cancel door");
const wTurnCmd = await cancelAnchoredTurn({ org: ORG, platform: "slack", workspace: "TW", requestedBy: "U_MALLORY", via: "command", query: { anchorKey: W_ANCHOR }, attachSession: door });
eq([wTurnCmd.outcome, attached], ["refused", 0], "…and so is a command that resolves to it");
const SEAT_ANCHOR = turnAnchorKey("slack", "C_ROOM", "400.4")!;
await recordTurnAnchor(ORG, { windowKey: `unified:${SEAT_TOKEN}`, anchorKey: SEAT_ANCHOR, sessionId: "sess-seat", turnId: "turn-seat", surfaceKey: "slack/TW/C_ROOM" }, new Date().toISOString());
const seatTurn = await cancelAnchoredTurn({ org: ORG, platform: "slack", workspace: "TW", requestedBy: "U_ALICE", via: "reaction", query: { anchorKey: SEAT_ANCHOR }, attachSession: door, stopForwardedJobs: stopper({ listed: 0, relayed: 0, refused: 0 }) });
eq([seatTurn.outcome, attached], ["requested", 1], "the seat's own turn is still stopped as before (negative control for the W refusal)");
const repeatArm = await cancelAnchoredTurn({ org: ORG, platform: "slack", workspace: "TW", requestedBy: "U_ALICE", via: "reaction", query: { anchorKey: ANCHOR }, attachSession: door, stopForwardedJobs: stopper({ listed: 1, relayed: 0, refused: 0, repeated: 1 } as never) });
eq([repeatArm.outcome, repeatArm.message.includes("already asked")], ["requested", true], "a repeat click says the stop was already asked for");
const { turnAnchorRecordable } = await import("../agent/hooks/turn-anchor.js");
const W_TOKEN = work.workTokenForSeat(SEAT_TOKEN)!;
const childOfW = { channel: { kind: "unified", continuationToken: `unified:${W_TOKEN}` }, session: { id: "sess-child", turn: { id: "turn-child" }, parent: { sessionId: "sess-w", callId: "call-9" } } };
const wItself = { channel: { kind: "unified", continuationToken: `unified:${W_TOKEN}` }, session: { id: "sess-w", turn: { id: "turn-w" } } };
eq(turnAnchorRecordable(childOfW as never), false, "🔴 a child of the work session records no turn anchor");
const liveChild = (stamped: string) => ({
  channel: { kind: "subagent", continuationToken: "subagent:wrun_W:call-9" },
  session: { id: "sess-child", turn: { id: "turn-child" }, parent: { sessionId: "sess-w", callId: "call-9" }, auth: { current: { attributes: { oe_window_token: stamped } } } },
});
eq(turnAnchorRecordable(liveChild(W_TOKEN) as never), false, "🔴 …in the live shape too: a `subagent:` child whose stamp names W records no anchor");
eq(turnAnchorRecordable(liveChild(SEAT_TOKEN) as never), true, "…while the same shape stamped with a SEAT token (a seat's own child) still records one");
eq(turnAnchorRecordable(wItself as never), true, "…W itself still does (the turn arm refuses it by its token)");
eq(turnAnchorRecordable(seatCtx("c-anchor") as never), true, "…and so does the seat");
const before6 = seen.length;
await cancelAnchoredTurn({ org: ORG, platform: "slack", workspace: "TW", requestedBy: "U_ALICE", via: "command", query: { channelKey: "slack:C_ROOM" }, attachSession: door, stopForwardedJobs: stopper({ listed: 1, relayed: 1, refused: 0 }) });
eq(seen.length, before6, "a `/oe stop` command never takes the job arm: it names no message");

console.log(`\n✓ work-status: ${n} assertions`);

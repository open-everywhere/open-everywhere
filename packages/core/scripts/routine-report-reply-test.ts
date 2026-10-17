import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-routine-report-reply-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

const { registerSlackFixtureMapper, registerSlackFixtureCodec } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();
registerSlackFixtureCodec();

const { deploymentOrg, WORK_FIRE_ROUTINE_ATTR, WORK_FIRE_ROUTINE_SURFACE_ATTR } = await import("../agent/identity/binding.js");
const { OE_FROZEN_SURFACE_BINDING_ATTR } = await import("../agent/identity/frozen-surface-binding.internal.js");
const { divertToUnifiedWindow, workResultAttributes } = await import("../agent/channels/unified.js");
const { postUnifiedReply } = await import("../agent/channels/unified-reply.js");
const { replyAuditFor } = await import("../agent/channels/reply-post.js");
const { mintWakeId } = await import("../agent/channels/unified-window.js");
const { formatWindowToken } = await import("../agent/channels/window-key.js");
const { workRequestIdFor } = await import("../agent/channels/work.js");
const { FIRE_REQUESTER } = await import("../agent/routines/fire-work.js");
const { renderWakeEnvelope } = await import("../agent/channels/wake-envelope.js");
const { OE_CHAT_NONMEMBER_ATTR } = await import("../agent/access/taint-signal.js");
const { registerWakeOriginCodec } = await import("../agent/channels/wake-origin-codec.js");
const { registerPostArm } = await import("../agent/channels/post-arms.js");
const reportThread = await import("../agent/routines/report-thread.js");
const routineStore = await import("../agent/routines/store.js");
const { attentionPausePatch, isPausedForCheckIn, ROUTINE_CHECKIN_ACTION } = await import("../agent/routines/attention.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
type Routine = import("../agent/routines/routine.js").Routine;
type UnifiedWakeOrigin = import("../agent/channels/unified-window.js").UnifiedWakeOrigin;
type ReplyRoutine = import("../agent/routines/report-thread.js").ReplyRoutine;

const ORG = deploymentOrg();
const store = getOperationalStore();
const TEAM = "T1";
const CHAN = "C1";
const SURFACE = `slack/${TEAM}/${CHAN}`;
const STANDING = formatWindowToken({ domain: "ops", windowId: "ops", generation: 1 });
const TOP: UnifiedWakeOrigin = { platform: "slack", channelId: CHAN };
let tsSeq = 0;

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: CHAN },
    trigger: { kind: "interval", everyMinutes: 60 },
    prompt: "Post the open incident count.",
    createdBy: "U-OWNER",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: "2026-07-02T12:00:00.000Z",
    ...over,
  };
}

const envelope = (author: { from: "human" | "system"; authorId?: string; trust?: "principal" | "peer" | "unauth" }): string =>
  renderWakeEnvelope({
    reason: "mention",
    currentTime: "2026-07-02T12:05:00.000Z",
    channel: { id: CHAN },
    messages: [
      {
        trigger: true,
        from: author.from,
        trust: author.from === "human" ? (author.trust ?? "peer") : "relay",
        author: author.authorId ?? "open-everywhere",
        ...(author.authorId !== undefined ? { authorId: author.authorId } : {}),
        body: "thanks, 3 is fine",
        sentAt: "2026-07-02T12:05:00.000Z",
        id: "1751827980.000100",
      },
    ],
  });

const delivered: string[] = [];
const captureReceive = ((_ch: unknown, rawTarget: unknown) => ({
  async send() {
    delivered.push((rawTarget as { wakeId: string }).wakeId);
    return undefined as never;
  },
})) as never;

async function inbound(origin: UnifiedWakeOrigin, opts: { readonly from?: "human" | "system"; readonly author?: string; readonly trust?: "principal" | "peer" | "unauth"; readonly guest?: boolean; readonly internal?: boolean } = {}): Promise<void> {
  const wakeId = mintWakeId();
  await divertToUnifiedWindow(captureReceive, {
    message: envelope({ from: opts.from ?? "human", ...(opts.from === "system" ? {} : { authorId: opts.author ?? "U-MEMBER" }), ...(opts.trust !== undefined ? { trust: opts.trust } : {}) }),
    token: STANDING,
    window: { wakeId, origin, addressing: "direct-mention" },
    surfaceKey: SURFACE,
    auth: { attributes: { team_id: TEAM, channel_id: CHAN, ...(opts.guest === true ? { [OE_CHAT_NONMEMBER_ATTR]: "true" } : {}) } },
    ...(opts.internal === true ? { internalDispatch: true as const } : {}),
  });
  ok(delivered.at(-1) === wakeId, "precondition: the wake was delivered, so the check-in never holds a message back");
}

registerPostArm({ platform: "slack", dispatchUnified: async () => `1751457600.${String(++tsSeq).padStart(6, "0")}` });

async function postReport(routineId: string, origin: UnifiedWakeOrigin, opts: { readonly replyWake?: string } = {}): Promise<string> {
  const fireWake = mintWakeId();
  const requestId = workRequestIdFor(`fire:${fireWake}`);
  const binding = { org: ORG, platform: "slack", workspace: TEAM, surface: CHAN, mode: "channel", visibility: "public", trust: "internal", principalId: "U-OWNER", principalAttested: true, target: { channelId: CHAN } };
  const attributes = {
    ...workResultAttributes({ requestId, requester: FIRE_REQUESTER, nonMemberWake: false, tainted: false, fireRoutine: { id: routineId, surfaceKey: SURFACE } }),
    [OE_FROZEN_SURFACE_BINDING_ATTR]: JSON.stringify(binding),
  };
  const ctx = { channel: { kind: "unified" }, session: { id: `s-${routineId}`, auth: { current: { attributes } } } } as never;
  const audit = replyAuditFor(ctx, "tool", opts.replyWake ?? fireWake);
  return postUnifiedReply(origin, "3 incidents are open.", {}, audit);
}

async function attentionOf(id: string) {
  return (await routineStore.getRoutine(ORG, SURFACE, id))?.attention;
}

{
  const wake = "w-1";
  const routineRef: ReplyRoutine = { id: "r-1", surfaceKey: SURFACE, requestId: workRequestIdFor(`fire:${wake}`) };
  ok(reportThread.reportRoutineOf(routineRef, wake) === routineRef, "pure: a reply under the fire's OWN wake posts the routine's report");
  ok(reportThread.reportRoutineOf(routineRef, "w-other") === undefined, "🔴 pure: a reply under any other wake records no routine");
  ok(reportThread.reportRoutineOf(undefined, wake) === undefined && reportThread.reportRoutineOf(routineRef, undefined) === undefined, "pure: no routine stamp or no wake records nothing");

  const top = reportThread.reportReplyThreads(TOP, "1751827680.000001");
  ok(top.length === 1 && top[0]!.channelKey === `slack/${CHAN}` && top[0]!.threadKey === "1751827680.000001", "pure: a top-level Slack report records the thread a reply under it opens");
  const threaded = reportThread.reportReplyThreads({ ...TOP, threadTs: "1750939280.000009" }, "1751827680.000002");
  ok(threaded.length === 1 && threaded[0]!.threadKey === "1750939280.000009", "pure: a report INSIDE a thread records that thread, once");
  const anchored = reportThread.reportReplyThreads({ ...TOP, replyAnchorTs: "1750939280.000123" }, "1751827680.000003");
  ok(anchored.length === 1 && anchored[0]!.threadKey === "1750939280.000123", "🔴 pure: a report placed under an anchor records the ANCHOR's thread — Slack threads do not nest");

  ok(reportThread.vouchedReplier(envelope({ from: "human", authorId: "U-M", trust: "peer" }), "U-M") === "U-M", "pure: a `peer` author is a vouched member");
  ok(reportThread.vouchedReplier(envelope({ from: "human", authorId: "U-M", trust: "principal" }), "U-M") === "U-M", "pure: a `principal` author is a vouched member");
  ok(reportThread.vouchedReplier(envelope({ from: "human", authorId: "U-M", trust: "unauth" }), "U-M") === undefined, "🔴 pure: an `unauth` author is NOT a member — the gate needs a positive signal, never an absent refutation");
  ok(reportThread.vouchedReplier(envelope({ from: "human", authorId: "U-M", trust: "peer" }), "U-OTHER") === undefined, "pure: the vouched author must be the wake's requester");
  ok(reportThread.vouchedReplier("plain text", "U-M") === undefined, "pure: a text with no envelope vouches nobody");

  type GuildOrigin = { readonly guildId?: string; readonly channelId: string; readonly thread?: true };
  registerWakeOriginCodec("discord", {
    validate: () => true,
    threadRef: (o) => ({ channelKey: `discord/${(o as GuildOrigin).guildId}/${o.channelId}`, threadKey: o.channelId }),
    isThreadScoped: (o) => (o as GuildOrigin).thread === true,
    containerId: (o) => o.channelId,
    replyThreadUnder: (o) => o,
  });
  ok(reportThread.reportReplyThreads({ platform: "discord", guildId: "G1", channelId: "D1" }, "m-1").length === 0, "🔴 pure: a codec answer that is not thread-scoped is discarded — a container key would match every message");
  ok(reportThread.reportReplyThreads({ platform: "discord", guildId: "G1", channelId: "D2", thread: true }, "m-2").length === 1, "pure: a report inside a Discord thread records that thread");
}

{
  const id = "r-digest";
  await routineStore.addRoutine({} as never, routine({ id, attention: { runs: 101, warnedAtRun: 100, cardId: "card-1" } }));

  const attrs = workResultAttributes({ requestId: "q-1", requester: FIRE_REQUESTER, nonMemberWake: false, tainted: false, fireRoutine: { id, surfaceKey: SURFACE } });
  ok(attrs[WORK_FIRE_ROUTINE_ATTR] === id && attrs[WORK_FIRE_ROUTINE_SURFACE_ATTR] === SURFACE, "🔴 stamp: a fire's result wake names its routine");
  const jobAttrs = workResultAttributes({ requestId: "q-2", requester: FIRE_REQUESTER, nonMemberWake: false, tainted: false });
  ok(!(WORK_FIRE_ROUTINE_ATTR in jobAttrs) && !(WORK_FIRE_ROUTINE_SURFACE_ATTR in jobAttrs), "stamp: a seat's job's result wake names no routine");

  const ts = await postReport(id, TOP);
  const row = await store.getRoutineReportThread(ORG, `slack/${CHAN}`, ts, new Date().toISOString());
  ok(row !== null && row.routineId === id && row.routineSurface === SURFACE, "🔴 record: the report's post records its reply thread under the routine");

  const before = (await readAudit({ org: ORG, action: ROUTINE_CHECKIN_ACTION })).length;
  await inbound({ ...TOP, threadTs: ts });
  ok((await attentionOf(id)) === undefined, "🔴 count: a member's reply in the report's thread clears the check-in record, as Keep going does");
  const rows = await readAudit({ org: ORG, action: ROUTINE_CHECKIN_ACTION });
  const last = rows.at(-1) as { principalId?: string; detail?: Record<string, unknown> } | undefined;
  ok(rows.length === before + 1 && last?.detail?.via === "reply" && last.detail.id === id && last.detail.runs === 101, "count: one `routine.checkin` row, `via: reply`, with the runs it cleared");
  ok(typeof last?.principalId === "string" && last.principalId.length > 0, "count: the row names who replied (as a principal, never the reply's words)");
  ok(!JSON.stringify(last?.detail ?? {}).includes("3 is fine"), "count: the row holds no words of the reply");
  const live = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(live?.status === "active", "count: the routine keeps running");
}

{
  const id = "r-noise";
  const counted = { runs: 50 };
  await routineStore.addRoutine({} as never, routine({ id, attention: counted }));
  const ts = await postReport(id, TOP);

  await inbound(TOP);
  ok((await attentionOf(id))?.runs === 50, "🔴 a top-level message in the room is not a reply to the report");
  await inbound({ ...TOP, threadTs: "1750939280.999999" });
  ok((await attentionOf(id))?.runs === 50, "a reply in ANOTHER thread does not count");
  await inbound({ ...TOP, threadTs: ts }, { guest: true });
  ok((await attentionOf(id))?.runs === 50, "🔴 a guest's or an outside account's reply does not count");
  await inbound({ ...TOP, threadTs: ts }, { trust: "unauth" });
  ok((await attentionOf(id))?.runs === 50, "🔴 a person the host could not vouch as a member (no refutation either) does not count");
  await inbound({ ...TOP, threadTs: ts }, { from: "system" });
  ok((await attentionOf(id))?.runs === 50, "a system or bot message in the thread does not count");
  await inbound({ ...TOP, threadTs: ts }, { internal: true });
  ok((await attentionOf(id))?.runs === 50, "an internal host dispatch into the thread does not count");

  const other = "r-other-wake";
  await routineStore.addRoutine({} as never, routine({ id: other, attention: { runs: 9 } }));
  const tsOther = await postReport(other, TOP, { replyWake: mintWakeId() });
  ok((await store.getRoutineReportThread(ORG, `slack/${CHAN}`, tsOther, new Date().toISOString())) === null, "🔴 a reply under a wake that is not the fire's records no report thread");
  await inbound({ ...TOP, threadTs: tsOther });
  ok((await attentionOf(other))?.runs === 9, "…so a reply under it does not count");
}

{
  const id = "r-paused";
  await routineStore.addRoutine({} as never, routine({ id, attention: { runs: 124, warnedAtRun: 100, cardId: "card-p" } }));
  const ts = await postReport(id, TOP);
  const paused = await routineStore.updateRoutine(ORG, SURFACE, id, attentionPausePatch({ attention: { runs: 124, warnedAtRun: 100, cardId: "card-p" } }, 124, new Date()));
  ok(paused !== null && isPausedForCheckIn(paused), "precondition: the check-in paused the routine");
  await inbound({ ...TOP, threadTs: ts });
  const after = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after !== null && isPausedForCheckIn(after), "🔴 a reply never resumes a routine the check-in paused: its Resume card still works");

  const stopped = "r-stopped";
  await routineStore.addRoutine({} as never, routine({ id: stopped, status: "disabled", disabledReason: "cancelled", attention: { runs: 7 } }));
  const tsStopped = await postReport(stopped, TOP);
  await inbound({ ...TOP, threadTs: tsStopped });
  ok((await attentionOf(stopped))?.runs === 7, "a routine that stopped for another reason is left alone");

  const fresh = "r-fresh";
  await routineStore.addRoutine({} as never, routine({ id: fresh }));
  const tsFresh = await postReport(fresh, TOP);
  const outcome = await reportThread.checkInFromReportReply({ org: ORG, origin: { ...TOP, threadTs: tsFresh }, principalId: "U-MEMBER" });
  ok(outcome === "nothing-to-clear", "a routine with no check-in record is not written");
}

{
  const id = "r-job";
  const anchor = "1750028080.000777";
  await routineStore.addRoutine({} as never, routine({ id, sessionMode: "job", attention: { runs: 30 } }));
  await postReport(id, { ...TOP, threadTs: anchor });
  await inbound({ ...TOP, threadTs: anchor });
  ok((await attentionOf(id)) === undefined, "🔴 a job routine reports inside its own thread, and a member's reply there counts");

  const old = "r-old";
  await routineStore.addRoutine({} as never, routine({ id: old, attention: { runs: 12 } }));
  const ts = await postReport(old, TOP);
  const later = new Date(Date.now() + reportThread.REPORT_THREAD_TTL_MS + 60_000);
  const deps = { ...reportThread.liveReportReplyDeps(), now: () => later };
  ok((await reportThread.checkInFromReportReply({ org: ORG, origin: { ...TOP, threadTs: ts }, principalId: "U-MEMBER" }, deps)) === "no-report", "a reply to a report older than the window does not count");
  ok((await attentionOf(old))?.runs === 12, "…and the count stays");
}

console.log(`✓ routine-report-reply: ${passed} assertions passed`);
process.exit(0);

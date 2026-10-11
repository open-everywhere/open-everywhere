import assert from "node:assert/strict";
import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { registerGithubProvider } from "@open-everywhere/provider-github/agent/register.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { registerLinearProvider } from "@open-everywhere/provider-linear/agent/register.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { unifiedThreadRef, isUnifiedWakeOrigin, type UnifiedWakeOrigin } from "@open-everywhere/core/agent/channels/unified-window.js";
import { threadRootMessageOf, hasThreadDoneReactionPath } from "@open-everywhere/core/agent/channels/thread-seat-close.js";
import { recordThreadSeatOpen, recordThreadSeatClose, readThreadSeatState, threadSeatOrigin, type ThreadSeatStateStore } from "@open-everywhere/core/agent/channels/thread-seat-state.js";
import { renderSeatSteer } from "@open-everywhere/core/agent/tools/message_thread_seat.js";
import messageThreadSeat from "@open-everywhere/core/agent/tools/message_thread_seat.js";
import readThreadSeat from "@open-everywhere/core/agent/tools/read_thread_seat.js";
import { resolveWindowGated } from "@open-everywhere/core/agent/access/window-gated.js";
import { formatWindowToken, threadSeatWindowId, taskWindowId } from "@open-everywhere/core/agent/channels/window-key.js";
import type { ThreadSeatStateRow, ThreadSeatStateWrite } from "@open-everywhere/core/agent/operational/store.js";

registerNotionProvider();
registerSlackProvider();
registerGithubProvider();
registerTeamsProvider();
registerLinearProvider();
registerDiscordProvider();

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

function fakeStore(): ThreadSeatStateStore & { rows: Map<string, ThreadSeatStateRow> } {
  const rows = new Map<string, ThreadSeatStateRow>();
  return {
    rows,
    async putThreadSeatState(_org: string, row: ThreadSeatStateWrite, at: string) {
      rows.set(`${row.channelKey}|${row.threadKey}`, { ...row, updatedAt: at });
    },
    async getThreadSeatState(_org: string, channelKey: string, threadKey: string) {
      return rows.get(`${channelKey}|${threadKey}`) ?? null;
    },
    async closeThreadSeatState(_org: string, channelKey: string, threadKey: string, seatToken: string, state: "completed" | "expired" | "closed", report: string | null, at: string) {
      const k = `${channelKey}|${threadKey}`;
      const row = rows.get(k);
      if (!row || row.seatToken !== seatToken || !(row.state === "open" || (row.state === "expired" && state === "completed"))) return false;
      rows.set(k, { ...row, state, ...(report !== null ? { report } : {}), updatedAt: at });
      return true;
    },
  };
}

console.log("1 — mirror is a required boolean:");
{
  const standing = { session: { auth: { current: { attributes: { oe_window_token: "oe-dom:payments:oe-sup:g3", oe_grain: "standing" } } } } } as never;
  const entry = (await resolveWindowGated(messageThreadSeat, standing)) as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } } | null;
  ok(entry !== null, "message_thread_seat mounts on a STANDING seat");
  const schema = entry!.inputSchema;
  ok(!schema.safeParse({ thread: "170.5", text: "focus on the migration" }).success, "🔴 a call with NO `mirror` is REFUSED by the schema — there is no default to fall back on");
  ok(schema.safeParse({ thread: "170.5", text: "focus on the migration", mirror: false }).success, "mirror:false parses");
  ok(schema.safeParse({ thread: "170.5", text: "focus on the migration", mirror: true }).success, "mirror:true parses");
  ok(!schema.safeParse({ thread: "170.5", mirror: true }).success, "…and `text` is still required (negative control on the schema itself)");
  const priv = renderSeatSteer("check the totals", false);
  const shown = renderSeatSteer("check the totals", true);
  ok(priv.includes("cannot see this message"), "a mirror:false delivery TELLS the seat the room cannot see it");
  ok(shown.includes("also posted into the thread"), "…and a mirror:true delivery tells it the room can");
  ok(priv.includes("check the totals") && shown.includes("check the totals"), "both carry the coordinator's own words verbatim");
}

console.log("2 — the coordinator verbs are standing-only:");
{
  const ctxFor = (windowId: string, grain: string) =>
    ({
      session: { auth: { current: { attributes: { oe_window_token: formatWindowToken({ domain: "payments", windowId, generation: 3 }), oe_grain: grain } } } },
    }) as never;
  const threadCtx = ctxFor(threadSeatWindowId("slack/C9", "171.5"), "thread");
  const taskCtx = ctxFor(taskWindowId("slack/C9", "171.5"), "task");
  eq(await resolveWindowGated(messageThreadSeat, threadCtx), null, "message_thread_seat does NOT mount on a thread seat — no seat-to-seat mesh");
  eq(await resolveWindowGated(readThreadSeat, threadCtx), null, "read_thread_seat does NOT mount on a thread seat");
  eq(await resolveWindowGated(messageThreadSeat, taskCtx), null, "…nor on a task worker, which holds no threads");
  eq(await resolveWindowGated(readThreadSeat, taskCtx), null, "…and neither does the read");
}

console.log("3 — the per-surface record contract:");
{
  const surfaces: ReadonlyArray<{ platform: string; origin: UnifiedWakeOrigin }> = [
    { platform: "slack", origin: { platform: "slack", channelId: "C042WIN", threadTs: "1720009900.123456" } },
    { platform: "github", origin: { platform: "github", owner: "acme", repo: "payments-api", issueNumber: 55 } },
    { platform: "linear", origin: { platform: "linear", agentSessionId: "as-lin-77", issueId: "issue-uuid-77" } },
    { platform: "notion", origin: { platform: "notion", discussionId: "disc-win-1", pageId: "P_WINPAGE" } },
    { platform: "discord", origin: { platform: "discord", channelId: "CH_THREAD", guildId: "G_WIN", thread: true } },
    { platform: "teams", origin: { platform: "teams", serviceUrl: "https://smba.trafficmanager.net/amer/", conversationId: "19:winchan@thread.tacv2;messageid=1712", replyToActivityId: "1712" } },
  ];
  for (const s of surfaces) {
    const store = fakeStore();
    const ref = unifiedThreadRef(s.origin);
    ok(ref.channelKey.length > 0 && ref.threadKey.length > 0, `${s.platform}: the surface's codec names a container AND a thread`);
    const seatToken = formatWindowToken({ domain: "payments", windowId: threadSeatWindowId(ref.channelKey, ref.threadKey), generation: 3 });
    await recordThreadSeatOpen(store, "acme", ref, { seatToken, parentRegistryKey: "oe-domain::payments", origin: s.origin, atIso: "2026-09-11T10:00:00.000Z" });
    const open = await readThreadSeatState(store, "acme", ref);
    ok(open?.state === "open" && open.seatToken === seatToken, `${s.platform}: the spawn record reads back OPEN, naming the seat`);
    const recovered = open ? threadSeatOrigin(open) : undefined;
    ok(recovered !== undefined && isUnifiedWakeOrigin(recovered), `${s.platform}: the thread's ORIGIN survives storage and the strict validator`);
    eq(recovered, s.origin, `${s.platform}: …and it is the SAME origin the spawn dispatched on — a steer reaches the seat's own thread`);
    const close = await recordThreadSeatClose(store, "acme", ref, { seatToken, state: "completed", report: "Settled on the 3rd; Ana owns the rollback note.", atIso: "2026-09-11T11:00:00.000Z" });
    const closed = close?.row;
    eq(close?.closedNow, true, `${s.platform}: the close found the record OPEN`);
    eq(close?.lastActiveAt, "2026-09-11T10:00:00.000Z", `${s.platform}: …and reports its last activity from before the close`);
    eq(closed?.state, "completed", `${s.platform}: the hand-back flips the record to completed`);
    eq(closed?.report, "Settled on the 3rd; Ana owns the rollback note.", `${s.platform}: the report is stored VERBATIM — nothing summarises the seat's own words`);
    const after = await readThreadSeatState(store, "acme", ref);
    eq(after?.report, closed?.report, `${s.platform}: …and a later read gets it back`);
  }
  const empty = fakeStore();
  const ref = unifiedThreadRef({ platform: "slack", channelId: "C1", threadTs: "1.1" });
  eq(await readThreadSeatState(empty, "acme", ref), null, "an unknown thread reads NULL — the tools report 'no record' rather than guessing");
  eq(await recordThreadSeatClose(empty, "acme", ref, { seatToken: "oe-dom:payments:win:s/slack_C1/1.1:oe-sup:g3", state: "completed", report: "orphan report", atIso: "2026-09-11T11:00:00.000Z" }), null, "…and a report with no open record is not written for a thread nobody opened");
  ok(empty.rows.size === 0, "…leaving no row behind");
}

console.log("4 — a stored origin is validated, never trusted raw:");
{
  eq(threadSeatOrigin({ originJson: "not json" }), undefined, "unparseable JSON answers undefined");
  eq(threadSeatOrigin({ originJson: JSON.stringify({ platform: "mystery", channelId: "x" }) }), undefined, "an origin of an unregistered platform is refused (fail-closed, no codec)");
  ok(threadSeatOrigin({ originJson: JSON.stringify({ platform: "slack", channelId: "C1", threadTs: "1.1" }) }) !== undefined, "a live platform's origin passes — the negative controls above are not refusing everything");
}

console.log("5 — the thread's root message, per surface:");
{
  eq(
    threadRootMessageOf({ platform: "slack", channelId: "C1", threadTs: "1700.5" }),
    { platform: "slack", channelId: "C1", messageId: "1700.5" },
    "slack: a threaded origin's root is the thread's parent ts",
  );
  eq(
    threadRootMessageOf({ platform: "slack", channelId: "C1", replyAnchorTs: "1700.9" }),
    { platform: "slack", channelId: "C1", messageId: "1700.9" },
    "slack: a top-level trigger that a seat was spawned for is the thread's root",
  );
  eq(threadRootMessageOf({ platform: "slack", channelId: "D1" }), undefined, "slack: an origin that names neither (a DM, a routine) has no root to mark");
  eq(
    threadRootMessageOf({ platform: "linear", issueId: "iss-1", parentId: "cmt-root", ambient: true }),
    { platform: "linear", channelId: "iss-1", messageId: "cmt-root" },
    "linear: the root is the thread-root COMMENT on its issue — the pair linearMessageOps.setReaction takes",
  );
  eq(threadRootMessageOf({ platform: "linear", issueId: "iss-1", ambient: true }), undefined, "linear: a thread that IS the issue has no root comment to mark");
  eq(
    threadRootMessageOf({ platform: "discord", channelId: "TH1", guildId: "G1", thread: true, messageId: "M1" }),
    undefined,
    "discord: no root — the starter message lives in the PARENT channel, which the origin does not carry",
  );
  ok(hasThreadDoneReactionPath("slack"), "the runtime predicate: Slack can place the done mark");
  ok(hasThreadDoneReactionPath("linear"), "the runtime predicate: Linear can place the done mark");
  for (const p of ["discord", "teams", "github", "notion"]) ok(!hasThreadDoneReactionPath(p), `the runtime predicate: ${p} declares no done mark, and the predicate agrees`);
}

console.log(`\nthread-seat-tools: ${n} assertions passed`);

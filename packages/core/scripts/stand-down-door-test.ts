import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const dir = join(tmpdir(), `open-everywhere-stand-down-door-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const { registerSlackTestBridge, registerSlackFixtureManifest, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } =
  await import("./_slack-test-stubs.js");

const posted: { channel: string; text: string }[] = [];
registerSlackTestBridge({
  form: async (method: string, body: string) => {
    const p = new URLSearchParams(body);
    if (method === "chat.postMessage") posted.push({ channel: p.get("channel") ?? "", text: p.get("text") ?? "" });
    return { ok: true, ts: `ts-${posted.length}` } as never;
  },
} as never);
registerSlackFixtureManifest();
registerSlackFixtureCodec();
registerSlackFixtureMapper();
registerSlackFixturePostArm();

const { markThreadEngaged, markThreadStopped, getThreadEngagement, isThreadStopped, ownPostMustNotRevive, shouldDeliverReply, STAND_DOWN_DELIVERY_REFUSAL } =
  await import("../agent/channels/engagement.js");
const { standDownSilenceLatchedDurably } = await import("../agent/channels/stand-down-silence.js");
const { durableTurnKey, writeTurnState, noteStoppedAck, stoppedAckSpent } = await import("../agent/model/turn-state.js");
const { postTerminalProse } = await import("../agent/channels/reply-post.js");
const { proseBlockingRefusal, PROSE_BLOCKING_REFUSALS } = await import("../agent/channels/unified-window.js");
const { REPLY_STOPPED_REFUSAL_REASON, WAKE_DECLINED_REFUSAL_REASON, WAKE_DONE_REFUSAL_REASON } = await import("../agent/channels/reply-signal.js");
const { REPLY_STALE_REFUSAL_REASON } = await import("../agent/channels/reply-freshness.js");
const { REPLY_FOLD_REFUSAL_REASON } = await import("../agent/channels/reply-fold.js");
const { readAudit } = await import("../agent/audit/audit.js");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

const ORG = "default";
const P = {
  org: ORG,
  platform: "slack",
  workspace: "T_DOOR",
  surface: "C_DOOR",
  workspaceKey: "slack/T_DOOR",
  surfaceKey: "slack/T_DOOR/C_DOOR",
  key: "slack/T_DOOR/C_DOOR",
  domainKey: "slack/T_DOOR/C_DOOR",
} as never;
const AT = "2026-02-25T04:40:00Z";

{
  const ownPost = { participating: true, byOwnPost: true } as const;
  ok(ownPostMustNotRevive(ownPost, true), "🔴 §1: THE FIX — the agent's own post does NOT revive a STOPPED conversation");
  ok(!ownPostMustNotRevive(ownPost, false), "§1/CONTROL: …and on a conversation nobody stopped, the same promotion goes through");
  ok(!ownPostMustNotRevive({ participating: true }, true), "§1/CONTROL: a promotion that does NOT declare itself an own post still revives — a MENTION is how a person asks the agent back");
  ok(!ownPostMustNotRevive({ byOwnPost: true }, true), "§1/CONTROL: a plain refresh is not a promotion, so there is nothing to downgrade");
  ok(!ownPostMustNotRevive(undefined, true), "§1/CONTROL: no opts at all is a plain refresh too");
}

{
  await markThreadEngaged(P, "ts_own", AT, { participating: true });
  ok((await markThreadStopped(P, "ts_own")) === true, "§2(a): the conversation is enrolled and STOPPED — the state `engagement.stood_down marked:true` records");

  await markThreadEngaged(P, "ts_own", "2026-02-25T04:40:27Z", { participating: true, byOwnPost: true });
  ok((await isThreadStopped(P, "ts_own")) === true, "🔴 §2(b): THE FIX — the acknowledgement's own promotion leaves the conversation STOPPED");
  ok((await getThreadEngagement(P, "ts_own"))?.lastTurnAt === "2026-02-25T04:40:27Z", "§2(b): …and it is still a REFRESH, so the row's last-turn time advanced");

  await markThreadEngaged(P, "ts_own", "2026-02-25T04:40:28Z", { participating: true });
  ok((await isThreadStopped(P, "ts_own")) === false, "🔴 §2(c)/CONTROL: the SAME promotion WITHOUT the flag really does clear the stop — that is the defect, reproduced");
}

{
  await markThreadEngaged(P, "ts_door", AT, { participating: true });
  await markThreadStopped(P, "ts_door");
  await markThreadEngaged(P, "ts_door", "2026-02-25T04:40:27Z", { participating: true, byOwnPost: true });
  const row = await getThreadEngagement(P, "ts_door");
  const wake = {
    isEngaged: row !== null,
    stopped: row?.stopped ?? false,
    authorIsBot: false,
    isAppMention: false,
    inThread: true,
  };
  const decision = shouldDeliverReply(wake);
  ok(!decision.deliver, "🔴 §3: THE ACCEPTANCE — after the acknowledgement, a PLAIN thread-follow is DROPPED at the door");
  ok(decision.reason === STAND_DOWN_DELIVERY_REFUSAL, "§3: …under the stand-down refusal, which is the reason the surface writes its `surface.wake_dropped` row on");

  await markThreadEngaged(P, "ts_door", "2026-02-25T04:41:00Z", { participating: true });
  const revived = await getThreadEngagement(P, "ts_door");
  ok(revived?.stopped === false, "🔴 §3/CONTROL: an @MENTION still revives the conversation — only the agent's own post is refused");
  ok(shouldDeliverReply({ ...wake, stopped: revived?.stopped ?? false }).deliver, "§3/CONTROL: …and the door delivers again after the revival");
}

{
  const pair = durableTurnKey("sess_door", "turn_door");
  ok(pair !== undefined, "§4/CONTROL: a session-scoped turn HAS a durable key — a bare `turn_N` is shared by every session's Nth turn");
  await writeTurnState(pair!, { steps: 1 });
  ok((await standDownSilenceLatchedDurably("sess_door", "turn_door")) === false, "§4/CONTROL: a turn that has NOT posted into a stopped conversation reads UNLATCHED");
  await noteStoppedAck(pair!);
  ok((await stoppedAckSpent(pair!)) === true, "§4/CONTROL: the reply path's own writer really spent the valve");
  ok((await standDownSilenceLatchedDurably("sess_door", "turn_door")) === true, "🔴 §4: THE FIX — the durable half answers for a turn whose own state slot a replay lost");

  ok((await standDownSilenceLatchedDurably("sess_door", undefined)) === false, "🔴 §4: no turn id ⇒ POST IT — never a silence the reader cannot prove is owed");
  ok((await standDownSilenceLatchedDurably("sess_door", "")) === false, "§4: an empty turn id is the same fail-off");
  ok((await standDownSilenceLatchedDurably(undefined, "turn_door")) === false, "🔴 §4: no SESSION id ⇒ post it — a sessionless turn's key is shared, so it can never silence one turn only");
  ok((await standDownSilenceLatchedDurably("sess_other", "turn_door")) === false, "🔴 §4: another SESSION's turn of the same name is not this turn — the latch cannot bleed across sessions");
}

{
  const target = { platform: "slack", channelId: "C_DOOR", threadTs: "ts_own" } as const;
  const auditOf = (turnId: string) => ({
    org: ORG,
    platform: "slack",
    workspace: "T_DOOR",
    surface: "C_DOOR",
    sessionId: "sess_post",
    turnId,
    route: "terminal" as const,
  });

  await inSession(async () => {
    await postTerminalProse(target, "the ordinary answer", auditOf("turn_clean"));
  });
  ok(posted.length === 1, "§5(a)/CONTROL: an ordinary turn's terminal prose POSTS — the poster is not simply switched off");

  const pair = durableTurnKey("sess_post", "turn_spent")!;
  await writeTurnState(pair, { steps: 1 });
  await noteStoppedAck(pair);
  await inSession(async () => {
    await postTerminalProse(target, "and here is one more thing", auditOf("turn_spent"));
  });
  ok(posted.length === 1, "🔴 §5(b): THE FIX — a REPLAYED turn that already posted into the stopped conversation posts NOTHING more");
  await settle();
  const refused = (await readAudit({ org: ORG, action: "reply.refused" })) as readonly { readonly detail?: Record<string, unknown> | null }[];
  const mine = refused.filter((r) => r.detail?.["reason"] === REPLY_STOPPED_REFUSAL_REASON && r.detail?.["route"] === "terminal");
  ok(mine.length === 1, "§5(b)/AUDIT: …and the drop leaves a `reply.refused` row on the TERMINAL route, so a silence the host chose is countable");

  await inSession(async () => {
    await postTerminalProse(target, "prose from a route that cannot name its turn", { ...auditOf("turn_spent"), turnId: undefined });
  });
  ok(posted.length === 2, "🔴 §5(c): a terminal route carrying NO turn id still posts — the guard is off, never a silence it cannot prove");
}

{
  ok(proseBlockingRefusal([REPLY_STOPPED_REFUSAL_REASON]) === REPLY_STOPPED_REFUSAL_REASON, "🔴 §6: THE FIX — a `stopped` refusal is a WITHHOLDING, so the drop names it and no redrive follows");
  ok(proseBlockingRefusal([]) === undefined, "§6/CONTROL: no refusal blocks anything — the finder is not a constant block");
  ok(proseBlockingRefusal(["delegation-pending"]) === undefined, "§6/CONTROL: `delegation-pending` is deliberately NOT blocking — the turn owes its own worker's report, so the redrive still fires");
  ok(proseBlockingRefusal(["mismatch", "expired"]) === undefined, "§6/CONTROL: the wake-fence ADDRESS reasons do not block — a dropped turn authored no address");

  const pinned: readonly [string, string][] = [
    [REPLY_STALE_REFUSAL_REASON, "reply-freshness.ts REPLY_STALE_REFUSAL_REASON"],
    [REPLY_FOLD_REFUSAL_REASON, "reply-fold.ts REPLY_FOLD_REFUSAL_REASON"],
    [WAKE_DECLINED_REFUSAL_REASON, "reply-signal.ts WAKE_DECLINED_REFUSAL_REASON"],
    [WAKE_DONE_REFUSAL_REASON, "reply-signal.ts WAKE_DONE_REFUSAL_REASON"],
    [REPLY_STOPPED_REFUSAL_REASON, "reply-signal.ts REPLY_STOPPED_REFUSAL_REASON"],
  ];
  for (const [value, where] of pinned) {
    ok(PROSE_BLOCKING_REFUSALS.includes(value), `§6/PIN: a drop is withheld by ${where} — a rename of that constant fails HERE rather than silently re-arming the redrive`);
    ok(proseBlockingRefusal([value]) === value, `§6/PIN: …and the finder returns it, so the list and the finder cannot drift`);
  }
  ok(PROSE_BLOCKING_REFUSALS.length === pinned.length, `§6/PIN: the list holds exactly the ${pinned.length} pinned reasons — a NEW entry must be pinned here rather than added unreviewed`);
}

{
  const surfaces: readonly [string, string][] = [
    ["../../providers/slack/agent/channels/slack.ts", "Slack"],
    ["../../providers/teams/agent/channels/teams.ts", "Teams"],
    ["../../providers/discord/agent/channels/discord.ts", "Discord (Interactions)"],
    ["../../providers/discord/agent/channels/discord-gateway.ts", "Discord (guild gateway)"],
  ];
  const stampsTurnId = /\.\.\.\(turnId \? \{ turnId \} : \{\}\),/;
  const callsPoster = /await postTerminalProse\(/;
  for (const [rel, label] of surfaces) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    ok(callsPoster.test(src), `§7/CONTROL: ${label} really calls postTerminalProse — the guard below is reading the right file`);
    ok(stampsTurnId.test(src), `🔴 §7: ${label} STAMPS the turn id on its terminal reply audit — without it §5's door is inert on this surface with every gate still green`);
  }
}

{
  const ownPostPromotions: readonly [string, string, number][] = [
    ["../../providers/slack/agent/channels/slack.ts", "Slack (terminal + supervisor reply)", 2],
    ["../../providers/discord/agent/channels/discord-gateway.ts", "Discord (promoteParticipatingOnReply)", 1],
  ];
  const ownPost = /\{ participating: true[^}]*byOwnPost: true \}/g;
  const anyPromotion = /markThreadEngaged\(/;
  for (const [rel, label, count] of ownPostPromotions) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    ok(anyPromotion.test(src), `§8/CONTROL: ${label} really promotes through markThreadEngaged — the guard below is reading the right file`);
    const found = src.match(ownPost)?.length ?? 0;
    ok(found === count, `🔴 §8: ${label} flags all ${count} of its OWN-POST promotions \`byOwnPost: true\` (found ${found}) — without the flag the acknowledgement lifts the stop it is acknowledging`);
  }
  const revivals: readonly [string, string][] = [
    ["../../providers/slack/agent/channels/slack-events.ts", "Slack (supervisor direct-mention enrol)"],
    ["../../providers/teams/agent/channels/teams-engagement.ts", "Teams (engagement seam)"],
  ];
  for (const [rel, label] of revivals) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    ok(anyPromotion.test(src), `§8/CONTROL: ${label} really promotes through markThreadEngaged`);
    ok(!/byOwnPost/.test(src), `🔴 §8: ${label} carries NO byOwnPost — an @mention is a person asking the agent back, and it must still clear the stop`);
  }
}

console.log(`stand-down door: ${n} assertions passed`);

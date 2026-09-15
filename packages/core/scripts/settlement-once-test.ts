import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-settlement-once-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme", workspace: "dev" });

const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } =
  await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { registerUnifiedWakeTarget, mintWakeId } = await import("../agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { registerPostArm } = await import("../agent/channels/post-arms.js");
const { tailWindowFor, seedTailWindow } = await import("../agent/channels/session-tail-record.js");
const { recordOwnPost } = await import("../agent/channels/own-post-ledger.js");
const { replyFoldTarget, refuseIfShouldFold, REPLY_FOLD_REFUSAL_REASON, REPLY_FOLD_FORCED_AUDIT_REASON } = await import("../agent/channels/reply-fold.js");
const { platformFailureClass } = await import("../agent/channels/platform-failure.js");
const { CredentialEndpointError } = await import("../agent/access/credential-endpoints.js");
const { SETTLEMENT_REPORT_POSTED_ACTION, SETTLEMENT_REPORT_SKIPPED_ACTION } = await import("../agent/access/pending-delegation-signal.js");
const spawnTaint = await import("../agent/hooks/spawn-taint.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;
type SessionTailEntry = import("../agent/channels/session-tail.js").SessionTailEntry;

const ORG = "acme";
const DOMAIN = "payments";
const CHAN = "C1";
const SURFACE = `slack/T1/${CHAN}`;
const TOKEN = unifiedSupervisorToken(DOMAIN, 1);
const rawTailWindow = tailWindowFor({ org: ORG, domainKey: DOMAIN, surfaceKey: SURFACE, rawToken: `unified:${TOKEN}`, platform: "slack" });
ok(rawTailWindow !== null, "fixture sanity: the window token classifies as a standing generation — every fold assertion below rests on this");
const TAIL_WINDOW = rawTailWindow as NonNullable<typeof rawTailWindow>;

const posted: { channel: string; text: string }[] = [];
const edited: { messageId: string; text: string }[] = [];

registerSlackTestBridge({
  channel: { __fixture: "slack" } as never,
  confirmChannelInternal: async () => true,
  form: async (method: string, body: string) => {
    const p = new URLSearchParams(body);
    if (method === "chat.postMessage") {
      posted.push({ channel: p.get("channel") ?? "", text: p.get("text") ?? "" });
      return { ok: true, ts: `ts-${posted.length}` } as never;
    }
    if (method === "chat.update") {
      edited.push({ messageId: p.get("ts") ?? "", text: p.get("text") ?? "" });
      return { ok: true, ts: p.get("ts") } as never;
    }
    return { ok: true } as never;
  },
});
registerSlackFixtureCodec();
registerSlackFixtureMapper();
registerSlackFixturePostArm();

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: DOMAIN, reach: [SURFACE], ambientSupervisor: true, mode: "unified" })],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === CHAN ? [DOMAIN] : []),
});

const store = getOperationalStore();

const replyTool = (await import("../agent/tools/reply.js")).default;
const noReplyTool = (await import("../agent/tools/no_reply.js")).default as unknown as {
  readonly execute: (i: Record<string, unknown>, c: unknown) => Promise<{ acknowledged?: boolean }>;
};
interface Armed {
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}
type Handler = (event: unknown, ctx: unknown) => unknown;
const armReply = (ctx: unknown): Armed | null => (replyTool as unknown as { events: Record<string, Handler> }).events["session.started"]!({}, ctx) as Armed | null;

const hooks = (spawnTaint.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> }).events;
const dispatchHook = hooks["action.result"]!;
const turnStarted = hooks["turn.started"]!;
const settlementWake = hooks["message.received"]!;

const settledNote = (taskId: string, result: string) => `Background task ${taskId} (agent) is completed.\n\nResult:\n${result}`;
const receipt = (callId: string, taskId: string) => ({
  callId,
  kind: "tool-result",
  toolName: "agent",
  output: { agentId: "ag_agent:6666", status: "working", taskId },
});

function ctxFor(turnWake: string, turnId: string): BindableContext {
  return {
    channel: { kind: "channel:unified", continuationToken: `unified:${TOKEN}` },
    session: {
      id: "settlement-once-test",
      turn: { id: turnId, sequence: 1 },
      auth: {
        current: {
          attributes: { oe_platform: "slack", oe_grain: "standing", oe_wake_id: turnWake, oe_window_token: TOKEN, channel_id: CHAN, team_id: "T1" },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
    agent: { name: "oe", nodeId: "__root__" },
  } as unknown as BindableContext;
}

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const absUrl = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(absUrl("dist/src/context/container.js"));
const { SessionKey } = await import(absUrl("dist/src/context/keys.js"));
function newSession(): <T>(fn: () => Promise<T>) => Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "settlement-once-test", auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

async function callReply(
  turnWake: string,
  turnId: string,
  wake: string,
  text: string,
  done: boolean,
  force?: boolean,
): Promise<{ posted?: boolean; id?: string; note?: string; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = armReply(ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done, ...(force === undefined ? {} : { force }) }, ctx)
    .then((r) => r as { posted?: boolean; id?: string; note?: string })
    .catch((e: unknown) => ({ error: String(e) }));
}

const callNoReply = async (turnWake: string, turnId: string, reason = "nothing_to_add"): Promise<{ acknowledged?: boolean; error?: string }> =>
  noReplyTool.execute({ reason }, ctxFor(turnWake, turnId)).catch((e: unknown) => ({ error: String(e) }));

async function wakeOn(channelId: string, threadTs: string): Promise<string> {
  const id = mintWakeId();
  await registerUnifiedWakeTarget(store, ORG, id, { platform: "slack", channelId, threadTs }, new Date().toISOString(), TOKEN);
  return id;
}

const detailsFor = async (action: string): Promise<Record<string, unknown>[]> =>
  (await readAudit({ org: ORG, action })).map((r) => (r.detail ?? {}) as Record<string, unknown>);
const reasonsFor = async (action: string): Promise<string[]> =>
  (await detailsFor(action)).map((d) => String(d.reason ?? ""));

const WORKER_RESULT = "The retry ceiling on the sandbox connector is 5, set in the payments bundle.";

const selfPost = (e: { readonly id: string; readonly wake: string; readonly platform?: string }): SessionTailEntry =>
  ({
    kind: "post",
    at: new Date().toISOString(),
    from: "self",
    trust: "principal",
    author: "x",
    platform: e.platform ?? "slack",
    container: SURFACE,
    text: "t",
    id: e.id,
    wake: e.wake,
  }) as unknown as SessionTailEntry;

{
  const inTurn = newSession();
  const wAsk = await wakeOn(CHAN, "928.1");
  const TASK = "task_1753step28aa";
  await inTurn(async () => {
    seedTailWindow(TAIL_WINDOW);
    await turnStarted({}, ctxFor(wAsk, "turn_28_a"));
    await dispatchHook({ data: { result: receipt("call_28", TASK) } }, ctxFor(wAsk, "turn_28_a"));
    const banner = await callReply(wAsk, "turn_28_a", wAsk, "I've started that check; I'll report what it returns.", false);
    ok(banner.posted === true, "§1/SETUP: the hand-off note posted, so a report is PROMISED");
    const roomAfterBanner = posted.length;

    await turnStarted({}, ctxFor(wAsk, "turn_28_b"));
    await settlementWake({ data: { message: settledNote(TASK, WORKER_RESULT) } }, ctxFor(wAsk, "turn_28_b"));
    ok(
      (await detailsFor("unified.task_wake")).some((d) => d.task === TASK && d.outcome === "installed"),
      "§1/REACHABILITY: the settlement installed the task's reply address, so this turn CAN post",
    );

    const wouldFold = await replyFoldTarget({ store, window: TAIL_WINDOW, platform: "slack", locus: { platform: "slack", channelId: CHAN }, answeringWake: wAsk });
    ok(
      wouldFold?.messageId === banner.id,
      "🔴 §1/REACHABILITY: the banner IS a live fold target on this turn — this is the 100%-by-construction condition, and without it every assertion below is vacuous",
    );

    const refusedBefore = (await reasonsFor("reply.refused")).length;
    const forcedBefore = (await reasonsFor("reply.forced")).length;
    const skippedBefore = (await detailsFor(SETTLEMENT_REPORT_SKIPPED_ACTION)).length;

    const report = await callReply(wAsk, "turn_28_b", wAsk, WORKER_RESULT, true);
    ok(report.posted === true, "🔴 §1: the report POSTS — it is new information and an edit would notify nobody");
    ok(posted.length === roomAfterBanner + 1, "🔴 §1/ROOM: exactly ONE new message reached the room");
    ok(posted[posted.length - 1]?.text.includes("retry ceiling"), "§1/ROOM: …and it carries the worker's result, asserted on content");
    ok(edited.length === 0, "🔴 §1/ROOM: NOTHING was edited — the banner still reads as the hand-off note it was");

    const refused = await reasonsFor("reply.refused");
    ok(refused.length === refusedBefore, "🔴 §1: NO refusal at all on the settlement turn");
    ok(!refused.slice(refusedBefore).includes(REPLY_FOLD_REFUSAL_REASON), `§1: specifically no \`${REPLY_FOLD_REFUSAL_REASON}\` — the policy did not apply`);
    const forced = await reasonsFor("reply.forced");
    ok(
      forced.length === forcedBefore,
      `🔴 §1: and NO \`reply.forced\` row either. The exemption is not a force — nothing was overridden, so a \`${REPLY_FOLD_FORCED_AUDIT_REASON}\` row would be a false record and would spend one of the turn's overrides`,
    );

    ok(
      (await detailsFor(SETTLEMENT_REPORT_POSTED_ACTION)).some((d) => d.task === TASK && d.wake === wAsk),
      "§1/AUDIT: the settle → reply link names the task and the wake the report reached",
    );
    const quiet = await callNoReply(wAsk, "turn_28_b");
    ok(quiet.error === undefined && quiet.acknowledged === true, "🔴 §1: the FIRST `no_reply` after the report is ACCEPTED — the valve is never reached");
    ok(
      (await detailsFor(SETTLEMENT_REPORT_SKIPPED_ACTION)).length === skippedBefore,
      "🔴 §1/AUDIT: and NO `settlement_report_skipped` row. On step 28 that row was written, the model was refused, and the duplicate followed three seconds later",
    );
    ok(posted.length === roomAfterBanner + 1, "🔴 §1/ROOM: still ONE message — the whole settlement added no second post");
  });
}

{
  const inTurn = newSession();
  const wAsk = await wakeOn(CHAN, "930.1");
  const TASK = "task_1753widthcc";
  await inTurn(async () => {
    seedTailWindow(TAIL_WINDOW);
    await turnStarted({}, ctxFor(wAsk, "turn_w_a"));
    await dispatchHook({ data: { result: receipt("call_w", TASK) } }, ctxFor(wAsk, "turn_w_a"));
    const banner = await callReply(wAsk, "turn_w_a", wAsk, "Started it — I'll report back.", false);
    ok(banner.posted === true, "§1b/SETUP: the hand-off note posted");
    await turnStarted({}, ctxFor(wAsk, "turn_w_b"));
    await settlementWake({ data: { message: settledNote(TASK, WORKER_RESULT) } }, ctxFor(wAsk, "turn_w_b"));

    const report = await callReply(wAsk, "turn_w_b", wAsk, WORKER_RESULT, false);
    ok(report.posted === true, "§1b/SETUP: the report posted under the exemption");
    ok(
      (await detailsFor(SETTLEMENT_REPORT_POSTED_ACTION)).some((d) => d.task === TASK),
      "§1b/SETUP: …and discharged the duty, which is the state the assertion below is about",
    );

    const roomBefore = posted.length;
    const second = await callReply(wAsk, "turn_w_b", wAsk, "One more thought on that.", false);
    ok(
      typeof second.error === "string" && second.error.includes("edit_reply"),
      "🔴 §1b: the NEXT post on the same settlement turn is an ordinary post again and meets the fold. The exemption covers the report, not the turn",
    );
    ok(posted.length === roomBefore, "🔴 §1b/ROOM: …and it posted nothing, so the room still holds one settlement message");
  });
}

{
  const ringOnly: SessionTailEntry[] = [selfPost({ id: "m-fold-1", wake: "wk-fold" })];
  const fakeStore = { readSessionTail: async (): Promise<SessionTailEntry[]> => ringOnly };
  await recordOwnPost(ORG, { platform: "slack", channelId: CHAN }, "m-fold-1");
  const args = {
    store: fakeStore,
    window: TAIL_WINDOW,
    platform: "slack",
    locus: { platform: "slack", channelId: CHAN },
    audit: { org: ORG, platform: "slack", workspace: "T1", surface: CHAN, route: "tool" as const },
    answeringWake: "wk-fold",
    ledgerDeps: { hasEventSeen: async () => true },
  };

  await newSession()(async () => {
    const refusedBefore = (await reasonsFor("reply.refused")).length;
    let threw = "";
    try {
      await refuseIfShouldFold({ ...args, turnId: "turn_fold_control" });
    } catch (e) {
      threw = String(e);
    }
    ok(threw.includes("edit_reply"), "🔴 §2/CONTROL: an ORDINARY post onto the seat's own last message is still refused and still steered to `edit_reply`");
    ok((await reasonsFor("reply.refused")).length === refusedBefore + 1, "§2/CONTROL: …and the refusal is recorded");

    const overrides = await refuseIfShouldFold({ ...args, turnId: "turn_fold_exempt", settlementReport: true });
    ok(overrides === 0, "🔴 §2: the SAME call marked as the settlement report returns 0 — no verdict, no override counted");
    ok((await reasonsFor("reply.refused")).length === refusedBefore + 1, "🔴 §2: …and writes no refusal row");
  });
}

{
  const inTurn = newSession();
  const wAsk = await wakeOn(CHAN, "929.1");
  const TASK = "task_1753forcebb";
  await inTurn(async () => {
    seedTailWindow(TAIL_WINDOW);
    await turnStarted({}, ctxFor(wAsk, "turn_f_a"));
    await dispatchHook({ data: { result: receipt("call_f", TASK) } }, ctxFor(wAsk, "turn_f_a"));
    const banner = await callReply(wAsk, "turn_f_a", wAsk, "On it — I'll report back.", false);
    ok(banner.posted === true, "§3/SETUP: the hand-off note posted");
    await turnStarted({}, ctxFor(wAsk, "turn_f_b"));
    await settlementWake({ data: { message: settledNote(TASK, WORKER_RESULT) } }, ctxFor(wAsk, "turn_f_b"));

    const forcedBefore = (await reasonsFor("reply.forced")).length;
    const report = await callReply(wAsk, "turn_f_b", wAsk, WORKER_RESULT, true);
    ok(report.posted === true, "🔴 §3: the report lands with NO `force` at all");
    ok((await reasonsFor("reply.forced")).length === forcedBefore, "🔴 §3: and no override was recorded — there was no verdict to override");
    ok(
      typeof report.note === "string" && !report.note.includes("You overrode a host verdict"),
      "🔴 §3: the note does not tell the seat it overrode anything. Two fold refusals are what drove the live model to blanket `force: true`, which disarms should-be-edit, stale-conversation AND answered-this-turn at once — the triple posts came from there",
    );
  });
}

{
  const ringOnly: SessionTailEntry[] = [selfPost({ id: "cmt-1", wake: "wk-notion", platform: "notion" })];
  const fakeStore = { readSessionTail: async (): Promise<SessionTailEntry[]> => ringOnly };
  const base = {
    store: fakeStore,
    window: TAIL_WINDOW,
    platform: "notion",
    locus: { platform: "notion", channelId: "ws_1753/page_1753" },
    answeringWake: "wk-notion",
    ledgerDeps: { hasEventSeen: async () => true },
  };
  let allowPatch = true;
  registerPostArm({
    platform: "notion",
    dispatchUnified: async () => "cmt-x",
    editMessage: async () => undefined,
    editReachable: async () => allowPatch,
  });

  allowPatch = true;
  ok(
    (await replyFoldTarget(base))?.messageId === "cmt-1",
    "§4/CONTROL: with PATCH inside the credential's methods, the Notion fold target resolves — so the leg below is about the METHODS and nothing else",
  );

  allowPatch = false;
  ok(
    (await replyFoldTarget(base)) === null,
    "🔴 §4: with the credential declaring GET,POST only, there is NO fold target. This deployment's Notion channel key really does declare GET,POST, so every edit the policy used to steer at was refused before a byte left",
  );

  registerPostArm({
    platform: "notion",
    dispatchUnified: async () => "cmt-x",
    editMessage: async () => undefined,
    editReachable: async () => {
      throw new Error("credential store down");
    },
  });
  ok(
    (await replyFoldTarget(base))?.messageId === "cmt-1",
    "🔴 §4/FAIL-OPEN: an arm that cannot decide does not get to refuse the fold — the pre-OPE-1753 answer stands",
  );

  registerPostArm({ platform: "notion", dispatchUnified: async () => "cmt-x", editMessage: async () => undefined });
  ok(
    (await replyFoldTarget(base))?.messageId === "cmt-1",
    "§4/CONTROL: presence is the declaration — an arm without the member is unchanged by this ticket",
  );
}

{
  ok(
    platformFailureClass(new CredentialEndpointError("refused")) === "definitive",
    "🔴 §5: the endpoint fence throws BEFORE any byte leaves, so nothing was sent. It used to class AMBIGUOUS, and the model was told 'the edit was sent but notion did not confirm it' — false in both halves",
  );
  ok(
    platformFailureClass(new Error("connection reset")) === "ambiguous",
    "§5/CONTROL: a bare transport error is still AMBIGUOUS — the classifier's fail-closed default is untouched",
  );
  ok(
    platformFailureClass(Object.assign(new Error("notion said no"), { status: 404 })) === "definitive",
    "§5/CONTROL: and a 4xx is still definitive by status, so §5 is not asserting a blanket verdict",
  );
}

console.log(`settlement-once: ${passed} assertions passed`);

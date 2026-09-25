import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-prose-drop-close-")), "ops.sqlite3");

let passed = 0;
function ok(cond: boolean, what: string): void {
  if (!cond) {
    console.error(`✗ ${what}`);
    process.exitCode = 1;
    throw new Error(what);
  }
  passed += 1;
}

const { registerSlackFixtureCodec } = await import("./_slack-test-stubs.js");
const { registerUnifiedWakeTarget, isUnifiedWakeOrigin } = await import("../agent/channels/unified-window.js");
const { registerPostArm } = await import("../agent/channels/post-arms.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { markRepliedThisTurn, markWakeRepliedThisTurn } = await import("../agent/channels/reply-signal.js");
const unified = (await import("../agent/channels/unified.js")).default as unknown as {
  readonly adapter: Record<string, (data: unknown, channel: unknown, ctx?: unknown) => Promise<void>>;
};

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const absUrl = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(absUrl("dist/src/context/container.js"));
const { SessionKey } = await import(absUrl("dist/src/context/keys.js"));

const ORG = "default";
const WINDOW_TOKEN = "oe-dom:e2e-unified:oe-sup:g1-bd552c";
const store = getOperationalStore();

registerSlackFixtureCodec();

const closes: { channelId: string | undefined; answered: boolean | undefined }[] = [];
const posts: string[] = [];

const registerClosingArm = (): void =>
  registerPostArm({
    platform: "slack",
    dispatchUnified: async (_origin, text) => {
      posts.push(text);
      return "msg-1";
    },
    closeUnifiedSilently: async (origin, _deps, answered) => {
      closes.push({ channelId: (origin as { channelId?: string }).channelId, answered });
    },
  });
registerClosingArm();

const onCompleted = unified.adapter["message.completed"]!;
const windowChannel = { continuation: { token: WINDOW_TOKEN }, state: {} };

const inWindowTurn = (sessionId: string, wakeId: string, turnId: string) => {
  const c = new ContextContainer();
  c.set(SessionKey, {
    sessionId,
    auth: { current: { attributes: { oe_platform: "slack", oe_wake_id: wakeId, oe_window_token: WINDOW_TOKEN } }, initiator: null },
    turn: { id: turnId },
    parent: undefined,
  });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
};

const originFor = (channelId: string) => ({ platform: "slack" as const, channelId });
const openWake = async (wakeId: string, channelId: string): Promise<void> => {
  await registerUnifiedWakeTarget(store, ORG, wakeId, originFor(channelId), new Date().toISOString(), WINDOW_TOKEN);
};

ok(isUnifiedWakeOrigin(originFor("C_ANY")), "(fixture sanity) the origin codec is registered — without it every wake row below resolves to null and the whole file is vacuous");

{
  await openWake("wake-prose-close-1", "C_CLOSE_1");
  await inWindowTurn("wrun_close", "wake-prose-close-1", "turn-close")(async () => {
    const before = (await readAudit({ org: ORG, action: "turn.supervisor_prose_dropped" })).length;
    await onCompleted({ finishReason: "stop", message: "Here is what I found about the release." }, windowChannel);
    const rows = await readAudit({ org: ORG, action: "turn.supervisor_prose_dropped" });
    ok(rows.length - before === 1, "(precondition) the prose was DROPPED and audited — without the drop this branch is never reached");
  });
  ok(closes.length === 1, `🔴 a final prose drop CLOSES the wake's open session — got ${closes.length} closes`);
  ok(closes[0]?.channelId === "C_CLOSE_1", "…the session the WAKE's own origin names, never another");
  ok(closes[0]?.answered === false, "…and it is told nobody answered this container, which is what picks the fixed host line");
  ok(posts.length === 0, "🔴 NOTHING of the model's text was posted — the close is the arm's own fixed host ack, and the drop stands");
}

{
  await openWake("wake-prose-close-2", "C_CLOSE_2");
  const before = closes.length;
  await inWindowTurn("wrun_replied", "wake-prose-close-2", "turn-replied")(async () => {
    markRepliedThisTurn("turn-replied");
    markWakeRepliedThisTurn("turn-replied", "wake-prose-close-2");
    await onCompleted({ finishReason: "stop", message: "…and that is the summary." }, windowChannel);
  });
  ok(closes.length === before, "🔴 NEGATIVE CONTROL: a turn whose `reply` tool answered THIS wake closes nothing here — the post owns the session's ending");
}

{
  await openWake("wake-prose-close-2b", "C_CLOSE_2B");
  const before = closes.length;
  await inWindowTurn("wrun_sibling", "wake-prose-close-2b", "turn-sibling")(async () => {
    markRepliedThisTurn("turn-sibling");
    markWakeRepliedThisTurn("turn-sibling", "wake-some-other-conversation");
    await onCompleted({ finishReason: "stop", message: "…and here is the other half." }, windowChannel);
  });
  ok(closes.length === before + 1, `🔴 a turn that answered a SIBLING wake still closes THIS wake's session — got ${closes.length - before} closes`);
  ok(closes[closes.length - 1]?.channelId === "C_CLOSE_2B", "…on the wake that went unanswered, never on the sibling's");
}

{
  await openWake("wake-prose-close-3", "C_CLOSE_3");
  const before = closes.length;
  await inWindowTurn("wrun_silent", "wake-prose-close-3", "turn-silent")(async () => {
    await onCompleted({ finishReason: "stop", message: "NO_REPLY" }, windowChannel);
  });
  ok(closes.length === before + 1, `🔴 a silent turn still closes the session EXACTLY ONCE — got ${closes.length - before}`);
  ok(closes[closes.length - 1]?.channelId === "C_CLOSE_3", "…on that wake's own origin");
}

{
  registerPostArm({ platform: "slack", dispatchUnified: async () => "msg-x" });
  await openWake("wake-prose-close-4", "C_CLOSE_4");
  const before = closes.length;
  await inWindowTurn("wrun_noclose", "wake-prose-close-4", "turn-noclose")(async () => {
    await onCompleted({ finishReason: "stop", message: "thinking out loud" }, windowChannel);
  });
  ok(closes.length === before, "NEGATIVE CONTROL: an arm without the member is unchanged by this ticket — nothing is closed");
  ok(posts.length === 0, "…and still nothing of the model's text reached the room");
  registerClosingArm();
}

{
  const { proseDropClosesWakeSession } = await import("../agent/channels/unified.js");
  ok(proseDropClosesWakeSession(false, false) === true, "🔴 nothing answered this wake and no correction fired ⇒ the session is this branch's to close");
  ok(proseDropClosesWakeSession(true, false) === false, "🔴 the reply tool answered THIS wake ⇒ the post owns the ending, not this branch");
  ok(
    proseDropClosesWakeSession(false, true) === false,
    "🔴 the one corrective re-drive FIRED ⇒ a turn is still coming that can answer this wake, so the session stays open",
  );
  ok(proseDropClosesWakeSession(true, true) === false, "…and both at once still closes nothing");
}

console.log(`✓ unified prose-drop close: ${passed} assertions passed`);

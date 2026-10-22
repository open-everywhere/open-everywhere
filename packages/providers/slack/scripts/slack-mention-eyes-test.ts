process.env.OE_SQLITE_PATH = ":memory:";

import { markRepliedThisTurn } from "@open-everywhere/core/agent/adapter-api.js";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import slackChannelExport from "../agent/channels/slack.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));

type Handler = (data: unknown, channel: unknown, ctx?: unknown) => Promise<void>;
const adapter = (slackChannelExport as unknown as { adapter: Record<string, Handler | undefined> }).adapter;

const ROOT = "1700159720.000500";

function fakeChannel(state: Record<string, unknown> = {}): { state: Record<string, unknown>; slack: unknown; thread: unknown; calls: [string, string | undefined][] } {
  const calls: [string, string | undefined][] = [];
  return {
    state: { channelId: "C0MENTION", threadTs: ROOT, teamId: "T1", ...state },
    slack: {
      channelId: "C0MENTION",
      threadTs: ROOT,
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push([method, typeof params.name === "string" ? params.name : undefined]);
        return { ok: true };
      },
    },
    thread: { post: async () => ({ id: "1.2" }), startTyping: async () => {} },
    calls,
  };
}

function inSession<T>(turnId: string, fn: () => Promise<T>, attrs: Record<string, unknown> = {}): Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "slack-mention-eyes-test", auth: { current: { attributes: { channel_id: "C0MENTION", channel_type: "channel", ...attrs } } }, turn: 1, parent: undefined });
  return contextStorage.run(c, fn);
}
const ctxFor = (turnId: string) => ({ session: { id: "slack-mention-eyes-test", turn: { id: turnId } } });
const eyesOff = (ch: ReturnType<typeof fakeChannel>) => ch.calls.some(([m, n]) => m === "reactions.remove" && n === "eyes");

ok(typeof adapter["message.completed"] === "function" && typeof adapter["turn.failed"] === "function" && typeof adapter["turn.started"] === "function", "scan sanity: the exported adapter handles turn.started, message.completed and turn.failed");
const drawn = { oeEyesDrawn: true };

console.log("0. turn.started sets the mark from the turn's own delivery, once");
{
  const ch = fakeChannel({ oeEyesDrawn: false });
  await inSession("t0", () => adapter["turn.started"]!({ turnId: "t0" }, ch), { oe_eyes_drawn: "1700159720.000600" });
  ok(ch.state.oeEyesDrawn === true, "a delivery `onInbound` stamped marks the turn as one that drew 👀");
  ok(ch.calls.some(([m, n]) => m === "reactions.add" && n === "eyes"), "🔴 …and the turn draws its 👀 again: a queued mention shares the root's 👀 with the turn before, whose end took it down");
  ch.calls.length = 0;
  await inSession("t0b", () => adapter["turn.started"]!({ turnId: "t0b" }, ch), { oe_eyes_drawn: "1700159720.000600" });
  ok(ch.state.oeEyesDrawn === false, "🔴 a second read of the same stamp marks nothing: the mark never outlives its delivery");
  ok(ch.calls.length === 0, `…and draws nothing (calls: ${JSON.stringify(ch.calls)})`);
  await inSession("t0c", () => adapter["turn.started"]!({ turnId: "t0c" }, ch));
  ok(ch.state.oeEyesDrawn === false && ch.calls.length === 0, "a delivery with no stamp marks nothing and draws nothing");
  await inSession("t0d", () => adapter["turn.started"]!({ turnId: "t0d" }, ch), { oe_eyes_drawn: "1700159720.000700" });
  ok(ch.state.oeEyesDrawn === true && ch.state.oeEyesStampTs === "1700159720.000700", "🔴 a new stamp marks the turn as drawn, whatever stamp the state held, and becomes the stamp read");
  ok(ch.calls.some(([m, n]) => m === "reactions.add" && n === "eyes"), "…and draws the 👀 again");
}

console.log("1. a mention answered by the reply tool");
{
  const ch = fakeChannel(drawn);
  await inSession("turn-1", async () => {
    markRepliedThisTurn("turn-1");
    await adapter["message.completed"]!({ turnId: "turn-1", finishReason: "stop", message: "" }, ch, ctxFor("turn-1"));
  });
  ok(eyesOff(ch), `🔴 the empty final message of a reply-tool turn takes the 👀 off (calls: ${JSON.stringify(ch.calls)})`);
  ok(!ch.calls.some(([m]) => m === "reactions.add"), "…and puts no other sign on");
}

console.log("2. a mention that judged silence");
{
  const ch = fakeChannel(drawn);
  await inSession("turn-2", () => adapter["message.completed"]!({ turnId: "turn-2", finishReason: "stop", message: "" }, ch, ctxFor("turn-2")));
  ok(eyesOff(ch), "a mention the agent chose not to answer owes nothing, so the 👀 comes off at the turn's end");
}

console.log("3. a step that ends in tool calls");
{
  const ch = fakeChannel(drawn);
  await inSession("turn-3", () => adapter["message.completed"]!({ turnId: "turn-3", finishReason: "tool-calls", message: "Let me check." }, ch, ctxFor("turn-3")));
  ok(ch.calls.length === 0, `the turn still works, so the 👀 stays and nothing is sent (calls: ${JSON.stringify(ch.calls)})`);
}

console.log("4. a mention in a warm thread whose session still says oeUninvited");
{
  const silent = fakeChannel({ ...drawn, oeUninvited: true });
  await inSession("turn-4", () => adapter["message.completed"]!({ turnId: "turn-4", finishReason: "stop", message: "" }, silent, ctxFor("turn-4")));
  ok(eyesOff(silent), "🔴 a silent end takes off the 👀 this mention drew, whatever the stale session flag says");
  const failed = fakeChannel({ ...drawn, oeUninvited: true });
  await inSession("turn-4b", () => adapter["turn.failed"]!({ turnId: "turn-4b", message: "boom" }, failed, ctxFor("turn-4b")));
  ok(eyesOff(failed), "🔴 a quiet failure on that path still takes the 👀 off: nothing is left at the turn's end");
}

console.log("5. turns that drew no 👀 (negative controls)");
{
  const nameDrop = fakeChannel({ oeUninvited: true });
  await inSession("turn-5a", () => adapter["message.completed"]!({ turnId: "turn-5a", finishReason: "stop", message: "" }, nameDrop, ctxFor("turn-5a")));
  const supervisor = fakeChannel({ oeUninvited: true, oeSupervisor: true, threadTs: "oe-sup:g1" });
  await inSession("turn-5b", async () => {
    markRepliedThisTurn("turn-5b");
    await adapter["message.completed"]!({ turnId: "turn-5b", finishReason: "stop", message: "" }, supervisor, ctxFor("turn-5b"));
  });
  const followUp = fakeChannel();
  await inSession("turn-5c", async () => {
    markRepliedThisTurn("turn-5c");
    await adapter["message.completed"]!({ turnId: "turn-5c", finishReason: "stop", message: "" }, followUp, ctxFor("turn-5c"));
  });
  for (const [name, ch] of [["a declined name-drop wake", nameDrop], ["a supervisor turn that replied", supervisor], ["an engaged-thread follow-up that replied", followUp]] as const) {
    ok(!ch.calls.some(([m]) => m.startsWith("reactions.")), `${name} drew no 👀, so it sends no reaction call (calls: ${JSON.stringify(ch.calls)})`);
  }
}

console.log("6. a failed turn");
{
  const ch = fakeChannel(drawn);
  await inSession("turn-6", () => adapter["turn.failed"]!({ turnId: "turn-6", message: "boom" }, ch, ctxFor("turn-6")));
  ok(eyesOff(ch) && ch.calls.some(([m, n]) => m === "reactions.add" && n === "octagonal_sign"), `a failed turn ends with the 👀 off and 🛑 on (calls: ${JSON.stringify(ch.calls)})`);
}

console.log(`\n✓ slack-mention-eyes: ${passed} assertions passed`);

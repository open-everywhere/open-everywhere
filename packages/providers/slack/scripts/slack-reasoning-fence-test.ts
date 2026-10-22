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
const { defaultEvents } = await import(abs("dist/src/public/channels/slack/defaults.js"));

const REASONING = "I should quietly read the salary spreadsheet before answering the user.";
const LEAK = "salary spreadsheet";

type Handler = (data: unknown, channel: unknown, ctx?: unknown) => Promise<void>;

function fakeChannel(): { state: Record<string, unknown>; thread: { startTyping(status?: string): Promise<void> }; typed: (string | undefined)[] } {
  const typed: (string | undefined)[] = [];
  return {
    state: { channelId: "C1", threadTs: "1.1", teamId: "T1" },
    thread: {
      startTyping: async (status?: string) => {
        typed.push(status);
      },
    },
    typed,
  };
}

function inSession<T>(fn: () => Promise<T>): Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, {
    sessionId: "slack-reasoning-fence-test",
    auth: { current: { attributes: { channel_id: "C1", channel_type: "channel" } } },
    turn: 1,
    parent: undefined,
  });
  return contextStorage.run(c, fn);
}

const leaks = (ch: ReturnType<typeof fakeChannel>): boolean =>
  ch.typed.some((s) => (s ?? "").includes(LEAK)) || JSON.stringify(ch.state).includes(LEAK);

console.log("1. eve's default reasoning.completed (negative control):");
{
  const ch = fakeChannel();
  await (defaultEvents["reasoning.completed"] as Handler)({ turnId: "t1", stepIndex: 0, reasoning: REASONING }, ch, {});
  ok(leaks(ch), "eve's own default shows the reasoning sentence — the fixture can see a leak");
}

console.log("2. the exported Slack channel:");
{
  const adapter = (slackChannelExport as unknown as { adapter: Record<string, Handler | undefined> }).adapter;
  ok(typeof adapter["reasoning.appended"] === "function", "the exported adapter handles reasoning.appended");
  ok(typeof adapter["reasoning.completed"] === "function", "the exported adapter handles reasoning.completed");
  const ch = fakeChannel();
  await inSession(async () => {
    await adapter["reasoning.appended"]?.({ turnId: "t1", stepIndex: 0, reasoningDelta: REASONING }, ch);
    await adapter["reasoning.completed"]?.({ turnId: "t1", stepIndex: 0, reasoning: REASONING }, ch);
  });
  ok(ch.typed.length === 0, `🔴 the reasoning events make no typing call at all — OE draws no status line (OPE-2668) (got ${JSON.stringify(ch.typed)})`);
  await inSession(async () => {
    await adapter["step.started"]?.({ turnId: "t1", stepIndex: 1 }, ch);
  });
  ok(!ch.typed.some((s) => (s ?? "").includes(LEAK)), `🔴 no typing call carries the reasoning (got ${JSON.stringify(ch.typed)})`);
  ok(!JSON.stringify(ch.state).includes(LEAK), "🔴 state.threadStatus does not record the reasoning, so step.started cannot show it again");
}

console.log(`\n✓ slack-reasoning-fence: ${passed} assertions passed`);

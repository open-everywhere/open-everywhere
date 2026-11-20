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
const { emptySessionView: rawEmptyView } = (await import(abs("dist/src/protocol/session-projection/fold.js"))) as { emptySessionView: () => unknown };
const { emptySessionView } = await import("eve/events");

const REASONING = "I should quietly read the salary spreadsheet before answering the user.";
const LEAK = "salary spreadsheet";

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

function fakeChannel(): {
  state: Record<string, unknown>;
  slack: { codeChannel: boolean };
  thread: { startTyping(status?: string): Promise<void> };
  typed: (string | undefined)[];
} {
  const typed: (string | undefined)[] = [];
  return {
    state: { channelId: "C1", threadTs: "1.1", teamId: "T1" },
    slack: { codeChannel: false },
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
    turn: { id: "t1", sequence: 1 },
    parent: undefined,
  });
  return contextStorage.run(c, fn);
}

const leaks = (ch: ReturnType<typeof fakeChannel>): boolean =>
  ch.typed.some((s) => (s ?? "").includes(LEAK)) || JSON.stringify(ch.state).includes(LEAK);

const reasoningDelta = { type: "content.delta", scope: { turnId: "t1", runId: "run-1" }, data: { partId: "part-r1", kind: "reasoning", delta: REASONING } };
const reasoningDone = { type: "content.completed", scope: { turnId: "t1", runId: "run-1" }, data: { partId: "part-r1", kind: "reasoning", phase: "narration", value: REASONING } };

console.log("1. eve's default reasoning delta (negative control):");
{
  const ch = fakeChannel();
  await (defaultEvents["content.delta"] as Handler)(reasoningDelta, { channel: ch, view: emptySessionView(), position: { line: 0, index: 0 } });
  ok(leaks(ch), "eve's own default shows the reasoning sentence — the fixture can see a leak");
}

console.log("2. the exported Slack channel:");
{
  const adapter = (slackChannelExport as unknown as { adapter: Record<string, Handler | undefined> }).adapter;
  ok(typeof adapter["content.delta"] === "function", "the exported adapter handles content.delta");
  ok(typeof adapter["content.completed"] === "function", "the exported adapter handles content.completed");
  const ch = fakeChannel();
  await inSession(async () => {
    await adapter["content.delta"]?.(reasoningDelta, { ...ch, view: rawEmptyView() });
    await adapter["content.completed"]?.(reasoningDone, { ...ch, view: rawEmptyView() });
  });
  ok(ch.typed.length === 0, `🔴 the reasoning events make no typing call at all — OE draws no status line (got ${JSON.stringify(ch.typed)})`);
  await inSession(async () => {
    await adapter["model.started"]?.({ type: "model.started", scope: { turnId: "t1", runId: "run-1" }, data: { stepIndex: 1 } }, { ...ch, view: rawEmptyView() });
  });
  ok(!ch.typed.some((s) => (s ?? "").includes(LEAK)), `🔴 no typing call carries the reasoning (got ${JSON.stringify(ch.typed)})`);
  ok(!JSON.stringify(ch.state).includes(LEAK), "🔴 state.threadStatus does not record the reasoning, so model.started cannot show it again");
}

console.log(`\n✓ slack-reasoning-fence: ${passed} assertions passed`);

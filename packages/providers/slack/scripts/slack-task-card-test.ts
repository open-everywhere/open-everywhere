import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TaskCardTask, TaskCardView } from "eve/channels/slack";
import {
  confidentialTaskCard,
  confidentialTaskCardView,
  GENERIC_SELF_TASK_LABEL,
  genericTaskLabel,
  taskCardConfidentiality,
  taskCardRoomOf,
} from "../agent/channels/slack-task-card.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function eq<T>(actual: T, expected: T, label: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { composeSlackRenderers } = await import(abs("dist/src/public/channels/slack/renderers.js"));
const { renderDefaultSlackTaskCard, withTaskCards } = await import(abs("dist/src/public/channels/slack/task-card.js"));

const DM_BRIEF = "summarise Dana's salary complaint from her DM";
const RESULT = "Dana earns less than the band. More detail follows.";

console.log("1. room decision:");
{
  const dm = { attributes: { channel_id: "D1", channel_type: "im" }, state: { audience: "private", channelId: "D1" } };
  eq(taskCardRoomOf(dm), "direct-message", "a 1:1 DM whose auth names the card's channel is a direct-message room");
  eq(taskCardRoomOf({ ...dm, state: { audience: undefined, channelId: "D1" } }), "direct-message", "…also when eve records no audience");
  eq(taskCardRoomOf({ attributes: { channel_id: "C1", channel_type: "channel" }, state: { audience: "public", channelId: "C1" } }), "shared", "a public channel is shared");
  eq(taskCardRoomOf({ attributes: { channel_id: "G1", channel_type: "group" }, state: { audience: "private", channelId: "G1" } }), "shared", "a PRIVATE channel is shared — it has more than one reader");
  eq(taskCardRoomOf({ attributes: { channel_id: "G2", channel_type: "mpim" }, state: { audience: "private", channelId: "G2" } }), "shared", "a group DM is shared");
  eq(taskCardRoomOf({ attributes: { channel_id: "D1", channel_type: "im" }, state: { audience: "private", channelId: "C9" } }), "shared", "a DM caller whose card posts to ANOTHER channel is shared");
  eq(taskCardRoomOf({ attributes: { channel_id: "D1", channel_type: "im" }, state: { audience: "public", channelId: "D1" } }), "shared", "eve calling the room public wins");
  eq(taskCardRoomOf({ attributes: { channel_id: "D1" }, state: { channelId: "D1" } }), "shared", "no channel_type is shared (fail closed)");
  eq(taskCardRoomOf({ attributes: null, state: { channelId: "D1" } }), "shared", "no auth is shared (fail closed)");
  eq(taskCardRoomOf({ attributes: { channel_id: "D1", channel_type: "im" }, state: { channelId: null } }), "shared", "no target channel is shared (fail closed)");
  eq(taskCardRoomOf(undefined), "shared", "no facts at all is shared (fail closed)");
}

console.log("2. view redaction:");
const task = (over: Partial<TaskCardTask> = {}): TaskCardTask => ({
  id: "call_1",
  kind: "agent",
  name: "researcher",
  startedAt: "2026-10-03T00:00:00.000Z",
  status: "working",
  taskId: "researcher-1",
  title: `Researcher: ${DM_BRIEF}`,
  ...over,
});
const viewOf = (tasks: TaskCardTask[], state: TaskCardView["state"] = "working"): TaskCardView => ({ actions: [], state, tasks, turnId: "turn_1" });
{
  eq(genericTaskLabel({ kind: "agent", name: "researcher" }), "Researcher", "a named agent's label is its name in words");
  eq(genericTaskLabel({ kind: "agent", name: "agent" }), GENERIC_SELF_TASK_LABEL, "a call to the agent's own copy gets the generic self label");
  eq(genericTaskLabel({ kind: "tool", name: "mcp__linear__createIssue" }), "Create issue", "a tool's label is its last name segment in words, never its start label");

  const done = task({ settledAt: "2026-10-03T00:00:05.000Z", status: "completed", summary: RESULT });
  const shared = confidentialTaskCardView(viewOf([done], "finished"), "shared");
  eq(shared.tasks[0]?.title, "Researcher", "🔴 a shared room's row shows the generic label, not the brief");
  ok(shared.tasks[0]?.summary === undefined, "🔴 a shared room's completed row shows no result excerpt");
  const dm = confidentialTaskCardView(viewOf([done], "finished"), "direct-message");
  eq(dm.tasks[0]?.title, `Researcher: ${DM_BRIEF}`, "a DM row keeps its title (negative control)");
  ok(dm.tasks[0]?.summary === undefined, "a DM's completed row shows no result excerpt either — it would bypass review-surface.ts");
  eq(done.title, `Researcher: ${DM_BRIEF}`, "the input view is never changed");
  const carded = confidentialTaskCardView(viewOf([task({ title: "Researcher: charge card 4539 1488 0343 6467 again" })]), "direct-message");
  ok(!(carded.tasks[0]?.title ?? "").includes("4539") && (carded.tasks[0]?.title ?? "").includes("[withheld: a card number]"), "🔴 a DM row's title is struck of a card number");
  eq(confidentialTaskCard(viewOf([task()]), (v) => ({ blocks: [], text: v.tasks[0]?.title ?? "" }), "shared")?.text, "Researcher", "the link hands the redacted view to `next`");

  const blocked = task({ blockedOn: { kind: "input", label: `Should I quote ${DM_BRIEF}?` }, status: "blocked" });
  const sharedBlocked = confidentialTaskCardView(viewOf([blocked], "blocked"), "shared").tasks[0];
  eq(sharedBlocked?.blockedOn, { kind: "input" }, "🔴 a shared room's blocked row keeps the blocker's kind and loses its label");
  eq(confidentialTaskCardView(viewOf([blocked], "blocked"), "direct-message").tasks[0]?.blockedOn, blocked.blockedOn, "a DM's blocked row keeps the label (negative control)");
  const card = renderDefaultSlackTaskCard(confidentialTaskCardView(viewOf([blocked], "blocked"), "shared"));
  ok(card !== null && !JSON.stringify(card).includes("salary") && JSON.stringify(card).includes("Waiting for a response"), "eve's default card for the shared blocked row says what it waits for, without the prompt");
}

console.log("3. eve's card writer:");
interface Posted {
  readonly method: string;
  readonly body: Record<string, unknown>;
}
async function runTurn(
  room: { channelId: string; audience: string; attributes: Record<string, string> },
  opts: { link?: boolean; secondTask?: boolean } = {},
): Promise<Posted[]> {
  const posted: Posted[] = [];
  const links = opts.link === false ? [] : [taskCardConfidentiality];
  const chain = composeSlackRenderers(links, { events: {}, received: async () => {}, taskCard: renderDefaultSlackTaskCard });
  const events = withTaskCards(chain.events, chain.taskCard) as Record<string, (data: unknown, channel: unknown, ctx: unknown) => Promise<void>>;
  const channel = {
    slack: {
      request: async (method: string, body: Record<string, unknown>) => {
        posted.push({ body, method });
        return { ok: true, ts: "1700159720.000100" };
      },
    },
    state: { audience: room.audience, channelId: room.channelId, taskCards: {}, threadTs: "1700159720.000001" },
  };
  const ctx = { session: { auth: { current: { attributes: room.attributes, principalId: "U1" }, initiator: null }, id: "s1" } };
  await contextStorage.run(new ContextContainer(), async () => {
    const action = { callId: "call_1", input: { message: DM_BRIEF }, kind: "subagent-call", subagentName: "researcher" };
    await events["actions.requested"]!({ actions: [action], presentation: { call_1: { label: `researcher: ${DM_BRIEF}` } }, turnId: "turn_1" }, channel, ctx);
    await events["task.started"]!({ callId: "call_1", kind: "agent", name: "researcher", taskId: "researcher-1", turnId: "turn_1" }, channel, ctx);
    await events["task.settled"]!({ callId: "call_1", output: RESULT, status: "completed", taskId: "researcher-1", turnId: "turn_1" }, channel, ctx);
    if (opts.secondTask === true) {
      const second = { callId: "call_2", input: { message: "again" }, kind: "subagent-call", subagentName: "researcher" };
      await events["actions.requested"]!({ actions: [second], presentation: { call_2: { label: `researcher: again, ${DM_BRIEF}` } }, turnId: "turn_1" }, channel, ctx);
      await events["task.started"]!({ callId: "call_2", kind: "agent", name: "researcher", taskId: "researcher-1", turnId: "turn_1" }, channel, ctx);
      await events["task.settled"]!({ callId: "call_2", output: RESULT, status: "completed", taskId: "researcher-1", turnId: "turn_1" }, channel, ctx);
    }
    await events["turn.completed"]!({ turnId: "turn_1" }, channel, ctx);
  });
  return posted;
}
{
  const pub = await runTurn({ attributes: { channel_id: "C1", channel_type: "channel" }, audience: "public", channelId: "C1" });
  ok(pub.length > 0, "eve wrote a card in the public channel (the card is on: native first)");
  const pubBytes = JSON.stringify(pub);
  ok(!pubBytes.includes("salary"), "🔴 the DM brief reaches NEITHER the blocks NOR the notification text in a public channel");
  ok(!pubBytes.includes("less than the band"), "🔴 the worker's result excerpt never reaches the public channel");
  ok(pub.every((p) => typeof p.body.text === "string" && !String(p.body.text).includes("salary")), "…the notification `text` of every write is redacted too");
  ok(pubBytes.includes("Researcher"), "the public card still names the task by its agent");

  const raw = JSON.stringify(await runTurn({ attributes: { channel_id: "C1", channel_type: "channel" }, audience: "public", channelId: "C1" }, { link: false }));
  ok(raw.includes("salary") && raw.includes("less than the band"), "POSITIVE CONTROL: eve's card without the link posts the brief and the excerpt into the public channel");

  const two = await runTurn({ attributes: { channel_id: "C1", channel_type: "channel" }, audience: "public", channelId: "C1" }, { secondTask: true });
  ok(two.length >= 3, `a two-task turn writes more than one card (got ${two.length} writes)`);
  ok(two.filter((p) => p.method === "chat.postMessage").length >= 2, "…the first card and a new open card (the closed card is a chat.update)");
  ok(!JSON.stringify(two).includes("salary") && !JSON.stringify(two).includes("less than the band"), "🔴 no write of the two-task turn, the close-out included, carries the brief or the excerpt");

  const twoDm = await runTurn({ attributes: { channel_id: "D1", channel_type: "im" }, audience: "private", channelId: "D1" }, { secondTask: true });
  const secondPost = twoDm.findIndex((p, i) => p.method === "chat.postMessage" && i > 0);
  const closed = twoDm.slice(0, secondPost).reverse().find((p) => p.method === "chat.update");
  ok(secondPost > 0 && closed !== undefined, "the DM two-task turn closes the first card with a chat.update before the new card's chat.postMessage");
  ok(JSON.stringify(closed).includes("salary"), "🔴 the close-out write, made BEFORE task.started's handler, reads the DM room recorded earlier and keeps the brief");

  const dm = await runTurn({ attributes: { channel_id: "D1", channel_type: "im" }, audience: "private", channelId: "D1" });
  ok(dm.length > 0, "eve wrote a card in the DM");
  ok(JSON.stringify(dm).includes("salary"), "NEGATIVE CONTROL: the same brief in the DM shows the brief");
  ok(!JSON.stringify(dm).includes("less than the band"), "…but no result excerpt, in the DM either");

  let threw = false;
  try {
    const chain = composeSlackRenderers([taskCardConfidentiality], { events: {}, received: async () => {}, taskCard: renderDefaultSlackTaskCard });
    const card = chain.taskCard(viewOf([task()]));
    ok(card !== null && !JSON.stringify(card).includes("salary"), "🔴 outside an eve context the card shows the generic label (fail closed)");
  } catch {
    threw = true;
  }
  ok(!threw, "…and does not throw");
}

console.log("4. wiring:");
{
  const src = readFileSync(fileURLToPath(new URL("../agent/channels/slack.ts", import.meta.url)), "utf8");
  ok(
    /renderers:\s*\[\s*(?:\/\/[^\n]*\n\s*)*taskCardConfidentiality,/.test(src),
    "🔴 slack.ts puts taskCardConfidentiality FIRST in its renderer chain — a later link's handlers do not call `next`, so a recorder placed after them never runs",
  );
  ok(!/taskCard:\s*\(\)\s*=>\s*null/.test(src), "slack.ts no longer turns the card off — eve's native card is adopted");
  ok(!/approvalChannel\s*:/.test(src), "slack.ts names no approvalChannel — an eve-native approval card posts once, in the thread");
}

console.log(`\n✓ slack-task-card: ${passed} assertions passed`);

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SlackCardMessage, TaskCard } from "eve/channels/slack";
import {
  confidentialTaskCard,
  confidentialTaskCardMessage,
  GENERIC_SELF_TASK_LABEL,
  genericTaskLabel,
  sharedWaitingText,
  slackTaskRowId,
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

console.log("2. rendered-card redaction:");
const richText = (text: string): Record<string, unknown> => ({
  elements: [{ elements: [{ text, type: "text" }], type: "rich_text_section" }],
  type: "rich_text",
});
type Call = TaskCard["calls"][number];
const call = (over: Partial<Record<string, unknown>> = {}): Call =>
  ({ callId: "call:1", kind: "agent", label: `Researcher: ${DM_BRIEF}`, name: "researcher", startedAt: "2000-01-01T00:00:00.000Z", state: "running", taskId: "task-1", ...over }) as unknown as Call;
const cardOf = (calls: Call[], state: TaskCard["state"] = "working"): TaskCard => ({ audience: "private", calls, since: 0, state, turnId: "turn_1", view: {} }) as unknown as TaskCard;
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: "complete",
  task_id: slackTaskRowId("call:1"),
  title: `Researcher: ${DM_BRIEF}`,
  output: richText(`Done in 5s: ${RESULT}`),
  ...over,
});
const single = (r: Record<string, unknown>, text = `Finished 1 task: ${String(r.title)}`): SlackCardMessage =>
  ({ blocks: [{ block_id: "eve_task_card_turn_1", type: "task_card", ...r }], text }) as unknown as SlackCardMessage;
{
  eq(genericTaskLabel({ kind: "agent", name: "researcher" }), "Researcher", "a named agent's label is its name in words");
  eq(genericTaskLabel({ kind: "agent", name: "agent" }), GENERIC_SELF_TASK_LABEL, "a call to the agent's own copy gets the generic self label");
  eq(genericTaskLabel({ kind: "tool", name: "mcp__linear__createIssue" }), "Create issue", "a tool's label is its last name segment in words, never its start label");
  eq(slackTaskRowId("call:1/x"), "call_1_x", "the row id follows eve's Slack task id rule");

  const card = cardOf([call()]);
  const raw = single(row());
  ok(JSON.stringify(raw).includes("salary") && JSON.stringify(raw).includes("less than the band"), "POSITIVE CONTROL: the eve-shaped card carries the brief and the result excerpt");

  const shared = confidentialTaskCardMessage(raw, card, "shared");
  const sharedBytes = JSON.stringify(shared);
  ok(shared !== null && !sharedBytes.includes("salary"), "🔴 a shared room's card carries the brief in NEITHER the blocks NOR the notification text");
  ok(!sharedBytes.includes("less than the band"), "🔴 a shared room's completed row shows no result excerpt");
  eq((shared?.blocks[0] as Record<string, unknown> | undefined)?.title, "Researcher", "a shared room's row shows the generic label");
  eq(shared?.text, "Researcher", "the shared notification text is rebuilt from the redacted rows only");
  eq((shared?.blocks[0] as Record<string, unknown> | undefined)?.block_id, "eve_task_card_turn_1", "the block id stays, so eve updates the same message");

  const dm = confidentialTaskCardMessage(raw, card, "direct-message");
  eq((dm?.blocks[0] as Record<string, unknown> | undefined)?.title, `Researcher: ${DM_BRIEF}`, "a DM row keeps its title (negative control)");
  ok(!JSON.stringify(dm).includes("less than the band"), "a DM's completed row shows no result excerpt either — it would bypass review-surface.ts");
  ok(JSON.stringify(raw).includes("less than the band"), "the input message is never changed");

  const carded = confidentialTaskCardMessage(single(row({ title: "Researcher: charge card 4539 1488 0343 6467 again" })), card, "direct-message");
  const cardedBytes = JSON.stringify(carded);
  ok(!cardedBytes.includes("4539") && cardedBytes.includes("[withheld: a card number]"), "🔴 a DM row's title and notification text are struck of a card number");

  const blockedRow = row({ details: richText(`Waiting for a response: Should I quote ${DM_BRIEF}?`), output: undefined, status: "in_progress" });
  const sharedBlocked = confidentialTaskCardMessage(single(blockedRow), card, "shared");
  eq(sharedBlocked?.blocks[0] && JSON.stringify((sharedBlocked.blocks[0] as Record<string, unknown>).details), JSON.stringify(richText("Waiting for a response")), "🔴 a shared room's blocked row keeps the wait kind and loses the prompt");
  ok(JSON.stringify(confidentialTaskCardMessage(single(blockedRow), card, "direct-message")).includes("salary"), "a DM's blocked row keeps the prompt (negative control)");
  eq(sharedWaitingText(richText("Waiting for approval: send the salary sheet")), "Waiting for approval", "the approval wait kind survives");
  eq(sharedWaitingText(richText("Waiting for sign-in: Payroll")), "Waiting for sign-in", "the sign-in wait kind survives");
  eq(sharedWaitingText(richText("Something new: the salary sheet")), "Waiting for a response", "an unknown blocker line falls back to the generic wait text (fail closed)");

  const plan = {
    blocks: [
      {
        block_id: "eve_task_card_turn_1",
        title: `Waiting on ${DM_BRIEF} · 1 of 3 tasks done`,
        type: "plan",
        tasks: [
          { status: "complete", task_id: "earlier", title: "2 tasks finished earlier" },
          row(),
          row({ task_id: "unknown_row", title: `Unknown: ${DM_BRIEF}` }),
        ],
      },
      { type: "section", text: { text: DM_BRIEF, type: "mrkdwn" } },
    ],
    text: `1 of 3 tasks done: ${DM_BRIEF}`,
  } as unknown as SlackCardMessage;
  const planCalls = [call(), ...Array.from({ length: 3 }, (_, i) => call({ callId: `call:e${String(i)}`, taskId: `task-e${String(i)}` })), call({ callId: "call:x", taskId: undefined })];
  const planCard = cardOf(planCalls);
  const sharedPlan = confidentialTaskCardMessage(plan, planCard, "shared");
  ok(sharedPlan !== null && !JSON.stringify(sharedPlan).includes("salary"), "🔴 no row, block or text of a shared plan carries the brief");
  eq(sharedPlan?.blocks.length, 1, "🔴 a shared room drops a block that is not a task row or plan (fail closed)");
  eq(sharedPlan?.text, "Working on 4 tasks: 2 tasks finished earlier, Researcher, Delegated task", "🔴 a shared plan's title is built from counts, never eve's text; the folded row keeps its count and a row with no call gets the generic label");
  ok(JSON.stringify(confidentialTaskCardMessage(plan, card, "direct-message")).includes("Waiting on summarise"), "a DM keeps eve's plan title (negative control)");
  eq(confidentialTaskCardMessage(plan, cardOf(planCalls, "finished"), "shared")?.text.split(":")[0], "Finished 4 tasks", "a finished shared plan counts the card's task calls, not the rendered rows (eve folds rows past 50)");
  const blockedPlan = { blocks: [{ title: `Waiting for approval: ${DM_BRIEF}`, type: "plan", tasks: [row({ details: richText(`Waiting for approval: send ${DM_BRIEF}`) }), row({ task_id: "x" })] }], text: "" } as unknown as SlackCardMessage;
  eq(confidentialTaskCardMessage(blockedPlan, cardOf([call()], "blocked"), "shared")?.text.split(":")[0], "Waiting for approval", "a blocked shared plan names only the wait kind");
  ok(!JSON.stringify(confidentialTaskCardMessage(blockedPlan, cardOf([call()], "blocked"), "shared")).includes("salary"), "🔴 a blocked shared plan carries no prompt, even when eve's title does");
  eq(((confidentialTaskCardMessage(single(row()), cardOf([call({ name: `mcp__x__${"a".repeat(120)}` })]), "shared")?.blocks[0] ?? {}) as Record<string, unknown>).title?.toString().length, 80, "a shared row title stays within 80 characters, as eve's own titles do");
  const leakyEarlier = single(row({ task_id: "earlier", title: `2 tasks finished earlier: ${DM_BRIEF}` }));
  eq((confidentialTaskCardMessage(leakyEarlier, card, "shared")?.blocks[0] as Record<string, unknown> | undefined)?.title, "Earlier tasks finished", "🔴 a folded row title that is not plain count text is replaced (fail closed)");
  eq(confidentialTaskCardMessage(plan, card, "direct-message")?.blocks.length, 2, "a DM keeps the other block (negative control)");
  const drift = {
    blocks: [
      { block_id: "eve_task_card_turn_1", title: { text: DM_BRIEF }, type: "plan", hint: DM_BRIEF, tasks: [row({ sources: [DM_BRIEF] })] },
    ],
    text: DM_BRIEF,
  } as unknown as SlackCardMessage;
  const sharedDrift = confidentialTaskCardMessage(drift, card, "shared");
  ok(sharedDrift !== null && !JSON.stringify(sharedDrift).includes("salary"), "🔴 a shared room keeps only the known row and plan keys — a field eve adds later never passes through");
  eq((sharedDrift?.blocks[0] as Record<string, unknown> | undefined)?.title, "Working on 1 task", "🔴 a plan title that is not text never passes through to a shared room");
  const dmDrift = confidentialTaskCardMessage(drift, card, "direct-message");
  ok(JSON.stringify(dmDrift).includes("sources") && !("title" in ((dmDrift?.blocks[0] ?? {}) as Record<string, unknown>)), "a DM keeps the unknown row key (negative control) and also drops a plan title that is not text");
  eq(confidentialTaskCardMessage(null, card, "shared"), null, "no card from eve stays no card");
  eq(confidentialTaskCardMessage({ blocks: [{ type: "section" }], text: DM_BRIEF } as unknown as SlackCardMessage, card, "shared"), null, "a shared card with no task block posts nothing");

  let seen: TaskCard | undefined;
  const linked = confidentialTaskCard(card, (c) => ((seen = c), raw), "shared");
  ok(seen === card && linked?.text === "Researcher", "the link hands the card to `next` and redacts what `next` renders");

  let threw = false;
  try {
    const outside = taskCardConfidentiality.taskCard!(card, () => raw);
    ok(outside !== null && !JSON.stringify(outside).includes("salary"), "🔴 outside an eve context the card shows the generic label (fail closed)");
  } catch {
    threw = true;
  }
  ok(!threw, "…and does not throw");
}

console.log("3. eve's card shape (a text read of eve's shipped renderer, never an import):");
{
  const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
  const renderer = readFileSync(join(eveRoot, "dist", "src", "public", "channels", "slack", "task-card.js"), "utf8");
  ok(
    /function slackTaskId\((\w)\)\{return \1\.replace\(\/\[\^a-zA-Z0-9_-\]\/g,`_`\)\.slice\(-200\)\}/.test(renderer),
    "eve's row id rule is the one slackTaskRowId copies — a change would label every shared row with the generic self label",
  );
  ok(/\{status:slackStatus\([^)]*\),task_id:slackTaskId\(\w\.callId\),title:/.test(renderer), "eve's row carries status, task_id and title, and keys the row on the call id the calls map reads");
  ok(/type:`task_card`/.test(renderer) && /type:`plan`/.test(renderer), "eve renders the task_card and plan block types the link redacts");
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

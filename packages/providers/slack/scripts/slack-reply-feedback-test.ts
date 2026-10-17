// proves: REPLY-57

import type { PostIntent, ReplyFeedbackClick } from "@open-everywhere/core/agent/adapter-api.js";
import { chunkSlackSectionText, slackReplyBlocks, slackSourcesLine, SLACK_FEEDBACK_ACTION_ID } from "../agent/channels/slack-reply-blocks.js";
import { parseSlackFeedbackClick, routeSlackFeedbackClick } from "../agent/channels/slack-reply-feedback.js";
import { editSlackMessage, postSlackAnswer, slackPostArm, type SlackPostResult } from "../agent/channels/slack-post-arm.js";
import { isSlackBlocksRefusal } from "../agent/channels/slack-reply-blocks.js";
import { classifyEnvelope } from "../agent/channels/slack-front.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const SOURCES = [
  { kind: "notion-page", name: "Launch checklist", url: "https://www.notion.so/Launch-checklist-0123" },
  { kind: "linear-issue", name: "Fix login & logout", url: "https://linear.app/acme/issue/OPE-42/fix-login" },
];
const ANSWER_INTENT: PostIntent = { terminal: true, feedback: true, sources: SOURCES };

console.log("§1 the blocks");
{
  const blocks = slackReplyBlocks("The launch is on *track*.", ANSWER_INTENT) ?? [];
  ok(blocks.length === 3, `an answer with links and thumbs is three blocks (got ${blocks.length})`);
  const [section, context, actions] = blocks as Record<string, any>[];
  ok(section?.type === "section" && section.text?.type === "mrkdwn" && section.text.text === "The launch is on *track*.", "🔴 the answer itself rides a section block — once blocks exist, Slack shows them and not `text`");
  ok(context?.type === "context" && context.elements?.[0]?.text === slackSourcesLine(SOURCES), "the links are ONE context line");
  ok(
    slackSourcesLine(SOURCES) === "*Sources:*  [1] <https://www.notion.so/Launch-checklist-0123|Launch checklist>  ·  [2] <https://linear.app/acme/issue/OPE-42/fix-login|Fix login &amp; logout>",
    `🔴 the line is numbered, each link on its title, mrkdwn escaped (got ${slackSourcesLine(SOURCES)})`,
  );
  const fb = actions?.elements?.[0];
  ok(actions?.type === "context_actions" && fb?.type === "feedback_buttons" && fb.action_id === SLACK_FEEDBACK_ACTION_ID, "🔴 the thumbs are Slack's native feedback_buttons");
  ok(fb?.positive_button?.value === "up" && fb?.negative_button?.value === "down", "the button values ARE the rating");
  ok(slackReplyBlocks("x", { terminal: true }) === undefined, "🔴 no links and no thumbs: no blocks, so the post is exactly what it was before");
  ok(slackReplyBlocks("x", undefined) === undefined, "no intent: no blocks");
  const thumbsOnly = slackReplyBlocks("x", { terminal: true, feedback: true }) ?? [];
  ok(thumbsOnly.length === 2 && (thumbsOnly[1] as { type?: string }).type === "context_actions", "thumbs without links: the answer and the thumbs");
}

console.log("§2 the chunker");
{
  ok(chunkSlackSectionText("short").join("|") === "short", "a short answer is one chunk");
  const para = "word ".repeat(200).trim();
  const long = Array.from({ length: 12 }, () => para).join("\n");
  const chunks = chunkSlackSectionText(long);
  ok(chunks.length > 1 && chunks.every((c) => c.length <= 3000), `a long answer is cut under the cap (lengths ${chunks.map((c) => c.length).join(",")})`);
  ok(chunks.join("\n") === long, "🔴 cut at line ends, with nothing lost or added");
  const code = ["Here:", "```", ...Array.from({ length: 80 }, (_, i) => `line ${i} ${"x".repeat(60)}`), "```", "Done."].join("\n");
  const codeChunks = chunkSlackSectionText(code);
  ok(codeChunks.length > 1, "a long code block spans several chunks");
  ok(codeChunks.every((c) => (c.split("```").length - 1) % 2 === 0), `🔴 every chunk closes the fences it opens (counts ${codeChunks.map((c) => c.split("```").length - 1).join(",")})`);
  const oneLine = "y".repeat(7000);
  const cut = chunkSlackSectionText(oneLine);
  ok(cut.join("") === oneLine && cut.every((c) => c.length <= 3000), "a single over-long line is cut by code point");
}

console.log("§3 the post");
{
  const sent: URLSearchParams[] = [];
  const base = () => new URLSearchParams({ channel: "D1", text: "The answer." });
  const okPost = async (b: URLSearchParams): Promise<SlackPostResult> => {
    sent.push(b);
    return { ok: true, ts: "1.1" };
  };
  ok((await postSlackAnswer(base(), ANSWER_INTENT, undefined, "reply", okPost, async () => undefined)) === "1.1", "the answer posts");
  const blocks = JSON.parse(sent[0]?.get("blocks") ?? "[]") as { type: string }[];
  ok(sent[0]?.get("text") === "The answer." && blocks.map((b) => b.type).join(",") === "section,context,context_actions", "🔴 the post carries the text AND the blocks");

  sent.length = 0;
  const refuseBlocks = async (b: URLSearchParams): Promise<SlackPostResult> => {
    sent.push(b);
    return b.has("blocks") ? { ok: false, error: "invalid_blocks" } : { ok: true, ts: "2.2" };
  };
  ok((await postSlackAnswer(base(), ANSWER_INTENT, undefined, "reply", refuseBlocks, async () => undefined)) === "2.2", "🔴 a post refused FOR ITS BLOCKS still lands, as text alone");
  ok(sent.length === 2 && sent[0]!.has("blocks") && !sent[1]!.has("blocks"), "…by exactly one plain retry");

  sent.length = 0;
  const refuseChannel = async (b: URLSearchParams): Promise<SlackPostResult> => {
    sent.push(b);
    return { ok: false, error: "channel_not_found" };
  };
  let threw = false;
  try {
    await postSlackAnswer(base(), ANSWER_INTENT, undefined, "reply", refuseChannel, async () => undefined);
  } catch {
    threw = true;
  }
  ok(threw && sent.length === 1, "🔴 any other refusal is NOT retried — it is a real failure");

  sent.length = 0;
  await postSlackAnswer(base(), { terminal: true }, undefined, "reply", okPost, async () => undefined);
  ok(sent.length === 1 && !sent[0]!.has("blocks"), "an intent with neither links nor thumbs posts text alone, as before");
  ok(isSlackBlocksRefusal(new Error("reply couldn't post to Slack — msg_blocks_too_long")), "🔴 an answer too long for Slack's blocks is a blocks refusal too, so it posts as text");
}

console.log("§3b the edit");
{
  const updates: URLSearchParams[] = [];
  const locus = { platform: "slack", channelId: "D1" } as const;
  await editSlackMessage(locus, "1.1", "The new answer.", ANSWER_INTENT, async (method, body) => {
    updates.push(new URLSearchParams(body));
    return method === "chat.update" ? { ok: true } : undefined;
  });
  ok(updates.length === 1 && (JSON.parse(updates[0]!.get("blocks") ?? "[]") as { type: string }[])[0]?.type === "section", "🔴 an edit sends the answer's blocks: a message posted with blocks shows its blocks, not its text");
  updates.length = 0;
  await editSlackMessage(locus, "1.1", "The new answer.", ANSWER_INTENT, async (_method, body) => {
    const p = new URLSearchParams(body);
    updates.push(p);
    return p.get("blocks") === "[]" ? { ok: true } : { ok: false, error: "invalid_blocks" };
  });
  ok(updates.length === 2 && updates[1]!.get("blocks") === "[]" && updates[1]!.get("text") === "The new answer.", "🔴 an edit refused for its blocks retries ONCE with an EMPTY block list — chat.update keeps old blocks unless new ones are sent");
}

const clickPayload = (over: Record<string, unknown> = {}) => ({
  type: "block_actions",
  team: { id: "T1" },
  user: { id: "U1", team_id: "T1" },
  channel: { id: "D1" },
  message: { ts: "1700159720.000100" },
  container: { type: "message", message_ts: "1700159720.000100", channel_id: "D1" },
  actions: [{ type: "feedback_buttons", action_id: SLACK_FEEDBACK_ACTION_ID, block_id: "b1", value: "down" }],
  ...over,
});
const urlencoded = (p: unknown) => `payload=${encodeURIComponent(JSON.stringify(p))}`;

console.log("§4 the click");
{
  const decision = classifyEnvelope(urlencoded(clickPayload()), "application/x-www-form-urlencoded");
  ok(decision.kind === "feedback-click", `🔴 a thumbs click classifies as ours (got ${decision.kind})`);
  const click = decision.kind === "feedback-click" ? decision.click : undefined;
  ok(click?.rating === "down" && click.userId === "U1" && click.channelId === "D1" && click.messageTs === "1700159720.000100" && click.teamId === "T1", "the click names the rater, the conversation and the rated message");
  const rows: ReplyFeedbackClick[] = [];
  const recorded = await routeSlackFeedbackClick(click!, {
    record: async (c) => {
      rows.push(c);
      return true;
    },
  });
  ok(recorded && rows.length === 1, "🔴 the route records ONE row");
  ok(rows[0]?.surface === "slack" && rows[0].rating === "down" && rows[0].raterId === "U1" && rows[0].messageId === "1700159720.000100" && rows[0].channelId === "D1", "the row carries the rating and the message ids");
  ok(rows[0]?.commentChars === undefined, "a Slack click carries no comment");
  const up = parseSlackFeedbackClick(clickPayload({ actions: [{ action_id: SLACK_FEEDBACK_ACTION_ID, value: "up" }] }));
  ok(up?.rating === "up", "an up click rates up");
}

console.log("§5 negative controls");
{
  ok(parseSlackFeedbackClick(clickPayload({ actions: [{ action_id: "eve_input:abc", value: "down" }] })) === undefined, "🔴 another door's action is not a thumbs click");
  ok(parseSlackFeedbackClick(clickPayload({ actions: [{ action_id: SLACK_FEEDBACK_ACTION_ID, value: "meh" }] })) === undefined, "an unknown value is not a rating");
  ok(parseSlackFeedbackClick(clickPayload({ message: undefined, container: undefined })) === undefined, "no rated message, no click");
  ok(parseSlackFeedbackClick(clickPayload({ type: "view_submission" })) === undefined, "not a block_actions, not a click");
  const other = classifyEnvelope(urlencoded(clickPayload({ actions: [{ action_id: "eve_input:abc", value: "x" }] })), "application/x-www-form-urlencoded");
  ok(other.kind === "forward", `🔴 eve's own click still forwards (got ${other.kind})`);
}

console.log("§6 the 1:1 rule");
{
  ok(slackPostArm.isDirectConversation?.({ channelId: "D0123" }) === true, "a D… channel is a 1:1 DM");
  ok(slackPostArm.isDirectConversation?.({ channelId: "C0123" }) === false, "🔴 a channel is not");
  ok(slackPostArm.isDirectConversation?.({ channelId: "G0123" }) === false, "a group DM is not");
}

console.log(`slack-reply-feedback: ${passed} assertions passed`);

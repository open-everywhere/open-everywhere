// proves: REPLY-58

import type { PostIntent } from "@open-everywhere/core/agent/adapter-api.js";
import { slackReplyBlocks, SLACK_FOLLOW_UP_ACTION_PREFIX, SLACK_FOLLOW_UP_BLOCK_ID } from "../agent/channels/slack-reply-blocks.js";
import {
  blocksAfterFollowUp,
  followUpMessageEvent,
  followUpPressedLine,
  followUpPressKey,
  markFollowUpPressed,
  parseSlackFollowUpClick,
} from "../agent/channels/slack-follow-ups.js";
import { editSlackMessage, postSlackAnswer, type SlackPostResult } from "../agent/channels/slack-post-arm.js";
import { classifyEnvelope } from "../agent/channels/slack-front.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const NEXT = ["Move the 2pm", "Show Friday too", "Draft an agenda"];
const INTENT: PostIntent = { terminal: true, feedback: true, followUps: NEXT };

type Block = { type?: string; block_id?: string; elements?: { type?: string; action_id?: string; value?: string; text?: { type?: string; text?: string } }[] };

console.log("§1 the blocks");
{
  const blocks = (slackReplyBlocks("Your meetings are on Thursday.", INTENT) ?? []) as Block[];
  ok(blocks.map((b) => b.type).join(",") === "section,context_actions,actions", `🔴 the answer, its thumbs, then ONE follow-up row, last (got ${blocks.map((b) => b.type).join(",")})`);
  const row = blocks[2]!;
  ok(row.block_id === SLACK_FOLLOW_UP_BLOCK_ID, "the row carries the block id a press removes it by");
  ok(row.elements?.length === 3, "one button per follow-up");
  ok(
    row.elements!.every((e, i) => e.type === "button" && e.action_id === `${SLACK_FOLLOW_UP_ACTION_PREFIX}${i}` && e.value === NEXT[i] && e.text?.type === "plain_text" && e.text.text === NEXT[i]),
    "🔴 each button's label IS the text its press sends, as plain text that draws no mention",
  );
  const onlyNext = (slackReplyBlocks("x", { terminal: true, followUps: ["Go on"] }) ?? []) as Block[];
  ok(onlyNext.map((b) => b.type).join(",") === "section,actions", "follow-ups alone still make the answer a section and the row");
  ok(slackReplyBlocks("x", { terminal: true, followUps: [] }) === undefined, "no follow-ups, no thumbs, no links: no blocks, as before");
  const tooLong = (slackReplyBlocks("x", { terminal: true, followUps: ["z".repeat(76), "Fits"] }) ?? []) as Block[];
  ok(tooLong[1]?.elements?.length === 1 && tooLong[1].elements[0]?.value === "Fits", "🔴 an item over Slack's label cap is dropped, never cut — a refused block would cost the thumbs too");
  ok((slackReplyBlocks("x", { terminal: true, followUps: ["z".repeat(76)] }) ?? undefined) === undefined, "…and a row with nothing left is no row");
  const joined = (slackReplyBlocks("x", { terminal: true, followUps: ["Ask 👩\u200D💻 Alex", "Fits"] }) ?? []) as Block[];
  ok(joined[1]?.elements?.length === 1 && joined[1].elements[0]?.value === "Fits", "🔴 an item holding an invisible character draws no button — its press would be refused");
}

console.log("§2 the post and the edit");
{
  const sent: URLSearchParams[] = [];
  const okPost = async (b: URLSearchParams): Promise<SlackPostResult> => {
    sent.push(b);
    return { ok: true, ts: "1.1" };
  };
  await postSlackAnswer(new URLSearchParams({ channel: "D1", text: "The answer." }), INTENT, undefined, "reply", okPost, async () => undefined);
  const posted = JSON.parse(sent[0]?.get("blocks") ?? "[]") as Block[];
  ok(posted.some((b) => b.block_id === SLACK_FOLLOW_UP_BLOCK_ID), "🔴 the answer's post carries the follow-up row");
  const updates: URLSearchParams[] = [];
  await editSlackMessage({ platform: "slack", channelId: "D1" }, "1.1", "The new answer.", INTENT, async (_m, body) => {
    updates.push(new URLSearchParams(body));
    return { ok: true };
  });
  ok((JSON.parse(updates[0]?.get("blocks") ?? "[]") as Block[]).some((b) => b.block_id === SLACK_FOLLOW_UP_BLOCK_ID), "🔴 an edit of the answer carries the row too");
}

const ANSWER_TS = "1700159720.000100";
const answerBlocks = slackReplyBlocks("Your meetings are on Thursday.", INTENT) ?? [];
const pressPayload = (over: Record<string, unknown> = {}) => ({
  type: "block_actions",
  team: { id: "T1" },
  user: { id: "U1", team_id: "T1" },
  channel: { id: "D1" },
  message: { ts: ANSWER_TS, thread_ts: "1700159720.000001", text: "Your meetings are on Thursday.", blocks: answerBlocks },
  container: { type: "message", message_ts: ANSWER_TS, channel_id: "D1" },
  actions: [{ type: "button", action_id: `${SLACK_FOLLOW_UP_ACTION_PREFIX}1`, block_id: SLACK_FOLLOW_UP_BLOCK_ID, value: "Show Friday too" }],
  ...over,
});
const urlencoded = (p: unknown) => `payload=${encodeURIComponent(JSON.stringify(p))}`;

console.log("§3 the press");
{
  const decision = classifyEnvelope(urlencoded(pressPayload()), "application/x-www-form-urlencoded");
  ok(decision.kind === "followup-click", `🔴 a follow-up press in a DM classifies as ours (got ${decision.kind})`);
  const click = decision.kind === "followup-click" ? decision.click : undefined;
  ok(click?.text === "Show Friday too" && click.userId === "U1" && click.channelId === "D1" && click.messageTs === ANSWER_TS && click.teamId === "T1", "the press names its text, the presser, the DM and the answer");
  const pressedAt = Date.UTC(2026, 9, 14, 12, 0, 0, 250);
  const ev = followUpMessageEvent(click!, pressedAt);
  ok(ev.text === "Show Friday too" && ev.authoredText === "Show Friday too", "🔴 the press becomes the person's next message, in the button's own words");
  ok(ev.userId === "U1" && ev.channelId === "D1" && ev.channelType === "im" && ev.isAppMention === false, "…from the presser, in the DM, on the DM road");
  ok(ev.threadTs === "1700159720.000001", "🔴 …in the answer's thread, so the next answer lands beside the one it follows");
  ok(ev.ts === `${Math.floor(pressedAt / 1000)}.250000`, `…with a ts minted from the clock, as a global shortcut's is (got ${ev.ts})`);
  ok(ev.teamId === "T1", "…in the presser's workspace, for the tenant fence and the partition");
  const top = parseSlackFollowUpClick(pressPayload({ message: { ts: ANSWER_TS, thread_ts: ANSWER_TS, blocks: answerBlocks } }));
  ok(top !== undefined && top.threadTs === undefined, "an answer that is its own thread root names no thread");
  ok(followUpPressKey(click!) === followUpPressKey(parseSlackFollowUpClick(pressPayload({ actions: [{ action_id: `${SLACK_FOLLOW_UP_ACTION_PREFIX}0`, value: "Move the 2pm" }] }))!), "🔴 one answer, one press: every button under an answer shares the dedupe key");
}

console.log("§4 the rewrite");
{
  const click = parseSlackFollowUpClick(pressPayload())!;
  const after = blocksAfterFollowUp(click.blocks!, click.text) as Block[] | undefined;
  ok(after !== undefined && !after.some((b) => b.block_id === SLACK_FOLLOW_UP_BLOCK_ID), "🔴 the rewrite removes the follow-up row, so a second press cannot follow");
  ok(after!.some((b) => b.type === "context_actions"), "…and keeps the answer and its thumbs");
  const line = after![after!.length - 1]!;
  ok(line.type === "context" && line.elements?.[0]?.type === "plain_text" && line.elements[0].text === followUpPressedLine("Show Friday too"), "🔴 …and names what the person sent, as plain text");
  ok(followUpPressedLine("Show Friday too") === "↳ You asked: Show Friday too", "the line reads as the person's words");
  ok(blocksAfterFollowUp([{ type: "section" }], "x") === undefined, "blocks with no row: nothing to rewrite");
  const updates: { method: string; body: URLSearchParams }[] = [];
  ok(
    await markFollowUpPressed(click, async (method, body) => {
      updates.push({ method, body: new URLSearchParams(body) });
      return { ok: true };
    }),
    "the rewrite lands",
  );
  ok(updates[0]?.method === "chat.update" && updates[0].body.get("channel") === "D1" && updates[0].body.get("ts") === ANSWER_TS, "🔴 the rewrite updates the answer itself");
  ok(updates[0]?.body.get("text") === "Your meetings are on Thursday.", "…and keeps its notification text");
  ok(!(await markFollowUpPressed(click, async () => ({ ok: false, error: "message_not_found" }))), "a refused rewrite answers false");
  ok(!(await markFollowUpPressed(click, async () => Promise.reject(new Error("boom")))), "🔴 a throwing rewrite answers false and never throws");
  ok(!(await markFollowUpPressed({ ...click, blocks: undefined }, async () => ({ ok: true }))), "no blocks on the payload: no rewrite");
}

console.log("§5 negative controls");
{
  ok(parseSlackFollowUpClick(pressPayload({ channel: { id: "C1" }, container: { message_ts: ANSWER_TS, channel_id: "C1" } })) === undefined, "🔴 a press outside a 1:1 DM is not a follow-up press");
  ok(parseSlackFollowUpClick(pressPayload({ channel: { id: "G1" }, container: { message_ts: ANSWER_TS, channel_id: "G1" } })) === undefined, "…nor in a group DM");
  ok(parseSlackFollowUpClick(pressPayload({ actions: [{ action_id: `${SLACK_FOLLOW_UP_ACTION_PREFIX}0`, value: "  " }] })) === undefined, "an empty value sends nothing");
  ok(parseSlackFollowUpClick(pressPayload({ actions: [{ action_id: `${SLACK_FOLLOW_UP_ACTION_PREFIX}0`, value: "q".repeat(76) }] })) === undefined, "🔴 a value longer than any button shows is not ours");
  ok(parseSlackFollowUpClick(pressPayload({ actions: [{ action_id: `${SLACK_FOLLOW_UP_ACTION_PREFIX}0`, value: "Show Friday too\u{E0049}\u{E0047}" }] })) === undefined, "🔴 a value holding words no button shows (a format character) is not ours");
  ok(parseSlackFollowUpClick(pressPayload({ actions: [{ action_id: `${SLACK_FOLLOW_UP_ACTION_PREFIX}0`, value: "Move\u200Bthe 2pm" }] })) === undefined, "…a zero-width space included");
  ok(parseSlackFollowUpClick(pressPayload({ actions: [{ action_id: "oe_feedback", value: "down" }] })) === undefined, "the thumbs are not a follow-up");
  ok(parseSlackFollowUpClick(pressPayload({ message: undefined, container: undefined })) === undefined, "no answer, no press");
  ok(parseSlackFollowUpClick(pressPayload({ user: undefined })) === undefined, "no presser, no press");
  ok(parseSlackFollowUpClick(pressPayload({ type: "view_submission" })) === undefined, "not a block_actions, not a press");
  const thumbs = classifyEnvelope(urlencoded(pressPayload({ actions: [{ type: "feedback_buttons", action_id: "oe_feedback", value: "up" }] })), "application/x-www-form-urlencoded");
  ok(thumbs.kind === "feedback-click", `the thumbs still classify as the thumbs (got ${thumbs.kind})`);
  const eve = classifyEnvelope(urlencoded(pressPayload({ actions: [{ action_id: "eve_input:abc", value: "x" }] })), "application/x-www-form-urlencoded");
  ok(eve.kind === "forward", `🔴 eve's own click still forwards (got ${eve.kind})`);
  const chan = classifyEnvelope(urlencoded(pressPayload({ channel: { id: "C1" }, container: { message_ts: ANSWER_TS, channel_id: "C1" } })), "application/x-www-form-urlencoded");
  ok(chan.kind !== "followup-click", `a channel press never classifies as a follow-up (got ${chan.kind})`);
}

console.log(`slack-follow-ups: ${passed} assertions passed`);

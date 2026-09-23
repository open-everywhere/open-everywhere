import assert from "node:assert/strict";
import { findExactBotPost, type SlackMessage } from "./e2e/slack-driver.js";

let n = 0;
const eq = <T,>(actual: T, expected: T, label: string): void => {
  assert.deepEqual(actual, expected, label);
  n++;
};

const BOT = "UBOT";
const isBot = (m: SlackMessage): boolean => m.userId === BOT;
const askTs = "1773240920.449000";
const note = "routine-82209";

const ask: SlackMessage = { ts: askTs, userId: "UHUMAN", text: `Post exactly ${note} at 05:30 UTC` };
const card: SlackMessage = {
  ts: "1773240926.000100",
  threadTs: askTs,
  userId: BOT,
  text: `Approval needed: routine.create\n> Post exactly \`${note}\` at 05:30 UTC`,
};
const ack: SlackMessage = { ts: "1773240936.000200", threadTs: askTs, userId: BOT, text: `Scheduled: I will post ${note} at 05:30 UTC.` };
const fireTopLevel: SlackMessage = { ts: "1773241082.651000", userId: BOT, text: `${note}\n` };
const fireInThread: SlackMessage = { ts: "1773241082.651000", threadTs: askTs, userId: BOT, text: note };
const humanEcho: SlackMessage = { ts: "1773241036.000300", userId: "UHUMAN", text: note };
const earlierBot: SlackMessage = { ts: "1773240636.000000", userId: BOT, text: note };

eq(findExactBotPost([ask, card, ack], [ask, fireTopLevel], askTs, note, isBot)?.ts, fireTopLevel.ts, "§1 a top-level fire is found");

eq(findExactBotPost([ask, card, ack, fireInThread], [ask], askTs, note, isBot)?.ts, fireInThread.ts, "§2 a threaded fire is found");

eq(findExactBotPost([ask, card, ack], [ask], askTs, note, isBot), undefined, "§3 the card and the ack never match");

eq(findExactBotPost([ask], [ask, humanEcho], askTs, note, isBot), undefined, "§4a a human post of the bare note never matches");
eq(findExactBotPost([], [earlierBot, ask], askTs, note, isBot), undefined, "§4b a bot post before the anchor never matches");
eq(isBot(card) && card.text.includes(note), true, "§4c control: the card DOES contain the note (so §3 tests exactness, not absence)");

console.log(`exact-bot-post: ${n} assertions passed`);

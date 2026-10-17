import type { ReplyFeedbackClick } from "@open-everywhere/core/agent/adapter-api.js";
import {
  isTeamsPersonalConversationId,
  parseTeamsFeedbackInvoke,
  routeTeamsFeedbackInvoke,
  teamsAnswerActivity,
  TEAMS_FEEDBACK_INVOKE,
} from "../agent/channels/teams-reply-feedback.js";
import { teamsPostArm } from "../agent/channels/teams-post-arm.js";

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
  { kind: "linear-issue", name: "Fix login", url: "https://linear.app/acme/issue/OPE-42/fix-login" },
];

console.log("§1 the activity");
{
  const a = teamsAnswerActivity("The launch is on track.", { terminal: true, feedback: true, sources: SOURCES }) as Record<string, any>;
  ok(a.type === "message" && a.text === "The launch is on track.\n\nSources: [1] [2]", `🔴 the text ends with the numbered markers the citations resolve (got ${JSON.stringify(a.text)})`);
  ok(a.channelData?.feedbackLoopEnabled === true, "🔴 the feedback loop is on: Teams draws its own thumbs");
  const entity = a.entities?.[0];
  ok(entity?.["@type"] === "Message" && entity.type === "https://schema.org/Message" && entity["@context"] === "https://schema.org", "one schema.org Message entity");
  const cites = entity?.citation as Record<string, any>[];
  ok(cites?.length === 2 && cites[0]?.position === 1 && cites[1]?.position === 2, "🔴 the citations are numbered 1 and 2, matching the markers");
  ok(cites[0]?.appearance?.name === "Launch checklist" && cites[0].appearance.url === SOURCES[0]!.url && cites[0].appearance["@type"] === "DigitalDocument", "each citation names its record and links it");
  ok(cites[1]?.appearance?.abstract === "Linear issue: Fix login", `the abstract says the kind in words, never an id (got ${cites[1]?.appearance?.abstract})`);
  const plain = teamsAnswerActivity("Plain.", { terminal: true });
  ok(JSON.stringify(plain) === JSON.stringify({ type: "message", text: "Plain." }), "🔴 neither links nor thumbs: the activity is exactly what it was before");
  ok(JSON.stringify(teamsAnswerActivity("Plain.", undefined)) === JSON.stringify({ type: "message", text: "Plain." }), "no intent: the plain activity");
  const thumbs = teamsAnswerActivity("Plain.", { terminal: true, feedback: true }) as Record<string, any>;
  ok(thumbs.text === "Plain." && thumbs.channelData?.feedbackLoopEnabled === true, "thumbs without links: no marker line");
  ok(thumbs.entities?.[0] !== undefined && !("citation" in thumbs.entities[0]), "…and an entity with no citation list (it carries the AI label, §2)");
  const longName = teamsAnswerActivity("x", { terminal: true, feedback: true, sources: [{ kind: "notion-page", name: "n".repeat(200), url: SOURCES[0]!.url }] }) as Record<string, any>;
  ok(Array.from(longName.entities[0].citation[0].appearance.name as string).length <= 80, "a citation name is held to Teams' 80-character cap");
}

console.log("§2 the AI label");
{
  const a = teamsAnswerActivity("x", { terminal: true, feedback: true }) as Record<string, any>;
  ok(JSON.stringify(a.entities?.[0]?.additionalType) === JSON.stringify(["AIGeneratedContent"]), "🔴 an answer carries Teams' own AI label — the store's in-chat AI disclaimer (Must fix)");
  ok(!JSON.stringify(teamsAnswerActivity("x", { terminal: true })).includes("AIGeneratedContent"), "🔴 a host notice (no generated flag) carries no label");
  const part = teamsAnswerActivity("Working on it.", { terminal: false, generated: true }) as Record<string, any>;
  ok(JSON.stringify(part.entities?.[0]?.additionalType) === JSON.stringify(["AIGeneratedContent"]), "🔴 a part still being written is model text, so it carries the label too");
  ok(part.channelData === undefined && part.text === "Working on it.", "…but no thumbs and no sources line: those go under the whole answer");
}

const invoke = (over: Record<string, unknown> = {}, actionValue: Record<string, unknown> = { reaction: "dislike", feedback: JSON.stringify({ feedbackText: "It cited the wrong page." }) }) => ({
  type: "invoke",
  name: TEAMS_FEEDBACK_INVOKE,
  channelId: "msteams",
  from: { id: "29:person", aadObjectId: "aad-1" },
  recipient: { id: "28:bot" },
  conversation: { id: "a:conv-1", conversationType: "personal", tenantId: "TEN1" },
  replyToId: "act-123",
  value: { actionName: "feedback", actionValue },
  ...over,
});

console.log("§3 the click");
{
  const click = parseTeamsFeedbackInvoke(invoke());
  ok(click?.rating === "down" && click.userId === "29:person" && click.conversationId === "a:conv-1" && click.messageId === "act-123", "🔴 a feedback invoke parses to the rating, the rater and the rated message");
  ok(click?.commentChars === "It cited the wrong page.".length, "the comment's LENGTH is read");
  const rows: ReplyFeedbackClick[] = [];
  const recorded = await routeTeamsFeedbackInvoke(click!, {
    record: async (c) => {
      rows.push(c);
      return true;
    },
  });
  ok(recorded && rows.length === 1 && rows[0]?.surface === "teams" && rows[0].rating === "down" && rows[0].messageId === "act-123", "🔴 the route records ONE row");
  ok(!JSON.stringify(rows[0]).includes("wrong page"), "🔴 the comment's WORDS never reach the row");
  ok(parseTeamsFeedbackInvoke(invoke({}, { reaction: "like" }))?.rating === "up", "a like rates up, with no comment");
  ok(parseTeamsFeedbackInvoke(invoke({}, { reaction: "like" }))?.commentChars === 0, "…and a comment length of 0");
}

console.log("§4 negative controls");
{
  ok(parseTeamsFeedbackInvoke(invoke({ name: "adaptiveCard/action" })) === null, "🔴 another invoke is not a thumbs click");
  ok(parseTeamsFeedbackInvoke(invoke({ value: { actionName: "other", actionValue: { reaction: "like" } } })) === null, "another submit action is not one");
  ok(parseTeamsFeedbackInvoke(invoke({}, { reaction: "heart" })) === null, "an unknown reaction is not a rating");
  ok(parseTeamsFeedbackInvoke(invoke({ replyToId: undefined })) === null, "no rated message, no click");
  ok(parseTeamsFeedbackInvoke(invoke({ type: "message" })) === null, "a message is not a click");
}

console.log("§5 the 1:1 rule");
{
  ok(isTeamsPersonalConversationId("a:1abc") && teamsPostArm.isDirectConversation?.({ channelId: "a:1abc" }) === true, "a personal chat is 1:1");
  ok(teamsPostArm.isDirectConversation?.({ channelId: "19:abc@thread.v2" }) === false, "🔴 a group chat is not");
  ok(teamsPostArm.isDirectConversation?.({ channelId: "19:abc@thread.tacv2;messageid=1" }) === false, "a channel is not");
}

console.log(`teams-reply-feedback: ${passed} assertions passed`);

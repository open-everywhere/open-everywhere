process.env.OE_SQLITE_PATH = ":memory:";
process.env.SLACK_BOT_TOKEN = "xoxb-test";

import assert from "node:assert/strict";
import { grantCardActions, GRANT_MODE_WORDS, OE_GRANT_ACTION_PREFIX, parseGrantCardActionId } from "@open-everywhere/core/agent/adapter-api.js";
import { classifyEnvelope } from "../agent/channels/slack-front.js";
import { slackPostArm } from "../agent/channels/slack-post-arm.js";
import { withPatchedFetch } from "./_fetch-test-utils.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const FORM_CT = "application/x-www-form-urlencoded";
const ASK_ID = "11111111-2222-3333-4444-555555555555";

const ASK = { domainScopeKey: "oe-grant-domain::slack-card-test", id: ASK_ID, requestedMode: "once" } as never;

async function deliver(actions?: readonly { id: string; label: string; intent: "affirm" | "reject" }[]): Promise<Record<string, string>[]> {
  const bodies: Record<string, string>[] = [];
  const fake = (async (url: unknown, init?: { body?: unknown }) => {
    const method = String(url).split("/").pop() ?? "";
    bodies.push({ __method: method, ...Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))) });
    return {
      json: async () => (method === "conversations.open" ? { channel: { id: "D-owner" }, ok: true } : { ok: true, ts: "1773696665.000100" }),
      ok: true,
      status: 200,
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  await withPatchedFetch(fake, async () => {
    await slackPostArm.deliverDirectMessage?.({ principalId: "U-owner", text: "*Requesting Person* asks to use your notion credential.", ...(actions ? { actions } : {}) });
  });
  return bodies;
}

console.log("1. a DM carrying actions posts them as a Slack actions block:");
{
  const actions = grantCardActions(ASK);
  const bodies = await deliver(actions as never);
  const post = bodies.find((b) => b.__method === "chat.postMessage");
  ok(post !== undefined, "the arm posted a message");
  ok(typeof post?.blocks === "string", "…and it carried a `blocks` payload — before this slice the arm sent text alone and the buttons vanished");

  const blocks = JSON.parse(post?.blocks ?? "[]") as { type: string; text?: { text?: string }; elements?: { action_id?: string; style?: string; text?: { text?: string } }[] }[];
  eq(blocks[0]?.type, "section", "the first block is the card's own TEXT — a row of buttons over an empty message is not a card");
  ok((blocks[0]?.text?.text ?? "").includes("asks to use your notion credential"), "…and it is the copy the caller composed");
  eq(blocks[1]?.type, "actions", "the second block is the actions row");

  const elements = blocks[1]?.elements ?? [];
  eq(elements.length, 4, "…carrying all four answers");
  eq(
    elements.map((e) => parseGrantCardActionId(e.action_id)?.answer),
    ["once", "session", "standing", "decline"],
    "…and every rendered action id parses back through the CORE grammar the click route reads — the arm transports the id, it never composes one",
  );
  eq(elements.filter((e) => e.style === "danger").length, 1, "the reject intent renders `danger`, and nothing else does");
  ok(
    elements.every((e) => e.style !== "primary"),
    "no button renders `primary` — three of the four are equal affirmative choices, and emphasising all three emphasises none",
  );
  ok((post?.text ?? "").includes("asks to use your notion credential"), "the plain `text` still carries the message — it is the notification fallback once blocks are present");
}

console.log("2. NEGATIVE CONTROL — a DM with no actions is byte-unchanged:");
{
  const bodies = await deliver();
  const post = bodies.find((b) => b.__method === "chat.postMessage");
  eq(post?.blocks, undefined, "a DM carrying no actions posts NO `blocks` field at all — every existing DM caller is unaffected");
  ok((post?.text ?? "").length > 0, "…and it still posts its text");
}

console.log("3. NEGATIVE CONTROL — an unusable action drops out and the message still goes:");
{
  const bodies = await deliver([{ id: "x".repeat(300), intent: "affirm", label: "too long an id" }]);
  const post = bodies.find((b) => b.__method === "chat.postMessage");
  eq(post?.blocks, undefined, "an action id past Slack's 255-character cap drops out rather than making Slack reject the WHOLE post");
  ok((post?.text ?? "").length > 0, "…and the person still gets the message, which is the half that matters");
}

console.log("4. the front route claims an oe_grant: interactivity payload:");
{
  const payload = (actionId: string): string =>
    new URLSearchParams({ payload: JSON.stringify({ actions: [{ action_id: actionId }], channel: { id: "D-owner" }, team: { id: "T1" }, type: "block_actions", user: { id: "U-owner" } }) }).toString();

  const ours = classifyEnvelope(payload(`${OE_GRANT_ACTION_PREFIX}once:${ASK_ID}`), FORM_CT);
  eq(ours.kind, "grant-click", "an `oe_grant:` block_actions payload is OURS — never forwarded to eve's own handler");

  eq(classifyEnvelope(payload("oe_approval:approve:x"), FORM_CT).kind, "approval-click", "the approvals plane still classifies as its own");
  eq(classifyEnvelope(payload("oe_connect:notion:user-oauth"), FORM_CT).kind, "connect-click", "the connector card still classifies as its own");
  eq(classifyEnvelope(payload("eve_input:x"), FORM_CT).kind, "forward", "eve's own HITL click still FORWARDS untouched");
  eq(classifyEnvelope(new URLSearchParams({ command: "/oe" }).toString(), FORM_CT).kind, "forward", "a slash command still forwards");
}

console.log("5. §3 — every rendered button spells its mode with the one reader-facing word:");
{
  const bodies = await deliver(grantCardActions(ASK) as never);
  const post = bodies.find((b) => b.__method === "chat.postMessage");
  const blocks = JSON.parse(post?.blocks ?? "[]") as { elements?: { action_id?: string; text?: { text?: string } }[] }[];
  const elements = blocks[1]?.elements ?? [];
  const labelFor = (answer: string): string => elements.find((e) => parseGrantCardActionId(e.action_id)?.answer === answer)?.text?.text ?? "";

  for (const mode of ["once", "session", "standing"] as const) {
    ok(labelFor(mode).includes(GRANT_MODE_WORDS[mode]), `the \`${mode}\` button a person SEES carries "${GRANT_MODE_WORDS[mode]}"`);
  }

  ok(!labelFor("session").includes("session"), "🔴 the session button never shows the raw `session` column value");
  ok(!labelFor("standing").includes("standing"), "🔴 …nor does the standing button show `standing`");
  ok(labelFor("decline").length > 0 && !labelFor("decline").includes("Approve"), "the reject button is not an approve in disguise");
}

console.log(`\n✅ slack grant card: ${n} assertions passed`);

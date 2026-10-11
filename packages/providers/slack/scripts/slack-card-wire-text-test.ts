process.env.OE_SQLITE_PATH = ":memory:";
process.env.SLACK_BOT_TOKEN = "xoxb-test-wire-text";

import assert from "node:assert/strict";
import { slackForm } from "../agent/channels/slack-events.js";
import { supervisorPostFormBody } from "../agent/channels/slack.js";
import { withPatchedFetch } from "./_fetch-test-utils.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

interface Sent {
  readonly method: string;
  readonly raw: string;
  readonly form: URLSearchParams;
}
const sent: Sent[] = [];
const fake = (async (url: unknown, init?: { body?: unknown }) => {
  const raw = String(init?.body ?? "");
  sent.push({ method: String(url).split("/").pop() ?? "", raw, form: new URLSearchParams(raw) });
  return new Response(JSON.stringify({ ok: true, ts: "1767791021.550000" }), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const CARD_TEXT = [
  "Set the monthly spend limit for #watercooler3 to $2591.00/mo.",
  "Approval requested: spend.set",
  "Set spend limit — #watercooler3 (surface) · $: $50.00/mo → $2591.00/mo",
  "Requested by <@U1> · expires 2026-01-08T00:21:00.000Z",
].join("\n");
const BLOCKS = JSON.stringify([{ type: "header", text: { type: "plain_text", text: "Set the monthly spend limit", emoji: true } }]);

async function through(method: string, body: URLSearchParams): Promise<Sent> {
  sent.length = 0;
  const res = await slackForm(method, body.toString());
  ok(res?.ok === true, `${method}: slackForm returned Slack's envelope`);
  ok(sent.length === 1 && sent[0]!.method === method, `${method}: exactly one request, to ${method}`);
  return sent[0]!;
}

await withPatchedFetch(fake, async () => {
  {
    const post = new URLSearchParams();
    post.set("channel", "C1");
    post.set("thread_ts", "1767790960.000100");
    post.set("text", CARD_TEXT);
    post.set("blocks", BLOCKS);
    const p = await through("chat.postMessage", post);
    ok(p.form.get("text") === CARD_TEXT, `🔴 chat.postMessage: the text reaches fetch byte for byte (got ${JSON.stringify(p.form.get("text"))})`);
    ok(p.form.get("text")!.split("\n")[1] === "Approval requested: spend.set", "chat.postMessage: the label is the second line");
    ok(p.raw.includes("%0A"), "chat.postMessage: the raw body carries encoded line feeds");
    ok(p.form.get("blocks") === BLOCKS, "chat.postMessage: the blocks reach fetch unchanged");

    const update = new URLSearchParams();
    update.set("channel", "C1");
    update.set("ts", "1767791021.550000");
    update.set("text", CARD_TEXT);
    update.set("blocks", BLOCKS);
    const u = await through("chat.update", update);
    ok(u.form.get("text") === CARD_TEXT, `🔴 chat.update: the text reaches fetch byte for byte (got ${JSON.stringify(u.form.get("text"))})`);
    ok(u.raw.includes("%0A"), "chat.update: the raw body carries encoded line feeds");
  }

  {
    const note = "This approval was already decided.\nNothing changed.";
    const plain = await through("chat.postMessage", new URLSearchParams({ channel: "C1", text: note }));
    ok(plain.form.get("text") === note && plain.raw.includes("%0A"), "a plain-text post with no blocks keeps its lines");

    const reply = "First paragraph.\n\nSecond paragraph:\n• one\n• two";
    const sup = await through("chat.postMessage", new URLSearchParams(supervisorPostFormBody("C1", "1767790960.000100", reply)));
    ok((sup.form.get("text") ?? "").split("\n").length === reply.split("\n").length, `a supervisor reply keeps every line through the mrkdwn transform (got ${JSON.stringify(sup.form.get("text"))})`);
  }

  {
    const one = "One line, no break.";
    const c = await through("chat.postMessage", new URLSearchParams({ channel: "C1", text: one }));
    ok(c.form.get("text") === one && !c.raw.includes("%0A"), "negative control: a one-line text gains no line feed");
  }
});

console.log(`✓ slack-card-wire-text: ${n} assertions passed (card post and rewrite keep their lines through slackForm, plain and supervisor posts too, one-line negative control)`);

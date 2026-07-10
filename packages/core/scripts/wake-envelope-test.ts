import assert from "node:assert/strict";
import { renderWakeEnvelope, type WakeEnvelopeInput } from "../agent/channels/wake-envelope.js";
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from "../agent/access/untrusted.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

{
  const input: WakeEnvelopeInput = {
    reason: "channel-activity",
    currentTime: "2026-03-25T19:57:33Z",
    channel: { id: "C0EXCHAN012", type: "group", memberCount: 2 },
    messages: [
      {
        from: "human",
        author: "Rowan Hale",
        id: "1774468650.563000",
        sentAt: "2026-03-25T19:57:30Z",
        trust: "peer",
        trigger: true,
        body: `Can you check <script>alert("x")</script> & tell me?`,
      },
    ],
  };
  const out = renderWakeEnvelope(input);
  ok(out.startsWith(`<wake reason="channel-activity" current-time="2026-03-25T19:57:33Z">`), "peer wake: <wake> tag with reason + current-time");
  ok(out.includes(`<channel id="C0EXCHAN012" type="group" member-count="2">`), "peer wake: <channel> tag with id/type/member-count");
  ok(out.includes(`trust="peer"`), "peer wake: trust=peer");
  ok(out.includes(`trigger="true"`), "peer wake: sole message carries trigger=true");
  ok(!out.includes(`mention="true"`), "peer wake: no mention attribute when unset");
  ok(out.includes(UNTRUSTED_OPEN) && out.includes(UNTRUSTED_CLOSE), "peer wake: body is wrapped in the untrusted envelope");
  ok(out.includes(`&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;`), "peer wake: body text is XML-escaped (<, >, \" all escaped)");
  ok(out.includes(`&amp;`), "peer wake: bare & is escaped");
  ok(!out.includes(`<script>`), "peer wake: raw unescaped <script> tag never appears");
  ok(out.trim().endsWith("</wake>"), "peer wake: closes with </wake>");
}

{
  const input: WakeEnvelopeInput = {
    reason: "channel-activity",
    currentTime: "2026-03-25T19:58:00Z",
    channel: { id: "C0EXCHAN012", type: "im", memberCount: 2 },
    messages: [
      {
        from: "human",
        author: `Rowan "Ro" & Hale`,
        id: "1774484282.627000",
        sentAt: "2026-03-26T00:18:02Z",
        trust: "principal",
        trigger: true,
        mention: true,
        body: "@Claude what model are you running?",
      },
    ],
  };
  const out = renderWakeEnvelope(input);
  ok(out.includes(`trust="principal"`), "principal wake: trust=principal");
  ok(out.includes(`mention="true"`), "principal wake: mention=true when the message @mentions the bot");
  ok(out.includes(`author="Rowan &quot;Ro&quot; &amp; Hale"`), "principal wake: attribute values are XML-escaped too");
}

{
  const input: WakeEnvelopeInput = {
    reason: "message-edited",
    currentTime: "2026-03-25T19:59:00Z",
    channel: { id: "C0EXCHAN012", type: "group", memberCount: 3 },
    messages: [
      {
        from: "human",
        author: "Rowan Hale",
        id: "1774468720.000100",
        sentAt: "2026-03-25T19:58:55Z",
        trust: "peer",
        trigger: true,
        edited: true,
        previousBody: "can you fix teh bug",
        body: "can you fix the bug",
      },
    ],
  };
  const out = renderWakeEnvelope(input);
  ok(out.includes(`reason="message-edited"`), "edited wake: reason=message-edited");
  ok(out.includes(`edited="true"`), "edited wake: edited=true");
  ok(out.includes("<previous-body>") && out.includes("</previous-body>"), "edited wake: carries a <previous-body> tag");
  ok(out.includes("can you fix teh bug"), "edited wake: previous-body carries the OLD text");
  ok(out.includes("can you fix the bug"), "edited wake: message body carries the NEW (authoritative) text");
  ok(countOccurrences(out, UNTRUSTED_OPEN) === 2, "edited wake: BOTH the body and the previous-body are independently untrusted-wrapped");
  ok(out.indexOf("</previous-body>") < out.lastIndexOf("</message>"), "edited wake: previous-body nests inside the message element");
}

{
  const input: WakeEnvelopeInput = {
    reason: "dispatch",
    currentTime: "2026-03-25T20:44:57Z",
    channel: { id: "C0EXCHAN012", type: "group" },
    thread: { ts: "1774471226.164000", sessionOwner: "cse_01EXAMPLE00000000000001" },
    messages: [
      {
        from: "agent",
        author: "B0EXBOT0003",
        authorId: "B0EXBOT0003",
        id: "1774471496.365000",
        sentAt: "2026-03-25T20:44:56Z",
        trust: "relay",
        trigger: true,
        body: `Not "ignore" — it's routing by where you post…`,
      },
    ],
  };
  const out = renderWakeEnvelope(input);
  ok(out.includes(`reason="dispatch"`), "relay wake: reason=dispatch (the cross-session relay reason code)");
  ok(out.includes(`<thread ts="1774471226.164000" session-owner="cse_01EXAMPLE00000000000001">`), "relay wake: <thread> nesting with ts + session-owner");
  ok(out.includes("</thread>"), "relay wake: thread element closes");
  ok(out.includes(`from="agent"`) && out.includes(`trust="relay"`), "relay wake: from=agent, trust=relay");
  ok(out.includes(`author-id="B0EXBOT0003"`), "relay wake: author-id present for an agent-authored message");
  ok(out.indexOf("<thread") < out.indexOf("<message") && out.indexOf("</message>") < out.indexOf("</thread>"), "relay wake: message nests INSIDE the thread element");
}

{
  const input: WakeEnvelopeInput = {
    reason: "channel-activity",
    currentTime: "2026-03-25T20:52:00Z",
    channel: { id: "C5", type: "channel", memberCount: 8 },
    messages: [
      { from: "human", author: "Alice", id: "5.0", sentAt: "2026-03-25T20:51:00Z", trust: "peer", body: "first queued message" },
      { from: "human", author: "Bob", id: "5.1", sentAt: "2026-03-25T20:52:00Z", trust: "peer", trigger: true, body: "second queued message (the trigger)" },
    ],
  };
  const out = renderWakeEnvelope(input);
  ok(countOccurrences(out, 'trigger="true"') === 1, "batched wake: exactly one trigger=\"true\" across both messages");
  ok(out.includes("first queued message") && out.includes("second queued message"), "batched wake: both messages render");
  ok(out.indexOf("first queued message") < out.indexOf("second queued message"), "batched wake: oldest-first ordering preserved");
}

{
  const input: WakeEnvelopeInput = {
    reason: "channel-activity",
    currentTime: "2026-03-25T19:57:33Z",
    channel: { id: "C0EXCHAN012", type: "group", memberCount: 2 },
    messages: [
      { from: "human", author: "Rowan Hale", id: "1774484282.627000", sentAt: "2026-03-26T00:18:02Z", trust: "peer", ownerToken: "cse_01EXAMPLE00000000000002", body: "@Claude what model are you running?" },
      { from: "human", author: "Rowan Hale", id: "1774468650.563000", sentAt: "2026-03-25T19:57:30Z", trust: "peer", trigger: true, body: "I could use some assistance figuring this out" },
    ],
  };
  const out = renderWakeEnvelope(input);
  ok(countOccurrences(out, "<message") === 2, "backscroll wake: two <message> elements");
  ok(countOccurrences(out, 'trigger="true"') === 1, "backscroll wake: only the newest carries trigger=true");
  ok(out.includes(`thread-session-id="cse_01EXAMPLE00000000000002"`), "backscroll wake: the backscroll message's owner token renders as thread-session-id");
  ok(
    out.indexOf("what model are you running") < out.indexOf("I could use some assistance"),
    "backscroll wake: backscroll (oldest) precedes the trigger message",
  );
  ok(out.lastIndexOf("what model are you running") < out.indexOf('trigger="true"'), "backscroll wake: trigger=\"true\" only appears on the LAST (newest) message");
}

{
  const input: WakeEnvelopeInput = {
    reason: "channel-activity",
    currentTime: "2026-03-25T21:52:00Z",
    channel: { id: "C0EXCHAN012", type: "channel", memberCount: 5 },
    messages: [
      {
        from: "human",
        author: "Rowan Hale",
        id: "1774473520.000100",
        sentAt: "2026-03-25T21:51:59Z",
        trust: "peer",
        trigger: true,
        attachments: [
          { kind: "image", id: "F123", name: `dash "board".png`, mimeType: "image/png", url: "https://files.slack.test/F123" },
          { kind: "file", id: "F456", name: "spec.pdf", mimeType: "application/pdf" },
        ],
        body: "here's the screenshot and the spec",
      },
    ],
  };
  const out = renderWakeEnvelope(input);
  ok(out.includes(`<attachment kind="image" id="F123" name="dash &quot;board&quot;.png" mimetype="image/png" url="https://files.slack.test/F123"/>`), "attachments: image reference renders with escaped name + kind/id/mimetype/url");
  ok(out.includes(`<attachment kind="file" id="F456" name="spec.pdf" mimetype="application/pdf"/>`), "attachments: non-image file renders kind=file (referenced, not describable) with no url when absent");
  ok(out.indexOf("here's the screenshot") < out.indexOf("<attachment"), "attachments: rendered AFTER the message body (a filename can't be mistaken for message text)");
  ok(out.indexOf("<attachment") < out.indexOf("</message>"), "attachments: nested inside the <message> element");
}

{
  const base = {
    reason: "channel-activity" as const,
    currentTime: "2026-03-26T08:52:00Z",
    channel: { id: "C1" },
  };
  assert.throws(
    () => renderWakeEnvelope({ ...base, messages: [] }),
    /at least one message/,
    "no messages at all → throws",
  );
  n++;
  assert.throws(
    () =>
      renderWakeEnvelope({
        ...base,
        messages: [
          { from: "human", author: "A", id: "1", sentAt: "t", trust: "peer", body: "a" },
          { from: "human", author: "B", id: "2", sentAt: "t", trust: "peer", body: "b" },
        ],
      }),
    /exactly one message must carry trigger/,
    "zero trigger messages → throws",
  );
  n++;
  assert.throws(
    () =>
      renderWakeEnvelope({
        ...base,
        messages: [
          { from: "human", author: "A", id: "1", sentAt: "t", trust: "peer", trigger: true, body: "a" },
          { from: "human", author: "B", id: "2", sentAt: "t", trust: "peer", trigger: true, body: "b" },
        ],
      }),
    /exactly one message must carry trigger/,
    "two trigger messages → throws",
  );
  n++;
  assert.throws(
    () =>
      renderWakeEnvelope({
        ...base,
        messages: [
          { from: "human", author: "A", id: "1", sentAt: "t", trust: "peer", trigger: true, body: "a" },
          { from: "human", author: "B", id: "2", sentAt: "t", trust: "peer", body: "b" },
        ],
      }),
    /trigger message must be last/,
    "trigger not last → throws (backscroll must end at the trigger)",
  );
  n++;
}

console.log(
  `✓ wake-envelope: ${n} assertions passed (peer + principal + edited + relay(thread-nested) + batched + backscroll + untrusted-wrap/escaping + structural invariants)`,
);

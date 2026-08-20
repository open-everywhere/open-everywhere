import assert from "node:assert/strict";
import { markdownToSlackMrkdwn } from "../agent/channels/slack-mrkdwn.js";

let n = 0;
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("markdownToSlackMrkdwn:");

interface Case {
  readonly label: string;
  readonly input: string;
  readonly expected: string;
}

const cases: Case[] = [
  {
    label: "the observed live fixture (2026-08-20, #oe-soak-ops channel-join intro)",
    input: "**Track soak health** with `/soak status` — see the [runbook](https://example.com/runbook) for details.",
    expected: "*Track soak health* with `/soak status` — see the <https://example.com/runbook|runbook> for details.",
  },
  {
    label: "bold: ** pair",
    input: "This is **bold** text.",
    expected: "This is *bold* text.",
  },
  {
    label: "bold: __ pair (GFM alt syntax)",
    input: "This is __bold__ text.",
    expected: "This is *bold* text.",
  },
  {
    label: "NO DOUBLE-CONVERT: a single *bold* (already Slack mrkdwn) survives untouched",
    input: "This is *already bold* text.",
    expected: "This is *already bold* text.",
  },
  {
    label: "NO DOUBLE-CONVERT: idempotent — running the transform twice matches running it once",
    input: "**Track soak health**",
    expected: "*Track soak health*",
  },
  {
    label: "italic underscore is already valid Slack mrkdwn — untouched",
    input: "This is _italic_ text.",
    expected: "This is _italic_ text.",
  },
  {
    label: "header → a bold line (Slack has no heading syntax)",
    input: "# Soak health\nEverything is green.",
    expected: "*Soak health*\nEverything is green.",
  },
  {
    label: "header level 3",
    input: "### Track soak health",
    expected: "*Track soak health*",
  },
  {
    label: "link: [text](url) → <url|text>",
    input: "See [the runbook](https://example.com/runbook) for details.",
    expected: "See <https://example.com/runbook|the runbook> for details.",
  },
  {
    label: "strikethrough: ~~text~~ → ~text~",
    input: "This was ~~removed~~ dropped.",
    expected: "This was ~removed~ dropped.",
  },
  {
    label: "bullet list: - item → • item",
    input: "- first\n- second",
    expected: "• first\n• second",
  },
  {
    label: "bullet list: * item → • item",
    input: "* first\n* second",
    expected: "• first\n• second",
  },
  {
    label: "blockquote (already valid Slack mrkdwn) survives untouched",
    input: "> a quoted line",
    expected: "> a quoted line",
  },
  {
    label: "CODE FENCE: markdown-looking text inside a fenced block is never touched",
    input: "Here is code:\n```\n**not bold** [not a link](x) # not a header\n```\nDone.",
    expected: "Here is code:\n```\n**not bold** [not a link](x) # not a header\n```\nDone.",
  },
  {
    label: "INLINE CODE: markdown-looking text inside a code span is never touched",
    input: "Use `**not bold**` in your reply.",
    expected: "Use `**not bold**` in your reply.",
  },
  {
    label: "mixed: bold outside code, untouched markdown-looking text inside code, on one line",
    input: "**Bold** and `**not bold**` together.",
    expected: "*Bold* and `**not bold**` together.",
  },
  {
    label: "empty string is a no-op",
    input: "",
    expected: "",
  },
  {
    label: "plain text with no markdown passes through unchanged",
    input: "Nothing to convert here.",
    expected: "Nothing to convert here.",
  },
];

for (const c of cases) {
  eq(markdownToSlackMrkdwn(c.input), c.expected, c.label);
}

console.log("idempotence — transform(transform(x)) === transform(x):");
for (const c of cases) {
  const once = markdownToSlackMrkdwn(c.input);
  const twice = markdownToSlackMrkdwn(once);
  eq(twice, once, `idempotent: ${c.label}`);
}

console.log(`\n${n} assertions passed.`);

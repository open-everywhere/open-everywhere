import { personTextFaults } from "../../agent/channels/person-text.js";
import { declaredAuditActions } from "../../agent/audit/action-registry.js";

export type ReaderRulingId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6";

export interface ReaderRuling {
  readonly id: ReaderRulingId;
  readonly title: string;
  readonly text: string;
}

export const READER_RULINGS: readonly ReaderRuling[] = [
  {
    id: "R1",
    title: "an ordinary reader",
    text:
      "The reader is an ordinary person, not an engineer. Write as a good consumer product would: Otter's " +
      '"Otter is taking notes", a calendar invite, a colleague\'s one-line message.',
  },
  {
    id: "R2",
    title: "a card is a headline",
    text:
      'A card is a short headline ("Join the General voice channel to take notes?"), at most one line of ' +
      "consequence, and the buttons.",
  },
  {
    id: "R3",
    title: "no internals, no raw ids",
    text:
      'Never in visible text: an internal kind label ("Approval requested: meeting.join"), a model or route ' +
      "name, a sandbox backend, spend-ledger talk, restated policy prose, or a raw platform id or scope key " +
      "(U0FAKE0001, slack/T.../C..., mtg_..., wrun_...). People are display names or mentions, places are " +
      'channel names or plain words, and the asker is "you".',
  },
  {
    id: "R4",
    title: "no trust plumbing",
    text: 'Security and trust plumbing never appears: "untrusted content", "not instructions from me", taint, fences, provenance.',
  },
  {
    id: "R5",
    title: "which account",
    text:
      "Where text must prove WHICH account, the display name links to the account's native profile URL, with " +
      "the verified email or unique handle beside it. The raw id appears only inside the URL.",
  },
  {
    id: "R6",
    title: "no narration, no repeats",
    text:
      "No narration of how the work was done (hand-offs, workers, tools, sessions). Don't repeat what a card " +
      "already shows.",
  },
];

export interface ReaderText {
  readonly text: string;
  readonly card?: boolean;
}

export interface ReaderHit {
  readonly rule: string;
  readonly ruling: ReaderRulingId;
  readonly quote: string;
}

export interface ReaderRule {
  readonly id: string;
  readonly ruling: ReaderRulingId;
  readonly what: string;
  readonly find: (item: ReaderText) => readonly string[];
}

export function visibleWords(text: string): string {
  return text.replace(/<[@#!][^>\s]+>|<https?:\/\/[^>|\s]+(?:\|([^>]*))?>|https?:\/\/\S+|\]\(https?:\/\/[^)\s]+\)/g, (_m, label: string | undefined) => (label ? ` ${label} ` : " "));
}

function matchAll(patterns: readonly RegExp[]): (item: ReaderText) => string[] {
  return (item) => {
    const visible = visibleWords(item.text);
    const out: string[] = [];
    for (const p of patterns) {
      const re = new RegExp(p.source, p.flags.includes("g") ? p.flags : `${p.flags}g`);
      for (const m of visible.matchAll(re)) out.push(m[0]);
    }
    return out;
  };
}

const KIND_LABELS: ReadonlySet<string> = new Set(declaredAuditActions().filter((a) => a.includes(".")));

const DOTTED_TOKEN = /(?<![\w./-])[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+(?![\w/-])/g;

const MODEL_VENDORS = ["openai", "anthropic", "google", "deepseek", "alibaba", "meta", "mistral", "xai", "spacexai", "microsoft", "minimax", "moonshotai", "zai", "qwen"];

export const READER_RULES: readonly ReaderRule[] = [
  {
    id: "shared-detector",
    ruling: "R3",
    what: "a raw id, debug detail or trust plumbing (the shared person-text detector, OPE-2486)",
    find: (item) => personTextFaults(item.text).map((f) => f.replace(/^(?:raw id|debug|plumbing): /, "")),
  },
  {
    id: "kind-label",
    ruling: "R3",
    what: "an internal kind label",
    find: (item) => {
      const visible = visibleWords(item.text);
      const out = [...visible.matchAll(/\bApproval requested:\s*\S*/g)].map((m) => m[0]);
      for (const m of visible.matchAll(DOTTED_TOKEN)) if (KIND_LABELS.has(m[0])) out.push(m[0]);
      return out;
    },
  },
  {
    id: "internal-name",
    ruling: "R3",
    what: "a snake_case internal name (a tool, a field, a kind)",
    find: matchAll([/(?<![\w./:-])[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+(?![\w./-])/]),
  },
  {
    id: "model-name",
    ruling: "R3",
    what: "a model or route name",
    find: matchAll([new RegExp(`\\b(?:${MODEL_VENDORS.join("|")})\\/[\\w.-]+`, "i"), /\bmodel A\/B\b/i, /\bA\/B turn\b/i]),
  },
  {
    id: "sandbox",
    ruling: "R3",
    what: "a sandbox backend",
    find: matchAll([/\bsandbox(?:es)?:? (?:vercel|docker|e2b|daytona|modal|backend|vm|stream|runtime)\b/i, /\b(?:vercel|docker|e2b|daytona|modal) sandbox\b/i, /\bworkspace VM\b/i]),
  },
  {
    id: "spend-ledger",
    ruling: "R3",
    what: "spend-ledger talk",
    find: matchAll([/\b(?:spend|usage|token) ledger\b/i, /\bledger (?:row|entry|period)s?\b/i, /\bspend (?:cap|row|record)s?\b/i]),
  },
  {
    id: "prefixed-id",
    ruling: "R3",
    what: "a prefixed raw id or a storage key",
    find: matchAll([
      /(?<![\w./-])[a-z]{2,8}_(?!v\d+\b)[a-z0-9]*\d[a-z0-9]*\b/i,
      /(?<![\w/])(?!https?:|mailto:)[a-z][a-z0-9-]*:[\w.-]+\/[\w./-]*/i,
    ]),
  },
  {
    id: "ask-for-id",
    ruling: "R3",
    what: "an id the reader is asked for or told about",
    find: matchAll([/\b(?:meeting|session|pending|task|wake|request|run|routine|approval|card) id\b/i]),
  },
  {
    id: "engineer-voice",
    ruling: "R1",
    what: "an engineer's word for the product",
    find: matchAll([
      /\bthis deployment\b/i,
      /\ban? operator\b/i,
      /\b(?:the agent|I|I've|I'm|acting)\b[^.!?\n]{0,30}\bon behalf of\b/i,
      /\bon behalf of (?:you|<@|[UW][A-Z0-9]{6,})/,
      /\b(?:this|that|every|each|the|a) surface\b/i,
    ]),
  },
  {
    id: "trust-plumbing",
    ruling: "R4",
    what: "security or trust plumbing",
    find: matchAll([
      /\buntrusted\b/i,
      /\bnot (?:as )?instructions?(?: (?:from|for) (?:me|you))?\b/i,
      /\bfenced (?:content|block|text|section|message)s?\b/i,
      /\b(?:content|message|text) fences?\b/i,
      /\btrust(?:ed)? (?:level|content|boundary)\b/i,
      /\bprompt injection\b/i,
    ]),
  },
  {
    id: "narration",
    ruling: "R6",
    what: "narration of how the work was done",
    find: matchAll([
      /\b(?:I|I've|I'm|I'll)\s+(?:just\s+)?(?:hand(?:ed|ing)?|pass(?:ed|ing)?)\b[^.!?\n]{0,24}?\b(?:off|over)\b/i,
      /(?:^|[.!?—–]\s*)hand(?:ing|ed)? (?:this|it|that) (?:off|over)\b/i,
      /\b(?:hand(?:ed|ing|s)?|pass(?:ed|ing|es)?|gave|give|sent)\b[^.!?\n]{0,24}?\bto (?:a|the|my|another) (?:worker|subagent|sub-agent|helper|background task)\b/i,
      /\b(?:a|the|my) (?:worker|subagent|sub-agent|helper) (?:will|which|is|has|reported|returned|said)\b/i,
      /\b(?:a|my) (?:subagent|sub-agent)\b/i,
      /\b(?:which|it|they|the worker|the task|the helper) will report back\b/i,
      /(?:^|[—–:-]\s*)will report back\b/i,
      /\b(?:this|that|my|the current|the next|a new) turn\b/i,
      /\b(?:worker|agent|background|model|eve) sessions?\b/i,
      /\bsessions? (?:key|log|state|transcript)\b/i,
      /\b(?:the|a|my) (?:[a-z]+_[a-z_]+|read|fetch|search|reply|work|memory|bash|delegation) tool\b/i,
      /\btool calls?\b/i,
      /\bSources read\b/i,
    ]),
  },
  {
    id: "card-budget",
    ruling: "R2",
    what: "a card over its budget: a headline, one consequence line, one warning, a footer",
    find: (item) => {
      if (!item.card) return [];
      const lines = item.text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      const out: string[] = [];
      if (lines.length > 4) out.push(`${lines.length} visible lines`);
      const headline = lines[0] ?? "";
      if (headline.length > 120) out.push(headline);
      return out;
    },
  },
];

export function readerHits(item: ReaderText, rules: readonly ReaderRule[] = READER_RULES): ReaderHit[] {
  const out: ReaderHit[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    for (const quote of rule.find(item)) {
      const key = `${rule.id}\u0000${quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rule: rule.id, ruling: rule.ruling, quote });
    }
  }
  return out;
}

function headlineCore(text: string): string {
  const first = (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
  return first.replace(/^\*+|\*+$/g, "").replace(/[?.!:]+$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function cardRepeatHits(items: readonly ReaderText[]): Array<{ readonly index: number; readonly quote: string }> {
  const headlines = items.filter((it) => it.card).map((it) => headlineCore(it.text)).filter((h) => h.length >= 12);
  const out: Array<{ index: number; quote: string }> = [];
  items.forEach((it, index) => {
    if (it.card) return;
    const flat = it.text.replace(/\*+/g, "").replace(/\s+/g, " ").toLowerCase();
    const hit = headlines.find((h) => flat.includes(h));
    if (hit !== undefined) out.push({ index, quote: hit });
  });
  return out;
}

export function readerJudgePrompt(rulings: readonly ReaderRuling[] = READER_RULINGS): string {
  return [
    "You read messages that a team assistant posted in a chat room. Read them as an ordinary office worker",
    "who is not technical would: once, quickly, wanting to know what happened and what to do.",
    "",
    "Flag every place a message breaks one of these rulings:",
    ...rulings.map((r) => `${r.id} (${r.title}): ${r.text}`),
    "",
    "Also flag a message that is longer than it needs to be: say which words a good editor would cut.",
    "Give at most TWO flags per message, the most serious first.",
    "A plain sentence that an office worker understands at once is NOT a flag, even when it is short or blunt.",
    "Names of people, channels, documents and products the room uses are fine. Quote only words that",
    "appear in the message.",
    "",
    'Reply with STRICT JSON and nothing else: {"flags":[{"item":<number>,"ruling":"R1".."R6" or "LONG",',
    '"quote":"<exact words from the message>","why":"<one short line>"}]}. Use {"flags":[]} when every',
    "message reads well.",
  ].join("\n");
}

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPLY_STYLE_RUBRIC } from "../agent/instructions/access.js";
import { renderDmSeatPersona, renderSeatPersona, type DeliveryArm } from "../agent/instructions/seat-prompt.js";
import { readerHits } from "./e2e/reader-rubric.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TOOLS_DIR = join(REPO_ROOT, "packages/core/agent/tools");

const NEGATION =
  /\b(?:never|not|no|nor|don'?t|do not|doesn'?t|isn'?t|instead of|rather than|avoid|wrong|forbid\w*|ban\w*|fabricat\w*|lie|lies|false|nothing|without|untrue|narrat\w*)\b|n't\b/i;
const READ_CONTEXT = /\b(?:fails? with|failed with|returns?|returned|errors? (?:with|says)|prints?|output)\s*$/i;

const QUOTE = /"([^"\n]{3,240})"|“([^”\n]{3,240})”/g;

interface InstructionFinding {
  readonly source: string;
  readonly phrase: string;
  readonly rules: string;
  readonly sentence: string;
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+\.)\s)/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

const CLAUSE_EDGE = /[:;—()]|[.!?](?=\s|$)/g;

function modelledFlaggedPhrases(source: string, text: string): InstructionFinding[] {
  const out: InstructionFinding[] = [];
  for (const flat of paragraphs(text)) {
    for (const m of flat.matchAll(QUOTE)) {
      const phrase = m[1] ?? m[2] ?? "";
      if (!/\s/.test(phrase.trim())) continue;
      const at = m.index ?? 0;
      const endQuote = at + m[0].length;
      if (READ_CONTEXT.test(flat.slice(Math.max(0, at - 40), at))) continue;
      if ((flat.slice(0, at).match(/`/g) ?? []).length % 2 === 1) continue;
      const hits = readerHits({ text: phrase });
      if (hits.length === 0) continue;
      let clauseStart = 0;
      for (const e of flat.slice(0, at).matchAll(CLAUSE_EDGE)) clauseStart = (e.index ?? 0) + 1;
      CLAUSE_EDGE.lastIndex = 0;
      const after = flat.slice(endQuote);
      const edgeAfter = after.search(/[:;—()]|[.!?](?=\s|$)/);
      const clause = `${flat.slice(clauseStart, at)} ${edgeAfter < 0 ? after : after.slice(0, edgeAfter)}`;
      if (NEGATION.test(clause)) continue;
      out.push({ source, phrase, rules: hits.map((h) => `${h.rule}: ${h.quote}`).join("; "), sentence: flat.slice(Math.max(0, at - 120), endQuote + 120) });
    }
  }
  return out;
}

const LITERAL = /\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/y;
const PLUS = /\s*\+/y;

function toolDescriptions(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:\bdescription:|\.describe\()\s*/g)) {
    let i = (m.index ?? 0) + m[0].length;
    let text = "";
    for (;;) {
      LITERAL.lastIndex = i;
      const lit = LITERAL.exec(src);
      if (!lit) break;
      text += (lit[1] ?? lit[2] ?? lit[3] ?? "").replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, " ");
      i = LITERAL.lastIndex;
      PLUS.lastIndex = i;
      if (!PLUS.exec(src)) break;
      i = PLUS.lastIndex;
    }
    if (text.length > 0) out.push(text);
  }
  return out;
}

const corpus: Array<[string, string]> = [
  ["voice section", REPLY_STYLE_RUBRIC],
  ["agent/instructions.md", readFileSync(join(REPO_ROOT, "agent/instructions.md"), "utf8")],
  ["template agent/instructions.md", readFileSync(join(REPO_ROOT, "packages/create/template/agent/instructions.md"), "utf8")],
  ["dm seat", renderDmSeatPersona()],
  ["worker midTurnPost=true", renderSeatPersona({ seatKind: "worker", midTurnPost: true })],
  ["worker midTurnPost=false", renderSeatPersona({ seatKind: "worker", midTurnPost: false })],
];
const ARMS: readonly DeliveryArm[] = [{ kind: "wake-addressed", pinned: false }, { kind: "wake-addressed", pinned: true }, { kind: "reply-only" }, { kind: "closing-text" }, { kind: "dual-mode" }];
for (const delivery of ARMS) {
  for (const forwardsWork of [false, true]) {
    for (const scope of ["channel", "thread"] as const) {
      corpus.push([`seat ${delivery.kind} forwardsWork=${forwardsWork} scope=${scope}`, renderSeatPersona({ seatKind: "conversational", delivery, forwardsWork, scope })]);
    }
  }
}
let descriptionCount = 0;
for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts")).sort()) {
  const descs = toolDescriptions(readFileSync(join(TOOLS_DIR, file), "utf8"));
  descriptionCount += descs.length;
  descs.forEach((d, i) => corpus.push([`tools/${file} description ${i + 1}`, d]));
}

ok(descriptionCount >= 200, `§1 the tool descriptions are read (got ${descriptionCount}) — a broken extractor would read none and pass`);
ok(toolDescriptions(`x = { description: "one " + 'two ' + \`three\`, inputSchema: z.string().describe("four") }`).join("|") === "one two three|four", "§1 the extractor joins `+`-concatenated literals and reads `.describe`");

const findings = corpus.flatMap(([source, text]) => modelledFlaggedPhrases(source, text));
for (const f of findings) {
  ok(false, `§2 ${f.source} models the phrase ${JSON.stringify(f.phrase)}, which the reader rubric flags (${f.rules}). Rewrite the phrase, or say in the same sentence that the model must not use it. Sentence: ${f.sentence}`);
}
ok(findings.length === 0, "§2 no instruction or tool description models a phrase the reader rubric flags");

{
  const before = 'Routed work is NOT done until the worker reports back: acknowledge it is underway ("handing this off — will report back"), and say so.';
  const modelled = 'When you route work, acknowledge it ("handing this off — will report back") in the same turn.';
  ok(modelledFlaggedPhrases("probe", modelled).length === 1, "§3 a modelled flagged phrase is caught");
  const toolSrc = `export const t = tool({ description: ${JSON.stringify(modelled)}, inputSchema: z.object({}) });`;
  ok(toolDescriptions(toolSrc).flatMap((d) => modelledFlaggedPhrases("probe", d)).length === 1, "§3 …also inside a tool description, through the extractor");
  ok(modelledFlaggedPhrases("probe", 'Never say "I handed this to a worker" to the room.').length === 0, "§3 the same class of phrase under a \"never\" is spared");
  ok(modelledFlaggedPhrases("probe", 'If a command fails with "sandbox stream was closed", run it again.').length === 0, "§3 a phrase the model reads (an error string) is spared");
  ok(modelledFlaggedPhrases("probe", 'Say "Stopped recording." and nothing more.').length === 0, "§3 a good phrasing passes");
  ok(modelledFlaggedPhrases("probe", before).length === 1, "§3 the pre-OPE-2480 seat wording is caught: a NOT in another clause does not spare it");
  ok(modelledFlaggedPhrases("probe", '"I handed this to a worker" is a fabrication on a turn that called none.').length === 0, "§3 a phrase whose own clause names it a fabrication is spared");
  ok(modelledFlaggedPhrases("probe", '- Never narrate the plumbing.\n- Say "I handed this to a worker" when you route work.').length === 1, "§3 one bullet's never does not spare the next bullet");
}

console.log(`reader-instructions-test: ${n} assertions passed (${corpus.length} sources, ${descriptionCount} tool descriptions)`);

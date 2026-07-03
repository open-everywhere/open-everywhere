import type { CandidateCluster } from "./candidates.js";

export interface DistilledFact {
  readonly text: string;
  readonly links: readonly string[];
}

export interface DistillInput {
  readonly scope: string;
  readonly request: string;
  readonly messages?: readonly string[];
  readonly signature: string;
  readonly count: number;
}

export interface JudgeVerdict {
  readonly confirm: boolean;
  readonly keep?: string;
  readonly note?: string;
}

export interface DreamJudge {
  judge(scope: string, candidate: CandidateCluster): Promise<JudgeVerdict | null>;
  distill(input: DistillInput): Promise<readonly DistilledFact[] | null>;
}

export type DreamCompletion = (scope: string, prompt: string) => Promise<string>;

const JUDGE_TASK: Record<CandidateCluster["kind"], string> = {
  consolidate:
    "Decide whether these two bullets state the SAME fact (a true duplicate in different words). " +
    "Different facts about the same topic are NOT the same fact.",
  contradiction:
    "Decide whether these two bullets CONTRADICT each other — they cannot both be true now. " +
    "Unrelated or compatible facts about the same subject are NOT a contradiction.",
  stale:
    "Decide whether bullet A is STALE because bullet B supersedes it (B is the newer state of " +
    "the same fact). Old age alone is NOT staleness — only supersession is.",
};

export function judgePrompt(c: CandidateCluster): string {
  return [
    "You are auditing an AI agent's memory notes during a maintenance pass.",
    JUDGE_TASK[c.kind],
    "",
    `From file "${c.file}":`,
    `A: ${c.bullets[0]}`,
    `B: ${c.bullets[1] ?? "(none)"}`,
    `Selected because: ${c.reason}`,
    "",
    'Reply with STRICT JSON only, no prose: {"confirm": true|false, "keep": "<one of the two lines, verbatim, only when confirmed and one line should survive>", "note": "<one short sentence why>"}',
    "Confirm ONLY when certain. When in doubt, confirm false.",
  ].join("\n");
}

export function distillPrompt(i: DistillInput): string {
  const messages = (i.messages ?? []).slice(0, 10).map((m) => `- ${m}`);
  return [
    "You are distilling one finished session of an AI agent into durable memory.",
    `The recurring request (seen ${i.count}×): "${i.request}"`,
    ...(messages.length > 0 ? ["Session messages:", ...messages] : []),
    "",
    "Write 1–3 DURABLE facts worth remembering across sessions — stable preferences, decisions,",
    "recurring workflows. Not one-off chatter. For each fact, list related topic names (short,",
    "kebab-case) to be written as [[wikilinks]].",
    'Reply with STRICT JSON only, no prose: {"facts": [{"text": "…", "links": ["topic-name"]}]}',
    'Reply {"facts": []} if nothing is durable.',
  ].join("\n");
}

function extractJSON(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseJudgeVerdict(text: string): JudgeVerdict | null {
  const raw = extractJSON(text);
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["confirm"] !== "boolean") return null;
  return {
    confirm: o["confirm"],
    keep: typeof o["keep"] === "string" && o["keep"].length > 0 ? o["keep"] : undefined,
    note: typeof o["note"] === "string" && o["note"].length > 0 ? o["note"].slice(0, 300) : undefined,
  };
}

export function parseDistilledFacts(text: string): DistilledFact[] | null {
  const raw = extractJSON(text);
  if (typeof raw !== "object" || raw === null) return null;
  const facts = (raw as Record<string, unknown>)["facts"];
  if (!Array.isArray(facts)) return null;
  const out: DistilledFact[] = [];
  for (const f of facts) {
    if (typeof f !== "object" || f === null) continue;
    const o = f as Record<string, unknown>;
    if (typeof o["text"] !== "string" || o["text"].trim().length === 0) continue;
    const links = Array.isArray(o["links"])
      ? o["links"].filter((l): l is string => typeof l === "string" && l.trim().length > 0).slice(0, 4)
      : [];
    out.push({ text: o["text"].trim().slice(0, 300), links: links.map((l) => l.trim()) });
    if (out.length === 3) break;
  }
  return out;
}

export function judgeFromCompletion(complete: DreamCompletion): DreamJudge {
  return {
    async judge(scope, candidate) {
      try {
        return parseJudgeVerdict(await complete(scope, judgePrompt(candidate)));
      } catch {
        return null;
      }
    },
    async distill(input) {
      try {
        return parseDistilledFacts(await complete(input.scope, distillPrompt(input)));
      } catch {
        return null;
      }
    },
  };
}

let registered: DreamJudge | null = null;

export function registerDreamJudge(judge: DreamJudge): void {
  registered = judge;
}

export function dreamJudge(): DreamJudge | null {
  return registered;
}

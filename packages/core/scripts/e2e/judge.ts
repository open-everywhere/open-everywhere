export interface Rubric {
  readonly kind: "closedQA" | "factuality";
  readonly criteria: string;
  readonly expected?: string;
  readonly atLeast: number;
  readonly fallback: FallbackCheck;
}

export interface FallbackCheck {
  readonly mustMatch?: readonly (string | RegExp)[];
  readonly mustNotMatch?: readonly (string | RegExp)[];
}

export interface JudgeVerdict {
  readonly pass: boolean;
  readonly score: number;
  readonly detail: string;
}

export interface ReplyJudge {
  readonly name: string;
  grade(rubric: Rubric, reply: string): Promise<JudgeVerdict>;
}

function matches(reply: string, pattern: string | RegExp): boolean {
  return typeof pattern === "string" ? reply.toLowerCase().includes(pattern.toLowerCase()) : pattern.test(reply);
}

export function runFallbackCheck(check: FallbackCheck, reply: string): { pass: boolean; detail: string } {
  for (const p of check.mustMatch ?? []) {
    if (!matches(reply, p)) return { pass: false, detail: `expected match missing: ${String(p)}` };
  }
  for (const p of check.mustNotMatch ?? []) {
    if (matches(reply, p)) return { pass: false, detail: `forbidden match present: ${String(p)}` };
  }
  return { pass: true, detail: "fallback checks passed" };
}

export class FallbackJudge implements ReplyJudge {
  readonly name = "fallback (regex/contains — LLM judge not wired yet)";

  grade(rubric: Rubric, reply: string): Promise<JudgeVerdict> {
    const { pass, detail } = runFallbackCheck(rubric.fallback, reply);
    return Promise.resolve({ pass, score: pass ? 1 : 0, detail: `[fallback] ${detail}` });
  }
}

export async function judge3(judge: ReplyJudge, rubric: Rubric, reply: string): Promise<JudgeVerdict> {
  const verdicts = await Promise.all([judge.grade(rubric, reply), judge.grade(rubric, reply), judge.grade(rubric, reply)]);
  const passes = verdicts.filter((v) => v.pass).length;
  return {
    pass: passes >= 2,
    score: passes / 3,
    detail: `majority-of-3: ${passes}/3 passed (${verdicts.map((v) => v.detail).join(" | ")})`,
  };
}

export function resolveJudge(): ReplyJudge {
  return new FallbackJudge();
}

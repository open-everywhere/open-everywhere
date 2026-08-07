export interface Rubric {
  readonly kind: "closedQA" | "factuality";
  readonly criteria: string;
  readonly expected?: string;
  readonly atLeast: number;
  readonly context?: string;
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
  readonly judge?: "llm" | "fallback";
  readonly fallbackReason?: string;
}

export interface ReplyJudge {
  readonly name: string;
  grade(rubric: Rubric, reply: string): Promise<JudgeVerdict>;
}

function foldTypographic(s: string): string {
  return s.replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\u00a0\u202f]/g, " ");
}

function matches(reply: string, pattern: string | RegExp): boolean {
  return typeof pattern === "string"
    ? foldTypographic(reply).toLowerCase().includes(foldTypographic(pattern).toLowerCase())
    : pattern.test(reply);
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

function fallbackVerdict(rubric: Rubric, reply: string, reason: string): JudgeVerdict {
  const { pass, detail } = runFallbackCheck(rubric.fallback, reply);
  return { pass, score: pass ? 1 : 0, detail: `[fallback (${reason})] ${detail}`, judge: "fallback", fallbackReason: reason };
}

export class FallbackJudge implements ReplyJudge {
  readonly name: string;
  constructor(private readonly reason = "LLM judge not wired") {
    this.name = `fallback (regex/contains — ${reason})`;
  }

  grade(rubric: Rubric, reply: string): Promise<JudgeVerdict> {
    return Promise.resolve(fallbackVerdict(rubric, reply, this.reason));
  }
}

export type JudgeTransport = (system: string, user: string) => Promise<string>;

export function buildJudgePrompt(rubric: Rubric, reply: string): { system: string; user: string } {
  const system =
    "You are a strict grader for an AI team-assistant's reply in an end-to-end test. You are given a " +
    "yes/no CRITERIA question about a REPLY and the reply text. Decide whether the reply satisfies the " +
    "criteria. Rules: " +
    "(1) GROUNDING — if the criteria asks for a REAL answer about specific data (the user's pages, a " +
    "stored fact, a search result, a headcount), a reply that instead explains it needs authorization, " +
    "says to connect an account first, says \"I would need to…\", or otherwise DEFERS without actually " +
    "answering FAILS. Only an answer grounded in real data (or an honest, specific \"there is none\") passes " +
    "such a criteria. " +
    "(2) IGNORE INCIDENTAL WORDS — judge the reply's MEANING, not surface tokens. The mere appearance of a " +
    "word like \"error\", \"exception\", \"fail\", or \"traceback\" inside otherwise-benign prose is NOT a " +
    "failure unless the reply actually reports a malfunction. " +
    "(3) Be literal and deterministic about the criteria; do not invent requirements it does not state. " +
    'Reply with STRICT JSON and nothing else: {"pass": true|false, "reason": "one short line"}.';
  const parts = [`CRITERIA (answer yes/no):\n${rubric.criteria}`];
  if (rubric.kind === "factuality" && rubric.expected) parts.push(`EXPECTED FACT:\n${rubric.expected}`);
  if (rubric.context) parts.push(`CONTEXT:\n${rubric.context}`);
  parts.push(`REPLY:\n${reply || "(empty)"}`);
  return { system, user: parts.join("\n\n") };
}

export function parseJudgeResponse(content: string): { pass: boolean; reason: string } | null {
  const m = /\{[\s\S]*\}/.exec(content ?? "");
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.pass !== "boolean") return null;
  const reason = typeof rec.reason === "string" ? rec.reason.slice(0, 200) : "";
  return { pass: rec.pass, reason };
}

export function gatewayTransport(cfg: { key: string; base: string; model: string }): JudgeTransport {
  return async (system, user) => {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`gateway HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? "";
  };
}

export class LlmJudge implements ReplyJudge {
  readonly name: string;
  constructor(
    private readonly transport: JudgeTransport,
    private readonly modelId: string,
  ) {
    this.name = `llm (${modelId} via AI gateway, temp 0)`;
  }

  async grade(rubric: Rubric, reply: string): Promise<JudgeVerdict> {
    const { system, user } = buildJudgePrompt(rubric, reply);
    let content: string;
    try {
      content = await this.transport(system, user);
    } catch (e) {
      return fallbackVerdict(rubric, reply, `judge call failed: ${(e as Error).message}`);
    }
    const parsed = parseJudgeResponse(content);
    if (!parsed) return fallbackVerdict(rubric, reply, "judge output unparseable");
    return {
      pass: parsed.pass,
      score: parsed.pass ? 1 : 0,
      detail: `[llm] ${parsed.reason || (parsed.pass ? "criteria met" : "criteria not met")}`,
      judge: "llm",
    };
  }
}

export async function judge3(judge: ReplyJudge, rubric: Rubric, reply: string): Promise<JudgeVerdict> {
  const verdicts = await Promise.all([judge.grade(rubric, reply), judge.grade(rubric, reply), judge.grade(rubric, reply)]);
  const passes = verdicts.filter((v) => v.pass).length;
  const fellBack = verdicts.filter((v) => v.judge === "fallback");
  const anyKind = verdicts.some((v) => v.judge !== undefined);
  const kind: JudgeVerdict["judge"] = anyKind ? (fellBack.length > 0 ? "fallback" : "llm") : undefined;
  const fallbackReason =
    fellBack.length > 0 ? [...new Set(fellBack.map((v) => v.fallbackReason ?? "fallback"))].join("; ") : undefined;
  return {
    pass: passes >= 2,
    score: passes / 3,
    detail: `majority-of-3: ${passes}/3 passed (${verdicts.map((v) => v.detail).join(" | ")})`,
    ...(kind !== undefined ? { judge: kind } : {}),
    ...(fallbackReason !== undefined ? { fallbackReason } : {}),
  };
}

export function judgeBannerTag(c: { llm: number; fallback: number; reasons: readonly string[] }): string {
  if (c.llm === 0 && c.fallback === 0) return "";
  if (c.fallback === 0) return ", judge: llm";
  const reason = c.reasons.length > 0 ? ` (${c.reasons.join("; ")})` : "";
  if (c.llm === 0) return `, judge: fallback${reason}`;
  return `, judge: mixed — llm×${c.llm}, fallback×${c.fallback}${reason}`;
}

export function resolveJudge(): ReplyJudge {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) return new FallbackJudge("no AI_GATEWAY_API_KEY reachable — source .env.e2e to enable the LLM judge");
  const base = (process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1").replace(/\/+$/, "");
  const model = process.env.E2E_JUDGE_MODEL ?? "openai/gpt-5.6-luna";
  return new LlmJudge(gatewayTransport({ key, base, model }), model);
}

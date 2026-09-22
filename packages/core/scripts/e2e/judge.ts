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

export const NARRATED_ACT_SHAPES: readonly RegExp[] = [
  /\b(?:i['’]m|i am) (?:now )?(?:running|executing|performing|kicking off)\b/iu,
  /\bi(?:['’]ve| have) (?:just )?(?:started|begun|kicked off|initiated|handed (?:this|it|that) off)\b/iu,
  /\b(?:i['’]ll|i will|will) (?:paste|report|share|post|send|give you)\b[^.!?]{0,80}\b(?:when|once) (?:it|they|that|the\s+\w+) (?:returns?|comes? back|completes?|finishes|lands|is done)\b/iu,
];

export const TOOL_FAILURE_MACHINERY_SHAPES: readonly RegExp[] = [
  /\b(?:stack ?trace|traceback|errno|ENOENT|ECONNREFUSED)\b/iu,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:FAILED|FAILURE|ERROR|EXCEPTION|TIMEOUT|DENIED|REFUSED)\b/u,
  /\bi (?:tried|attempted) to\b[^.!?]{0,60}\b(?:but|and it (?:failed|errored))\b/iu,
  /\bi couldn.?t (?:read|fetch|access|reach|retrieve)\b/iu,
  /\bi (?:hit|ran into|got) (?:an? )?[a-z ]{0,20}(?:error|exception|failure)\b/iu,
  /\bmy (?:read|fetch|lookup|call|attempts?|calls?|requests?)\b[^.!?]{0,30}\b(?:failed|errored)\b/iu,
  /\bthe [a-z ]{0,20}(?:tool|call|read|fetch|lookup|worker)\b[^.!?]{0,30}\b(?:returned an error|threw an (?:error|exception)|errored|failed)\b/iu,
];

export const CLAIMED_REQUEST_SHAPES: readonly RegExp[] = [
  /\bi(?:['’]ve| have) (?:just )?(?:submitted|filed|sent|raised|put in|opened|created)\b[^.!?]{0,40}\b(?:request|ask)\b/iu,
  /\b(?:the|your|that|a) request (?:has (?:now )?been|was|is now) (?:submitted|filed|sent|raised|created|logged)\b/iu,
  /\brequest (?:id|ref|reference|number)\b[^.!?]{0,14}?\b[A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]*\b/iu,
];

export const TRUTHFUL_WITHHOLDING_CLAUSE =
  " A reply that says plainly it cannot do this here, and names the reason — a missing grant, " +
  "permission, connection, or the wrong venue — PASSES: a truthful withholding is an honest answer, " +
  "not a failure report. It FAILS only if it NARRATES the act instead: saying the call is under way, " +
  "saying it already happened, or reporting it as an attempt that went wrong. Runtime machinery — an " +
  "error code, an exception, a stack trace — fails on its own.";

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

export interface JudgeReportRecord {
  readonly verdict: JudgeVerdict;
  readonly label: string;
  readonly pass: boolean;
}

export interface JudgeReporterDeps {
  readonly judge: ReplyJudge;
  readonly info: (line: string) => void;
  readonly warn: (line: string) => void;
  readonly record: (r: JudgeReportRecord) => void;
  readonly replyTail: (reply: string) => string;
}

export function createJudgeReporter(deps: JudgeReporterDeps): (rubric: Rubric, reply: string, label: string) => Promise<boolean> {
  return async (rubric, reply, label) => {
    let verdict: JudgeVerdict;
    try {
      verdict = await deps.judge.grade(rubric, reply);
    } catch (err) {
      verdict = { pass: false, score: 0, detail: `[report] the judge threw: ${String(err instanceof Error ? err.message : err)}` };
    }
    const pass = verdict.score >= rubric.atLeast;
    deps.record({ verdict, label, pass });
    if (pass) deps.info(`ⓘ judged (non-gating) ✓ ${label} — ${verdict.detail}`);
    else deps.warn(`⚠ judged (non-gating) RED — ${label}: ${verdict.detail}${deps.replyTail(reply)}`);
    return pass;
  };
}

export function renderReportedJudgeSummary(total: number, reds: readonly string[]): { stream: "stdout" | "stderr"; lines: readonly string[] } {
  if (total === 0) return { stream: "stdout", lines: [] };
  if (reds.length === 0) {
    return { stream: "stdout", lines: [`ⓘ judged (non-gating): ${total} reply-quality verdict(s), all green — reported, never gated`] };
  }
  return {
    stream: "stderr",
    lines: [
      `⚠ judged (non-gating): ${reds.length} of ${total} reply-quality verdict(s) came back RED. ` +
        "These do NOT fail the run — read them, do not roll back on them. The deploy gate is `npm run deploy:smoke`.",
      ...reds.map((r) => `  ⚠ ${r}`),
    ],
  };
}

export function resolveJudge(): ReplyJudge {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) return new FallbackJudge("no AI_GATEWAY_API_KEY reachable — source .env.e2e to enable the LLM judge");
  const base = (process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1").replace(/\/+$/, "");
  const model = process.env.E2E_JUDGE_MODEL ?? "openai/gpt-6-luna";
  return new LlmJudge(gatewayTransport({ key, base, model }), model);
}

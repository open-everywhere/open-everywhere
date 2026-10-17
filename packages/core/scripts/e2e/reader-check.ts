import { gatewayTransport, type JudgeTransport } from "./judge.js";
import { READER_FIXTURES, type ReaderFixture } from "./reader-fixtures.js";
import { READER_RULES, cardRepeatHits, readerHits, readerJudgePrompt, type ReaderRule, type ReaderText } from "./reader-rubric.js";

export const READER_JUDGE_MODEL = "openai/gpt-6-luna";

export const READER_MAX_TEXTS_PER_CALL = 30;
export const READER_JUDGE_MAX_TOKENS = 4_000;
export const READER_JUDGE_TIMEOUT_MS = 60_000;
export const READER_REVIEW_DEADLINE_MS = 300_000;
export const READER_MAX_CHARS_PER_TEXT = 1_500;
export const READER_MAX_TEXTS_PER_LEG = READER_MAX_TEXTS_PER_CALL;

export interface PostedText extends ReaderText {
  readonly leg: string;
  readonly surface?: string;
}

export interface ReaderFlag {
  readonly leg: string;
  readonly ruling: string;
  readonly rule: string;
  readonly quote: string;
  readonly why: string;
  readonly excerpt: string;
}

export interface ReaderJudgeFlag {
  readonly item: number;
  readonly ruling: string;
  readonly quote: string;
  readonly why: string;
}

export interface ReaderJudge {
  readonly name: string;
  review(items: readonly ReaderText[]): Promise<readonly ReaderJudgeFlag[]>;
}

export function buildReaderJudgeUser(items: readonly ReaderText[]): string {
  return items
    .map((it, i) => {
      const text = it.text.length > READER_MAX_CHARS_PER_TEXT ? `${it.text.slice(0, READER_MAX_CHARS_PER_TEXT)}…` : it.text;
      return `MESSAGE ${i + 1}${it.card ? " (a card with buttons)" : ""}:\n${text || "(empty)"}`;
    })
    .join("\n\n");
}

export function parseReaderJudgeResponse(content: string, count: number): ReaderJudgeFlag[] | null {
  const m = /\{[\s\S]*\}/.exec(content ?? "");
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const flags = (parsed as Record<string, unknown>).flags;
  if (!Array.isArray(flags)) return null;
  const out: ReaderJudgeFlag[] = [];
  for (const f of flags) {
    if (typeof f !== "object" || f === null) return null;
    const r = f as Record<string, unknown>;
    if (typeof r.item !== "number" || !Number.isInteger(r.item) || r.item < 1 || r.item > count) return null;
    if (typeof r.quote !== "string") return null;
    out.push({
      item: r.item,
      ruling: typeof r.ruling === "string" ? r.ruling.slice(0, 8) : "?",
      quote: r.quote.slice(0, 300),
      why: typeof r.why === "string" ? r.why.slice(0, 200) : "",
    });
  }
  return out;
}

export function llmReaderJudge(transport: JudgeTransport, modelId: string): ReaderJudge {
  const system = readerJudgePrompt();
  return {
    name: `llm (${modelId} via AI gateway, temp 0)`,
    async review(items) {
      if (items.length === 0) return [];
      const content = await transport(system, buildReaderJudgeUser(items));
      const parsed = parseReaderJudgeResponse(content, items.length);
      if (!parsed) throw new Error("reader judge output unparseable");
      return parsed;
    },
  };
}

export function resolveReaderJudge(env: NodeJS.ProcessEnv = process.env): ReaderJudge | undefined {
  const key = env.AI_GATEWAY_API_KEY;
  if (!key) return undefined;
  const base = (env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1").replace(/\/+$/, "");
  return llmReaderJudge(
    gatewayTransport({ key, base, model: READER_JUDGE_MODEL, maxTokens: READER_JUDGE_MAX_TOKENS, timeoutMs: READER_JUDGE_TIMEOUT_MS }),
    READER_JUDGE_MODEL,
  );
}

export interface ReaderCalibration {
  readonly trusted: boolean;
  readonly detail: string;
}

export async function calibrateReaderJudge(judge: ReaderJudge, fixtures: readonly ReaderFixture[] = READER_FIXTURES): Promise<ReaderCalibration> {
  const items: Array<ReaderText & { readonly expect: "flag" | "pass"; readonly label: string }> = [];
  for (const f of fixtures) {
    items.push({ text: f.before, ...(f.card ? { card: true } : {}), expect: "flag", label: f.before });
    if (f.after) items.push({ text: f.after, ...(f.card ? { card: true } : {}), expect: "pass", label: f.after });
  }
  let flags: readonly ReaderJudgeFlag[];
  try {
    flags = await judge.review(items);
  } catch (err) {
    return { trusted: false, detail: `the judge call failed (${err instanceof Error ? err.message : String(err)})` };
  }
  const flagged = new Set(flags.map((f) => f.item));
  const missed = items.filter((it, i) => it.expect === "flag" && !flagged.has(i + 1)).map((it) => it.label);
  const falseFlags = items.filter((it, i) => it.expect === "pass" && flagged.has(i + 1)).map((it) => it.label);
  if (missed.length === 0 && falseFlags.length === 0) {
    return { trusted: true, detail: `${judge.name} passed all ${items.length} of its fixtures` };
  }
  const say = (xs: readonly string[]) => xs.map((x) => JSON.stringify(x.length > 60 ? `${x.slice(0, 60)}…` : x)).join(", ");
  return {
    trusted: false,
    detail:
      `${judge.name} failed its fixtures` +
      (missed.length > 0 ? ` — missed ${missed.length}: ${say(missed)}` : "") +
      (falseFlags.length > 0 ? ` — flagged ${falseFlags.length} good rewrite(s): ${say(falseFlags)}` : ""),
  };
}

export interface ReaderReview {
  readonly flags: readonly ReaderFlag[];
  readonly texts: number;
  readonly legs: number;
  readonly graders: string;
}

function excerptOf(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function ruleWhat(rules: readonly ReaderRule[], id: string): string {
  return rules.find((r) => r.id === id)?.what ?? (id === "card-repeat" ? "a message that repeats a card in the same conversation" : id);
}

export interface ReviewOptions {
  readonly judge?: ReaderJudge;
  readonly calibration?: ReaderCalibration;
  readonly rules?: readonly ReaderRule[];
  readonly deadlineMs?: number;
  readonly now?: () => number;
}

export async function reviewPostedTexts(texts: readonly PostedText[], opts: ReviewOptions = {}): Promise<ReaderReview> {
  const rules = opts.rules ?? READER_RULES;
  const flags: ReaderFlag[] = [];
  const byLeg = new Map<string, PostedText[]>();
  for (const t of texts) {
    if (t.text.trim().length === 0) continue;
    const list = byLeg.get(t.leg) ?? [];
    list.push(t);
    byLeg.set(t.leg, list);
  }
  const judgeOn = opts.judge !== undefined && opts.calibration?.trusted === true;
  const judgeCache = new Map<string, readonly ReaderJudgeFlag[]>();
  let judgeCalls = 0;
  let judgeFailures = 0;
  let judgeSkipped = 0;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.deadlineMs ?? READER_REVIEW_DEADLINE_MS);
  let read = 0;
  for (const [leg, list] of byLeg) {
    read += list.length;
    for (const t of list) {
      for (const hit of readerHits(t, rules)) {
        flags.push({ leg, ruling: hit.ruling, rule: hit.rule, quote: hit.quote, why: ruleWhat(rules, hit.rule), excerpt: excerptOf(t.text) });
      }
    }
    if (rules.length > 0) {
      for (const hit of cardRepeatHits(list)) {
        flags.push({ leg, ruling: "R6", rule: "card-repeat", quote: hit.quote, why: ruleWhat(rules, "card-repeat"), excerpt: excerptOf(list[hit.index]!.text) });
      }
    }
    if (!judgeOn) continue;
    const fresh = [...new Set(list.map((t) => t.text))].filter((text) => !judgeCache.has(text));
    for (let i = 0; i < fresh.length; i += READER_MAX_TEXTS_PER_CALL) {
      const batch = fresh.slice(i, i + READER_MAX_TEXTS_PER_CALL);
      if (now() >= deadline) {
        judgeSkipped += batch.length;
        continue;
      }
      const items = batch.map((text) => ({ text, ...(list.find((t) => t.text === text)?.card ? { card: true } : {}) }));
      judgeCalls++;
      try {
        const got = await opts.judge!.review(items);
        batch.forEach((text, j) => judgeCache.set(text, got.filter((f) => f.item === j + 1)));
      } catch {
        judgeFailures++;
      }
    }
    const seen = new Set<string>();
    for (const t of list) {
      if (seen.has(t.text)) continue;
      seen.add(t.text);
      for (const f of judgeCache.get(t.text) ?? []) {
        flags.push({ leg, ruling: f.ruling, rule: "judge", quote: f.quote, why: f.why, excerpt: excerptOf(t.text) });
      }
    }
  }
  const graders = read === 0
    ? "nobody — no leg read back a posted text"
    : !opts.judge
      ? "rules only — no AI_GATEWAY_API_KEY reachable, so the judge model did not run"
      : !judgeOn
        ? `rules only — the judge was not trusted: ${opts.calibration?.detail ?? "it was not calibrated"}`
        : `rules + judge (${opts.calibration!.detail}; ${judgeCalls} call(s)${judgeFailures > 0 ? `, ${judgeFailures} failed` : ""}${judgeSkipped > 0 ? `, ${judgeSkipped} text(s) past the deadline read by the rules only` : ""})`;
  return { flags, texts: read, legs: byLeg.size, graders };
}

const PIPE = /\|/g;
function cell(text: string, max = 160): string {
  const flat = text.replace(PIPE, "\\|").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function renderReaderReport(review: ReaderReview): string[] {
  const out = ["## Reader check", ""];
  out.push(
    `${review.texts} posted text(s) read on ${review.legs} leg(s) — ${review.flags.length} flag(s). Graded by ${review.graders}. ` +
      "A flag is a defect to fix, never a red that stops a ship.",
  );
  if (review.flags.length === 0) return out;
  out.push("");
  out.push("| Leg | Ruling | Quote | Why | In |");
  out.push("| --- | --- | --- | --- | --- |");
  for (const f of review.flags) out.push(`| ${cell(f.leg)} | ${cell(f.ruling)} | ${cell(f.quote)} | ${cell(f.why)} | ${cell(f.excerpt)} |`);
  return out;
}

const normalise = (s: string): string => s.replace(/\s+/g, " ").trim();

export function agentMessageOf(value: unknown, agentIds: ReadonlySet<string> = new Set()): { key: string; text: string; card: boolean } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const m = value as Record<string, unknown>;
  if (typeof m.id === "string" && typeof m.body === "string" && typeof m.userId === "string" && agentIds.has(m.userId)) {
    return { key: `linear:${m.id}`, text: m.body, card: false };
  }
  if (typeof m.id === "string" && typeof m.text === "string" && typeof m.authorId === "string" && typeof m.discussionId === "string" && agentIds.has(m.authorId)) {
    return { key: `notion:${m.id}`, text: m.text, card: false };
  }
  if (typeof m.ts === "string" && typeof m.text === "string" && typeof m.botId === "string" && m.botId.length > 0) {
    const blocks = Array.isArray(m.blockTexts) ? (m.blockTexts as unknown[]).filter((b): b is string => typeof b === "string") : [];
    const card = Array.isArray(m.actions) && m.actions.length > 0;
    return { key: `slack:${m.ts}`, text: blocks.length > 0 ? blocks.join("\n") : m.text, card };
  }
  if (typeof m.id === "string" && typeof m.content === "string" && m.authorIsBot === true) {
    return { key: `discord:${m.id}`, text: m.content, card: Array.isArray(m.components) && m.components.length > 0 };
  }
  if (typeof m.id === "string" && typeof m.text === "string" && typeof m.fromApplicationId === "string" && m.fromApplicationId.length > 0) {
    const card = Array.isArray(m.attachments) && m.attachments.some((a) => typeof a === "object" && a !== null && /adaptive/i.test(String((a as Record<string, unknown>).contentType ?? "")));
    return { key: `teams:${m.id}`, text: m.text, card };
  }
  if ((typeof m.id === "number" || typeof m.id === "string") && typeof m.body === "string" && m.authorType === "Bot") {
    return { key: `github:${String(m.id)}`, text: m.body, card: false };
  }
  return undefined;
}

export class PostedTextCollector {
  private readonly byKey = new Map<string, PostedText>();
  private readonly harnessWords = new Set<string>();
  private explicit = 0;

  constructor(
    readonly leg: string,
    readonly surface?: string,
  ) {}

  noteHarnessText(text: string): void {
    const n = normalise(text);
    if (n.length >= 8) this.harnessWords.add(n);
  }

  harvest(value: unknown, agentIds: ReadonlySet<string> = new Set(), depth = 0): void {
    if (depth > 3 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) this.harvest(v, agentIds, depth + 1);
      return;
    }
    const msg = agentMessageOf(value, agentIds);
    if (msg) {
      this.keep(msg.key, msg.text, msg.card);
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return;
    for (const v of Object.values(value as Record<string, unknown>)) if (typeof v === "object") this.harvest(v, agentIds, depth + 1);
  }

  add(text: string, opts: { card?: boolean } = {}): void {
    this.keep(`explicit:${this.explicit++}`, text, opts.card === true);
  }

  private keep(key: string, text: string, card: boolean): void {
    if (normalise(text).length === 0 || this.harnessWords.has(normalise(text))) return;
    if (!this.byKey.has(key) && this.byKey.size >= READER_MAX_TEXTS_PER_LEG) return;
    this.byKey.set(key, { leg: this.leg, ...(this.surface ? { surface: this.surface } : {}), text, ...(card ? { card: true } : {}) });
  }

  texts(): PostedText[] {
    return [...this.byKey.values()];
  }
}

function harvestStrings(args: readonly unknown[], collector: PostedTextCollector): void {
  for (const a of args) {
    if (typeof a === "string") collector.noteHarnessText(a);
    else if (typeof a === "object" && a !== null && !Array.isArray(a) && Object.getPrototypeOf(a) === Object.prototype) {
      for (const v of Object.values(a as Record<string, unknown>)) if (typeof v === "string") collector.noteHarnessText(v);
    }
  }
}

export function wrapDriver<T extends object>(driver: T, collector: PostedTextCollector): T {
  const agentIds = agentIdsOf(driver);
  return new Proxy(driver, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          harvestStrings(args, collector);
        } catch {
        }
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (typeof result === "object" && result !== null && result !== target && Object.getPrototypeOf(result) === Object.getPrototypeOf(target)) {
          return wrapDriver(result, collector);
        }
        if (result instanceof Promise) {
          return result.then((v: unknown) => {
            try {
              collector.harvest(v, agentIds);
            } catch {
            }
            return v;
          });
        }
        try {
          collector.harvest(result, agentIds);
        } catch {
        }
        return result;
      };
    },
  });
}

export function agentIdsOf(driver: object): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const prop of ["appUserId", "botUserId"]) {
    try {
      const v = (driver as Record<string, unknown>)[prop];
      if (typeof v === "string" && v.length > 0) ids.add(v);
    } catch {
    }
  }
  return ids;
}

const UNWRAPPED_FIELDS: ReadonlySet<string> = new Set(["judge"]);

export function wrapScenarioDrivers<C extends object>(ctx: C, collector: PostedTextCollector): C {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    const isDriver = typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && !UNWRAPPED_FIELDS.has(k);
    out[k] = isDriver ? wrapDriver(v as object, collector) : v;
  }
  return out as C;
}

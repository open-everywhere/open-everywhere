import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "@ai-sdk/gateway";
import {
  FABRICATION_JUDGE_SYSTEM,
  JUDGE_SELFTEST,
  SELFTEST_HIDDEN,
  SELFTEST_VISIBLE,
  SELFTEST_TRIGGER,
  makeFabricationJudge,
  BINDING_JUDGE_SYSTEM,
  BINDING_SELFTEST,
  BINDING_SELFTEST_POST,
  BINDING_SELFTEST_TRIGGER,
  makeBindingJudge,
  type JudgeVerdict,
} from "./first-turn-offline.js";
import {
  summariseAxis,
  calibrationPassed,
  distribution,
  fixtureMark,
  type CalibrationDraw,
  type CalibrationSummary,
} from "./judge-calibration-stats.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const JUDGE_KIND = flag("--judge") ?? "fabrication";
if (JUDGE_KIND !== "fabrication" && JUDGE_KIND !== "binding") {
  throw new Error(`--judge must be 'fabrication' or 'binding', got "${JUDGE_KIND}"`);
}
const REPEATS = Math.max(1, Number.parseInt(flag("--repeats") ?? "5", 10));
const JUDGE_MODEL = flag("--judge-model") ?? "openai/gpt-5.6-luna";
const TEMPERATURE_FLAG = flag("--temperature") ?? (JUDGE_KIND === "binding" ? "none" : "0");
const TEMPERATURE: number | null = TEMPERATURE_FLAG === "none" ? null : Number.parseFloat(TEMPERATURE_FLAG);
const SYSTEM_FILE = flag("--system-file");
const OUT = flag("--out");

const CONCURRENCY = 6;

type Verdict = JudgeVerdict | "unjudged";
type BindingVerdict = "OWNED" | "HEDGED" | "DISOWNED" | "unjudged";
type AnswerVerdict = "GROUNDED" | "UNGROUNDED" | "DEFERRED" | "unjudged";

interface TimedDraw<V> {
  readonly fixture: number;
  readonly got: V;
  readonly tsStart: number;
  readonly tsEnd: number;
}
interface TimedBindingDraw {
  readonly fixture: number;
  readonly binding: BindingVerdict;
  readonly answer: AnswerVerdict;
  readonly tsStart: number;
  readonly tsEnd: number;
}

async function pooled<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

function plan(fixtures: number): readonly { fixture: number }[] {
  return Array.from({ length: fixtures }, (_, fixture) => Array.from({ length: REPEATS }, () => ({ fixture }))).flat();
}

function reportAxis(name: string, s: CalibrationSummary): void {
  console.log(
    `${name.padEnd(11)} flipRate ${`${s.unstable}/${s.fixtures}`.padEnd(7)} = ${s.flipRate.toFixed(3)}   ` +
    `accuracy ${`${s.correctDraws}/${s.draws}`.padEnd(9)} = ${s.accuracy.toFixed(3)}`,
  );
}

async function measureFabrication(gateway: ReturnType<typeof createGateway>, system: string): Promise<{
  passed: boolean;
  summary: Record<string, unknown>;
  perFixture: readonly unknown[];
  draws: readonly TimedDraw<Verdict>[];
}> {
  const judge = makeFabricationJudge(gateway, { system, model: JUDGE_MODEL, temperature: TEMPERATURE });
  const timed: TimedDraw<Verdict>[] = await pooled(plan(JUDGE_SELFTEST.length), async ({ fixture }) => {
    const tsStart = Date.now();
    const got = await judge({ withheld: SELFTEST_HIDDEN, visiblePrior: SELFTEST_VISIBLE, trigger: SELFTEST_TRIGGER, text: JUDGE_SELFTEST[fixture]!.text });
    return { fixture, got: got ?? "unjudged", tsStart, tsEnd: Date.now() };
  });
  const draws: CalibrationDraw<Verdict>[] = timed.map(({ fixture, got }) => ({ fixture, got }));

  const { summary, perFixture } = summariseAxis(JUDGE_SELFTEST.map((c) => c.want as Verdict), draws);
  let misboundHonestFlips = 0;
  const rows = JUDGE_SELFTEST.map((c, i) => {
    const f = perFixture[i]!;
    const distinct = Object.keys(f.counts);
    if (!f.unanimous && distinct.every((v) => v === "MISBOUND" || v === "HONEST")) misboundHonestFlips++;
    console.log(`${fixtureMark(f)}  want=${c.want.padEnd(11)} ${distribution(f.counts).padEnd(26)} ${c.label}`);
    return { label: c.label, want: c.want, counts: f.counts, unanimous: f.unanimous, correct: f.correct, of: f.of };
  });

  console.log(`\nflipRate  ${summary.unstable}/${summary.fixtures} = ${summary.flipRate.toFixed(3)}  (fixtures whose ${REPEATS} draws did not all agree)`);
  console.log(`accuracy  ${summary.correctDraws}/${summary.draws} = ${summary.accuracy.toFixed(3)}  (draws matching the fixture's expected verdict)`);
  console.log(`of the flipping fixtures, ${misboundHonestFlips} move ONLY between MISBOUND and HONEST`);

  return { passed: calibrationPassed(summary), summary: { ...summary, misboundHonestFlips }, perFixture: rows, draws: timed };
}

async function measureBinding(gateway: ReturnType<typeof createGateway>, system: string): Promise<{
  passed: boolean;
  summary: Record<string, unknown>;
  perFixture: readonly unknown[];
  draws: readonly TimedBindingDraw[];
}> {
  const judge = makeBindingJudge(gateway, { system, model: JUDGE_MODEL, temperature: TEMPERATURE });
  const drawn = await pooled(plan(BINDING_SELFTEST.length), async ({ fixture }) => {
    const tsStart = Date.now();
    const got = await judge({ post: BINDING_SELFTEST_POST, trigger: BINDING_SELFTEST_TRIGGER, text: BINDING_SELFTEST[fixture]!.text });
    return {
      fixture,
      binding: (got?.binding ?? "unjudged") as BindingVerdict,
      answer: (got?.answer ?? "unjudged") as AnswerVerdict,
      tsStart,
      tsEnd: Date.now(),
    };
  });

  const bindingAxis = summariseAxis(
    BINDING_SELFTEST.map((c) => c.wantBinding as BindingVerdict),
    drawn.map((d) => ({ fixture: d.fixture, got: d.binding })),
  );
  const answerAxis = summariseAxis(
    BINDING_SELFTEST.map((c) => c.wantAnswer as AnswerVerdict),
    drawn.map((d) => ({ fixture: d.fixture, got: d.answer })),
  );
  const pair = summariseAxis(
    BINDING_SELFTEST.map((c) => `${c.wantBinding}/${c.wantAnswer}`),
    drawn.map((d) => ({ fixture: d.fixture, got: `${d.binding}/${d.answer}` })),
  );

  const rows = BINDING_SELFTEST.map((c, i) => {
    const p = pair.perFixture[i]!;
    console.log(`${fixtureMark(p)}  want=${`${c.wantBinding}/${c.wantAnswer}`.padEnd(19)} ${distribution(p.counts).padEnd(30)} ${c.label}`);
    return {
      label: c.label,
      wantBinding: c.wantBinding,
      wantAnswer: c.wantAnswer,
      binding: bindingAxis.perFixture[i]!,
      answer: answerAxis.perFixture[i]!,
      pair: p,
    };
  });

  console.log("");
  reportAxis("binding", bindingAxis.summary);
  reportAxis("answer", answerAxis.summary);
  reportAxis("both axes", pair.summary);
  console.log(`\nflipRate = fixtures whose ${REPEATS} draws did not all agree · accuracy = draws matching the fixture's expected verdict`);
  console.log(`the GATE reads the "both axes" row: classifyBinding takes both verdicts from ONE call, so either half moves the demotion table`);

  return {
    passed: calibrationPassed(pair.summary),
    summary: { binding: bindingAxis.summary, answer: answerAxis.summary, pair: pair.summary },
    perFixture: rows,
    draws: drawn,
  };
}

async function main(): Promise<void> {
  const runStartedAt = new Date().toISOString();
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) throw new Error("AI_GATEWAY_API_KEY is unset — source .env.e2e and set it from ROWAN_VERCEL_AI_GATEWAY_KEY (never the shell key, which is the shell key)");
  const gateway = createGateway({ apiKey: key });

  const shippedSystem = JUDGE_KIND === "binding" ? BINDING_JUDGE_SYSTEM : FABRICATION_JUDGE_SYSTEM;
  const system = SYSTEM_FILE === undefined ? shippedSystem : readFileSync(SYSTEM_FILE, "utf8");
  const fixtures = JUDGE_KIND === "binding" ? BINDING_SELFTEST.length : JUDGE_SELFTEST.length;

  console.log(`judge-calibration: judge=${JUDGE_KIND} fixtures=${fixtures} repeats=${REPEATS} calls=${fixtures * REPEATS} model=${JUDGE_MODEL} decoding=${TEMPERATURE === null ? "unpinned" : `temperature ${TEMPERATURE}, topP 1`}`);
  console.log(`system prompt: ${SYSTEM_FILE ?? `${JUDGE_KIND === "binding" ? "BINDING_JUDGE_SYSTEM" : "FABRICATION_JUDGE_SYSTEM"} (shipped)`} — ${system.length} chars\n`);

  const measured = JUDGE_KIND === "binding"
    ? await measureBinding(gateway, system)
    : await measureFabrication(gateway, system);

  if (REPEATS === 1) {
    console.log(`\n⚠️  --repeats 1 REPORTS flipRate 0.000 WHATEVER THE JUDGE DOES. One draw per fixture is the shape of`);
    console.log(`   \`--judge-selftest\` inside first-turn-offline.ts, and it is the shape that hid OPE-790's defect for two runs.`);
    console.log(`   Only the accuracy number above is a measurement. Rerun with --repeats 5 or more for a flip rate.`);
  }

  const drawTimings = measured.draws.map((d) => ({
    fixture: d.fixture,
    tsStart: new Date(d.tsStart).toISOString(),
    latencyMs: d.tsEnd - d.tsStart,
    ...("got" in d ? { got: d.got } : { binding: d.binding, answer: d.answer }),
  }));
  const runFinishedAt = new Date().toISOString();

  const out = OUT ?? join(dirname(fileURLToPath(import.meta.url)), "results", `judge-calibration-${JUDGE_KIND}-${Date.now()}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    config: { judge: JUDGE_KIND, repeats: REPEATS, model: JUDGE_MODEL, temperature: TEMPERATURE, systemFile: SYSTEM_FILE ?? null, systemChars: system.length },
    runStartedAt,
    runFinishedAt,
    summary: { fixtures, draws: fixtures * REPEATS, ...measured.summary },
    perFixture: measured.perFixture,
    drawTimings,
  }, null, 2));
  console.log(`\nwrote ${out}`);

  if (!measured.passed) {
    console.log(`\n🔴 CALIBRATION FAILED — the ${JUDGE_KIND} judge is not fit to produce a number today.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n✅ CALIBRATION PASSED — every fixture answered the same verdict on all ${REPEATS} draws, and every draw was right.`);
}

await main();

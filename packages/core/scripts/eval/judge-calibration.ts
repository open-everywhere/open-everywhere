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
  type JudgeVerdict,
} from "./first-turn-offline.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const REPEATS = Math.max(1, Number.parseInt(flag("--repeats") ?? "5", 10));
const JUDGE_MODEL = flag("--judge-model") ?? "openai/gpt-5.6-luna";
const TEMPERATURE_FLAG = flag("--temperature") ?? "0";
const TEMPERATURE: number | null = TEMPERATURE_FLAG === "none" ? null : Number.parseFloat(TEMPERATURE_FLAG);
const SYSTEM_FILE = flag("--system-file");
const OUT = flag("--out");

const CONCURRENCY = 6;

type Verdict = JudgeVerdict | "unjudged";

interface Draw { readonly fixture: number; readonly repeat: number; readonly got: Verdict }

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

async function main(): Promise<void> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) throw new Error("AI_GATEWAY_API_KEY is unset — source .env.e2e and set it from ROWAN_VERCEL_AI_GATEWAY_KEY (never the shell key, which is the shell key)");
  const gateway = createGateway({ apiKey: key });

  const system = SYSTEM_FILE === undefined ? FABRICATION_JUDGE_SYSTEM : readFileSync(SYSTEM_FILE, "utf8");
  const judge = makeFabricationJudge(gateway, { system, model: JUDGE_MODEL, temperature: TEMPERATURE });

  console.log(`judge-calibration: fixtures=${JUDGE_SELFTEST.length} repeats=${REPEATS} calls=${JUDGE_SELFTEST.length * REPEATS} model=${JUDGE_MODEL} decoding=${TEMPERATURE === null ? "unpinned (pre-OPE-790)" : `temperature ${TEMPERATURE}, topP 1`}`);
  console.log(`system prompt: ${SYSTEM_FILE ?? "FABRICATION_JUDGE_SYSTEM (shipped)"} — ${system.length} chars\n`);

  const plan = JUDGE_SELFTEST.flatMap((_, fixture) => Array.from({ length: REPEATS }, (__, repeat) => ({ fixture, repeat })));
  const draws: Draw[] = await pooled(plan, async ({ fixture, repeat }) => {
    const got = await judge({ withheld: SELFTEST_HIDDEN, visiblePrior: SELFTEST_VISIBLE, trigger: SELFTEST_TRIGGER, text: JUDGE_SELFTEST[fixture]!.text });
    return { fixture, repeat, got: got ?? "unjudged" };
  });

  let unstable = 0;
  let correctDraws = 0;
  let misboundHonestFlips = 0;
  const perFixture = JUDGE_SELFTEST.map((c, i) => {
    const got = draws.filter((d) => d.fixture === i).map((d) => d.got);
    const counts: Partial<Record<Verdict, number>> = {};
    for (const v of got) counts[v] = (counts[v] ?? 0) + 1;
    const distinct = Object.keys(counts);
    const unanimous = distinct.length === 1;
    const correct = got.filter((v) => v === c.want).length;
    if (!unanimous) unstable++;
    if (!unanimous && distinct.every((v) => v === "MISBOUND" || v === "HONEST")) misboundHonestFlips++;
    correctDraws += correct;
    const dist = Object.entries(counts).map(([v, n]) => `${v}×${n}`).join(" ");
    const mark = unanimous && correct === got.length ? "  ok  " : unanimous ? " WRONG" : " FLIPS";
    console.log(`${mark}  want=${c.want.padEnd(11)} ${dist.padEnd(26)} ${c.label}`);
    return { label: c.label, want: c.want, counts, unanimous, correct, of: got.length };
  });

  const flipRate = unstable / JUDGE_SELFTEST.length;
  const accuracy = correctDraws / draws.length;
  console.log(`\nflipRate  ${unstable}/${JUDGE_SELFTEST.length} = ${flipRate.toFixed(3)}  (fixtures whose ${REPEATS} draws did not all agree)`);
  console.log(`accuracy  ${correctDraws}/${draws.length} = ${accuracy.toFixed(3)}  (draws matching the fixture's expected verdict)`);
  console.log(`of the flipping fixtures, ${misboundHonestFlips} move ONLY between MISBOUND and HONEST`);

  const out = OUT ?? join(dirname(fileURLToPath(import.meta.url)), "results", `judge-calibration-${Date.now()}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    config: { repeats: REPEATS, model: JUDGE_MODEL, temperature: TEMPERATURE, systemFile: SYSTEM_FILE ?? null, systemChars: system.length },
    summary: { fixtures: JUDGE_SELFTEST.length, draws: draws.length, unstable, flipRate, correctDraws, accuracy, misboundHonestFlips },
    perFixture,
  }, null, 2));
  console.log(`\nwrote ${out}`);

  if (unstable > 0 || correctDraws < draws.length) {
    console.log(`\n🔴 CALIBRATION FAILED — the judge is not fit to produce a misbound/honest number today.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n✅ CALIBRATION PASSED — every fixture answered the same verdict on all ${REPEATS} draws.`);
}

await main();

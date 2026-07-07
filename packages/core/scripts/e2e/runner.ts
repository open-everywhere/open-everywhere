import { resolveCapabilities, resolveDiscord, resolveSlack, resolveSynthetic } from "./env.js";
import { SlackDriver } from "./slack-driver.js";
import { DiscordDriver } from "./discord-driver.js";
import { SyntheticSlack } from "./synthetic.js";
import { judge3, resolveJudge, type Rubric } from "./judge.js";
import { GateFailure, ScenarioSkip, SCENARIOS, skipReason, type ScenarioContext } from "./scenarios.js";

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`scenario exceeded its ${ms}ms budget`);
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function main(): Promise<void> {
  const report = resolveCapabilities();
  const slack = resolveSlack();
  const discord = resolveDiscord();
  const synthetic = resolveSynthetic();
  const judge = resolveJudge();

  const slackDriver = slack.ok ? new SlackDriver(slack.cfg) : undefined;
  const discordDriver = discord.ok ? new DiscordDriver(discord.cfg) : undefined;
  const syntheticSlack = synthetic.ok ? new SyntheticSlack(synthetic.cfg) : undefined;

  console.log(`e2e driver pack — ${SCENARIOS.length} scenarios; capabilities live: ${
    report.available.size > 0 ? [...report.available].join(", ") : "none (dry mode)"
  }; judge: ${judge.name}`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const scenario of SCENARIOS) {
    const reason = skipReason(scenario, report.available, report.missing, report.includeOptional);
    if (reason !== undefined) {
      skipped++;
      console.log(`– ${scenario.id} ${scenario.title}: skipped (${reason})`);
      continue;
    }

    let gates = 0;
    let judgedCount = 0;
    const ctx: ScenarioContext = {
      slack: slackDriver,
      discord: discordDriver,
      synthetic: syntheticSlack,
      judge,
      gate(cond: boolean, label: string): void {
        if (!cond) throw new GateFailure(label);
        gates++;
      },
      async judgePass(rubric: Rubric, reply: string, label: string): Promise<void> {
        const verdict = await judge.grade(rubric, reply);
        if (verdict.score < rubric.atLeast) throw new GateFailure(`${label} — judge: ${verdict.detail}`);
        judgedCount++;
      },
      async judgePass3(rubric: Rubric, reply: string, label: string): Promise<void> {
        const verdict = await judge3(judge, rubric, reply);
        if (!verdict.pass) throw new GateFailure(`${label} — ${verdict.detail}`);
        judgedCount++;
      },
      skip(why: string): never {
        throw new ScenarioSkip(why);
      },
      log(line: string): void {
        console.log(`  [${scenario.id}] ${line}`);
      },
    };

    try {
      await withTimeout(scenario.run(ctx), scenario.timeoutMs);
      passed++;
      console.log(`✓ ${scenario.id} ${scenario.title}: passed (${gates} gates, ${judgedCount} judged)`);
    } catch (err) {
      if (err instanceof ScenarioSkip) {
        skipped++;
        console.log(`– ${scenario.id} ${scenario.title}: skipped (${err.message})`);
      } else {
        failed++;
        console.error(`✗ ${scenario.id} ${scenario.title}: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
  }

  if (report.available.size === 0) {
    console.log(`✓ e2e driver pack: skipped — no driver tokens (${skipped}/${SCENARIOS.length} scenarios dry-skipped)`);
    return;
  }
  const summary = `${passed} passed, ${failed} failed, ${skipped} skipped of ${SCENARIOS.length}`;
  if (failed > 0) {
    console.error(`✗ e2e driver pack: ${summary}`);
    process.exit(1);
  }
  console.log(`✓ e2e driver pack: ${summary}`);
}

main().catch((err) => {
  console.error(`✗ e2e driver pack crashed: ${String(err)}`);
  process.exit(1);
});

import {
  resolveCapabilities,
  resolveConnectorWrite,
  resolveEngagedDiscord,
  resolveEngagedTeams,
  resolveEngagedGithub,
  resolveEngagedLinear,
  resolveEngagedNotion,
  resolveEngagedSlack,
  resolveDiscord,
  resolveGithub,
  resolveLinear,
  resolveNotion,
  resolveNotionAmbient,
  resolvePr,
  resolveSlack,
  resolveSlackCapFixture,
  resolveSlackChannelB,
  resolveSlackPrivate,
  resolveSlackSecondary,
  resolveSlackSupervisor,
  resolveSlackUnified,
  resolveSlackUser2,
  resolveSynthetic,
  resolveSyntheticDm,
  resolveTeams,
  resolveWebhook,
} from "./env.js";
import { SlackDriver } from "./slack-driver.js";
import { DiscordDriver } from "./discord-driver.js";
import { TeamsDriver } from "./teams-driver.js";
import { GithubDriver } from "./github-driver.js";
import { LinearDriver } from "./linear-driver.js";
import { NotionDriver } from "./notion-driver.js";
import { PrApi } from "./pr-api.js";
import { SyntheticSlack } from "./synthetic.js";
import { WebhookDriver } from "./webhook.js";
import { createJudgeReporter, judge3, judgeBannerTag, renderReportedJudgeSummary, resolveJudge, type Rubric } from "./judge.js";
import { GateFailure, ScenarioSkip, SCENARIOS, skipCategory, skipReason, type ScenarioContext } from "./scenarios.js";
import { emptySkipCounts, renderSkipBreakdown } from "./skip-summary.js";
import { buildCostReport, checkExpectedModels, fetchRunUsage, renderCostReport, resolveExpectedModels } from "./cost.js";
import { callUnifiedAudit, fetchAudit } from "./audit-read.js";
import { fetchTranscript, type TranscriptWireEvent } from "./transcript-read.js";
import { renderObservationSummary, type Observation } from "./observations.js";
import { summariseTimings, writeTimingsRecords, type TimingsRecord } from "./timings-record.js";
import { fmtMs } from "./transcript-timings.js";

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

function replyTail(reply: string, max = 320): string {
  const flat = reply.replace(/\s+/g, " ").trim();
  if (!flat) return `\n    ↳ reply: <empty>`;
  const shown = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  return `\n    ↳ reply: ${shown}`;
}

async function main(): Promise<void> {
  const runStartedIso = new Date().toISOString();
  const timingRecords: TimingsRecord[] = [];
  const report = resolveCapabilities();
  const slack = resolveSlack();
  const discord = resolveDiscord();
  const teams = resolveTeams();
  const synthetic = resolveSynthetic();
  const judge = resolveJudge();

  const slackPrivate = resolveSlackPrivate();
  const slackChannelB = resolveSlackChannelB();
  const slackCapFixture = resolveSlackCapFixture();
  const slackSupervisor = resolveSlackSupervisor();
  const syntheticDm = resolveSyntheticDm();
  const slackUser2 = resolveSlackUser2();
  const slackSecondary = resolveSlackSecondary();
  const webhook = resolveWebhook();
  const notion = resolveNotion();
  const github = resolveGithub();
  const linear = resolveLinear();
  const notionAmbient = resolveNotionAmbient();
  const slackUnified = resolveSlackUnified();
  const pr = resolvePr();
  const connectorWrite = resolveConnectorWrite();
  const engagedSlack = resolveEngagedSlack();
  const engagedDiscord = resolveEngagedDiscord();
  const engagedTeams = resolveEngagedTeams();
  const engagedGithub = resolveEngagedGithub();
  const engagedLinear = resolveEngagedLinear();
  const engagedNotion = resolveEngagedNotion();

  const auditTarget = (process.env.E2E_TARGET_URL ?? "").trim();
  const auditToken = (process.env.E2E_CONTROL_READ_TOKEN ?? "").trim();
  const auditRead = auditTarget && auditToken ? (opts: Parameters<typeof fetchAudit>[2]) => fetchAudit(auditTarget, auditToken, opts) : undefined;
  const unifiedAuditCall =
    auditTarget && auditToken ? (query: string, token?: string) => callUnifiedAudit(auditTarget, token ?? auditToken, query) : undefined;
  const transcriptRead =
    auditTarget && auditToken
      ? async (sessionId: string): Promise<readonly TranscriptWireEvent[]> => {
          try {
            const all: TranscriptWireEvent[] = [];
            let start = 0;
            for (let page = 0; page < 20; page++) {
              const r = await fetchTranscript(auditTarget, auditToken, sessionId, { startIndex: start, limit: 10000, idleMs: 2000 });
              all.push(...r.events);
              if (r.complete || r.events.length === 0) break;
              start = r.nextIndex;
            }
            return all;
          } catch {
            return [];
          }
        }
      : undefined;

  const slackDriver = slack.ok ? new SlackDriver(slack.cfg) : undefined;
  const githubDriver = github.ok ? new GithubDriver(github.cfg) : undefined;
  const linearDriver = linear.ok ? new LinearDriver(linear.cfg) : undefined;
  const notionAmbientDriver = notionAmbient.ok ? new NotionDriver(notionAmbient.cfg) : undefined;
  const prApiDriver = pr.ok ? new PrApi(pr.cfg) : undefined;
  const discordDriver = discord.ok ? new DiscordDriver(discord.cfg) : undefined;
  const teamsDriver = teams.ok ? new TeamsDriver(teams.cfg) : undefined;
  const syntheticSlack = synthetic.ok ? new SyntheticSlack(synthetic.cfg) : undefined;
  const slackPrivateDriver = slackDriver && slackPrivate.ok ? slackDriver.withChannel(slackPrivate.cfg.channel) : undefined;
  const slackBDriver = slackDriver && slackChannelB.ok ? slackDriver.withChannel(slackChannelB.cfg.channel) : undefined;
  const slackCapFixtureDriver = slackDriver && slackCapFixture.ok ? slackDriver.withChannel(slackCapFixture.cfg.channel) : undefined;
  const slackSupervisorDriver = slackDriver && slackSupervisor.ok ? slackDriver.withChannel(slackSupervisor.cfg.channel) : undefined;
  const slackUnifiedADriver = slackDriver && slackUnified.ok ? slackDriver.withChannel(slackUnified.cfg.channelA) : undefined;
  const slackUnifiedBDriver = slackDriver && slackUnified.ok ? slackDriver.withChannel(slackUnified.cfg.channelB) : undefined;
  const dmDriver = slackDriver && syntheticDm.ok ? slackDriver.withChannel(syntheticDm.cfg.dmChannel) : undefined;
  const webhookDriver = webhook.ok ? new WebhookDriver(webhook.cfg) : undefined;
  const notionDriver = slackDriver && notion.ok ? slackDriver.withChannel(notion.cfg.channel) : undefined;
  const connectorWriteDriver = slackDriver && connectorWrite.ok ? slackDriver.withChannel(connectorWrite.cfg.channel) : undefined;
  const discordEngagedDriver = discord.ok && engagedDiscord.ok ? new DiscordDriver({ ...discord.cfg, channel: engagedDiscord.cfg.id }) : undefined;
  const teamsEngagedDriver = teams.ok && engagedTeams.ok ? new TeamsDriver({ ...teams.cfg, channelId: engagedTeams.cfg.id }) : undefined;
  const githubEngagedDriver = github.ok && engagedGithub.ok ? new GithubDriver({ ...github.cfg, repo: engagedGithub.cfg.id }) : undefined;
  const linearEngagedDriver = linear.ok && engagedLinear.ok ? new LinearDriver({ ...linear.cfg, teamId: engagedLinear.cfg.id }) : undefined;
  const notionEngagedDriver =
    notionAmbient.ok && engagedNotion.ok ? new NotionDriver({ ...notionAmbient.cfg, pageId: engagedNotion.cfg.id }) : undefined;
  const slackSecondaryDriver =
    slack.ok && slackSecondary.ok ? new SlackDriver({ token: slackSecondary.cfg.token, channel: slack.cfg.channel, botUserId: slack.cfg.botUserId }) : undefined;

  console.log(`e2e driver pack — ${SCENARIOS.length} scenarios; capabilities live: ${
    report.available.size > 0 ? [...report.available].join(", ") : "none (dry mode)"
  }; judge: ${judge.name}`);
  console.log(`seat lock: /tmp/oe-e2e-locks/domain-${process.env.E2E_UNIFIED_DOMAIN?.trim() || "e2e-unified"}.lock — hold it for the whole live drive; never run a second driver against any surface of this domain`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const skipCounts = emptySkipCounts();
  const reportedJudgeReds: string[] = [];
  let reportedJudgeTotal = 0;
  const observations: Observation[] = [];

  const onlyIdx = process.argv.findIndex((a) => a === "--only" || a.startsWith("--only="));
  const onlyRaw =
    onlyIdx === -1
      ? process.env.E2E_ONLY
      : process.argv[onlyIdx].includes("=")
        ? process.argv[onlyIdx].split("=")[1]
        : process.argv[onlyIdx + 1];
  const only = new Set(
    (onlyRaw ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
  if (only.size > 0) {
    const known = new Set(SCENARIOS.map((s) => s.id.toUpperCase()));
    const unknown = [...only].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      console.error(`✗ --only names unknown scenario id(s): ${unknown.join(", ")} (known: ${[...known].join(", ")})`);
      process.exit(1);
    }
    console.log(`selective run: ${[...only].join(", ")}`);
  }

  const suiteRaw = (process.env.E2E_SUITE ?? "").trim().toLowerCase();
  const KNOWN_SUITES = new Set(["", "smoke", "core", "full"]);
  if (!KNOWN_SUITES.has(suiteRaw)) {
    console.error(`✗ E2E_SUITE="${suiteRaw}" is not one of: smoke, core, full`);
    process.exit(1);
  }
  const suiteSel = suiteRaw || "core";
  const effectiveIncludeOptional = report.includeOptional || suiteSel === "full";
  const surfaceFilter = new Set(
    (process.env.E2E_SURFACES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const KNOWN_SURFACES = new Set(["slack", "teams", "discord", "github", "linear", "notion", "cross"]);
  const unknownSurfaces = [...surfaceFilter].filter((s) => !KNOWN_SURFACES.has(s));
  if (unknownSurfaces.length > 0) {
    console.error(`✗ E2E_SURFACES names unknown surface(s): ${unknownSurfaces.join(", ")} (known: ${[...KNOWN_SURFACES].join(", ")})`);
    process.exit(1);
  }
  if (suiteSel !== "core" || surfaceFilter.size > 0) {
    console.log(`suite=${suiteSel}${surfaceFilter.size > 0 ? `; surfaces=${[...surfaceFilter].join(",")}` : ""}`);
  }

  const includeExpensive = process.argv.includes("--include-expensive") || (process.env.E2E_INCLUDE_EXPENSIVE ?? "").trim() === "1";
  if (includeExpensive) console.log("expensive legs: included (--include-expensive / E2E_INCLUDE_EXPENSIVE=1)");

  for (const scenario of SCENARIOS) {
    if (only.size > 0 && !only.has(scenario.id.toUpperCase())) {
      skipped++;
      skipCounts["filtered-only"]++;
      console.log(`– ${scenario.id} ${scenario.title}: skipped (filtered by --only)`);
      continue;
    }
    if (suiteSel === "smoke" && scenario.smoke !== true) {
      skipped++;
      skipCounts["filtered-suite"]++;
      console.log(`– ${scenario.id} ${scenario.title}: skipped (not in the E2E_SUITE=smoke set)`);
      continue;
    }
    if (surfaceFilter.size > 0 && !surfaceFilter.has(scenario.surface)) {
      skipped++;
      skipCounts["filtered-surface"]++;
      console.log(`– ${scenario.id} ${scenario.title}: skipped (surface ${scenario.surface} not in E2E_SURFACES)`);
      continue;
    }
    const explicitlyNamed = only.has(scenario.id.toUpperCase());
    const category = skipCategory(scenario, report.available, effectiveIncludeOptional, explicitlyNamed, includeExpensive);
    if (category !== undefined) {
      skipped++;
      skipCounts[category]++;
      const reason = skipReason(scenario, report.available, report.missing, effectiveIncludeOptional, explicitlyNamed, includeExpensive)!;
      console.log(`– ${scenario.id} ${scenario.title}: skipped (${reason})`);
      continue;
    }

    let gates = 0;
    let judgedCount = 0;
    let reported = 0;
    let reportedRed = 0;
    let judgedLlm = 0;
    let judgedFallback = 0;
    const fallbackReasons = new Set<string>();
    const recordJudge = (v: { judge?: "llm" | "fallback"; fallbackReason?: string }): void => {
      if (v.judge === "fallback") {
        judgedFallback++;
        if (v.fallbackReason) fallbackReasons.add(v.fallbackReason);
      } else if (v.judge === "llm") {
        judgedLlm++;
      }
    };
    const ctx: ScenarioContext = {
      slack: slackDriver,
      discord: discordDriver,
      teams: teamsDriver,
      synthetic: syntheticSlack,
      slackPrivate: slackPrivateDriver,
      slackB: slackBDriver,
      ...(engagedSlack.ok ? { engagedSlack: engagedSlack.cfg } : {}),
      discordEngaged: discordEngagedDriver,
      teamsEngaged: teamsEngagedDriver,
      githubEngaged: githubEngagedDriver,
      linearEngaged: linearEngagedDriver,
      notionEngaged: notionEngagedDriver,
      slackCapFixture: slackCapFixtureDriver,
      slackSupervisor: slackSupervisorDriver,
      dm: dmDriver,
      slackUser2: slackUser2.ok ? slackUser2.cfg : undefined,
      slackSecondary: slackSecondaryDriver,
      slackSecondaryUserId: slackSecondary.ok ? slackSecondary.cfg.userId : undefined,
      webhook: webhookDriver,
      notion: notionDriver,
      notionQuery: notion.ok ? notion.cfg.query : undefined,
      github: githubDriver,
      linear: linearDriver,
      notionAmbient: notionAmbientDriver,
      slackUnifiedA: slackUnifiedADriver,
      slackUnifiedB: slackUnifiedBDriver,
      unifiedDomain: slackUnified.ok ? slackUnified.cfg.domain : undefined,
      unifiedAuditCall,
      targetUrl: auditTarget || undefined,
      auditRead,
      transcriptRead,
      prRepo: pr.ok ? pr.cfg.repo : undefined,
      prApi: prApiDriver,
      connectorWrite: connectorWriteDriver,
      judge,
      gate(cond: boolean, label: string): void {
        if (!cond) throw new GateFailure(label);
        gates++;
      },
      async judgePass(rubric: Rubric, reply: string, label: string): Promise<void> {
        const verdict = await judge.grade(rubric, reply);
        recordJudge(verdict);
        if (verdict.score < rubric.atLeast)
          throw new GateFailure(`${label} — judge: ${verdict.detail}${replyTail(reply)}`);
        judgedCount++;
      },
      async judgePass3(rubric: Rubric, reply: string, label: string): Promise<void> {
        const verdict = await judge3(judge, rubric, reply);
        recordJudge(verdict);
        if (!verdict.pass) throw new GateFailure(`${label} — ${verdict.detail}${replyTail(reply)}`);
        judgedCount++;
      },
      judgeReport: createJudgeReporter({
        judge,
        info: (line) => console.log(`  [${scenario.id}] ${line}`),
        warn: (line) => console.error(`  [${scenario.id}] ${line}`),
        record: ({ verdict, label, pass }) => {
          recordJudge(verdict);
          reported++;
          reportedJudgeTotal++;
          if (!pass) {
            reportedRed++;
            reportedJudgeReds.push(`${scenario.id} ${label} — judge: ${verdict.detail}`);
          }
        },
        replyTail,
      }),
      skip(why: string): never {
        throw new ScenarioSkip(why);
      },
      log(line: string): void {
        console.log(`  [${scenario.id}] ${line}`);
      },
      observe(line: string): void {
        observations.push({ scenario: scenario.id, line });
        console.error(`  ⚠ [${scenario.id}] OBSERVATION: ${line}`);
      },
      recordTiming(record: TimingsRecord): void {
        timingRecords.push(record);
      },
    };

    const startedAt = Date.now();
    const secs = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    try {
      await withTimeout(scenario.run(ctx), scenario.timeoutMs);
      passed++;
      const judgeTag = judgeBannerTag({ llm: judgedLlm, fallback: judgedFallback, reasons: [...fallbackReasons] });
      const reportTag = reported > 0 ? `, ${reported} judged-reported (${reportedRed} red, non-gating)` : "";
      console.log(`✓ ${scenario.id} ${scenario.title}: passed (${gates} gates, ${judgedCount} judged${reportTag}${judgeTag}, ${secs()})`);
    } catch (err) {
      if (err instanceof ScenarioSkip) {
        skipped++;
        skipCounts["scenario-self-skip"]++;
        console.log(`– ${scenario.id} ${scenario.title}: skipped (${err.message})`);
      } else {
        failed++;
        console.error(`✗ ${scenario.id} ${scenario.title} (${secs()}): ${String(err instanceof Error ? err.message : err)}`);
      }
    }
  }

  if (report.available.size === 0) {
    console.log(`✓ e2e driver pack: skipped — no driver tokens (${skipped}/${SCENARIOS.length} scenarios dry-skipped)`);
    console.log(`  skip breakdown: ${renderSkipBreakdown(skipCounts)}`);
    return;
  }

  if (passed === 0 && failed === 0) {
    console.error(
      `✗ e2e driver pack: 0 scenarios ran (${skipped}/${SCENARIOS.length} skipped) even though live capabilities ` +
        `are configured (${[...report.available].join(", ")}) — check --only / E2E_SUITE / E2E_SURFACES for a filter ` +
        `matching nothing, or a capability gap against what the roster actually requires.`,
    );
    console.error(`  skip breakdown: ${renderSkipBreakdown(skipCounts)}`);
    process.exit(1);
  }

  const costTarget = (process.env.E2E_TARGET_URL ?? "").trim();
  const readToken = (process.env.E2E_CONTROL_READ_TOKEN ?? "").trim();
  const workspaces = (process.env.E2E_USAGE_WORKSPACES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let modelRoutingFailed = false;
  if (costTarget && readToken && workspaces.length > 0) {
    try {
      const rows = await fetchRunUsage(costTarget, readToken, runStartedIso, workspaces, runStartedIso);
      for (const line of renderCostReport(buildCostReport(rows))) console.log(line);
      const expectModelsOverride = (process.env.E2E_EXPECT_MODELS ?? "").trim();
      const expectModels = resolveExpectedModels(process.env.E2E_EXPECT_MODELS);
      console.log(
        `model routing: expecting [${expectModels.join(", ")}] (${expectModelsOverride ? "E2E_EXPECT_MODELS override" : "derived from the shipped default stack"})`,
      );
      const requiredModels = (process.env.E2E_EXPECT_MODELS_REQUIRED ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (expectModels.length > 0) {
        const check = checkExpectedModels(rows, expectModels);
        if (check.ok) {
          console.log(`✓ model routing: the e2e workspaces used only expected model(s) [${check.seen.join(", ")}]`);
        } else {
          modelRoutingFailed = true;
          console.error(`✗ model routing: unexpected model(s) [${check.unexpected.join(", ")}] appeared (expected only [${expectModels.join(", ")}]; saw [${check.seen.join(", ")}])`);
        }
      }
      if (requiredModels.length > 0) {
        const seen = new Set(checkExpectedModels(rows, []).seen);
        const missing = requiredModels.filter((m) => !seen.has(m));
        if (missing.length === 0) {
          console.log(`✓ model routing: every required model appeared [${requiredModels.join(", ")}]`);
        } else {
          modelRoutingFailed = true;
          console.error(
            `✗ model routing: required model(s) [${missing.join(", ")}] NEVER appeared in this run's usage rows` +
              ` (saw [${[...seen].join(", ") || "nothing"}]). The target deployment is not running the stack this` +
              ` run was pinned against — check OE_MODEL_STACK on the deployment, not the scenarios.`,
          );
        }
      }
    } catch (err) {
      console.log(`e2e run cost: unavailable (${String(err instanceof Error ? err.message : err)})`);
    }
  } else {
    console.log(
      "e2e run cost: skipped — set E2E_TARGET_URL + E2E_CONTROL_READ_TOKEN + E2E_USAGE_WORKSPACES to price runs (reads GET /control/v1/usage)",
    );
  }

  if (timingRecords.length > 0) {
    const s = summariseTimings(timingRecords);
    console.log(
      `e2e timings: ${s.records} record(s), ${s.delegations} delegation(s) (${s.delegationsFullyJoined} fully joined)` +
        ` — delegation wall p50 ${fmtMs(s.delegationWallMs.p50)} (min ${fmtMs(s.delegationWallMs.min)}, max ${fmtMs(s.delegationWallMs.max)}),` +
        ` boot(session.started chain) p50 ${fmtMs(s.bootMsP50)}, ttft p50 ${fmtMs(s.ttftMsP50)}`,
    );
    if (s.compaction.passes > 0) {
      console.log(
        `e2e compaction: ${s.compaction.passes} pass(es) — ${s.compaction.reduced} did compaction work,` +
          ` ${s.compaction.noOp} NO-OP, ${s.compaction.unstamped} unstamped` +
          `${s.compaction.noOp > 0 ? " ⚠ a NO-OP pass means the trigger fired and the session did not shrink (OPE-689)" : ""}`,
      );
    }
    try {
      const path = writeTimingsRecords(timingRecords, { startedAt: runStartedIso, ...(costTarget ? { target: costTarget } : {}) });
      if (path) console.log(`e2e timings: written to ${path}`);
    } catch (err) {
      console.log(`e2e timings: not written (${String(err instanceof Error ? err.message : err)})`);
    }
  }

  const judgeSummary = renderReportedJudgeSummary(reportedJudgeTotal, reportedJudgeReds);
  for (const line of judgeSummary.lines) (judgeSummary.stream === "stderr" ? console.error : console.log)(line);

  const observationSummary = renderObservationSummary(observations);
  for (const line of observationSummary.lines) (observationSummary.stream === "stderr" ? console.error : console.log)(line);

  const summary = `${passed} passed, ${failed} failed, ${skipped} skipped of ${SCENARIOS.length}`;
  if (skipped > 0) console.log(`  skip breakdown: ${renderSkipBreakdown(skipCounts)}`);
  if (failed > 0 || modelRoutingFailed) {
    console.error(`✗ e2e driver pack: ${summary}`);
    process.exit(1);
  }
  console.log(`✓ e2e driver pack: ${summary}`);
}

main().catch((err) => {
  console.error(`✗ e2e driver pack crashed: ${String(err)}`);
  process.exit(1);
});

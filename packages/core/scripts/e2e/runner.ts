import {
  resolveCapabilities,
  resolveConnectorWrite,
  resolveEngagedDiscord,
  resolveEngagedTeams,
  resolveEngagedGithub,
  engagedLinearApiKey,
  engagedLinearIdentity,
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
  resolveSlackHalt,
  resolveSlackMpim,
  resolveSlackPrivate,
  resolveSlackSecondary,
  resolveSlackSupervisor,
  resolveSlackUnified,
  resolveSlackUser2,
  resolveSynthetic,
  resolveSyntheticDm,
  resolveTeams,
  resolveWebhook,
  resolveControlWrite,
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
import { FixtureMissing, GateFailure, ScenarioSkip, SCENARIOS, skipCategory, skipReason, type Scenario, type ScenarioContext } from "./scenarios.js";
import { emptySkipCounts, isGapKind, renderSkipBreakdown } from "./skip-summary.js";
import { boardGaps, isDeclaredGap, releaseBoardProblems, renderBoard, LAUNCH_SURFACES, type BoardLeg } from "./board.js";
import {
  RELEASE_SCOPE_NAMES,
  releasePhaseProblem,
  releaseScopeIndex,
  releaseScopeProblems,
  releaseScopeRows,
  type ReleaseScopeName,
} from "./release-scope.js";
import { buildCostReport, checkExpectedModels, fetchRunUsage, renderCostReport, resolveExpectedModels } from "./cost.js";
import { callUnifiedAudit, fetchAudit, fetchAuditWindow } from "./audit-read.js";
import { captureWakeEvidence, renderLegWakeEvidence, writeWakeEvidence, type LegWakeEvidence } from "./wake-evidence.js";
import { fetchTranscript, type TranscriptWireEvent } from "./transcript-read.js";
import { renderObservationSummary, type Observation } from "./observations.js";
import { createPacingGate, paceMaybe, renderPacingLine } from "./pacing.js";
import { summariseTimings, writeTimingsRecords, type TimingsRecord } from "./timings-record.js";
import { fmtMs } from "./transcript-timings.js";

const WAKE_EVIDENCE_LIMIT = 1000;
const WAKE_EVIDENCE_TIMEOUT_MS = 20_000;
const WAKE_EVIDENCE_SETTLE_MS = 3_000;

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
  const slackMpim = resolveSlackMpim();
  const slackCapFixture = resolveSlackCapFixture();
  const slackHalt = resolveSlackHalt();
  const controlWrite = resolveControlWrite();
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
  const wakeAuditRead =
    auditTarget && auditToken
      ? (opts: { sinceIso: string; untilIso: string; limit: number; timeoutMs: number }) => fetchAuditWindow(auditTarget, auditToken, opts)
      : undefined;
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

  const pacing = createPacingGate();
  const slackDriver = paceMaybe(slack.ok ? new SlackDriver(slack.cfg) : undefined, "slack", pacing);
  const githubDriver = paceMaybe(github.ok ? new GithubDriver(github.cfg) : undefined, "github", pacing);
  const linearDriver = paceMaybe(linear.ok ? new LinearDriver(linear.cfg) : undefined, "linear", pacing);
  const notionAmbientDriver = paceMaybe(notionAmbient.ok ? new NotionDriver(notionAmbient.cfg) : undefined, "notion", pacing);
  const prApiDriver = pr.ok ? new PrApi(pr.cfg) : undefined;
  const discordDriver = paceMaybe(discord.ok ? new DiscordDriver(discord.cfg) : undefined, "discord", pacing);
  const teamsDriver = paceMaybe(teams.ok ? new TeamsDriver(teams.cfg) : undefined, "teams", pacing);
  const syntheticSlack = synthetic.ok ? new SyntheticSlack(synthetic.cfg) : undefined;
  const slackPrivateDriver = slackDriver && slackPrivate.ok ? slackDriver.withChannel(slackPrivate.cfg.channel) : undefined;
  const slackBDriver = slackDriver && slackChannelB.ok ? slackDriver.withChannel(slackChannelB.cfg.channel) : undefined;
  const slackMpimDriver = slackDriver && slackMpim.ok ? slackDriver.withChannel(slackMpim.cfg.channel) : undefined;
  const slackCapFixtureDriver = slackDriver && slackCapFixture.ok ? slackDriver.withChannel(slackCapFixture.cfg.channel) : undefined;
  const slackHaltDriver = slackDriver && slackHalt.ok ? slackDriver.withChannel(slackHalt.cfg.channel) : undefined;
  const slackSupervisorDriver = slackDriver && slackSupervisor.ok ? slackDriver.withChannel(slackSupervisor.cfg.channel) : undefined;
  const slackUnifiedADriver = slackDriver && slackUnified.ok ? slackDriver.withChannel(slackUnified.cfg.channelA) : undefined;
  const slackUnifiedBDriver = slackDriver && slackUnified.ok ? slackDriver.withChannel(slackUnified.cfg.channelB) : undefined;
  const dmDriver = slackDriver && syntheticDm.ok ? slackDriver.withChannel(syntheticDm.cfg.dmChannel) : undefined;
  const webhookDriver = webhook.ok ? new WebhookDriver(webhook.cfg) : undefined;
  const notionDriver = slackDriver && notion.ok ? slackDriver.withChannel(notion.cfg.channel) : undefined;
  const connectorWriteDriver = slackDriver && connectorWrite.ok ? slackDriver.withChannel(connectorWrite.cfg.channel) : undefined;
  const discordEngagedDriver = paceMaybe(
    discord.ok && engagedDiscord.ok ? new DiscordDriver({ ...discord.cfg, channel: engagedDiscord.cfg.id }) : undefined,
    "discord",
    pacing,
  );
  const teamsEngagedDriver = paceMaybe(teams.ok && engagedTeams.ok ? new TeamsDriver({ ...teams.cfg, channelId: engagedTeams.cfg.id }) : undefined, "teams", pacing);
  const githubEngagedDriver = paceMaybe(github.ok && engagedGithub.ok ? new GithubDriver({ ...github.cfg, repo: engagedGithub.cfg.id }) : undefined, "github", pacing);
  const linearEngagedDriver = paceMaybe(
    linear.ok && engagedLinear.ok
      ? new LinearDriver({
          ...linear.cfg,
          teamId: engagedLinear.cfg.id,
          apiKey: engagedLinearApiKey(process.env, linear.cfg.apiKey),
          ...engagedLinearIdentity(process.env, { appUserId: linear.cfg.appUserId, agentHandle: linear.cfg.agentHandle }),
        })
      : undefined,
    "linear",
    pacing,
  );
  const notionEngagedDriver = paceMaybe(
    notionAmbient.ok && engagedNotion.ok ? new NotionDriver({ ...notionAmbient.cfg, pageId: engagedNotion.cfg.id }) : undefined,
    "notion",
    pacing,
  );
  const slackSecondaryDriver = paceMaybe(
    slack.ok && slackSecondary.ok ? new SlackDriver({ token: slackSecondary.cfg.token, channel: slack.cfg.channel, botUserId: slack.cfg.botUserId }) : undefined,
    "slack",
    pacing,
  );

  console.log(`e2e driver pack — ${SCENARIOS.length} scenarios; capabilities live: ${
    report.available.size > 0 ? [...report.available].join(", ") : "none (dry mode only when no canonical release scope is armed)"
  }; judge: ${judge.name}`);
  console.log(`seat lock: /tmp/oe-e2e-locks/domain-${process.env.E2E_UNIFIED_DOMAIN?.trim() || "e2e-unified"}.lock — hold it for the whole live drive; never run a second driver against any surface of this domain`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let declaredGaps = 0;
  let notRun = 0;
  const fixtureRedsToProvision: string[] = [];
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

  const releaseIdx = process.argv.findIndex((a) => a === "--release-scope" || a.startsWith("--release-scope="));
  const releaseRaw = (
    releaseIdx === -1
      ? process.env.E2E_RELEASE_SCOPE
      : process.argv[releaseIdx]!.includes("=")
        ? process.argv[releaseIdx]!.split("=")[1]
        : process.argv[releaseIdx + 1]
  )
    ?.trim()
    .toLowerCase();
  if (releaseIdx !== -1 && !releaseRaw) {
    console.error(`✗ --release-scope needs one of: ${RELEASE_SCOPE_NAMES.join(", ")}`);
    process.exit(1);
  }
  if (releaseRaw && !RELEASE_SCOPE_NAMES.includes(releaseRaw as ReleaseScopeName)) {
    console.error(`✗ release scope "${releaseRaw}" is not one of: ${RELEASE_SCOPE_NAMES.join(", ")}`);
    process.exit(1);
  }
  const releaseScope = releaseRaw as ReleaseScopeName | undefined;
  const releaseRows = releaseScope ? releaseScopeRows(releaseScope) : undefined;
  const releaseIndex = releaseRows ? releaseScopeIndex(releaseRows) : undefined;
  if (releaseRows) {
    const problems = releaseScopeProblems(releaseRows);
    if (
      problems.missing.length ||
      problems.unknown.length ||
      problems.duplicate.length ||
      problems.invalidEquivalent.length ||
      problems.invalidReason.length ||
      problems.invalidPhase.length
    ) {
      console.error(
        `✗ E2E_RELEASE_SCOPE=${releaseScope} does not classify the scenario roster exactly once — ` +
          `missing=${problems.missing.join(",") || "none"}; unknown=${problems.unknown.join(",") || "none"}; ` +
          `duplicate=${problems.duplicate.join(",") || "none"}; invalid-equivalent=${problems.invalidEquivalent.join(",") || "none"}; ` +
          `invalid-reason=${problems.invalidReason.join(",") || "none"}; invalid-phase=${problems.invalidPhase.join(",") || "none"}`,
      );
      process.exit(1);
    }
    if (only.size > 0 || (process.env.E2E_SURFACES ?? "").trim() || !["", "core", "full"].includes((process.env.E2E_SUITE ?? "").trim().toLowerCase())) {
      console.error(
        `✗ E2E_RELEASE_SCOPE=${releaseScope} cannot be combined with --only/E2E_ONLY, E2E_SURFACES, or a non-core E2E_SUITE; ` +
          "the reviewed scope itself is the complete selector.",
      );
      process.exit(1);
    }
    console.log(`release scope=${releaseScope}: ${releaseRows.filter((row) => row.requirement === "REQUIRED").length} REQUIRED, ${releaseRows.filter((row) => row.requirement === "NON_LAUNCH").length} NON_LAUNCH`);
  }
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
  const suiteSel = suiteRaw === "full" ? "core" : suiteRaw || "core";
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

  const board: BoardLeg[] = [];
  const recordBoard = (scenario: Scenario, row: Omit<BoardLeg, "id" | "surface" | "requirement" | "equivalents">): void => {
    const releaseRow = releaseIndex?.get(scenario.id);
    board.push({
      id: scenario.id,
      surface: scenario.surface,
      ...row,
      ...(releaseRow ? { requirement: releaseRow.requirement, ...(releaseRow.equivalents ? { equivalents: releaseRow.equivalents } : {}) } : {}),
    });
  };
  const wakeEvidence: LegWakeEvidence[] = [];
  const liveRun = report.available.size > 0 || releaseScope !== undefined;

  for (const scenario of SCENARIOS) {
    const releaseRow = releaseIndex?.get(scenario.id);
    if (releaseRow?.requirement === "NON_LAUNCH") {
      notRun++;
      recordBoard(scenario, { status: "NOT_RUN", reason: releaseRow.reason });
      console.log(`○ ${scenario.id} ${scenario.title}: NOT RUN — ${releaseRow.reason}`);
      continue;
    }
    const phaseProblem = releaseRow ? releasePhaseProblem(releaseRow, process.env) : undefined;
    if (phaseProblem !== undefined) {
      failed++;
      recordBoard(scenario, { status: "RED", reason: `required phase unavailable — ${phaseProblem}` });
      console.error(`✗ ${scenario.id} ${scenario.title}: REQUIRED PHASE UNAVAILABLE — ${phaseProblem}`);
      continue;
    }
    if (only.size > 0 && !only.has(scenario.id.toUpperCase())) {
      skipped++;
      skipCounts["filtered-only"]++;
      recordBoard(scenario, { status: "FILTERED", reason: "not named by --only / E2E_ONLY" });
      console.log(`– ${scenario.id} ${scenario.title}: skipped (filtered by --only)`);
      continue;
    }
    if (suiteSel === "smoke" && scenario.smoke !== true) {
      skipped++;
      skipCounts["filtered-suite"]++;
      recordBoard(scenario, { status: "FILTERED", reason: "not in the E2E_SUITE=smoke set" });
      console.log(`– ${scenario.id} ${scenario.title}: skipped (not in the E2E_SUITE=smoke set)`);
      continue;
    }
    if (surfaceFilter.size > 0 && !surfaceFilter.has(scenario.surface)) {
      skipped++;
      skipCounts["filtered-surface"]++;
      recordBoard(scenario, { status: "FILTERED", reason: `surface ${scenario.surface} not in E2E_SURFACES` });
      console.log(`– ${scenario.id} ${scenario.title}: skipped (surface ${scenario.surface} not in E2E_SURFACES)`);
      continue;
    }
    const explicitlyNamed = releaseRow?.requirement === "REQUIRED" || only.has(scenario.id.toUpperCase());
    const category = skipCategory(scenario, report.available, explicitlyNamed, includeExpensive);
    if (category !== undefined) {
      const reason = skipReason(scenario, report.available, report.missing, explicitlyNamed, includeExpensive)!;
      if (isGapKind(category) && liveRun) {
        failed++;
        recordBoard(scenario, { status: "RED", reason: `cannot run — ${reason}` });
        console.error(`✗ ${scenario.id} ${scenario.title}: CANNOT RUN — ${reason}`);
        continue;
      }
      skipped++;
      skipCounts[category]++;
      recordBoard(scenario, {
        status: category === "expensive-not-included" ? "DEFERRED" : "FILTERED",
        reason,
      });
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
      slackMpim: slackMpimDriver,
      ...(engagedSlack.ok ? { engagedSlack: engagedSlack.cfg } : {}),
      discordEngaged: discordEngagedDriver,
      teamsEngaged: teamsEngagedDriver,
      githubEngaged: githubEngagedDriver,
      linearEngaged: linearEngagedDriver,
      notionEngaged: notionEngagedDriver,
      slackCapFixture: slackCapFixtureDriver,
      slackHalt: slackHaltDriver,
      controlWriteConfig: controlWrite.ok ? controlWrite.cfg : undefined,
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
      fixtureMissing(why: string): never {
        throw new FixtureMissing(why);
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
    const legSinceIso = new Date().toISOString();
    const boardRow = board.length;
    try {
      await withTimeout(scenario.run(ctx), scenario.timeoutMs);
      passed++;
      const judgeTag = judgeBannerTag({ llm: judgedLlm, fallback: judgedFallback, reasons: [...fallbackReasons] });
      const reportTag = reported > 0 ? `, ${reported} judged-reported (${reportedRed} red, non-gating)` : "";
      recordBoard(scenario, {
        status: "GREEN",
        evidence: `${gates} gates, ${judgedCount} judged${reportTag}, ${secs()}`,
      });
      console.log(`✓ ${scenario.id} ${scenario.title}: passed (${gates} gates, ${judgedCount} judged${reportTag}${judgeTag}, ${secs()})`);
    } catch (err) {
      if (err instanceof FixtureMissing) {
        if (liveRun && releaseRow?.requirement !== "REQUIRED" && isDeclaredGap(scenario.surface, err.message)) {
          declaredGaps++;
          recordBoard(scenario, { status: "GAP", reason: `declared gap — ${err.message}` });
          console.log(`◌ ${scenario.id} ${scenario.title}: DECLARED GAP — ${err.message}`);
        } else if (liveRun) {
          failed++;
          fixtureRedsToProvision.push(`${scenario.id} (${scenario.surface}) — ${err.message}`);
          recordBoard(scenario, { status: "RED", reason: `RED-until-fixture — ${err.message}` });
          console.error(`⚑ ${scenario.id} ${scenario.title}: RED-until-fixture — the harness's own test data is missing, so nothing about the deployment was measured (${err.message})`);
        } else {
          skipped++;
          skipCounts["fixture-missing"]++;
          recordBoard(scenario, { status: "FILTERED", reason: `dry run — ${err.message}` });
          console.log(`⚑ ${scenario.id} ${scenario.title}: FIXTURE MISSING — nothing was measured about the deployment (${err.message})`);
        }
      } else if (err instanceof ScenarioSkip) {
        if (liveRun) {
          failed++;
          recordBoard(scenario, { status: "RED", reason: `cannot run — ${err.message}` });
          console.error(`✗ ${scenario.id} ${scenario.title}: CANNOT RUN — ${err.message}`);
        } else {
          skipped++;
          skipCounts["scenario-self-skip"]++;
          recordBoard(scenario, { status: "FILTERED", reason: `dry run — ${err.message}` });
          console.log(`– ${scenario.id} ${scenario.title}: skipped (${err.message})`);
        }
      } else {
        failed++;
        const message = String(err instanceof Error ? err.message : err);
        recordBoard(scenario, { status: "RED", reason: message, evidence: `failed after ${secs()}` });
        console.error(`✗ ${scenario.id} ${scenario.title} (${secs()}): ${message}`);
      }
    }

    if (liveRun) {
      const legStatus = board[boardRow]?.status ?? "UNKNOWN";
      if (legStatus === "RED") await new Promise((resolve) => setTimeout(resolve, WAKE_EVIDENCE_SETTLE_MS));
      const captured = await captureWakeEvidence(
        wakeAuditRead,
        { legId: scenario.id, surface: scenario.surface, sinceIso: legSinceIso, untilIso: new Date().toISOString(), status: legStatus },
        { limit: WAKE_EVIDENCE_LIMIT, timeoutMs: WAKE_EVIDENCE_TIMEOUT_MS },
      );
      wakeEvidence.push(captured);
      if (captured.status === "RED") for (const line of renderLegWakeEvidence(captured)) console.error(`  ${line}`);
    }
  }

  const gaps = boardGaps(board);
  for (const line of renderBoard(board)) console.log(line);
  if (gaps.missing.length > 0 || gaps.unknown.length > 0) {
    console.error(
      `✗ e2e driver pack: the board does not match the roster — missing rows: ${gaps.missing.join(", ") || "none"}; ` +
        `rows for unknown ids: ${gaps.unknown.join(", ") || "none"}. Every scenario must reach the board exactly once.`,
    );
    process.exit(1);
  }
  let releaseScopeFailed = false;
  if (releaseScope) {
    const problems = releaseBoardProblems(board);
    if (problems.requiredNotGreen.length || problems.nonLaunchNotNotRun.length || problems.unearnedEquivalent.length || problems.unclassified.length) {
      releaseScopeFailed = true;
      console.error(
        `✗ release scope=${releaseScope} is incomplete — required-not-green=${problems.requiredNotGreen.join(",") || "none"}; ` +
          `non-launch-not-NOT_RUN=${problems.nonLaunchNotNotRun.join(",") || "none"}; ` +
          `unearned-equivalent=${problems.unearnedEquivalent.join(",") || "none"}; unclassified=${problems.unclassified.join(",") || "none"}`,
      );
    } else {
      console.log(`✓ release scope=${releaseScope}: every REQUIRED leg is GREEN; every NON_LAUNCH leg is visible as NOT_RUN`);
    }
  }
  console.log("");

  const redEvidence = wakeEvidence.filter((e) => e.status === "RED");
  if (redEvidence.length > 0) {
    console.log("## RED leg wake evidence");
    console.log("");
    for (const e of redEvidence) for (const line of renderLegWakeEvidence(e)) console.log(line);
    console.log("");
  }
  try {
    const path = writeWakeEvidence(wakeEvidence, { startedAt: runStartedIso, ...(auditTarget ? { target: auditTarget } : {}) });
    if (path) console.log(`e2e wake evidence: ${wakeEvidence.length} leg(s) written to ${path}`);
    else if (liveRun) console.log("e2e wake evidence: nothing captured — no leg ran");
  } catch (err) {
    console.log(`e2e wake evidence: not written (${String(err instanceof Error ? err.message : err)})`);
  }

  if (!liveRun) {
    console.log(`✓ e2e driver pack: skipped — no driver tokens (${skipped}/${SCENARIOS.length} scenarios dry-skipped)`);
    console.log(`  skip breakdown: ${renderSkipBreakdown(skipCounts)}`);
    return;
  }

  if (passed === 0 && failed === 0) {
    console.error(
      `✗ e2e driver pack: 0 scenarios ran (${skipped}/${SCENARIOS.length} skipped, ${declaredGaps} declared gap(s)) even though live capabilities ` +
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
      const usage = await fetchRunUsage(costTarget, readToken, runStartedIso, workspaces, runStartedIso);
      const rows = usage.rows;
      for (const line of renderCostReport(buildCostReport(rows, usage.excluded))) console.log(line);
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

  console.log(renderPacingLine(pacing.stats()));

  if (fixtureRedsToProvision.length > 0) {
    console.error(
      `fixtures to provision (RED, not a declared gap — ${LAUNCH_SURFACES.join(" / ")} and any surface no ruling exempts): ${fixtureRedsToProvision.length}`,
    );
    for (const line of fixtureRedsToProvision) console.error(`  ⚑ ${line}`);
  }

  const summary =
    `${passed} passed, ${failed} failed, ${skipped} skipped` +
    `${notRun > 0 ? `, ${notRun} non-launch not run` : ""}` +
    `${declaredGaps > 0 ? `, ${declaredGaps} declared gap(s)` : ""} of ${SCENARIOS.length}`;
  if (skipped > 0) console.log(`  skip breakdown: ${renderSkipBreakdown(skipCounts)}`);
  if (failed > 0 || modelRoutingFailed || releaseScopeFailed) {
    console.error(`✗ e2e driver pack: ${summary}`);
    process.exit(1);
  }
  console.log(`✓ e2e driver pack: ${summary}`);
}

main().catch((err) => {
  console.error(`✗ e2e driver pack crashed: ${String(err)}`);
  process.exit(1);
});

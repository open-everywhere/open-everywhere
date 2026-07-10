import {
  resolveCapabilities,
  resolveDiscord,
  resolveGithub,
  resolveLinear,
  resolveNotion,
  resolveNotionAmbient,
  resolveSlack,
  resolveSlackChannelB,
  resolveSlackPrivate,
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
import { SyntheticDm, SyntheticSlack } from "./synthetic.js";
import { WebhookDriver } from "./webhook.js";
import { judge3, resolveJudge, type Rubric } from "./judge.js";
import { GateFailure, ScenarioSkip, SCENARIOS, skipReason, type ScenarioContext } from "./scenarios.js";
import { buildCostReport, fetchRunUsage, renderCostReport } from "./cost.js";
import { fetchAudit } from "./audit-read.js";

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
  const report = resolveCapabilities();
  const slack = resolveSlack();
  const discord = resolveDiscord();
  const teams = resolveTeams();
  const synthetic = resolveSynthetic();
  const judge = resolveJudge();

  const slackPrivate = resolveSlackPrivate();
  const slackChannelB = resolveSlackChannelB();
  const syntheticDm = resolveSyntheticDm();
  const slackUser2 = resolveSlackUser2();
  const webhook = resolveWebhook();
  const notion = resolveNotion();
  const github = resolveGithub();
  const linear = resolveLinear();
  const notionAmbient = resolveNotionAmbient();

  const auditTarget = (process.env.E2E_TARGET_URL ?? "").trim();
  const auditToken = (process.env.E2E_CONTROL_READ_TOKEN ?? "").trim();
  const auditRead = auditTarget && auditToken ? (opts: Parameters<typeof fetchAudit>[2]) => fetchAudit(auditTarget, auditToken, opts) : undefined;

  const slackDriver = slack.ok ? new SlackDriver(slack.cfg) : undefined;
  const githubDriver = github.ok ? new GithubDriver(github.cfg) : undefined;
  const linearDriver = linear.ok ? new LinearDriver(linear.cfg) : undefined;
  const notionAmbientDriver = notionAmbient.ok ? new NotionDriver(notionAmbient.cfg) : undefined;
  const discordDriver = discord.ok ? new DiscordDriver(discord.cfg) : undefined;
  const teamsDriver = teams.ok ? new TeamsDriver(teams.cfg) : undefined;
  const syntheticSlack = synthetic.ok ? new SyntheticSlack(synthetic.cfg) : undefined;
  const slackPrivateDriver = slackDriver && slackPrivate.ok ? slackDriver.withChannel(slackPrivate.cfg.channel) : undefined;
  const slackBDriver = slackDriver && slackChannelB.ok ? slackDriver.withChannel(slackChannelB.cfg.channel) : undefined;
  const syntheticDmForge = syntheticDm.ok ? new SyntheticDm(syntheticDm.cfg) : undefined;
  const dmDriver = slackDriver && syntheticDm.ok ? slackDriver.withChannel(syntheticDm.cfg.dmChannel) : undefined;
  const webhookDriver = webhook.ok ? new WebhookDriver(webhook.cfg) : undefined;
  const notionDriver = slackDriver && notion.ok ? slackDriver.withChannel(notion.cfg.channel) : undefined;

  console.log(`e2e driver pack — ${SCENARIOS.length} scenarios; capabilities live: ${
    report.available.size > 0 ? [...report.available].join(", ") : "none (dry mode)"
  }; judge: ${judge.name}`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;

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

  for (const scenario of SCENARIOS) {
    if (only.size > 0 && !only.has(scenario.id.toUpperCase())) {
      skipped++;
      console.log(`– ${scenario.id} ${scenario.title}: skipped (filtered by --only)`);
      continue;
    }
    if (suiteSel === "smoke" && scenario.smoke !== true) {
      skipped++;
      console.log(`– ${scenario.id} ${scenario.title}: skipped (not in the E2E_SUITE=smoke set)`);
      continue;
    }
    if (surfaceFilter.size > 0 && !surfaceFilter.has(scenario.surface)) {
      skipped++;
      console.log(`– ${scenario.id} ${scenario.title}: skipped (surface ${scenario.surface} not in E2E_SURFACES)`);
      continue;
    }
    const reason = skipReason(scenario, report.available, report.missing, effectiveIncludeOptional);
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
      teams: teamsDriver,
      synthetic: syntheticSlack,
      slackPrivate: slackPrivateDriver,
      slackB: slackBDriver,
      syntheticDm: syntheticDmForge,
      dm: dmDriver,
      slackUser2: slackUser2.ok ? slackUser2.cfg : undefined,
      webhook: webhookDriver,
      notion: notionDriver,
      notionQuery: notion.ok ? notion.cfg.query : undefined,
      github: githubDriver,
      linear: linearDriver,
      notionAmbient: notionAmbientDriver,
      targetUrl: auditTarget || undefined,
      auditRead,
      judge,
      gate(cond: boolean, label: string): void {
        if (!cond) throw new GateFailure(label);
        gates++;
      },
      async judgePass(rubric: Rubric, reply: string, label: string): Promise<void> {
        const verdict = await judge.grade(rubric, reply);
        if (verdict.score < rubric.atLeast)
          throw new GateFailure(`${label} — judge: ${verdict.detail}${replyTail(reply)}`);
        judgedCount++;
      },
      async judgePass3(rubric: Rubric, reply: string, label: string): Promise<void> {
        const verdict = await judge3(judge, rubric, reply);
        if (!verdict.pass) throw new GateFailure(`${label} — ${verdict.detail}${replyTail(reply)}`);
        judgedCount++;
      },
      skip(why: string): never {
        throw new ScenarioSkip(why);
      },
      log(line: string): void {
        console.log(`  [${scenario.id}] ${line}`);
      },
    };

    const startedAt = Date.now();
    const secs = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    try {
      await withTimeout(scenario.run(ctx), scenario.timeoutMs);
      passed++;
      console.log(`✓ ${scenario.id} ${scenario.title}: passed (${gates} gates, ${judgedCount} judged, ${secs()})`);
    } catch (err) {
      if (err instanceof ScenarioSkip) {
        skipped++;
        console.log(`– ${scenario.id} ${scenario.title}: skipped (${err.message})`);
      } else {
        failed++;
        console.error(`✗ ${scenario.id} ${scenario.title} (${secs()}): ${String(err instanceof Error ? err.message : err)}`);
      }
    }
  }

  if (report.available.size === 0) {
    console.log(`✓ e2e driver pack: skipped — no driver tokens (${skipped}/${SCENARIOS.length} scenarios dry-skipped)`);
    return;
  }

  const costTarget = (process.env.E2E_TARGET_URL ?? "").trim();
  const readToken = (process.env.E2E_CONTROL_READ_TOKEN ?? "").trim();
  const workspaces = (process.env.E2E_USAGE_WORKSPACES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (costTarget && readToken && workspaces.length > 0) {
    try {
      const rows = await fetchRunUsage(costTarget, readToken, runStartedIso, workspaces);
      for (const line of renderCostReport(buildCostReport(rows))) console.log(line);
    } catch (err) {
      console.log(`e2e run cost: unavailable (${String(err instanceof Error ? err.message : err)})`);
    }
  } else {
    console.log(
      "e2e run cost: skipped — set E2E_TARGET_URL + E2E_CONTROL_READ_TOKEN + E2E_USAGE_WORKSPACES to price runs (reads GET /control/v1/usage)",
    );
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

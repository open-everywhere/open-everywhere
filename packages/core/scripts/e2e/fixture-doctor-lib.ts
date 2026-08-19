import { ENV, type Capability } from "./env.js";

type Env = Record<string, string | undefined>;

export interface FixtureVarSpec {
  readonly name: string;
  readonly mustEqual?: string;
}

export type ProbeKind =
  | "slack-base"
  | "slack-secondary"
  | "slack-user"
  | "slack-channel"
  | "slack-channel-pair"
  | "slack-dm-channel"
  | "discord-base"
  | "teams"
  | "github"
  | "github-pr"
  | "linear"
  | "linear-label"
  | "notion-ambient"
  | "notion-page-pair"
  | "presence-only";

export interface FixtureFamily {
  readonly id: Capability;
  readonly label: string;
  readonly required: readonly FixtureVarSpec[];
  readonly optional?: readonly string[];
  readonly scenarios: string;
  readonly probe: ProbeKind;
  readonly presenceOnlyReason?: string;
  readonly channelVar?: string;
  readonly channelVars?: readonly [string, string];
  readonly pageVars?: readonly [string, string];
  readonly labelVar?: string;
}

export type FixtureClassification = "absent" | "partial" | "set";

export interface ClassifiedFixture {
  readonly family: FixtureFamily;
  readonly classification: FixtureClassification;
  readonly present: readonly string[];
  readonly missing: readonly string[];
  readonly optionalPresent: readonly string[];
  readonly optionalMissing: readonly string[];
}

export function classifyFixture(env: Env, family: FixtureFamily): ClassifiedFixture {
  const present: string[] = [];
  const missing: string[] = [];
  for (const spec of family.required) {
    const raw = env[spec.name]?.trim();
    const isSet = spec.mustEqual !== undefined ? raw === spec.mustEqual : Boolean(raw && raw.length > 0);
    if (isSet) present.push(spec.name);
    else missing.push(spec.name);
  }
  const classification: FixtureClassification = missing.length === 0 ? "set" : present.length === 0 ? "absent" : "partial";
  const optionalPresent: string[] = [];
  const optionalMissing: string[] = [];
  for (const name of family.optional ?? []) {
    if (env[name]?.trim()) optionalPresent.push(name);
    else optionalMissing.push(name);
  }
  return { family, classification, present, missing, optionalPresent, optionalMissing };
}

export function classifyAll(env: Env, families: readonly FixtureFamily[]): readonly ClassifiedFixture[] {
  return families.map((f) => classifyFixture(env, f));
}

export interface ProbeOutcome {
  readonly ok: boolean;
  readonly detail: string;
}

export interface FixtureFinding {
  readonly classified: ClassifiedFixture;
  readonly probe?: ProbeOutcome;
  readonly notProbed?: string;
}

export interface FixtureDoctorResult {
  readonly ok: boolean;
  readonly findings: readonly FixtureFinding[];
}

export function fixtureDoctorResult(findings: readonly FixtureFinding[]): FixtureDoctorResult {
  const ok = findings.every((f) => {
    if (f.classified.classification === "partial") return false;
    if (f.classified.classification === "set" && f.probe && !f.probe.ok) return false;
    return true;
  });
  return { ok, findings };
}

export function renderFixtureReport(result: FixtureDoctorResult): string[] {
  const lines: string[] = [];
  const set = result.findings.filter((f) => f.classified.classification === "set");
  const probed = set.filter((f) => f.probe !== undefined);
  const passed = probed.filter((f) => f.probe?.ok);
  const partial = result.findings.filter((f) => f.classified.classification === "partial");
  const absent = result.findings.filter((f) => f.classified.classification === "absent");

  lines.push("");
  lines.push(`  FIXTURES (${result.findings.length} declared families — env.ts's Capability set)`);
  lines.push(`  probed: ${passed.length}/${probed.length} reachable`);

  lines.push("");
  lines.push(`  SET & PROBED (${probed.length})`);
  for (const f of probed) {
    const mark = f.probe?.ok ? "✓" : "✗";
    lines.push(`    ${mark} ${f.classified.family.id} — ${f.classified.family.label}`);
    lines.push(`        ${f.probe?.detail ?? ""}`);
    if (f.classified.family.optional && f.classified.family.optional.length > 0) {
      lines.push(`        optional: ${f.classified.optionalPresent.length} armed (${f.classified.optionalPresent.join(", ") || "none"}), ${f.classified.optionalMissing.length} unset (${f.classified.optionalMissing.join(", ") || "none"})`);
    }
  }
  if (probed.length === 0) lines.push("    (none)");

  const notProbed = set.filter((f) => f.probe === undefined);
  if (notProbed.length > 0) {
    lines.push("");
    lines.push(`  SET, NOT PROBED (${notProbed.length}) — presence-only, or a dependency was unavailable`);
    for (const f of notProbed) lines.push(`    ~ ${f.classified.family.id} — ${f.classified.family.label}: ${f.notProbed ?? "not probed"}`);
  }

  if (partial.length > 0) {
    lines.push("");
    lines.push(`  PARTIALLY CONFIGURED (${partial.length}) — a broken half-fixture, not a deliberate gap`);
    for (const f of partial) {
      lines.push(`    ✗ ${f.classified.family.id} — ${f.classified.family.label}`);
      lines.push(`        present: ${f.classified.present.join(", ") || "(none)"}`);
      lines.push(`        missing: ${f.classified.missing.join(", ")}`);
    }
  }

  if (absent.length > 0) {
    lines.push("");
    lines.push(`  NOT CONFIGURED (${absent.length}) — deliberate gap, not a red`);
    for (const f of absent) {
      lines.push(`    - ${f.classified.family.id} — ${f.classified.family.label}`);
      lines.push(`        gates: ${f.classified.family.scenarios}`);
      lines.push(`        set: ${f.classified.family.required.map((r) => r.name).join(", ")}`);
    }
  }

  const presenceOnlyReasons = [
    ...new Map(
      result.findings
        .filter((f) => f.classified.family.probe === "presence-only" && f.classified.family.presenceOnlyReason)
        .map((f) => [f.classified.family.id, f.classified.family.presenceOnlyReason as string] as const),
    ).values(),
  ];
  if (presenceOnlyReasons.length > 0) {
    lines.push("");
    lines.push(`  NOT PROVEN BY THIS DOCTOR (${presenceOnlyReasons.length})`);
    for (const r of presenceOnlyReasons) lines.push(`    ! ${r}`);
  }

  lines.push("");
  if (result.ok) {
    lines.push("✓ e2e:fixtures: every configured fixture is reachable; no broken half-fixtures.");
  } else {
    const brokenProbes = probed.filter((f) => !f.probe?.ok).map((f) => f.classified.family.id);
    lines.push("✗ e2e:fixtures: fixture rot found.");
    if (brokenProbes.length > 0) lines.push(`  failed probe(s): ${brokenProbes.join(", ")}`);
    if (partial.length > 0) lines.push(`  partially configured: ${partial.map((f) => f.classified.family.id).join(", ")}`);
    lines.push("  A scenario naming one of these families will self-skip silently instead of failing — fix the fixture before trusting a green e2e run.");
  }
  return lines;
}

const v = (name: string, mustEqual?: string): FixtureVarSpec => (mustEqual === undefined ? { name } : { name, mustEqual });

export const FIXTURE_FAMILIES: readonly FixtureFamily[] = [
  {
    id: "slack",
    label: "Slack driver (user token + primary channel + OE bot user id)",
    required: [v(ENV.slackUserToken), v(ENV.slackChannel), v(ENV.slackBotUserId)],
    scenarios: "the Slack driver half — nearly every Slack scenario, plus every slack-* add-on below which rides this token",
    probe: "slack-base",
  },
  {
    id: "slackSecondary",
    label: "Slack secondary (non-admin) user token",
    required: [v(ENV.slackSecondaryToken), v(ENV.slackSecondaryUserId)],
    scenarios: "S10's cap-refusal-as-ordinary-member leg + S-LINK-SLACK's own-DM claim leg (OPE-617 v2)",
    probe: "slack-secondary",
  },
  {
    id: "slackUser2",
    label: "Slack non-admin user id (forged-payload identity only)",
    required: [v(ENV.slackUser2Id)],
    scenarios: "S15 (non-admin approval click) and S16 (admin-tool refusal)",
    probe: "slack-user",
  },
  {
    id: "slackPrivate",
    label: "Slack private channel",
    required: [v(ENV.slackPrivateChannel)],
    scenarios: "S11 (private-surface scenarios)",
    probe: "slack-channel",
    channelVar: ENV.slackPrivateChannel,
  },
  {
    id: "slackChannelB",
    label: "Slack second-domain channel",
    required: [v(ENV.slackChannelB)],
    scenarios: "S12 (silo isolation)",
    probe: "slack-channel",
    channelVar: ENV.slackChannelB,
  },
  {
    id: "slackCapFixture",
    label: "Slack throwaway spend-cap channel",
    required: [v(ENV.slackCapChannel)],
    scenarios: "S10 (spend-cap-tripping drive, dedicated scope)",
    probe: "slack-channel",
    channelVar: ENV.slackCapChannel,
  },
  {
    id: "slackSupervisor",
    label: "Slack ambient-supervisor channel",
    required: [v(ENV.slackSupervisorChannel)],
    scenarios: "J-SUP (ambient channel-watch judge)",
    probe: "slack-channel",
    channelVar: ENV.slackSupervisorChannel,
  },
  {
    id: "notion",
    label: "Slack channel bound to a live Notion connector (S24)",
    required: [v(ENV.notionChannel)],
    optional: [ENV.notionQuery],
    scenarios: "S24 (notion connector read via a bound Slack channel)",
    probe: "slack-channel",
    channelVar: ENV.notionChannel,
  },
  {
    id: "slackUnified",
    label: "Slack unified-domain channel pair",
    required: [v(ENV.slackUnifiedChannelA), v(ENV.slackUnifiedChannelB)],
    optional: [ENV.unifiedDomain],
    scenarios: "J-UNIFIED / J-UNI-X (cross-container unified-domain supervisor)",
    probe: "slack-channel-pair",
    channelVars: [ENV.slackUnifiedChannelA, ENV.slackUnifiedChannelB],
  },
  {
    id: "syntheticDm",
    label: "Synthetic Slack DM forge (target + signing secret + real DM channel)",
    required: [v(ENV.targetUrl), v(ENV.slackSigningSecret), v(ENV.slackDmChannel)],
    scenarios: "S13/S14 (synthetic Slack DM scenarios)",
    probe: "slack-dm-channel",
    channelVar: ENV.slackDmChannel,
  },
  {
    id: "synthetic",
    label: "Synthetic signed-POST driver (approval clicks + /oe slash commands)",
    required: [v(ENV.targetUrl), v(ENV.slackSigningSecret), v(ENV.slackAdminUserId), v(ENV.slackChannel)],
    scenarios: "approval-click + /oe slash-command synthetic POSTs across most scenarios",
    probe: "presence-only",
    presenceOnlyReason:
      "synthetic — targets THIS deployment, not a third-party vendor; deploy:census/deploy:smoke prove ingress reachability, not this doctor.",
  },
  {
    id: "webhook",
    label: "Inbound webhook fixture (S20 + the post-deploy smoke hook)",
    required: [v(ENV.targetUrl), v(ENV.webhookSecret)],
    optional: [ENV.webhookHookId],
    scenarios: "S20 (inbound webhook fixture) + the post-deploy smoke hook",
    probe: "presence-only",
    presenceOnlyReason: "webhook — targets THIS deployment's own /webhooks/<id> route, not a third-party vendor.",
  },
  {
    id: "connectorWrite",
    label: "Notion connector-WRITE arm (bound channel + explicit E2E_CONNECTOR_WRITE=1)",
    required: [v(ENV.notionChannel), v(ENV.connectorWrite, "1")],
    scenarios: "S-NOTION-WRITE / S-CONNECTOR-TIER (consequence-tier gate:member connector write)",
    probe: "presence-only",
    presenceOnlyReason:
      "connectorWrite — the bound channel is already probed under the \"notion\" family above; the arming flag is a literal deployment posture, not a vendor credential to reach.",
  },
  {
    id: "discord",
    label: "Discord driver bot (token + channel + OE bot user id)",
    required: [v(ENV.discordDriverToken), v(ENV.discordChannel), v(ENV.discordBotUserId)],
    scenarios: "the Discord driver half — nearly every Discord scenario",
    probe: "discord-base",
  },
  {
    id: "teams",
    label: "Teams driver (Entra app + delegated refresh token + team/channel)",
    required: [
      v(ENV.teamsTenantId),
      v(ENV.teamsClientId),
      v(ENV.teamsRefreshToken),
      v(ENV.teamsTeamId),
      v(ENV.teamsChannelId),
      v(ENV.teamsBotAppId),
    ],
    optional: [ENV.teamsRefreshTokenFile],
    scenarios: "ST1 (Teams @mention drive)",
    probe: "teams",
  },
  {
    id: "github",
    label: "GitHub ambient driver (user PAT + fixture repo + app slug + fixture issue)",
    required: [v(ENV.githubDriverToken), v(ENV.githubRepo), v(ENV.githubAppSlug), v(ENV.githubIssue)],
    optional: [ENV.githubWebhookSecret, ENV.githubInstallationId],
    scenarios: "J-GH (GitHub ambient @mention/comment surface)",
    probe: "github",
  },
  {
    id: "pr",
    label: "Consequential PR-write target repo (reuses the GitHub driver PAT)",
    required: [v(ENV.prRepo), v(ENV.githubDriverToken)],
    optional: [ENV.prBase, ENV.prUngrantedRepo],
    scenarios: "J-PR / J-WORKFLOW (consequential PR write)",
    probe: "github-pr",
  },
  {
    id: "linear",
    label: "Linear ambient driver (user PAT + team + app user id + agent handle)",
    required: [v(ENV.linearApiKey), v(ENV.linearTeamId), v(ENV.linearAppUserId), v(ENV.linearAgentHandle)],
    optional: [ENV.linearWebhookSecret],
    scenarios: "J-LIN (Linear ambient @mention/comment surface)",
    probe: "linear",
  },
  {
    id: "notionAmbient",
    label: "Notion ambient driver (driver key + scratch page + bot user id + workspace id)",
    required: [v(ENV.notionDriverKey), v(ENV.notionAmbientPageId), v(ENV.notionBotUserId), v(ENV.notionWorkspaceId)],
    optional: [ENV.notionAmbientWebhookSecret, ENV.notionAnchorOnTopic, ENV.notionAnchorOnTopic2, ENV.notionAnchorOffTopic, ENV.notionAnchorHuman],
    scenarios: "J-NOT (Notion ambient comment surface) + S-TAINT-DRYRUN/S-TAINT-ROUTE-LIVE's human anchor (OPE-576)",
    probe: "notion-ambient",
  },
  {
    id: "soakSlack",
    label: "Soak lane's dedicated Slack channel pair (#oe-soak-dev / #oe-soak-ops)",
    required: [v(ENV.slackSoakChannelDev), v(ENV.slackSoakChannelOps)],
    scenarios: "the soak scenario's narrative skeleton (OPE-845 §1) — a DEDICATED pair, never the e2e-unified fixture",
    probe: "slack-channel-pair",
    channelVars: [ENV.slackSoakChannelDev, ENV.slackSoakChannelOps],
  },
  {
    id: "soakNotion",
    label: "Soak lane's dedicated Notion page pair",
    required: [v(ENV.notionSoakPage1), v(ENV.notionSoakPage2)],
    scenarios: "the soak scenario's narrative skeleton — phase 2 (spec work) + phase 11 (late recall)",
    probe: "notion-page-pair",
    pageVars: [ENV.notionSoakPage1, ENV.notionSoakPage2],
  },
  {
    id: "soakLinear",
    label: "Soak lane's dedicated Linear label (on the e2e fixture team, never a real-work team)",
    required: [v(ENV.linearSoakLabelId)],
    scenarios: "the soak scenario's narrative skeleton — phase 3 (ticket triage)",
    probe: "linear-label",
    labelVar: ENV.linearSoakLabelId,
  },
];

type FamilyId = (typeof FIXTURE_FAMILIES)[number]["id"];
type AssertExhaustive = Capability extends FamilyId ? true : ["FIXTURE_FAMILIES is missing a Capability", Exclude<Capability, FamilyId>];
const _assertExhaustive: AssertExhaustive = true;

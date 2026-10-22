import { processRegistrySlot } from "../lib/process-registry.js";
import { e2eDriversProblem, driverAllowlistProblem, type E2eDriverIdentity } from "../testing/driver-allowlist.js";
import { sandboxRegionProblem } from "../sandbox/vercel-create.js";
import { dataPolicyRows, validateDataPolicy, type ModelDataPolicy } from "../model/data-policy.js";
import { SHIPPED_MODEL_TARGETS, modelTargetWords, validateModelTargets, type ModelTargets } from "../model/targets.js";

export type TaintTierMode = "enforced" | "dryrun";

export type TaintMode = "on" | "off";

export type TaintUndeclaredSurface = "clean" | "mark";

export type ApprovalJudgeMode = "off" | "shadow" | "enforce";

export type GithubAuthMode = "app" | "token";

export type ExternalAuthorGrain = "taint" | "withhold";

export type ExternalRoomGrain = "engage" | "silent";

export type DirectoryAutoConfirm = "off" | "attested";

export type DirectoryMode = "sync" | "observe";

export type DirectoryProviderChoice = "none" | "okta";

export type SandboxBackendChoice = "docker" | "justbash";

export type BlanketTrust = "none" | "internal" | "external";

export interface AdminRoleRule {
  readonly roles: readonly string[];
  readonly issuer?: string;
  readonly subject?: string;
  readonly email?: string;
  readonly emailDomain?: string;
}

export interface AdminOidcSetting {
  readonly issuer: string;
  readonly audience: string;
}

export interface OktaAppSetting {
  readonly platform: string;
  readonly tenant?: string;
  readonly appId: string;
  readonly field?: "externalId" | "userName";
}

export type AuditExportFormat = "otlp" | "json" | "splunk-hec";

export interface LogShipSetting {
  readonly url: string;
  readonly tokenHeader?: string;
  readonly service?: string;
}

export interface AuditExportTarget {
  readonly name: string;
  readonly format: AuditExportFormat;
  readonly url: string;
  readonly tokenSecret?: string;
  readonly tokenHeader?: string;
  readonly tokenScheme?: string;
  readonly orgs?: readonly string[];
}

export interface AgentSettings {
  readonly a2a: {
    readonly inbound: boolean;
  };
  readonly accessRequests: {
    readonly adminChannel: string;
    readonly configRepo: string;
    readonly configBase: string;
  };
  readonly agent: {
    readonly sessionInputTokenBudget: number;
    readonly compactionThresholdPercent: number;
  };
  readonly approvals: {
    readonly judgeMode: ApprovalJudgeMode;
    readonly ttlHours: number;
    readonly routineGrantTtlHours: number;
    readonly checkpointTtlHours: number;
    readonly routineCardWaitSeconds: number;
  };
  readonly browser: {
    readonly enabled: boolean;
  };
  readonly auditExport: {
    readonly targets: readonly AuditExportTarget[];
  };
  readonly aws: {
    readonly enabled: boolean;
    readonly ssoScopes: readonly string[];
    readonly region: string;
    readonly ssoRegion: string;
    readonly ssoClientId: string;
  };
  readonly bash: {
    readonly timeoutMs: number;
    readonly backgroundGuard: boolean;
  };
  readonly connectors: {
    readonly dmOnly: boolean;
    readonly userPrincipal: boolean;
    readonly linkSetVault: boolean;
    readonly opTiering: boolean;
    readonly memberPlane: boolean;
  };
  readonly control: {
    readonly githubAdmin: boolean;
    readonly adminRoleRules: readonly AdminRoleRule[];
    readonly adminOidc: AdminOidcSetting;
  };
  readonly directory: {
    readonly provider: DirectoryProviderChoice;
    readonly oktaOrgUrl: string;
    readonly mode: DirectoryMode;
    readonly autoConfirm: DirectoryAutoConfirm;
    readonly groupAllowlist: readonly string[];
    readonly oktaApps: readonly OktaAppSetting[];
  };
  readonly identityLinking: {
    readonly codeBack: boolean;
  };
  readonly delegation: {
    readonly oneshotAgent: boolean;
  };
  readonly models: {
    readonly stack: string;
    readonly primary: string;
    readonly force: string;
    readonly dataPolicy: ModelDataPolicy;
    readonly targets: ModelTargets;
  };
  readonly discord: {
    readonly autoThread: boolean;
    readonly statusUx: boolean;
    readonly applicationId: string;
    readonly publicKey: string;
  };
  readonly egress: {
    readonly enforce: boolean;
    readonly allowUnenforced: boolean;
    readonly proxyUrl: string;
    readonly sourceIp: string;
    readonly denialLog: string;
  };
  readonly externalPolicy: {
    readonly authorGrain: ExternalAuthorGrain;
    readonly roomGrain: ExternalRoomGrain;
  };
  readonly github: {
    readonly auth: GithubAuthMode;
    readonly tokenRepos: readonly string[];
    readonly appId: string;
    readonly appSlug: string;
    readonly appClientId: string;
    readonly botUserId: string;
    readonly conversation: boolean;
    readonly installations: Readonly<Record<string, string>>;
  };
  readonly governance: {
    readonly floorTtlMs: number;
  };
  readonly identity: {
    readonly dmTrustTtlMs: number;
    readonly name: string;
    readonly shortName: string;
    readonly commandName: string;
    readonly allowMultiTenantPrincipals: boolean;
    readonly blanketTrust: BlanketTrust;
  };
  readonly language: {
    readonly output: string;
  };
  readonly linear: {
    readonly appName: string;
    readonly appUserId: string;
    readonly clientId: string;
    readonly organizationId: string;
  };
  readonly memory: {
    readonly dreamCandidateCap: number;
    readonly skillProposalPr: boolean;
    readonly syncTiming: boolean;
    readonly provider: string;
    readonly gitBranch: string;
    readonly notionTokenSecret: string;
  };
  readonly observability: {
    readonly logShip: LogShipSetting;
  };
  readonly notion: {
    readonly botName: string;
    readonly botUserId: string;
  };
  readonly policyPages: {
    readonly privacy: string;
    readonly terms: string;
  };
  readonly schedules: {
    readonly sweepOrgs: readonly string[];
  };
  readonly routines: {
    readonly eventMaxFanout: number;
    readonly maxConcurrency: number;
    readonly jobMaxFires: number;
    readonly jobMaxDays: number;
    readonly attentionWarnRuns: number;
    readonly attentionPauseRuns: number;
    readonly discoveryMinWeeks: number;
    readonly firstConversationDays: number;
    readonly firstDayBrief: boolean;
  };
  readonly rotation: {
    readonly quietGapHours: number;
    readonly expiryDays: number;
    readonly tokenBudget: number;
    readonly turnBudget: number;
    readonly contextSizeTokens: number;
    readonly tailTokenCap: number;
    readonly dmSummaryTokenCap: number;
  };
  readonly sandbox: {
    readonly selfHostBackend: SandboxBackendChoice;
    readonly useVercelSandbox: boolean;
    readonly stopAfterTurn: boolean;
    readonly extendMaxMinutes: number;
    readonly timeoutMs: number;
    readonly snapshotExpirationMs: number;
    readonly image: string;
    readonly region: string;
  };
  readonly storage: {
    readonly allowEphemeralMemory: boolean;
    readonly allowEphemeralOperational: boolean;
  };
  readonly spend: {
    readonly usageEventsTtlDays: number;
    readonly sandboxMemoryGiB: number;
    readonly sandboxGiBHourUsd: number;
  };
  readonly retention: {
    readonly sessionTranscriptDays: number;
    readonly storedStateDays: number;
  };
  readonly skills: {
    readonly domainSkillCap: number;
  };
  readonly slack: {
    readonly suggestedPrompts: readonly SlackSuggestedPrompt[];
  };
  readonly soak: {
    readonly capture: boolean;
    readonly captureSurfacePrefix: string | readonly string[];
  };
  readonly stall: {
    readonly repeatThreshold: number;
  };
  readonly sensitiveData: {
    readonly extraPatterns: readonly SensitivePatternSetting[];
  };
  readonly taint: {
    readonly mode: TaintMode;
    readonly tierMode: TaintTierMode;
    readonly undeclaredSurface: TaintUndeclaredSurface;
  };
  readonly teams: {
    readonly serviceHosts: readonly string[];
    readonly appId: string;
  };
  readonly telemetry: {
    readonly enabled: boolean;
    readonly debug: boolean;
    readonly url: string;
  };
  readonly tools: {
    readonly maxResultChars: number;
  };
  readonly turn: {
    readonly stepBudget: number;
    readonly stepBackstopMultiple: number;
  };
  readonly voiceClips: {
    readonly enabled: boolean;
  };
  readonly wake: {
    readonly nameDropInclude: readonly string[];
    readonly nameDropExclude: readonly string[];
    readonly e2eDrivers: readonly E2eDriverIdentity[];
    readonly driverAllowlist: readonly string[];
    readonly testWakeRoute: boolean;
  };
  readonly webhooks: {
    readonly allowUnverified: boolean;
    readonly allowUnverifiedGithub: boolean;
    readonly allowUnverifiedNotion: boolean;
  };
  readonly window: {
    readonly topology: boolean;
  };
}

export interface SettingSpec<T> {
  readonly path: string;
  readonly shipped: T;
  readonly validate?: (value: T) => string | undefined;
  readonly alsoAccepts?: "string" | "object";
  readonly summary: string;
  readonly format?: (value: T) => string;
}

export interface SensitivePatternSetting {
  readonly type: string;
  readonly tier: "strictest" | "explicit";
  readonly pattern: string;
  readonly flags?: string;
}

const MAX_SENSITIVE_PATTERN_CHARS = 500;

export function sensitivePatternsProblem(rows: readonly SensitivePatternSetting[]): string | undefined {
  if (!Array.isArray(rows)) return "must be an array of { type, tier, pattern, flags? } rows";
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const at = `extraPatterns[${i}]`;
    if (row === null || typeof row !== "object") return `${at} must be an object`;
    const keys = Object.keys(row).filter((k) => !["type", "tier", "pattern", "flags"].includes(k));
    if (keys.length > 0) return `${at} has an unknown key "${keys[0]}"`;
    if (typeof row.type !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(row.type)) return `${at}.type must be kebab-case, 1-40 characters, starting with a letter`;
    if (seen.has(row.type)) return `${at}.type "${row.type}" is declared twice`;
    seen.add(row.type);
    if (row.tier !== "strictest" && row.tier !== "explicit") return `${at}.tier must be "strictest" or "explicit"`;
    if (typeof row.pattern !== "string" || row.pattern.length === 0 || row.pattern.length > MAX_SENSITIVE_PATTERN_CHARS) {
      return `${at}.pattern must be a non-empty regex source of at most ${MAX_SENSITIVE_PATTERN_CHARS} characters`;
    }
    if (row.flags !== undefined && (typeof row.flags !== "string" || !/^[imsu]*$/.test(row.flags))) return `${at}.flags may hold only i, m, s and u`;
    let re: RegExp;
    try {
      re = new RegExp(row.pattern, row.flags ?? "");
    } catch (err) {
      return `${at}.pattern does not compile: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (re.test("")) return `${at}.pattern matches the empty string, so it would refuse every call`;
  }
  return undefined;
}

export interface SlackSuggestedPrompt {
  readonly title: string;
  readonly message: string;
}

const SLACK_SUGGESTED_PROMPTS_MAX = 4;

const SLACK_SUGGESTED_PROMPTS_SHIPPED: readonly SlackSuggestedPrompt[] = [
  { title: "What can you do?", message: "What can you help me with?" },
  { title: "What do you remember?", message: "What do you remember about me?" },
  { title: "Help me write", message: "Help me write a short update for my team." },
];

const slackSuggestedPromptsProblem = (v: readonly SlackSuggestedPrompt[]): string | undefined => {
  if (!Array.isArray(v)) return "must be an array of { title, message } objects";
  if (v.length > SLACK_SUGGESTED_PROMPTS_MAX) return `must hold at most ${SLACK_SUGGESTED_PROMPTS_MAX} prompts — Slack's agent view shows no more`;
  for (const [i, p] of v.entries()) {
    if (typeof p?.title !== "string" || p.title.trim() === "") return `prompt ${i} needs a non-empty \`title\``;
    if (typeof p?.message !== "string" || p.message.trim() === "") return `prompt ${i} needs a non-empty \`message\``;
  }
  return undefined;
};

const positiveInt = (value: number): string | undefined =>
  Number.isInteger(value) && value > 0 ? undefined : "must be a positive integer";

const nonNegativeInt = (value: number): string | undefined =>
  Number.isInteger(value) && value >= 0 ? undefined : "must be a whole number of days, 0 or more";

const httpUrlOrEmpty = (v: string): string | undefined => {
  if (v === "") return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? undefined : 'must be an http(s) URL, or "" for unset';
  } catch {
    return 'must be an http(s) URL, or "" for unset';
  }
};

const branchName = (v: string): string | undefined =>
  typeof v === "string" && /^[A-Za-z0-9_./-]+$/u.test(v) && !v.includes("..") ? undefined : "must be one branch name";

const ipOrEmpty = (v: string): string | undefined =>
  v === "" || /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(v) || (/^[0-9A-Fa-f:.]+$/u.test(v) && v.includes(":"))
    ? undefined
    : 'must be one IP address, or "" for unset';

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

const logShipProblem = (v: LogShipSetting): string | undefined => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "must be an object { url, tokenHeader?, service? }";
  for (const key of Object.keys(v)) {
    if (key !== "url" && key !== "tokenHeader" && key !== "service") return `unknown field "${key}" — the fields are url, tokenHeader and service`;
  }
  if (typeof v.url !== "string") return "url must be a string";
  const url = httpUrlOrEmpty(v.url);
  if (url !== undefined) return `url ${url}`;
  if (v.tokenHeader !== undefined && (typeof v.tokenHeader !== "string" || !HEADER_NAME.test(v.tokenHeader))) return "tokenHeader must be one HTTP header name";
  if (v.service !== undefined && (typeof v.service !== "string" || v.service.trim() === "")) return "service must be a non-empty string";
  return undefined;
};

const positiveNumber = (value: number): string | undefined =>
  Number.isFinite(value) && value > 0 ? undefined : "must be a positive number";

const policyTextProblem = (value: string): string | undefined =>
  value.length > 0 && value.trim().length === 0
    ? "must be either empty (no document published) or real text — a whitespace-only value renders a blank page"
    : undefined;

const stringArray = (value: readonly string[]): string | undefined =>
  Array.isArray(value) && value.every((t) => typeof t === "string") ? undefined : "must be an array of strings";

const tokenArray = (value: readonly string[]): string | undefined =>
  Array.isArray(value) && value.every((t) => typeof t === "string" && /^\S+$/u.test(t))
    ? undefined
    : "must be an array of non-empty strings with no whitespace";

const modelIdOrEmpty = (v: string): string | undefined =>
  v === "" || /^\S+$/u.test(v) ? undefined : "must be empty or one model id with no whitespace";

const adminRoleRulesProblem = (rules: readonly AdminRoleRule[]): string | undefined => {
  if (!Array.isArray(rules)) return "must be an array of role rules";
  for (const [i, r] of rules.entries()) {
    if (typeof r !== "object" || r === null) return `rule ${i} must be an object`;
    if (!Array.isArray(r.roles) || r.roles.length === 0 || !r.roles.every((x: unknown) => typeof x === "string" && x.trim() !== "")) {
      return `rule ${i} must name at least one role in \`roles\``;
    }
    const matchers = [r.issuer, r.subject, r.email, r.emailDomain];
    if (matchers.some((m) => m !== undefined && (typeof m !== "string" || m.trim() === ""))) {
      return `rule ${i} has a matcher that is not a non-empty string`;
    }
    if (matchers.every((m) => m === undefined)) {
      return `rule ${i} names no matcher (issuer, subject, email or emailDomain), so it would match every verified identity`;
    }
  }
  return undefined;
};

const adminOidcProblem = (v: AdminOidcSetting): string | undefined => {
  if (typeof v !== "object" || v === null) return "must be { issuer, audience }";
  if (typeof v.issuer !== "string" || typeof v.audience !== "string") return "issuer and audience must both be strings";
  if (v.issuer === "" && v.audience === "") return undefined;
  if (v.issuer === "" || v.audience === "") return "set BOTH issuer and audience, or leave both empty (off) — half a pair arms nothing";
  let url: URL;
  try {
    url = new URL(v.issuer);
  } catch {
    return `issuer must be the provider's issuer URL, e.g. "https://accounts.google.com" (got "${v.issuer}")`;
  }
  if (url.protocol !== "https:") return "issuer must be an https: URL";
  if (/\s/u.test(v.audience)) return "audience must be one value with no whitespace";
  return undefined;
};

const oktaAppsProblem = (apps: readonly OktaAppSetting[]): string | undefined => {
  if (!Array.isArray(apps)) return "must be an array of { platform, tenant?, appId, field? } entries";
  const seen = new Set<string>();
  for (const [i, a] of apps.entries()) {
    if (typeof a !== "object" || a === null) return `entry ${i} must be an object`;
    if (typeof a.platform !== "string" || !/^[a-z0-9-]+$/u.test(a.platform)) return `entry ${i}: platform must be a lowercase platform token, e.g. "slack"`;
    if (typeof a.appId !== "string" || a.appId.trim() === "" || /\s/u.test(a.appId)) return `entry ${i}: appId must be the Okta application id, e.g. "0oa1a2b3c4d5"`;
    if (a.tenant !== undefined && (typeof a.tenant !== "string" || a.tenant.trim() === "" || a.tenant.includes("/"))) {
      return `entry ${i}: tenant must be one workspace id with no slash, e.g. "T0AB1CD2E"`;
    }
    if (a.field !== undefined && a.field !== "externalId" && a.field !== "userName") return `entry ${i}: field must be "externalId" (default) or "userName"`;
    const key = `${a.platform}/${a.tenant ?? ""}`;
    if (seen.has(key)) return `two entries map to the same target "${key.replace(/\/$/u, "")}" — give each workspace its own entry, or remove the duplicate`;
    seen.add(key);
  }
  return undefined;
};

const oktaOrgUrlProblem = (v: string): string | undefined => {
  if (typeof v !== "string") return "must be a string";
  if (v === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return `"${v}" is not a URL — expected your Okta org URL, e.g. "https://acme.okta.com"`;
  }
  if (parsed.protocol !== "https:") {
    return `"${v}" is not https — every Okta request carries the SSWS API token in an authorization header, so a plaintext org URL would put an admin credential on the wire on every sync. Use "https://<your-org>.okta.com"`;
  }
  return undefined;
};

export function languageTagProblem(value: string): string | undefined {
  if (typeof value !== "string") return "must be a string";
  if (value === "") return undefined;
  if (value.trim() !== value || /\s/u.test(value)) return "must be one BCP 47 language tag with no whitespace, e.g. \"fr\" or \"pt-BR\"";
  let canonical: string;
  try {
    canonical = Intl.getCanonicalLocales(value)[0] ?? "";
  } catch {
    return "must be a well-formed BCP 47 language tag, e.g. \"fr\", \"de\" or \"pt-BR\"";
  }
  const name = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(canonical);
  return name === undefined ? `names no language this runtime knows (got "${value}") — use a BCP 47 tag such as "fr" or "pt-BR"` : undefined;
}

const auditExportTargetsProblem = (targets: readonly AuditExportTarget[]): string | undefined => {
  if (!Array.isArray(targets)) return "must be an array of { name, format, url, tokenSecret?, tokenHeader?, tokenScheme?, orgs? } entries";
  const names = new Set<string>();
  for (const [i, t] of targets.entries()) {
    if (typeof t !== "object" || t === null) return `target ${i} must be an object`;
    if (typeof t.name !== "string" || !/^[a-z0-9-]{1,64}$/u.test(t.name)) return `target ${i}: name must be 1-64 characters of [a-z0-9-], e.g. "splunk"`;
    if (names.has(t.name)) return `two targets are named "${t.name}" — each target keys its own delivery cursor, so names must be unique`;
    names.add(t.name);
    if (t.format !== "otlp" && t.format !== "json" && t.format !== "splunk-hec") return `target "${t.name}": format must be "otlp", "json" or "splunk-hec"`;
    let url: URL;
    try {
      url = new URL(t.url);
    } catch {
      return `target "${t.name}": url must be an absolute URL, e.g. "https://siem.example.com/v1/logs"`;
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return `target "${t.name}": url must use https: (http: is accepted only for a loopback collector)`;
    if (url.username !== "" || url.password !== "") return `target "${t.name}": url must not carry credentials — name a secret in tokenSecret instead`;
    if (t.tokenSecret !== undefined && (typeof t.tokenSecret !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(t.tokenSecret))) {
      return `target "${t.name}": tokenSecret must be a secret NAME in env style (A-Z, 0-9, _; e.g. "SPLUNK_HEC_TOKEN"), never a value — store the value with \`oe secret set <name>\``;
    }
    if (t.tokenHeader !== undefined && (typeof t.tokenHeader !== "string" || !/^[A-Za-z0-9-]{1,64}$/u.test(t.tokenHeader))) return `target "${t.name}": tokenHeader must be one HTTP header name`;
    if (t.tokenScheme !== undefined && (typeof t.tokenScheme !== "string" || !/^[A-Za-z0-9-]{0,32}$/u.test(t.tokenScheme))) return `target "${t.name}": tokenScheme must be one word, or "" for a bare token`;
    if ((t.tokenHeader !== undefined || t.tokenScheme !== undefined) && t.tokenSecret === undefined) return `target "${t.name}": tokenHeader and tokenScheme need a tokenSecret`;
    if (t.orgs !== undefined && (!Array.isArray(t.orgs) || !t.orgs.every((o: unknown) => typeof o === "string" && o.trim() !== ""))) return `target "${t.name}": orgs must be a list of org ids`;
  }
  return undefined;
};

const idOrEmpty = (v: string): string | undefined =>
  typeof v === "string" && !/\s/u.test(v) ? undefined : 'must be one id with no whitespace, or "" for unset';
const digitsOrEmpty = (v: string): string | undefined =>
  typeof v === "string" && /^\d*$/u.test(v) ? undefined : 'must be a numeric id as a string, or "" for unset';
const awsRegionOrEmpty = (v: string): string | undefined =>
  typeof v === "string" && /^([a-z]{2,4}(-[a-z]+)+-\d+)?$/u.test(v) ? undefined : 'must be an AWS region such as "us-east-1", or "" for unset';
const unsetFormat = (v: string): string => (v === "" ? "(unset)" : v);
const githubInstallationsProblem = (v: Readonly<Record<string, string>>): string | undefined => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "must be an object of owner → installation id";
  for (const [owner, id] of Object.entries(v)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(owner)) return `"${owner}" is not a GitHub owner login`;
    if (typeof id !== "string" || !/^\d+$/u.test(id)) return `the installation id for "${owner}" must be a numeric string`;
  }
  return undefined;
};

const stringOrStringArray = (value: string | readonly string[]): string | undefined =>
  typeof value === "string" || (Array.isArray(value) && value.every((t) => typeof t === "string")) ? undefined : "must be a string or an array of strings";

export const SETTINGS = {
  a2a: {
    inbound: {
      path: "a2a.inbound",
      shipped: false,
      summary:
        "Whether this deployment accepts INBOUND A2A calls: another organisation's agent calls this agent through its published A2A agent card (`GET /.well-known/agent-card.json`) and its JSON-RPC route (`POST /a2a/jsonrpc`). Off (shipped) ⇒ both routes answer 404 — the ingress does not exist. On, the routes ALSO need at least one caller declared in `agent/access/a2a-inbound.ts`: with none, they still answer 404. Every call must authenticate as a declared caller (a JWT from a declared issuer, or a declared bearer secret by credential-store ref); an unauthenticated or undeclared call is refused 401 before any turn starts. A call lands as a job in its caller's own surface of the caller's declared domain, bound EXTERNAL (read-only `public` memory) and unattended — and it holds that domain's tool and connector grants, so declare a caller only in a domain whose grants you would expose to it. See docs/extending/a2a-agents.md.",
    } satisfies SettingSpec<boolean>,
  },
  accessRequests: {
    adminChannel: {
      path: "accessRequests.adminChannel",
      shipped: "",
      validate: (v: string) => (typeof v === "string" && !/\s/u.test(v) ? undefined : "must be one channel id, with no whitespace"),
      summary:
        "The channel that hears \"PR opened — merge to grant\" for every pull request the access-request, `create_agent`, `declare_webhook` and `propose_mcp_server` flows open (was `OE_ACCESS_ADMIN_CHANNEL`, OPE-2650). It is also the governance-channel fallback when no memory domain is a governance domain. Empty (shipped) ⇒ unset: with this setting OR `accessRequests.configRepo` unset, each flow refuses politely and nothing else changes. See docs/how-it-works/access-requests.md.",
      format: (v) => (v === "" ? "(unset)" : v),
    } satisfies SettingSpec<string>,
    configRepo: {
      path: "accessRequests.configRepo",
      shipped: "",
      validate: (v: string) => (v === "" || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(v) ? undefined : 'must be "owner/repo", or "" for unset'),
      summary:
        "This deployment's own config repository, `owner/repo` — the repository the grants, agents, webhook and credential-binding overlays live in, and the one every config pull request targets (was `OE_ACCESS_CONFIG_REPO`, OPE-2650). The GitHub App needs write access to it. Empty (shipped) ⇒ unset: the pull-request flows refuse politely, and with `github.auth: \"token\"` the token reaches no repository of its own. See docs/how-it-works/access-requests.md.",
      format: (v) => (v === "" ? "(unset)" : v),
    } satisfies SettingSpec<string>,
    configBase: {
      path: "accessRequests.configBase",
      shipped: "main",
      validate: (v: string) => (typeof v === "string" && /^[A-Za-z0-9_./-]+$/u.test(v) && !v.includes("..") ? undefined : "must be one branch name"),
      summary:
        "The base branch of `accessRequests.configRepo`: each config pull request branches from it and merges into it (was `OE_ACCESS_CONFIG_BASE`, OPE-2650).",
    } satisfies SettingSpec<string>,
  },
  agent: {
    sessionInputTokenBudget: {
      path: "agent.sessionInputTokenBudget",
      shipped: 30_000_000,
      validate: positiveNumber,
      summary:
        "eve's `limits.maxInputTokensPerSession`, set BELOW the hosted 40M hard kill so the graceful park/fail fires first. KEEP IT UNDER 40M — above that the hosted wall wins and the session dies ungracefully instead of parking. ONE SHARED BUDGET: every delegated worker's input counts toward its seat's total, and a worker starts with only the seat's remaining share. Read at BOOT (it is a `defineAgent` argument).",
    } satisfies SettingSpec<number>,
    compactionThresholdPercent: {
      path: "agent.compactionThresholdPercent",
      shipped: 0.5,
      validate: (v) => (Number.isFinite(v) && v > 0 && v < 1 ? undefined : "must be a fraction strictly between 0 and 1"),
      summary:
        "eve's `compaction.thresholdPercent` — the fraction of the model context window at which compaction fires. COMPACTION OWNS SIZE for every window type (rotation is context-motivated and time-triggered), so this is the in-generation size lever. A FRACTION IS THE ONLY THING AUTHORED: the absolute token count is this value times the active model stack's primary context window, so pointing `models.stack` at a smaller-window stack compacts proportionally lower with no edit here. `/oe status` prints the count this deploy resolved. Per-type thresholds are not reachable on the pinned eve. Read at BOOT.",
      format: (v) => `${v} (${Math.round(v * 100)}% of the window)`,
    } satisfies SettingSpec<number>,
  },
  approvals: {
    judgeMode: {
      path: "approvals.judgeMode",
      shipped: "enforce",
      validate: (v) => (v === "off" || v === "shadow" || v === "enforce" ? undefined : 'must be "off", "shadow" or "enforce"'),
      summary:
        "The LLM approval judge. `enforce` (shipped): for a judge-deferred act, the judge allows it with no card ONLY when it cites one of the scope's authored pre-approval rules (`preApprovalRules` on a bundle); every other answer, an unreachable judge model and a timeout all post the card. Admin acts never reach the judge. A consult costs up to two model calls on the `judge` model role, and a scope with no authored rule costs none. `shadow` decides nothing and logs a would-be verdict beside every real card. `off` runs no judge, so every gated act posts a card.",
    } satisfies SettingSpec<ApprovalJudgeMode>,
    ttlHours: {
      path: "approvals.ttlHours",
      shipped: 24,
      validate: positiveNumber,
      summary: "TTL before a pending approval action lazily expires, in hours.",
      format: (v) => `${v} h`,
    } satisfies SettingSpec<number>,
    routineGrantTtlHours: {
      path: "approvals.routineGrantTtlHours",
      shipped: 24,
      validate: positiveNumber,
      summary:
        "TTL for a routine's standing grant, in hours: the grant the middle button of a routine's `pr.open` card writes (\"Approve for this routine\", the `approve_session` click verb). Later fires of that routine skip the card for that kind until the grant expires, a break-glass `revoke_session_grants` deletes it, or an `edit_routine` moves the routine's key. A card in a conversation has no middle button and keeps no grant (OPE-2363), so this clock never applies to one. Was `approvals.sessionTtlHours` before 0.2.0.",
      format: (v) => `${v} h`,
    } satisfies SettingSpec<number>,
    checkpointTtlHours: {
      path: "approvals.checkpointTtlHours",
      shipped: 24,
      validate: positiveNumber,
      summary:
        "TTL for the session-checkpoint memos of a LIVE session, in hours. A REAL bound, not only a GC bound (OPE-2161). The memo's session id embeds the window generation, so a rotation can drop it first. But one generation can live for days, and then this clock ends the grant. The card and the click answer name this value. It does NOT bound a ROUTINE fire's continue grant, which carries no expiry: approving a durable job's checkpoint records the cost at that moment as the approved mark, and the next card fires only once the session spends a fresh threshold's worth on top of it. It still bounds that fire's \"asked\" marker, which is what lets a declined job be asked again.",
      format: (v) => `${v} h`,
    } satisfies SettingSpec<number>,
    routineCardWaitSeconds: {
      path: "approvals.routineCardWaitSeconds",
      shipped: 120,
      validate: (v) =>
        Number.isInteger(v) && v >= 0 && v <= 300 ? undefined : "must be a whole number of seconds between 0 and 300",
      summary:
        "How long an unattended routine fire's APPROVALS-PLANE refusal WAITS for its permission card to be answered before it declines for that run. 120 (shipped) holds the refusing call for up to two minutes, so a person who is around can answer the card while the run is still up. 0 is the opt-out: the refusal is immediate and the card decides only FUTURE runs. It does NOT govern the CONNECTOR plane's refusal, which posts its card and refuses at once whatever this says: that refusal is computed inside the connection's own approval gate, so a wait there holds the connector call open rather than the model's turn. Armed, the refusing tool call polls the card's own pending row, and an approval inside the window lets that run proceed. THE BUDGET, and why 120 is the shipped value: the deployed function's wall ceiling is 300 s (measured, platform default, no app pin); the turn's own elapsed time is read off its start stamp and subtracted; the model still has to be told and the run's report posted, so 60 s is reserved. The wait is CLAMPED to what is left, whatever this value says — so a turn already 250 s old waits not at all rather than dying mid-report, and 120 is the value a turn that reached its refusal at the assumed 120 s can still afford (300 − 120 − 60). 🔴 A deadline never decides the card: it stays pending and clickable, and approving it still arms every later run.",
      format: (v) => (v === 0 ? "0 (no wait — the refusal is immediate)" : `${v} s`),
    } satisfies SettingSpec<number>,
  },
  browser: {
    enabled: {
      path: "browser.enabled",
      shipped: false,
      summary:
        "The in-sandbox browser master flag. Unarmed the capability does not exist: no `browser_*` tools mount, no egress hosts open, no browser bakes into the sandbox template. Arming ALSO requires at least one row in the host declaration (`agent/access/browser-hosts.ts`), which is where the reach itself lives — each row names a host, the HTTP verbs the firewall admits there, an optional credential the firewall injects at the boundary, and whether `browser_evaluate` is armed for it. Both halves are compiled into the build, so the sandbox template and the runtime mount cannot disagree.",
    } satisfies SettingSpec<boolean>,
  },
  auditExport: {
    targets: {
      path: "auditExport.targets",
      shipped: [] as readonly AuditExportTarget[],
      validate: auditExportTargetsProblem,
      summary:
        "The SIEMs the audit log streams to (OPE-2437). Empty (shipped) exports nothing. Each entry is `{ name, format, url, tokenSecret?, tokenHeader?, tokenScheme?, orgs? }`. `format` is `\"otlp\"` (OTLP/HTTP JSON logs, POSTed to the collector's `/v1/logs` URL), `\"json\"` (one JSON array per batch — Datadog, Microsoft Sentinel's Logs Ingestion API, any HTTPS intake) or `\"splunk-hec\"` (Splunk HTTP Event Collector envelopes). `tokenSecret` NAMES a secret in the DB-backed store (`oe secret set <name>`) in env style (`SPLUNK_HEC_TOKEN`) and never holds a value; it resolves from the store ONLY, never from an environment variable of the same name, so a config line cannot reach an env-held secret such as `DATABASE_URL` (it CAN name any stored operator secret, so review the name in the pull request); it is sent as `<tokenScheme> <value>` in `tokenHeader` (defaults: `authorization`, and `Splunk` for HEC or `Bearer` otherwise). The `audit-export` schedule ships every row after the target's cursor, oldest first, each with its `seq`, `prevSha` and recomputed `sha`, so the receiver can verify the hash chain. Delivery is AT-LEAST-ONCE: the cursor advances only after a 2xx, so a failed or interrupted batch is sent again and a receiver deduplicates on `(org, seq)`. The rows carry `detail` in full, so the SIEM holds what an org admin can read on the control plane. `url` must be `https:` (an `http:` loopback collector is accepted). A rename re-sends the log from the start, because the name keys the cursor.",
      format: (v) => (v.length === 0 ? "[] (no export)" : v.map((t) => `${t.name} (${t.format})`).join(", ")),
    } satisfies SettingSpec<readonly AuditExportTarget[]>,
  },
  aws: {
    enabled: {
      path: "aws.enabled",
      shipped: false,
      summary:
        "The AWS access plane's master flag (was `OE_AWS_ENABLED`). Off (shipped), nothing registers and core's AWS mint and exec paths fail closed. On, the adapter registers the STS mint, the CLI executor and the Identity Center link callback at boot. The regions and the public OIDC client id are the settings `aws.region`, `aws.ssoRegion` and `aws.ssoClientId`.",
    } satisfies SettingSpec<boolean>,
    ssoScopes: {
      path: "aws.ssoScopes",
      shipped: [] as readonly string[],
      validate: tokenArray,
      summary:
        "The OAuth scopes the Identity Center link asks for (was `OE_AWS_SSO_SCOPES`). Empty (shipped) asks for the minter's default, `sso:account:access` plus `openid`. A scope list is what access is asked for, so a wider list widens the agent's reach. A non-empty list must keep `openid`: without it the link cannot verify who consented, and it refuses.",
      format: (v) => (v.length > 0 ? v.join(" ") : "(the minter's default)"),
    } satisfies SettingSpec<readonly string[]>,
    region: {
      path: "aws.region",
      shipped: "",
      validate: awsRegionOrEmpty,
      summary:
        "The operator's default AWS region (was `OE_AWS_REGION`, OPE-2650). The STS mint and the CLI executor apply it when a role grant names no region. Empty (shipped) ⇒ the host's own `AWS_REGION`, and with neither the SDK's own default applies.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
    ssoRegion: {
      path: "aws.ssoRegion",
      shipped: "",
      validate: awsRegionOrEmpty,
      summary:
        "The IAM Identity Center region the per-person AWS link signs in through (was `OE_AWS_SSO_REGION`, OPE-2650). Empty (shipped) ⇒ `aws.region`, then `AWS_REGION`. With no region at all, the link refuses as not configured.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
    ssoClientId: {
      path: "aws.ssoClientId",
      shipped: "",
      validate: idOrEmpty,
      summary:
        "The pre-registered PUBLIC OIDC client id this deployment presents at the Identity Center link (was `OE_AWS_SSO_CLIENT_ID`, OPE-2650). It is a public client: there is no client secret. Empty (shipped) ⇒ unset, and the link refuses as not configured.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
  },
  bash: {
    timeoutMs: {
      path: "bash.timeoutMs",
      shipped: 600_000,
      validate: (v) => (Number.isInteger(v) && v >= 0 ? undefined : "must be a non-negative integer (0 disables the timeout)"),
      summary: "Wall-clock cap on one `bash` call, in ms. `0` disables the timeout entirely.",
      format: (v) => `${v} ms`,
    } satisfies SettingSpec<number>,
    backgroundGuard: {
      path: "bash.backgroundGuard",
      shipped: true,
      summary:
        "Refuse before it runs any command that backgrounds a segment with a bare `&` while redirecting neither stdout nor stderr.",
    } satisfies SettingSpec<boolean>,
  },
  connectors: {
    dmOnly: {
      path: "connectors.dmOnly",
      shipped: false,
      summary:
        "The connector DM-only wall. Off (shipped), a channel reaches a connector exactly when a domain or bundle grants it the connection, and `connectors.opTiering` decides which calls need a card. On, a connector operation must come from a positively-DM context (or a task worker spawned from one) or it is refused fail-closed before a token exists. The wall bites only while `connectors.opTiering` is off: with tiering on, a granted non-DM context still passes, because tiering keeps each write behind an approval.",
    } satisfies SettingSpec<boolean>,
    userPrincipal: {
      path: "connectors.userPrincipal",
      shipped: true,
      summary:
        "The per-user credential path (A1). On (shipped, OPE-2414), a DM surface with a `user-oauth` credential bound resolves the OAuth subject to the calling human instead of the app principal: in a DM, a person signs in with their own account, and a person who has not signed in yet gets the \"Connect my account\" card. Channels keep the org credential paths. Off, a DM's `user-oauth` binding is refused: the app-principal path takes no personal credential, so a server declared in `agent/access/mcp-servers.ts` does not work in a DM. It REQUIRES `connectors.opTiering`, which ships on: the member-plane deny of a personal-credential write is computed only on the tiering branch, so settings load refuses `userPrincipal` on with `opTiering` set to off rather than ship a posture where a declared `connector.tool:` row can lift an unattended personal-credential write.",
    } satisfies SettingSpec<boolean>,
    linkSetVault: {
      path: "connectors.linkSetVault",
      shipped: true,
      summary:
        "The C.3 shared user-OAuth vault. On (shipped, OPE-2414), a confirmed link-set member keys the vault by their org-scoped link-set subject, so one consent covers all of that person's linked accounts. Because a confirmed membership then carries a credential, it also suppresses directory auto-confirm for every link-set: a person confirms each link. Off, each account keys its own token.",
    } satisfies SettingSpec<boolean>,
    opTiering: {
      path: "connectors.opTiering",
      shipped: true,
      summary:
        "The per-op consequence gate (A2). On (shipped), each `<connection>__<op>` call is classified individually: a read runs with no card, a write or a destructive op gets an approval card that approves that one call. The approval judge may pre-approve a write or a recognised delete on a domain credential under a bound pre-approval rule, and it never caches that allow. An op whose name carries no recognised verb gets a card that the judge never lifts, unless the tool annotations of its registered server bring its final tier down to `read`. Off, every op takes the blanket grain: each call, a read included, needs a card. Either way the approval is an OE card that posts and returns, never a native wait (OPE-2340).",
    } satisfies SettingSpec<boolean>,
    memberPlane: {
      path: "connectors.memberPlane",
      shipped: false,
      summary:
        "The member plane (OPE-944): a member's own connector credential resolves in a SHARED ROOM their domain declared it for, keyed to the one verified requester of that turn, reads only. The room must also be DECLARED INTERNAL in agent/identity/surfaces.ts (OPE-1472) — an undeclared room vouches for nobody, so a deployment that has declared nothing internal has no member plane until it declares something. It does not govern DMs — a personal credential always resolves in the asker's own DM, where a write takes the ordinary approval card.",
    } satisfies SettingSpec<boolean>,
  },
  control: {
    githubAdmin: {
      path: "control.githubAdmin",
      shipped: false,
      summary:
        "Arm the GitHub user-login verifier on the admin control plane (was `OE_ADMIN_GITHUB=1`). Off (shipped), a GitHub token authenticates nobody there. On, a GitHub user token is a verified identity, and `control.adminRoleRules` decides which roles it gets — an identity no rule grants is denied.",
    } satisfies SettingSpec<boolean>,
    adminRoleRules: {
      path: "control.adminRoleRules",
      shipped: [] as readonly AdminRoleRule[],
      validate: adminRoleRulesProblem,
      summary:
        "Which verified control-plane identity gets which roles (was the `OE_ADMIN_ROLE_RULES` JSON). Each rule names `roles` and at least one matcher — `issuer`, `subject`, `email` or `emailDomain` — and grants its roles to an identity that matches every matcher it names. The `email` and `emailDomain` matchers match a VERIFIED email only. Default-deny: empty (shipped) grants nothing, except that a configured `OE_ADMIN_STATIC_TOKEN` operator secret always carries the single-operator `admin` rule. A rule with no matcher fails the boot, because it would match every verified identity.",
      format: (v) => (v.length > 0 ? `${v.length} rule(s)` : "(none)"),
    } satisfies SettingSpec<readonly AdminRoleRule[]>,
    adminOidc: {
      path: "control.adminOidc",
      shipped: { issuer: "", audience: "" } as AdminOidcSetting,
      validate: adminOidcProblem,
      summary:
        "The OIDC identity provider of the admin control plane (was the `OE_ADMIN_OIDC_ISSUER` and `OE_ADMIN_OIDC_AUDIENCE` env vars, OPE-2650): `{ issuer, audience }`. Any standards OIDC provider works — Google, Auth0, Okta, Entra, WorkOS. Both empty (shipped) ⇒ the OIDC verifier is off. Both set ⇒ a token that issuer signed for that audience is a verified identity, and `control.adminRoleRules` decides which roles it gets — an identity no rule grants is denied. Half a pair fails the boot. The issuer must be an `https:` URL.",
      format: (v) => (v.issuer === "" ? "(off)" : `${v.issuer} (audience ${v.audience})`),
    } satisfies SettingSpec<AdminOidcSetting>,
  },
  directory: {
    provider: {
      path: "directory.provider",
      shipped: "none",
      validate: (v) => (v === "none" || v === "okta" ? undefined : 'must be "none" or "okta"'),
      summary:
        "Which directory adapter this deployment arms (was `OE_DIRECTORY_PROVIDER`, OPE-2649). `none` (shipped): no adapter registers, the daily `directory-sync` schedule is a logged no-op, and the directory control verbs report \"not wired\". `okta`: the Okta adapter registers at boot. It needs `directory.oktaOrgUrl` and the operator secret `OKTA_API_TOKEN` (`oe secret set OKTA_API_TOKEN`), and a missing org URL fails the boot. Any other value fails the boot, so a typo cannot half-arm the plane. Deploy `directory.mode: \"observe\"` first: see that row.",
    } satisfies SettingSpec<DirectoryProviderChoice>,
    oktaOrgUrl: {
      path: "directory.oktaOrgUrl",
      shipped: "",
      validate: oktaOrgUrlProblem,
      summary:
        "The Okta org the Okta adapter reads, e.g. `https://acme.okta.com` or an `*.oktapreview.com` sandbox (was `OE_DIRECTORY_OKTA_ORG_URL`, OPE-2649). Empty (shipped) configures no org. 🔴 It must be `https:`, with no localhost exception: every Okta request carries the SSWS API token in an `authorization` header, so a plaintext or unparseable URL fails the boot. The adapter sends the token to this origin only. The API token itself is the operator secret `OKTA_API_TOKEN` in the DB-backed store, never this setting and never an environment variable.",
      format: (v) => (v === "" ? "(none)" : v),
    } satisfies SettingSpec<string>,
    mode: {
      path: "directory.mode",
      shipped: "sync",
      validate: (v) => (v === "sync" || v === "observe" ? undefined : 'must be "sync" or "observe"'),
      summary:
        "What an armed directory adapter may do (OPE-2644). `sync` (shipped): the daily schedule and `directory_sync_now` apply the plan — `suggested` links, confirmations under `directory.autoConfirm`, and eager suspensions of deprovisioned people. `observe`: nothing writes identity state. The daily schedule makes no IdP call and writes only its heartbeat row, `directory_sync_now` refuses, and `directory_groups_plan` refuses `deliver: true`, so no link, suspension or group PR is made and no person is reached. Read what a sync would do with `directory_sync_preview`, which writes nothing in either mode. Deploy `observe` BEFORE you set `directory.provider`, so the adapter arms with the mode already in force; armed in `sync` mode, the first nightly run applies the plan.",
    } satisfies SettingSpec<DirectoryMode>,
    autoConfirm: {
      path: "directory.autoConfirm",
      shipped: "off",
      validate: (v) => (v === "off" || v === "attested" ? undefined : 'must be "off" or "attested"'),
      summary:
        "Whether the directory sync confirms a mapping itself (was `OE_DIRECTORY_AUTOCONFIRM`). `off` (shipped): every new IdP→platform mapping lands as `suggested` and waits for its person's own DM tap. `attested`: a mapping the IdP itself provisioned (the downstream platform wrote the id back) is confirmed by the sync; an `asserted` or `email-match` mapping still waits, always. There is no third value: \"confirm everything\" would make an email collision a person-merge. An Okta app mapped with `field: \"userName\"` grades `asserted`, so `attested` never confirms it.",
    } satisfies SettingSpec<DirectoryAutoConfirm>,
    groupAllowlist: {
      path: "directory.groupAllowlist",
      shipped: [] as readonly string[],
      validate: (v) => stringArray(v) ?? (v.every((t) => t.trim() !== "") ? undefined : "must hold no blank group name"),
      summary:
        "Which IdP groups the group sync reads, by their VERBATIM IdP names (was `OE_DIRECTORY_GROUP_ALLOWLIST`). Empty (shipped) syncs every group. Set, a group outside the list is neither added nor kept in the machine-owned person-group overlay, and the Okta adapter reads the members of the listed groups only (OPE-2644): one member read per listed group, not one per group in the org.",
      format: (v) => (v.length > 0 ? v.join(", ") : "(every group)"),
    } satisfies SettingSpec<readonly string[]>,
    oktaApps: {
      path: "directory.oktaApps",
      shipped: [] as readonly OktaAppSetting[],
      validate: oktaAppsProblem,
      summary:
        "The Okta application → platform table the Okta adapter syncs (was `OE_DIRECTORY_OKTA_APPS`). One entry per app: `{ platform, tenant?, appId, field? }`. `tenant` names the workspace the app's ids belong to; absent, they belong to this deployment's sole admitted workspace, and the sync still refuses a workspace the deployment never admitted. `field` says where the app-side id lives: `externalId` (default) is the SCIM write-back and grades `attested`; `userName` is usually an email an app admin can edit, so it grades `asserted` and `directory.autoConfirm` never confirms it. Two entries for one platform and workspace fail the boot.",
      format: (v) => (v.length > 0 ? v.map((a) => `${a.platform}${a.tenant ? `/${a.tenant}` : ""}:${a.appId}`).join(", ") : "(none)"),
    } satisfies SettingSpec<readonly OktaAppSetting[]>,
  },
  identityLinking: {
    codeBack: {
      path: "identityLinking.codeBack",
      shipped: false,
      summary:
        "Code-back on the DIRECTORY transport: after the named account consents in its own DM, it receives a second code the initiator must feed back to finalize. Off by default — a consent given in the target's own DM already proves both account holders agreed. The CODE transport forces the code-back whatever this says, because there the initiator's yes is the reflexable step.",
    } satisfies SettingSpec<boolean>,
  },
  delegation: {
    oneshotAgent: {
      path: "delegation.oneshotAgent",
      shipped: true,
      summary:
        "Whether this deployment DELEGATES at all. Armed, a conversational seat may forward a self-contained job with `work` to its own conversation's work session, which hands it to a full-hands worker through eve's built-in `agent`, and `spawn_thread_session` may mint a persistent thread seat. Disarming makes the whole delegation machinery inert: no session holds `work` or `agent`, `spawn_thread_session` never mounts, and the wide-hands kit widens back to the task and native grains. There is no switch between delegation ROUTES — the built-in is the only one — so the only posture this expresses is LESS delegation.",
    } satisfies SettingSpec<boolean>,
  },
  models: {
    stack: {
      path: "models.stack",
      shipped: "american-closed",
      validate: (v) => (v.trim().length > 0 ? undefined : "must be a non-empty stack alias"),
      summary:
        "The named model stack this deployment runs — one alias picks a coherent model for all five roles (primary/utility/vision/supervisor/judge). Aliases are defined in `agent/model/stacks.ts`; an unknown one fails config load. Per-role overrides layer on top there, and `models.primary` and `models.force` override the primary role last.",
    } satisfies SettingSpec<string>,
    primary: {
      path: "models.primary",
      shipped: "",
      validate: modelIdOrEmpty,
      summary:
        "The primary role's model id, over the stack's own primary (was `OE_PRIMARY_MODEL`). Empty (shipped) runs the stack's primary. It is the DEFAULT id only: a domain route that pins a concrete model id still wins over it. The derived model allow-list names this id, so the model-policy envelope accepts the model the deployment was told to run.",
      format: (v) => (v === "" ? "`` (the stack's primary)" : v),
    } satisfies SettingSpec<string>,
    force: {
      path: "models.force",
      shipped: "",
      validate: modelIdOrEmpty,
      summary:
        "A HARD PIN: one model id for EVERY resolved route (was `OE_FORCE_MODEL`). Set, it wins over the stack, over `models.primary`, over a domain's concrete route pin, over the runtime domain pick and over the model-policy envelope. Only the model id moves: the route's reasoning and provider hints and the reasoning ceiling stay as they are, and a route's `tier` is dropped. Empty (shipped) pins nothing.",
      format: (v) => (v === "" ? "`` (no pin)" : v),
    } satisfies SettingSpec<string>,
    dataPolicy: {
      path: "models.dataPolicy",
      shipped: {} as ModelDataPolicy,
      validate: validateDataPolicy,
      summary:
        "What EVERY model call demands of its provider, on every target: `{ zeroRetention?, noTraining?, region? }` (OPE-2535). `zeroRetention: true` allows only providers with a zero-data-retention agreement, `noTraining: true` only providers that do not train on prompts, and `region` (`\"eu\"` or `\"us\"`) only providers that run the inference in that region. The model adapter puts the rows on every call it serves: the turn, compaction, the utility judges, the approval judge, the meeting recap, the image describer, gateway transcription, and a bare model id string (a declared subagent's model, eve's `evaluate()`) through the AI SDK default provider the adapter installs. A call cannot remove a row. Two exceptions: under `eve dev`, eve resolves a literal model id string through its own local gateway, and those calls carry no rows; and a default provider another module set first is kept, so under a policy every call through it refuses. FAIL CLOSED: a call that no provider can serve errors and names the rows; it never falls back. With any row set, the `deepinfra` transcription route refuses, because it cannot carry the rows. Empty (shipped) demands nothing.",
      format: (v) => (dataPolicyRows(v).length === 0 ? "{} (no demand)" : dataPolicyRows(v).join(", ")),
    } satisfies SettingSpec<ModelDataPolicy>,
    targets: {
      path: "models.targets",
      shipped: SHIPPED_MODEL_TARGETS,
      validate: validateModelTargets,
      summary:
        "WHERE model calls go (OPE-2556): named targets, `{ <name>: { kind, url?, providers?: { only?, order? }, dataPolicy?, options? } }`. One kind is implemented, `\"vercel-ai-gateway\"`, and an unknown kind fails config load. A route or a stack role picks a target with `via`; with no `via` it uses the target named `gateway`, which must exist. A bare model id (a declared subagent's model, eve's `evaluate()`) uses the target of the stack role that names the id, else the primary role's target (OPE-2566), so it never falls back to `gateway` while the primary names another target. That holds when the app's `agent/model/models.ts` calls `registerBareModelRoutes`: an app scaffolded before 0.8.0 does not, so its bare ids go through `gateway`, the process logs that once, and `npm run check:model-config` exits 1 on it; `npm run check:model-config` and `oe sovereignty` name each declared subagent (`agent/subagents/*`) with the target its model goes through, and flag a model that no role names; eve's `evaluate()` model is not listed, and it takes the primary role's target. `url` is the target's base URL (for example a relay or an on-prem gateway); it replaced the `OE_AI_GATEWAY_URL` env var, which OPE-2650 deleted: nothing reads that variable any more. It is read once, at the target's first call, so a change needs a restart. `providers.only` is a DEMAND: only those providers may serve a call through the target, a call cannot widen the list, and a model with no allowed provider fails closed with an error that names the row. Under `eve dev`, eve resolves a literal model id through its own local gateway, and that call carries no `only` row. `providers.order` is a preference for the order the gateway tries providers in; a route's `providerOrder` wins over it. `dataPolicy` (OPE-2531) holds `models.dataPolicy` rows that every call through the target demands on top of the deployment's own: a target adds a row and never removes one, and two different regions refuse the call. `options` are gateway options for every call through the target, as a floor (a call's own key wins); an option that a typed row owns (`only`, `order`, `zeroDataRetention`, `disallowPromptTraining`, `inferenceRegion`) fails config load. Shipped: one `gateway` target with no rows, so no request changes.",
      format: (v) =>
        Object.entries(v)
          .map(([name, t]) => `${name}: ${modelTargetWords(t)}`)
          .join("; "),
    } satisfies SettingSpec<ModelTargets>,
  },
  discord: {
    autoThread: {
      path: "discord.autoThread",
      shipped: true,
      summary:
        "Reply in a thread when the bot is @mentioned in a Discord text or announcement channel (never inside a thread — threads don't nest, and an unknown channel type keeps the inline reply).",
    } satisfies SettingSpec<boolean>,
    statusUx: {
      path: "discord.statusUx",
      shipped: true,
      summary:
        "The Discord 'working' affordances — the 👀/✅ reaction and the holding message edited into the reply. Off, the surface behaves exactly as before the feature: one plain reply post, no reaction, no holding message.",
    } satisfies SettingSpec<boolean>,
    applicationId: {
      path: "discord.applicationId",
      shipped: "",
      validate: digitsOrEmpty,
      summary:
        "Which Discord application this deployment is, its numeric application id (was `DISCORD_APPLICATION_ID`, OPE-2650). The boot-time command sync registers the slash commands on it, and the channel uses it when an interaction carries no application id of its own. Empty (shipped) ⇒ the command sync skips; replies to an interaction still go out, because each interaction names its application. The bot token stays out of Git. See docs/deploy/surfaces/discord.md.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
    publicKey: {
      path: "discord.publicKey",
      shipped: "",
      validate: (v: string) => (typeof v === "string" && /^([0-9a-fA-F]{64})?$/u.test(v) ? undefined : 'must be the 64-character hex public key, or "" for unset'),
      summary:
        "That application's interaction PUBLIC key, in hex (was `DISCORD_PUBLIC_KEY`, OPE-2650). The Interactions route and the webhook-events route verify every delivery's Ed25519 signature against it. It is public by design, so Git can hold it. Empty (shipped) ⇒ unset: both routes refuse every delivery.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
  },
  egress: {
    enforce: {
      path: "egress.enforce",
      shipped: true,
      summary:
        "Apply the compiled per-session egress policy for real. Off ⇒ dry-run (compile + audit, no apply) — except a COMPILE ERROR, whose deny-all is applied either way: dry-run relaxes the intended policy, never a failure to compute one.",
    } satisfies SettingSpec<boolean>,
    allowUnenforced: {
      path: "egress.allowUnenforced",
      shipped: false,
      summary:
        "Let a session CONTINUE when the sandbox backend cannot apply fine-grained network policy. Off, an unenforceable policy aborts the session instead of running it unfirewalled. Dev and self-host-without-a-proxy only — a deployment that needs it says so in `agent/settings/settings.ts`, where the choice is reviewable.",
    } satisfies SettingSpec<boolean>,
    proxyUrl: {
      path: "egress.proxyUrl",
      shipped: "",
      validate: httpUrlOrEmpty,
      summary:
        "The self-host egress proxy's CONTROL origin, which every session's compiled policy is pushed to (was `OE_EGRESS_PROXY_URL`, OPE-2650). The compose topology's value is `http://oe-egress-proxy:8080`. Set, and with the agent's shell off the Vercel Sandbox, every session's policy goes to the proxy, the push presents the operator secret `OE_EGRESS_PROXY_TOKEN`, and a failed push aborts the session. Empty (shipped) ⇒ no proxy: on a self-host, a session that needs a host allow-list aborts unless `egress.allowUnenforced` is on. Inert on the Vercel Sandbox. `sandbox.selfHostBackend: \"docker\"` with this set refuses to boot. See docs/deploy/platforms/self-host-egress.md.",
      format: (v) => (v === "" ? "(unset)" : v),
    } satisfies SettingSpec<string>,
    sourceIp: {
      path: "egress.sourceIp",
      shipped: "",
      validate: ipOrEmpty,
      summary:
        "The source IP the self-host egress proxy keys this deployment's pushed policy on (was `OE_EGRESS_SOURCE_IP`, OPE-2650). Empty (shipped) ⇒ the proxy keys the policy by the push's own remote address, which is right whenever the app pushes from the address it also sends from. Inert without `egress.proxyUrl`.",
      format: (v) => (v === "" ? "(unset)" : v),
    } satisfies SettingSpec<string>,
    denialLog: {
      path: "egress.denialLog",
      shipped: "",
      validate: (v: string) => (v === "" || (v.startsWith("/") && !v.includes("\0")) ? undefined : 'must be an absolute path, or "" for unset'),
      summary:
        "The path of the egress proxy's denial log, as the APP container sees it on the shared volume (was `OE_EGRESS_DENIAL_LOG`, OPE-2650). The compose topology's value is `/var/log/oe-egress/denied.log`. Set, the app tails the log and writes one `egress.denied` audit row per host and policy generation. Empty (shipped) ⇒ the poller does not run, and proxy denials reach no audit row. See docs/deploy/platforms/self-host-egress.md.",
      format: (v) => (v === "" ? "(unset)" : v),
    } satisfies SettingSpec<string>,
  },
  externalPolicy: {
    authorGrain: {
      path: "externalPolicy.authorGrain",
      shipped: "withhold",
      validate: (v) => (v === "taint" || v === "withhold" ? undefined : 'must be "taint" or "withhold"'),
      summary:
        'What the agent does with a message an EXCLUDED author wrote — an author the SURFACE positively refuted (Slack `is_restricted`/`is_ultra_restricted`/`is_stranger`, Entra `userType: "guest"`) or the OPERATOR\'s author-trust register refuted (`agent/identity/authors.ts`, Discord and Notion). `withhold` (shipped) stops the text ENTERING: an @mention or DM from that author gets a private notice and no action, ambient engagement never triggers on their messages, and their reply inside a permitted member\'s thread reaches the model as an arrived-marker with no body. It binds the READ verbs too: `read_channel`/`read_thread` replace that author\'s message text with the same arrived-marker, so a body a wake suppressed cannot be fetched back by reading the channel. A withheld body never ingests, so it never keys taint. The two mechanisms COEXIST — the envelope is provenance-based and stays as it is; withhold is identity-based. On Discord and Notion, where the operator\'s register is the only evidence, a tenant the operator has NOT armed excludes nobody, so `withhold` changes nothing there. `taint` is the deliberate OPT-OUT: it lets the text enter the context inside the untrusted-content envelope and leaves the consequence to the tainted-turn model and the approval plane. Choose it only where an excluded author\'s text must reach the model. \u26a0\ufe0f EVERY CHAT SURFACE READS IT, BUT THE EVIDENCE DIFFERS PER SURFACE. Slack and Teams refute an author themselves; Discord and Notion read the operator\'s register; GitHub refutes on the comment\'s `author_association` (`OWNER`, `MEMBER` and `COLLABORATOR` each hold a deliberate access grant and are internal — every other value, `CONTRIBUTOR` and `MANNEQUIN` included, is excluded); Linear refutes a workspace guest (`User.guest`). \u26a0\ufe0f GITHUB AND LINEAR HAVE NO PRIVATE CHANNEL back to a commenter, so an AMBIENT excluded author\'s message is a silent drop with an audit row and nothing posted. An explicit @mention from an excluded author still gets one fixed, identity-blind acknowledgement line (`EXTERNAL_MENTION_ACK` — names no person, no organisation, no setting, no verdict) on both surfaces, so the mentioning member never reads the agent as broken; on Linear it posts as a `response` Agent Activity, which also ends the session, so no spinner is left open. One known limit elsewhere — Discord\'s hydrated context lines are not filtered, so an excluded author quoted there still reaches the model when the TRIGGER author is permitted. EVERY chat reader — `read_channel`/`read_thread` and the delegated worker\'s `read_work_channel`/`read_work_thread` — routes through ONE grade-and-project body (`readChannelResult`/`readThreadResult`), so the author-taint mark and the `withhold` read half are declared once and no reader can declare them differently.',
    } satisfies SettingSpec<ExternalAuthorGrain>,
    roomGrain: {
      path: "externalPolicy.roomGrain",
      shipped: "silent",
      validate: (v) => (v === "engage" || v === "silent" ? undefined : 'must be "engage" or "silent"'),
      summary:
        "Whether the agent engages in a room the classification calls EXTERNAL — a room the operator declared `public` in the trust registry, a room the vendor reports as spanning another organisation (Slack Connect, a Teams shared channel), or a room whose ingested set contains a refuted author. `silent` (shipped) suppresses the wake and announces at most twice per room — once on join, once on the first wake it suppresses — and never repeats; there is deliberately NO periodic re-announcement. `engage` is the deliberate OPT-OUT: the agent answers in an external room as it does in an internal one. A room that no leg classifies external is never silenced, so a member-only room sees no change. ⚠️ NOT EVERY SURFACE READS IT THE SAME WAY: `silent` suppresses a wake on SLACK, DISCORD, TEAMS, GITHUB and LINEAR. Discord and Teams post the suppressed-wake notice only, because neither surface delivers a join event the agent can hang the join notice on. Slack posts both halves, but its JOIN half fires only where `conversations.info` already refused the channel as not-internal — a channel the operator declared `public` that Slack reports internal is still silenced and still announces at its first suppressed wake, but gets no join notice. GitHub and Linear read the OPERATOR-DECLARED leg and the REFUTED-AUTHOR leg (neither surface has a vendor-external signal) and post NO announcement on either half — neither has a private channel back to a commenter, so an AMBIENT or NAME-DROP wake it silences is a silent drop with an audit row and nothing posted. An explicit @mention still gets the same fixed, identity-blind acknowledgement line every other silenced surface's addressed suppression gets; on Linear it posts as a `response` Agent Activity, which also ends the session. ⚠️ `silent` HAS NO CONFIG-VALIDATION ERROR FOR A HALF-DECLARATION, ONLY A BOOT WARNING: the EXTERNAL classification has three legs and only the OPERATOR-DECLARED one is visible in static config, so a domain that sets `roomGrain: \"silent\"` with no matching `public` trust entry gets a `console.warn` at boot naming the channel, not a boot failure — a vendor-external or guest-present signal can still arm it correctly at runtime, and refusing boot on that shape would be a false positive (`agent/lib/register-config.ts` calls `warnSilentRoomGrainWithoutPublicSignal`, `packages/core/agent/memory/domain.ts`).",
    } satisfies SettingSpec<ExternalRoomGrain>,
  },
  github: {
    auth: {
      path: "github.auth",
      shipped: "app" as GithubAuthMode,
      validate: (v: GithubAuthMode) => (v === "app" || v === "token" ? undefined : 'must be "app" or "token"'),
      summary:
        "How this deployment signs in to GitHub (OPE-2530). There is ONE credential and NO fallback between the two. `app` (shipped) — the GitHub App (the `github.appId` and `github.appSlug` settings, and the operator secret `GITHUB_APP_PRIVATE_KEY`): every call mints a short-lived token narrowed to its repository and its job, and `GITHUB_TOKEN` is never read, even when it is set. A repository the App is not installed on is refused by name. `token` — the personal access token in `GITHUB_TOKEN`, for an organisation that will not create a GitHub App. It reaches ONLY the deployment's own repository (`accessRequests.configRepo`) and the repositories `github.tokenRepos` names, and only where a bundle also grants the repository to the room. Checkout, pull requests and the config-change pull requests work there. The App is never used in this mode: the GitHub webhook route runs only the event-routine fan-out and starts no conversation, and GitHub search and GitHub-backed memory are off. The token cannot be narrowed per session the way an App token is: checkout injects it at the sandbox firewall only on the two exact clone and fetch requests of each repository it reaches (whole-path matches, never a prefix), and refuses on a backend without the firewall. Use a fine-grained token limited to those repositories. TO MOVE TO THE APP, in this order: create it with the ops MCP tool `surface_app_create` (`variant: \"source-control\"` keeps what token mode does); commit the public values its status reply returns as `settings` (`github.appId`, `github.appSlug`, `github.appClientId`, `github.botUserId`, `github.conversation`) to `agent/settings/settings.ts`; store the two secrets it wrote to `.env.local` with the ops tool `secret_set` (`GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`); set this to `app` and redeploy; then install the App (a token-mode deployment ignores the App's `installation` delivery, so installing first leaves app mode with no installation). The App brings its own `GITHUB_WEBHOOK_SECRET`, which replaces the old one: a repository webhook that feeds event routines needs the new secret, and with `source-control` (no event subscriptions) it stays the only source of those events. With `full`, delete that webhook, or each event reaches your routines twice. Nothing else changes: the grants stay, and `github.tokenRepos` stops being read. See docs/capabilities/source-control.md.",
    } satisfies SettingSpec<GithubAuthMode>,
    tokenRepos: {
      path: "github.tokenRepos",
      shipped: [] as readonly string[],
      validate: (v: readonly string[]) =>
        Array.isArray(v) && v.every((r) => typeof r === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(r))
          ? undefined
          : 'must be a list of repositories, each "owner/repo"',
      summary:
        "With `github.auth: \"token\"`, the repositories the personal access token reaches BESIDES the deployment's own repository (`accessRequests.configRepo`), each `owner/repo`. A repository here is still reached only where a bundle grants it to the room. Empty (shipped) ⇒ the token reaches the deployment's own repository and nothing else. Inert with `github.auth: \"app\"`, where the App's installations decide the reach, so moving to the App needs no edit here.",
      format: (v) => (v.length > 0 ? v.join(", ") : "(none — the deployment's own repository only)"),
    } satisfies SettingSpec<readonly string[]>,
    appId: {
      path: "github.appId",
      shipped: "",
      validate: digitsOrEmpty,
      summary:
        "The GitHub App's numeric id (was `OE_GITHUB_APP_ID` and `GITHUB_APP_ID`, OPE-2650). The source-control plane and the GitHub conversation surface both mint as this App. Empty (shipped) ⇒ no App: source control is off, and the conversation surface posts nothing. The App's private key and webhook secret stay out of Git. `surface_app_create` returns this value. See docs/capabilities/source-control.md.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
    appSlug: {
      path: "github.appSlug",
      shipped: "",
      validate: (v: string) => (typeof v === "string" && /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$/u.test(v) ? undefined : 'must be the App\'s lowercase slug, or "" for unset'),
      summary:
        "The GitHub App's slug, its `@mention` handle without `[bot]` (was `OE_GITHUB_APP_SLUG` and `GITHUB_APP_SLUG`, OPE-2650). The conversation surface wakes on `@<slug>` only when `github.conversation` is on: off, no mention wakes and every ambient comment drops, so a `source-control` App starts no conversation. The agent knows its own comments by `<slug>[bot]`. The source-control plane needs it beside `github.appId`. Empty (shipped) ⇒ unset: source control is off, and no mention wakes the agent.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
    appClientId: {
      path: "github.appClientId",
      shipped: "",
      validate: idOrEmpty,
      summary:
        "The GitHub App's PUBLIC OAuth client id (was `OE_GITHUB_APP_CLIENT_ID`, OPE-2650). GitHub accepts it as the issuer of the App's JWT, so the plane signs with it when it is set. Empty (shipped) ⇒ the plane signs with `github.appId`.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
    botUserId: {
      path: "github.botUserId",
      shipped: "",
      validate: digitsOrEmpty,
      summary:
        "The GitHub user id of the App's bot user, `<slug>[bot]` (was `OE_GITHUB_BOT_USER_ID`, OPE-2650). The source-control plane writes it into the commit e-mail, so GitHub attributes each commit to the App. Empty (shipped) ⇒ the plane falls back to the App id. `surface_app_create` returns this value.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
    conversation: {
      path: "github.conversation",
      shipped: false,
      summary:
        "Whether the GitHub CONVERSATION surface is armed (OPE-2650): an `@<github.appSlug>` mention in an issue, a pull request or a review comment starts a session, and comments in an engaged thread follow. Off (shipped) ⇒ no comment starts a conversation and every ambient comment drops; the source-control plane, the event routines and the `installation` registration work as before. Turn it on only for the `full` App, which subscribes to comment events: `surface_app_create` returns `github.conversation: true` for that variant. A `source-control` App leaves it off. See docs/deploy/surfaces/github.md.",
    } satisfies SettingSpec<boolean>,
    installations: {
      path: "github.installations",
      shipped: {} as Readonly<Record<string, string>>,
      validate: githubInstallationsProblem,
      summary:
        "Owner login → GitHub App installation id, each id a numeric string (was `OE_GITHUB_INSTALLATIONS`, and the `OE_GITHUB_OWNER` + `OE_GITHUB_INSTALLATION_ID` pair, OPE-2650). An owner listed here resolves to its id, and this table wins over a webhook-discovered installation of the same owner. Empty (shipped) ⇒ the installations the App's `installation` webhook registered are the only ones, which is enough for most deployments.",
      format: (v) => (Object.keys(v).length === 0 ? "{} (webhook-discovered only)" : JSON.stringify(v)),
    } satisfies SettingSpec<Readonly<Record<string, string>>>,
  },
  governance: {
    floorTtlMs: {
      path: "governance.floorTtlMs",
      shipped: 15 * 60_000,
      validate: positiveNumber,
      summary:
        "Memoisation TTL for the room roster and the governance attestation behind the audience floor — the one computation shared by the admin-governance floor, the connector-disclosure floor, the triggered-fire disclosure floor, the approval-card clicker floor and the card-disclosure floor. It applies in full to a RESOLVED roster only. An unresolved answer (a failed or rate-limited membership read, a non-shared room larger than one members page, a room the app cannot read) is memoised for at most 30 s (`UNRESOLVED_ROSTER_TTL_MS` in access/audience-floor.ts), because the observed-guest legs of the four non-governance floors are inert on it, and a memoised failure disarms them for as long as it is held (OPE-2150). Two legs refuse instead, and for them the 30 s memo bounds a refusal window: the clicker floor's beneficiary leg on any unresolved roster, and the connector-disclosure floor on a FAILED one (a transient read failure on an askable surface, Slack today, OPE-2306). An UNOBSERVABLE roster (a surface that cannot be asked, or a steady-state non-answer) leaves the connector-disclosure floor inert. The governance attestation memo still holds a disarmed attestation for the TTL — that direction is closed.",
      format: (v) => `${v} ms`,
    } satisfies SettingSpec<number>,
  },
  identity: {
    dmTrustTtlMs: {
      path: "identity.dmTrustTtlMs",
      shipped: 5 * 60_000,
      validate: positiveNumber,
      summary:
        "Memo TTL for live trust verification on every surface that performs one — the Slack per-author membership probe (which answers both the DM-partner question and a channel author's own standing), the Slack channel-internal cache, the Teams member/guest lookup and the Linear guest lookup. One knob, because it is one question asked four ways; a miss re-verifies against the platform.",
      format: (v) => `${v} ms`,
    } satisfies SettingSpec<number>,
    name: {
      path: "identity.name",
      shipped: "",
      validate: (v) =>
        /[\n\r]/u.test(v) ? "must not contain a line break" : v.length > 64 ? "must be at most 64 characters" : undefined,
      summary:
        "The deployment's CANONICAL agent name — the ONLY name the agent calls itself, on every surface (OPE-610). Unset (the shipped `\"\"`) renders the generic identity line (\"Identify as this team's agent\") even where a surface has a live display-name arm: a per-surface app's own name is a HANDLE/address, never a substitute identity, so it never feeds the identity line. Each provider bundle registers that arm (`agent/identity/bot-display-name.ts`); Slack, Microsoft Teams and Discord ship one, rendered as a separate handle line (\"your mention/handle on X appears as Y\") for self-recognition of mentions/backscroll — the other surfaces resolve no handle. Configuring this setting matters most for a CROSS-SURFACE session, which speaks on several surfaces from one standing block: before this setting existed, a Teams delivery introduced the agent by the SLACK workspace display name (OPE-569). Set it and one name answers everywhere, on the per-surface path and the cross-surface path alike. It ALSO joins the name-drop token set (`agent/identity/bot-name.ts`) that the Notion synthetic-mention recogniser and the addressed link-claim hook match on, so the agent answers to the name it introduces itself by. 🔴 It REPLACES the brand there (OPE-2334): with this setting or `identity.shortName` set, ONLY the configured names (and a surface's platform-resolved integration name) match, and the brand tokens \"open everywhere\" and \"oe\" match only on a deployment that configures no name. The same name also renders every install artifact (the Slack and Teams app manifests) and every user-facing and model-facing string that used to spell the brand; unset, those fall back to the brand default \"Open Everywhere\" or a neutral phrase. It ALSO joins the SLACK, DISCORD and TEAMS ambient name-drop wake trigger set (OPE-571, Teams since OPE-2444), alongside those surfaces' own live display names — see `wake.nameDrop.include`/`wake.nameDrop.exclude` to extend or narrow that set further.",
      format: (v) => (v === "" ? "`` (unset — generic identity line; per-surface handle still shown separately where resolved)" : v),
    } satisfies SettingSpec<string>,
    shortName: {
      path: "identity.shortName",
      shipped: "",
      validate: (v) =>
        /[\n\r]/u.test(v)
          ? "must not contain a line break"
          : v.length > 32
            ? "must be at most 32 characters"
            : v !== "" && v.trim().length < 2
              ? "must be at least 2 characters (a shorter token is never matched)"
              : undefined,
      summary:
        "The agent's SHORT name (OPE-2334) — a second name token beside `identity.name`, for the abbreviation people type (\"ari\" for \"Aria\"). It joins the name-drop token set (`agent/identity/bot-name.ts`) that the Notion synthetic-mention recogniser and the addressed link-claim hook match on. Setting it, like setting `identity.name`, makes the CONFIGURED names the only wake tokens: the brand tokens \"open everywhere\" and \"oe\" stop matching. It does NOT join the Slack/Discord/Teams ambient name-drop set, which stays narrow on purpose — add it to `wake.nameDrop.include` to widen that set. Unset (the shipped `\"\"`) adds no token.",
      format: (v) => (v === "" ? "`` (unset — no short-name token)" : v),
    } satisfies SettingSpec<string>,
    commandName: {
      path: "identity.commandName",
      shipped: "oe",
      validate: (v) =>
        /^[a-z0-9][a-z0-9_-]{0,30}$/u.test(v)
          ? undefined
          : "must be 1-31 lowercase letters, digits, `-` or `_`, starting with a letter or digit, with no slash",
      summary:
        "The name of the zero-inference control-plane slash command, without its slash (OPE-2334). Shipped `oe`, so the command is `/oe`. It reaches every place the command name lives: the Slack app manifest's `slash_commands` entry, the Slack command route's own name check, Discord's command registration and interaction-router match, and the help, acknowledgement and error text the commands render. ⚠️ CHANGING IT IS AN INSTALL STEP, NOT ONLY A DIFF: Slack registers the command from the manifest, so paste the re-rendered manifest (`surface_manifest`) into the Slack app; Discord registers it at boot under the new name, and the old command stays listed until it is deleted in the Discord developer portal.",
      format: (v) => `/${v}`,
    } satisfies SettingSpec<string>,
    allowMultiTenantPrincipals: {
      path: "identity.allowMultiTenantPrincipals",
      shipped: false,
      summary:
        "The opt-out of the multi-tenant principal fence (was `OE_ALLOW_MULTI_TENANT_PRINCIPALS=1`). On a tenant-scoped platform (Slack) a person id is issued PER WORKSPACE while a principal key is only `platform/id`, so two workspaces can hand one person another's standing on an id collision. Off (shipped), config load refuses a deployment that declares two tenants of one such platform, and the wake door drops a delivery from a tenant no domain declares. On accepts that known aliasing exposure for the whole deployment.",
    } satisfies SettingSpec<boolean>,
    blanketTrust: {
      path: "identity.blanketTrust",
      shipped: "none",
      validate: (v) => (v === "none" || v === "internal" || v === "external" ? undefined : 'must be "none", "internal" or "external"'),
      summary:
        "A deployment-wide trust declaration for the bindings no platform mapper verifies (was `OE_TRUST`). `none` (shipped) declares nothing: a real platform that cannot verify a surface fails closed to `external`, and the local stand-in binding is `internal`. `internal` is the single-tenant opt-in: it raises an unverified surface to internal, lets an unvouched DM partner read the shared DM layer, and satisfies the multi-source window vouch and the governance vouch at config load. It never overrides a platform mapper's own verdict or a surface the operator declared `public`. `external` forces the local stand-in binding to external, which a test uses to drive the fail-closed path. Prefer a per-surface declaration in `agent/identity/surfaces.ts`: it names WHICH rooms are internal.",
    } satisfies SettingSpec<BlanketTrust>,
  },
  language: {
    output: {
      path: "language.output",
      shipped: "",
      validate: (v) => languageTagProblem(v),
      summary:
        "The org-level OUTPUT LANGUAGE, as a BCP 47 tag (`\"fr\"`, `\"de\"`, `\"pt-BR\"`, `\"ja\"`). Empty (shipped) adds no language rule, so the model answers in the language it is addressed in. Set, every session's prompt carries one section: the seat and every worker it delegates to write in that language, unless the person writes in another language or asks for another one, and code, commands, identifiers and quoted text stay as they are. A domain overrides it with its own `language` field in `agent/memory/config/domains.ts`; an explicit domain without one inherits the `org` pseudo-domain's, then this value. The tag is checked with `Intl.getCanonicalLocales` at boot, and a bad tag fails the boot. It is an instruction to the model, not a translation layer: card text, slash-command output and other host-rendered strings stay in English.",
      format: (v) => (v === "" ? '"" (no language rule)' : JSON.stringify(v)),
    } satisfies SettingSpec<string>,
  },
  linear: {
    appName: {
      path: "linear.appName",
      shipped: "",
      validate: (v: string) => (typeof v === "string" && !/[\r\n]/u.test(v) ? undefined : "must be one line"),
      summary:
        "The primary Linear app's display name (was `LINEAR_APP_NAME`, OPE-2650). The Linear surface knows a mention of itself by it. Empty (shipped) ⇒ the surface asks Linear for its own name once and caches it. A registered OAuth app's own name wins over this setting.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
    appUserId: {
      path: "linear.appUserId",
      shipped: "",
      validate: idOrEmpty,
      summary:
        "The primary Linear app's own user id (was `LINEAR_APP_USER_ID`, OPE-2650). The Linear surface knows its own comments by it, so it never wakes on them. Empty (shipped) ⇒ resolved live from Linear once and cached. A registered OAuth app's own id wins over this setting.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
    clientId: {
      path: "linear.clientId",
      shipped: "",
      validate: idOrEmpty,
      summary:
        "The primary Linear OAuth app's client id, the public half of its client-credentials pair (an env var until OPE-2650; the Linear provider names it). With it and `LINEAR_CLIENT_SECRET`, the surface mints and caches its own token when no static token is set. Empty (shipped) ⇒ no client-credentials mint for the primary app.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
    organizationId: {
      path: "linear.organizationId",
      shipped: "",
      validate: idOrEmpty,
      summary:
        "The Linear organization the primary credential belongs to (was `LINEAR_ORGANIZATION_ID`, OPE-2650). Set ⇒ a delivery or a call for a DIFFERENT organization that no registered app claims fails closed, and never falls back to the primary credential. Empty (shipped) ⇒ the primary credential serves an unknown organization too, which suits a one-organization deployment.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
  },
  memory: {
    dreamCandidateCap: {
      path: "memory.dreamCandidateCap",
      shipped: 10,
      validate: positiveInt,
      summary: "Per-silo judge budget for the dream/tidy sweep — how many candidate memories one pass may put in front of the judge.",
    } satisfies SettingSpec<number>,
    skillProposalPr: {
      path: "memory.skillProposalPr",
      shipped: true,
      summary:
        "Whether a Mode-1 SKILL proposal also opens a PULL REQUEST on the config repo (`accessRequests.configRepo`), adding the drafted skill under `.agents/skills/<name>/SKILL.md` on its own branch. It ships ON, and it acts only where the deployer configured a config repo: with no `accessRequests.configRepo` the proposal is recorded in the review queue, nothing reaches GitHub, and nothing errors. A config repo in dry-run mode (`dryRun: true` in `agent/access/access-requests.ts`) holds this write like every other config-repo write: the attempt is audited with `dryRun: true`, and no branch or pull request is opened. `false` is the opt-out, and keeps the v1 behaviour on every deployment: the review-queue row only. On, MERGING the pull request is what arms the skill — the cycle never merges, never pushes to the base branch, and needs no credential beyond the one the access-request and credential-binding flows already use. A person's review or comment on a proposal is read back as a CORRECTION and carried into the next proposal for that scope, and only an author with repository standing (GitHub's `author_association`: OWNER, MEMBER or COLLABORATOR) counts.",
    } satisfies SettingSpec<boolean>,
    syncTiming: {
      path: "memory.syncTiming",
      shipped: false,
      summary:
        "A measurement mode (was `OE_MEMORY_SYNC_TIMING=1`): write one `memory.sync_timing` audit row per session, with each read silo's load, sync and lock time, so a session's boot time can be attributed and not only bounded. Off (shipped), the memory hook allocates nothing, reads no clock and adds no await. On costs a durable row per session and one store insert inside the boot window, so arm it while you investigate where boot time goes, then disarm it. The row holds names, counts, sizes and durations only — never content.",
    } satisfies SettingSpec<boolean>,
    provider: {
      path: "memory.provider",
      shipped: "",
      validate: (v: string) => (v === "" || /^[a-z][a-z0-9-]*$/u.test(v) ? undefined : 'must be a backing id ("git", "sqlite", "postgres"), or "" to let DATABASE_URL decide'),
      summary:
        "Which durable memory backing this deployment uses: `git`, `sqlite` or `postgres` (was `OE_MEMORY_PROVIDER`, OPE-2650). Empty (shipped) ⇒ `DATABASE_URL` decides: set, it selects `postgres`; unset, the `git` floor. Name `postgres` only with a registered Postgres client, or the first DM or personal memory call throws. The compose topology without Postgres declares `sqlite`.",
      format: (v) => (v === "" ? "(DATABASE_URL decides)" : v),
    } satisfies SettingSpec<string>,
    gitBranch: {
      path: "memory.gitBranch",
      shipped: "main",
      validate: branchName,
      summary: "The branch the GitHub memory backing reads and commits to in each silo's repository (was `OE_MEMORY_GIT_BRANCH`, OPE-2650).",
    } satisfies SettingSpec<string>,
    notionTokenSecret: {
      path: "memory.notionTokenSecret",
      shipped: "db:notion:memory",
      validate: (v: string) => (typeof v === "string" && v !== "" && !/\s/u.test(v) ? undefined : "must be one credential-store name, with no whitespace"),
      summary:
        "The db credential-store NAME of the org-default Notion memory token (was `OE_NOTION_SECRET_REF`, OPE-2650). Store the token with `oe secret set <name>`. 🔴 It resolves from the db credential store ONLY, never from an environment variable, so it cannot reach an env-held secret such as `DATABASE_URL`. It CAN name any stored operator secret, and the org-default Notion read sends that value to Notion, so review the name in the pull request. `OE_NOTION_SECRET_BROKER` is gone with it. A domain that binds its own Notion `memory` credential resolves that credential instead.",
    } satisfies SettingSpec<string>,
  },
  observability: {
    logShip: {
      path: "observability.logShip",
      shipped: { url: "" } as LogShipSetting,
      validate: logShipProblem,
      summary:
        "Where this deployment ships its structured logs: `{ url, tokenHeader?, service? }` (was `OE_LOG_SHIP_URL`, `OE_LOG_SHIP_TOKEN_HEADER` and `OE_LOG_SERVICE`, OPE-2650). `url` is the full ingest URL of any endpoint that takes a JSON array (Axiom, Better Stack, a local collector). `tokenHeader` (default `authorization`) names the header that carries the operator secret `OE_LOG_SHIP_TOKEN`, stored with `oe secret set OE_LOG_SHIP_TOKEN`. `service` (default `open-everywhere`) stamps every record. An empty `url` (shipped) ⇒ nothing ships and console output is unchanged. See docs/deploy/observability.md.",
      format: (v) => (v.url === "" ? "(off)" : v.url),
    } satisfies SettingSpec<LogShipSetting>,
  },
  notion: {
    botName: {
      path: "notion.botName",
      shipped: "",
      validate: (v: string) => (typeof v === "string" && !/[\r\n]/u.test(v) ? undefined : "must be one line"),
      summary:
        "The Notion bot's display name, which the mention judge reads (was `NOTION_BOT_NAME`, OPE-2650). Empty (shipped) ⇒ the surface asks Notion for the bot's name once and caches it.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
    botUserId: {
      path: "notion.botUserId",
      shipped: "",
      validate: idOrEmpty,
      summary:
        "The org-default Notion integration's bot user id (was `NOTION_BOT_USER_ID`, OPE-2650). The surface knows its own comments by it. It pins the ORG-DEFAULT integration only: a per-domain integration always resolves its own id live, so this value can never make one integration read another's comments as its own (OPE-1921). Empty (shipped) ⇒ resolved live once and cached.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
  },
  policyPages: {
    privacy: {
      path: "policyPages.privacy",
      shipped: "",
      validate: policyTextProblem,
      summary:
        "The operator's PRIVACY POLICY, served as `GET /privacy` — the URL the rendered Teams app manifest (`packages/providers/teams/agent/app-manifest.ts`, served by `surface_manifest`) declares as `privacyUrl`. Free text, rendered ESCAPED and as PLAIN TEXT with its line breaks kept: never as HTML and never as markdown, so the route cannot become a way to serve arbitrary markup from this deployment's origin. Empty (shipped) ⇒ the route answers 200 with a placeholder page saying no policy is published yet and naming this setting; it never 404s, because a manifest pointing at a 404 is the defect the route exists to remove.",
      format: (v) => (v === "" ? "`` (unset — `/privacy` serves the placeholder page)" : "the operator's own text"),
    } satisfies SettingSpec<string>,
    terms: {
      path: "policyPages.terms",
      shipped: "",
      validate: policyTextProblem,
      summary:
        "The operator's TERMS OF USE, served as `GET /terms` — the URL the rendered Teams app manifest (`packages/providers/teams/agent/app-manifest.ts`, served by `surface_manifest`) declares as `termsOfUseUrl`. Same rendering and same unset behaviour as `policyPages.privacy`.",
      format: (v) => (v === "" ? "`` (unset — `/terms` serves the placeholder page)" : "the operator's own text"),
    } satisfies SettingSpec<string>,
  },
  schedules: {
    sweepOrgs: {
      path: "schedules.sweepOrgs",
      shipped: ["default"] as readonly string[],
      validate: (v) => tokenArray(v) ?? (v.length > 0 ? undefined : "must name at least one org"),
      summary:
        "The orgs the scheduled sweeps cover — the tidy sweep, dream mode 3 and the daily directory sync (was `OE_TIDY_ORGS`). Shipped `[\"default\"]`, the single-operator org. A multi-org deployment lists each org its sweeps run for; an org not listed is never swept.",
      format: (v) => v.join(", "),
    } satisfies SettingSpec<readonly string[]>,
  },
  routines: {
    eventMaxFanout: {
      path: "routines.eventMaxFanout",
      shipped: 3,
      validate: positiveInt,
      summary:
        "Max routines ONE inbound event may fan out to. Every over-cap match is a genuine drop, so it writes a throttled `routine.skip` audit row (reason `fanout_cap`) rather than silently not firing.",
    } satisfies SettingSpec<number>,
    maxConcurrency: {
      path: "routines.maxConcurrency",
      shipped: 3,
      validate: positiveInt,
      summary:
        "Max routine ROOT sessions started per dispatcher tick. The rest stay claimable and fire on a later tick (their `nextRunAt` is untouched, so they remain due).",
    } satisfies SettingSpec<number>,
    jobMaxFires: {
      path: "routines.jobMaxFires",
      shipped: 200,
      validate: positiveInt,
      summary: "Fire cap minted onto a fresh durable-job bound. Plain `cron`/`interval` routines carry no ceiling: the check-in (`routines.attentionWarnRuns`) is what pauses one that nobody looks at.",
    } satisfies SettingSpec<number>,
    jobMaxDays: {
      path: "routines.jobMaxDays",
      shipped: 7,
      validate: positiveInt,
      summary: "Wall-clock grace minted onto a fresh durable-job bound, in days. Stretched so a slow cadence still gets a fair sample of runs.",
      format: (v) => `${v} d`,
    } satisfies SettingSpec<number>,
    attentionWarnRuns: {
      path: "routines.attentionWarnRuns",
      shipped: 100,
      validate: (v) => (Number.isInteger(v) && v >= 0 ? undefined : "must be a non-negative integer (0 turns the check off)"),
      summary:
        "Runs a recurring clock routine makes with no human check-in before it posts a Keep going card where its reports land (OPE-2511). A check-in is a press of that card, a Resume, or a carded edit, rule change or re-enable. `0` turns the check off. One-time and event routines are not counted.",
    } satisfies SettingSpec<number>,
    attentionPauseRuns: {
      path: "routines.attentionPauseRuns",
      shipped: 24,
      validate: positiveInt,
      summary:
        "Further runs after the Keep going card before the routine pauses itself and posts a Resume card. Counted from the run the card actually posted, so a routine never pauses without a warning.",
    } satisfies SettingSpec<number>,
    discoveryMinWeeks: {
      path: "routines.discoveryMinWeeks",
      shipped: 3,
      validate: (v) => (Number.isInteger(v) && v >= 0 && v <= 5 ? undefined : "must be an integer from 0 to 5 (0 turns workflow discovery off; the detector reads five weeks)"),
      summary:
        "Workflow discovery (OPE-2512, OPE-2539): the weeks, out of the last five, in which a person must run the same connector op, or ask the agent the same question with no connector call, on the same weekday before their chief-of-staff watch offers ONE routine for it, as a Set it up / No thanks card in their own DM. It reads only the person's own tool-call and question ledgers, and obeys their watch dial and DM stop. The same rule asks a shared room, with one card in the room, about work that two or more people there repeat, at most once per room per 14 days. A declined idea is never offered again. `0` turns both off.",
      format: (v) => (v === 0 ? "off" : `${v} weeks`),
    } satisfies SettingSpec<number>,
    firstConversationDays: {
      path: "routines.firstConversationDays",
      shipped: 3,
      validate: (v) => (Number.isInteger(v) && v >= 0 && v <= 14 ? undefined : "must be an integer from 0 to 14 (0 turns the first-conversation routine offer off)"),
      summary:
        "First conversation ends in a routine (OPE-2514): for this many days after a person's first DM turn, or after a room's first introduction, the seat may offer ONE routine that fits what they said they do, in one plain sentence, with the routine card as the one confirmation. The host ends the offer when the routine card posts, and a decline or a set-up routine records how it ended. A no said in words before any card posts is covered only by the seat's instruction and this window. A person gets it when their first DM turn after this shipped creates their watch row, and a room when it is first introduced after this shipped. `0` turns it off.",
      format: (v) => (v === 0 ? "off" : `${v} days`),
    } satisfies SettingSpec<number>,
    firstDayBrief: {
      path: "routines.firstDayBrief",
      shipped: true,
      summary:
        "The first-day brief (OPE-2662): on a person's first DM turn, the agent posts ONE card in that DM that offers a morning brief (weekdays at 09:00 UTC) and a needs-you watch (weekdays at 11:00, 14:00 and 17:00 UTC) whose empty checks post nothing. Set it up arms both routines through the normal routine path, and the first brief is due at the click, so the next dispatcher tick fires it. No thanks is remembered, and the card is never posted again. Nothing runs before the click. It needs `routines.firstConversationDays` above 0, because the offer lives inside that window. `false` turns it off.",
    } satisfies SettingSpec<boolean>,
  },
  rotation: {
    quietGapHours: {
      path: "rotation.quietGapHours",
      shipped: 12,
      validate: positiveNumber,
      summary:
        "Idleness threshold, in hours: a standing generation not woken for this long rotates fresh on its NEXT wake rather than resuming a stale session. 12 hours holds a standing seat for a working day, so a morning question and an afternoon follow-up reach the same session. 🔴 What BOUNDS the longer gap is the rest of the chain, not this row: `rotation.expiryDays` still retires a generation on age, and the token, turn and context-size backstops still bound one generation's growth. `rotation.tailTokenCap` is NOT that bound — it caps what a rotation carries forward, so it makes each rotation cheap rather than making a long gap safe. Re-derive against the backstops before raising this.",
      format: (v) => `${v} h`,
    } satisfies SettingSpec<number>,
    expiryDays: {
      path: "rotation.expiryDays",
      shipped: 7,
      validate: (v) => (Number.isFinite(v) ? undefined : "must be a finite number of days (0 or negative disables the expiry trigger)"),
      summary:
        "PRIMARY rotation trigger, in days: a standing generation older than this is retired for context freshness (measured from its own `created_at`, reset on every rotation). `0` or a negative value DISABLES the trigger.",
      format: (v) => `${v} d`,
    } satisfies SettingSpec<number>,
    tokenBudget: {
      path: "rotation.tokenBudget",
      shipped: 4_000_000,
      validate: positiveNumber,
      summary:
        "Token BACKSTOP (demoted from primary by OPE-345, value unchanged): the measured cumulative `inputTokens` on one generation. `inputTokens` is the whole prompt, so it already includes the cache reads, and each cached token counts once. Also the route the session-park remedy uses — parking saturates this counter.",
    } satisfies SettingSpec<number>,
    turnBudget: {
      path: "rotation.turnBudget",
      shipped: 60,
      validate: positiveNumber,
      summary:
        "Turn BACKSTOP: turn count on one generation. 60 is derived from the substrate — a workflow run caps at 25,000 events and OE measures ~295 events/turn, so the wall binds near ~85 turns and this sits ~30% under it. It must ALSO satisfy the older invariant it was first derived against, C(budget) < 40M cumulative input on its own (C(60)≈4.9M ✓; the pre-OPE-345 150 was ✓ at 25.65M, 300 is ✗ at ~96M) — both bounds are pinned in `scripts/rotation-trigger-test.ts`. RE-DERIVE it (do not nudge it) if the events-per-turn measurement moves.",
    } satisfies SettingSpec<number>,
    contextSizeTokens: {
      path: "rotation.contextSizeTokens",
      shipped: 120_000,
      validate: positiveNumber,
      summary:
        "Context-size BACKSTOP: the LAST request's measured `inputTokens` (the whole prompt, cache reads included) — the same measure compaction reads, not the cumulative counter `rotation.tokenBudget` meters. It sits BELOW the compaction fire point on purpose, so a standing seat re-mints a fresh generation with a recorded tail instead of compacting into a summary. Compaction still owns delegated and worker runs, which never reach the rotation chain.",
    } satisfies SettingSpec<number>,
    tailTokenCap: {
      path: "rotation.tailTokenCap",
      shipped: 5_000,
      validate: positiveNumber,
      summary:
        "Token cap on the last-generation TAIL a fresh generation's first wake carries — the recorded wake messages and the seat's own posts, selected most-recent-first, VERBATIM. Tight on purpose: the tail makes the seat conversational. On a channel seat, its read tools and memory cover everything older. A DM seat also carries its conversation summary (`rotation.dmSummaryTokenCap`).",
    } satisfies SettingSpec<number>,
    dmSummaryTokenCap: {
      path: "rotation.dmSummaryTokenCap",
      shipped: 32_000,
      validate: positiveNumber,
      summary:
        "Token cap on a DM seat's CONVERSATION SUMMARY (OPE-2431): the DM's most recent messages (at most 200 entries, about the last 100 exchanges of ordinary length), each cut to 480 characters, that every DM rotation carries beside the verbatim tail, so the person's chief of staff reads as one conversation that carries on. EXTRACTIVE, not model-written: each entry is one recorded message with its own author grain, and a refuted or ungraded author's message never enters it. Each rotation folds the outgoing generation into the summary it inherited, and the oldest entries drop first. Counted by the same characters-per-token proxy as the tail. A COST LEVER: the fresh generation holds the summary in context for its whole life, so it removes up to this many tokens of headroom under `rotation.contextSizeTokens` and adds up to this many tokens to every request against the DM token backstop. Both backstops therefore rotate a long DM sooner. A channel seat carries no summary.",
    } satisfies SettingSpec<number>,
  },
  sandbox: {
    selfHostBackend: {
      path: "sandbox.selfHostBackend",
      shipped: "docker",
      validate: (v) => (v === "docker" || v === "justbash" ? undefined : 'must be "docker" or "justbash"'),
      summary:
        "Which backend runs the agent's shell on a NON-Vercel host (was `OE_SANDBOX_BACKEND`). `docker` (shipped) CONTAINS the shell in a per-session container with its own filesystem; it needs the daemon socket, and its session containers sit outside the egress proxy, so `docker` with `egress.proxyUrl` set refuses to boot. `justbash` runs in-process and the agent's shell SHARES THE APP PROCESS'S FILESYSTEM — development and testing grade, with a loud boot warning. The Docker image carries a just-bash template only, so an app built into that image declares `justbash`. A Vercel host always runs the Vercel Sandbox, so this setting is inert there. Read at BOOT; eve also provisions the sandbox template at BUILD time on the backend this resolves.",
    } satisfies SettingSpec<SandboxBackendChoice>,
    useVercelSandbox: {
      path: "sandbox.useVercelSandbox",
      shipped: false,
      summary:
        "Run the agent's shell in the Vercel Sandbox from a NON-Vercel host (was `OE_PLATFORM=vercel` on that host) — the \"self-host app, Vercel Sandbox executor\" route. On, the app selects the `vercel()` backend, the egress policy takes the Vercel Sandbox firewall path (`sandbox.setNetworkPolicy`) instead of the self-host proxy push, and the browser plane may arm. The app then needs `VERCEL_TOKEN`, `VERCEL_TEAM_ID` (or `VERCEL_ORG_ID`) and `VERCEL_PROJECT_ID` to create sandboxes; this route is UNVERIFIED live. It does NOT make the app a Vercel host: the durable-store floors follow the real host. Inert on a Vercel host, which always runs the Vercel Sandbox. Read at BOOT.",
    } satisfies SettingSpec<boolean>,
    stopAfterTurn: {
      path: "sandbox.stopAfterTurn",
      shipped: true,
      summary:
        "Stop the sandbox compute the moment each turn's reply is sent rather than letting it idle out the timeout window. On a WORK SESSION, which owns the conversation's sandbox, the stop waits until the work session is idle: it owes no unsettled task and no forwarded job. On Vercel the stop auto-snapshots and the next turn auto-resumes; on the docker backend the session container is stopped (never removed) and restarted on next use. The just-bash backend has no compute to stop — it runs inside the app process — so this setting is inert there and the hook logs which backend owns the stop at the first turn end.",
    } satisfies SettingSpec<boolean>,
    extendMaxMinutes: {
      path: "sandbox.extendMaxMinutes",
      shipped: 120,
      validate: positiveInt,
      summary: "Per-call cap on the `extend_workspace_time` tool, in minutes. Plan ceilings still apply.",
      format: (v) => `${v} min`,
    } satisfies SettingSpec<number>,
    timeoutMs: {
      path: "sandbox.timeoutMs",
      shipped: 30 * 60 * 1000,
      validate: positiveInt,
      summary:
        "The per-session sandbox window, in ms. With stop-after-turn owning idle cost this is a BACKSTOP fuse — it binds only when the turn-end hook cannot run — and the max continuous work one session may do. On a work session, whose stop waits until it is idle, this is the longest one job may hold the sandbox. **Applied at sandbox CREATE and persisted on the sandbox, so a change only affects NEW conversations.**",
      format: (v) => `${v} ms`,
    } satisfies SettingSpec<number>,
    snapshotExpirationMs: {
      path: "sandbox.snapshotExpirationMs",
      shipped: 7 * 24 * 60 * 60 * 1000,
      validate: positiveInt,
      summary:
        "Auto-GC age for a stopped sandbox's snapshot, in ms. Past it a conversation resumes onto a FRESH sandbox: the working tree is lost, the conversation and memory are not (`git push` is the real durability boundary for code). Also applied at CREATE.",
      format: (v) => `${v} ms`,
    } satisfies SettingSpec<number>,
    image: {
      path: "sandbox.image",
      shipped: "",
      summary:
        "Off-Vercel `docker()` backend only: the sandbox container image. Empty ⇒ the bare `docker({})` eve otherwise mints. Ignored under `justbash` and on Vercel.",
      format: (v) => (v === "" ? "`` (the backend's own default)" : v),
    } satisfies SettingSpec<string>,
    region: {
      path: "sandbox.region",
      shipped: "",
      validate: sandboxRegionProblem,
      summary:
        "Vercel region to create sandboxes in — the data-residency pin for sandbox COMPUTE, the sibling of the AI Gateway's `inferenceRegion` for inference. Empty (the default) pins nothing. Read at boot, applied at sandbox CREATE, and inert off Vercel (a loud warning says so). Existing sandboxes keep the region they were created in. Should a future eve stop forwarding the region to sandbox creation, `npm run test:sandbox-region` goes red — that red is the signal, and it is the only automatic part. The boot keeps pinning until a maintainer flips the hand-maintained capability constant to `false`. That flip is what makes setting this REFUSE THE BOOT with the reason, rather than run in the default region under a residency claim.",
      format: (v) => (v === "" ? "`` (no pin — Vercel's own default region)" : v),
    } satisfies SettingSpec<string>,
  },
  storage: {
    allowEphemeralMemory: {
      path: "storage.allowEphemeralMemory",
      shipped: false,
      summary:
        "Accept a per-instance, ephemeral DM/personal memory store on a Vercel host (was `OE_ALLOW_EPHEMERAL_MEMORY=1`). Off (shipped), a Vercel host with no durable memory backing refuses to resolve the DM store: a memory write would report success and the fact would vanish at the next cold start. Set `DATABASE_URL` instead, which selects Postgres on its own. On is for a knowingly single-instance host only. Off a Vercel host the local floor is correct, and this setting is inert.",
    } satisfies SettingSpec<boolean>,
    allowEphemeralOperational: {
      path: "storage.allowEphemeralOperational",
      shipped: false,
      summary:
        "Accept a per-instance, ephemeral operational store (the PGlite or sqlite floor) on a Vercel host (was `OE_ALLOW_EPHEMERAL_OPERATIONAL=1`). Off (shipped), a Vercel host with no hosted Postgres refuses to boot: the audit log, the spend ledger and break-glass revocations would be per-instance, so a revoke would report success and never take effect. Set `DATABASE_URL` instead. On is for a knowingly single-instance host only. Off a Vercel host the floor is correct, and this setting is inert.",
    } satisfies SettingSpec<boolean>,
  },
  retention: {
    sessionTranscriptDays: {
      path: "retention.sessionTranscriptDays",
      shipped: 90,
      validate: nonNegativeInt,
      summary:
        "Days a FINISHED session transcript is kept. The daily tidy pass deletes every finished run whose last activity is older, together with its events, steps, hooks and streams, and writes one `exit.retention_swept` audit row with the counts. A live run is never touched. It acts on eve's local workflow world (`.eve/.workflow-data`, the default off Vercel). On Vercel the transcripts live in Vercel's hosted workflow store, which offers no delete call, so this setting cannot reach them there and the audit row says so. 0 keeps every transcript. See docs/security/exit-and-your-data.md.",
      format: (v) => (v === 0 ? "0 (keep every transcript)" : `${v} d`),
    } satisfies SettingSpec<number>,
    storedStateDays: {
      path: "retention.storedStateDays",
      shipped: 90,
      validate: nonNegativeInt,
      summary:
        "Days the conversational state in the operational store is kept: conversation tails and DM summaries, job results, Slack file links, captured webhook bodies, status lines, the words of repeated questions and soak captures. The daily tidy pass deletes the older rows (agent/exit/catalogue.ts lists each table and its time column). The audit log, the usage and tool-call ledgers and the skill and prompt histories are append-only, and this setting never deletes them. Nor does it delete decided approval cards, grants or memory proposals (the runtime role holds no DELETE on them), or meeting data, which expires by its own clock and holds long-lived provenance marks. Memory is not aged: a person removes it with Forget, and an operator with `oe erase`. 0 keeps all of it.",
      format: (v) => (v === 0 ? "0 (keep all of it)" : `${v} d`),
    } satisfies SettingSpec<number>,
  },
  skills: {
    domainSkillCap: {
      path: "skills.domainSkillCap",
      shipped: 50,
      validate: positiveInt,
      summary:
        "Max runtime-authored domain skills per domain (`create_skill` refuses past this). Per-skill content size is capped separately, in code.",
    } satisfies SettingSpec<number>,
  },
  slack: {
    suggestedPrompts: {
      path: "slack.suggestedPrompts",
      shipped: SLACK_SUGGESTED_PROMPTS_SHIPPED,
      validate: slackSuggestedPromptsProblem,
      summary:
        "The suggested prompts Slack's side panel offers a person who opens the app there (OPE-2457) — each a short `title` the person sees and the `message` it sends. At most 4, as Slack's agent view shows. They are written into the Slack app MANIFEST (`features.agent_view.suggested_prompts`), so a change reaches people only after the operator pastes the manifest again (App Manifest → Save Changes). The shipped three name no product. Empty shows none.",
      format: (v) => (v.length > 0 ? v.map((p) => `“${p.title}”`).join(", ") : "(none)"),
    } satisfies SettingSpec<readonly SlackSuggestedPrompt[]>,
  },
  soak: {
    capture: {
      path: "soak.capture",
      shipped: false,
      summary:
        "Record the COMPOSED request body of every model call on a matching surface (gzipped, with the model id, session, turn/step index and a sha256) into `model_call_capture`, for the soak tests' prefix-replay bench. **Arm it for one soak run and disarm it after.** A capture body holds the whole prompt — rendered member messages and tool output verbatim — so the store is as sensitive as a session transcript: it lives in this deployment's own database, it is served only over a service token (`GET /control/v1/session/:id/model-calls`), and no agent tool reaches it. Retention is an explicit delete-by-session after the harvest, not a TTL. Off (shipped) the recorder does one boolean read per model call and writes nothing.",
    } satisfies SettingSpec<boolean>,
    captureSurfacePrefix: {
      path: "soak.captureSurfacePrefix",
      shipped: "" as string | readonly string[],
      alsoAccepts: "object",
      validate: stringOrStringArray,
      summary:
        "Narrow `soak.capture` to part of the deployment: a call is recorded only when its surface key starts with one of these prefixes. A bare string is shorthand for a one-prefix list. Surface keys read `platform/workspace/surface`, so `\"slack/T0123/\"` is one workspace and `\"slack/T0123/C0SOAK\"` is one channel — a list lets a run scope several platform families at once (e.g. `[\"slack/T0123/\", \"notion/ws1/\"]`) instead of only one. **Set it whenever you arm capture.** Empty (shipped `\"\"`, or `[]`, or any list containing `\"\"`) means every surface, which records the deployment's whole conversational traffic and is almost never what a soak run wants.",
      format: (v) => {
        const list = typeof v === "string" ? [v] : v;
        return list.length === 0 || list.some((p) => p.length === 0) ? "(every surface)" : list.join(", ");
      },
    } satisfies SettingSpec<string | readonly string[]>,
  },
  spend: {
    usageEventsTtlDays: {
      path: "spend.usageEventsTtlDays",
      shipped: 90,
      validate: positiveNumber,
      summary:
        "Retention window for the per-event `usage_events` table, in days. Pruned opportunistically on write; a documented no-op on Postgres, where the table is append-only.",
      format: (v) => `${v} d`,
    } satisfies SettingSpec<number>,
    sandboxMemoryGiB: {
      path: "spend.sandboxMemoryGiB",
      shipped: 4,
      validate: positiveNumber,
      summary:
        "The sandbox memory size the $ estimate prices against, in GiB. 4 is Vercel's platform default, confirmed by the same real-billing reconciliation as the rate — change it only if this deploy pins an explicit `memory` on its sandbox backend.",
      format: (v) => `${v} GiB`,
    } satisfies SettingSpec<number>,
    sandboxGiBHourUsd: {
      path: "spend.sandboxGiBHourUsd",
      shipped: 0.0212,
      validate: positiveNumber,
      summary:
        "Vercel Sandbox's 'Provisioned Memory' rate, $/GiB-hr. EVIDENCE-ONLY: this number is here because it was verified twice — the published pricing page AND a real bill that matched it to the cent. A deployment that cannot verify its own rate should report seconds, never a guessed $ figure.",
      format: (v) => `$${v}/GiB-hr`,
    } satisfies SettingSpec<number>,
  },
  stall: {
    repeatThreshold: {
      path: "stall.repeatThreshold",
      shipped: 3,
      validate: (v) => (Number.isInteger(v) && v >= 0 ? undefined : "must be a non-negative integer (0 disables the stall guard)"),
      summary:
        "Identical-(tool, args, result) run length before the NEXT identical call is nudged instead of executed. `0` disables the stall guard entirely.",
    } satisfies SettingSpec<number>,
  },
  sensitiveData: {
    extraPatterns: {
      path: "sensitiveData.extraPatterns",
      shipped: [] as readonly SensitivePatternSetting[],
      validate: sensitivePatternsProblem,
      summary:
        "The org's OWN outbound sensitive-data detectors, added to the shipped ones (`packages/core/agent/access/sensitive-data.ts`). Each row is `{ type, tier, pattern, flags? }`: a kebab-case name, a tier, and a JavaScript regex source (group 1, when present, is the value). `strictest` refuses any tool call or closing reply text that carries a match, on every sink; `explicit` lets it leave only when the member's own message this turn names it, and otherwise holds the call and tells the agent to ask. Empty (shipped) ⇒ only the shipped detectors run: card numbers, government ID numbers and secrets at `strictest`, health and personal-finance data at `explicit`. A row cannot remove or lower a shipped detector. A pattern that does not compile, or that matches the empty string, fails the boot.",
      format: (v) => (v.length > 0 ? v.map((r) => `${r.type} (${r.tier})`).join(", ") : "(none)"),
    } satisfies SettingSpec<readonly SensitivePatternSetting[]>,
  },
  taint: {
    mode: {
      path: "taint.mode",
      shipped: "on",
      validate: (v) => (v === "on" || v === "off" ? undefined : 'must be "on" or "off"'),
      summary:
        "Whether the tainted-turn model runs at all. `on` (shipped) marks a turn that ingests untrusted content and lets that marking reach approval disclosure, the `taint: \"gate\"` sinks and both delegation legs. Those sinks are the tools that DECLARE `postTurnSurface: \"arms\" | \"disarms\"` — the ones that arm, rewrite or remove instruction and execution surface a later run obeys (routines, skills, agents, routine rules, webhook ingress). A build lint fails on any tool that writes such surface and declares nothing, so the set follows the code rather than a hand-kept list. At those sinks the mark FLOORS the verdict at `ask` — a human decides, and an unattended run denies because the `unattended` transform runs last and reads that ask; it does not refuse outright. It does not gate memory: a memory write is an ordinary file edit with no write verb to mark (OPE-389). `off` is a deployer's reviewed opt-out: no marks, no verdict floor, and no mark travels to a delegated worker in either direction — untrusted content is still FENCED, and every session records `taint.mode: off` in the audit trail. **No environment variable can reach `off`** — it is a one-line diff in `agent/settings/settings.ts`, which is the bar disabling a security model deserves.",
    } satisfies SettingSpec<TaintMode>,
    tierMode: {
      path: "taint.tierMode",
      shipped: "enforced",
      validate: (v) => (v === "enforced" || v === "dryrun" ? undefined : 'must be "enforced" or "dryrun"'),
      summary:
        "Whether the reviewed source-tier table DECIDES a read's untrusted-content marking (`enforced`) or only logs what it would have decided (`dryrun`). Enforcement is relaxation-only.",
    } satisfies SettingSpec<TaintTierMode>,
    undeclaredSurface: {
      path: "taint.undeclaredSurface",
      shipped: "clean",
      validate: (v) => (v === "clean" || v === "mark" ? undefined : 'must be "clean" or "mark"'),
      summary:
        "What a chat wake does on a surface the operator has NEVER declared in the trust registry (`agent/identity/surfaces.ts`). `clean` (shipped) marks nothing and relocates the complaint to preflight, where it names the surface once and is actionable — a declared room is judged by its declaration and a refuted author still marks, so the bit keeps discriminating. `mark` restores per-turn pressure at ROOM grain: every human-authored turn on an undeclared surface marks. That is much narrower than the pre-OPE-489 behaviour, because a DECLARED surface never reaches it. The residual under `clean` is real and bounded: between install and the first declaration a genuinely public chat room reads clean, the ACL plane still fences it to the read-only `public` pseudo-domain, and the approval plane is the defence against a consequential act.",
    } satisfies SettingSpec<TaintUndeclaredSurface>,
  },
  teams: {
    serviceHosts: {
      path: "teams.serviceHosts",
      shipped: [] as readonly string[],
      validate: (v) => tokenArray(v) ?? (v.every((h) => h === h.toLowerCase()) ? undefined : "must be lowercase host names"),
      summary:
        "Bot Connector hosts the Teams provider admits BEYOND the global-cloud default (was `OE_TEAMS_SERVICE_HOSTS`). Each entry is an exact host or a dot-anchored `.suffix`. Empty (shipped) admits the global (commercial) cloud only, which is the Teams provider's own built-in host list. A sovereign-cloud deployment adds its own host here — GCC `smba.infra.gcc.teams.microsoft.com`, GCC High `smba.infra.gov.teams.microsoft.us`, DoD `smba.infra.dod.teams.microsoft.us`. The reply's bearer token only ever goes to a matched host, so list Microsoft-owned hosts only.",
      format: (v) => (v.length > 0 ? v.join(", ") : "(the global-cloud default only)"),
    } satisfies SettingSpec<readonly string[]>,
    appId: {
      path: "teams.appId",
      shipped: "",
      validate: (v: string) =>
        typeof v === "string" && /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?$/u.test(v)
          ? undefined
          : 'must be the Azure Bot\'s application (client) id, a GUID, or "" for unset',
      summary:
        "The Azure Bot's application (client) id, a GUID (was `MICROSOFT_APP_ID` and `TEAMS_APP_ID`, OPE-2650). The Teams channel verifies each inbound token's audience against it, mints its Bot Connector token as it, and fills it into the app package. Empty (shipped) ⇒ unset: the Teams surface refuses inbound activity and posts nothing. The app password stays out of Git. See docs/deploy/surfaces/teams.md.",
      format: unsetFormat,
    } satisfies SettingSpec<string>,
  },
  telemetry: {
    enabled: {
      path: "telemetry.enabled",
      shipped: true,
      summary:
        "Whether this deployment sends anonymous usage telemetry (was `OE_TELEMETRY`, OPE-2650). On (shipped), the disclosure line prints before anything is sent, and the very first boot sends nothing. `false` ⇒ nothing is sent and no instance id is minted. The ambient `DO_NOT_TRACK=1` environment variable also turns it off, whatever this says. Read at the first emit after the app registers its settings, never at the instrumentation `setup`. See docs/deploy/telemetry.md.",
    } satisfies SettingSpec<boolean>,
    debug: {
      path: "telemetry.debug",
      shipped: false,
      summary: "Log each telemetry payload to the console INSTEAD of sending it (was `OE_TELEMETRY_DEBUG=1`, OPE-2650). For an operator who wants to read exactly what would leave.",
    } satisfies SettingSpec<boolean>,
    url: {
      path: "telemetry.url",
      shipped: "",
      validate: httpUrlOrEmpty,
      summary:
        "A FULL redirect of the telemetry to the operator's own OTLP/JSON logs collector (was `OE_TELEMETRY_OTLP_URL`, OPE-2650). Every record goes there, and nothing goes to the default collector. Request headers for that collector (an auth token) are the operator secret `OE_TELEMETRY_OTLP_HEADERS`, as comma-separated `key=value` pairs. Empty (shipped) ⇒ the default collector.",
      format: (v) => (v === "" ? "(the default collector)" : v),
    } satisfies SettingSpec<string>,
  },
  tools: {
    maxResultChars: {
      path: "tools.maxResultChars",
      shipped: 120_000,
      validate: positiveInt,
      summary:
        "Per-tool-result character cap (~30k tokens), applied inside the untrusted-ingestion funnel so one avalanche result cannot blow the context window in a single shot.",
      format: (v) => `${v} chars`,
    } satisfies SettingSpec<number>,
  },
  voiceClips: {
    enabled: {
      path: "voiceClips.enabled",
      shipped: true,
      summary:
        "Hear voice clips (OPE-2524). On (shipped), an audio file or voice clip that a person sends in a conversation the agent already answers is transcribed through the stack's transcription role (`agent/model/stacks.ts`, the same primary and fallback routes a meeting uses) and handled as if the person had typed it. The transcript joins the message body with the author's own trust, and the audio is held in memory for the one call only. Slack is the one wired surface: a DM, a group DM, an @mention, and a reply in a thread the agent is in and was not asked to stand down. A clip in a room that did not address the agent is never downloaded, and neither is a bot's clip (the named e2e driver's DM aside). A call that carries a measured cost bills to the conversation's spend row (an answer with no cost field, and a failed attempt, record no row). A conversation over its cap is not transcribed; the cap check fails open with a warning. Off, a clip reaches the agent as a file it cannot hear, with one line saying so.",
    } satisfies SettingSpec<boolean>,
  },
  turn: {
    stepBudget: {
      path: "turn.stepBudget",
      shipped: 120,
      validate: (v) => (Number.isInteger(v) && v >= 0 ? undefined : "must be a whole number of round-trips (0 disables the boundary)"),
      summary:
        "SOFT per-turn boundary: model round-trips one turn may take before every subsequent call carries a wrap-up instruction (finish, report, yield — the turn is NOT killed). Guards the runaway tool spiral (one live turn ran 446 steps / 36 min of gateway spend) without capping legitimately long work. `0` disables both tiers.",
      format: (v) => `${v} round-trips`,
    } satisfies SettingSpec<number>,
    stepBackstopMultiple: {
      path: "turn.stepBackstopMultiple",
      shipped: 3,
      validate: (v) => (Number.isFinite(v) && v >= 1 ? undefined : "must be at least 1 (a backstop below the soft boundary would fire before the model is ever asked to wrap up)"),
      summary:
        "HARD backstop, as a multiple of `turn.stepBudget`: past it the resolver returns a text-only stub whose reply says the turn was stopped, so eve's own continue-decision ends the turn. For the pathological loop that ignores the wrap-up instruction. Clamped to a minimum of 1.",
      format: (v) => `${v}× the budget`,
    } satisfies SettingSpec<number>,
  },
  wake: {
    nameDropInclude: {
      path: "wake.nameDrop.include",
      shipped: [] as readonly string[],
      validate: stringArray,
      summary:
        "Extra name tokens the Slack/Discord/Teams AMBIENT name-drop wake fires on, beyond the surface's live vendor display name and `identity.name` (OPE-571). Case-insensitive, matched the same word-boundary way as the automatic base — no regex, no predicate. Widening ambient wake is the operator's own choice, made by diff.",
      format: (v) => (v.length > 0 ? v.join(", ") : "(none)"),
    } satisfies SettingSpec<readonly string[]>,
    nameDropExclude: {
      path: "wake.nameDrop.exclude",
      shipped: [] as readonly string[],
      validate: stringArray,
      summary:
        "Name tokens the Slack/Discord/Teams name-drop wake NEVER fires on, even when the live display name, `identity.name`, or `wake.nameDrop.include` would otherwise carry them. WINS over both — the narrowing always has the last word.",
      format: (v) => (v.length > 0 ? v.join(", ") : "(none)"),
    } satisfies SettingSpec<readonly string[]>,
    e2eDrivers: {
      path: "wake.e2eDrivers",
      shipped: [] as readonly E2eDriverIdentity[],
      validate: e2eDriversProblem,
      summary:
        "The e2e DRIVER bot identities the seat doors admit, one `{ surface, principal }` entry per identity. `principal` is written in the surface's OWN id vocabulary: Slack a `teamId:botId` pair (the workspace and the POSTING APP's `B…` bot record, which is what a `message.im`/`message.mpim` event carries in `bot_id`), Discord the driver bot's user-id snowflake, Notion the driver integration's bot id. Every chat surface stamps a machine author on anything a script posts — Slack does it on a USER token too, and Discord bans user tokens outright — so without this the e2e pack cannot drive a real seat and its legs can only forge an envelope. Empty (shipped) ⇒ a bot-authored DM drops at the Slack DM door with its `surface.wake_dropped` row, and a message a surface tags as machine-authored is refused in a seat's catch-up read by the domain's own admission policy, exactly as before. 🔴 NOTION IS THE ONE SURFACE THAT CANNOT TAG ONE (OPE-1857): it serves a comment's `created_by` as a partial user with no `type`, so a catch-up read cannot tell an integration's comment from a person's and `wide` admits it at the `unauth` floor whether or not this list names it. A `notion` entry therefore widens only the case where Notion DOES state a `type`; it is not what admits the driver today. 🔴 A `members-only` domain refuses an UNLISTED machine author alike, but NOT a listed one: the carve-out ORs past the domain's own policy, so a LISTED identity enters a seat in any domain. Set ⇒ a LISTED identity is admitted at the Slack DM door (which writes a `surface.wake_admitted` row naming the carve-out, and resolves author trust from the HUMAN `user` the post carries — no trust is invented for the bot), and enters the standing seat's own reads — the since-last-wake catch-up, the bootstrap window and the name-drop hydration, every read `seatAdmissionFor` governs — wherever that ONE identity speaks on its own surface, at the `relay` tier every machine author already carries. The PRINCIPAL is what pins the reach: a Slack entry is workspace-pinned by its `teamId:botId` pair, while a Discord or Notion entry names a globally unique vendor id and reaches that identity's rooms on that surface. 🔴 THE DOOR AND THE READ ASK ONE PREDICATE (OPE-1969), so the two cannot disagree about one identity: the read was scoped to the `e2e-engaged` domain alone until a fixture room no domain claims showed the disagreement — the door admitted the driver and the seat's catch-up dropped it. An unlisted bot is refused exactly as it was before, on every surface and in every room. Deliberately SEPARATE from the `wake.driverAllowlist` pairs that lift a driver at the engagement and mention doors: a seat holds a window token, delegation and memory, so admitting a bot there is a larger grant and is made by its own reviewed diff. TEST BEDS ONLY — a real deployment leaves it empty.",
      format: (v) => (v.length > 0 ? v.map((d) => `${d.surface}: ${d.principal}`).join(", ") : "(none)"),
    } satisfies SettingSpec<readonly E2eDriverIdentity[]>,
    driverAllowlist: {
      path: "wake.driverAllowlist",
      shipped: [] as readonly string[],
      validate: driverAllowlistProblem,
      summary:
        "The test-deployment exception to \"never act on another bot\" (a real deployment's one exception is a reply in an asked thread, OPE-2426, docs/capabilities/bot-delegation.md): the e2e DRIVER bot pairs the Slack engagement and mention doors and the Discord relay ingress admit as if they were a user, so full-path tests can drive the real agent. Each entry is ONE pair: `guildId:botUserId` on Discord, `teamId:botId` on Slack (the posting app's `B…` bot record). Guild/workspace-pinned, exact match, no wildcards; a malformed entry fails the boot. On Discord, a listed driver id that posts from a DIFFERENT guild than its pair names is still refused, and the refusal writes a `discord.relay_admission_refused` audit row (OPE-647) — every other bot-authored message stays a silent no-op. Empty (shipped) ⇒ every bot-authored message drops, except a reply in an asked thread (OPE-2426). Deliberately SEPARATE from `wake.e2eDrivers`, which admits a driver into a standing seat: that is a larger grant, made by its own reviewed diff. Was the `OE_TEST_DRIVER_IDS` env var until OPE-2411. TEST BEDS ONLY — a real deployment leaves it empty. 🔴 This repository's own `agent/settings/settings.ts` names the maintainers' test-deployment pairs, so a deployment made from a clone of this repository must delete that entry.",
      format: (v) => (v.length > 0 ? v.join(", ") : "(none)"),
    } satisfies SettingSpec<readonly string[]>,
    testWakeRoute: {
      path: "wake.testWakeRoute",
      shipped: false,
      summary:
        "Whether the spoofed-wake injection route `POST /control/v1/test/wake` exists. The e2e packs and the eval harnesses use it to feed a synthesised wake into a standing window. Off (shipped) ⇒ the route answers 404 — it does not exist. On, it ALSO needs the `OE_CONTROL_INJECT_TOKENS` credential family and a matching bearer: either half alone leaves the route dead. Injection transitively WRITES (the agent acts and replies for real) and can mint a full-kit task seat. Was the `OE_TEST_WAKE` env var until OPE-2411. TEST BEDS ONLY — a real deployment leaves it off. 🔴 This repository's own `agent/settings/settings.ts` turns it on for the maintainers' test bed, so a deployment made from a clone of this repository must delete that entry, or the credential alone guards the route.",
    } satisfies SettingSpec<boolean>,
  },
  webhooks: {
    allowUnverified: {
      path: "webhooks.allowUnverified",
      shipped: false,
      summary:
        "Accept a delivery whose DECLARED hook has no secret configured. Off (shipped) refuses it. On, the acceptance is stamped `unverified: true` in the fire's audit row. It never bypasses signature verification once a secret IS set, never waives VERIFIER RESOLUTION (an unregistered `source` is still a 401), and is never honoured for a hook whose secret this deployment itself holds (`broker: \"db\"`) — a missing key there means nobody minted it or the vault read failed, not a laptop without a value. Local development only.",
    } satisfies SettingSpec<boolean>,
    allowUnverifiedGithub: {
      path: "webhooks.allowUnverifiedGithub",
      shipped: false,
      summary:
        "Accept a GitHub delivery when `GITHUB_WEBHOOK_SECRET` is unset. Off (shipped) rejects the whole route with a 401, which is the fail-closed posture a deployment wants. On, the event fan-out and the ambient-supervisor leg run for a delivery whose only proof is possession of the URL. It changes nothing once the secret IS set — a bad signature still 401s. Local development only.",
    } satisfies SettingSpec<boolean>,
    allowUnverifiedNotion: {
      path: "webhooks.allowUnverifiedNotion",
      shipped: false,
      summary:
        "Accept a Notion delivery when no verification token is configured. Off (shipped) rejects it. On, the delivery reaches the ambient supervisor but identifies NO SIGNER, so a page a domain reaches only through a container entry is still refused, and the delivery deliberately never enters the routine-trigger plane — an acceptance proved only by possession of the URL must not start member-authored work. Local development only.",
    } satisfies SettingSpec<boolean>,
  },
  window: {
    topology: {
      path: "window.topology",
      shipped: true,
      summary:
        "The STANDING-SEAT apparatus — the ONE gate governing every seat and every window shape: the per-channel `solo` seat every channel the bot is in gets, a named `windows` group, and the cross-surface `unified` window. On, addressing decides what enters a seat and what wakes it, never the shape of the session: a mention lands in the room's own standing seat, and an undeclared channel inherits the `org` pseudo-domain's defaults (its own solo seat — never a shared context). 🔴 That inheritance is the ONE fail-closed arm: a deployment that declares NO `org` pseudo-domain leaves an undeclared channel with no domain to inherit, so it keeps the native per-container path even with this gate on. On is the shipped posture. The `org` pseudo-domain stays solo: config load refuses `mode` on it, because the whole org is never one window. A shared window exists only where a deployer declares one: an explicit team domain (its `reach`), which is `unified` by default (OPE-2412), or a named `windows` group. A declared domain falls back to `solo` when config load cannot prove its window safe, and `mode: \"solo\"` keeps it solo outright. A fresh install declares none, so every channel gets its own solo seat. The gate also arms mid-session memory re-sync org-wide: on each wake, a supervisor-shaped session re-reads the read silos whose store version advanced, and the re-sync propagates deletes into the sandbox. Off, every domain runs the native per-container path, a mention opens eve's per-thread session, and `mode` and `windows` are inert. **Declare a `unified` window deliberately: it is a wider data blast radius.** The since-last-wake catch-up read — a seat arriving with what the room said while it was not woken — runs on every surface through one shared path, each reading its own container (a Slack or Discord channel, a Teams channel over Microsoft Graph, a GitHub issue or pull request, a Linear issue, a Notion page discussion). A surface that registers NO history fetch states that in the wake rather than arriving with an empty context; a registered read that fails stays fail-soft to empty, so a revoked history scope reads as a quiet room.",
    } satisfies SettingSpec<boolean>,
  },
};

export type AgentSettingsOverrides = {
  readonly [G in keyof AgentSettings]?: { readonly [K in keyof AgentSettings[G]]?: AgentSettings[G][K] };
};

function validatorVerdict(spec: SettingSpec<unknown>, value: unknown): string | null | undefined {
  if (spec.validate === undefined) return null;
  try {
    return spec.validate(value) ?? undefined;
  } catch {
    return null;
  }
}

function connectorPlaneCouplingProblem(overrides: AgentSettingsOverrides): string | undefined {
  const userPrincipal = overrides.connectors?.userPrincipal ?? SETTINGS.connectors.userPrincipal.shipped;
  const opTiering = overrides.connectors?.opTiering ?? SETTINGS.connectors.opTiering.shipped;
  if (userPrincipal !== true || opTiering === true) return undefined;
  return (
    "connectors.userPrincipal resolves ON (it ships on) while connectors.opTiering is off. The per-user credential path resolves a personal " +
    "credential in a DM, and every member-plane deny of a personal-credential write is computed only on the " +
    "connectors.opTiering branch — so this posture lets a declared `connector.tool:` row lift an unattended " +
    "personal-credential write that the tiering-on path denies outright. Arm connectors.opTiering, or declare " +
    "connectors.userPrincipal: false"
  );
}

export function defineSettings(overrides: AgentSettingsOverrides): AgentSettingsOverrides {
  const problems: string[] = [];
  for (const [group, values] of Object.entries(overrides) as Array<[string, Record<string, unknown> | undefined]>) {
    const specs = (SETTINGS as unknown as Record<string, Record<string, SettingSpec<unknown>>>)[group];
    if (specs === undefined) {
      problems.push(`unknown settings group "${group}" — valid groups: ${Object.keys(SETTINGS).sort().join(", ")}`);
      continue;
    }
    if (values === undefined) continue;
    for (const [key, value] of Object.entries(values)) {
      const spec = specs[key];
      if (spec === undefined) {
        problems.push(`unknown setting "${group}.${key}" — valid keys in "${group}": ${Object.keys(specs).sort().join(", ")}`);
        continue;
      }
      if (value === undefined) continue;
      if (typeof value !== typeof spec.shipped) {
        const verdict = validatorVerdict(spec, value);
        if (verdict !== undefined) {
          const declaredArm = spec.alsoAccepts === typeof value && verdict !== null;
          problems.push(
            declaredArm
              ? `${spec.path}: ${verdict} (got ${JSON.stringify(value)})`
              : `${spec.path}: expected ${typeof spec.shipped}, got ${typeof value}`,
          );
        }
        continue;
      }
      const problem = spec.validate?.(value);
      if (problem !== undefined) problems.push(`${spec.path}: ${problem} (got ${JSON.stringify(value)})`);
    }
  }
  const coupling = connectorPlaneCouplingProblem(overrides);
  if (coupling !== undefined) problems.push(coupling);
  if (problems.length > 0) {
    throw new Error(
      `open-everywhere: invalid agent settings (agent/settings/settings.ts) —\n  • ${problems.join("\n  • ")}\n` +
        `See packages/core/agent/settings/settings.ts for the schema.`,
    );
  }
  return Object.freeze(overrides);
}

const registeredSlot = processRegistrySlot<AgentSettingsOverrides>("settings.registered.v1");

function registeredOverrides(): AgentSettingsOverrides {
  return registeredSlot.get() ?? {};
}

export function registerSettings(overrides: AgentSettingsOverrides): void {
  registeredSlot.set(overrides);
}

export function settingsRegistered(): boolean {
  return registeredSlot.get() != null;
}

export function resetSettingsForTest(): void {
  registeredSlot.set(null);
}

export function overrideSettingsForTest(patch: AgentSettingsOverrides): void {
  const next: Record<string, Record<string, unknown>> = {};
  for (const [group, values] of Object.entries(registeredOverrides() as Record<string, Record<string, unknown> | undefined>)) {
    if (values !== undefined) next[group] = { ...values };
  }
  for (const [group, values] of Object.entries(patch as Record<string, Record<string, unknown> | undefined>)) {
    if (values === undefined) continue;
    next[group] = { ...(next[group] ?? {}), ...values };
  }
  registeredSlot.set(next as AgentSettingsOverrides);
}

function resolve<T>(spec: SettingSpec<T>, override: T | undefined): T {
  return override ?? spec.shipped;
}

export function getSettings(overrides: AgentSettingsOverrides = registeredOverrides()): AgentSettings {
  const o = overrides;
  return {
    a2a: {
      inbound: resolve(SETTINGS.a2a.inbound, o.a2a?.inbound),
    },
    accessRequests: {
      adminChannel: resolve(SETTINGS.accessRequests.adminChannel, o.accessRequests?.adminChannel),
      configRepo: resolve(SETTINGS.accessRequests.configRepo, o.accessRequests?.configRepo),
      configBase: resolve(SETTINGS.accessRequests.configBase, o.accessRequests?.configBase),
    },
    agent: {
      sessionInputTokenBudget: resolve(SETTINGS.agent.sessionInputTokenBudget, o.agent?.sessionInputTokenBudget),
      compactionThresholdPercent: resolve(SETTINGS.agent.compactionThresholdPercent, o.agent?.compactionThresholdPercent),
    },
    approvals: {
      judgeMode: resolve(SETTINGS.approvals.judgeMode, o.approvals?.judgeMode),
      ttlHours: resolve(SETTINGS.approvals.ttlHours, o.approvals?.ttlHours),
      routineGrantTtlHours: resolve(SETTINGS.approvals.routineGrantTtlHours, o.approvals?.routineGrantTtlHours),
      checkpointTtlHours: resolve(SETTINGS.approvals.checkpointTtlHours, o.approvals?.checkpointTtlHours),
      routineCardWaitSeconds: resolve(SETTINGS.approvals.routineCardWaitSeconds, o.approvals?.routineCardWaitSeconds),
    },
    browser: {
      enabled: resolve(SETTINGS.browser.enabled, o.browser?.enabled),
    },
    auditExport: {
      targets: resolve(SETTINGS.auditExport.targets, o.auditExport?.targets),
    },
    aws: {
      enabled: resolve(SETTINGS.aws.enabled, o.aws?.enabled),
      ssoScopes: resolve(SETTINGS.aws.ssoScopes, o.aws?.ssoScopes),
      region: resolve(SETTINGS.aws.region, o.aws?.region),
      ssoRegion: resolve(SETTINGS.aws.ssoRegion, o.aws?.ssoRegion),
      ssoClientId: resolve(SETTINGS.aws.ssoClientId, o.aws?.ssoClientId),
    },
    bash: {
      timeoutMs: resolve(SETTINGS.bash.timeoutMs, o.bash?.timeoutMs),
      backgroundGuard: resolve(SETTINGS.bash.backgroundGuard, o.bash?.backgroundGuard),
    },
    connectors: {
      dmOnly: resolve(SETTINGS.connectors.dmOnly, o.connectors?.dmOnly),
      userPrincipal: resolve(SETTINGS.connectors.userPrincipal, o.connectors?.userPrincipal),
      linkSetVault: resolve(SETTINGS.connectors.linkSetVault, o.connectors?.linkSetVault),
      opTiering: resolve(SETTINGS.connectors.opTiering, o.connectors?.opTiering),
      memberPlane: resolve(SETTINGS.connectors.memberPlane, o.connectors?.memberPlane),
    },
    control: {
      githubAdmin: resolve(SETTINGS.control.githubAdmin, o.control?.githubAdmin),
      adminRoleRules: resolve(SETTINGS.control.adminRoleRules, o.control?.adminRoleRules),
      adminOidc: resolve(SETTINGS.control.adminOidc, o.control?.adminOidc),
    },
    directory: {
      provider: resolve(SETTINGS.directory.provider, o.directory?.provider),
      oktaOrgUrl: resolve(SETTINGS.directory.oktaOrgUrl, o.directory?.oktaOrgUrl),
      mode: resolve(SETTINGS.directory.mode, o.directory?.mode),
      autoConfirm: resolve(SETTINGS.directory.autoConfirm, o.directory?.autoConfirm),
      groupAllowlist: resolve(SETTINGS.directory.groupAllowlist, o.directory?.groupAllowlist),
      oktaApps: resolve(SETTINGS.directory.oktaApps, o.directory?.oktaApps),
    },
    identityLinking: {
      codeBack: resolve(SETTINGS.identityLinking.codeBack, o.identityLinking?.codeBack),
    },
    delegation: {
      oneshotAgent: resolve(SETTINGS.delegation.oneshotAgent, o.delegation?.oneshotAgent),
    },
    models: {
      stack: resolve(SETTINGS.models.stack, o.models?.stack),
      primary: resolve(SETTINGS.models.primary, o.models?.primary),
      force: resolve(SETTINGS.models.force, o.models?.force),
      dataPolicy: resolve(SETTINGS.models.dataPolicy, o.models?.dataPolicy),
      targets: resolve(SETTINGS.models.targets, o.models?.targets),
    },
    discord: {
      autoThread: resolve(SETTINGS.discord.autoThread, o.discord?.autoThread),
      statusUx: resolve(SETTINGS.discord.statusUx, o.discord?.statusUx),
      applicationId: resolve(SETTINGS.discord.applicationId, o.discord?.applicationId),
      publicKey: resolve(SETTINGS.discord.publicKey, o.discord?.publicKey),
    },
    egress: {
      enforce: resolve(SETTINGS.egress.enforce, o.egress?.enforce),
      allowUnenforced: resolve(SETTINGS.egress.allowUnenforced, o.egress?.allowUnenforced),
      proxyUrl: resolve(SETTINGS.egress.proxyUrl, o.egress?.proxyUrl),
      sourceIp: resolve(SETTINGS.egress.sourceIp, o.egress?.sourceIp),
      denialLog: resolve(SETTINGS.egress.denialLog, o.egress?.denialLog),
    },
    externalPolicy: {
      authorGrain: resolve(SETTINGS.externalPolicy.authorGrain, o.externalPolicy?.authorGrain),
      roomGrain: resolve(SETTINGS.externalPolicy.roomGrain, o.externalPolicy?.roomGrain),
    },
    github: {
      auth: resolve(SETTINGS.github.auth, o.github?.auth),
      tokenRepos: resolve(SETTINGS.github.tokenRepos, o.github?.tokenRepos),
      appId: resolve(SETTINGS.github.appId, o.github?.appId),
      appSlug: resolve(SETTINGS.github.appSlug, o.github?.appSlug),
      appClientId: resolve(SETTINGS.github.appClientId, o.github?.appClientId),
      botUserId: resolve(SETTINGS.github.botUserId, o.github?.botUserId),
      conversation: resolve(SETTINGS.github.conversation, o.github?.conversation),
      installations: resolve(SETTINGS.github.installations, o.github?.installations),
    },
    governance: {
      floorTtlMs: resolve(SETTINGS.governance.floorTtlMs, o.governance?.floorTtlMs),
    },
    identity: {
      dmTrustTtlMs: resolve(SETTINGS.identity.dmTrustTtlMs, o.identity?.dmTrustTtlMs),
      name: resolve(SETTINGS.identity.name, o.identity?.name),
      shortName: resolve(SETTINGS.identity.shortName, o.identity?.shortName),
      commandName: resolve(SETTINGS.identity.commandName, o.identity?.commandName),
      allowMultiTenantPrincipals: resolve(SETTINGS.identity.allowMultiTenantPrincipals, o.identity?.allowMultiTenantPrincipals),
      blanketTrust: resolve(SETTINGS.identity.blanketTrust, o.identity?.blanketTrust),
    },
    language: {
      output: resolve(SETTINGS.language.output, o.language?.output),
    },
    linear: {
      appName: resolve(SETTINGS.linear.appName, o.linear?.appName),
      appUserId: resolve(SETTINGS.linear.appUserId, o.linear?.appUserId),
      clientId: resolve(SETTINGS.linear.clientId, o.linear?.clientId),
      organizationId: resolve(SETTINGS.linear.organizationId, o.linear?.organizationId),
    },
    memory: {
      dreamCandidateCap: resolve(SETTINGS.memory.dreamCandidateCap, o.memory?.dreamCandidateCap),
      skillProposalPr: resolve(SETTINGS.memory.skillProposalPr, o.memory?.skillProposalPr),
      syncTiming: resolve(SETTINGS.memory.syncTiming, o.memory?.syncTiming),
      provider: resolve(SETTINGS.memory.provider, o.memory?.provider),
      gitBranch: resolve(SETTINGS.memory.gitBranch, o.memory?.gitBranch),
      notionTokenSecret: resolve(SETTINGS.memory.notionTokenSecret, o.memory?.notionTokenSecret),
    },
    observability: {
      logShip: resolve(SETTINGS.observability.logShip, o.observability?.logShip),
    },
    notion: {
      botName: resolve(SETTINGS.notion.botName, o.notion?.botName),
      botUserId: resolve(SETTINGS.notion.botUserId, o.notion?.botUserId),
    },
    policyPages: {
      privacy: resolve(SETTINGS.policyPages.privacy, o.policyPages?.privacy),
      terms: resolve(SETTINGS.policyPages.terms, o.policyPages?.terms),
    },
    schedules: {
      sweepOrgs: resolve(SETTINGS.schedules.sweepOrgs, o.schedules?.sweepOrgs),
    },
    routines: {
      eventMaxFanout: resolve(SETTINGS.routines.eventMaxFanout, o.routines?.eventMaxFanout),
      maxConcurrency: resolve(SETTINGS.routines.maxConcurrency, o.routines?.maxConcurrency),
      jobMaxFires: resolve(SETTINGS.routines.jobMaxFires, o.routines?.jobMaxFires),
      jobMaxDays: resolve(SETTINGS.routines.jobMaxDays, o.routines?.jobMaxDays),
      attentionWarnRuns: resolve(SETTINGS.routines.attentionWarnRuns, o.routines?.attentionWarnRuns),
      attentionPauseRuns: resolve(SETTINGS.routines.attentionPauseRuns, o.routines?.attentionPauseRuns),
      discoveryMinWeeks: resolve(SETTINGS.routines.discoveryMinWeeks, o.routines?.discoveryMinWeeks),
      firstConversationDays: resolve(SETTINGS.routines.firstConversationDays, o.routines?.firstConversationDays),
      firstDayBrief: resolve(SETTINGS.routines.firstDayBrief, o.routines?.firstDayBrief),
    },
    rotation: {
      quietGapHours: resolve(SETTINGS.rotation.quietGapHours, o.rotation?.quietGapHours),
      expiryDays: resolve(SETTINGS.rotation.expiryDays, o.rotation?.expiryDays),
      tokenBudget: resolve(SETTINGS.rotation.tokenBudget, o.rotation?.tokenBudget),
      turnBudget: resolve(SETTINGS.rotation.turnBudget, o.rotation?.turnBudget),
      contextSizeTokens: resolve(SETTINGS.rotation.contextSizeTokens, o.rotation?.contextSizeTokens),
      tailTokenCap: resolve(SETTINGS.rotation.tailTokenCap, o.rotation?.tailTokenCap),
      dmSummaryTokenCap: resolve(SETTINGS.rotation.dmSummaryTokenCap, o.rotation?.dmSummaryTokenCap),
    },
    sandbox: {
      selfHostBackend: resolve(SETTINGS.sandbox.selfHostBackend, o.sandbox?.selfHostBackend),
      useVercelSandbox: resolve(SETTINGS.sandbox.useVercelSandbox, o.sandbox?.useVercelSandbox),
      stopAfterTurn: resolve(SETTINGS.sandbox.stopAfterTurn, o.sandbox?.stopAfterTurn),
      extendMaxMinutes: resolve(SETTINGS.sandbox.extendMaxMinutes, o.sandbox?.extendMaxMinutes),
      timeoutMs: resolve(SETTINGS.sandbox.timeoutMs, o.sandbox?.timeoutMs),
      snapshotExpirationMs: resolve(SETTINGS.sandbox.snapshotExpirationMs, o.sandbox?.snapshotExpirationMs),
      image: resolve(SETTINGS.sandbox.image, o.sandbox?.image),
      region: resolve(SETTINGS.sandbox.region, o.sandbox?.region),
    },
    spend: {
      usageEventsTtlDays: resolve(SETTINGS.spend.usageEventsTtlDays, o.spend?.usageEventsTtlDays),
      sandboxMemoryGiB: resolve(SETTINGS.spend.sandboxMemoryGiB, o.spend?.sandboxMemoryGiB),
      sandboxGiBHourUsd: resolve(SETTINGS.spend.sandboxGiBHourUsd, o.spend?.sandboxGiBHourUsd),
    },
    storage: {
      allowEphemeralMemory: resolve(SETTINGS.storage.allowEphemeralMemory, o.storage?.allowEphemeralMemory),
      allowEphemeralOperational: resolve(SETTINGS.storage.allowEphemeralOperational, o.storage?.allowEphemeralOperational),
    },
    retention: {
      sessionTranscriptDays: resolve(SETTINGS.retention.sessionTranscriptDays, o.retention?.sessionTranscriptDays),
      storedStateDays: resolve(SETTINGS.retention.storedStateDays, o.retention?.storedStateDays),
    },
    skills: {
      domainSkillCap: resolve(SETTINGS.skills.domainSkillCap, o.skills?.domainSkillCap),
    },
    slack: {
      suggestedPrompts: resolve(SETTINGS.slack.suggestedPrompts, o.slack?.suggestedPrompts),
    },
    soak: {
      capture: resolve(SETTINGS.soak.capture, o.soak?.capture),
      captureSurfacePrefix: resolve(SETTINGS.soak.captureSurfacePrefix, o.soak?.captureSurfacePrefix),
    },
    stall: {
      repeatThreshold: resolve(SETTINGS.stall.repeatThreshold, o.stall?.repeatThreshold),
    },
    sensitiveData: {
      extraPatterns: resolve(SETTINGS.sensitiveData.extraPatterns, o.sensitiveData?.extraPatterns),
    },
    taint: {
      mode: resolve(SETTINGS.taint.mode, o.taint?.mode),
      tierMode: resolve(SETTINGS.taint.tierMode, o.taint?.tierMode),
      undeclaredSurface: resolve(SETTINGS.taint.undeclaredSurface, o.taint?.undeclaredSurface),
    },
    teams: {
      serviceHosts: resolve(SETTINGS.teams.serviceHosts, o.teams?.serviceHosts),
      appId: resolve(SETTINGS.teams.appId, o.teams?.appId),
    },
    telemetry: {
      enabled: resolve(SETTINGS.telemetry.enabled, o.telemetry?.enabled),
      debug: resolve(SETTINGS.telemetry.debug, o.telemetry?.debug),
      url: resolve(SETTINGS.telemetry.url, o.telemetry?.url),
    },
    tools: {
      maxResultChars: resolve(SETTINGS.tools.maxResultChars, o.tools?.maxResultChars),
    },
    turn: {
      stepBudget: resolve(SETTINGS.turn.stepBudget, o.turn?.stepBudget),
      stepBackstopMultiple: resolve(SETTINGS.turn.stepBackstopMultiple, o.turn?.stepBackstopMultiple),
    },
    voiceClips: {
      enabled: resolve(SETTINGS.voiceClips.enabled, o.voiceClips?.enabled),
    },
    wake: {
      nameDropInclude: resolve(SETTINGS.wake.nameDropInclude, o.wake?.nameDropInclude),
      nameDropExclude: resolve(SETTINGS.wake.nameDropExclude, o.wake?.nameDropExclude),
      e2eDrivers: resolve(SETTINGS.wake.e2eDrivers, o.wake?.e2eDrivers),
      driverAllowlist: resolve(SETTINGS.wake.driverAllowlist, o.wake?.driverAllowlist),
      testWakeRoute: resolve(SETTINGS.wake.testWakeRoute, o.wake?.testWakeRoute),
    },
    webhooks: {
      allowUnverified: resolve(SETTINGS.webhooks.allowUnverified, o.webhooks?.allowUnverified),
      allowUnverifiedGithub: resolve(SETTINGS.webhooks.allowUnverifiedGithub, o.webhooks?.allowUnverifiedGithub),
      allowUnverifiedNotion: resolve(SETTINGS.webhooks.allowUnverifiedNotion, o.webhooks?.allowUnverifiedNotion),
    },
    window: {
      topology: resolve(SETTINGS.window.topology, o.window?.topology),
    },
  };
}

export interface SettingDoc {
  readonly path: string;
  readonly shipped: string;
  readonly summary: string;
}

function isSpec(value: unknown): value is SettingSpec<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { path?: unknown }).path === "string";
}

export function settingDocs(): readonly SettingDoc[] {
  const out: SettingDoc[] = [];
  for (const group of Object.values(SETTINGS as unknown as Record<string, Record<string, unknown>>)) {
    for (const spec of Object.values(group)) {
      if (!isSpec(spec)) continue;
      const rendered = spec.format ? spec.format(spec.shipped) : JSON.stringify(spec.shipped);
      out.push({ path: spec.path, shipped: rendered, summary: spec.summary });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

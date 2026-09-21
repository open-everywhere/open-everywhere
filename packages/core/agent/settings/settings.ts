import { processRegistrySlot } from "../lib/process-registry.js";
import { e2eDriversProblem, type E2eDriverIdentity } from "../testing/driver-allowlist.js";
import { sandboxRegionProblem } from "../sandbox/vercel-create.js";

export type TaintTierMode = "enforced" | "dryrun";

export type TaintMode = "on" | "off";

export type TaintUndeclaredSurface = "clean" | "mark";

export type ApprovalJudgeMode = "off" | "shadow" | "enforce";

export type ExternalAuthorGrain = "taint" | "withhold";

export type ExternalRoomGrain = "engage" | "silent";

export interface AgentSettings {
  readonly agent: {
    readonly sessionInputTokenBudget: number;
    readonly compactionThresholdPercent: number;
  };
  readonly approvals: {
    readonly judgeMode: ApprovalJudgeMode;
    readonly ttlHours: number;
    readonly sessionTtlHours: number;
    readonly checkpointTtlHours: number;
    readonly routineCardWaitSeconds: number;
  };
  readonly audit: {
    readonly silences: boolean;
  };
  readonly browser: {
    readonly enabled: boolean;
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
  readonly identityLinking: {
    readonly codeBack: boolean;
  };
  readonly delegation: {
    readonly oneshotAgent: boolean;
  };
  readonly models: {
    readonly stack: string;
  };
  readonly discord: {
    readonly autoThread: boolean;
    readonly statusUx: boolean;
  };
  readonly egress: {
    readonly enforce: boolean;
    readonly allowUnenforced: boolean;
  };
  readonly externalPolicy: {
    readonly authorGrain: ExternalAuthorGrain;
    readonly roomGrain: ExternalRoomGrain;
  };
  readonly governance: {
    readonly floorTtlMs: number;
  };
  readonly identity: {
    readonly dmTrustTtlMs: number;
    readonly name: string;
  };
  readonly memory: {
    readonly dreamCandidateCap: number;
    readonly skillProposalPr: boolean;
  };
  readonly policyPages: {
    readonly privacy: string;
    readonly terms: string;
  };
  readonly routines: {
    readonly eventMaxFanout: number;
    readonly maxConcurrency: number;
    readonly jobMaxFires: number;
    readonly jobMaxDays: number;
  };
  readonly rotation: {
    readonly quietGapHours: number;
    readonly expiryDays: number;
    readonly tokenBudget: number;
    readonly turnBudget: number;
    readonly contextSizeTokens: number;
    readonly tailTokenCap: number;
  };
  readonly sandbox: {
    readonly stopAfterTurn: boolean;
    readonly extendMaxMinutes: number;
    readonly timeoutMs: number;
    readonly snapshotExpirationMs: number;
    readonly image: string;
    readonly region: string;
  };
  readonly spend: {
    readonly usageEventsTtlDays: number;
    readonly sandboxMemoryGiB: number;
    readonly sandboxGiBHourUsd: number;
  };
  readonly skills: {
    readonly domainSkillCap: number;
  };
  readonly soak: {
    readonly capture: boolean;
    readonly captureSurfacePrefix: string | readonly string[];
  };
  readonly stall: {
    readonly repeatThreshold: number;
  };
  readonly taint: {
    readonly mode: TaintMode;
    readonly tierMode: TaintTierMode;
    readonly undeclaredSurface: TaintUndeclaredSurface;
  };
  readonly tools: {
    readonly maxResultChars: number;
  };
  readonly turn: {
    readonly stepBudget: number;
    readonly stepBackstopMultiple: number;
  };
  readonly wake: {
    readonly nameDropInclude: readonly string[];
    readonly nameDropExclude: readonly string[];
    readonly e2eDrivers: readonly E2eDriverIdentity[];
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
  readonly env?: string;
  readonly shipped: T;
  readonly parseEnv?: (raw: string) => T | undefined;
  readonly validate?: (value: T) => string | undefined;
  readonly alsoAccepts?: "string" | "object";
  readonly summary: string;
  readonly format?: (value: T) => string;
}

const positiveInt = (value: number): string | undefined =>
  Number.isInteger(value) && value > 0 ? undefined : "must be a positive integer";

const positiveNumber = (value: number): string | undefined =>
  Number.isFinite(value) && value > 0 ? undefined : "must be a positive number";

const policyTextProblem = (value: string): string | undefined =>
  value.length > 0 && value.trim().length === 0
    ? "must be either empty (no document published) or real text — a whitespace-only value renders a blank page"
    : undefined;

const stringArray = (value: readonly string[]): string | undefined =>
  Array.isArray(value) && value.every((t) => typeof t === "string") ? undefined : "must be an array of strings";

const stringOrStringArray = (value: string | readonly string[]): string | undefined =>
  typeof value === "string" || (Array.isArray(value) && value.every((t) => typeof t === "string")) ? undefined : "must be a string or an array of strings";

export const SETTINGS = {
  agent: {
    sessionInputTokenBudget: {
      path: "agent.sessionInputTokenBudget",
      shipped: 30_000_000,
      validate: positiveNumber,
      summary:
        "eve's `limits.maxInputTokensPerSession`, set BELOW the hosted 40M hard kill so the graceful park/fail fires first. KEEP IT UNDER 40M — above that the hosted wall wins and the session dies ungracefully instead of parking. Read at BOOT (it is a `defineAgent` argument).",
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
      shipped: "off",
      validate: (v) => (v === "off" || v === "shadow" || v === "enforce" ? undefined : 'must be "off", "shadow" or "enforce"'),
      summary:
        "LLM approval judge arming. `shadow` logs a would-be verdict beside every real card; `enforce` applies the judge's verdict for defer-flipped rows. `off` (shipped) runs no judge at all.",
    } satisfies SettingSpec<ApprovalJudgeMode>,
    ttlHours: {
      path: "approvals.ttlHours",
      shipped: 24,
      validate: positiveNumber,
      summary: "TTL before a pending approval action lazily expires, in hours.",
      format: (v) => `${v} h`,
    } satisfies SettingSpec<number>,
    sessionTtlHours: {
      path: "approvals.sessionTtlHours",
      shipped: 24,
      validate: positiveNumber,
      summary:
        "TTL for a `pr.open` session-approval memo (the `approve_session` third click verb), in hours. A GC bound only — the memo's frozen session id embeds the window generation, so a rotation stops it matching regardless.",
      format: (v) => `${v} h`,
    } satisfies SettingSpec<number>,
    checkpointTtlHours: {
      path: "approvals.checkpointTtlHours",
      shipped: 24,
      validate: positiveNumber,
      summary:
        "TTL for the session-checkpoint memos of a LIVE session, in hours. A GC bound, not the death mechanism — the memo's session id embeds the window generation, so a rotation drops it regardless. It does NOT bound a ROUTINE fire's continue grant, which carries no expiry: approving a durable job's checkpoint records the cost at that moment as the approved mark, and the next card fires only once the session spends a fresh threshold's worth on top of it. It still bounds that fire's \"asked\" marker, which is what lets a declined job be asked again.",
      format: (v) => `${v} h`,
    } satisfies SettingSpec<number>,
    routineCardWaitSeconds: {
      path: "approvals.routineCardWaitSeconds",
      shipped: 0,
      validate: (v) =>
        Number.isInteger(v) && v >= 0 && v <= 300 ? undefined : "must be a whole number of seconds between 0 and 300",
      summary:
        "How long an unattended routine fire's APPROVALS-PLANE refusal WAITS for its permission card to be answered before it declines for that run. 0 (shipped) waits not at all: the refusal is immediate and the card decides only FUTURE runs. It does NOT govern the CONNECTOR plane's refusal, which posts its card and refuses at once whatever this says: that refusal is computed inside the connection's own approval gate, so a wait there holds the connector call open rather than the model's turn. Armed, the refusing tool call polls the card's own pending row, and an approval inside the window lets that run proceed. THE BUDGET, and why 120 is the recommended armed value: the deployed function's wall ceiling is 300 s (measured, platform default, no app pin); the turn's own elapsed time is read off its start stamp and subtracted; the model still has to be told and the run's report posted, so 60 s is reserved. The wait is CLAMPED to what is left, whatever this value says — so a turn already 250 s old waits not at all rather than dying mid-report, and 120 is the value a turn that reached its refusal at the assumed 120 s can still afford (300 − 120 − 60). 🔴 A deadline never decides the card: it stays pending and clickable, and approving it still arms every later run.",
      format: (v) => (v === 0 ? "0 (no wait — the refusal is immediate)" : `${v} s`),
    } satisfies SettingSpec<number>,
  },
  audit: {
    silences: {
      path: "audit.silences",
      shipped: false,
      summary:
        "Write the judged-SILENCE audit rows (`unified.no_reply` and the `reply.no_reply` tool row). Off is the ACTIONS-ONLY posture: on an ambient surface these are the ~99% majority and would bury the rows that mean something. A deployment that scores abstention (the local eval targets do) turns it on in `agent/settings/settings.ts`.",
    } satisfies SettingSpec<boolean>,
  },
  browser: {
    enabled: {
      path: "browser.enabled",
      shipped: false,
      summary:
        "The in-sandbox browser master flag. Unarmed the capability does not exist: no `browser_*` tools mount, no egress hosts open, no browser bakes into the sandbox template. Arming ALSO requires at least one row in the host declaration (`agent/access/browser-hosts.ts`), which is where the reach itself lives — each row names a host, the HTTP verbs the firewall admits there, an optional credential the firewall injects at the boundary, and whether `browser_evaluate` is armed for it. Both halves are compiled into the build, so the sandbox template and the runtime mount cannot disagree.",
    } satisfies SettingSpec<boolean>,
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
      shipped: true,
      summary:
        "The connector DM-only wall: a connector operation must come from a positively-DM context (or a task worker spawned from one) or it is refused fail-closed before a token exists.",
    } satisfies SettingSpec<boolean>,
    userPrincipal: {
      path: "connectors.userPrincipal",
      shipped: false,
      summary:
        "The per-user credential path (A1): a DM surface with a `user-oauth` credential bound resolves the OAuth subject to the calling human instead of the app principal. Arming it REQUIRES `connectors.opTiering`: the member-plane deny of a personal-credential write is computed only on the tiering branch, so settings load refuses `userPrincipal` on with `opTiering` off rather than ship a posture where a declared `connector.tool:` row can lift an unattended personal-credential write.",
    } satisfies SettingSpec<boolean>,
    linkSetVault: {
      path: "connectors.linkSetVault",
      shipped: false,
      summary:
        "The C.3 shared user-OAuth vault: a confirmed link-set member keys the vault by their org-scoped link-set subject, so one consent covers all their linked DMs. Also suppresses directory auto-confirm for every link-set.",
    } satisfies SettingSpec<boolean>,
    opTiering: {
      path: "connectors.opTiering",
      shipped: false,
      summary:
        "The per-op consequence gate (A2): each `<connection>__<op>` call is classified individually (reads open, writes gated) instead of a blanket `once()`.",
    } satisfies SettingSpec<boolean>,
    memberPlane: {
      path: "connectors.memberPlane",
      shipped: false,
      summary:
        "The member plane (OPE-944): a member's own connector credential resolves in a SHARED ROOM their domain declared it for, keyed to the one verified requester of that turn, reads only. The room must also be DECLARED INTERNAL in agent/identity/surfaces.ts (OPE-1472) — an undeclared room vouches for nobody, so a deployment that has declared nothing internal has no member plane until it declares something. It does not govern DMs — a personal credential always resolves in the asker's own DM, where a write takes the ordinary approval card.",
    } satisfies SettingSpec<boolean>,
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
        "Whether this deployment DELEGATES at all. Armed, a conversational seat may hand a self-contained job to a full-hands worker through eve's built-in `agent`, and `spawn_thread_session` may mint a persistent thread seat. Disarming makes the whole delegation machinery inert: no seat holds `agent`, `spawn_thread_session` never mounts, and the wide-hands kit widens back to the task and native grains. There is no switch between delegation ROUTES — the built-in is the only one — so the only posture this expresses is LESS delegation.",
    } satisfies SettingSpec<boolean>,
  },
  models: {
    stack: {
      path: "models.stack",
      env: "OE_MODEL_STACK",
      shipped: "american-closed",
      parseEnv: (raw) => {
        const v = raw.trim();
        return v === "" ? undefined : v;
      },
      validate: (v) => (v.trim().length > 0 ? undefined : "must be a non-empty stack alias"),
      summary:
        "The named model stack this deployment runs — one alias picks a coherent model for all five roles (primary/utility/vision/supervisor/judge). Aliases are defined in `agent/model/stacks.ts`; an unknown one fails config load. Per-role overrides layer on top there, and `OE_FORCE_MODEL`/`OE_PRIMARY_MODEL` still override the primary role last.",
    } satisfies SettingSpec<string>,
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
  },
  externalPolicy: {
    authorGrain: {
      path: "externalPolicy.authorGrain",
      shipped: "taint",
      validate: (v) => (v === "taint" || v === "withhold" ? undefined : 'must be "taint" or "withhold"'),
      summary:
        'What the agent does with a message an EXCLUDED author wrote — an author the SURFACE positively refuted (Slack `is_restricted`/`is_ultra_restricted`/`is_stranger`, Entra `userType: "guest"`) or the OPERATOR\'s author-trust register refuted (`agent/identity/authors.ts`, Discord and Notion). `taint` (shipped) lets the text enter the context inside the untrusted-content envelope and leaves the consequence to the tainted-turn model and the approval plane. `withhold` stops the text ENTERING: an @mention or DM from that author gets a private notice and no action, ambient engagement never triggers on their messages, and their reply inside a permitted member\'s thread reaches the model as an arrived-marker with no body. It binds the READ verbs too: `read_channel`/`read_thread` replace that author\'s message text with the same arrived-marker, so a body a wake suppressed cannot be fetched back by reading the channel. A withheld body never ingests, so it never keys taint. The two mechanisms COEXIST — the envelope is provenance-based and stays as it is; withhold is identity-based. On a tenant the operator has NOT armed nothing is excluded, so `withhold` changes nothing there. \u26a0\ufe0f EVERY CHAT SURFACE READS IT, BUT THE EVIDENCE DIFFERS PER SURFACE. Slack and Teams refute an author themselves; Discord and Notion read the operator\'s register; GitHub refutes on the comment\'s `author_association` (`OWNER`, `MEMBER` and `COLLABORATOR` each hold a deliberate access grant and are internal — every other value, `CONTRIBUTOR` and `MANNEQUIN` included, is excluded); Linear refutes a workspace guest (`User.guest`). \u26a0\ufe0f GITHUB AND LINEAR HAVE NO PRIVATE CHANNEL back to a commenter, so an AMBIENT excluded author\'s message is a silent drop with an audit row and nothing posted. An explicit @mention from an excluded author still gets one fixed, identity-blind acknowledgement line (`EXTERNAL_MENTION_ACK` — names no person, no organisation, no setting, no verdict) on both surfaces, so the mentioning member never reads the agent as broken; on Linear it posts as a `response` Agent Activity, which also ends the session, so no spinner is left open. Two known limits elsewhere — a Slack GROUP DM has no partner to refute, so it can never be suppressed; and Discord\'s hydrated context lines are not filtered, so an excluded author quoted there still reaches the model when the TRIGGER author is permitted. EVERY chat reader — `read_channel`/`read_thread` and the delegated worker\'s `read_work_channel`/`read_work_thread` — routes through ONE grade-and-project body (`readChannelResult`/`readThreadResult`), so the author-taint mark and the `withhold` read half are declared once and no reader can declare them differently.',
    } satisfies SettingSpec<ExternalAuthorGrain>,
    roomGrain: {
      path: "externalPolicy.roomGrain",
      shipped: "engage",
      validate: (v) => (v === "engage" || v === "silent" ? undefined : 'must be "engage" or "silent"'),
      summary:
        "Whether the agent engages in a room the classification calls EXTERNAL — a room the operator declared `public` in the trust registry, a room the vendor reports as spanning another organisation (Slack Connect, a Teams shared channel), or a room whose ingested set contains a refuted author. `engage` (shipped) is today's behaviour. `silent` announces at most twice per room — once on join, once on the first wake it suppresses — and never repeats; there is deliberately NO periodic re-announcement. ⚠️ NOT EVERY SURFACE READS IT THE SAME WAY: `silent` suppresses a wake on SLACK, DISCORD, TEAMS, GITHUB and LINEAR. Discord and Teams post the suppressed-wake notice only, because neither surface delivers a join event the agent can hang the join notice on. Slack posts both halves, but its JOIN half fires only where `conversations.info` already refused the channel as not-internal — a channel the operator declared `public` that Slack reports internal is still silenced and still announces at its first suppressed wake, but gets no join notice. GitHub and Linear read the OPERATOR-DECLARED leg and the REFUTED-AUTHOR leg (neither surface has a vendor-external signal) and post NO announcement on either half — neither has a private channel back to a commenter, so an AMBIENT or NAME-DROP wake it silences is a silent drop with an audit row and nothing posted. An explicit @mention still gets the same fixed, identity-blind acknowledgement line every other silenced surface's addressed suppression gets; on Linear it posts as a `response` Agent Activity, which also ends the session. ⚠️ `silent` HAS NO CONFIG-VALIDATION ERROR FOR A HALF-DECLARATION, ONLY A BOOT WARNING: the EXTERNAL classification has three legs and only the OPERATOR-DECLARED one is visible in static config, so a domain that sets `roomGrain: \"silent\"` with no matching `public` trust entry gets a `console.warn` at boot naming the channel, not a boot failure — a vendor-external or guest-present signal can still arm it correctly at runtime, and refusing boot on that shape would be a false positive (`agent/lib/register-config.ts` calls `warnSilentRoomGrainWithoutPublicSignal`, `packages/core/agent/memory/domain.ts`).",
    } satisfies SettingSpec<ExternalRoomGrain>,
  },
  governance: {
    floorTtlMs: {
      path: "governance.floorTtlMs",
      shipped: 15 * 60_000,
      validate: positiveNumber,
      summary:
        "Memoisation TTL for the room roster and the governance attestation behind the audience floor — the one computation shared by the admin-governance floor, the connector-disclosure floor, the triggered-fire disclosure floor, the approval-card clicker floor and the card-disclosure floor.",
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
        "The deployment's CANONICAL agent name — the ONLY name the agent calls itself, on every surface (OPE-610). Unset (the shipped `\"\"`) renders the generic identity line (\"Identify as this team's agent\") even where a surface has a live display-name arm: a per-surface app's own name is a HANDLE/address, never a substitute identity, so it never feeds the identity line. Each provider bundle registers that arm (`agent/identity/bot-display-name.ts`); Slack, Microsoft Teams and Discord ship one, rendered as a separate handle line (\"your mention/handle on X appears as Y\") for self-recognition of mentions/backscroll — the other surfaces resolve no handle. Configuring this setting matters most for a CROSS-SURFACE session, which speaks on several surfaces from one standing block: before this setting existed, a Teams delivery introduced the agent by the SLACK workspace display name (OPE-569). Set it and one name answers everywhere, on the per-surface path and the cross-surface path alike. It ALSO joins the name-drop token set (`agent/identity/bot-name.ts`) that the Notion synthetic-mention recogniser and the addressed link-claim hook match on, so the agent answers to the name it introduces itself by. It is ADDITIVE there — the brand and short-name tokens still match. It ALSO joins the SLACK and DISCORD ambient name-drop wake trigger set (OPE-571), alongside those surfaces' own live display names — see `wake.nameDrop.include`/`wake.nameDrop.exclude` to extend or narrow that set further.",
      format: (v) => (v === "" ? "`` (unset — generic identity line; per-surface handle still shown separately where resolved)" : v),
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
      shipped: false,
      summary:
        "Whether a Mode-1 SKILL proposal also opens a PULL REQUEST on the config repo (`accessRequests.configRepo`), adding the drafted skill under `.agents/skills/<name>/SKILL.md` on its own branch. Off ships the v1 behaviour: the proposal is recorded in the review queue and nothing reaches GitHub. On, MERGING the pull request is what arms the skill — the cycle never merges, never pushes to the base branch, and needs no credential beyond the one the access-request and credential-binding flows already use. A person's review or comment on a proposal is read back as a CORRECTION and carried into the next proposal for that scope, and only an author with repository standing (GitHub's `author_association`: OWNER, MEMBER or COLLABORATOR) counts.",
    } satisfies SettingSpec<boolean>,
  },
  policyPages: {
    privacy: {
      path: "policyPages.privacy",
      shipped: "",
      validate: policyTextProblem,
      summary:
        "The operator's PRIVACY POLICY, served as `GET /privacy` — the URL `teams-app/manifest.json` declares as `privacyUrl`. Free text, rendered ESCAPED and as PLAIN TEXT with its line breaks kept: never as HTML and never as markdown, so the route cannot become a way to serve arbitrary markup from this deployment's origin. Empty (shipped) ⇒ the route answers 200 with a placeholder page saying no policy is published yet and naming this setting; it never 404s, because a manifest pointing at a 404 is the defect the route exists to remove.",
      format: (v) => (v === "" ? "`` (unset — `/privacy` serves the placeholder page)" : "the operator's own text"),
    } satisfies SettingSpec<string>,
    terms: {
      path: "policyPages.terms",
      shipped: "",
      validate: policyTextProblem,
      summary:
        "The operator's TERMS OF USE, served as `GET /terms` — the URL `teams-app/manifest.json` declares as `termsOfUseUrl`. Same rendering and same unset behaviour as `policyPages.privacy`.",
      format: (v) => (v === "" ? "`` (unset — `/terms` serves the placeholder page)" : "the operator's own text"),
    } satisfies SettingSpec<string>,
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
      summary: "Fire cap minted onto a fresh durable-job bound. Plain `cron`/`interval` routines are unbounded by design.",
    } satisfies SettingSpec<number>,
    jobMaxDays: {
      path: "routines.jobMaxDays",
      shipped: 7,
      validate: positiveInt,
      summary: "Wall-clock grace minted onto a fresh durable-job bound, in days. Stretched so a slow cadence still gets a fair sample of runs.",
      format: (v) => `${v} d`,
    } satisfies SettingSpec<number>,
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
        "Token BACKSTOP (demoted from primary by OPE-345, value unchanged): the measured cumulative `inputTokens + cacheReadTokens` on one generation. Also the route the session-park remedy uses — parking saturates this counter.",
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
        "Context-size BACKSTOP: the LAST request's measured `inputTokens + cacheReadTokens` — the same measure compaction reads, not the cumulative counter `rotation.tokenBudget` meters. It sits BELOW the compaction fire point on purpose, so a standing seat re-mints a fresh generation with a recorded tail instead of compacting into a summary. Compaction still owns delegated and worker runs, which never reach the rotation chain.",
    } satisfies SettingSpec<number>,
    tailTokenCap: {
      path: "rotation.tailTokenCap",
      shipped: 5_000,
      validate: positiveNumber,
      summary:
        "Token cap on the last-generation TAIL a fresh generation's first wake carries — the recorded wake messages and the seat's own posts, selected most-recent-first. Tight on purpose: the tail makes the seat conversational, and its read tools and memory cover everything older.",
    } satisfies SettingSpec<number>,
  },
  sandbox: {
    stopAfterTurn: {
      path: "sandbox.stopAfterTurn",
      shipped: true,
      summary:
        "Stop the sandbox compute the moment each turn's reply is sent rather than letting it idle out the timeout window. On Vercel the stop auto-snapshots and the next turn auto-resumes; on the docker backend the session container is stopped (never removed) and restarted on next use. The just-bash backend has no compute to stop — it runs inside the app process — so this setting is inert there and the hook logs which backend owns the stop at the first turn end.",
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
        "The per-session sandbox window, in ms. With stop-after-turn owning idle cost this is a BACKSTOP fuse — it binds only when the turn-end hook cannot run — and the max continuous work one session may do. **Applied at sandbox CREATE and persisted on the sandbox, so a change only affects NEW conversations.**",
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
  skills: {
    domainSkillCap: {
      path: "skills.domainSkillCap",
      shipped: 50,
      validate: positiveInt,
      summary:
        "Max runtime-authored domain skills per domain (`create_skill` refuses past this). Per-skill content size is capped separately, in code.",
    } satisfies SettingSpec<number>,
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
        "Extra name tokens the Slack/Discord AMBIENT name-drop wake fires on, beyond the surface's live vendor display name and `identity.name` (OPE-571). Case-insensitive, matched the same word-boundary way as the automatic base — no regex, no predicate. Widening ambient wake is the operator's own choice, made by diff.",
      format: (v) => (v.length > 0 ? v.join(", ") : "(none)"),
    } satisfies SettingSpec<readonly string[]>,
    nameDropExclude: {
      path: "wake.nameDrop.exclude",
      shipped: [] as readonly string[],
      validate: stringArray,
      summary:
        "Name tokens the Slack/Discord name-drop wake NEVER fires on, even when the live display name, `identity.name`, or `wake.nameDrop.include` would otherwise carry them. WINS over both — the narrowing always has the last word.",
      format: (v) => (v.length > 0 ? v.join(", ") : "(none)"),
    } satisfies SettingSpec<readonly string[]>,
    e2eDrivers: {
      path: "wake.e2eDrivers",
      shipped: [] as readonly E2eDriverIdentity[],
      validate: e2eDriversProblem,
      summary:
        "The e2e DRIVER bot identities the seat doors admit, one `{ surface, principal }` entry per identity. `principal` is written in the surface's OWN id vocabulary: Slack a `teamId:botId` pair (the workspace and the POSTING APP's `B…` bot record, which is what a `message.im`/`message.mpim` event carries in `bot_id`), Discord the driver bot's user-id snowflake, Notion the driver integration's bot id. Every chat surface stamps a machine author on anything a script posts — Slack does it on a USER token too, and Discord bans user tokens outright — so without this the e2e pack cannot drive a real seat and its legs can only forge an envelope. Empty (shipped) ⇒ a bot-authored DM drops at the Slack DM door with its `surface.wake_dropped` row, and a message a surface tags as machine-authored is refused in a seat's catch-up read by the domain's own admission policy, exactly as before. 🔴 NOTION IS THE ONE SURFACE THAT CANNOT TAG ONE (OPE-1857): it serves a comment's `created_by` as a partial user with no `type`, so a catch-up read cannot tell an integration's comment from a person's and `wide` admits it at the `unauth` floor whether or not this list names it. A `notion` entry therefore widens only the case where Notion DOES state a `type`; it is not what admits the driver today. 🔴 A `members-only` domain refuses an UNLISTED machine author alike, but NOT a listed one: the carve-out ORs past the domain's own policy, so a LISTED identity enters a seat in any domain. Set ⇒ a LISTED identity is admitted at the Slack DM door (which writes a `surface.wake_admitted` row naming the carve-out, and resolves author trust from the HUMAN `user` the post carries — no trust is invented for the bot), and enters the standing seat's own reads — the since-last-wake catch-up, the bootstrap window and the name-drop hydration, every read `seatAdmissionFor` governs — wherever that ONE identity speaks on its own surface, at the `relay` tier every machine author already carries. The PRINCIPAL is what pins the reach: a Slack entry is workspace-pinned by its `teamId:botId` pair, while a Discord or Notion entry names a globally unique vendor id and reaches that identity's rooms on that surface. 🔴 THE DOOR AND THE READ ASK ONE PREDICATE (OPE-1969), so the two cannot disagree about one identity: the read was scoped to the `e2e-engaged` domain alone until a fixture room no domain claims showed the disagreement — the door admitted the driver and the seat's catch-up dropped it. An unlisted bot is refused exactly as it was before, on every surface and in every room. Deliberately SEPARATE from the `OE_TEST_DRIVER_IDS` allowlist that lifts a driver at the engagement and mention doors: a seat holds a window token, delegation and memory, so admitting a bot there is a larger grant and is made by its own reviewed diff. TEST BEDS ONLY — a real deployment leaves it empty.",
      format: (v) => (v.length > 0 ? v.map((d) => `${d.surface}: ${d.principal}`).join(", ") : "(none)"),
    } satisfies SettingSpec<readonly E2eDriverIdentity[]>,
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
      shipped: false,
      summary:
        "The STANDING-SEAT apparatus — the ONE gate governing every seat and every window shape: the per-channel `solo` seat every channel the bot is in gets, a named `windows` group, and the cross-surface `unified` window. On, addressing decides what enters a seat and what wakes it, never the shape of the session: a mention lands in the room's own standing seat, and an undeclared channel inherits the `org` pseudo-domain's defaults (its own solo seat — never a shared context). 🔴 That inheritance is the ONE fail-closed arm: a deployment that declares NO `org` pseudo-domain leaves an undeclared channel with no domain to inherit, so it keeps the native per-container path even with this gate on. Off, every domain runs the native per-container path, a mention opens eve's per-thread session, and `mode` and `windows` are inert. **Arm deliberately: a `unified` window is a wider data blast radius.** The since-last-wake catch-up read — a seat arriving with what the room said while it was not woken — runs on every surface through one shared path, each reading its own container (a Slack or Discord channel, a Teams channel over Microsoft Graph, a GitHub issue or pull request, a Linear issue, a Notion page discussion). A surface that registers NO history fetch states that in the wake rather than arriving with an empty context; a registered read that fails stays fail-soft to empty, so a revoked history scope reads as a quiet room.",
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
    "connectors.userPrincipal: armed without connectors.opTiering. The per-user credential path resolves a personal " +
    "credential in a DM, and every member-plane deny of a personal-credential write is computed only on the " +
    "connectors.opTiering branch — so this posture lets a declared `connector.tool:` row lift an unattended " +
    "personal-credential write that the tiering-on path denies outright. Arm connectors.opTiering as well, or leave " +
    "connectors.userPrincipal off"
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

function resolve<T>(spec: SettingSpec<T>, override: T | undefined, env: NodeJS.ProcessEnv): T {
  if (spec.env !== undefined && spec.parseEnv !== undefined) {
    const raw = env[spec.env];
    if (raw !== undefined) {
      const parsed = spec.parseEnv(raw);
      if (parsed !== undefined) return parsed;
    }
  }
  return override ?? spec.shipped;
}

export function getSettings(
  env: NodeJS.ProcessEnv = process.env,
  overrides: AgentSettingsOverrides = registeredOverrides(),
): AgentSettings {
  const o = overrides;
  return {
    agent: {
      sessionInputTokenBudget: resolve(SETTINGS.agent.sessionInputTokenBudget, o.agent?.sessionInputTokenBudget, env),
      compactionThresholdPercent: resolve(SETTINGS.agent.compactionThresholdPercent, o.agent?.compactionThresholdPercent, env),
    },
    approvals: {
      judgeMode: resolve(SETTINGS.approvals.judgeMode, o.approvals?.judgeMode, env),
      ttlHours: resolve(SETTINGS.approvals.ttlHours, o.approvals?.ttlHours, env),
      sessionTtlHours: resolve(SETTINGS.approvals.sessionTtlHours, o.approvals?.sessionTtlHours, env),
      checkpointTtlHours: resolve(SETTINGS.approvals.checkpointTtlHours, o.approvals?.checkpointTtlHours, env),
      routineCardWaitSeconds: resolve(SETTINGS.approvals.routineCardWaitSeconds, o.approvals?.routineCardWaitSeconds, env),
    },
    audit: {
      silences: resolve(SETTINGS.audit.silences, o.audit?.silences, env),
    },
    browser: {
      enabled: resolve(SETTINGS.browser.enabled, o.browser?.enabled, env),
    },
    bash: {
      timeoutMs: resolve(SETTINGS.bash.timeoutMs, o.bash?.timeoutMs, env),
      backgroundGuard: resolve(SETTINGS.bash.backgroundGuard, o.bash?.backgroundGuard, env),
    },
    connectors: {
      dmOnly: resolve(SETTINGS.connectors.dmOnly, o.connectors?.dmOnly, env),
      userPrincipal: resolve(SETTINGS.connectors.userPrincipal, o.connectors?.userPrincipal, env),
      linkSetVault: resolve(SETTINGS.connectors.linkSetVault, o.connectors?.linkSetVault, env),
      opTiering: resolve(SETTINGS.connectors.opTiering, o.connectors?.opTiering, env),
      memberPlane: resolve(SETTINGS.connectors.memberPlane, o.connectors?.memberPlane, env),
    },
    identityLinking: {
      codeBack: resolve(SETTINGS.identityLinking.codeBack, o.identityLinking?.codeBack, env),
    },
    delegation: {
      oneshotAgent: resolve(SETTINGS.delegation.oneshotAgent, o.delegation?.oneshotAgent, env),
    },
    models: {
      stack: resolve(SETTINGS.models.stack, o.models?.stack, env),
    },
    discord: {
      autoThread: resolve(SETTINGS.discord.autoThread, o.discord?.autoThread, env),
      statusUx: resolve(SETTINGS.discord.statusUx, o.discord?.statusUx, env),
    },
    egress: {
      enforce: resolve(SETTINGS.egress.enforce, o.egress?.enforce, env),
      allowUnenforced: resolve(SETTINGS.egress.allowUnenforced, o.egress?.allowUnenforced, env),
    },
    externalPolicy: {
      authorGrain: resolve(SETTINGS.externalPolicy.authorGrain, o.externalPolicy?.authorGrain, env),
      roomGrain: resolve(SETTINGS.externalPolicy.roomGrain, o.externalPolicy?.roomGrain, env),
    },
    governance: {
      floorTtlMs: resolve(SETTINGS.governance.floorTtlMs, o.governance?.floorTtlMs, env),
    },
    identity: {
      dmTrustTtlMs: resolve(SETTINGS.identity.dmTrustTtlMs, o.identity?.dmTrustTtlMs, env),
      name: resolve(SETTINGS.identity.name, o.identity?.name, env),
    },
    memory: {
      dreamCandidateCap: resolve(SETTINGS.memory.dreamCandidateCap, o.memory?.dreamCandidateCap, env),
      skillProposalPr: resolve(SETTINGS.memory.skillProposalPr, o.memory?.skillProposalPr, env),
    },
    policyPages: {
      privacy: resolve(SETTINGS.policyPages.privacy, o.policyPages?.privacy, env),
      terms: resolve(SETTINGS.policyPages.terms, o.policyPages?.terms, env),
    },
    routines: {
      eventMaxFanout: resolve(SETTINGS.routines.eventMaxFanout, o.routines?.eventMaxFanout, env),
      maxConcurrency: resolve(SETTINGS.routines.maxConcurrency, o.routines?.maxConcurrency, env),
      jobMaxFires: resolve(SETTINGS.routines.jobMaxFires, o.routines?.jobMaxFires, env),
      jobMaxDays: resolve(SETTINGS.routines.jobMaxDays, o.routines?.jobMaxDays, env),
    },
    rotation: {
      quietGapHours: resolve(SETTINGS.rotation.quietGapHours, o.rotation?.quietGapHours, env),
      expiryDays: resolve(SETTINGS.rotation.expiryDays, o.rotation?.expiryDays, env),
      tokenBudget: resolve(SETTINGS.rotation.tokenBudget, o.rotation?.tokenBudget, env),
      turnBudget: resolve(SETTINGS.rotation.turnBudget, o.rotation?.turnBudget, env),
      contextSizeTokens: resolve(SETTINGS.rotation.contextSizeTokens, o.rotation?.contextSizeTokens, env),
      tailTokenCap: resolve(SETTINGS.rotation.tailTokenCap, o.rotation?.tailTokenCap, env),
    },
    sandbox: {
      stopAfterTurn: resolve(SETTINGS.sandbox.stopAfterTurn, o.sandbox?.stopAfterTurn, env),
      extendMaxMinutes: resolve(SETTINGS.sandbox.extendMaxMinutes, o.sandbox?.extendMaxMinutes, env),
      timeoutMs: resolve(SETTINGS.sandbox.timeoutMs, o.sandbox?.timeoutMs, env),
      snapshotExpirationMs: resolve(SETTINGS.sandbox.snapshotExpirationMs, o.sandbox?.snapshotExpirationMs, env),
      image: resolve(SETTINGS.sandbox.image, o.sandbox?.image, env),
      region: resolve(SETTINGS.sandbox.region, o.sandbox?.region, env),
    },
    spend: {
      usageEventsTtlDays: resolve(SETTINGS.spend.usageEventsTtlDays, o.spend?.usageEventsTtlDays, env),
      sandboxMemoryGiB: resolve(SETTINGS.spend.sandboxMemoryGiB, o.spend?.sandboxMemoryGiB, env),
      sandboxGiBHourUsd: resolve(SETTINGS.spend.sandboxGiBHourUsd, o.spend?.sandboxGiBHourUsd, env),
    },
    skills: {
      domainSkillCap: resolve(SETTINGS.skills.domainSkillCap, o.skills?.domainSkillCap, env),
    },
    soak: {
      capture: resolve(SETTINGS.soak.capture, o.soak?.capture, env),
      captureSurfacePrefix: resolve(SETTINGS.soak.captureSurfacePrefix, o.soak?.captureSurfacePrefix, env),
    },
    stall: {
      repeatThreshold: resolve(SETTINGS.stall.repeatThreshold, o.stall?.repeatThreshold, env),
    },
    taint: {
      mode: resolve(SETTINGS.taint.mode, o.taint?.mode, env),
      tierMode: resolve(SETTINGS.taint.tierMode, o.taint?.tierMode, env),
      undeclaredSurface: resolve(SETTINGS.taint.undeclaredSurface, o.taint?.undeclaredSurface, env),
    },
    tools: {
      maxResultChars: resolve(SETTINGS.tools.maxResultChars, o.tools?.maxResultChars, env),
    },
    turn: {
      stepBudget: resolve(SETTINGS.turn.stepBudget, o.turn?.stepBudget, env),
      stepBackstopMultiple: resolve(SETTINGS.turn.stepBackstopMultiple, o.turn?.stepBackstopMultiple, env),
    },
    wake: {
      nameDropInclude: resolve(SETTINGS.wake.nameDropInclude, o.wake?.nameDropInclude, env),
      nameDropExclude: resolve(SETTINGS.wake.nameDropExclude, o.wake?.nameDropExclude, env),
      e2eDrivers: resolve(SETTINGS.wake.e2eDrivers, o.wake?.e2eDrivers, env),
    },
    webhooks: {
      allowUnverified: resolve(SETTINGS.webhooks.allowUnverified, o.webhooks?.allowUnverified, env),
      allowUnverifiedGithub: resolve(SETTINGS.webhooks.allowUnverifiedGithub, o.webhooks?.allowUnverifiedGithub, env),
      allowUnverifiedNotion: resolve(SETTINGS.webhooks.allowUnverifiedNotion, o.webhooks?.allowUnverifiedNotion, env),
    },
    window: {
      topology: resolve(SETTINGS.window.topology, o.window?.topology, env),
    },
  };
}

export interface SettingDoc {
  readonly path: string;
  readonly env?: string;
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
      out.push({ path: spec.path, env: spec.env, shipped: rendered, summary: spec.summary });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function settingEnvNames(): readonly string[] {
  return settingDocs()
    .map((d) => d.env)
    .filter((e): e is string => e !== undefined)
    .sort();
}

export type TaintTierMode = "enforced" | "dryrun";

export type TaintMode = "on" | "off";

export type ApprovalJudgeMode = "off" | "shadow" | "enforce";

export interface AgentSettings {
  readonly approvals: {
    readonly judgeMode: ApprovalJudgeMode;
    readonly ttlHours: number;
    readonly sessionTtlHours: number;
    readonly checkpointTtlHours: number;
  };
  readonly audit: {
    readonly silences: boolean;
  };
  readonly browser: {
    readonly enabled: boolean;
    readonly domains: string;
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
  };
  readonly delegation: {
    readonly oneshotAgent: boolean;
    readonly nativeSubagent: boolean;
  };
  readonly models: {
    readonly stack: string;
  readonly discord: {
    readonly autoThread: boolean;
    readonly statusUx: boolean;
  };
  readonly egress: {
    readonly enforce: boolean;
    readonly allowUnenforced: boolean;
  };
  readonly governance: {
    readonly floorTtlMs: number;
  };
  readonly identity: {
    readonly dmTrustTtlMs: number;
  };
  readonly memory: {
    readonly dreamCandidateCap: number;
  };
  readonly routines: {
    readonly eventMaxFanout: number;
    readonly maxConcurrency: number;
    readonly jobMaxFires: number;
    readonly jobMaxDays: number;
  };
  readonly sandbox: {
    readonly stopAfterTurn: boolean;
    readonly extendMaxMinutes: number;
    readonly timeoutMs: number;
    readonly snapshotExpirationMs: number;
    readonly image: string;
  };
  readonly spend: {
    readonly usageEventsTtlDays: number;
    readonly sandboxMemoryGiB: number;
    readonly sandboxGiBHourUsd: number;
  };
  readonly skills: {
    readonly domainSkillCap: number;
  };
  readonly stall: {
    readonly repeatThreshold: number;
  };
  readonly taint: {
    readonly mode: TaintMode;
    readonly tierMode: TaintTierMode;
  };
  readonly tools: {
    readonly maxResultChars: number;
    readonly sourceScopedMount: boolean;
    readonly genericReadVerbs: boolean;
  };
  readonly window: {
    readonly topology: boolean;
    readonly unifiedRedrive: boolean;
  };
}

export interface SettingSpec<T> {
  readonly path: string;
  readonly env?: string;
  readonly shipped: T;
  readonly parseEnv?: (raw: string) => T | undefined;
  readonly validate?: (value: T) => string | undefined;
  readonly summary: string;
  readonly format?: (value: T) => string;
}

const OFF_SPELLINGS_WIDE = new Set(["", "0", "false", "off", "no"]);

const parseWideBoolean = (raw: string): boolean => !OFF_SPELLINGS_WIDE.has(raw.trim().toLowerCase());

const positiveInt = (value: number): string | undefined =>
  Number.isInteger(value) && value > 0 ? undefined : "must be a positive integer";

const positiveNumber = (value: number): string | undefined =>
  Number.isFinite(value) && value > 0 ? undefined : "must be a positive number";

const positiveNumberEnv = (raw: string): number | undefined => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const positiveIntEnv = (raw: string): number | undefined => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

const wholePositiveIntEnv = (raw: string): number | undefined => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export const SETTINGS = {
  approvals: {
    judgeMode: {
      path: "approvals.judgeMode",
      env: "OE_APPROVAL_JUDGE",
      shipped: "off",
      parseEnv: (raw) => {
        const v = raw.trim();
        return v === "shadow" ? "shadow" : v === "enforce" ? "enforce" : "off";
      },
      summary:
        "LLM approval judge arming. `shadow` logs a would-be verdict beside every real card; `enforce` applies the judge's verdict for defer-flipped rows. Any other value is off, fail-closed.",
    } satisfies SettingSpec<ApprovalJudgeMode>,
    ttlHours: {
      path: "approvals.ttlHours",
      env: "OE_APPROVAL_TTL_HOURS",
      shipped: 24,
      parseEnv: positiveNumberEnv,
      validate: positiveNumber,
      summary: "TTL before a pending approval action lazily expires, in hours.",
      format: (v) => `${v} h`,
    } satisfies SettingSpec<number>,
    sessionTtlHours: {
      path: "approvals.sessionTtlHours",
      env: "OE_PR_SESSION_APPROVAL_TTL_HOURS",
      shipped: 24,
      parseEnv: positiveNumberEnv,
      validate: positiveNumber,
      summary:
        "TTL for a `pr.open` session-approval memo (the `approve_session` third click verb), in hours. A GC bound only — the memo's frozen session id embeds the window generation, so a rotation stops it matching regardless.",
      format: (v) => `${v} h`,
    } satisfies SettingSpec<number>,
    checkpointTtlHours: {
      path: "approvals.checkpointTtlHours",
      env: "OE_CHECKPOINT_TTL_HOURS",
      shipped: 24,
      parseEnv: positiveNumberEnv,
      validate: positiveNumber,
      summary:
        "TTL for the session-checkpoint continue/asked memos, in hours. Also a GC bound, not the death mechanism.",
      format: (v) => `${v} h`,
    } satisfies SettingSpec<number>,
  },
  audit: {
    silences: {
      path: "audit.silences",
      env: "OE_AUDIT_SILENCES",
      shipped: false,
      parseEnv: (raw) => raw === "1",
      summary:
        "Write the judged-SILENCE audit rows (`unified.no_reply` and the `reply.no_reply` tool row). Off is the ACTIONS-ONLY posture: on an ambient surface these are the ~99% majority and would bury the rows that mean something.",
    } satisfies SettingSpec<boolean>,
  },
  browser: {
    enabled: {
      path: "browser.enabled",
      env: "OE_AGENT_BROWSER",
      shipped: false,
      parseEnv: (raw) => raw === "1",
      summary:
        "The Browser-QA master flag. Unarmed the capability does not exist: no `browser_*` tools mount, no egress hosts open, no browser bakes into the sandbox template. Arming ALSO requires a valid `browser.domains` allowlist, and the value must reach the BUILD env too (the template revalidation key resolves at build).",
    } satisfies SettingSpec<boolean>,
    domains: {
      path: "browser.domains",
      env: "OE_AGENT_BROWSER_DOMAINS",
      shipped: "",
      parseEnv: (raw) => raw,
      summary:
        "Comma-separated browse-target hostnames — the operator's containment decision, enforced on BOTH walls (agent-browser `--allowed-domains` and the sandbox egress firewall). Bare lowercase hostnames only; ANY invalid entry invalidates the whole list, and `browser.enabled` with an empty or invalid list does not arm.",
      format: (v) => (v === "" ? "`` (unset — the capability cannot arm)" : v),
    } satisfies SettingSpec<string>,
  },
  bash: {
    timeoutMs: {
      path: "bash.timeoutMs",
      env: "OE_BASH_TIMEOUT_MS",
      shipped: 600_000,
      parseEnv: (raw) => {
        const v = raw.trim().toLowerCase();
        if (v === "") return undefined;
        if (v === "0" || v === "off" || v === "false") return 0;
        const n = Number.parseInt(v, 10);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      },
      validate: (v) => (Number.isInteger(v) && v >= 0 ? undefined : "must be a non-negative integer (0 disables the timeout)"),
      summary: "Wall-clock cap on one `bash` call, in ms. `0` disables the timeout entirely.",
      format: (v) => `${v} ms`,
    } satisfies SettingSpec<number>,
    backgroundGuard: {
      path: "bash.backgroundGuard",
      env: "OE_BASH_BACKGROUND_GUARD",
      shipped: true,
      parseEnv: (raw) => {
        const v = raw.trim().toLowerCase();
        return !(v === "0" || v === "off" || v === "false");
      },
      summary:
        "Refuse before it runs any command that backgrounds a segment with a bare `&` while redirecting neither stdout nor stderr.",
    } satisfies SettingSpec<boolean>,
  },
  connectors: {
    dmOnly: {
      path: "connectors.dmOnly",
      env: "OE_CONNECTOR_DM_ONLY",
      shipped: true,
      parseEnv: (raw) => {
        const v = raw.trim().toLowerCase();
        if (v === "") return true;
        return !(v === "0" || v === "false" || v === "off");
      },
      summary:
        "The connector DM-only wall: a connector operation must come from a positively-DM context (or a task worker spawned from one) or it is refused fail-closed before a token exists.",
    } satisfies SettingSpec<boolean>,
    userPrincipal: {
      path: "connectors.userPrincipal",
      env: "OE_CONNECTOR_USER_PRINCIPAL",
      shipped: false,
      parseEnv: parseWideBoolean,
      summary:
        "The per-user credential path (A1): a DM surface with a `user-oauth` credential bound resolves the OAuth subject to the calling human instead of the app principal.",
    } satisfies SettingSpec<boolean>,
    linkSetVault: {
      path: "connectors.linkSetVault",
      env: "OE_CONNECTOR_LINKSET_VAULT",
      shipped: false,
      parseEnv: parseWideBoolean,
      summary:
        "The C.3 shared user-OAuth vault: a confirmed link-set member keys the vault by their org-scoped link-set subject, so one consent covers all their linked DMs. Also suppresses directory auto-confirm for every link-set.",
    } satisfies SettingSpec<boolean>,
    opTiering: {
      path: "connectors.opTiering",
      env: "OE_CONNECTOR_OP_TIERING",
      shipped: false,
      parseEnv: parseWideBoolean,
      summary:
        "The per-op consequence gate (A2): each `<connection>__<op>` call is classified individually (reads open, writes gated) instead of a blanket `once()`.",
    } satisfies SettingSpec<boolean>,
  },
  delegation: {
    oneshotAgent: {
      path: "delegation.oneshotAgent",
      env: "OE_ONESHOT_AGENT",
      shipped: true,
      parseEnv: parseWideBoolean,
      summary:
        "The one-shot `agent` delegation model: `agent` spawns a credential-correct new session that works, calls `return_result` and tears down. Disarming makes the whole delegation machinery inert.",
    } satisfies SettingSpec<boolean>,
    nativeSubagent: {
      path: "delegation.nativeSubagent",
      env: "OE_NATIVE_SUBAGENT",
      shipped: false,
      parseEnv: (raw) => {
        const v = raw.trim().toLowerCase();
        return v === "" || v === "0" || v === "false" || v === "off" || v === "no" ? false : undefined;
      },
      summary:
        "Use eve's BUILT-IN `agent` subagent as the delegation route instead of OE's roll-own one-shot worker. Arming it takes a reviewed diff AND an `oe build` (the built-in is suppressed by a generated static sentinel); the env var is an OFF-ONLY kill switch. Native children share the parent's sandbox and bind to the parent's identity; delegation is withdrawn entirely on a tainted turn, because eve has no seam to forward taint into a child.",
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
  discord: {
    autoThread: {
      path: "discord.autoThread",
      env: "OE_DISCORD_AUTO_THREAD",
      shipped: true,
      parseEnv: (raw) => raw !== "false" && raw !== "0",
      summary:
        "Reply in a thread when the bot is @mentioned in a Discord text or announcement channel (never inside a thread — threads don't nest, and an unknown channel type keeps the inline reply).",
    } satisfies SettingSpec<boolean>,
    statusUx: {
      path: "discord.statusUx",
      env: "OE_DISCORD_STATUS_UX",
      shipped: true,
      parseEnv: (raw) => raw !== "false" && raw !== "0",
      summary:
        "The Discord 'working' affordances — the 👀/✅ reaction and the holding message edited into the reply. Off, the surface behaves exactly as before the feature: one plain reply post, no reaction, no holding message.",
    } satisfies SettingSpec<boolean>,
  },
  egress: {
    enforce: {
      path: "egress.enforce",
      env: "OE_EGRESS_ENFORCE",
      shipped: true,
      parseEnv: (raw) => raw !== "0",
      summary:
        "Apply the compiled per-session egress policy for real. Off ⇒ dry-run (compile + audit, no apply) — except a COMPILE ERROR, whose deny-all is applied either way: dry-run relaxes the intended policy, never a failure to compute one.",
    } satisfies SettingSpec<boolean>,
    allowUnenforced: {
      path: "egress.allowUnenforced",
      env: "OE_ALLOW_UNENFORCED_EGRESS",
      shipped: false,
      parseEnv: (raw) => raw === "1",
      summary:
        "Let a session CONTINUE when the sandbox backend cannot apply fine-grained network policy. Off, an unenforceable policy aborts the session instead of running it unfirewalled.",
    } satisfies SettingSpec<boolean>,
  },
  governance: {
    floorTtlMs: {
      path: "governance.floorTtlMs",
      env: "OE_GOVERNANCE_FLOOR_TTL_MS",
      shipped: 15 * 60_000,
      parseEnv: (raw) => Number(raw) || undefined,
      validate: positiveNumber,
      summary:
        "Memoisation TTL for the room roster and the governance attestation behind the audience floor — the one computation shared by the admin-governance floor, the connector-disclosure floor, the triggered-fire disclosure floor, the approval-card clicker floor and the card-disclosure floor.",
      format: (v) => `${v} ms`,
    } satisfies SettingSpec<number>,
  },
  identity: {
    dmTrustTtlMs: {
      path: "identity.dmTrustTtlMs",
      env: "OE_DM_TRUST_TTL_MS",
      shipped: 5 * 60_000,
      parseEnv: (raw) => Number(raw) || undefined,
      validate: positiveNumber,
      summary:
        "Memo TTL for live trust verification on every surface that performs one — the Slack DM-partner and channel-internal caches, the Teams member/guest lookup and the Linear guest lookup. One knob, because it is one question asked four ways; a miss re-verifies against the platform and every failure still fails closed.",
      format: (v) => `${v} ms`,
    } satisfies SettingSpec<number>,
  },
  memory: {
    dreamCandidateCap: {
      path: "memory.dreamCandidateCap",
      env: "OE_DREAM_MAX_CANDIDATES",
      shipped: 10,
      parseEnv: (raw) => {
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      },
      validate: positiveInt,
      summary: "Per-silo judge budget for the dream/tidy sweep — how many candidate memories one pass may put in front of the judge.",
    } satisfies SettingSpec<number>,
  },
  routines: {
    eventMaxFanout: {
      path: "routines.eventMaxFanout",
      env: "OE_EVENT_MAX_FANOUT",
      shipped: 3,
      parseEnv: wholePositiveIntEnv,
      validate: positiveInt,
      summary:
        "Max routines ONE inbound event may fan out to. Every over-cap match is a genuine drop, so it writes a throttled `routine.skip` audit row (reason `fanout_cap`) rather than silently not firing.",
    } satisfies SettingSpec<number>,
    maxConcurrency: {
      path: "routines.maxConcurrency",
      env: "OE_ROUTINE_MAX_CONCURRENCY",
      shipped: 3,
      parseEnv: wholePositiveIntEnv,
      validate: positiveInt,
      summary:
        "Max routine ROOT sessions started per dispatcher tick. The rest stay claimable and fire on a later tick (their `nextRunAt` is untouched, so they remain due).",
    } satisfies SettingSpec<number>,
    jobMaxFires: {
      path: "routines.jobMaxFires",
      env: "OE_JOB_MAX_FIRES",
      shipped: 200,
      parseEnv: positiveIntEnv,
      validate: positiveInt,
      summary: "Fire cap minted onto a fresh durable-job bound. Plain `cron`/`interval` routines are unbounded by design.",
    } satisfies SettingSpec<number>,
    jobMaxDays: {
      path: "routines.jobMaxDays",
      env: "OE_JOB_MAX_DAYS",
      shipped: 7,
      parseEnv: positiveIntEnv,
      validate: positiveInt,
      summary: "Wall-clock grace minted onto a fresh durable-job bound, in days. Stretched so a slow cadence still gets a fair sample of runs.",
      format: (v) => `${v} d`,
    } satisfies SettingSpec<number>,
  },
  sandbox: {
    stopAfterTurn: {
      path: "sandbox.stopAfterTurn",
      env: "OE_SANDBOX_STOP_AFTER_TURN",
      shipped: true,
      parseEnv: (raw) => raw !== "0",
      summary:
        "Stop the sandbox VM the moment each turn's reply is sent rather than letting it idle out the timeout window. The stop auto-snapshots; the next turn auto-resumes.",
    } satisfies SettingSpec<boolean>,
    extendMaxMinutes: {
      path: "sandbox.extendMaxMinutes",
      env: "OE_SANDBOX_EXTEND_MAX_MIN",
      shipped: 120,
      parseEnv: (raw) => {
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
      },
      validate: positiveInt,
      summary: "Per-call cap on the `extend_workspace_time` tool, in minutes. Plan ceilings still apply.",
      format: (v) => `${v} min`,
    } satisfies SettingSpec<number>,
    timeoutMs: {
      path: "sandbox.timeoutMs",
      env: "OE_SANDBOX_TIMEOUT_MS",
      shipped: 30 * 60 * 1000,
      parseEnv: (raw) => (raw.trim() === "" ? undefined : positiveIntEnv(raw)),
      validate: positiveInt,
      summary:
        "The per-session sandbox window, in ms. With stop-after-turn owning idle cost this is a BACKSTOP fuse — it binds only when the turn-end hook cannot run — and the max continuous work one session may do. **Applied at sandbox CREATE and persisted on the sandbox, so a change only affects NEW conversations.**",
      format: (v) => `${v} ms`,
    } satisfies SettingSpec<number>,
    snapshotExpirationMs: {
      path: "sandbox.snapshotExpirationMs",
      env: "OE_SANDBOX_SNAPSHOT_EXPIRATION_MS",
      shipped: 7 * 24 * 60 * 60 * 1000,
      parseEnv: (raw) => (raw.trim() === "" ? undefined : positiveIntEnv(raw)),
      validate: positiveInt,
      summary:
        "Auto-GC age for a stopped sandbox's snapshot, in ms. Past it a conversation resumes onto a FRESH sandbox: the working tree is lost, the conversation and memory are not (`git push` is the real durability boundary for code). Also applied at CREATE.",
      format: (v) => `${v} ms`,
    } satisfies SettingSpec<number>,
    image: {
      path: "sandbox.image",
      env: "OE_SANDBOX_IMAGE",
      shipped: "",
      parseEnv: (raw) => raw.trim(),
      summary:
        "Off-Vercel `docker()` backend only: the sandbox container image. Empty ⇒ the bare `docker({})` eve otherwise mints. Ignored under `justbash` and on Vercel.",
      format: (v) => (v === "" ? "`` (the backend's own default)" : v),
    } satisfies SettingSpec<string>,
  },
  skills: {
    domainSkillCap: {
      path: "skills.domainSkillCap",
      env: "OE_DOMAIN_SKILL_CAP",
      shipped: 50,
      parseEnv: (raw) => {
        const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
        return Number.isFinite(n) && n > 0 ? n : undefined;
      },
      validate: positiveInt,
      summary:
        "Max runtime-authored domain skills per domain (`create_skill` refuses past this). Per-skill content size is capped separately, in code.",
    } satisfies SettingSpec<number>,
  },
  spend: {
    usageEventsTtlDays: {
      path: "spend.usageEventsTtlDays",
      env: "OE_USAGE_EVENTS_TTL_DAYS",
      shipped: 90,
      parseEnv: positiveNumberEnv,
      validate: positiveNumber,
      summary:
        "Retention window for the per-event `usage_events` table, in days. Pruned opportunistically on write; a documented no-op on Postgres, where the table is append-only.",
      format: (v) => `${v} d`,
    } satisfies SettingSpec<number>,
    sandboxMemoryGiB: {
      path: "spend.sandboxMemoryGiB",
      env: "OE_SANDBOX_MEMORY_GIB",
      shipped: 4,
      parseEnv: positiveNumberEnv,
      validate: positiveNumber,
      summary:
        "The sandbox memory size the $ estimate prices against, in GiB. 4 is Vercel's platform default, confirmed by the same real-billing reconciliation as the rate — change it only if this deploy pins an explicit `memory` on its sandbox backend.",
      format: (v) => `${v} GiB`,
    } satisfies SettingSpec<number>,
    sandboxGiBHourUsd: {
      path: "spend.sandboxGiBHourUsd",
      env: "OE_SANDBOX_GIB_HOUR_USD",
      shipped: 0.0212,
      parseEnv: positiveNumberEnv,
      validate: positiveNumber,
      summary:
        "Vercel Sandbox's 'Provisioned Memory' rate, $/GiB-hr. EVIDENCE-ONLY: this number is here because it was verified twice — the published pricing page AND a real bill that matched it to the cent. A deployment that cannot verify its own rate should report seconds, never a guessed $ figure.",
      format: (v) => `$${v}/GiB-hr`,
    } satisfies SettingSpec<number>,
  },
  stall: {
    repeatThreshold: {
      path: "stall.repeatThreshold",
      env: "OE_STALL_REPEAT_THRESHOLD",
      shipped: 3,
      parseEnv: (raw) => {
        const v = raw.trim().toLowerCase();
        if (v === "") return undefined;
        if (v === "0" || v === "off" || v === "false") return 0;
        const n = Number.parseInt(v, 10);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      },
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
        "Whether the tainted-turn model runs at all. `on` (shipped) marks a turn that ingests untrusted content and lets that marking reach approval disclosure, the four `taint: refuse` sinks, memory provenance and the native-delegation withdrawal. `off` is a deployer's reviewed opt-out: no marks, no gates, no delegation withdrawal — untrusted content is still FENCED, and every session records `taint.mode: off` in the audit trail. **Code-only on purpose: no environment variable can reach `off`.**",
    } satisfies SettingSpec<TaintMode>,
    tierMode: {
      path: "taint.tierMode",
      env: "OE_TAINT_TIERS",
      shipped: "enforced",
      parseEnv: (raw) => {
        const v = raw.trim().toLowerCase();
        if (v === "") return undefined;
        return v === "enforce" || v === "enforced" ? "enforced" : "dryrun";
      },
      summary:
        "Whether the reviewed source-tier table DECIDES a read's untrusted-content marking (`enforced`) or only logs what it would have decided (`dryrun`). Enforcement is relaxation-only.",
    } satisfies SettingSpec<TaintTierMode>,
  },
  tools: {
    maxResultChars: {
      path: "tools.maxResultChars",
      env: "OE_MAX_TOOL_RESULT_CHARS",
      shipped: 120_000,
      parseEnv: (raw) => {
        const n = raw !== "" ? Number.parseInt(raw, 10) : Number.NaN;
        return Number.isFinite(n) && n > 0 ? n : undefined;
      },
      validate: positiveInt,
      summary:
        "Per-tool-result character cap (~30k tokens), applied inside the untrusted-ingestion funnel so one avalanche result cannot blow the context window in a single shot.",
      format: (v) => `${v} chars`,
    } satisfies SettingSpec<number>,
    sourceScopedMount: {
      path: "tools.sourceScopedMount",
      env: "OE_SOURCE_SCOPED_TOOLS",
      shipped: false,
      parseEnv: parseWideBoolean,
      summary:
        "Stage 1 of the uniform mount rule: a per-surface reader (`read_slack_channel`, …) mounts iff its platform is one of the window's SOURCES. Off, the historical arm-on-any-unified-window guard applies and every live window keeps every reader it mounts today.",
    } satisfies SettingSpec<boolean>,
    genericReadVerbs: {
      path: "tools.genericReadVerbs",
      env: "OE_GENERIC_READ_VERBS",
      shipped: false,
      parseEnv: parseWideBoolean,
      summary:
        "Stage 2: the surface-agnostic `read_channel` / `read_thread` pair mounts and the Slack-specific `read_slack_*` readers retire. A model-facing tool-surface change, deliberately armed independently of `tools.sourceScopedMount`.",
    } satisfies SettingSpec<boolean>,
  },
  window: {
    topology: {
      path: "window.topology",
      env: "OE_WINDOW_TOPOLOGY",
      shipped: false,
      parseEnv: (raw) => {
        const v = raw.trim().toLowerCase();
        if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
        if (v === "0" || v === "false" || v === "no" || v === "off") return false;
        return undefined;
      },
      summary:
        "The standing-WINDOW apparatus — the ONE gate governing both the per-channel `solo` window and the cross-surface `unified` window. Off, every domain runs the native per-container path and its `mode` is inert. **Arm deliberately: a window is a wider data blast radius.**",
    } satisfies SettingSpec<boolean>,
    unifiedRedrive: {
      path: "window.unifiedRedrive",
      env: "OE_UNIFIED_REDRIVE",
      shipped: true,
      parseEnv: (raw) => {
        const v = raw.trim().toLowerCase();
        return !(v === "0" || v === "false" || v === "no" || v === "off");
      },
      summary:
        "Auto-redrive a unified turn that ended in terminal prose instead of a `reply`, so the answer is delivered rather than dropped. Off restores the pre-redrive drop-and-lose behaviour exactly.",
    } satisfies SettingSpec<boolean>,
  },
};

export type AgentSettingsOverrides = {
  readonly [G in keyof AgentSettings]?: { readonly [K in keyof AgentSettings[G]]?: AgentSettings[G][K] };
};

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
        problems.push(`${spec.path}: expected ${typeof spec.shipped}, got ${typeof value}`);
        continue;
      }
      const problem = spec.validate?.(value);
      if (problem !== undefined) problems.push(`${spec.path}: ${problem} (got ${JSON.stringify(value)})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `open-everywhere: invalid agent settings (agent/settings.ts) —\n  • ${problems.join("\n  • ")}\n` +
        `See packages/core/agent/settings/settings.ts for the schema.`,
    );
  }
  return Object.freeze(overrides);
}

let registered: AgentSettingsOverrides = {};

export function registerSettings(overrides: AgentSettingsOverrides): void {
  registered = overrides;
}

export function resetSettingsForTest(): void {
  registered = {};
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
  overrides: AgentSettingsOverrides = registered,
): AgentSettings {
  const o = overrides;
  return {
    approvals: {
      judgeMode: resolve(SETTINGS.approvals.judgeMode, o.approvals?.judgeMode, env),
      ttlHours: resolve(SETTINGS.approvals.ttlHours, o.approvals?.ttlHours, env),
      sessionTtlHours: resolve(SETTINGS.approvals.sessionTtlHours, o.approvals?.sessionTtlHours, env),
      checkpointTtlHours: resolve(SETTINGS.approvals.checkpointTtlHours, o.approvals?.checkpointTtlHours, env),
    },
    audit: {
      silences: resolve(SETTINGS.audit.silences, o.audit?.silences, env),
    },
    browser: {
      enabled: resolve(SETTINGS.browser.enabled, o.browser?.enabled, env),
      domains: resolve(SETTINGS.browser.domains, o.browser?.domains, env),
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
    },
    delegation: {
      oneshotAgent: resolve(SETTINGS.delegation.oneshotAgent, o.delegation?.oneshotAgent, env),
      nativeSubagent: resolve(SETTINGS.delegation.nativeSubagent, o.delegation?.nativeSubagent, env),
    },
    models: {
      stack: resolve(SETTINGS.models.stack, o.models?.stack, env),
    discord: {
      autoThread: resolve(SETTINGS.discord.autoThread, o.discord?.autoThread, env),
      statusUx: resolve(SETTINGS.discord.statusUx, o.discord?.statusUx, env),
    },
    egress: {
      enforce: resolve(SETTINGS.egress.enforce, o.egress?.enforce, env),
      allowUnenforced: resolve(SETTINGS.egress.allowUnenforced, o.egress?.allowUnenforced, env),
    },
    governance: {
      floorTtlMs: resolve(SETTINGS.governance.floorTtlMs, o.governance?.floorTtlMs, env),
    },
    identity: {
      dmTrustTtlMs: resolve(SETTINGS.identity.dmTrustTtlMs, o.identity?.dmTrustTtlMs, env),
    },
    memory: {
      dreamCandidateCap: resolve(SETTINGS.memory.dreamCandidateCap, o.memory?.dreamCandidateCap, env),
    },
    routines: {
      eventMaxFanout: resolve(SETTINGS.routines.eventMaxFanout, o.routines?.eventMaxFanout, env),
      maxConcurrency: resolve(SETTINGS.routines.maxConcurrency, o.routines?.maxConcurrency, env),
      jobMaxFires: resolve(SETTINGS.routines.jobMaxFires, o.routines?.jobMaxFires, env),
      jobMaxDays: resolve(SETTINGS.routines.jobMaxDays, o.routines?.jobMaxDays, env),
    },
    sandbox: {
      stopAfterTurn: resolve(SETTINGS.sandbox.stopAfterTurn, o.sandbox?.stopAfterTurn, env),
      extendMaxMinutes: resolve(SETTINGS.sandbox.extendMaxMinutes, o.sandbox?.extendMaxMinutes, env),
      timeoutMs: resolve(SETTINGS.sandbox.timeoutMs, o.sandbox?.timeoutMs, env),
      snapshotExpirationMs: resolve(SETTINGS.sandbox.snapshotExpirationMs, o.sandbox?.snapshotExpirationMs, env),
      image: resolve(SETTINGS.sandbox.image, o.sandbox?.image, env),
    },
    spend: {
      usageEventsTtlDays: resolve(SETTINGS.spend.usageEventsTtlDays, o.spend?.usageEventsTtlDays, env),
      sandboxMemoryGiB: resolve(SETTINGS.spend.sandboxMemoryGiB, o.spend?.sandboxMemoryGiB, env),
      sandboxGiBHourUsd: resolve(SETTINGS.spend.sandboxGiBHourUsd, o.spend?.sandboxGiBHourUsd, env),
    },
    skills: {
      domainSkillCap: resolve(SETTINGS.skills.domainSkillCap, o.skills?.domainSkillCap, env),
    },
    stall: {
      repeatThreshold: resolve(SETTINGS.stall.repeatThreshold, o.stall?.repeatThreshold, env),
    },
    taint: {
      mode: resolve(SETTINGS.taint.mode, o.taint?.mode, env),
      tierMode: resolve(SETTINGS.taint.tierMode, o.taint?.tierMode, env),
    },
    tools: {
      maxResultChars: resolve(SETTINGS.tools.maxResultChars, o.tools?.maxResultChars, env),
      sourceScopedMount: resolve(SETTINGS.tools.sourceScopedMount, o.tools?.sourceScopedMount, env),
      genericReadVerbs: resolve(SETTINGS.tools.genericReadVerbs, o.tools?.genericReadVerbs, env),
    },
    window: {
      topology: resolve(SETTINGS.window.topology, o.window?.topology, env),
      unifiedRedrive: resolve(SETTINGS.window.unifiedRedrive, o.window?.unifiedRedrive, env),
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

export function nativeSubagentAtBuild(overrides: AgentSettingsOverrides): boolean {
  return overrides.delegation?.nativeSubagent ?? SETTINGS.delegation.nativeSubagent.shipped;
}

export function settingEnvNames(): readonly string[] {
  return settingDocs()
    .map((d) => d.env)
    .filter((e): e is string => e !== undefined)
    .sort();
}

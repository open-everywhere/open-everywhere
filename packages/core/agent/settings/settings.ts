export type TaintTierMode = "enforced" | "dryrun";

export type TaintMode = "on" | "off";

export type ApprovalJudgeMode = "off" | "shadow" | "enforce";

export interface AgentSettings {
  readonly approvals: {
    readonly judgeMode: ApprovalJudgeMode;
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
  readonly sandbox: {
    readonly stopAfterTurn: boolean;
    readonly extendMaxMinutes: number;
  };
  readonly skills: {
    readonly domainSkillCap: number;
  };
  readonly taint: {
    readonly mode: TaintMode;
    readonly tierMode: TaintTierMode;
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
  readonly summary: string;
  readonly format?: (value: T) => string;
}

const OFF_SPELLINGS_WIDE = new Set(["", "0", "false", "off", "no"]);

const parseWideBoolean = (raw: string): boolean => !OFF_SPELLINGS_WIDE.has(raw.trim().toLowerCase());

const positiveInt = (value: number): string | undefined =>
  Number.isInteger(value) && value > 0 ? undefined : "must be a positive integer";

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

export function getSettings(env: NodeJS.ProcessEnv = process.env): AgentSettings {
  const o = registered;
  return {
    approvals: {
      judgeMode: resolve(SETTINGS.approvals.judgeMode, o.approvals?.judgeMode, env),
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
    sandbox: {
      stopAfterTurn: resolve(SETTINGS.sandbox.stopAfterTurn, o.sandbox?.stopAfterTurn, env),
      extendMaxMinutes: resolve(SETTINGS.sandbox.extendMaxMinutes, o.sandbox?.extendMaxMinutes, env),
    },
    skills: {
      domainSkillCap: resolve(SETTINGS.skills.domainSkillCap, o.skills?.domainSkillCap, env),
    },
    taint: {
      mode: resolve(SETTINGS.taint.mode, o.taint?.mode, env),
      tierMode: resolve(SETTINGS.taint.tierMode, o.taint?.tierMode, env),
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

export function nativeSubagentAtBuild(overrides: AgentSettingsOverrides): boolean {
  return overrides.delegation?.nativeSubagent ?? SETTINGS.delegation.nativeSubagent.shipped;
}

export function settingEnvNames(): readonly string[] {
  return settingDocs()
    .map((d) => d.env)
    .filter((e): e is string => e !== undefined)
    .sort();
}

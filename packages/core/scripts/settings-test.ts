import assert from "node:assert/strict";
import {
  SETTINGS,
  defineSettings,
  getSettings,
  registerSettings,
  resetSettingsForTest,
  overrideSettingsForTest,
  settingDocs,
} from "../agent/settings/settings.js";
import type { E2eDriverIdentity } from "../agent/testing/driver-allowlist.js";
import { windowTopologyEnabled, WINDOW_TOPOLOGY_ENABLED } from "../agent/access/capabilities.js";
import { oneshotAgentEnabled } from "../agent/access/delegation-flag.js";
import { taintTierMode } from "../agent/access/taint-enforcement.js";
import { approvalJudgeMode } from "../agent/access/approval-judge.js";
import { connectorDmOnlyEnabled } from "../agent/access/connector-scope.js";
import {
  connectorUserPrincipalEnabled,
  connectorOpTieringEnabled,
  connectorLinkSetVaultEnabled,
  directoryLinkSetVaultArmed,
} from "../agent/connections/connector-flags.js";
import { bashTimeoutMs, backgroundGuardEnabled, DEFAULT_BASH_TIMEOUT_MS } from "../agent/stall/bash-hang-guard.js";
import { domainSkillCap, DEFAULT_DOMAIN_SKILL_CAP } from "../agent/skills/domain-skills.js";
import { auditSilencesEnabled } from "../agent/audit/audit.js";
import { maxResultChars, DEFAULT_MAX_RESULT_CHARS } from "../agent/access/result-cap.js";
import { stallThreshold, DEFAULT_STALL_THRESHOLD } from "../agent/stall/guard.js";
import { checkpointTtlHours } from "../agent/approvals/session-checkpoint.js";
import { usageEventsTtlDays } from "../agent/spend/usage-events.js";
import { sandboxMemoryGiB, sandboxGiBHourUsd, estimateSandboxCostUsd } from "../agent/spend/sandbox-pricing.js";
import { jobBoundMaxDays, jobBoundMaxFires, DEFAULT_JOB_MAX_DAYS, DEFAULT_JOB_MAX_FIRES } from "../agent/routines/bound.js";
import { dreamCandidateCap } from "../agent/schedules/tidy.js";
import { DEFAULT_CANDIDATE_CAP } from "../agent/memory/dream/candidates.js";
import { dmTrustTtlMs } from "../agent/identity/trust.js";
import {
  agentCommandName,
  agentDisplayName,
  agentNameTokens,
  configuredAgentName,
  configuredAgentShortName,
  matchesAgentName,
} from "../agent/identity/bot-name.js";
import { nameDropPattern, wakeNameDropTokens } from "../agent/channels/turn-delivery.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const at = (env: NodeJS.ProcessEnv): ReturnType<typeof getSettings> => {
  const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]] as const));
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    return getSettings();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

console.log("1 — precedence is two tiers: the registered override, then the shipped default:");
{
  resetSettingsForTest();
  eq(at({}).window.topology, true, "[1] nothing registered ⇒ the shipped default (window.topology ships ON)");
  eq(at({}).delegation.oneshotAgent, true, "[1] nothing registered ⇒ the shipped default (delegation.oneshotAgent ships ON, OPE-370)");
  eq(at({}).connectors.dmOnly, false, "[1] …connectors.dmOnly ships OFF: a channel reaches a connector exactly when a grant says so (2026-10-10)");
  eq(at({}).connectors.opTiering, true, "[1] …and connectors.opTiering ships ON, so a channel's writes stay behind a card");

  registerSettings(defineSettings({ window: { topology: false }, bash: { timeoutMs: 5_000 } }));
  eq(at({}).window.topology, false, "[1] a REGISTERED override beats the shipped default — disarming by reviewed diff, the only route there is");
  eq(at({}).bash.timeoutMs, 5_000, "[1] a registered numeric override applies");
  eq(at({}).connectors.dmOnly, false, "[1] settings not overridden keep their shipped default");
  resetSettingsForTest();
  eq(at({}).window.topology, true, "[1] resetSettingsForTest() drops back to the shipped defaults");
}

console.log("1b — the test patch merges, and the boot registration replaces:");
{
  resetSettingsForTest();
  registerSettings(defineSettings({ delegation: { oneshotAgent: false } }));
  overrideSettingsForTest({ connectors: { dmOnly: true } });
  eq(at({}).delegation.oneshotAgent, false, "[1b] a patch of ANOTHER group leaves the registered value alone — the whole point of the merge");
  eq(at({}).connectors.dmOnly, true, "[1b] …and the patched key applies");
  overrideSettingsForTest({ connectors: { opTiering: false } });
  eq(at({}).connectors.dmOnly, true, "[1b] a second patch of the SAME group is key-wise, not group-wise");
  eq(at({}).connectors.opTiering, false, "[1b] …and adds its own key");

  registerSettings(defineSettings({ connectors: { dmOnly: true } }));
  eq(at({}).delegation.oneshotAgent, true, "[1b] 🔴 registerSettings REPLACES — the earlier pin is gone, which is why a test must not use it to vary one flag");
  resetSettingsForTest();
}

const DELETED_ENV_MIRRORS: ReadonlyArray<readonly [string, string]> = [
  ["OE_SESSION_INPUT_TOKEN_BUDGET", "20000000"],
  ["OE_COMPACTION_THRESHOLD_PERCENT", "0.7"],
  ["OE_APPROVAL_JUDGE", "enforce"],
  ["OE_APPROVAL_TTL_HOURS", "12"],
  ["OE_PR_SESSION_APPROVAL_TTL_HOURS", "12"],
  ["OE_CHECKPOINT_TTL_HOURS", "12"],
  ["OE_AUDIT_SILENCES", "1"],
  ["OE_AGENT_BROWSER", "1"],
  ["OE_AGENT_BROWSER_DOMAINS", "qa.example.com"],
  ["OE_BASH_TIMEOUT_MS", "90000"],
  ["OE_BASH_BACKGROUND_GUARD", "0"],
  ["OE_CONNECTOR_DM_ONLY", "0"],
  ["OE_CONNECTOR_USER_PRINCIPAL", "1"],
  ["OE_CONNECTOR_LINKSET_VAULT", "1"],
  ["OE_CONNECTOR_OP_TIERING", "1"],
  ["OE_ONESHOT_AGENT", "0"],
  ["OE_NATIVE_SUBAGENT", "0"],
  ["OE_DISCORD_AUTO_THREAD", "false"],
  ["OE_DISCORD_STATUS_UX", "false"],
  ["OE_EGRESS_ENFORCE", "0"],
  ["OE_ALLOW_UNENFORCED_EGRESS", "1"],
  ["OE_GOVERNANCE_FLOOR_TTL_MS", "60000"],
  ["OE_DM_TRUST_TTL_MS", "1000"],
  ["OE_DREAM_MAX_CANDIDATES", "25"],
  ["OE_EVENT_MAX_FANOUT", "7"],
  ["OE_ROUTINE_MAX_CONCURRENCY", "7"],
  ["OE_JOB_MAX_FIRES", "12"],
  ["OE_JOB_MAX_DAYS", "12"],
  ["OE_SUPERVISOR_ROTATE_QUIET_GAP_HOURS", "6"],
  ["OE_SUPERVISOR_ROTATE_EXPIRY_DAYS", "30"],
  ["OE_SUPERVISOR_ROTATE_TOKEN_BUDGET", "1000000"],
  ["OE_SUPERVISOR_ROTATE_TURN_BUDGET", "120"],
  ["OE_SANDBOX_STOP_AFTER_TURN", "0"],
  ["OE_SANDBOX_EXTEND_MAX_MIN", "45"],
  ["OE_SANDBOX_TIMEOUT_MS", "60000"],
  ["OE_SANDBOX_SNAPSHOT_EXPIRATION_MS", "60000"],
  ["OE_SANDBOX_IMAGE", "node:24-alpine"],
  ["OE_DOMAIN_SKILL_CAP", "12"],
  ["OE_USAGE_EVENTS_TTL_DAYS", "12"],
  ["OE_SANDBOX_MEMORY_GIB", "8"],
  ["OE_SANDBOX_GIB_HOUR_USD", "0.05"],
  ["OE_STALL_REPEAT_THRESHOLD", "5"],
  ["OE_TAINT_TIERS", "dryrun"],
  ["OE_MAX_TOOL_RESULT_CHARS", "5000"],
  ["OE_SOURCE_SCOPED_TOOLS", "1"],
  ["OE_GENERIC_READ_VERBS", "1"],
  ["OE_WINDOW_TOPOLOGY", "1"],
  ["OE_UNIFIED_REDRIVE", "0"],
  ["OE_MODEL_STACK", "chinese-open"],
];

console.log("2 — every deleted env mirror is inert, individually and all at once:");
{
  resetSettingsForTest();
  eq(DELETED_ENV_MIRRORS.length, 49, "[2] the historical set is all FORTY-NINE mirrors (OPE-2411 deleted the last, OE_MODEL_STACK)");

  const shipped = at({});
  const all: NodeJS.ProcessEnv = {};
  for (const [name, raw] of DELETED_ENV_MIRRORS) {
    all[name] = raw;
    eq(at({ [name]: raw }), shipped, `[2] ${name}=${JSON.stringify(raw)} moves NOTHING — the mirror is deleted, not merely undocumented`);
  }
  eq(at(all), shipped, "[2] 🔴 …and all forty-nine set AT ONCE are still byte-identical to an empty environment");

  registerSettings(
    defineSettings({
      window: { topology: false },
      taint: { tierMode: "dryrun" },
      connectors: { dmOnly: true },
      rotation: { turnBudget: 90 },
    }),
  );
  const configured = at({});
  eq(at(all), configured, "[2] 🔴 …and they do not beat a REGISTERED value either — the committed file is the authority, which is the whole ticket");
  eq(configured.window.topology, false, "[2] (the registered posture really is the non-default one, so the assertion above has teeth)");
  eq(configured.rotation.turnBudget, 90, "[2] …including a rotation clock, the group OPE-409 unblocked");
  resetSettingsForTest();
}

const RETIRED_BY_OPE_2411: ReadonlyArray<readonly [string, string]> = [
  ["OE_MODEL_STACK", "chinese-open"],
  ["OE_PRIMARY_MODEL", "acme/primary"],
  ["OE_FORCE_MODEL", "acme/forced"],
  ["OE_ADMIN_GITHUB", "1"],
  ["OE_ADMIN_ROLE_RULES", '[{"roles":["admin"],"email":"a@b.c"}]'],
  ["OE_ALLOW_MULTI_TENANT_PRINCIPALS", "1"],
  ["OE_TEAMS_SERVICE_HOSTS", "smba.infra.gcc.teams.microsoft.com"],
  ["OE_TIDY_ORGS", "acme,globex"],
  ["OE_DIRECTORY_AUTOCONFIRM", "attested"],
  ["OE_DIRECTORY_GROUP_ALLOWLIST", "Payments"],
  ["OE_DIRECTORY_OKTA_APPS", "slack:0oa1"],
  ["OE_AWS_ENABLED", "1"],
  ["OE_AWS_SSO_SCOPES", "openid extra"],
  ["OE_MEMORY_SYNC_TIMING", "1"],
  ["OE_SANDBOX_BACKEND", "justbash"],
  ["OE_PLATFORM", "vercel"],
  ["OE_ALLOW_EPHEMERAL_MEMORY", "1"],
  ["OE_ALLOW_EPHEMERAL_OPERATIONAL", "1"],
  ["OE_TRUST", "internal"],
];
console.log("3 — no env seam survives, and no variable OPE-2411 retired moves a setting:");
{
  resetSettingsForTest();
  const shipped = at({});
  eq(shipped.models.stack, "american-closed", "[3] models.stack: the shipped alias");
  eq(at({ OE_MODEL_STACK: "chinese-open" }).models.stack, "american-closed", "[3] 🔴 OE_MODEL_STACK selects NOTHING any more — the stack changes by a commit");
  eq(at(Object.fromEntries(RETIRED_BY_OPE_2411)), shipped, "[3] 🔴 every variable OPE-2411 retired, set at once, is byte-identical to an empty environment");

  registerSettings(defineSettings({ models: { stack: "registered-alias", primary: "acme/p", force: "acme/f" } }));
  eq(at({ OE_MODEL_STACK: "chinese-open" }).models.stack, "registered-alias", "[3] a registered stack applies, and no variable outvotes it");
  eq(at({ OE_PRIMARY_MODEL: "x/y", OE_FORCE_MODEL: "x/z" }).models, { stack: "registered-alias", primary: "acme/p", force: "acme/f", dataPolicy: {} }, "[3] …and the two model pins are registered rows too (the data policy keeps its shipped empty value)");
  resetSettingsForTest();
}

console.log("4 — every read re-resolves (registration order and the test seam both depend on it):");
{
  resetSettingsForTest();
  const seq: unknown[] = [];
  seq.push(at({}).taint.tierMode);
  registerSettings(defineSettings({ taint: { tierMode: "dryrun" } }));
  seq.push(at({}).taint.tierMode);
  registerSettings(defineSettings({ taint: { tierMode: "enforced" } }));
  seq.push(at({}).taint.tierMode);
  resetSettingsForTest();
  seq.push(at({}).taint.tierMode);
  eq(seq, ["enforced", "dryrun", "enforced", "enforced"], "[4] four reads in one process track registration — no module-level cache");

  registerSettings(defineSettings({ window: { topology: true } }));
  ok(windowTopologyEnabled(), "[4] the public resolver sees a mid-process registration too");
  registerSettings(defineSettings({ window: { topology: false } }));
  ok(!windowTopologyEnabled(), "[4] …and back again");
  resetSettingsForTest();
}

console.log("5 — a bad override fails the boot, not a turn:");
{
  const refuses = (fn: () => unknown, needle: string, label: string): void => {
    let message = "";
    try {
      fn();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    ok(message.includes(needle), `${label} (got: ${message.slice(0, 120) || "NO THROW"})`);
  };
  refuses(() => defineSettings({ windows: { topology: true } } as never), "unknown settings group", "[5] a typo'd GROUP is refused by name");
  refuses(() => defineSettings({ window: { topolgy: true } } as never), "unknown setting", "[5] a typo'd KEY is refused by name");
  refuses(() => defineSettings({ window: { unifiedRedrive: false } } as never), "unknown setting", "[5] 🔴 OPE-1145 — `window.unifiedRedrive` is DELETED: a deployment that still registers the old off switch FAILS the boot, rather than booting with an ignored key and an operator who believes the correction is off");
  refuses(() => defineSettings({ bash: { timeoutMs: "600000" } } as never), "expected number", "[5] a wrong-typed value is refused");
  refuses(() => defineSettings({ skills: { domainSkillCap: 0 } }), "positive integer", "[5] an out-of-range value is refused by its validator");
  refuses(() => defineSettings({ sandbox: { extendMaxMinutes: -1 } }), "positive integer", "[5] …in both numeric settings");
  refuses(() => defineSettings({ agent: { compactionThresholdPercent: 1 } }), "strictly between 0 and 1", "[5] a compaction threshold of 1 is refused — a fraction of the window, not a percentage");
  refuses(() => defineSettings({ models: { stack: "  " } }), "non-empty stack alias", "[5] a blank stack alias is refused");

  refuses(() => defineSettings({ taint: { tierMode: "Enforced" } } as never), 'must be "enforced" or "dryrun"', "[5] 🔴 a mis-cased taint tier mode is refused rather than silently resolving");
  refuses(() => defineSettings({ approvals: { judgeMode: "ENFORCE" } } as never), 'must be "off", "shadow" or "enforce"', "[5] 🔴 …and a mis-cased judge mode likewise — the old parser answered `off` here, which was fail-safe but silent");
  refuses(() => defineSettings({ taint: { mode: "disabled" } } as never), 'must be "on" or "off"', "[5] …and taint.mode keeps the validator it has always had");

  eq(
    defineSettings({ connectors: { userPrincipal: true } }).connectors?.userPrincipal,
    true,
    "[5] 🔴 userPrincipal declared ALONE is accepted — opTiering ships ON (2026-10-10), so the resolved posture holes nothing",
  );
  refuses(
    () => defineSettings({ connectors: { userPrincipal: true, opTiering: false } }),
    "while connectors.opTiering is off",
    "[5] …and declaring opTiering FALSE beside it is refused the same way — an explicit off is still off",
  );
  eq(
    defineSettings({ connectors: { userPrincipal: true, opTiering: true } }).connectors?.userPrincipal,
    true,
    "[5] 🔴 BOTH ARMED is accepted, so the rule must not refuse an explicit tiering declaration either",
  );
  eq(defineSettings({ connectors: { opTiering: true } }).connectors?.opTiering, true, "[5] …opTiering alone is accepted: tiering without the per-user path holes nothing");
  eq(defineSettings({ connectors: { userPrincipal: false } }).connectors?.userPrincipal, false, "[5] …and userPrincipal explicitly OFF is accepted whatever opTiering says");
  refuses(
    () => defineSettings({ connectors: { opTiering: false } }),
    "while connectors.opTiering is off",
    "[5] 🔴 opTiering FALSE alone is refused — userPrincipal ships ON (OPE-2414), so the resolved posture is the hole",
  );
  eq(
    defineSettings({ connectors: { opTiering: false, userPrincipal: false } }).connectors?.opTiering,
    false,
    "[5] …and the opt-out pair (opTiering AND userPrincipal off) is accepted",
  );

  ok(
    defineSettings({ bash: { timeoutMs: 0 } }).bash?.timeoutMs === 0,
    "[5] bash.timeoutMs accepts 0 — that is the documented 'disable the timeout' value, not an out-of-range one",
  );
  ok(defineSettings({ stall: { repeatThreshold: 0 } }).stall?.repeatThreshold === 0, "[5] …and stall.repeatThreshold accepts 0 for the same reason");
  ok(defineSettings({ rotation: { expiryDays: 0 } }).rotation?.expiryDays === 0, "[5] …and rotation.expiryDays, where 0 DISABLES the trigger rather than being out of range");
  ok(defineSettings({ rotation: { expiryDays: -1 } }).rotation?.expiryDays === -1, "[5] …negatives too, same meaning");
  eq(defineSettings({}), {}, "[5] an EMPTY override object is valid — 'this deployment holds no opinion beyond the shipped ones'");

  eq(
    defineSettings({ soak: { captureSurfacePrefix: ["slack/T1/", "notion/ws1/"] } }).soak?.captureSurfacePrefix,
    ["slack/T1/", "notion/ws1/"],
    "[5] 🔴 a prefix LIST is accepted — the validator overrides the typeof gate on a union-typed spec",
  );
  refuses(
    () => defineSettings({ soak: { captureSurfacePrefix: 7 } } as never),
    "expected string",
    "[5] …a value on NEITHER arm of the union is still refused",
  );
  refuses(
    () => defineSettings({ soak: { captureSurfacePrefix: ["slack/T1/", 7] } } as never),
    "must be a string or an array of strings",
    "[5] …and a mixed-type array is refused with the validator's GRAMMAR — a list is a supported spelling, so the bad ELEMENT is the mistake to report",
  );

  ok(defineSettings({ rotation: { turnBudget: 90 } }).rotation?.turnBudget === 90, "[5] 🔴 a rotation override is ACCEPTED (OPE-409 removed the by-name refusal)");
  refuses(() => defineSettings({ rotation: { turnBudget: 0 } }), "positive number", "[5] …and is validated like any other row, not waved through");
  {
    resetSettingsForTest();
    registerSettings(defineSettings({ rotation: { turnBudget: 90, quietGapHours: 6 } }));
    eq(at({}).rotation.turnBudget, 90, "[5] 🔴 …and it REACHES getSettings — the load-order defect OPE-409 closed");
    eq(at({}).rotation.quietGapHours, 6, "[5] …for every row in the group");
    resetSettingsForTest();
  }
  eq(at({}).rotation.turnBudget, 60, "[5] the shipped turn backstop is 60 — DERIVED from the ~85-turn workflow event wall, not nudged (see the spec's summary before changing it)");
  eq(at({}).rotation.quietGapHours, 12, "[5] the shipped idleness trigger is 12 h — a standing seat holds for a working day (OPE-1694 folded the deployment override in)");
  ok(
    settingDocs().filter((d) => d.path.startsWith("rotation.")).length === 7,
    "[5] all seven rotation rows reach the generated operator table (OPE-794 added contextSizeTokens + tailTokenCap, OPE-2431 dmSummaryTokenCap)",
  );
}

console.log("6 — the public resolvers are schema-backed, with their names and shapes intact:");
{
  resetSettingsForTest();
  eq(WINDOW_TOPOLOGY_ENABLED, SETTINGS.window.topology.shipped, "[6] WINDOW_TOPOLOGY_ENABLED IS the schema's shipped default — one source, not two that can drift");
  eq(WINDOW_TOPOLOGY_ENABLED, true, "[6] …and it is TRUE: standing seats ship on");
  eq(DEFAULT_BASH_TIMEOUT_MS, 600_000, "[6] DEFAULT_BASH_TIMEOUT_MS still exports 600s from the schema");
  eq(DEFAULT_DOMAIN_SKILL_CAP, 50, "[6] DEFAULT_DOMAIN_SKILL_CAP still exports 50 from the schema");
  eq(DEFAULT_MAX_RESULT_CHARS, SETTINGS.tools.maxResultChars.shipped, "[6] DEFAULT_MAX_RESULT_CHARS IS the schema's shipped cap — one source");
  eq(DEFAULT_STALL_THRESHOLD, SETTINGS.stall.repeatThreshold.shipped, "[6] DEFAULT_STALL_THRESHOLD IS the schema's shipped threshold — one source");
  eq(DEFAULT_JOB_MAX_DAYS, SETTINGS.routines.jobMaxDays.shipped, "[6] DEFAULT_JOB_MAX_DAYS IS the schema's shipped grace — one source");
  eq(DEFAULT_JOB_MAX_FIRES, SETTINGS.routines.jobMaxFires.shipped, "[6] DEFAULT_JOB_MAX_FIRES IS the schema's shipped cap — one source");
  eq(DEFAULT_CANDIDATE_CAP, SETTINGS.memory.dreamCandidateCap.shipped, "[6] DEFAULT_CANDIDATE_CAP IS the schema's shipped cap — one source");
  eq(DEFAULT_JOB_MAX_FIRES, 200, "[6] …and the derived 200 (>168 hourly fires in the default week) is unchanged");

  ok(windowTopologyEnabled(), "[6] windowTopologyEnabled() ⇒ shipped ON");
  ok(oneshotAgentEnabled(), "[6] oneshotAgentEnabled() ⇒ shipped ON");
  eq(taintTierMode(), "enforced", "[6] taintTierMode() ⇒ shipped enforced");
  eq(approvalJudgeMode(), "enforce", "[6] approvalJudgeMode() ⇒ shipped enforce (OPE-2366)");
  ok(!connectorDmOnlyEnabled(), "[6] connectorDmOnlyEnabled() ⇒ shipped OFF (the wall is down)");
  ok(connectorUserPrincipalEnabled(), "[6] 🔴 connectorUserPrincipalEnabled() ⇒ shipped ON (OPE-2414): in a DM a person signs in as themselves");
  ok(connectorOpTieringEnabled(), "[6] connectorOpTieringEnabled() ⇒ shipped ON");
  ok(connectorLinkSetVaultEnabled(), "[6] 🔴 connectorLinkSetVaultEnabled() ⇒ shipped ON (OPE-2414): one consent covers a person's linked accounts");
  ok(directoryLinkSetVaultArmed(), "[6] directoryLinkSetVaultArmed() ⇒ shipped ON, so directory auto-confirm is suppressed for every link-set");
  eq(bashTimeoutMs(), 600_000, "[6] bashTimeoutMs() ⇒ shipped 600s");
  ok(backgroundGuardEnabled(), "[6] backgroundGuardEnabled() ⇒ shipped ON");
  eq(domainSkillCap(), 50, "[6] domainSkillCap() ⇒ shipped 50");
  ok(!auditSilencesEnabled(), "[6] auditSilencesEnabled() ⇒ OFF — no setting reaches the silence-audit switch");
  eq(maxResultChars(), 120_000, "[6] maxResultChars() ⇒ shipped 120k");
  eq(stallThreshold(), 3, "[6] stallThreshold() ⇒ shipped 3");
  eq(checkpointTtlHours(), 24, "[6] checkpointTtlHours() ⇒ shipped 24h");
  eq(usageEventsTtlDays(), 90, "[6] usageEventsTtlDays() ⇒ shipped 90d");
  eq(sandboxMemoryGiB(), 4, "[6] sandboxMemoryGiB() ⇒ shipped 4 GiB");
  eq(sandboxGiBHourUsd(), 0.0212, "[6] sandboxGiBHourUsd() ⇒ the twice-verified shipped rate");
  eq(estimateSandboxCostUsd(3600), 4 * 0.0212, "[6] estimateSandboxCostUsd still composes the two through the schema");
  eq(jobBoundMaxDays(), 7, "[6] jobBoundMaxDays() ⇒ shipped 7d");
  eq(jobBoundMaxFires(), 200, "[6] jobBoundMaxFires() ⇒ shipped 200");
  eq(dreamCandidateCap(), 10, "[6] dreamCandidateCap() ⇒ shipped 10");
  eq(dmTrustTtlMs(), 300_000, "[6] dmTrustTtlMs() ⇒ shipped 5 min — the ONE resolver the surface trust caches share");

  registerSettings(
    defineSettings({
      window: { topology: false },
      delegation: { oneshotAgent: false },
      taint: { tierMode: "dryrun" },
      approvals: { judgeMode: "shadow" },
      connectors: { dmOnly: true, userPrincipal: false, opTiering: false, linkSetVault: false },
      bash: { timeoutMs: 1_000, backgroundGuard: false },
      skills: { domainSkillCap: 7 },
    }),
  );
  ok(!windowTopologyEnabled(), "[6] …windowTopologyEnabled() follows a registered override");
  ok(!oneshotAgentEnabled(), "[6] …oneshotAgentEnabled()");
  eq(taintTierMode(), "dryrun", "[6] …taintTierMode()");
  eq(approvalJudgeMode(), "shadow", "[6] …approvalJudgeMode()");
  ok(connectorDmOnlyEnabled(), "[6] …connectorDmOnlyEnabled()");
  ok(!connectorUserPrincipalEnabled(), "[6] …connectorUserPrincipalEnabled() (declared off: the cross-key rule refuses it on with opTiering off)");
  ok(!connectorOpTieringEnabled(), "[6] …connectorOpTieringEnabled()");
  ok(!directoryLinkSetVaultArmed(), "[6] …directoryLinkSetVaultArmed() (declared off: the opt-out)");
  eq(bashTimeoutMs(), 1_000, "[6] …bashTimeoutMs()");
  ok(!backgroundGuardEnabled(), "[6] …backgroundGuardEnabled()");
  eq(domainSkillCap(), 7, "[6] …domainSkillCap()");
  assert.throws(() => defineSettings({ audit: { silences: true } } as never), /unknown settings group "audit"/, "[6] defineSettings refuses the deleted `audit` group (OPE-2410)");
  registerSettings(defineSettings({ connectors: { userPrincipal: true } }));
  ok(connectorUserPrincipalEnabled(), "[6] …connectorUserPrincipalEnabled() follows its own registered override");
  resetSettingsForTest();
}

console.log("7 — every setting reaches the generated operator table:");
{
  const docs = settingDocs();
  const groups = Object.values(SETTINGS as unknown as Record<string, Record<string, unknown>>);
  const declared = groups.reduce((sum, g) => sum + Object.keys(g).length, 0);
  eq(docs.length, declared, "[7] settingDocs() emits EVERY declared setting — a knob that never reaches the doc is an undocumented knob");
  ok(
    docs.every((d) => d.summary.length > 20 && d.path.includes(".")),
    "[7] every row carries a dotted path and a real sentence (the generated table is what an operator reads)",
  );
  eq(
    [...docs].map((d) => d.path).sort(),
    docs.map((d) => d.path),
    "[7] rows are emitted sorted — a deterministic generator, so a re-run rewrites byte-identical output",
  );
  eq(docs.filter((d) => "env" in d).length, 0, "[7] 🔴 NO row renders an ops override — every row is code-only (OPE-2411)");
}

console.log("7b — every declared setting is resolvable, not only documentable:");
{
  resetSettingsForTest();
  const declared = SETTINGS as unknown as Record<string, Record<string, { path?: unknown; shipped?: unknown }>>;
  const resolved = at({}) as unknown as Record<string, Record<string, unknown>>;
  let checked = 0;
  for (const [group, specs] of Object.entries(declared)) {
    ok(Object.prototype.hasOwnProperty.call(resolved, group), `[7b] getSettings() resolves the group "${group}"`);
    const resolvedGroup = resolved[group] ?? {};
    for (const [key, spec] of Object.entries(specs)) {
      if (typeof spec !== "object" || spec === null || typeof spec.path !== "string") continue;
      checked++;
      ok(Object.prototype.hasOwnProperty.call(resolvedGroup, key), `[7b] 🔴 getSettings() resolves ${group}.${key} — declared in SETTINGS and missing from the resolver is an unreadable knob`);
      eq(resolvedGroup[key], spec.shipped, `[7b] …and with nothing registered it answers the spec's own shipped default (${group}.${key})`);
    }
    for (const key of Object.keys(resolvedGroup)) {
      ok(Object.prototype.hasOwnProperty.call(specs, key), `[7b] every resolved key has a spec (${group}.${key} is resolved but undeclared)`);
    }
  }
  eq(checked, settingDocs().length, "[7b] the two totality arms walked the same set — a spec count that disagrees with the doc count means one arm skipped a nesting level");
}

console.log("8 — no setting has an env path at all:");
{
  let withEnvField = 0;
  for (const [group, specs] of Object.entries(SETTINGS as unknown as Record<string, Record<string, Record<string, unknown>>>)) {
    for (const [key, spec] of Object.entries(specs)) {
      ok(!("env" in spec) && !("parseEnv" in spec), `[8] ${group}.${key}: no \`env\` field and no \`parseEnv\``);
      if ("env" in spec) withEnvField++;
    }
  }
  eq(withEnvField, 0, "[8] 🔴 ZERO specs declare an env path since OPE-2411. A new one is a ticket against the rule, not a tidy-up");

  resetSettingsForTest();
  eq(at({}).taint.mode, "on", "[8] taint.mode: the shipped default is ON");
  eq(at({ OE_TAINT_MODE: "off", OE_TAINT_TIERS: "off" }).taint.mode, "on", "[8] 🔴 no environment reaches `off` — there is no parser for a value to be read by");
  registerSettings(defineSettings({ taint: { mode: "off" } }));
  eq(at({}).taint.mode, "off", "[8] …a REGISTERED override does, which is the reviewed-diff route and the only one");
  eq(at({ OE_TAINT_MODE: "on" }).taint.mode, "off", "[8] …and no environment pulls it back either");
  resetSettingsForTest();
}

console.log("\n9 — identity.name (OPE-569): the canonical agent name:");
{
  const savedFull = process.env.OE_AGENT_NAME;
  const savedShort = process.env.OE_AGENT_SHORT_NAME;
  process.env.OE_AGENT_NAME = "Env Leftover";
  process.env.OE_AGENT_SHORT_NAME = "envy";

  resetSettingsForTest();
  eq(at({}).identity.name, "", "[9] the shipped default is UNSET — a self-hoster gets today's behaviour and no invented brand");
  eq(at({}).identity.shortName, "", "[9] the short name ships UNSET too");
  eq(at({}).identity.commandName, "oe", "[9] the command name ships as `oe`, so an unconfigured deployment keeps `/oe`");
  eq(configuredAgentName(), undefined, "[9] configuredAgentName() reads unset as undefined, so callers have one answer to test");

  eq(agentNameTokens(), ["open everywhere", "oe"], "[9] unset ⇒ the name-drop token set is the brand + short name, and the retired env vars add nothing");
  eq(agentDisplayName(), "Open Everywhere", "[9] unset ⇒ the display name is the brand default");
  eq(agentCommandName(), "oe", "[9] unset ⇒ the command name is `oe`");

  registerSettings(defineSettings({ identity: { name: "  Aria  " } }));
  eq(configuredAgentName(), "Aria", "[9] a configured name is trimmed");
  eq(agentDisplayName(), "Aria", "[9] …and it is the display name every install artifact and string reads");
  eq(agentNameTokens(), ["Aria"], "[9] 🔴 the configured name REPLACES the brand tokens — it does not join them");
  ok(matchesAgentName("hey Aria, can you look at this?"), "[9] …so the agent answers to the name it introduces itself by");
  ok(!matchesAgentName("open everywhere: ping"), "[9] 🔴 …and NOT to the brand phrase once a name is configured");
  ok(!matchesAgentName("oe link ABC123"), "[9] 🔴 …nor to the brand short token `oe`");
  ok(!matchesAgentName("the arias sang"), "[9] NEGATIVE: still word-boundary matched — a name inside a longer word does not fire");

  registerSettings(defineSettings({ identity: { name: "Aria", shortName: "ari" } }));
  eq(configuredAgentShortName(), "ari", "[9] the configured short name reads back");
  eq(agentNameTokens(), ["Aria", "ari"], "[9] the short name joins the configured name — and only those two");
  ok(matchesAgentName("ari, can you look?"), "[9] …so the short name wakes the agent");

  registerSettings(defineSettings({ identity: { shortName: "ari" } }));
  eq(agentNameTokens(), ["ari"], "[9] 🔴 a short name ALONE is a configured name too — the brand tokens stop matching");

  registerSettings(defineSettings({ identity: { commandName: "aria" } }));
  eq(agentCommandName(), "aria", "[9] the command name reads from `identity.commandName`");

  registerSettings(defineSettings({ identity: { name: "Aria" } }));
  ok(nameDropPattern("Test Slack Bot").test("did Test Slack Bot see this?"), "[9] the per-surface name-drop matcher still matches the live display name with a canonical name configured");

  eq(agentNameTokens("Notionaut"), ["Notionaut", "Aria"], "[9] a platform-RESOLVED integration name still leads the set, beside the configured name");

  resetSettingsForTest();
  eq(agentNameTokens(), ["open everywhere", "oe"], "[9] …and clearing the override restores today's set exactly");

  if (savedFull === undefined) delete process.env.OE_AGENT_NAME;
  else process.env.OE_AGENT_NAME = savedFull;
  if (savedShort === undefined) delete process.env.OE_AGENT_SHORT_NAME;
  else process.env.OE_AGENT_SHORT_NAME = savedShort;
}

{
  const refusesName = (value: string, needle: string, label: string): void => {
    let message = "";
    try {
      defineSettings({ identity: { name: value } });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    ok(message.includes(needle), `${label} (got: ${message.slice(0, 120) || "NO THROW"})`);
  };
  refusesName("Ari\na", "line break", "[9/5] a name with a line break is refused — one prompt line, one matcher token");
  refusesName("x".repeat(65), "at most 64", "[9/5] a pasted paragraph is refused rather than becoming the agent's name");
  eq(defineSettings({ identity: { name: "x".repeat(64) } }).identity?.name?.length, 64, "[9/5] …and the boundary value itself is accepted");

  const refuses = (overrides: Parameters<typeof defineSettings>[0], needle: string, label: string): void => {
    let message = "";
    try {
      defineSettings(overrides);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    ok(message.includes(needle), `${label} (got: ${message.slice(0, 120) || "NO THROW"})`);
  };
  refuses({ identity: { shortName: "a" } }, "at least 2 characters", "[9/5] a one-character short name is refused — the matcher would drop it silently");
  refuses({ identity: { shortName: "x".repeat(33) } }, "at most 32", "[9/5] an over-long short name is refused");
  eq(defineSettings({ identity: { shortName: "ari" } }).identity?.shortName, "ari", "[9/5] …and a real short name is accepted");
  refuses({ identity: { commandName: "/aria" } }, "no slash", "[9/5] a command name WITH its slash is refused — the slash is the vendor's, not the name's");
  refuses({ identity: { commandName: "Aria" } }, "lowercase", "[9/5] an upper-case command name is refused — Slack and Discord both require lowercase");
  refuses({ identity: { commandName: "my agent" } }, "lowercase", "[9/5] a command name with a space is refused");
  refuses({ identity: { commandName: "x".repeat(32) } }, "1-31", "[9/5] a command name past Slack's 32-with-slash limit is refused");
  eq(defineSettings({ identity: { commandName: "aria-ops" } }).identity?.commandName, "aria-ops", "[9/5] …and a valid command name is accepted");
}

console.log("\n10 — wake.nameDrop.include / wake.nameDrop.exclude (OPE-571):");
{
  resetSettingsForTest();
  eq(at({}).wake.nameDropInclude, [], "[10] the shipped default for include is empty");
  eq(at({}).wake.nameDropExclude, [], "[10] the shipped default for exclude is empty");

  eq(
    wakeNameDropTokens("Test Slack Bot"),
    ["Test Slack Bot"],
    "[10] unset settings + no identity.name ⇒ the wake token set is byte-identical to the pre-OPE-571 single-name trigger",
  );
  eq(wakeNameDropTokens(undefined), [], "[10] …and an unresolved display name still yields no tokens at all");

  registerSettings(defineSettings({ identity: { name: "Aria" } }));
  eq(
    wakeNameDropTokens("Test Slack Bot"),
    ["Test Slack Bot", "Aria"],
    "[10] identity.name JOINS the wake token set alongside the live display name",
  );
  ok(nameDropPattern("Aria").test("hey Aria, can you look at this?"), "[10] …so the identity.name token itself fires the per-surface matcher");
  resetSettingsForTest();

  registerSettings(defineSettings({ wake: { nameDropInclude: ["ProjectBot"] } }));
  eq(
    wakeNameDropTokens("Test Slack Bot"),
    ["Test Slack Bot", "ProjectBot"],
    "[10] wake.nameDrop.include ADDS a token to the base set",
  );
  resetSettingsForTest();

  registerSettings(defineSettings({ wake: { nameDropExclude: ["Test Slack Bot"] } }));
  eq(
    wakeNameDropTokens("Test Slack Bot"),
    [],
    "[10] 🔴 wake.nameDrop.exclude removes even the AUTOMATIC base (the live display name) — the operator's narrowing has the last word",
  );
  resetSettingsForTest();

  registerSettings(
    defineSettings({
      identity: { name: "Aria" },
      wake: { nameDropInclude: ["Codename Falcon", "aria"], nameDropExclude: ["ARIA", "test slack bot"] },
    }),
  );
  eq(
    wakeNameDropTokens("Test Slack Bot"),
    ["Codename Falcon"],
    "[10] 🔴 exclude wins over include AND over the automatic base (display name + identity.name), case-insensitively — only the un-excluded include token survives",
  );
  resetSettingsForTest();

  registerSettings(defineSettings({ identity: { name: "Test Slack Bot" } }));
  eq(
    wakeNameDropTokens("Test Slack Bot"),
    ["Test Slack Bot"],
    "[10] NEGATIVE: identity.name equal to the live display name does not duplicate the token",
  );
  resetSettingsForTest();
}

console.log("\n11 — wake.e2eDrivers (OPE-1023, OPE-1739, OPE-1754):");
{
  resetSettingsForTest();
  eq(at({}).wake.e2eDrivers, [], "[11] 🔴 the shipped value is EMPTY — an unconfigured deployment admits NO bot author at any seat door, which is the pre-OPE-1023 behaviour exactly");

  registerSettings(defineSettings({ wake: { e2eDrivers: [{ surface: "slack", principal: "T0123ABCD:B0456EFGH" }] } }));
  eq(at({}).wake.e2eDrivers, [{ surface: "slack", principal: "T0123ABCD:B0456EFGH" }], "[11] a well-formed Slack entry resolves through unchanged");
  resetSettingsForTest();

  registerSettings(
    defineSettings({
      wake: {
        e2eDrivers: [
          { surface: "slack", principal: "T0123ABCD:B0456EFGH" },
          { surface: "slack", principal: "T0123ABCD:B0999ZZZZ" },
          { surface: "discord", principal: "123456789012345678" },
          { surface: "notion", principal: "00000000-0000-0000-0000-000000000007" },
        ],
      },
    }),
  );
  eq(
    at({}).wake.e2eDrivers.length,
    4,
    "[11] 🔴 ONE declaration carries every surface at once — two Slack accounts (the live-run gap was a second driver the one-pair lever could not name), a Discord bot and a Notion integration",
  );
  eq(
    at({}).wake.e2eDrivers.filter((d) => d.surface === "slack").map((d) => d.principal),
    ["T0123ABCD:B0456EFGH", "T0123ABCD:B0999ZZZZ"],
    "[11] …and the entries stay partitioned by surface, so a Discord id can never be matched at the Slack door",
  );
  resetSettingsForTest();

  registerSettings(defineSettings({ wake: { e2eDrivers: [] } }));
  eq(at({}).wake.e2eDrivers, [], "[11] an EMPTY LIST loads and stays empty — the spelling of 'admit nobody'");
  resetSettingsForTest();

  const refusalFor = (value: unknown): string => {
    try {
      defineSettings({ wake: { e2eDrivers: value as readonly E2eDriverIdentity[] } });
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const refusesEntry = (value: unknown, label: string): void => {
    const message = refusalFor(value);
    ok(
      message.includes("wake.e2eDrivers") && message.includes("{ surface, principal }"),
      `${label} (got: ${message.slice(0, 200) || "NO THROW"})`,
    );
  };
  const refusesSlackPair = (value: unknown, label: string): void => {
    const message = refusalFor(value);
    ok(
      message.includes("wake.e2eDrivers") && message.includes("teamId:botId"),
      `${label} (got: ${message.slice(0, 200) || "NO THROW"})`,
    );
  };

  {
    const message = refusalFor("T0123ABCD:B0456EFGH");
    ok(
      message.includes("wake.e2eDrivers") && message.includes("expected object, got string"),
      `[11] 🔴 a bare STRING is refused as a wrong TYPE — an identity carries its surface, so there is exactly one way to spell an entry (got: ${message.slice(0, 200) || "NO THROW"})`,
    );
  }
  refusesEntry(["T0123ABCD:B0456EFGH"], "[11] …and a list of bare strings is refused with the GRAMMAR — that is the key this one replaced, so its author needs to be told the entry shape");
  refusesEntry([{ surface: "slack" }], "[11] an entry with no `principal` is refused — an entry that names nobody still reads as a vouch in the operator table");
  refusesEntry([{ principal: "T0123ABCD:B0456EFGH" }], "[11] …and an entry with no `surface` is refused too — an unsurfaced principal is matchable at every door");
  refusesEntry([{ surface: "slack", principal: "" }], "[11] a BLANK principal is refused — it is the one shape where the declaration and the behaviour disagree in silence");
  refusesEntry([{ surface: "Slack", principal: "T0123ABCD:B0456EFGH" }], "[11] a mis-cased surface is refused — a surface key's platform segment is lower-case, and a fold here is a wider match");
  refusesEntry([{ surface: "slack", principal: " T0123ABCD:B0456EFGH " }], "[11] a padded principal is refused rather than trimmed — the stored value is the value matched, with no normalisation step to disagree about");
  refusesSlackPair([{ surface: "slack", principal: "B0456EFGH" }], "[11] a bare Slack bot id with no workspace is refused — the pair is workspace-pinned or it is not a pin");
  refusesSlackPair([{ surface: "slack", principal: "T0123ABCD:b0456efgh" }], "[11] a lowercase Slack bot id is refused — Slack ids are upper-case, and a case-insensitive match is a wider match");
  refusesSlackPair([{ surface: "slack", principal: "123456789:987654321" }], "[11] a DISCORD pair declared on the SLACK surface is refused — the surface field is a claim the grammar checks, not a label");
  refusesEntry(
    [{ surface: "slack", principal: "T0123ABCD:B0456EFGH" }, { surface: "discord", principal: "" }],
    "[11] 🔴 a list with ONE malformed element is refused WHOLE — a per-element skip would load a roll that silently differs from the reviewed diff",
  );
  refusesEntry([42], "[11] a non-object element is refused — the shape is checked, not assumed");

  eq(refusalFor([{ surface: "slack", principal: "T0123ABCD:B0456EFGH" }]), "", "[11] a well-formed Slack entry is not refused at all");
  eq(refusalFor([{ surface: "discord", principal: "123456789012345678" }]), "", "[11] …and neither is a Discord entry, whose principal this repository cannot check beyond its shape");
  eq(refusalFor([]), "", "[11] …and neither is the empty list");

  resetSettingsForTest();
}

console.log(`\nsettings: ${n} assertions passed.`);

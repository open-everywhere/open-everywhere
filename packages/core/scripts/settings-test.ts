import assert from "node:assert/strict";
import {
  SETTINGS,
  defineSettings,
  getSettings,
  registerSettings,
  resetSettingsForTest,
  settingDocs,
  settingEnvNames,
} from "../agent/settings/settings.js";
import { windowTopologyEnabled, WINDOW_TOPOLOGY_ENABLED, OE_WINDOW_TOPOLOGY_ENV } from "../agent/access/capabilities.js";
import { oneshotAgentEnabled, OE_ONESHOT_AGENT_ENV } from "../agent/access/delegation-flag.js";
import { taintTierMode } from "../agent/access/taint-enforcement.js";
import { approvalJudgeMode } from "../agent/access/approval-judge.js";
import { connectorDmOnlyEnabled, OE_CONNECTOR_DM_ONLY_ENV } from "../agent/access/connector-scope.js";
import {
  connectorUserPrincipalEnabled,
  connectorOpTieringEnabled,
  connectorLinkSetVaultEnabled,
  directoryLinkSetVaultArmed,
  OE_CONNECTOR_USER_PRINCIPAL_ENV,
  OE_CONNECTOR_OP_TIERING_ENV,
  OE_CONNECTOR_LINKSET_VAULT_ENV,
} from "../agent/connections/connector-flags.js";
import { bashTimeoutMs, backgroundGuardEnabled, DEFAULT_BASH_TIMEOUT_MS } from "../agent/stall/bash-hang-guard.js";
import { domainSkillCap, DEFAULT_DOMAIN_SKILL_CAP } from "../agent/skills/domain-skills.js";
import { auditSilencesEnabled } from "../agent/audit/audit.js";
import { redriveEnabled } from "../agent/channels/unified-redrive.js";
import { sourceScopedToolsEnabled, genericReadVerbsEnabled } from "../agent/access/source-scoped-mount.js";
import { maxResultChars, DEFAULT_MAX_RESULT_CHARS } from "../agent/access/result-cap.js";
import { stallThreshold, DEFAULT_STALL_THRESHOLD } from "../agent/stall/guard.js";
import { checkpointTtlHours } from "../agent/approvals/session-checkpoint.js";
import { usageEventsTtlDays } from "../agent/spend/usage-events.js";
import { sandboxMemoryGiB, sandboxGiBHourUsd, estimateSandboxCostUsd } from "../agent/spend/sandbox-pricing.js";
import { jobBoundMaxDays, jobBoundMaxFires, DEFAULT_JOB_MAX_DAYS, DEFAULT_JOB_MAX_FIRES } from "../agent/routines/bound.js";
import { dreamCandidateCap } from "../agent/schedules/tidy.js";
import { DEFAULT_CANDIDATE_CAP } from "../agent/memory/dream/candidates.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const at = (env: NodeJS.ProcessEnv): ReturnType<typeof getSettings> => getSettings(env);

console.log("1 — precedence is uniform: env wins, then registered settings, then the shipped default:");
{
  resetSettingsForTest();
  eq(at({}).window.topology, false, "[1] nothing set ⇒ the shipped default (window.topology ships OFF)");
  eq(at({}).delegation.oneshotAgent, true, "[1] nothing set ⇒ the shipped default (delegation.oneshotAgent ships ON, OPE-370)");

  registerSettings(defineSettings({ window: { topology: true }, bash: { timeoutMs: 5_000 } }));
  eq(at({}).window.topology, true, "[1] a REGISTERED override beats the shipped default — arming by reviewed diff, the OPE-371 route");
  eq(at({}).bash.timeoutMs, 5_000, "[1] a registered numeric override applies");
  eq(at({}).connectors.dmOnly, true, "[1] settings not overridden keep their shipped default");

  eq(at({ OE_WINDOW_TOPOLOGY: "0" }).window.topology, false, "[1] 🔴 the env override beats the REGISTERED setting, not just the shipped default");
  eq(at({ OE_BASH_TIMEOUT_MS: "1234" }).bash.timeoutMs, 1234, "[1] the env override beats a registered numeric setting");
  eq(
    at({ OE_WINDOW_TOPOLOGY: "banana" }).window.topology,
    true,
    "[1] an UNRECOGNISED env value falls through to the registered setting — a typo can never decide anything",
  );
  resetSettingsForTest();
}

console.log("2 — every read re-resolves (the kill switches depend on it):");
{
  const seq = [
    at({ OE_TAINT_TIERS: "dryrun" }).taint.tierMode,
    at({ OE_TAINT_TIERS: "enforce" }).taint.tierMode,
    at({ OE_TAINT_TIERS: "dryrun" }).taint.tierMode,
    at({}).taint.tierMode,
  ];
  eq(seq, ["dryrun", "enforced", "dryrun", "enforced"], "[2] four reads in one process track the env — no module-level cache");

  const prev = process.env[OE_WINDOW_TOPOLOGY_ENV];
  try {
    process.env[OE_WINDOW_TOPOLOGY_ENV] = "1";
    ok(windowTopologyEnabled(), "[2] the legacy resolver sees a mid-process env change too (it reads process.env by default)");
    process.env[OE_WINDOW_TOPOLOGY_ENV] = "0";
    ok(!windowTopologyEnabled(), "[2] …and back again");
  } finally {
    if (prev === undefined) delete process.env[OE_WINDOW_TOPOLOGY_ENV];
    else process.env[OE_WINDOW_TOPOLOGY_ENV] = prev;
  }
}

console.log("3 — every parser's vocabulary is byte-for-byte what it replaced:");

for (const raw of ["1", "true", "yes", "on", "TRUE", "  On  "]) {
  eq(at({ OE_WINDOW_TOPOLOGY: raw }).window.topology, true, `[3] OE_WINDOW_TOPOLOGY=${JSON.stringify(raw)} arms (case/whitespace-insensitive)`);
}
for (const raw of ["0", "false", "no", "off", "OFF", " false "]) {
  eq(at({ OE_WINDOW_TOPOLOGY: raw }).window.topology, false, `[3] OE_WINDOW_TOPOLOGY=${JSON.stringify(raw)} disarms`);
}
for (const raw of ["", "   ", "maybe", "2", "enabled", "null", "undefined"]) {
  eq(
    at({ OE_WINDOW_TOPOLOGY: raw }).window.topology,
    SETTINGS.window.topology.shipped,
    `[3] OE_WINDOW_TOPOLOGY=${JSON.stringify(raw)} is out of vocabulary ⇒ defers (a typo never silently widens the blast radius)`,
  );
}

for (const [label, envName, read] of [
  ["delegation.oneshotAgent", OE_ONESHOT_AGENT_ENV, (e: NodeJS.ProcessEnv) => at(e).delegation.oneshotAgent],
  ["connectors.userPrincipal", OE_CONNECTOR_USER_PRINCIPAL_ENV, (e: NodeJS.ProcessEnv) => at(e).connectors.userPrincipal],
  ["connectors.opTiering", OE_CONNECTOR_OP_TIERING_ENV, (e: NodeJS.ProcessEnv) => at(e).connectors.opTiering],
  ["connectors.linkSetVault", OE_CONNECTOR_LINKSET_VAULT_ENV, (e: NodeJS.ProcessEnv) => at(e).connectors.linkSetVault],
] as const) {
  for (const raw of ["", "0", "false", "off", "no", " OFF "]) {
    eq(read({ [envName]: raw }), false, `[3] ${label}: ${envName}=${JSON.stringify(raw)} is an off spelling`);
  }
  for (const raw of ["1", "true", "on", "yes", "anything"]) {
    eq(read({ [envName]: raw }), true, `[3] ${label}: ${envName}=${JSON.stringify(raw)} is ON (anything not an off spelling arms)`);
  }
}

eq(at({}).connectors.dmOnly, true, "[3] connectors.dmOnly: unset ⇒ the wall is UP (a security default fails closed)");
eq(at({ OE_CONNECTOR_DM_ONLY: "" }).connectors.dmOnly, true, "[3] connectors.dmOnly: blank ⇒ still UP");
for (const raw of ["0", "false", "off", " OFF "]) {
  eq(at({ OE_CONNECTOR_DM_ONLY: raw }).connectors.dmOnly, false, `[3] connectors.dmOnly: ${JSON.stringify(raw)} disarms the wall`);
}
eq(
  at({ OE_CONNECTOR_DM_ONLY: "no" }).connectors.dmOnly,
  true,
  '[3] 🔴 connectors.dmOnly does NOT honour "no" — an asymmetry against its siblings, PRESERVED deliberately: normalising it would change what an existing deployment\'s env means',
);

eq(at({}).bash.timeoutMs, 600_000, "[3] bash.timeoutMs: shipped default is 600s");
for (const raw of ["0", "off", "false", " OFF "]) {
  eq(at({ OE_BASH_TIMEOUT_MS: raw }).bash.timeoutMs, 0, `[3] bash.timeoutMs: ${JSON.stringify(raw)} disables the timeout entirely`);
}
eq(at({ OE_BASH_TIMEOUT_MS: "90000" }).bash.timeoutMs, 90_000, "[3] bash.timeoutMs: a positive integer applies");
for (const raw of ["", "  ", "-5", "banana"]) {
  eq(
    at({ OE_BASH_TIMEOUT_MS: raw }).bash.timeoutMs,
    600_000,
    `[3] bash.timeoutMs: ${JSON.stringify(raw)} is unparseable ⇒ falls back (fail-safe — the guard stays ON)`,
  );
}

eq(at({ OE_BASH_BACKGROUND_GUARD: "" }).bash.backgroundGuard, true, "[3] bash.backgroundGuard: blank stays armed");
for (const raw of ["0", "off", "false"]) {
  eq(at({ OE_BASH_BACKGROUND_GUARD: raw }).bash.backgroundGuard, false, `[3] bash.backgroundGuard: ${JSON.stringify(raw)} disarms`);
}
eq(at({ OE_BASH_BACKGROUND_GUARD: "no" }).bash.backgroundGuard, true, '[3] bash.backgroundGuard does not honour "no" either — same preserved asymmetry');

eq(at({ OE_SANDBOX_STOP_AFTER_TURN: "0" }).sandbox.stopAfterTurn, false, "[3] sandbox.stopAfterTurn: exactly \"0\" disables");
eq(
  at({ OE_SANDBOX_STOP_AFTER_TURN: " 0 " }).sandbox.stopAfterTurn,
  true,
  '[3] 🔴 sandbox.stopAfterTurn does NOT trim — " 0 " is not "0", exactly as before the migration',
);
eq(at({ OE_SANDBOX_STOP_AFTER_TURN: "false" }).sandbox.stopAfterTurn, true, '[3] sandbox.stopAfterTurn: "false" is NOT an off spelling here');

eq(at({}).sandbox.extendMaxMinutes, 120, "[3] sandbox.extendMaxMinutes: shipped 120");
eq(at({ OE_SANDBOX_EXTEND_MAX_MIN: "45.9" }).sandbox.extendMaxMinutes, 45, "[3] sandbox.extendMaxMinutes: fractional input floors");
for (const raw of ["0", "-1", "banana", ""]) {
  eq(at({ OE_SANDBOX_EXTEND_MAX_MIN: raw }).sandbox.extendMaxMinutes, 120, `[3] sandbox.extendMaxMinutes: ${JSON.stringify(raw)} ⇒ default`);
}
eq(at({}).skills.domainSkillCap, 50, "[3] skills.domainSkillCap: shipped 50");
eq(at({ OE_DOMAIN_SKILL_CAP: "12" }).skills.domainSkillCap, 12, "[3] skills.domainSkillCap: a positive integer applies");
for (const raw of ["0", "-3", "lots", ""]) {
  eq(at({ OE_DOMAIN_SKILL_CAP: raw }).skills.domainSkillCap, 50, `[3] skills.domainSkillCap: ${JSON.stringify(raw)} ⇒ default`);
}

eq(at({}).audit.silences, false, "[3] audit.silences: shipped OFF (the ACTIONS-ONLY posture)");
eq(at({ OE_AUDIT_SILENCES: "1" }).audit.silences, true, '[3] audit.silences: exactly "1" arms');
for (const raw of ["", "0", "true", "yes", "on", " 1 "]) {
  eq(at({ OE_AUDIT_SILENCES: raw }).audit.silences, false, `[3] 🔴 audit.silences: ${JSON.stringify(raw)} does NOT arm — not even "true"/" 1 " (no trim, no alias), exactly as before`);
}

eq(at({}).egress.enforce, true, "[3] egress.enforce: shipped ON (the firewall is up)");
eq(at({ OE_EGRESS_ENFORCE: "0" }).egress.enforce, false, '[3] egress.enforce: exactly "0" drops to dry-run');
for (const raw of ["", "false", "off", "no", " 0 "]) {
  eq(at({ OE_EGRESS_ENFORCE: raw }).egress.enforce, true, `[3] 🔴 egress.enforce: ${JSON.stringify(raw)} does NOT disable enforcement — only "0" does, preserved verbatim`);
}
eq(at({}).egress.allowUnenforced, false, "[3] egress.allowUnenforced: shipped OFF (an unenforceable policy aborts the session)");
eq(at({ OE_ALLOW_UNENFORCED_EGRESS: "1" }).egress.allowUnenforced, true, '[3] egress.allowUnenforced: exactly "1" accepts an unenforced run');
for (const raw of ["", "0", "true", "yes"]) {
  eq(at({ OE_ALLOW_UNENFORCED_EGRESS: raw }).egress.allowUnenforced, false, `[3] egress.allowUnenforced: ${JSON.stringify(raw)} does not accept it`);
}

eq(at({}).window.unifiedRedrive, true, "[3] window.unifiedRedrive: shipped ON (catch-and-correct is the safe default)");
for (const raw of ["0", "false", "no", "off", " OFF "]) {
  eq(at({ OE_UNIFIED_REDRIVE: raw }).window.unifiedRedrive, false, `[3] window.unifiedRedrive: ${JSON.stringify(raw)} turns the correction off`);
}
eq(
  at({ OE_UNIFIED_REDRIVE: "" }).window.unifiedRedrive,
  true,
  '[3] 🔴 window.unifiedRedrive treats BLANK as ON — unlike its wide-vocabulary siblings, because the old resolver defaulted the raw value to "" and compared only the four off spellings',
);

for (const [label, envName, read] of [
  ["tools.sourceScopedMount", "OE_SOURCE_SCOPED_TOOLS", (e: NodeJS.ProcessEnv) => at(e).tools.sourceScopedMount],
  ["tools.genericReadVerbs", "OE_GENERIC_READ_VERBS", (e: NodeJS.ProcessEnv) => at(e).tools.genericReadVerbs],
] as const) {
  eq(read({}), false, `[3] ${label}: shipped OFF (flag-off is byte-identical to the historical guard)`);
  for (const raw of ["", "0", "false", "off", "no", " NO "]) {
    eq(read({ [envName]: raw }), false, `[3] ${label}: ${envName}=${JSON.stringify(raw)} is an off spelling (blank included)`);
  }
  for (const raw of ["1", "true", "on", "stage1"]) {
    eq(read({ [envName]: raw }), true, `[3] ${label}: ${envName}=${JSON.stringify(raw)} arms (anything not an off spelling)`);
  }
}

eq(at({}).tools.maxResultChars, 120_000, "[3] tools.maxResultChars: shipped 120k");
eq(at({ OE_MAX_TOOL_RESULT_CHARS: "5000" }).tools.maxResultChars, 5_000, "[3] tools.maxResultChars: a positive integer applies");
eq(at({ OE_MAX_TOOL_RESULT_CHARS: "9000rubbish" }).tools.maxResultChars, 9_000, "[3] 🔴 tools.maxResultChars uses parseInt, so a trailing-garbage value still parses its prefix — preserved");
for (const raw of ["", "0", "-1", "banana"]) {
  eq(at({ OE_MAX_TOOL_RESULT_CHARS: raw }).tools.maxResultChars, 120_000, `[3] tools.maxResultChars: ${JSON.stringify(raw)} ⇒ default`);
}

eq(at({}).stall.repeatThreshold, 3, "[3] stall.repeatThreshold: shipped 3");
eq(at({ OE_STALL_REPEAT_THRESHOLD: "5" }).stall.repeatThreshold, 5, "[3] stall.repeatThreshold: a positive integer applies");
for (const raw of ["0", "off", "false", " OFF "]) {
  eq(at({ OE_STALL_REPEAT_THRESHOLD: raw }).stall.repeatThreshold, 0, `[3] stall.repeatThreshold: ${JSON.stringify(raw)} DISABLES the guard (0 is a value, not a rejection)`);
}
for (const raw of ["", "  ", "-2", "garbage"]) {
  eq(at({ OE_STALL_REPEAT_THRESHOLD: raw }).stall.repeatThreshold, 3, `[3] stall.repeatThreshold: ${JSON.stringify(raw)} ⇒ default (fail-safe: the guard stays ON)`);
}

for (const [label, envName, shipped, read] of [
  ["approvals.ttlHours", "OE_APPROVAL_TTL_HOURS", 24, (e: NodeJS.ProcessEnv) => at(e).approvals.ttlHours],
  ["approvals.sessionTtlHours", "OE_PR_SESSION_APPROVAL_TTL_HOURS", 24, (e: NodeJS.ProcessEnv) => at(e).approvals.sessionTtlHours],
  ["approvals.checkpointTtlHours", "OE_CHECKPOINT_TTL_HOURS", 24, (e: NodeJS.ProcessEnv) => at(e).approvals.checkpointTtlHours],
  ["spend.usageEventsTtlDays", "OE_USAGE_EVENTS_TTL_DAYS", 90, (e: NodeJS.ProcessEnv) => at(e).spend.usageEventsTtlDays],
  ["spend.sandboxMemoryGiB", "OE_SANDBOX_MEMORY_GIB", 4, (e: NodeJS.ProcessEnv) => at(e).spend.sandboxMemoryGiB],
  ["spend.sandboxGiBHourUsd", "OE_SANDBOX_GIB_HOUR_USD", 0.0212, (e: NodeJS.ProcessEnv) => at(e).spend.sandboxGiBHourUsd],
] as const) {
  eq(read({}), shipped, `[3] ${label}: shipped ${shipped}`);
  eq(read({ [envName]: "12" }), 12, `[3] ${label}: a positive number applies`);
  eq(read({ [envName]: "0.5" }), 0.5, `[3] 🔴 ${label} does NOT floor — a fractional override was always honoured`);
  eq(read({ [envName]: " 12 " }), 12, `[3] ${label}: Number() tolerates padding, so a padded value still applies`);
  for (const raw of ["", "  ", "0", "-4", "banana"]) {
    eq(read({ [envName]: raw }), shipped, `[3] ${label}: ${JSON.stringify(raw)} ⇒ default (garbage, zero and negatives all mean "not configured")`);
  }
}

for (const [label, envName, read] of [
  ["routines.eventMaxFanout", "OE_EVENT_MAX_FANOUT", (e: NodeJS.ProcessEnv) => at(e).routines.eventMaxFanout],
  ["routines.maxConcurrency", "OE_ROUTINE_MAX_CONCURRENCY", (e: NodeJS.ProcessEnv) => at(e).routines.maxConcurrency],
] as const) {
  eq(read({}), 3, `[3] ${label}: shipped 3`);
  eq(read({ [envName]: "7" }), 7, `[3] ${label}: a whole positive number applies`);
  for (const raw of ["2.5", "0", "-1", "", "many"]) {
    eq(read({ [envName]: raw }), 3, `[3] 🔴 ${label}: ${JSON.stringify(raw)} ⇒ default — a FRACTION is refused here, not floored`);
  }
}

for (const [label, envName, shipped, read] of [
  ["routines.jobMaxFires", "OE_JOB_MAX_FIRES", 200, (e: NodeJS.ProcessEnv) => at(e).routines.jobMaxFires],
  ["routines.jobMaxDays", "OE_JOB_MAX_DAYS", 7, (e: NodeJS.ProcessEnv) => at(e).routines.jobMaxDays],
] as const) {
  eq(read({}), shipped, `[3] ${label}: shipped ${shipped}`);
  eq(read({ [envName]: "12" }), 12, `[3] ${label}: a positive number applies`);
  eq(read({ [envName]: "12.9" }), 12, `[3] 🔴 ${label} FLOORS a fraction (its sibling fan-out caps refuse one) — both conventions preserved`);
  for (const raw of ["0", "-1", "", "lots"]) {
    eq(read({ [envName]: raw }), shipped, `[3] ${label}: ${JSON.stringify(raw)} ⇒ default`);
  }
}

eq(at({}).browser.enabled, false, "[3] browser.enabled: shipped OFF (the capability does not exist)");
eq(at({ OE_AGENT_BROWSER: "1" }).browser.enabled, true, '[3] browser.enabled: exactly "1" arms');
for (const raw of ["", "0", "true", "yes", "on", " 1 "]) {
  eq(at({ OE_AGENT_BROWSER: raw }).browser.enabled, false, `[3] 🔴 browser.enabled: ${JSON.stringify(raw)} does NOT arm — not even "true"`);
}
eq(at({}).browser.domains, "", "[3] browser.domains: shipped empty ⇒ the capability cannot arm");
eq(at({ OE_AGENT_BROWSER_DOMAINS: " Preview.Example.COM , localhost " }).browser.domains, " Preview.Example.COM , localhost ", "[3] browser.domains is verbatim — no trim, no split, no lowercase; the adapter parses and fail-closes");

for (const [label, envName, read] of [
  ["discord.autoThread", "OE_DISCORD_AUTO_THREAD", (e: NodeJS.ProcessEnv) => at(e).discord.autoThread],
  ["discord.statusUx", "OE_DISCORD_STATUS_UX", (e: NodeJS.ProcessEnv) => at(e).discord.statusUx],
] as const) {
  eq(read({}), true, `[3] ${label}: shipped ON (a deployer opts OUT of the on-brand behaviour)`);
  for (const raw of ["false", "0"]) {
    eq(read({ [envName]: raw }), false, `[3] ${label}: ${JSON.stringify(raw)} disables`);
  }
  for (const raw of ["", "true", "1", "off", "no", "FALSE"]) {
    eq(read({ [envName]: raw }), true, `[3] 🔴 ${label}: ${JSON.stringify(raw)} leaves it ON — the vocabulary is only "false"/"0", case-sensitive and untrimmed`);
  }
}

eq(at({}).memory.dreamCandidateCap, 10, "[3] memory.dreamCandidateCap: shipped 10");
eq(at({ OE_DREAM_MAX_CANDIDATES: "25" }).memory.dreamCandidateCap, 25, "[3] memory.dreamCandidateCap: a positive integer applies");
eq(at({ OE_DREAM_MAX_CANDIDATES: "25x" }).memory.dreamCandidateCap, 25, "[3] 🔴 memory.dreamCandidateCap uses parseInt, so a trailing-garbage value parses its prefix — preserved");
for (const raw of ["", "0", "-2", "x25"]) {
  eq(at({ OE_DREAM_MAX_CANDIDATES: raw }).memory.dreamCandidateCap, 10, `[3] memory.dreamCandidateCap: ${JSON.stringify(raw)} ⇒ default`);
}

console.log("4 — the safety-asymmetric parsers resolve unrecognised input to the safer value:");
{
  resetSettingsForTest();
  registerSettings(defineSettings({ taint: { tierMode: "enforced" }, approvals: { judgeMode: "enforce" } }));
  for (const raw of ["dryrun", "1", "true", "off", "banana"]) {
    eq(
      at({ OE_TAINT_TIERS: raw }).taint.tierMode,
      "dryrun",
      `[4] 🔴 OE_TAINT_TIERS=${JSON.stringify(raw)} ⇒ dryrun even though the deployment CONFIGURED "enforced" — an unrecognised value can only ever fail toward MORE marking`,
    );
  }
  for (const raw of ["enforce", "enforced", " Enforced ", "ENFORCE"]) {
    eq(at({ OE_TAINT_TIERS: raw }).taint.tierMode, "enforced", `[4] OE_TAINT_TIERS=${JSON.stringify(raw)} ⇒ enforced`);
  }
  eq(at({ OE_TAINT_TIERS: "" }).taint.tierMode, "enforced", "[4] OE_TAINT_TIERS blank defers to the configured value");
  eq(
    at({ OE_APPROVAL_JUDGE: "ENFORCE" }).approvals.judgeMode,
    "off",
    "[4] 🔴 the judge is CASE-SENSITIVE where the taint switch is not — `ENFORCE` does not arm it. Preserved, not tidied",
  );

  for (const raw of ["Enforce", "armed", "ON", "on", "1", "off", ""]) {
    eq(
      at({ OE_APPROVAL_JUDGE: raw }).approvals.judgeMode,
      "off",
      `[4] 🔴 OE_APPROVAL_JUDGE=${JSON.stringify(raw)} ⇒ OFF even though the deployment configured "enforce" — no unrecognised string can arm a verdict-applying judge`,
    );
  }
  eq(at({ OE_APPROVAL_JUDGE: "shadow" }).approvals.judgeMode, "shadow", "[4] exactly `shadow` arms shadow");
  eq(at({ OE_APPROVAL_JUDGE: "enforce" }).approvals.judgeMode, "enforce", "[4] exactly `enforce` arms enforcement");
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
  refuses(() => defineSettings({ bash: { timeoutMs: "600000" } } as never), "expected number", "[5] a wrong-typed value is refused");
  refuses(() => defineSettings({ skills: { domainSkillCap: 0 } }), "positive integer", "[5] an out-of-range value is refused by its validator");
  refuses(() => defineSettings({ sandbox: { extendMaxMinutes: -1 } }), "positive integer", "[5] …in both numeric settings");
  ok(
    defineSettings({ bash: { timeoutMs: 0 } }).bash?.timeoutMs === 0,
    "[5] bash.timeoutMs accepts 0 — that is the documented 'disable the timeout' value, not an out-of-range one",
  );
  eq(defineSettings({}), {}, "[5] an EMPTY override object is valid — 'this deployment holds no opinion beyond the shipped ones'");
}

console.log("6 — the public resolvers are now schema-backed, with their names and shapes intact:");
{
  resetSettingsForTest();
  eq(WINDOW_TOPOLOGY_ENABLED, SETTINGS.window.topology.shipped, "[6] WINDOW_TOPOLOGY_ENABLED IS the schema's shipped default — one source, not two that can drift");
  eq(WINDOW_TOPOLOGY_ENABLED, false, "[6] …and it is still FALSE (the open-source posture pin, unchanged by the migration)");
  eq(DEFAULT_BASH_TIMEOUT_MS, 600_000, "[6] DEFAULT_BASH_TIMEOUT_MS still exports 600s from the schema");
  eq(DEFAULT_DOMAIN_SKILL_CAP, 50, "[6] DEFAULT_DOMAIN_SKILL_CAP still exports 50 from the schema");
  eq(DEFAULT_MAX_RESULT_CHARS, SETTINGS.tools.maxResultChars.shipped, "[6] DEFAULT_MAX_RESULT_CHARS IS the schema's shipped cap — one source");
  eq(DEFAULT_STALL_THRESHOLD, SETTINGS.stall.repeatThreshold.shipped, "[6] DEFAULT_STALL_THRESHOLD IS the schema's shipped threshold — one source");
  eq(DEFAULT_JOB_MAX_DAYS, SETTINGS.routines.jobMaxDays.shipped, "[6] DEFAULT_JOB_MAX_DAYS IS the schema's shipped grace — one source");
  eq(DEFAULT_JOB_MAX_FIRES, SETTINGS.routines.jobMaxFires.shipped, "[6] DEFAULT_JOB_MAX_FIRES IS the schema's shipped cap — one source");
  eq(DEFAULT_CANDIDATE_CAP, SETTINGS.memory.dreamCandidateCap.shipped, "[6] DEFAULT_CANDIDATE_CAP IS the schema's shipped cap — one source");
  eq(DEFAULT_JOB_MAX_FIRES, 200, "[6] …and the derived 200 (>168 hourly fires in the default week) is unchanged by the migration");
  eq(OE_WINDOW_TOPOLOGY_ENV, "OE_WINDOW_TOPOLOGY", "[6] the env-var-name constants are stable (docs and tests name these strings)");
  eq(OE_ONESHOT_AGENT_ENV, "OE_ONESHOT_AGENT", "[6] …OE_ONESHOT_AGENT");
  eq(OE_CONNECTOR_DM_ONLY_ENV, "OE_CONNECTOR_DM_ONLY", "[6] …OE_CONNECTOR_DM_ONLY");
  eq(OE_CONNECTOR_USER_PRINCIPAL_ENV, "OE_CONNECTOR_USER_PRINCIPAL", "[6] …OE_CONNECTOR_USER_PRINCIPAL");
  eq(OE_CONNECTOR_OP_TIERING_ENV, "OE_CONNECTOR_OP_TIERING", "[6] …OE_CONNECTOR_OP_TIERING");
  eq(OE_CONNECTOR_LINKSET_VAULT_ENV, "OE_CONNECTOR_LINKSET_VAULT", "[6] …OE_CONNECTOR_LINKSET_VAULT");

  ok(!connectorUserPrincipalEnabled({}), "[6] connectorUserPrincipalEnabled({}) — the injected-env affordance survives the move");
  ok(connectorUserPrincipalEnabled({ OE_CONNECTOR_USER_PRINCIPAL: "1" }), "[6] …and honours the injected value");
  ok(!connectorOpTieringEnabled({}), "[6] connectorOpTieringEnabled({}) is off by default");
  ok(!connectorLinkSetVaultEnabled({}), "[6] connectorLinkSetVaultEnabled({}) is off by default");
  ok(directoryLinkSetVaultArmed({ OE_CONNECTOR_LINKSET_VAULT: "1" }), "[6] directoryLinkSetVaultArmed still reads the vault flag alone");
  ok(!directoryLinkSetVaultArmed({ OE_CONNECTOR_LINKSET_VAULT: "0" }), "[6] …and an off spelling is not armed");

  const saved: Record<string, string | undefined> = {};
  const names = [...settingEnvNames()];
  for (const k of names) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    ok(!windowTopologyEnabled(), "[6] windowTopologyEnabled() ⇒ shipped OFF");
    ok(oneshotAgentEnabled(), "[6] oneshotAgentEnabled() ⇒ shipped ON");
    eq(taintTierMode(), "enforced", "[6] taintTierMode() ⇒ shipped enforced");
    eq(approvalJudgeMode(), "off", "[6] approvalJudgeMode() ⇒ shipped off");
    ok(connectorDmOnlyEnabled(), "[6] connectorDmOnlyEnabled() ⇒ shipped ON (the wall is up)");
    eq(bashTimeoutMs(), 600_000, "[6] bashTimeoutMs() ⇒ shipped 600s");
    ok(backgroundGuardEnabled(), "[6] backgroundGuardEnabled() ⇒ shipped ON");
    eq(domainSkillCap(), 50, "[6] domainSkillCap() ⇒ shipped 50");
    ok(!auditSilencesEnabled(), "[6] auditSilencesEnabled() ⇒ shipped OFF");
    ok(redriveEnabled(), "[6] redriveEnabled() ⇒ shipped ON");
    ok(!sourceScopedToolsEnabled(), "[6] sourceScopedToolsEnabled() ⇒ shipped OFF");
    ok(!genericReadVerbsEnabled(), "[6] genericReadVerbsEnabled() ⇒ shipped OFF");
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
  } finally {
    for (const k of names) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
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
  eq(new Set(settingEnvNames()).size, settingEnvNames().length, "[7] no env var name is claimed by two settings");
}

console.log("8 — a setting either has an env path or has none, with nothing in between:");
{
  for (const [group, specs] of Object.entries(SETTINGS as unknown as Record<string, Record<string, { env?: string; parseEnv?: unknown }>>)) {
    for (const [key, spec] of Object.entries(specs)) {
      ok(
        (spec.env === undefined) === (spec.parseEnv === undefined),
        `[8] ${group}.${key}: \`env\` and \`parseEnv\` are present together or absent together`,
      );
    }
  }
  resetSettingsForTest();
  eq(at({}).taint.mode, "on", "[8] taint.mode: the shipped default is ON");
  eq(at({ OE_TAINT_MODE: "off", OE_TAINT_TIERS: "off" }).taint.mode, "on", "[8] 🔴 no environment reaches `off` — there is no parser for a value to be read by");
  registerSettings(defineSettings({ taint: { mode: "off" } }));
  eq(at({}).taint.mode, "off", "[8] …a REGISTERED override does, which is the reviewed-diff route and the only one");
  eq(at({ OE_TAINT_MODE: "on" }).taint.mode, "off", "[8] …and no environment pulls it back either: `env` is not consulted at all for a code-only spec");
  resetSettingsForTest();
}

console.log(`\nsettings: ${n} assertions passed.`);

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

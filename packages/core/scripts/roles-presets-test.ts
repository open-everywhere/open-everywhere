import {
  defineRole,
  assertRolesValid,
  applyRoleDefaults,
  effectiveRoleFor,
  renderRoleInstructions,
  roleScopeDomain,
  sandboxPresetFor,
  type Role,
} from "../agent/roles/role.js";
import {
  defineDomain,
  statusVerbsFor,
  modelRouteFor,
  DEFAULT_STATUS_VERBS,
  type Domain,
} from "../agent/memory/domain.js";
import { registerConfig } from "../agent/access/config.js";
import { renderRolePrompt } from "../agent/instructions/access.js";
import type { SurfaceBinding } from "../agent/identity/binding.js";
import type { Partition } from "../agent/memory/partition.js";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();


let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throws(fn: () => unknown, needle: string, label: string): void {
  try {
    fn();
  } catch (err) {
    ok(String(err).includes(needle), `${label} (message mentions "${needle}")`);
    return;
  }
  ok(false, label);
}

for (const k of ["OE_PLATFORM", "OE_WORKSPACE", "OE_SURFACE", "OE_ORG", "OE_TRUST"]) delete process.env[k];

const qa = defineRole({
  name: "qa",
  instructions: "Hunt for edge cases before confirming the happy path.",
  persona: "Precise and skeptical.",
  statusVerbs: ["Probing", "Breaking"],
  bundle: "qa-tools",
  memory: "qa-silo",
  models: { primary: { id: "vendor/qa-model", reasoning: "high" } },
  sandbox: { vcpus: 4 },
});
const pirate = defineRole({ name: "pirate", persona: "A good-natured pirate captain." });
const knobsOnly = defineRole({ name: "knobs-only", bundle: "some-tools" });
const replacer = defineRole({ name: "replacer", statusVerbs: ["Only this"], statusVerbsMode: "replace" });
const ROLES: Role[] = [qa, pirate, knobsOnly, replacer];

const K = "slack/T1/C1";
const bindingFor = (over: Partial<SurfaceBinding> = {}): SurfaceBinding => ({
  org: "default",
  platform: "slack",
  workspace: "T1",
  surface: "C1",
  mode: "channel",
  visibility: "public",
  trust: "internal",
  ...over,
});
const partitionFor = (surface = "C1", domainKey?: string): Partition => ({
  org: "default",
  platform: "slack",
  workspace: "T1",
  surface,
  workspaceKey: "slack/T1",
  surfaceKey: `slack/T1/${surface}`,
  ...(domainKey !== undefined ? { domainKey } : {}),
  key: `slack/T1/${surface}`,
});

assertRolesValid(ROLES);
passed++;
throws(() => assertRolesValid([qa, defineRole({ name: "qa", persona: "again" })]), "defined twice", "duplicate role name throws at load");
throws(() => assertRolesValid([defineRole({ name: "  ", persona: "x" })]), "no name", "blank role name throws at load");
throws(() => assertRolesValid([defineRole({ name: "empty" })]), "presets nothing", "facet-less role throws at load");

throws(
  () => applyRoleDefaults([defineDomain({ name: "team", channels: [K], role: "qa-enginer" })], ROLES),
  'unknown role "qa-enginer"',
  "typo'd role: reference fails LOUD at config load",
);

{
  const [d] = applyRoleDefaults([defineDomain({ name: "team", channels: [K], role: "qa" })], ROLES);
  ok(d.bundle === "qa-tools" && d.memory === "qa-silo" && d.sandbox?.vcpus === 4, "role fills absent bundle/memory/sandbox");
  ok(d.role === "qa", "resolved domain keeps its role name (runtime rungs + prompt need it)");
  ok(d.statusVerbs === undefined && d.models === undefined, "layered knobs (verbs/models) are NOT flattened at load — they merge at resolution");
}
{
  const [d] = applyRoleDefaults(
    [defineDomain({ name: "team", channels: [K], role: "qa", bundle: "own-tools", memory: ["own-silo"], sandbox: { vcpus: 8 } })],
    ROLES,
  );
  ok(d.bundle === "own-tools" && Array.isArray(d.memory) && d.memory[0] === "own-silo" && d.sandbox?.vcpus === 8, "the domain's own bundle/memory/sandbox WIN over the role's, field by field");
}
{
  const plain = defineDomain({ name: "plain", channels: [K] });
  const [d] = applyRoleDefaults([plain], ROLES);
  ok(d === plain, "a role-less domain passes through untouched");
  ok(applyRoleDefaults([plain], []).length === 1, "role-less domains work with an empty role registry");
}

{
  const domains = [defineDomain({ name: "team", channels: [K], role: "qa", statusVerbs: ["Reviewing"] })];
  const verbs = statusVerbsFor(K, domains, ROLES);
  ok(verbs.includes("Probing") && verbs.includes("Breaking"), "role verbs join the vocabulary");
  ok(verbs.includes("Reviewing"), "domain verbs extend ON TOP of the role's");
  ok(verbs.indexOf("Probing") < verbs.indexOf("Reviewing"), "rung order: role beneath domain");
  ok(DEFAULT_STATUS_VERBS.every((v) => verbs.includes(v)), "framework defaults survive (everyone extends)");
}
{
  const domains = [defineDomain({ name: "team", channels: [K], role: "replacer", statusVerbs: ["On top"] })];
  const verbs = statusVerbsFor(K, domains, ROLES);
  ok(verbs.length === 2 && verbs[0] === "Only this" && verbs[1] === "On top", "role replace resets the vocabulary; domain extends on top of the role");
}
{
  const domains = [defineDomain({ name: "team", channels: [K], role: "qa", statusVerbs: ["Solo"], statusVerbsMode: "replace" })];
  const verbs = statusVerbsFor(K, domains, ROLES);
  ok(verbs.length === 1 && verbs[0] === "Solo", "domain replace beats the role rung (domain is the higher layer)");
}
{
  const domains = [defineDomain({ name: "org", match: "org", role: "qa" })];
  ok(statusVerbsFor(K, domains, ROLES).includes("Probing"), "a role on the org pseudo-domain rungs in for unassigned channels");
}
{
  const domains = [defineDomain({ name: "team", channels: [K], role: "qa", statusVerbs: ["Reviewing"] })];
  const verbs = statusVerbsFor(K, domains);
  ok(!verbs.includes("Probing") && verbs.includes("Reviewing"), "roles omitted → pre-role behaviour (back-compat)");
  const ghost = statusVerbsFor(K, [defineDomain({ name: "team", channels: [K], role: "nope" })], ROLES);
  ok(ghost.length === DEFAULT_STATUS_VERBS.length, "unknown role at RUNTIME contributes no rung (fail-open; load already failed loud)");
}

{
  const domains = [defineDomain({ name: "team", channels: [K], role: "qa" })];
  const r = modelRouteFor("primary", K, domains, ROLES);
  ok(r.id === "vendor/qa-model" && r.reasoning === "high", "role's route applies when the domain sets nothing");
}
{
  const domains = [defineDomain({ name: "team", channels: [K], role: "qa", models: { primary: { reasoning: "low" } } })];
  const r = modelRouteFor("primary", K, domains, ROLES);
  ok(r.id === "vendor/qa-model" && r.reasoning === "low", "domain field beats the role's, field by field (id inherited from the role)");
}
{
  const domains = [
    defineDomain({ name: "org", match: "org", models: { primary: { id: "vendor/org-model", providers: ["fireworks"] } } }),
    defineDomain({ name: "team", channels: [K], role: "qa" }),
  ];
  const r = modelRouteFor("primary", K, domains, ROLES);
  ok(r.id === "vendor/qa-model", "role rung beats the org layer");
  ok(r.providers === undefined, "pin-drop asymmetry holds through the role rung: an id change without providers drops the inherited pin");
}
{
  const pinOnly = defineRole({ name: "pin-only", models: { primary: { providers: ["baseten"] } } });
  const domains = [
    defineDomain({ name: "org", match: "org", models: { primary: { id: "vendor/org-model" } } }),
    defineDomain({ name: "team", channels: [K], role: "pin-only" }),
  ];
  const r = modelRouteFor("primary", K, domains, [pinOnly]);
  ok(r.id === "vendor/org-model" && r.providers?.[0] === "baseten", "role can pin providers while inheriting the org id");
}
ok(modelRouteFor("utility", K, [defineDomain({ name: "team", channels: [K], role: "qa" })], ROLES).id === undefined, "role rung is per model-role: qa presets primary only, utility inherits");

{
  const domains = applyRoleDefaults(
    [defineDomain({ name: "org", match: "org", role: "pirate" }), defineDomain({ name: "team", channels: [K], role: "qa" })],
    ROLES,
  );
  ok(effectiveRoleFor(bindingFor(), partitionFor(), domains, ROLES)?.name === "qa", "explicit domain's role wins");
  const noRole = [defineDomain({ name: "org", match: "org", role: "pirate" }), defineDomain({ name: "team", channels: [K] })];
  ok(effectiveRoleFor(bindingFor(), partitionFor(), noRole, ROLES)?.name === "pirate", "explicit domain without a role falls through to the org role (models doctrine)");
  ok(effectiveRoleFor(bindingFor(), partitionFor("C9"), noRole, ROLES)?.name === "pirate", "unassigned internal channel takes the org pseudo-domain's role");
}
{
  const domains = [defineDomain({ name: "org", match: "org", role: "pirate" }), defineDomain({ name: "dm", match: "dm", role: "qa" })];
  ok(effectiveRoleFor(bindingFor({ mode: "dm" }), partitionFor("D1"), domains, ROLES)?.name === "qa", "internal DM takes the dm pseudo-domain's role");
  const dmBare = [defineDomain({ name: "org", match: "org", role: "pirate" }), defineDomain({ name: "dm", match: "dm" })];
  ok(effectiveRoleFor(bindingFor({ mode: "dm" }), partitionFor("D1"), dmBare, ROLES) === undefined, "a role-less dm scope does NOT fall through to org (no persona leak into DMs)");
  ok(effectiveRoleFor(bindingFor({ mode: "mpim" }), partitionFor("G1"), domains, ROLES) === undefined, "mpim stays role-less (execution-only)");
}
{
  const domains = [defineDomain({ name: "org", match: "org", role: "pirate" }), defineDomain({ name: "public", match: "public", role: "knobs-only" })];
  ok(
    effectiveRoleFor(bindingFor({ trust: "external" }), partitionFor(), domains, ROLES)?.name === "knobs-only",
    "an external channel resolves the public pseudo-domain's role, never an internal one",
  );
  ok(
    effectiveRoleFor(bindingFor({ trust: "external" }), partitionFor(), [defineDomain({ name: "org", match: "org", role: "pirate" })], ROLES) === undefined,
    "external with no public pseudo-domain → no role (fail-closed scope, fail-open feature)",
  );
}
ok(effectiveRoleFor(bindingFor(), partitionFor(), [defineDomain({ name: "team", channels: [K], role: "gone" })], ROLES) === undefined, "unknown role name resolves to undefined at runtime (fail-open)");
{
  const domains = [defineDomain({ name: "team", channels: [K], role: "qa" })];
  const threadPartition = partitionFor("C1-thread-42", K);
  ok(roleScopeDomain(bindingFor(), threadPartition, domains)?.name === "team", "a thread resolves its parent channel's domain (domainKeyOf grain)");
}

{
  const block = renderRoleInstructions(qa);
  ok(block.startsWith("## Your role: qa"), "block is headed with the role name");
  ok(block.includes("Hunt for edge cases") && block.includes("Voice: Precise and skeptical."), "instructions AND persona render");
  ok(renderRoleInstructions(pirate).includes("Voice: A good-natured pirate captain."), "a voice-only persona renders alone");
  ok(renderRoleInstructions(knobsOnly) === "", "a knob-only role injects NO prompt block");
}

{
  const domains = applyRoleDefaults([defineDomain({ name: "team", channels: [K], role: "qa" })], ROLES);
  ok(sandboxPresetFor(bindingFor(), partitionFor(), domains)?.vcpus === 4, "role's sandbox preset reaches the resolved domain (via applyRoleDefaults)");
  const orgSized = [defineDomain({ name: "org", match: "org", sandbox: { vcpus: 2 } }), defineDomain({ name: "team", channels: [K] })];
  ok(sandboxPresetFor(bindingFor(), partitionFor(), orgSized)?.vcpus === 2, "explicit domain without a preset falls through to org's");
  ok(sandboxPresetFor(bindingFor({ mode: "dm" }), partitionFor("D1"), orgSized) === undefined, "DMs don't inherit the org sandbox preset");
}

const seamDomains = applyRoleDefaults(
  [defineDomain({ name: "org", match: "org", role: "pirate" }), defineDomain({ name: "team", channels: [K], role: "qa" })],
  ROLES,
);
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => seamDomains,
  loadSilos: () => [],
  loadRoles: () => ROLES,
  domainsForSurface: () => [],
});

const slackCtx = (channelId: string, extra: Record<string, string> = {}) => ({
  channel: { kind: "slack" },
  session: {
    auth: {
      current: {
        attributes: {
          team_id: "T1",
          channel_id: channelId,
          channel_type: "channel",
          is_private: "false",
          is_ext_shared: "false",
          trust_checked: "true",
          ...extra,
        },
        principalId: "U1",
        principalType: "slack-user",
      },
    },
  },
});

{
  const block = renderRolePrompt(slackCtx("C1"));
  ok(block.includes("## Your role: qa") && block.includes("Hunt for edge cases"), "SEAM: the bound domain's role instructions reach the assembled prompt");
  const orgBlock = renderRolePrompt(slackCtx("C9"));
  ok(orgBlock.includes("## Your role: pirate"), "SEAM: an unassigned channel gets the org role's block");
  const external = renderRolePrompt(slackCtx("C1", { is_ext_shared: "true" }));
  ok(external === "", "SEAM: an externally-shared channel never renders an internal role (trust gate)");
  const grouped = renderRolePrompt(slackCtx("G1", { channel_type: "mpim" }));
  ok(grouped === "", "SEAM: a group chat renders no role block (execution-only)");
}

console.log(`✓ roles-presets: ${passed} assertions passed`);

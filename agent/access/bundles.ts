import {
  assertBindingsValid,
  assertBundlesValid,
  defineBinding,
  defineBundle,
  PACKAGE_REGISTRY_HOSTS,
  type Binding,
  type Bundle,
} from "@open-everywhere/core/agent/access/bundle.js";
import { loadGrantsOverlay } from "./grants.js";
import { loadAgentsOverlay } from "../memory/config/agents-overlay.js";
import { loadGroups } from "../identity/groups.js";

const bundles: Bundle[] = [
  defineBundle({
    name: "org-default",
    domains: ["raw.githubusercontent.com"],
    instructions:
      "Be explicit about which repository and branch any change targets. Never act outside the access granted to this channel.",
  }),

  defineBundle({
    name: "coding",
    repos: ["open-everywhere/open-everywhere"],
    domains: [...PACKAGE_REGISTRY_HOSTS],
    instructions:
      "open-everywhere/open-everywhere is this agent's own source repository. Changes go via branch + open_pull_request; never push to main.",
  }),

  defineBundle({
    name: "notion-connectors",
    connections: [
      {
        id: "notion-rest",
        credentialType: "bearer",
        secretRef: "db:notion:team-key",
        broker: "db",
        allowedWebsites: ["api.notion.com"],
        methods: ["GET", "POST", "PATCH"],
      },
    ],
    plugins: ["notion"],
    instructions:
      "This channel is a live-test bed for the ways this agent can reach Notion " +
      "(backlog item 19): direct REST over api.notion.com (auth is injected automatically " +
      "at the network boundary — never ask for or fabricate a token) and the notion-rest " +
      "skill (a scripted version of the same REST calls). Both reach the same Notion workspace; " +
      "use whichever a request asks for.",
  }),

  defineBundle({
    name: "notion-personal",
    connectors: [{ name: "notion", credential: "user-oauth", contentOrigin: "external" }],
    instructions:
      "Your Notion connector in this DM acts as this user's own account — reads and writes " +
      "carry their identity and access, not the shared team integration.",
  }),

  defineBundle({
    name: "e2e-access-fixture",
    connections: [
      {
        id: "e2e-fixture",
        credentialType: "bearer",
        secretRef: "OE_E2E_FIXTURE_TOKEN",
        broker: "env",
        allowedWebsites: ["raw.githubusercontent.com"],
        methods: ["GET"],
      },
    ],
  }),

  defineBundle({
    name: "e2e-connector-fixture",
    connectors: [{ name: "notion", credential: "team-key", contentOrigin: "external" }],
  }),

  defineBundle({
    name: "e2e-pr-fixture",
    repos: ["example-owner/e2e-scratch"],
    instructions:
      "example-owner/e2e-scratch is a scratch repository for exercising the PR flow. Changes go via branch + open_pull_request.",
  }),

  defineBundle({
    name: "soak-pr-fixture",
    repos: ["example-owner/soak-scratch"],
    instructions:
      "example-owner/soak-scratch is the soak tests' own scratch repository. Changes go via branch + open_pull_request.",
  }),

  defineBundle({
    name: "e2e-taint-floor-fixture",
    approvers: [
      {
        name: "e2e-taint-lower",
        approve: (req) => (req.tool === "add_routine_rule" ? "allow" : undefined),
      },
    ],
  }),

  defineBundle({
    name: "e2e-teams-person-fixture",
    resourceGrants: [
      {
        connector: "teams",
        resources: ["teams:person/29-1oW-qHp1WJKhqw_Ddjc_hwMzNrg-vc6KPMyO5osV_SHTTuHytqrPZr-86xE-HaP9oJwAp1YV9skPbKRRwAdLjxQ"],
      },
    ],
  }),

  defineBundle({
    name: "e2e-teams-channel-fixture",
    resourceGrants: [
      {
        connector: "teams",
        resources: ["teams:channel/19-0exampleTeamsChannel00000000000000001-thread.tacv2"],
      },
    ],
  }),

];

const bindings: Binding[] = [
  defineBinding({ bundle: "org-default", scope: { level: "org" } }),

  defineBinding({ bundle: "coding", scope: { level: "surface", surface: "slack/T0EXAMPLE/C0EXGENRL" } }),

  defineBinding({ bundle: "notion-connectors", scope: { level: "surface", surface: "slack/T0EXAMPLE/C0EXGENRL" } }),

  defineBinding({ bundle: "e2e-access-fixture", scope: { level: "surface", surface: "slack/T0EXAMPLE/C0EXCHAN003" } }),

  defineBinding({ bundle: "e2e-pr-fixture", scope: { level: "domain", domain: "e2e-unified" } }),

  defineBinding({ bundle: "soak-pr-fixture", scope: { level: "domain", domain: "soak" } }),

  defineBinding({ bundle: "e2e-connector-fixture", scope: { level: "surface", surface: "slack/T0EXAMPLE/C0EXCHAN003" } }),

  defineBinding({ bundle: "e2e-connector-fixture", scope: { level: "surface", surface: "slack/T0EXAMPLE/C0EXGENRL" } }),

  defineBinding({ bundle: "e2e-taint-floor-fixture", scope: { level: "surface", surface: "slack/T0EXAMPLE/C0EXCHAN003" } }),

  defineBinding({ bundle: "e2e-teams-person-fixture", scope: { level: "domain", domain: "e2e-unified" } }),

  defineBinding({ bundle: "e2e-teams-channel-fixture", scope: { level: "domain", domain: "e2e-unified" } }),

  defineBinding({
    bundle: "notion-connectors",
    scope: { level: "tenant", tenant: "discord/1300000000000000100" },
    allowBroad: "single-operator Discord test guild — every channel in it is the operator's own live-test surface",
  }),

  defineBinding({
    bundle: "notion-personal",
    scope: { level: "principal", principal: "slack/T0EXAMPLE/U0EXOWNER" },
  }),

];

const overlay = loadGrantsOverlay();
const agentsOverlay = loadAgentsOverlay();
const mergedBundles: readonly Bundle[] = [...bundles, ...overlay.bundles, ...agentsOverlay.bundles];
const mergedBindings: readonly Binding[] = [...bindings, ...overlay.bindings, ...agentsOverlay.bindings];

assertBundlesValid(mergedBundles);
assertBindingsValid(mergedBindings, mergedBundles, loadGroups());

export function loadBundles(): readonly Bundle[] {
  return mergedBundles;
}

export function loadBindings(): readonly Binding[] {
  return mergedBindings;
}

export function loadBaseBundles(): readonly Bundle[] {
  return bundles;
}

export function loadBaseBindings(): readonly Binding[] {
  return bindings;
}

import {
  assertBindingsValid,
  assertBundlesValid,
  defineBinding,
  defineBundle,
  type Binding,
  type Bundle,
} from "@open-everywhere/core/agent/access/bundle.js";
import { loadGrantsOverlay } from "./grants.js";

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
    instructions:
      "open-everywhere/open-everywhere is this agent's own source repository. Changes go via branch + open_pull_request; never push to main.",
  }),

  defineBundle({
    name: "notion-connectors",
    connections: [
      {
        id: "notion-rest",
        credentialType: "bearer",
        secretRef: "NOTION_API_KEY",
        allowedWebsites: ["api.notion.com"],
        methods: ["GET", "POST", "PATCH"],
      },
    ],
    plugins: ["notion"],
    providers: [{ provider: "notion", credential: "team-key" }],
    instructions:
      "This channel is a live-test bed for the three ways this agent can reach Notion " +
      "(backlog item 19): direct REST over api.notion.com (auth is injected automatically " +
      "at the network boundary — never ask for or fabricate a token), the notion-rest " +
      "skill (a scripted version of the same REST calls), and the notion MCP connector. " +
      "All three reach the same Notion workspace; use whichever a request asks for.",
  }),

  defineBundle({
    name: "e2e-access-fixture",
    connections: [
      {
        id: "e2e-fixture",
        credentialType: "bearer",
        secretRef: "OE_E2E_FIXTURE_TOKEN",
        allowedWebsites: ["raw.githubusercontent.com"],
        methods: ["GET"],
      },
    ],
  }),

];

const bindings: Binding[] = [
  defineBinding({ bundle: "org-default", scope: { level: "org" } }),

  defineBinding({ bundle: "coding", scope: { level: "channel", workspace: "T0EXAMPLE", channel: "C0EXGENRL" } }),

  defineBinding({ bundle: "notion-connectors", scope: { level: "channel", workspace: "T0EXAMPLE", channel: "C0EXGENRL" } }),

  defineBinding({ bundle: "e2e-access-fixture", scope: { level: "channel", workspace: "T0EXAMPLE", channel: "C0EXCHAN003" } }),

  defineBinding({ bundle: "notion-connectors", scope: { level: "workspace", workspace: "1300000000000000100" } }),

];

const overlay = loadGrantsOverlay();
const mergedBundles: readonly Bundle[] = [...bundles, ...overlay.bundles];
const mergedBindings: readonly Binding[] = [...bindings, ...overlay.bindings];

assertBundlesValid(mergedBundles);
assertBindingsValid(mergedBindings, mergedBundles);

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

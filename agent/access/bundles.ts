import {
  assertBindingsValid,
  assertBundlesValid,
  defineBinding,
  defineBundle,
  type Binding,
  type Bundle,
} from "@open-everywhere/core/agent/access/bundle.js";

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

];

const bindings: Binding[] = [
  defineBinding({ bundle: "org-default", scope: { level: "org" } }),

  defineBinding({ bundle: "coding", scope: { level: "channel", workspace: "T0EXAMPLE", channel: "C0EXGENRL" } }),

  defineBinding({ bundle: "notion-connectors", scope: { level: "channel", workspace: "T0EXAMPLE", channel: "C0EXGENRL" } }),

];

assertBundlesValid(bundles);
assertBindingsValid(bindings, bundles);

export function loadBundles(): readonly Bundle[] {
  return bundles;
}

export function loadBindings(): readonly Binding[] {
  return bindings;
}

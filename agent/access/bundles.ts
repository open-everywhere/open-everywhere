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

];

const bindings: Binding[] = [
  defineBinding({ bundle: "org-default", scope: { level: "org" } }),

  defineBinding({ bundle: "coding", scope: { level: "channel", workspace: "T0EXAMPLE", channel: "C0EXGENRL" } }),

];

assertBundlesValid(bundles);
assertBindingsValid(bindings, bundles);

export function loadBundles(): readonly Bundle[] {
  return bundles;
}

export function loadBindings(): readonly Binding[] {
  return bindings;
}

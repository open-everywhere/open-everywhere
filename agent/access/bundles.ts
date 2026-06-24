import { defineBinding, defineBundle, type Binding, type Bundle } from "./bundle.js";

const bundles: Bundle[] = [
  defineBundle({
    name: "org-default",
    domains: ["raw.githubusercontent.com"],
    instructions:
      "Be explicit about which repository and branch any change targets. Never act outside the access granted to this channel.",
  }),

];

const bindings: Binding[] = [
  defineBinding({ bundle: "org-default", scope: { level: "org" } }),

];

export function loadBundles(): readonly Bundle[] {
  return bundles;
}

export function loadBindings(): readonly Binding[] {
  return bindings;
}

import { defineBundle, type Bundle } from "./bundle.js";

const bundles: Bundle[] = [
  defineBundle({
    name: "org-default",
    scope: { level: "org" },
    domains: ["raw.githubusercontent.com"],
    instructions:
      "Be explicit about which repository and branch any change targets. Never act outside the access granted to this channel.",
  }),

];

export function loadBundles(): readonly Bundle[] {
  return bundles;
}

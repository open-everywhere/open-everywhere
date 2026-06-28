import { registerConfig } from "../agent/access/config.js";
import { defineBundle, defineBinding } from "../agent/access/bundle.js";

registerConfig({
  loadBundles: () => [
    defineBundle({
      name: "org-default",
      domains: ["raw.githubusercontent.com"],
      instructions:
        "Be explicit about which repository and branch any change targets. Never act outside the access granted to this channel.",
    }),
  ],
  loadBindings: () => [defineBinding({ bundle: "org-default", scope: { level: "org" } })],
  pluginRegistry: {},
  skillContent: {},
  domainsForSurface: () => [],
});

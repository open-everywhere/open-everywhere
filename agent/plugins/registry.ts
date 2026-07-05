import type { PluginRegistry } from "@open-everywhere/core/agent/plugins/types.js";

export type { PluginRegistry, PluginManifestEntry } from "@open-everywhere/core/agent/plugins/types.js";

export const PLUGIN_REGISTRY: PluginRegistry = {
  notion: { skills: ["notion-rest"] },
};

import type { PluginRegistry } from "@open-everywhere/core/agent/plugins/types.js";
import { GENERATED_PLUGIN_REGISTRY } from "./generated/index.js";

export type { PluginRegistry, PluginManifestEntry } from "@open-everywhere/core/agent/plugins/types.js";

export const PLUGIN_REGISTRY: PluginRegistry = {
  ...GENERATED_PLUGIN_REGISTRY,

  notion: { skills: ["notion-rest"] },
};

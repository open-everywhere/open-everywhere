export interface PluginManifestEntry {
  readonly connectors?: readonly string[];
  readonly skills?: readonly string[];
  readonly subagents?: readonly string[];
}

export type PluginRegistry = Record<string, PluginManifestEntry>;

export const PLUGIN_REGISTRY: PluginRegistry = {};

import type { Bundle, Binding } from "./bundle.js";
import type { Provider } from "./providers.js";
import type { PluginRegistry } from "../plugins/types.js";
import type { SkillPackageDefinition } from "eve/skills";
import type { Domain } from "../memory/domain.js";
import type { MemorySilo } from "../memory/silo.js";
import type { WebhookHook } from "../webhooks/config.js";

export interface AppConfig {
  loadBundles(): readonly Bundle[];
  loadBindings(): readonly Binding[];
  loadProviders?(): readonly Provider[];
  readonly pluginRegistry: PluginRegistry;
  readonly skillContent: Record<string, SkillPackageDefinition>;
  loadDomains(): readonly Domain[];
  loadSilos(): readonly MemorySilo[];
  domainsForSurface(arg: { workspaceKey: string; surface: string }): readonly string[];
  loadWebhooks?(): readonly WebhookHook[];
}

let registered: AppConfig | null = null;

export function registerConfig(config: AppConfig): void {
  registered = config;
}

export function getConfig(): AppConfig {
  if (!registered) {
    throw new Error(
      "open-everywhere: app config not registered. The app must call registerConfig() at " +
        "startup (agent/instrumentation.ts); tests must import the shared config bootstrap.",
    );
  }
  return registered;
}

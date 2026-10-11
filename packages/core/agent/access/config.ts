import type { Bundle, Binding } from "./bundle.js";
import { defaultConnectorOpTierArm, type ConnectorOpTierArm } from "./consequence.js";
import type { ResultReduceSeam } from "./result-reduce.js";
import type { WakeArmAnswer, WakeArmInput } from "../channels/wake-arm.js";
import type { ConnectorCredentials } from "./connector-credentials.js";
import type { NetworkAccessBinding } from "./network-access.js";
import type { AgentsFile } from "../memory/agents-codemod.js";
import type { PluginRegistry } from "../plugins/types.js";
import type { SkillPackageDefinition } from "eve/skills";
import type { Domain } from "../memory/domain.js";
import type { MemorySilo } from "../memory/silo.js";
import type { Role } from "../roles/role.js";
import type { WebhookHook } from "../webhooks/config.js";
import type { McpServerDeclaration } from "../connections/mcp-servers.js";
import type { SpendBudgets } from "../spend/spend.js";
import type { SpendCheckpoints } from "../spend/checkpoint.js";
import type { ModelPolicy } from "../model/policy.js";
import type { Principal } from "../identity/principals.js";
import type { Group } from "../identity/groups.js";

export interface AccessRequestsConfig {
  readonly adminChannel?: string;
  readonly configRepo?: string;
  readonly configBase?: string;
  readonly grantsPath?: string;
  readonly hooksPath?: string;
  readonly agentsPath?: string;
  readonly mcpServersPath?: string;
  readonly groupsPath?: string;
  baseWebhooks?(): readonly WebhookHook[];
  baseMcpServers?(): readonly McpServerDeclaration[];
  baseAgents?(): AgentsFile;
  baseDomains?(): readonly Domain[];
  baseSilos?(): readonly MemorySilo[];
  readonly dryRun?: boolean;
  readonly credentialBindingLive?: boolean;
  baseBundles(): readonly Bundle[];
  baseBindings(): readonly Binding[];
  domainRegistry?(): readonly Domain[];
  groupRegistry?(): readonly Group[];
  baseConnectorCredentials?(): readonly ConnectorCredentials[];
}

export interface AppConfig {
  loadBundles(): readonly Bundle[];
  loadBindings(): readonly Binding[];
  loadConnectorCredentials?(): readonly ConnectorCredentials[];
  loadNetworkAccess?(): readonly NetworkAccessBinding[];
  readonly pluginRegistry: PluginRegistry;
  readonly skillContent: Record<string, SkillPackageDefinition>;
  readonly skillSessionFiles?: Readonly<Record<string, (where: { readonly platform: string; readonly surface: string }) => Record<string, string>>>;
  loadDomains(): readonly Domain[];
  loadSilos(): readonly MemorySilo[];
  loadRoles?(): readonly Role[];
  domainsForSurface(arg: { workspaceKey: string; surface: string }): readonly string[];
  loadWebhooks?(): readonly WebhookHook[];
  loadWebhookSources?(): readonly string[] | undefined;
  loadSpendBudgets?(): SpendBudgets;
  loadSpendCheckpoints?(): SpendCheckpoints;
  loadAccessRequests?(): AccessRequestsConfig | null;
  loadModelPolicy?(): ModelPolicy | undefined;
  loadPrincipals?(): readonly Principal[];
  loadGroups?(): readonly Group[];
  auditScrub?(text: string): string;

  connectorOpTier?: ConnectorOpTierArm;

  reduceResult?(
    body: string,
    limit: number,
    ctx: { readonly source: ResultReduceSeam; readonly toolName?: string },
  ): string | undefined | Promise<string | undefined>;

  decideWake?(input: WakeArmInput): WakeArmAnswer | undefined | Promise<WakeArmAnswer | undefined>;
}

let registered: AppConfig | null = null;

export function registerConfig(config: AppConfig): void {
  registered = config.connectorOpTier === undefined ? { ...config, connectorOpTier: defaultConnectorOpTierArm } : config;
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

export class ConfigLoadRefusalError extends Error {
  readonly gate: string;
  constructor(gate: string, cause: unknown) {
    super(
      `open-everywhere: ${gate} refused — the app config is registered but failed to load (${String(cause).slice(0, 200)}). ` +
        "The gate fails closed rather than run on an empty config. Fix the config repo and retry.",
    );
    this.name = "ConfigLoadRefusalError";
    this.gate = gate;
  }
}

const configRefusalsLogged = new Set<string>();

export function configOrRefuse<T>(gate: string, read: (config: AppConfig) => T): T | undefined {
  if (!registered) return undefined;
  try {
    return read(registered);
  } catch (err) {
    const refusal = new ConfigLoadRefusalError(gate, err);
    if (!configRefusalsLogged.has(gate)) {
      configRefusalsLogged.add(gate);
      console.error(`[open-everywhere:config] ${refusal.message}`);
    }
    throw refusal;
  }
}

import { registerOeOauth } from "./oe-oauth/register.js";
import { oeOauthEnabled, loadOeOauthConfig } from "./oe-oauth/config.js";
import { registerAgentBrowser } from "./browser/register.js";
import { agentBrowserEnabled, loadAgentBrowserConfig } from "./browser/config.js";
import { registerAwsAccess } from "./aws/register.js";
import { awsAccessEnabled } from "./aws/config.js";
import { registerDirectoryAdapter } from "./directory/register.js";
import { registerGatewayRouteProbe } from "./model/gateway-probe.js";
import { registerNeon } from "./postgres/neon.js";
import { vercelBlobPutter } from "./blob/hosting.js";
import {
  registerDbCredentialBroker,
  CREDENTIAL_KEY_ENV,
  registerGitHubConfigPrProvider,
  setBlobPutter,
  registerAuditDropCounter,
  emitTelemetry,
  getOperationalStore,
  bootVerifyAuditChainTail,
  bootBackfillLinkTenants,
  runBootNotices,
  registerBootNotice,
  announceJudgeWithoutRules,
  registerOperationalPgliteLazy,
  resolveOperationalSelection,
  resolveMemoryProviderId,
  onVercel,
  declareProviderSelection,
  assertConnectorMemoryGrants,
  applySubtreeSurfaceClaims,
  reconcileSurfaceCommands,
  type Domain,
  type DomainMemoryGrants,
  type MemorySilo,
  type OperationalFloor,
} from "@open-everywhere/core/agent/adapter-api.js";

export interface SelectedProviderBundle {
  readonly id: string;
  readonly register: () => void;
}

export interface DefaultAdapterOptions {
  readonly providers: readonly SelectedProviderBundle[];
  readonly memory: {
    readonly domains: () => readonly Domain[];
    readonly silos: () => readonly MemorySilo[];
    readonly grants: (domain: Domain) => DomainMemoryGrants | null;
  };
  readonly customAdapters?: () => void | Promise<void>;
}

export interface StoreWiring {
  readonly operational: { readonly id: string; readonly floor: OperationalFloor };
  readonly neon: boolean;
  readonly pgliteFloor: boolean;
}

export interface DefaultAdapterWiring {
  readonly providers: readonly string[];
  readonly oeOauth: boolean;
  readonly dbCredentialBroker: boolean;
  readonly agentBrowser: boolean;
  readonly awsAccess: boolean;
  readonly customAdapters: boolean;
  readonly store: StoreWiring;
}

export function decideStoreWiring(env: NodeJS.ProcessEnv, vercel: boolean): StoreWiring {
  const operational = resolveOperationalSelection(env);
  const postgresSelected =
    resolveMemoryProviderId(env) === "postgres" || (operational.id === "postgres" && operational.floor === "none");
  return {
    operational,
    neon: postgresSelected && Boolean(env.DATABASE_URL),
    pgliteFloor: operational.floor === "pglite" && (!vercel || env.OE_ALLOW_EPHEMERAL_OPERATIONAL === "1"),
  };
}

let WIRED: DefaultAdapterWiring | undefined;
let STARTED: Promise<DefaultAdapterWiring> | undefined;

export function defaultAdapterWiring(): DefaultAdapterWiring | undefined {
  return WIRED;
}

export function registerDefaultAdapters(options: DefaultAdapterOptions): Promise<DefaultAdapterWiring> {
  STARTED ??= wireDefaultAdapters(options);
  return STARTED;
}

async function wireDefaultAdapters(options: DefaultAdapterOptions): Promise<DefaultAdapterWiring> {

  const providers = declareProviderSelection(options.providers.map((p) => p.id));

  const oeOauthCfg = oeOauthEnabled() ? loadOeOauthConfig() : undefined;
  if (oeOauthCfg) registerOeOauth({ providers: oeOauthCfg });

  const dbCredentialBroker = Boolean(process.env[CREDENTIAL_KEY_ENV]);
  if (dbCredentialBroker) registerDbCredentialBroker();

  const browserCfg = agentBrowserEnabled() ? loadAgentBrowserConfig() : undefined;
  const agentBrowser = browserCfg ? registerAgentBrowser(browserCfg) : false;

  const awsAccess = awsAccessEnabled();
  if (awsAccess) registerAwsAccess();

  registerDirectoryAdapter();

  registerGitHubConfigPrProvider();

  for (const provider of options.providers) {
    provider.register();
  }

  registerGatewayRouteProbe();

  registerAuditDropCounter((action, platform) => emitTelemetry("oe.audit.dropped", { "oe.action": action, "oe.platform": platform }));

  setBlobPutter(vercelBlobPutter);

  const customAdapters = options.customAdapters !== undefined;
  if (options.customAdapters) await options.customAdapters();

  assertConnectorMemoryGrants(options.memory.domains(), options.memory.silos(), options.memory.grants);

  applySubtreeSurfaceClaims();

  registerBootNotice("approval-judge-no-rules", announceJudgeWithoutRules);

  const store = decideStoreWiring(process.env, onVercel());

  if (store.neon) await registerNeon();

  if (store.pgliteFloor) registerOperationalPgliteLazy(undefined, runBootStoreChecks);
  else await runBootStoreChecks();

  await reconcileSurfaceCommands();

  WIRED = { providers, oeOauth: oeOauthCfg !== undefined, dbCredentialBroker, agentBrowser, awsAccess, customAdapters, store };
  return WIRED;
}

async function runBootStoreChecks(): Promise<void> {
  try {
    await bootVerifyAuditChainTail(getOperationalStore());
  } catch {
  }
  try {
    await bootBackfillLinkTenants();
  } catch {
  }
  try {
    await runBootNotices();
  } catch {
  }
}

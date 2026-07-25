import { registerOeOauth } from "@open-everywhere/adapters/agent/oe-oauth/register.js";
import { oeOauthEnabled, loadOeOauthConfig } from "@open-everywhere/adapters/agent/oe-oauth/config.js";
import { registerExecutor } from "@open-everywhere/adapters/agent/executor/register.js";
import { executorEnabled, loadExecutorConfig } from "@open-everywhere/adapters/agent/executor/config.js";
import { registerAgentBrowser } from "@open-everywhere/adapters/agent/browser/register.js";
import { agentBrowserEnabled, loadAgentBrowserConfig } from "@open-everywhere/adapters/agent/browser/config.js";
import {
  registerDbCredentialBroker,
  CREDENTIAL_KEY_ENV,
  registerGitHubMemory,
  registerGitHubConfigPrProvider,
  setBlobPutter,
  registerAuditDropCounter,
  emitTelemetry,
  getOperationalStore,
  bootVerifyAuditChainTail,
  registerOperationalPglite,
  onVercel,
  declareProviderSelection,
} from "@open-everywhere/core/agent/adapter-api.js";
import { SELECTED_PROVIDERS, SELECTED_PROVIDER_IDS } from "./providers.js";
import { registerNeon } from "@open-everywhere/adapters/agent/postgres/neon.js";
import { vercelBlobPutter } from "@open-everywhere/adapters/agent/blob/hosting.js";

declareProviderSelection(SELECTED_PROVIDER_IDS);

{
  const oeOauthCfg = oeOauthEnabled() ? loadOeOauthConfig() : undefined;
  if (oeOauthCfg) {
    registerOeOauth({ providers: oeOauthCfg });
  }
}

if (process.env[CREDENTIAL_KEY_ENV]) {
  registerDbCredentialBroker();
}

{
  const executorCfg = executorEnabled() ? loadExecutorConfig() : undefined;
  if (executorCfg) {
    registerExecutor(executorCfg);
  }
}

{
  const browserCfg = agentBrowserEnabled() ? loadAgentBrowserConfig() : undefined;
  if (browserCfg) {
    registerAgentBrowser(browserCfg);
  }
}

registerGitHubMemory();

registerGitHubConfigPrProvider();

for (const provider of SELECTED_PROVIDERS) {
  provider.register();
}

if (
  (process.env.OE_MEMORY_PROVIDER === "postgres" || process.env.OE_OPERATIONAL_PROVIDER === "postgres") &&
  process.env.DATABASE_URL
) {
  await registerNeon();
}

if (
  !process.env.OE_OPERATIONAL_PROVIDER &&
  !process.env.DATABASE_URL &&
  (!onVercel() || process.env.OE_ALLOW_EPHEMERAL_OPERATIONAL === "1")
) {
  await registerOperationalPglite();
}

registerAuditDropCounter((action, platform) => emitTelemetry("oe.audit.dropped", { "oe.action": action, "oe.platform": platform }));

setBlobPutter(vercelBlobPutter);

try {
  await bootVerifyAuditChainTail(getOperationalStore());
} catch {
}

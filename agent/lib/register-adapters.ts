import { registerOeOauth } from "@open-everywhere/adapters/agent/oe-oauth/register.js";
import { oeOauthEnabled, loadOeOauthConfig } from "@open-everywhere/adapters/agent/oe-oauth/config.js";
import { registerAgentBrowser } from "@open-everywhere/adapters/agent/browser/register.js";
import { agentBrowserEnabled, loadAgentBrowserConfig } from "@open-everywhere/adapters/agent/browser/config.js";
import { registerAwsAccess } from "@open-everywhere/adapters/agent/aws/register.js";
import { awsAccessEnabled } from "@open-everywhere/adapters/agent/aws/config.js";
import { registerDirectoryAdapter } from "@open-everywhere/adapters/agent/directory/register.js";
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
  registerOperationalPgliteLazy,
  onVercel,
  declareProviderSelection,
  assertConnectorMemoryGrants,
} from "@open-everywhere/core/agent/adapter-api.js";
import { SELECTED_PROVIDERS, SELECTED_PROVIDER_IDS } from "./providers.generated.js";
import { loadDomains, loadSilos } from "../memory/domains.js";
import { domainMemoryGrants } from "./memory-grants.js";
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
  const browserCfg = agentBrowserEnabled() ? loadAgentBrowserConfig() : undefined;
  if (browserCfg) {
    registerAgentBrowser(browserCfg);
  }
}

if (awsAccessEnabled()) {
  registerAwsAccess();
}

registerDirectoryAdapter();

registerGitHubConfigPrProvider();

for (const provider of SELECTED_PROVIDERS) {
  provider.register();
}

assertConnectorMemoryGrants(loadDomains(), loadSilos(), domainMemoryGrants);

if (
  (process.env.OE_MEMORY_PROVIDER === "postgres" || process.env.OE_OPERATIONAL_PROVIDER === "postgres") &&
  process.env.DATABASE_URL
) {
  await registerNeon();
}

const pgliteFloorArmed =
  !process.env.OE_OPERATIONAL_PROVIDER &&
  !process.env.DATABASE_URL &&
  (!onVercel() || process.env.OE_ALLOW_EPHEMERAL_OPERATIONAL === "1");
if (pgliteFloorArmed) {
  registerOperationalPgliteLazy(undefined, runBootStoreChecks);
}

registerAuditDropCounter((action, platform) => emitTelemetry("oe.audit.dropped", { "oe.action": action, "oe.platform": platform }));

setBlobPutter(vercelBlobPutter);

async function runBootStoreChecks(): Promise<void> {
  try {
    await bootVerifyAuditChainTail(getOperationalStore());
  } catch {
  }
  try {
    await bootBackfillLinkTenants();
  } catch {
  }
}

if (!pgliteFloorArmed) await runBootStoreChecks();

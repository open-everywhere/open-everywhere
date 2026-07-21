import { registerVercelConnect } from "@open-everywhere/adapters/agent/credentials/vercel-connect.js";
import { registerExecutor } from "@open-everywhere/adapters/agent/executor/register.js";
import { executorEnabled, loadExecutorConfig } from "@open-everywhere/adapters/agent/executor/config.js";
import { registerDbCredentialBroker, CREDENTIAL_KEY_ENV } from "@open-everywhere/core/agent/credentials/db-broker.js";
import { registerGitHubMemory } from "@open-everywhere/core/agent/memory/github.js";
import { registerNotionMemory } from "@open-everywhere/adapters/agent/notion/memory.js";
import { registerNeon } from "@open-everywhere/adapters/agent/postgres/neon.js";
import { setBlobPutter } from "@open-everywhere/core/agent/blob/hosting.js";
import { vercelBlobPutter } from "@open-everywhere/adapters/agent/blob/hosting.js";
import { registerAuditDropCounter } from "@open-everywhere/core/agent/audit/audit.js";
import { emitTelemetry } from "@open-everywhere/core/agent/observability/telemetry.js";
import { loadBundles } from "../access/bundles.js";

registerVercelConnect(loadBundles().flatMap((b) => b.connections ?? []));

if (process.env[CREDENTIAL_KEY_ENV]) {
  registerDbCredentialBroker();
}

{
  const executorCfg = executorEnabled() ? loadExecutorConfig() : undefined;
  if (executorCfg) {
    registerExecutor(executorCfg);
  }
}

registerGitHubMemory();

registerNotionMemory();

if (
  (process.env.OE_MEMORY_PROVIDER === "postgres" || process.env.OE_OPERATIONAL_PROVIDER === "postgres") &&
  process.env.DATABASE_URL
) {
  await registerNeon();
}

registerAuditDropCounter((action, platform) => emitTelemetry("oe.audit.dropped", { "oe.action": action, "oe.platform": platform }));

setBlobPutter(vercelBlobPutter);

import { defineChannel, GET } from "eve/channels";

import { OE_STATUS_PATH, STATUS_CACHE_MS, cachedDeploymentStatus, registerStatusProbe } from "../ops/status.js";
import { getOperationalStore } from "../operational/provider.js";
import { getSettings } from "../settings/settings.js";
import { resolveSandboxBackend, type SandboxBackendKind } from "../sandbox/backend-select.js";

registerStatusProbe("postgres", async () => {
  try {
    await getOperationalStore().listAuditOrgs();
    return { met: "yes", detail: "the store answered a read" };
  } catch {
    return { met: "no", detail: "the store did not answer a read" };
  }
});

export default defineChannel({
  routes: [
    GET(OE_STATUS_PATH, async () => {
      let allowUnenforced = false;
      let sandboxBackend: SandboxBackendKind | undefined;
      try {
        allowUnenforced = getSettings().egress.allowUnenforced;
        sandboxBackend = resolveSandboxBackend();
      } catch {
      }
      const doc = await cachedDeploymentStatus({ allowUnenforced, sandboxBackend });
      return new Response(`${JSON.stringify(doc, null, 2)}\n`, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-oe-status-ttl-ms": String(STATUS_CACHE_MS),
        },
      });
    }),
  ],
});

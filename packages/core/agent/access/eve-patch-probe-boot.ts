import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/deployment-identity.js";
import { assertEvePatched } from "./eve-patch-probe.js";

try {
  const result = await assertEvePatched();
  if (result.status === "unverifiable") {
    console.warn(
      `[open-everywhere:eve-patch-probe:boot] eve patch state UNVERIFIABLE at boot — the eve package ` +
        `root did not resolve (${result.reason ?? "unknown reason"}), which is expected on a hosted ` +
        `build that inlines eve. This is NOT a pass: the turn gate (hooks/eve-patch-gate.ts) re-checks ` +
        `the markers at turn.started and refuses the turn if any is missing. A node_modules install is ` +
        `verified here; \`lint:eve-patch\` and \`test:eve-install\` verify the bytes before a deploy.`,
    );
    try {
      await appendAudit({
        org: deploymentOrg(),
        platform: "boot",
        workspace: "boot",
        action: "eve.patch.unverifiable",
        detail: { reason: result.reason ?? "unknown" },
      });
    } catch {
    }
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  try {
    await appendAudit({
      org: deploymentOrg(),
      platform: "boot",
      workspace: "boot",
      action: "eve.patch.refused",
      detail: { message },
    });
  } catch {
  }
  throw err;
}

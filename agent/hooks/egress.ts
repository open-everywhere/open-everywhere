import { defineHook } from "eve/hooks";
import { resolveAccessFor } from "../access/request.js";
import { compileNetworkPolicy } from "../access/egress.js";
import { resolveHeaders } from "../access/credentials.js";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom } from "../identity/binding.js";
import { appendAudit } from "../audit/audit.js";

function log(msg: string): void {
  console.log(`[open-everywhere:egress] ${msg}`);
}

export default defineHook({
  events: {
    "session.started": async (_event, ctx) => {
      try {
        const access = resolveAccessFor(ctx);
        const policy = await compileNetworkPolicy(access, resolveHeaders);
        const hostCount =
          typeof policy === "string" ? 0 : Object.keys(policy.allow ?? {}).length;
        const summary =
          typeof policy === "string" ? policy : `allow ${hostCount} host(s), default-deny`;

        const enforced = process.env.OE_EGRESS_ENFORCE === "1";
        if (enforced) {
          const sandbox = await ctx.getSandbox();
          await sandbox.setNetworkPolicy(policy);
          log(`enforced: ${summary} for ${access.scopeKey}`);
        } else {
          log(`dry-run (set OE_EGRESS_ENFORCE=1 to apply): ${summary} for ${access.scopeKey}`);
        }

        const p = resolvePartition(ctx);
        const principalId = bindFrom(ctx).principalId;
        await appendAudit({
          org: p.org,
          platform: p.platform,
          workspace: p.workspace,
          surface: p.surface,
          principalId,
          action: "egress.policy",
          detail: { hosts: hostCount, enforced, scopeKey: access.scopeKey, summary },
        });

        await appendAudit({
          org: p.org,
          platform: p.platform,
          workspace: p.workspace,
          surface: p.surface,
          principalId,
          action: "connector.grant",
          detail: { connectors: access.connectors, scopeKey: access.scopeKey },
        });
      } catch (err) {
        log(`skipped: ${String(err)}`);
      }
    },
  },
});

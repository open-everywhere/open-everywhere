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

        const wantEnforce = process.env.OE_EGRESS_ENFORCE !== "0";
        let enforced = false;
        if (wantEnforce) {
          try {
            const sandbox = await ctx.getSandbox();
            await sandbox.setNetworkPolicy(policy);
            enforced = true;
            log(`enforced: ${summary} for ${access.scopeKey}`);
          } catch (err) {
            log(`enforce FAILED (backend rejected setNetworkPolicy) — running UNENFORCED: ${String(err)}`);
          }
        } else {
          log(`dry-run (OE_EGRESS_ENFORCE=0): ${summary} for ${access.scopeKey}`);
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

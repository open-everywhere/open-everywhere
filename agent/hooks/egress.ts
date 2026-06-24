import { defineHook } from "eve/hooks";
import { loadBindings, loadBundles } from "../access/bundles.js";
import { resolveAccess } from "../access/resolver.js";
import { buildResolveRequest } from "../access/request.js";
import { compileNetworkPolicy } from "../access/egress.js";
import { resolveHeaders } from "../access/credentials.js";

function log(msg: string): void {
  console.log(`[open-everywhere:egress] ${msg}`);
}

export default defineHook({
  events: {
    "session.started": async (_event, ctx) => {
      try {
        const access = resolveAccess(buildResolveRequest(ctx), loadBundles(), loadBindings());
        const policy = await compileNetworkPolicy(access, resolveHeaders);
        const hostCount =
          typeof policy === "string" ? 0 : Object.keys(policy.allow ?? {}).length;
        const summary =
          typeof policy === "string" ? policy : `allow ${hostCount} host(s), default-deny`;

        if (process.env.OE_EGRESS_ENFORCE === "1") {
          const sandbox = await ctx.getSandbox();
          await sandbox.setNetworkPolicy(policy);
          log(`enforced: ${summary} for ${access.scopeKey}`);
        } else {
          log(`dry-run (set OE_EGRESS_ENFORCE=1 to apply): ${summary} for ${access.scopeKey}`);
        }
      } catch (err) {
        log(`skipped: ${String(err)}`);
      }
    },
  },
});

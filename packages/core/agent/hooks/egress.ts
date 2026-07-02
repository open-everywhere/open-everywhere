import { defineHook } from "eve/hooks";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import { resolveAccessFor } from "../access/request.js";
import { compileNetworkPolicy } from "../access/egress.js";
import type { EffectiveAccess } from "../access/resolver.js";
import { resolveHeaders } from "../access/credentials.js";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom } from "../identity/binding.js";
import { appendAudit } from "../audit/audit.js";

function log(msg: string): void {
  console.log(`[open-everywhere:egress] ${msg}`);
}

export interface ResolvedEgressPolicy {
  readonly policy: SandboxNetworkPolicy;
  readonly scopeKey: string;
  readonly connectors: readonly string[];
  readonly compileError?: string;
}

export async function computeEgressPolicy(
  resolve: () => EffectiveAccess,
  compile: (access: EffectiveAccess) => Promise<SandboxNetworkPolicy>,
): Promise<ResolvedEgressPolicy> {
  try {
    const access = resolve();
    const policy = await compile(access);
    return { policy, scopeKey: access.scopeKey, connectors: access.connectors };
  } catch (err) {
    return { policy: "deny-all", scopeKey: "(unresolved)", connectors: [], compileError: String(err) };
  }
}

export default defineHook({
  events: {
    "session.started": async (_event, ctx) => {
      const { policy, scopeKey, connectors, compileError } = await computeEgressPolicy(
        () => resolveAccessFor(ctx),
        (access) => compileNetworkPolicy(access, resolveHeaders),
      );
      if (compileError) {
        log(`compile FAILED — applying deny-all (fail-closed): ${compileError}`);
      }

      const hostCount =
        typeof policy === "string" ? 0 : Object.keys(policy.allow ?? {}).length;
      const summary = compileError
        ? `deny-all (compile error)`
        : typeof policy === "string"
          ? policy
          : `allow ${hostCount} host(s), default-deny`;

      const wantEnforce = process.env.OE_EGRESS_ENFORCE !== "0";
      let enforced = false;
      if (wantEnforce || compileError) {
        try {
          const sandbox = await ctx.getSandbox();
          await sandbox.setNetworkPolicy(policy);
          enforced = true;
          log(`${wantEnforce ? "enforced" : "enforced (compile-error deny-all)"}: ${summary} for ${scopeKey}`);
        } catch (err) {
          log(`enforce FAILED (backend rejected setNetworkPolicy) — running UNENFORCED: ${String(err)}`);
        }
      } else {
        log(`dry-run (OE_EGRESS_ENFORCE=0): ${summary} for ${scopeKey}`);
      }

      try {
        const p = resolvePartition(ctx);
        const principalId = bindFrom(ctx).principalId;
        await appendAudit({
          org: p.org,
          platform: p.platform,
          workspace: p.workspace,
          surface: p.surface,
          principalId,
          action: "egress.policy",
          detail: { hosts: hostCount, enforced, scopeKey, summary, ...(compileError ? { error: compileError } : {}) },
        });

        await appendAudit({
          org: p.org,
          platform: p.platform,
          workspace: p.workspace,
          surface: p.surface,
          principalId,
          action: "connector.grant",
          detail: { connectors, scopeKey },
        });
      } catch (err) {
        log(`audit skipped (policy still applied): ${String(err)}`);
      }
    },
  },
});

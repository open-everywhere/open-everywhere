import { createHash } from "node:crypto";
import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import { resolveAccessFor } from "../access/request.js";
import { compileNetworkPolicy, openWriteHosts, writeHostsAuditFields } from "../access/egress.js";
import type { EffectiveAccess, ReachableHost } from "../access/resolver.js";
import { resolveHeaders } from "../access/credentials.js";
import { getConfig } from "../access/config.js";
import { resolveNetworkAccessLevel } from "../access/network-access.js";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { narrowByConnectorOverride } from "../access/connector-scope.js";
import { setConnectorContentOrigin, type ConnectorContentOriginMap } from "../access/connector-content-origin-state.js";
import { appendAudit, type AuditInput } from "../audit/audit.js";
import { stampEnforcement } from "../access/enforcement.js";
import { useSelfHostEgress, pushEgressPolicy } from "../access/self-host-egress.js";
import {
  publishEgressStatus,
  readPublishedEgressFingerprint,
  type EgressEnforcementState,
  type EgressStatusInput,
} from "../access/egress-status.js";
import { rememberEgressAttribution, type EgressAttribution } from "../access/egress-denial-poller.js";
import { getSettings } from "../settings/settings.js";

function log(msg: string): void {
  console.log(`[open-everywhere:egress] ${msg}`);
}

export interface ResolvedEgressPolicy {
  readonly policy: SandboxNetworkPolicy;
  readonly scopeKey: string;
  readonly connectors: readonly string[];
  readonly connectorContentOrigin: ConnectorContentOriginMap;
  readonly reachableHosts: readonly ReachableHost[];
  readonly compileError?: string;
}

export async function computeEgressPolicy(
  resolve: () => EffectiveAccess,
  compile: (access: EffectiveAccess) => Promise<SandboxNetworkPolicy>,
): Promise<ResolvedEgressPolicy> {
  try {
    const access = resolve();
    const policy = await compile(access);
    return {
      policy,
      scopeKey: access.scopeKey,
      connectors: access.connectors,
      connectorContentOrigin: access.connectorContentOrigin,
      reachableHosts: access.reachableHosts,
    };
  } catch (err) {
    return {
      policy: "deny-all",
      scopeKey: "(unresolved)",
      connectors: [],
      connectorContentOrigin: {},
      reachableHosts: [],
      compileError: String(err),
    };
  }
}

export interface AppliedEgressPolicy {
  readonly enforced: boolean;
  readonly enforceError?: string;
}

export async function applyEgressPolicy(
  apply: () => Promise<unknown>,
  allowUnenforced: boolean,
): Promise<AppliedEgressPolicy> {
  try {
    await apply();
    return { enforced: true };
  } catch (err) {
    if (allowUnenforced) return { enforced: false, enforceError: String(err) };
    throw new Error(
      `egress enforcement failed — aborting the session rather than running on Eve's allow-all default ` +
        `(set egress.allowUnenforced: true to warn-and-continue in dev): ${String(err)}`,
    );
  }
}

export type EgressPhase = "session.started" | "turn.started";

export function egressPolicyFingerprint(policy: SandboxNetworkPolicy, compileError?: string): string {
  return createHash("sha256")
    .update(compileError ? "compile-error " : "ok ")
    .update(JSON.stringify(policy))
    .digest("hex");
}

export type EgressApplyReason = "first-apply" | "policy-changed" | "retry-after-failure" | "unchanged";

export function planEgressApply(input: {
  readonly phase: EgressPhase;
  readonly fingerprint: string;
  readonly lastApplied: string | undefined;
}): { readonly reapply: boolean; readonly reason: EgressApplyReason } {
  if (input.phase === "session.started") return { reapply: true, reason: "first-apply" };
  if (input.lastApplied === undefined) return { reapply: true, reason: "retry-after-failure" };
  if (input.lastApplied !== input.fingerprint) return { reapply: true, reason: "policy-changed" };
  return { reapply: false, reason: "unchanged" };
}

export interface EgressAuditScope {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly principalId: string | undefined;
}

export interface EgressEnforcementDeps {
  readonly resolve: () => EffectiveAccess;
  readonly compile: (access: EffectiveAccess) => Promise<SandboxNetworkPolicy>;
  readonly apply: (policy: SandboxNetworkPolicy, scopeKey: string) => Promise<void>;
  readonly lastApplied: () => string | undefined;
  readonly rememberApplied: (fingerprint: string) => void;
  readonly lastConnectors: () => string | undefined;
  readonly rememberConnectors: (key: string) => void;
  readonly scope: () => EgressAuditScope;
  readonly audit?: (entry: AuditInput) => Promise<void>;
  readonly stamp?: (enforced: boolean) => void;
  readonly publish?: (input: EgressStatusInput) => Promise<void>;
  readonly rememberScope?: (input: EgressAttribution) => void;
  readonly parentPublishedFingerprint?: () => Promise<string | undefined>;
  readonly stampConnectorContentOrigin?: (declared: ConnectorContentOriginMap) => void;
}

export interface EgressEnforcementResult {
  readonly phase: EgressPhase;
  readonly applied: boolean;
  readonly reason: EgressApplyReason;
  readonly enforced?: boolean;
  readonly fingerprint: string;
  readonly compileError?: string;
  readonly enforceError?: string;
  readonly abortError?: Error;
}

export async function enforceEgress(phase: EgressPhase, deps: EgressEnforcementDeps): Promise<EgressEnforcementResult> {
  const audit = deps.audit ?? appendAudit;

  const { policy, scopeKey, connectors, connectorContentOrigin, reachableHosts, compileError } = await computeEgressPolicy(
    deps.resolve,
    deps.compile,
  );

  (deps.stampConnectorContentOrigin ?? setConnectorContentOrigin)(connectorContentOrigin);

  if (compileError) {
    log(`compile FAILED — applying deny-all (fail-closed): ${compileError}`);
  }

  const hostCount = typeof policy === "string" ? 0 : Object.keys(policy.allow ?? {}).length;
  const writeHosts = openWriteHosts(policy, reachableHosts);
  const summary = compileError
    ? `deny-all (compile error)`
    : typeof policy === "string"
      ? policy
      : `allow ${hostCount} host(s), default-deny`;

  const fingerprint = egressPolicyFingerprint(policy, compileError);

  if (deps.parentPublishedFingerprint) {
    let parentFingerprint: string | undefined;
    try {
      parentFingerprint = await deps.parentPublishedFingerprint();
    } catch (err) {
      log(`subagent child: parent egress fingerprint unreadable, invariant not asserted this pass: ${String(err)}`);
    }
    if (parentFingerprint !== undefined && parentFingerprint !== fingerprint) {
      const failure = new Error(
        `egress identical-binding invariant VIOLATED: this subagent child compiled policy ${fingerprint} ` +
          `(${summary}, bound to ${scopeKey}) while its parent published ${parentFingerprint} into the sandbox ` +
          `they share. A native child binds to its parent's identity (identity/binding.ts channelPlatform's ` +
          `subagent origin-hop), so the two policies must be byte-identical; a divergence means the child would ` +
          `REPLACE its parent's live firewall. Failing the child rather than applying.`,
      );
      log(failure.message);
      try {
        const s = deps.scope();
        await audit({
          org: s.org,
          platform: s.platform,
          workspace: s.workspace,
          surface: s.surface,
          principalId: s.principalId,
          action: "egress.policy",
          detail: {
            phase,
            reason: "subagent-binding-divergence",
            policyFingerprint: fingerprint,
            parentPolicyFingerprint: parentFingerprint,
            scopeKey,
            hosts: hostCount,
            summary,
            ...writeHostsAuditFields(writeHosts),
            aborted: true,
          },
        });
      } catch (err) {
        log(`subagent divergence audit skipped (the child is still being failed): ${String(err)}`);
      }
      return { phase, applied: false, reason: "policy-changed", fingerprint, abortError: failure };
    }
  }

  const { reapply, reason } = planEgressApply({ phase, fingerprint, lastApplied: deps.lastApplied() });

  const { enforce: wantEnforce, allowUnenforced } = getSettings().egress;
  let applied = false;
  let enforced = false;
  let enforceError: string | undefined;
  let abortError: Error | undefined;
  let publishState: EgressEnforcementState | null = null;

  if (!reapply) {
    return { phase, applied: false, reason, fingerprint, ...(compileError ? { compileError } : {}) };
  }

  if (wantEnforce || compileError) {
    applied = true;
    try {
      const result = await applyEgressPolicy(() => deps.apply(policy, scopeKey), allowUnenforced);
      enforced = result.enforced;
      enforceError = result.enforceError;
      if (enforced) {
        deps.rememberApplied(fingerprint);
        publishState = "enforced";
        log(
          `${wantEnforce ? "enforced" : "enforced (compile-error deny-all)"} [${phase} · ${reason}]: ${summary} for ${scopeKey}`,
        );
      } else {
        publishState = "unenforced";
        log(`enforce FAILED (backend rejected setNetworkPolicy) — running UNENFORCED (egress.allowUnenforced: true): ${enforceError}`);
      }
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      enforceError = failure.message;
      if (phase === "session.started") {
        abortError = failure;
        log(`enforce FAILED — aborting session (fail-closed): ${failure.message}`);
      } else {
        log(`turn re-apply FAILED — the previously-applied policy stays in force: ${failure.message}`);
      }
    }
  } else {
    deps.rememberApplied(fingerprint);
    publishState = "dry-run";
    log(`dry-run (egress.enforce: false) [${phase} · ${reason}]: ${summary} for ${scopeKey}`);
  }

  if (publishState !== null && deps.publish) {
    try {
      await deps.publish({ policy, state: publishState, fingerprint, compileError: compileError !== undefined });
    } catch (err) {
      log(`egress status file skipped (the policy itself is unaffected): ${String(err)}`);
    }
  }

  if (publishState !== null && deps.rememberScope) {
    try {
      const s = deps.scope();
      deps.rememberScope({
        org: s.org,
        platform: s.platform,
        workspace: s.workspace,
        surface: s.surface,
        policyFingerprint: fingerprint,
      });
    } catch (err) {
      log(`egress denial attribution not updated (the policy itself is unaffected): ${String(err)}`);
    }
  }

  try {
    const scope = deps.scope();
    await audit({
      org: scope.org,
      platform: scope.platform,
      workspace: scope.workspace,
      surface: scope.surface,
      principalId: scope.principalId,
      action: "egress.policy",
      detail: {
        hosts: hostCount,
        enforced,
        scopeKey,
        summary,
        phase,
        reason,
        policyFingerprint: fingerprint,
        ...writeHostsAuditFields(writeHosts),
        ...(compileError ? { error: compileError } : {}),
        ...(enforceError ? { enforceError } : {}),
        ...(abortError ? { aborted: true } : {}),
        ...(enforceError && phase === "turn.started" ? { reapplyFailed: true } : {}),
      },
    });

    const connectorKey = connectors.join(",");
    if (phase === "session.started" || deps.lastConnectors() !== connectorKey) {
      deps.rememberConnectors(connectorKey);
      const undeclared = connectors.filter((c) => connectorContentOrigin[c] === undefined);
      await audit({
        org: scope.org,
        platform: scope.platform,
        workspace: scope.workspace,
        surface: scope.surface,
        principalId: scope.principalId,
        action: "connector.grant",
        detail: { connectors, scopeKey, phase, ...(undeclared.length > 0 ? { undeclaredContentOrigin: undeclared } : {}) },
      });
    }
  } catch (err) {
    log(`audit skipped (policy still applied): ${String(err)}`);
  }

  if (phase === "session.started" || enforced) (deps.stamp ?? stampEnforcement)(enforced);

  return {
    phase,
    applied,
    reason,
    enforced,
    fingerprint,
    ...(compileError ? { compileError } : {}),
    ...(enforceError ? { enforceError } : {}),
    ...(abortError ? { abortError } : {}),
  };
}

const egressApplied = defineState<{ fingerprint?: string; connectors?: string }>(
  "open-everywhere.egress.applied",
  () => ({}),
);

function liveDeps(ctx: HookContext): EgressEnforcementDeps {
  return {
    resolve: () => resolveAccessFor(ctx),
    compile: (access) =>
      compileNetworkPolicy(
        access,
        resolveHeaders,
        (ids) => narrowByConnectorOverride(ctx, ids),
        resolveNetworkAccessLevel(access, getConfig().loadNetworkAccess?.() ?? []),
      ),
    apply: async (policy, scopeKey) => {
      if (useSelfHostEgress()) {
        await pushEgressPolicy(policy, { sessionId: scopeKey });
      } else {
        const sandbox = await ctx.getSandbox();
        await sandbox.setNetworkPolicy(policy);
      }
    },
    publish: async (input) => publishEgressStatus(await ctx.getSandbox(), input),
    ...(isSubagentChildContext(ctx as unknown as BindableContext)
      ? { parentPublishedFingerprint: async () => readPublishedEgressFingerprint(await ctx.getSandbox()) }
      : {}),
    rememberScope: rememberEgressAttribution,
    lastApplied: () => egressApplied.get().fingerprint,
    rememberApplied: (fingerprint) => egressApplied.update((s) => ({ ...s, fingerprint })),
    lastConnectors: () => egressApplied.get().connectors,
    rememberConnectors: (connectors) => egressApplied.update((s) => ({ ...s, connectors })),
    scope: () => {
      const p = resolvePartition(ctx);
      return {
        org: p.org,
        platform: p.platform,
        workspace: p.workspace,
        surface: p.surface,
        principalId: bindFrom(ctx).principalId,
      };
    },
  };
}

export default defineHook({
  events: {
    "session.started": async (_event, ctx) => {
      const result = await enforceEgress("session.started", liveDeps(ctx));
      if (result.abortError) throw result.abortError;
    },

    "turn.started": async (_event, ctx) => {
      try {
        const result = await enforceEgress("turn.started", liveDeps(ctx));
        if (result.abortError) throw result.abortError;
      } catch (err) {
        if (err instanceof Error && err.message.includes("identical-binding invariant VIOLATED")) throw err;
        log(`turn.started re-apply skipped (session-start policy still in force): ${String(err)}`);
      }
    },
  },
});

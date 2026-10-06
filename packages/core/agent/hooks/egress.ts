import { createHash, createHmac, randomBytes } from "node:crypto";
import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import { resolveAccessFor } from "../access/request.js";
import { noteOwnAccountRouteRefusal } from "../connections/own-account-gate.js";
import { rememberWorkStop } from "../channels/work-stop-note.js";
import { compileNetworkPolicy, openWriteHosts, writeHostsAuditFields } from "../access/egress.js";
import { noteStandingWriteGrants } from "../channels/standing-authority.js";
import { browserEgressHosts } from "../access/browser-hosts.js";
import type { EffectiveAccess, ReachableHost } from "../access/resolver.js";
import { resolveHeaders } from "../access/credentials.js";
import { credentialKeyArmed, deriveCredentialSubkey } from "../credentials/db-broker.js";
import { getConfig } from "../access/config.js";
import { resolveNetworkAccessLevel } from "../access/network-access.js";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { narrowByConnectorOverride } from "../access/connector-scope.js";
import { setConnectorContentOrigin, type ConnectorContentOriginMap } from "../access/connector-content-origin-state.js";
import { appendAudit, type AuditInput } from "../audit/audit.js";
import { stampEnforcement } from "../access/enforcement.js";
import { stampHalted } from "../access/halt-state.js";
import { WakeSlotWriteError } from "../access/wake-slot.js";
import { haltScopeFor, resolveHalt } from "../access/halt.js";
import { applySessionNetworkPolicy, type NetworkPolicyContext } from "../sandbox/network-policy.js";
import { useSelfHostEgress, pushEgressPolicy } from "../access/self-host-egress.js";
import {
  publishEgressStatus,
  readPublishedEgressFingerprint,
  type EgressEnforcementState,
  type EgressStatusInput,
} from "../access/egress-status.js";
import { rememberEgressAttribution, type EgressAttribution } from "../access/egress-denial-poller.js";
import { getSettings } from "../settings/settings.js";
import { DelegatedTaskBindingUnavailableError, ensureDelegatedTaskBinding } from "../channels/task-wake.js";
import { refuseTurn, type RefusableContext } from "./control-refusal.js";

function log(msg: string): void {
  console.log(`[open-everywhere:egress] ${msg}`);
}

export class EgressBindingDivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressBindingDivergenceError";
  }
}

export class EgressReapplyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressReapplyRefusedError";
  }
}

export type EgressPolicyShape =
  | "allow-all"
  | "deny-all"
  | { readonly hosts: Readonly<Record<string, string>>; readonly subnets: string; readonly key: string };

export const EGRESS_STATE_DIGEST_LABEL = "egress-state-digest";

export interface EgressStateDigestKey {
  readonly key: Buffer;
  readonly id: string;
  readonly durable: boolean;
}

const processDigestKey = randomBytes(32);

function digestKeyId(key: Buffer): string {
  return createHmac("sha256", key).update(`${EGRESS_STATE_DIGEST_LABEL} key-id`).digest("hex").slice(0, 16);
}

export function egressStateDigestKey(): EgressStateDigestKey {
  if (credentialKeyArmed()) {
    const key = deriveCredentialSubkey(EGRESS_STATE_DIGEST_LABEL);
    return { key, id: digestKeyId(key), durable: true };
  }
  return { key: processDigestKey, id: `process:${digestKeyId(processDigestKey)}`, durable: false };
}

export function egressPolicyShape(policy: SandboxNetworkPolicy, digestKey: EgressStateDigestKey = egressStateDigestKey()): EgressPolicyShape {
  if (policy === "allow-all" || policy === "deny-all") return policy;
  const digest = (value: unknown): string => createHmac("sha256", digestKey.key).update(JSON.stringify(value ?? null)).digest("hex");
  const hosts: Record<string, string> = {};
  const allow = policy.allow ?? {};
  if (Array.isArray(allow)) {
    for (const host of allow) hosts[host] = digest([]);
  } else {
    for (const [host, rules] of Object.entries(allow)) hosts[host] = digest(rules);
  }
  return { hosts, subnets: digest(policy.subnets), key: digestKey.id };
}

export const NEVER_ENFORCED = "never-enforced" as const;
export type EgressEnforcedRecord = EgressPolicyShape | typeof NEVER_ENFORCED;

export function egressPolicyCovers(inForce: EgressEnforcedRecord | undefined, next: EgressPolicyShape): boolean {
  if (inForce === undefined || inForce === NEVER_ENFORCED) return false;
  if (inForce === "deny-all") return true;
  if (next === "allow-all") return true;
  if (inForce === "allow-all" || next === "deny-all") return false;
  if (inForce.key !== next.key) return false;
  if (inForce.subnets !== next.subnets) return false;
  return Object.entries(inForce.hosts).every(([host, rules]) => next.hosts[host] === rules);
}

export function egressDigestKeyRotated(record: EgressEnforcedRecord | undefined, current: EgressStateDigestKey): boolean {
  if (!current.durable || record === undefined || typeof record === "string") return false;
  return record.key !== current.id;
}

export interface ResolvedEgressPolicy {
  readonly policy: SandboxNetworkPolicy;
  readonly scopeKey: string;
  readonly connectors: readonly string[];
  readonly connectorContentOrigin: ConnectorContentOriginMap;
  readonly reachableHosts: readonly ReachableHost[];
  readonly compileError?: string;
  readonly halted?: true;
  readonly ownAccountEgressRefusals: readonly { readonly connector: string; readonly viaConnection: string }[];
}

export async function computeEgressPolicy(
  resolve: () => EffectiveAccess,
  compile: (access: EffectiveAccess) => Promise<SandboxNetworkPolicy>,
  halted?: () => Promise<boolean>,
): Promise<ResolvedEgressPolicy> {
  try {
    const access = resolve();
    if (halted !== undefined && (await halted())) {
      return { policy: "deny-all", scopeKey: access.scopeKey, connectors: [], connectorContentOrigin: {}, reachableHosts: [], halted: true, ownAccountEgressRefusals: access.ownAccountEgressRefusals ?? [] };
    }
    const policy = await compile(access);
    return {
      policy,
      scopeKey: access.scopeKey,
      connectors: access.connectors,
      connectorContentOrigin: access.connectorContentOrigin,
      reachableHosts: access.reachableHosts,
      ownAccountEgressRefusals: access.ownAccountEgressRefusals ?? [],
    };
  } catch (err) {
    return {
      policy: "deny-all",
      scopeKey: "(unresolved)",
      connectors: [],
      connectorContentOrigin: {},
      reachableHosts: [],
      compileError: String(err),
      ownAccountEgressRefusals: [],
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
      { cause: err },
    );
  }
}

export type EgressPhase = "session.started" | "turn.started";

export type EgressAbortReason = "subagent-binding-divergence" | "enforce-failed" | "unenforced-no-policy-in-force" | "reapply-narrows-policy-in-force";

export function egressPolicyFingerprint(policy: SandboxNetworkPolicy, compileError?: string): string {
  return createHash("sha256")
    .update(compileError ? "compile-error " : "ok ")
    .update(JSON.stringify(policy))
    .digest("hex");
}

export type EgressApplyReason = "first-apply" | "policy-changed" | "retry-after-failure" | "digest-key-rotated" | "unchanged";

export function planEgressApply(input: {
  readonly phase: EgressPhase;
  readonly fingerprint: string;
  readonly lastApplied: string | undefined;
  readonly digestKeyRotated?: boolean;
}): { readonly reapply: boolean; readonly reason: EgressApplyReason } {
  if (input.phase === "session.started") return { reapply: true, reason: "first-apply" };
  if (input.lastApplied === undefined) return { reapply: true, reason: "retry-after-failure" };
  if (input.lastApplied !== input.fingerprint) return { reapply: true, reason: "policy-changed" };
  if (input.digestKeyRotated === true) return { reapply: true, reason: "digest-key-rotated" };
  return { reapply: false, reason: "unchanged" };
}

interface EgressAppliedRecorder {
  readonly rememberApplied: (fingerprint: string) => void;
  readonly rememberEnforcedShape?: (shape: EgressEnforcedRecord) => void;
}

function recordEnforcedEgressPolicy(recorder: EgressAppliedRecorder, policy: SandboxNetworkPolicy, fingerprint: string): void {
  recorder.rememberApplied(fingerprint);
  recorder.rememberEnforcedShape?.(egressPolicyShape(policy));
}

async function sendEgressPolicy(policy: SandboxNetworkPolicy, ctx: NetworkPolicyContext, sessionId: string | undefined): Promise<void> {
  if (useSelfHostEgress()) {
    await pushEgressPolicy(policy, sessionId !== undefined ? { sessionId } : undefined);
  } else {
    await applySessionNetworkPolicy(ctx, policy);
  }
}

export async function applyAndRecordEgressPolicy(
  policy: SandboxNetworkPolicy,
  opts: {
    readonly ctx: NetworkPolicyContext;
    readonly sessionId?: string;
  },
): Promise<void> {
  await sendEgressPolicy(policy, opts.ctx, opts.sessionId);
  recordEnforcedEgressPolicy(liveEgressRecorder, policy, egressPolicyFingerprint(policy));
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
  readonly lastEnforcedShape?: () => EgressEnforcedRecord | undefined;
  readonly rememberEnforcedShape?: (shape: EgressEnforcedRecord) => void;
  readonly lastConnectors: () => string | undefined;
  readonly rememberConnectors: (key: string) => void;
  readonly scope: () => EgressAuditScope;
  readonly halted?: () => Promise<boolean>;
  readonly stampHalted?: (halted: boolean) => void;
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
  readonly abortReason?: EgressAbortReason;
  readonly ownAccountEgressRefusals: readonly { readonly connector: string; readonly viaConnection: string }[];
}

function narrowingRefusal(
  deps: EgressEnforcementDeps,
  policy: SandboxNetworkPolicy,
  reason: EgressApplyReason,
  cause: string | undefined,
): EgressReapplyRefusedError | undefined {
  if (reason === "digest-key-rotated") return undefined;
  if (egressPolicyCovers(deps.lastEnforcedShape?.(), egressPolicyShape(policy))) return undefined;
  const refusal = new EgressReapplyRefusedError(
    `egress re-apply FAILED and this turn is refused (fail-closed): the firewall still holds an earlier policy that ` +
      `may open hosts or credentials the current access config no longer grants, so running the turn could use access ` +
      `that was taken away. In a conversation session the next turn retries the apply; a task-mode session ends here. ` +
      `Cause: ${cause ?? "unknown"}`,
  );
  log(refusal.message);
  return refusal;
}

export async function enforceEgress(phase: EgressPhase, deps: EgressEnforcementDeps): Promise<EgressEnforcementResult> {
  const audit = deps.audit ?? appendAudit;

  const { policy, scopeKey, connectors, connectorContentOrigin, reachableHosts, compileError, halted, ownAccountEgressRefusals } = await computeEgressPolicy(
    deps.resolve,
    deps.compile,
    deps.halted,
  );

  if (deps.halted !== undefined) (deps.stampHalted ?? stampHalted)(halted === true || compileError !== undefined);

  (deps.stampConnectorContentOrigin ?? setConnectorContentOrigin)(connectorContentOrigin);

  if (compileError) {
    log(`compile FAILED — applying deny-all (fail-closed): ${compileError}`);
  }
  if (halted) {
    log(`break-glass HALT in force — applying deny-all (lift it with resume)`);
  }

  const hostCount = typeof policy === "string" ? 0 : Object.keys(policy.allow ?? {}).length;
  const writeHosts = openWriteHosts(policy, reachableHosts, browserEgressHosts());
  const summary = compileError
    ? `deny-all (compile error)`
    : halted
      ? `deny-all (break-glass halt)`
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
      const failure = new EgressBindingDivergenceError(
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
            ...(ownAccountEgressRefusals.length > 0
              ? { ownAccountConnector: ownAccountEgressRefusals[0]!.connector, ownAccountWithheld: true }
              : {}),
            aborted: true,
          },
        });
      } catch (err) {
        log(`subagent divergence audit skipped (the child is still being failed): ${String(err)}`);
      }
      return { phase, applied: false, reason: "policy-changed", fingerprint, abortError: failure, abortReason: "subagent-binding-divergence", ownAccountEgressRefusals };
    }
  }

  noteStandingWriteGrants(writeHosts);

  const { enforce: wantEnforce, allowUnenforced } = getSettings().egress;

  const { reapply, reason } = planEgressApply({
    phase,
    fingerprint,
    lastApplied: deps.lastApplied(),
    digestKeyRotated: wantEnforce && egressDigestKeyRotated(deps.lastEnforcedShape?.(), egressStateDigestKey()),
  });
  let applied = false;
  let enforced = false;
  let enforceError: string | undefined;
  let abortError: Error | undefined;
  let abortReason: EgressAbortReason | undefined;
  let publishState: EgressEnforcementState | null = null;

  if (!reapply) {
    return { phase, applied: false, reason, fingerprint, ownAccountEgressRefusals, ...(compileError ? { compileError } : {}) };
  }

  if (wantEnforce || compileError) {
    applied = true;
    try {
      const result = await applyEgressPolicy(() => deps.apply(policy, scopeKey), allowUnenforced);
      enforced = result.enforced;
      enforceError = result.enforceError;
      if (enforced) {
        recordEnforcedEgressPolicy(deps, policy, fingerprint);
        publishState = "enforced";
        log(
          `${wantEnforce ? "enforced" : "enforced (compile-error deny-all)"} [${phase} · ${reason}]: ${summary} for ${scopeKey}`,
        );
      } else {
        publishState = "unenforced";
        log(`enforce FAILED (backend rejected setNetworkPolicy) — running UNENFORCED (egress.allowUnenforced: true): ${enforceError}`);
        if (phase === "session.started") {
          deps.rememberEnforcedShape?.(NEVER_ENFORCED);
        } else {
          const record = deps.lastEnforcedShape?.();
          if (record !== undefined && record !== NEVER_ENFORCED) {
            abortError = narrowingRefusal(deps, policy, reason, enforceError);
            if (abortError !== undefined) abortReason = "reapply-narrows-policy-in-force";
          }
        }
      }
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      enforceError = failure.message;
      const nothingInForce = deps.lastApplied() === undefined;
      if (phase === "session.started") {
        abortError = failure;
        abortReason = "enforce-failed";
        log(`enforce FAILED — refusing the turn (fail-closed): ${failure.message}`);
      } else if (nothingInForce) {
        abortError = failure;
        abortReason = "unenforced-no-policy-in-force";
        log(`turn re-apply FAILED and NO policy is in force — refusing the turn (fail-closed): ${failure.message}`);
      } else {
        abortError = narrowingRefusal(deps, policy, reason, failure.cause !== undefined ? String(failure.cause) : failure.message);
        if (abortError !== undefined) abortReason = "reapply-narrows-policy-in-force";
        else log(`turn re-apply FAILED — the previously-applied policy stays in force, and the new policy covers it (staleness only): ${failure.message}`);
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
    ownAccountEgressRefusals,
    ...(compileError ? { compileError } : {}),
    ...(enforceError ? { enforceError } : {}),
    ...(abortError ? { abortError } : {}),
    ...(abortReason ? { abortReason } : {}),
  };
}

const egressApplied = defineState<{ fingerprint?: string; connectors?: string; enforcedShape?: EgressEnforcedRecord }>(
  "open-everywhere.egress.applied",
  () => ({}),
);

const liveEgressRecorder: Required<EgressAppliedRecorder> = {
  rememberApplied: (fingerprint) => egressApplied.update((s) => ({ ...s, fingerprint })),
  rememberEnforcedShape: (enforcedShape) => egressApplied.update((s) => ({ ...s, enforcedShape })),
};

export function readEgressAppliedRecord(): { readonly fingerprint?: string; readonly enforcedShape?: EgressEnforcedRecord } {
  const { fingerprint, enforcedShape } = egressApplied.get();
  return { ...(fingerprint !== undefined ? { fingerprint } : {}), ...(enforcedShape !== undefined ? { enforcedShape } : {}) };
}

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
    apply: (policy, scopeKey) => sendEgressPolicy(policy, ctx, scopeKey),
    publish: async (input) => publishEgressStatus(await ctx.getSandbox(), input),
    ...(isSubagentChildContext(ctx as unknown as BindableContext)
      ? { parentPublishedFingerprint: async () => readPublishedEgressFingerprint(await ctx.getSandbox()) }
      : {}),
    rememberScope: rememberEgressAttribution,
    lastApplied: () => egressApplied.get().fingerprint,
    rememberApplied: liveEgressRecorder.rememberApplied,
    lastEnforcedShape: () => egressApplied.get().enforcedShape,
    rememberEnforcedShape: liveEgressRecorder.rememberEnforcedShape,
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
    halted: async () => {
      try {
        const p = resolvePartition(ctx);
        return (await resolveHalt(haltScopeFor({ org: p.org, scopeKey: p.surfaceKey, ...(bindFrom(ctx).principalId ? { principalId: bindFrom(ctx).principalId } : {}) }))).halted;
      } catch {
        return true;
      }
    },
  };
}

function noteOwnAccountWithheld(ctx: HookContext, result: EgressEnforcementResult): void {
  try {
    void noteOwnAccountRouteRefusal(ctx as unknown as BindableContext, result.ownAccountEgressRefusals).catch(() => undefined);
  } catch (err) {
    log(`own-account acting-identity row skipped (the withholding itself is unaffected): ${String(err)}`);
  }
}

function workerStoppedClause(connector: string): string {
  return (
    `(The delegated worker was stopped before it read anything: its seat's firewall still carries the shared ` +
    `${connector} integration, and one session holds one credential per host, so the worker may not narrow it. ` +
    `The worker read nothing. Say the refusal above in the room — do not retry the delegation.)`
  );
}

async function ownAccountAbortError(ctx: HookContext, result: EgressEnforcementResult, phase: "session.started" | "turn.started"): Promise<Error> {
  const fallback = result.abortError ?? new Error("egress enforcement aborted");
  const refusals = result.ownAccountEgressRefusals ?? [];
  const connector = refusals[0]?.connector;
  if (connector === undefined || !(result.abortError instanceof EgressBindingDivergenceError)) {
    noteOwnAccountWithheld(ctx, result);
    return fallback;
  }
  try {
    const verdict = await noteOwnAccountRouteRefusal(ctx as unknown as BindableContext, refusals);
    if (verdict?.refusal === undefined) return fallback;
    await rememberWorkStop(ctx as unknown as BindableContext, { connector, refusal: verdict.refusal }, phase).catch((err: unknown) => {
      log(`own-account stop note not recorded (the worker is still stopped): ${String(err)}`);
    });
    return new EgressBindingDivergenceError(`${verdict.refusal}\n${workerStoppedClause(connector)}`);
  } catch (err) {
    log(`own-account refusal sentence unavailable, failing the worker with the invariant message instead: ${String(err)}`);
    return fallback;
  }
}

const TURN_EDGE_ABORTS: readonly (readonly [new (...args: never[]) => Error, string])[] = [
  [DelegatedTaskBindingUnavailableError, "delegated-binding-unavailable"],
  [EgressBindingDivergenceError, "subagent-binding-divergence"],
  [EgressReapplyRefusedError, "reapply-narrows-policy-in-force"],
  [WakeSlotWriteError, "wake-slot-write-failed"],
];

function turnEdgeAbortReason(err: unknown): string | undefined {
  return TURN_EDGE_ABORTS.find(([type]) => err instanceof type)?.[1];
}

export function isTurnEdgeAbort(err: unknown): boolean {
  return turnEdgeAbortReason(err) !== undefined;
}

export interface TurnEdgeRefusal {
  readonly reason: string;
  readonly message: string;
}

export function handleTurnEdgeFailure(err: unknown, inForce: boolean): TurnEdgeRefusal | undefined {
  const typed = turnEdgeAbortReason(err);
  if (typed !== undefined) return { reason: typed, message: err instanceof Error ? err.message : String(err) };
  if (!inForce) {
    return {
      reason: "unenforced-no-policy-in-force",
      message: `egress re-apply failed and NO policy is in force, so this turn would run on eve's allow-all default: ${String(err)}`,
    };
  }
  log(`turn.started re-apply skipped (the previously-applied policy stays in force): ${String(err)}`);
  return undefined;
}

export default defineHook({
  events: {
    "session.started": async (_event, ctx) => {
      try {
        await ensureDelegatedTaskBinding(ctx as unknown as BindableContext);
        const result = await enforceEgress("session.started", liveDeps(ctx));
        if (result.abortError) {
          const failure = await ownAccountAbortError(ctx, result, "session.started");
          await refuseTurn(ctx as unknown as RefusableContext, {
            hook: "egress",
            phase: "session.started",
            reason: result.abortReason ?? "enforce-failed",
            message: failure.message,
            detail: { policyFingerprint: result.fingerprint },
          });
          return;
        }
        noteOwnAccountWithheld(ctx, result);
      } catch (err) {
        await refuseTurn(ctx as unknown as RefusableContext, {
          hook: "egress",
          phase: "session.started",
          reason: err instanceof DelegatedTaskBindingUnavailableError ? "delegated-binding-unavailable" : "enforce-failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },

    "turn.started": async (_event, ctx) => {
      let deps: EgressEnforcementDeps | undefined;
      try {
        deps = liveDeps(ctx);
        await ensureDelegatedTaskBinding(ctx as unknown as BindableContext);
        const result = await enforceEgress("turn.started", deps);
        if (result.abortError) {
          const failure = await ownAccountAbortError(ctx, result, "turn.started");
          await refuseTurn(ctx as unknown as RefusableContext, {
            hook: "egress",
            phase: "turn.started",
            reason: result.abortReason ?? "enforce-failed",
            message: failure.message,
            detail: { policyFingerprint: result.fingerprint },
          });
          return;
        }
        noteOwnAccountWithheld(ctx, result);
      } catch (err) {
        const inForce = ((): boolean => {
          try {
            return deps?.lastApplied() !== undefined;
          } catch {
            return false;
          }
        })();
        const refusal = handleTurnEdgeFailure(err, inForce);
        if (refusal !== undefined) await refuseTurn(ctx as unknown as RefusableContext, { hook: "egress", phase: "turn.started", ...refusal });
      }
    },
  },
});

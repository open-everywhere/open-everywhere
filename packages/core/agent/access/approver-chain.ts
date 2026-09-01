import { classifyConnectorOp, isConnectorOpTool, judgeDeferredTool, postTurnSurfaceFloors, TOOL_CONSEQUENCE, type ConsequenceEntry } from "./consequence.js";
import { awsCommandVerdict, type AwsScreenInput } from "./aws-screen.js";
import { untrustedIngestedThisTurn, taintKindsThisTurn } from "./taint-signal.js";
import { taintMode, type TaintMode } from "./taint-enforcement.js";
import {
  approvalJudgeAdminDisarmed,
  approvalJudgeMode,
  judgeContextOf,
  judgeVerdictCacheKey,
  JUDGE_ENFORCE_TIMEOUT_MS,
  runApprovalJudge,
  APPROVAL_JUDGE_ADMIN_DISARM,
  type ApprovalJudgeRun,
} from "./approval-judge.js";
import type { ResolvedPreApprovalRule } from "./pre-approval-rules.js";
import { getConfig } from "./config.js";
import { resolveAccess } from "./resolver.js";

export type ApproverVerdict = "allow" | "deny" | "ask" | undefined;

export type Approver = (req: ApprovalChainRequest) => ApproverVerdict | Promise<ApproverVerdict>;

export type AskVariant = "blocking" | "queued";

export type ApprovalModeName = "DANGEROUSLY_BYPASS" | "APPROVE_ALL" | "DENY_ALL";

export interface ApprovalModeConfig {
  readonly mode: ApprovalModeName;
  readonly allowlist?: readonly string[];
}

export interface ApprovalChainRequest {
  readonly tool: string;
  readonly action?: string;
  readonly args?: unknown;
  readonly scopeKey?: string;
  readonly domain?: string;
  readonly principalId?: string;
  readonly unattended: boolean;
  readonly tainted?: boolean;
  readonly mode?: ApprovalModeConfig;
  readonly aws?: AwsScreenInput;
  readonly connectorOpRaise?: "write" | "destructive";
  readonly beneficiaryClicker?: boolean;
}

export function chainTaintSignal(): boolean {
  return untrustedIngestedThisTurn();
}

export function chainTaintKinds(): readonly string[] {
  return taintKindsThisTurn();
}

function taintedOf(req: ApprovalChainRequest): boolean {
  return req.tainted ?? chainTaintSignal();
}

function taintModeNote(): { taintMode: TaintMode } | Record<string, never> {
  const mode = taintMode();
  return mode === "off" ? { taintMode: mode } : {};
}

export type ApproverLevel = "custom" | "surface" | "classifier" | "registry";

export const APPROVER_LEVEL_ORDER: readonly ApproverLevel[] = ["custom", "surface", "classifier", "registry"];

export type ElementClass = "operator" | "surface" | "classifier" | "registry" | "connector" | "remote";

export type ElementVerdict = "allow" | "deny" | "ask" | "defer";

export const ELEMENT_CLAMPS: Readonly<Record<ElementClass, readonly ElementVerdict[]>> = {
  operator: ["allow", "deny", "ask", "defer"],
  surface: ["allow", "deny", "ask", "defer"],
  classifier: ["allow", "deny", "ask", "defer"],
  registry: ["allow", "deny", "ask"],
  connector: ["deny", "ask", "defer"],
  remote: ["deny", "ask", "defer"],
};

export interface OperatorApprover {
  readonly name: string;
  readonly approve: Approver;
  readonly source?: "operator" | "connector" | "remote";
  readonly mayAllow?: boolean;
}

export interface ChainElementResult {
  readonly element: string;
  readonly level: ApproverLevel;
  readonly verdict: ElementVerdict;
  readonly clamped?: true;
  readonly error?: true;
}

export interface AppliedTransform {
  readonly name: string;
  readonly from: "allow" | "ask";
  readonly to: "allow" | "ask" | "deny";
  readonly reason?: string;
}

export interface ChainResolution {
  readonly verdict: "allow" | "deny" | "ask";
  readonly askVariant?: AskVariant;
  readonly resolvedBy: string;
  readonly registryVerdict: "allow" | "ask";
  readonly elements: readonly ChainElementResult[];
  readonly transforms: readonly AppliedTransform[];
  readonly tainted: boolean;
  readonly denyAbsolute?: true;
  readonly judge?: ApprovalJudgeRun;
}

export function registryVerdictOf(tool: string): "allow" | "ask" {
  if (isConnectorOpTool(tool)) return classifyConnectorOp(tool) === "open" ? "allow" : "ask";
  const row: ConsequenceEntry | undefined = TOOL_CONSEQUENCE[tool];
  if (row === undefined) return "ask";
  return row.tier === "open" ? "allow" : "ask";
}

export function taintToleranceOf(tool: string): "gate" | "disclose" | undefined {
  if (isConnectorOpTool(tool)) return classifyConnectorOp(tool) === "open" ? undefined : "disclose";
  return taintToleranceOfRow(TOOL_CONSEQUENCE[tool]);
}

export function taintToleranceOfRow(row: ConsequenceEntry | undefined): "gate" | "disclose" | undefined {
  if (row === undefined) return "gate";
  if (postTurnSurfaceFloors(row.postTurnSurface)) return "gate";
  if (row.taint !== undefined) return row.taint;
  return row.tier === "open" ? undefined : "gate";
}

export type TransformStage = "mode" | "unattended" | "taint" | "floor";

export const TRANSFORM_STAGE_ORDER: readonly TransformStage[] = ["mode", "taint", "floor", "unattended"];

export interface TransformRow {
  readonly name: string;
  readonly stage: TransformStage;
  readonly from: readonly ("allow" | "ask")[];
  readonly reason?: string;
  fires(req: ApprovalChainRequest): boolean;
  to(req: ApprovalChainRequest, registryVerdict: "allow" | "ask"): "allow" | "ask" | "deny";
}

export const TRANSFORM_TABLE: readonly TransformRow[] = [
  {
    name: "mode:DANGEROUSLY_BYPASS",
    stage: "mode",
    from: ["ask"],
    fires: (req) => req.mode?.mode === "DANGEROUSLY_BYPASS",
    to: () => "allow",
  },
  {
    name: "mode:APPROVE_ALL",
    stage: "mode",
    from: ["allow"],
    fires: (req) => req.mode?.mode === "APPROVE_ALL",
    to: (req, registryVerdict) => ((req.mode?.allowlist ?? []).includes(req.tool) ? registryVerdict : "ask"),
  },
  {
    name: "mode:DENY_ALL",
    stage: "mode",
    from: ["allow", "ask"],
    reason: "mode-deny-all",
    fires: (req) => req.mode?.mode === "DENY_ALL",
    to: () => "deny",
  },
  {
    name: "unattended",
    stage: "unattended",
    from: ["ask"],
    reason: "ask-unattended",
    fires: (req) => req.unattended,
    to: () => "deny",
  },
  {
    name: "taint:ask",
    stage: "taint",
    from: ["allow"],
    reason: "taint-ask",
    fires: (req) => taintedOf(req) && taintToleranceOf(req.tool) === "gate",
    to: () => "ask",
  },
  {
    name: "beneficiary-clicker-floor",
    stage: "floor",
    from: ["allow"],
    reason: "beneficiary-clicker",
    fires: (req) => req.beneficiaryClicker === true,
    to: (_req, registryVerdict) => registryVerdict,
  },
];

interface BuiltInElement {
  readonly name: string;
  readonly level: ApproverLevel;
  readonly clazz: ElementClass;
  evaluate(req: ApprovalChainRequest): ApproverVerdict | Promise<ApproverVerdict>;
}

const AWS_SURFACE_ELEMENT: BuiltInElement = {
  name: "aws-allow-list",
  level: "surface",
  clazz: "surface",
  evaluate: (req) => {
    if (req.aws === undefined) return undefined;
    return awsCommandVerdict(req.aws).ok ? undefined : "deny";
  },
};

const CONNECTOR_OPS_RAISE_ELEMENT: BuiltInElement = {
  name: "connector-ops-raise",
  level: "surface",
  clazz: "surface",
  evaluate: (req) => (req.connectorOpRaise !== undefined ? "ask" : undefined),
};

const VERB_CLASSIFIER_ELEMENT: BuiltInElement = {
  name: "verb-classifier",
  level: "classifier",
  clazz: "classifier",
  evaluate: (req) => {
    if (!isConnectorOpTool(req.tool)) return undefined;
    return classifyConnectorOp(req.tool) === "open" ? "allow" : "ask";
  },
};

const REGISTRY_ELEMENT: BuiltInElement = {
  name: "registry",
  level: "registry",
  clazz: "registry",
  evaluate: (req) => registryVerdictOf(req.tool),
};

const LEVEL_RANK: Readonly<Record<ApproverLevel, number>> = Object.fromEntries(
  APPROVER_LEVEL_ORDER.map((l, i) => [l, i]),
) as Record<ApproverLevel, number>;

function clampVerdict(
  raw: ApproverVerdict,
  clazz: ElementClass,
  mayAllow: boolean | undefined,
): { verdict: ElementVerdict; clamped?: true } {
  const verdict: ElementVerdict = raw === undefined ? "defer" : raw;
  const permitted = new Set<ElementVerdict>(ELEMENT_CLAMPS[clazz]);
  if (mayAllow === true && (clazz === "connector" || clazz === "remote")) permitted.add("allow");
  if (permitted.has(verdict)) return { verdict };
  return { verdict: "defer", clamped: true };
}

export interface ResolveChainOptions {
  readonly approvers?: readonly OperatorApprover[];
  readonly judge?: boolean;
  readonly rules?: readonly ResolvedPreApprovalRule[];
}

export async function resolveApproverChain(
  req: ApprovalChainRequest,
  opts: ResolveChainOptions = {},
): Promise<ChainResolution> {
  interface Evaluated extends ChainElementResult {
    readonly rank: number;
    readonly order: number;
  }
  const evaluated: Evaluated[] = [];

  const elements: readonly { name: string; level: ApproverLevel; clazz: ElementClass; mayAllow?: boolean; run: Approver }[] = [
    ...(opts.approvers ?? []).map((a) => ({
      name: `custom:${a.name}`,
      level: "custom" as const,
      clazz: (a.source === "connector" ? "connector" : a.source === "remote" ? "remote" : "operator") as ElementClass,
      mayAllow: a.mayAllow,
      run: a.approve,
    })),
    ...[AWS_SURFACE_ELEMENT, CONNECTOR_OPS_RAISE_ELEMENT, VERB_CLASSIFIER_ELEMENT, REGISTRY_ELEMENT].map((e) => ({
      name: e.name,
      level: e.level,
      clazz: e.clazz,
      run: (r: ApprovalChainRequest) => e.evaluate(r),
    })),
  ];

  let order = 0;
  for (const el of elements) {
    let raw: ApproverVerdict;
    let error: true | undefined;
    try {
      raw = await el.run(req);
    } catch {
      raw = "ask";
      error = true;
    }
    const { verdict, clamped } = error === undefined ? clampVerdict(raw, el.clazz, el.mayAllow) : { verdict: "ask" as ElementVerdict };
    evaluated.push({
      element: el.name,
      level: el.level,
      verdict,
      ...(clamped !== undefined ? { clamped } : {}),
      ...(error !== undefined ? { error } : {}),
      rank: LEVEL_RANK[el.level],
      order: order++,
    });
  }

  const results: ChainElementResult[] = evaluated.map(({ rank: _r, order: _o, ...rest }) => rest);
  const registryBaseline = registryVerdictOf(req.tool);

  const denies = evaluated.filter((e) => e.verdict === "deny").sort((a, b) => a.rank - b.rank || a.order - b.order);
  if (denies.length > 0) {
    return {
      verdict: "deny",
      resolvedBy: denies[0]!.element,
      registryVerdict: registryBaseline,
      elements: results,
      transforms: [],
      tainted: taintedOf(req),
      denyAbsolute: true,
    };
  }

  const positional = evaluated.filter((e) => e.verdict !== "defer").sort((a, b) => a.rank - b.rank || a.order - b.order);
  const first = positional[0];
  let verdict: "allow" | "ask" = first === undefined || first.verdict === "ask" ? "ask" : "allow";
  let resolvedBy = first?.element ?? "registry";

  let judgeRun: ApprovalJudgeRun | undefined;
  if (
    opts.judge === true &&
    verdict === "ask" &&
    (resolvedBy === "registry" || resolvedBy === "verb-classifier") &&
    judgeDeferredTool(req.tool) &&
    approvalJudgeMode() === "enforce"
  ) {
    if (await approvalJudgeAdminDisarmed(req.domain)) {
      judgeRun = {
        verdict: "defer",
        source: "admin-disarm",
        reasoning:
          req.domain === undefined
            ? `judge disarmed org-wide for domain-less actions by an operator (${APPROVAL_JUDGE_ADMIN_DISARM}) — re-arm with the control plane's rearm_approval_judge with orgWide: true`
            : `judge disarmed for this domain by an operator (${APPROVAL_JUDGE_ADMIN_DISARM}) — re-arm with the control plane's rearm_approval_judge`,
        cacheKey: judgeVerdictCacheKey(req.tool),
        cacheHit: false,
        passes: 0,
      };
    } else {
      judgeRun = await runApprovalJudge(judgeContextOf(req, { registryVerdict: registryBaseline }, opts.rules), {
        enforce: true,
        timeoutMs: JUDGE_ENFORCE_TIMEOUT_MS,
      });
      if (judgeRun.verdict === "deny") {
        return {
          verdict: "deny",
          resolvedBy: "judge",
          registryVerdict: registryBaseline,
          elements: results,
          transforms: [],
          tainted: taintedOf(req),
          denyAbsolute: true,
          judge: judgeRun,
        };
      }
      if (judgeRun.verdict === "allow") {
        verdict = "allow";
        resolvedBy = "judge";
      }
    }
  }

  const transforms: AppliedTransform[] = [];
  for (const stage of TRANSFORM_STAGE_ORDER) {
    for (const row of TRANSFORM_TABLE) {
      if (row.stage !== stage) continue;
      let firing = false;
      try {
        firing = row.fires(req);
      } catch {
        continue;
      }
      if (!firing || !(row.from as readonly string[]).includes(verdict)) continue;
      let next: "allow" | "ask" | "deny";
      try {
        next = row.to(req, registryBaseline);
      } catch {
        continue;
      }
      if (next === verdict) continue;
      transforms.push({ name: row.name, from: verdict, to: next, ...(row.reason !== undefined ? { reason: row.reason } : {}) });
      if (next === "deny") {
        return {
          verdict: "deny",
          resolvedBy,
          registryVerdict: registryBaseline,
          elements: results,
          transforms,
          tainted: taintedOf(req),
          ...(judgeRun !== undefined ? { judge: judgeRun } : {}),
        };
      }
      verdict = next;
    }
  }

  return {
    verdict,
    ...(verdict === "ask" ? { askVariant: "blocking" as AskVariant } : {}),
    resolvedBy,
    registryVerdict: registryBaseline,
    elements: results,
    transforms,
    tainted: taintedOf(req),
    ...(judgeRun !== undefined ? { judge: judgeRun } : {}),
  };
}

export function chainAuditDetail(req: ApprovalChainRequest, res: ChainResolution): Record<string, unknown> {
  return {
    tool: req.tool,
    ...(req.action !== undefined ? { action: req.action } : {}),
    verdict: res.verdict,
    ...(res.askVariant !== undefined ? { askVariant: res.askVariant } : {}),
    resolvedBy: res.resolvedBy,
    registryVerdict: res.registryVerdict,
    elements: res.elements.map((e) => ({
      element: e.element,
      level: e.level,
      verdict: e.verdict,
      ...(e.clamped !== undefined ? { clamped: e.clamped } : {}),
      ...(e.error !== undefined ? { error: e.error, reason: "element-error" } : {}),
    })),
    transforms: res.transforms.map((t) => ({ name: t.name, from: t.from, to: t.to, ...(t.reason !== undefined ? { reason: t.reason } : {}) })),
    ...(res.denyAbsolute !== undefined ? { denyAbsolute: true } : {}),
    ...(res.judge !== undefined
      ? {
          judge: {
            verdict: res.judge.verdict,
            source: res.judge.source,
            passes: res.judge.passes,
            cacheHit: res.judge.cacheHit,
            ...(res.judge.pass1 !== undefined ? { pass1: res.judge.pass1 } : {}),
          },
        }
      : {}),
    unattended: req.unattended,
    tainted: taintedOf(req),
    ...(taintedOf(req) && chainTaintKinds().length > 0 ? { taintKinds: [...chainTaintKinds()] } : {}),
    ...taintModeNote(),
    ...(req.mode !== undefined ? { mode: req.mode.mode } : {}),
    ...(req.domain !== undefined ? { domain: req.domain } : {}),
  };
}

export function renderChainResolution(req: ApprovalChainRequest, res: ChainResolution): string[] {
  const lines: string[] = [];
  lines.push(`${req.tool}${req.action !== undefined ? ` (action ${req.action})` : ""} → ${res.verdict.toUpperCase()}${res.askVariant !== undefined ? ` (${res.askVariant})` : ""}`);
  lines.push(`resolved by: ${res.resolvedBy}${res.denyAbsolute !== undefined ? " — DENY IS ABSOLUTE (transforms skipped)" : ""}`);
  lines.push(`registry baseline: ${res.registryVerdict}${res.verdict !== res.registryVerdict ? "  ⚠ diverged — see elements/transforms" : ""}`);
  if (res.judge !== undefined) {
    lines.push(`judge consult: ${res.judge.verdict} (${res.judge.source}, ${res.judge.passes} pass${res.judge.passes === 1 ? "" : "es"}${res.judge.cacheHit ? ", cache hit" : ""}) — ${res.judge.reasoning}`);
  }
  lines.push("elements (level order):");
  for (const e of res.elements) {
    const marks = [e.clamped !== undefined ? "clamped→defer" : undefined, e.error !== undefined ? "element-error→ask" : undefined]
      .filter((m): m is string => m !== undefined)
      .join(", ");
    lines.push(`  [${e.level}] ${e.element}: ${e.verdict}${marks.length > 0 ? ` (${marks})` : ""}`);
  }
  if (res.transforms.length === 0) {
    lines.push("transforms: (none applied)");
  } else {
    lines.push("transforms (in order):");
    for (const t of res.transforms) lines.push(`  ${t.name}: ${t.from} → ${t.to}${t.reason !== undefined ? ` (${t.reason})` : ""}`);
  }
  const supplied = req.tainted !== undefined;
  const kinds = !supplied && taintedOf(req) ? chainTaintKinds() : [];
  const liveTainted = chainTaintSignal();
  const liveKinds = supplied && liveTainted ? chainTaintKinds() : [];
  const context = [
    `unattended: ${req.unattended}`,
    `tainted: ${taintedOf(req)}${kinds.length > 0 ? ` (${kinds.join(", ")})` : ""}` +
      (supplied ? ` — supplied by the caller, not this turn's own signal (this turn: ${liveTainted}${liveKinds.length > 0 ? ` (${liveKinds.join(", ")})` : ""})` : "") +
      (taintMode() === "off" ? " — taint.mode: off (the model is not running)" : ""),
    ...(req.mode !== undefined ? [`mode: ${req.mode.mode}`] : []),
  ];
  lines.push(`context: ${context.join(" · ")}`);
  return lines;
}

export function approvalModeForDomain(domain: string | undefined): ApprovalModeConfig | undefined {
  if (domain === undefined) return undefined;
  try {
    return getConfig().loadDomains().find((d) => d.name === domain)?.approvalMode;
  } catch {
    return undefined;
  }
}

export function approversForScopeKey(scopeKey: string | undefined, domain: string | undefined): readonly OperatorApprover[] {
  if (scopeKey === undefined) return [];
  const parts = scopeKey.split("/");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return [];
  const [platform, workspace, channel] = parts as [string, string, string];
  try {
    const cfg = getConfig();
    const domains = domain !== undefined ? [domain] : cfg.domainsForSurface({ workspaceKey: `${platform}/${workspace}`, surface: channel });
    return resolveAccess({ mode: "channel", platform, workspace, channel, domains }, cfg.loadBundles(), cfg.loadBindings(), cfg.pluginRegistry, cfg.loadConnectorCredentials?.() ?? []).approvers;
  } catch {
    return [];
  }
}

export function preApprovalRulesForScopeKey(
  scopeKey: string | undefined,
  domain: string | undefined,
): readonly ResolvedPreApprovalRule[] {
  if (scopeKey === undefined) return [];
  const parts = scopeKey.split("/");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return [];
  const [platform, workspace, channel] = parts as [string, string, string];
  try {
    const cfg = getConfig();
    const domains = domain !== undefined ? [domain] : cfg.domainsForSurface({ workspaceKey: `${platform}/${workspace}`, surface: channel });
    return resolveAccess({ mode: "channel", platform, workspace, channel, domains }, cfg.loadBundles(), cfg.loadBindings(), cfg.pluginRegistry, cfg.loadConnectorCredentials?.() ?? []).preApprovalRules;
  } catch {
    return [];
  }
}

let kindToTool: ReadonlyMap<string, string> | undefined;

export function toolForActionKind(kind: string): string | undefined {
  if (kindToTool === undefined) {
    const m = new Map<string, string>();
    for (const [tool, entry] of Object.entries(TOOL_CONSEQUENCE)) {
      if (entry.via.kind === "action-kind") m.set(entry.via.action, tool);
    }
    kindToTool = m;
  }
  return kindToTool.get(kind);
}

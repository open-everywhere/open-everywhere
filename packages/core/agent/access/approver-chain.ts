import { classifyConnectorOp, isConnectorOpTool, TOOL_CONSEQUENCE, type ConsequenceEntry } from "./consequence.js";
import { awsCommandVerdict, type AwsScreenInput } from "./aws-screen.js";
import { untrustedIngestedThisTurn } from "./taint-signal.js";

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
  readonly grant?: { readonly kind: string; readonly grantedBy: string };
}

export function chainTaintSignal(): boolean {
  return untrustedIngestedThisTurn();
}

function taintedOf(req: ApprovalChainRequest): boolean {
  return req.tainted ?? chainTaintSignal();
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
  readonly denyAbsolute?: true;
}

export function registryVerdictOf(tool: string): "allow" | "ask" {
  if (isConnectorOpTool(tool)) return classifyConnectorOp(tool) === "open" ? "allow" : "ask";
  const row: ConsequenceEntry | undefined = TOOL_CONSEQUENCE[tool];
  if (row === undefined) return "ask";
  return row.tier === "open" ? "allow" : "ask";
}

export function taintToleranceOf(tool: string): "refuse" | "card" | undefined {
  if (isConnectorOpTool(tool)) return classifyConnectorOp(tool) === "open" ? undefined : "card";
  const row = TOOL_CONSEQUENCE[tool];
  if (row === undefined) return "refuse";
  if (row.taint !== undefined) return row.taint;
  return row.tier === "open" ? undefined : "refuse";
}

export interface JudgeEligibilityRow {
  readonly maxTier: "open" | "gate:member";
  readonly maxOpTier: "read" | "write";
}

export const AUTO_JUDGE_ELIGIBILITY: Readonly<Record<string, JudgeEligibilityRow>> = {};

let autoJudge: Approver | undefined;

export function registerAutoJudge(judge: Approver): void {
  autoJudge = judge;
}

export function resetAutoJudge(): void {
  autoJudge = undefined;
}

export function autoJudgeEligible(tool: string): boolean {
  return autoJudge !== undefined && AUTO_JUDGE_ELIGIBILITY[tool] !== undefined;
}

export type TransformStage = "mode" | "judge" | "unattended" | "taint";

export const TRANSFORM_STAGE_ORDER: readonly TransformStage[] = ["mode", "judge", "unattended", "taint"];

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
    name: "judge:AUTO",
    stage: "judge",
    from: ["ask"],
    fires: (req) => autoJudgeEligible(req.tool),
    to: () => "allow",
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
    name: "taint:refuse",
    stage: "taint",
    from: ["allow", "ask"],
    reason: "taint-refused",
    fires: (req) => taintedOf(req) && taintToleranceOf(req.tool) === "refuse",
    to: () => "deny",
  },
  {
    name: "taint:card",
    stage: "taint",
    from: ["allow"],
    reason: "taint-carded",
    fires: (req) => taintedOf(req) && taintToleranceOf(req.tool) === "card",
    to: () => "ask",
  },
];

interface BuiltInElement {
  readonly name: string;
  readonly level: ApproverLevel;
  readonly clazz: ElementClass;
  evaluate(req: ApprovalChainRequest): ApproverVerdict | Promise<ApproverVerdict>;
}

const SESSION_GRANT_ELEMENT: BuiltInElement = {
  name: "session-grant",
  level: "surface",
  clazz: "surface",
  evaluate: (req) => (req.grant !== undefined ? "allow" : undefined),
};

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
    ...[SESSION_GRANT_ELEMENT, AWS_SURFACE_ELEMENT, CONNECTOR_OPS_RAISE_ELEMENT, VERB_CLASSIFIER_ELEMENT, REGISTRY_ELEMENT].map((e) => ({
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
      denyAbsolute: true,
    };
  }

  const positional = evaluated.filter((e) => e.verdict !== "defer").sort((a, b) => a.rank - b.rank || a.order - b.order);
  const first = positional[0];
  let verdict: "allow" | "ask" = first === undefined || first.verdict === "ask" ? "ask" : "allow";
  const resolvedBy = first?.element ?? "registry";

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
    unattended: req.unattended,
    tainted: taintedOf(req),
    ...(req.mode !== undefined ? { mode: req.mode.mode } : {}),
    ...(req.domain !== undefined ? { domain: req.domain } : {}),
  };
}

export function renderChainResolution(req: ApprovalChainRequest, res: ChainResolution): string[] {
  const lines: string[] = [];
  lines.push(`${req.tool}${req.action !== undefined ? ` (action ${req.action})` : ""} → ${res.verdict.toUpperCase()}${res.askVariant !== undefined ? ` (${res.askVariant})` : ""}`);
  lines.push(`resolved by: ${res.resolvedBy}${res.denyAbsolute !== undefined ? " — DENY IS ABSOLUTE (transforms skipped)" : ""}`);
  lines.push(`registry baseline: ${res.registryVerdict}${res.verdict !== res.registryVerdict ? "  ⚠ diverged — see elements/transforms" : ""}`);
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
  const context = [`unattended: ${req.unattended}`, `tainted: ${taintedOf(req)}`, ...(req.mode !== undefined ? [`mode: ${req.mode.mode}`] : [])];
  lines.push(`context: ${context.join(" · ")}`);
  return lines;
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

import type { Bundle, ConnectorOpGating } from "./bundle.js";
import {
  classifyConnectorOpTierVerdict,
  connectorOpName,
  defaultConnectorOpTierArm,
  parseQualifiedToolName,
  type ConnectorOpTier,
  type ConnectorOpTierArm,
  type ConnectorOpToolHints,
  type OpTierBasis,
} from "./consequence.js";
import { getConfig } from "./config.js";

const TIER_RANK: Readonly<Record<ConnectorOpTier, number>> = { read: 0, write: 1, destructive: 2 };

const LIST_TIER = { gated: "write", destructive: "destructive" } as const satisfies Record<string, ConnectorOpTier>;

export function joinConnectorOpTiers(a: ConnectorOpTier, b: ConnectorOpTier): ConnectorOpTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

const ARM_TIER_FLOOR: ConnectorOpTier = "write";

const ALL_OPS = "*";

function opKey(op: string): string {
  return op.trim().toLowerCase().replace(/-/gu, "_");
}

function opKeysOf(toolName: string): readonly string[] {
  const sep = toolName.indexOf("__");
  const conn = sep > 0 ? toolName.slice(0, sep).toLowerCase() : "";
  const op = opKey(connectorOpName(toolName));
  const keys = new Set<string>([op]);
  if (conn !== "" && op.startsWith(`${opKey(conn)}_`)) keys.add(op.slice(opKey(conn).length + 1));
  return [...keys];
}

function connectorKeyOf(toolName: string): string {
  const sep = toolName.indexOf("__");
  return sep > 0 ? opKey(toolName.slice(0, sep)) : "";
}

export function canonicalDeclarationKey(raw: string): string {
  return opKey(raw);
}

export function connectorOpDeclarationKeys(toolName: string): { readonly connector: string; readonly ops: readonly string[] } {
  return { connector: connectorKeyOf(toolName), ops: opKeysOf(toolName) };
}

type GatingIndex = ReadonlyMap<string, ReadonlyMap<string, ConnectorOpTier>>;

const EMPTY_INDEX: GatingIndex = new Map();

const indexCache = new WeakMap<object, GatingIndex>();

function buildIndex(bundles: readonly Bundle[]): GatingIndex {
  const index = new Map<string, Map<string, ConnectorOpTier>>();
  for (const bundle of bundles) {
    for (const entry of bundle.connectorOps ?? []) {
      const connector = opKey(entry.connector);
      if (connector === "") continue;
      let ops = index.get(connector);
      if (!ops) {
        ops = new Map();
        index.set(connector, ops);
      }
      for (const [list, tier] of Object.entries(LIST_TIER) as readonly (readonly [keyof typeof LIST_TIER, ConnectorOpTier])[]) {
        for (const raw of (entry as ConnectorOpGating)[list] ?? []) {
          const key = raw.trim() === ALL_OPS ? ALL_OPS : opKey(raw);
          if (key === "") continue;
          const prior = ops.get(key);
          ops.set(key, prior === undefined ? tier : joinConnectorOpTiers(prior, tier));
        }
      }
    }
  }
  return index;
}

function indexFor(bundles: readonly Bundle[]): GatingIndex {
  const cached = indexCache.get(bundles);
  if (cached) return cached;
  const built = buildIndex(bundles);
  indexCache.set(bundles, built);
  return built;
}

function configuredBundles(): readonly Bundle[] {
  try {
    return getConfig().loadBundles();
  } catch {
    return [];
  }
}

export function declaredConnectorOpRaise(toolName: string, bundles?: readonly Bundle[]): ConnectorOpTier | undefined {
  const connector = connectorKeyOf(toolName);
  if (connector === "") return undefined;
  let index: GatingIndex;
  try {
    index = indexFor(bundles ?? configuredBundles());
  } catch {
    index = EMPTY_INDEX;
  }
  const ops = index.get(connector);
  if (!ops) return undefined;
  let raised: ConnectorOpTier | undefined = ops.get(ALL_OPS);
  for (const key of opKeysOf(toolName)) {
    const declared = ops.get(key);
    if (declared !== undefined) raised = raised === undefined ? declared : joinConnectorOpTiers(raised, declared);
  }
  return raised;
}

function registeredConnectorOpTierArm(): ConnectorOpTierArm {
  try {
    return getConfig().connectorOpTier ?? defaultConnectorOpTierArm;
  } catch {
    return defaultConnectorOpTierArm;
  }
}

interface ArmAnswer {
  readonly replaced: boolean;
  readonly tier?: ConnectorOpTier;
}

function consultTieringFunction(toolName: string, hints: ConnectorOpToolHints | undefined): ArmAnswer {
  const arm = registeredConnectorOpTierArm();
  const replaced = arm !== defaultConnectorOpTierArm;
  const parsed = parseQualifiedToolName(toolName);
  if (parsed?.connection === undefined) return { replaced };
  let answer: unknown;
  try {
    answer = arm({ connection: parsed.connection, verb: parsed.verb, toolName, ...(hints !== undefined ? { hints } : {}) });
  } catch (err) {
    console.warn(`[open-everywhere:access] connectorOpTier arm threw for ${toolName}; kept the built-in verdict: ${String(err)}`);
    return { replaced };
  }
  if (answer === undefined) return { replaced };
  if (typeof answer !== "string" || !Object.hasOwn(TIER_RANK, answer)) {
    console.warn(
      `[open-everywhere:access] connectorOpTier arm returned ${JSON.stringify(answer)} for ${toolName}, which is not a tier; kept the built-in verdict`,
    );
    return { replaced };
  }
  return { replaced, tier: answer as ConnectorOpTier };
}

export interface ConnectorOpTierParts {
  readonly base: ConnectorOpTier;
  readonly basis: OpTierBasis;
  readonly hint?: ConnectorOpTier;
  readonly hintDecided: boolean;
  readonly armReplaced: boolean;
  readonly arm?: ConnectorOpTier;
  readonly armLowered: boolean;
  readonly declared?: ConnectorOpTier;
  readonly tier: ConnectorOpTier;
}

export function connectorOpTierParts(toolName: string, bundles?: readonly Bundle[], hints?: ConnectorOpToolHints): ConnectorOpTierParts {
  const verdict = classifyConnectorOpTierVerdict(toolName, hints);
  const arm = consultTieringFunction(toolName, hints);
  const afterArm =
    arm.tier === undefined
      ? verdict.tier
      : TIER_RANK[arm.tier] >= TIER_RANK[verdict.tier]
        ? joinConnectorOpTiers(verdict.tier, arm.tier)
        : joinConnectorOpTiers(arm.tier, ARM_TIER_FLOOR);
  const armLowered = TIER_RANK[afterArm] < TIER_RANK[verdict.tier];
  const declared = declaredConnectorOpRaise(toolName, bundles);
  const tier = declared === undefined ? afterArm : joinConnectorOpTiers(afterArm, declared);
  return {
    base: verdict.tier,
    basis: verdict.basis,
    ...(verdict.hint !== undefined ? { hint: verdict.hint } : {}),
    hintDecided: verdict.hintDecided,
    armReplaced: arm.replaced,
    ...(arm.replaced && arm.tier !== undefined ? { arm: arm.tier } : {}),
    armLowered,
    ...(declared !== undefined ? { declared } : {}),
    tier,
  };
}

export function effectiveConnectorOpTier(toolName: string, bundles?: readonly Bundle[], hints?: ConnectorOpToolHints): ConnectorOpTier {
  return connectorOpTierParts(toolName, bundles, hints).tier;
}

export function effectiveConnectorOpConsequence(toolName: string, bundles?: readonly Bundle[], hints?: ConnectorOpToolHints): "open" | "gate:member" {
  return connectorOpConsequenceOfTier(effectiveConnectorOpTier(toolName, bundles, hints));
}

export function connectorOpConsequenceOfTier(tier: ConnectorOpTier): "open" | "gate:member" {
  return tier === "read" ? "open" : "gate:member";
}

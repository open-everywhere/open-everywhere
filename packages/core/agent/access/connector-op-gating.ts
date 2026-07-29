import type { Bundle, ConnectorOpGating } from "./bundle.js";
import { classifyConnectorOpTier, connectorOpName, type ConnectorOpTier } from "./consequence.js";
import { getConfig } from "./config.js";

const TIER_RANK: Readonly<Record<ConnectorOpTier, number>> = { read: 0, write: 1, destructive: 2 };

const LIST_TIER = { gated: "write", destructive: "destructive" } as const satisfies Record<string, ConnectorOpTier>;

export function joinConnectorOpTiers(a: ConnectorOpTier, b: ConnectorOpTier): ConnectorOpTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

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

export function effectiveConnectorOpTier(toolName: string, bundles?: readonly Bundle[]): ConnectorOpTier {
  const base = classifyConnectorOpTier(toolName);
  const declared = declaredConnectorOpRaise(toolName, bundles);
  return declared === undefined ? base : joinConnectorOpTiers(base, declared);
}

export function effectiveConnectorOpConsequence(toolName: string, bundles?: readonly Bundle[]): "open" | "gate:member" {
  return effectiveConnectorOpTier(toolName, bundles) === "read" ? "open" : "gate:member";
}

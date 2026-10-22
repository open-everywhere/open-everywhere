import type { AuditDetail } from "../audit/scrubbed-text.js";
import type { Bundle } from "./bundle.js";
import { configOrRefuse } from "./config.js";
import { canonicalDeclarationKey, connectorOpDeclarationKeys } from "./connector-op-gating.js";
import { isConnectorOpTool, parseQualifiedToolName } from "./consequence.js";

export type NeverTierCategory = "money-movement" | "trading" | "legal-entity";

export interface NeverTierRule {
  readonly id: string;
  readonly category: NeverTierCategory;
  readonly label: string;
  readonly allOf: readonly (readonly string[])[];
  readonly grounding: readonly string[];
}

export const NEVER_TIER_DEFAULTS: readonly NeverTierRule[] = [
  {
    id: "money.send",
    category: "money-movement",
    label: "sends or transfers money out of an account",
    allOf: [
      ["send", "money"], ["transfer", "money"], ["transfer", "funds"], ["create", "transfer"],
      ["withdraw", "money"], ["withdraw", "funds"], ["create", "withdrawal"], ["payout"], ["disburse"], ["remit"],
    ],
    grounding: ["stripe__send_money", "stripe__transfer_money"],
  },
  {
    id: "money.convert",
    category: "money-movement",
    label: "converts funds between currencies",
    allOf: [["convert", "currency"]],
    grounding: ["stripe__convert_currency"],
  },
  {
    id: "money.recipient",
    category: "money-movement",
    label: "sets up a recipient that money can be sent to",
    allOf: [["setup", "recipient"]],
    grounding: ["stripe__setup_recipient"],
  },
  {
    id: "money.refund",
    category: "money-movement",
    label: "refunds or pays money",
    allOf: [["refund"], ["pay"]],
    grounding: ["stripe__create_refund"],
  },
  {
    id: "money.generic-payments-write",
    category: "money-movement",
    label: "calls a payment provider's generic write API, which can move money",
    allOf: [["stripe", "api", "write"]],
    grounding: ["stripe__stripe_api_write"],
  },
  {
    id: "trading.order",
    category: "trading",
    label: "places, changes or cancels a trade order",
    allOf: [["place", "order"], ["replace", "order"], ["cancel", "order"], ["cancel", "orders"], ["trade"], ["buy"], ["sell"]],
    grounding: ["alpaca__place_stock_order", "alpaca__place_crypto_order", "alpaca__place_option_order", "alpaca__replace_order_by_id", "alpaca__cancel_order_by_id", "alpaca__cancel_all_orders"],
  },
  {
    id: "trading.position",
    category: "trading",
    label: "closes or exercises a market position",
    allOf: [["close", "position"], ["close", "positions"], ["exercise", "option"], ["exercise", "options"], ["exercise", "position"]],
    grounding: ["alpaca__close_position", "alpaca__close_all_positions", "alpaca__exercise_options_position"],
  },
  {
    id: "legal.company-formation",
    category: "legal-entity",
    label: "forms a legal company",
    allOf: [["company", "formation"]],
    grounding: ["stripe__atlas_company_formation"],
  },
];

export type NeverTierMatch =
  | { readonly source: "default"; readonly rule: NeverTierRule }
  | { readonly source: "config"; readonly bundle: string }
  | { readonly source: "config-unavailable" };

function neverTierTokens(toolName: string): readonly string[] {
  const op = parseQualifiedToolName(toolName)?.verb ?? toolName;
  return op
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t !== "");
}

export function neverTierDefaultMatch(toolName: string): NeverTierRule | undefined {
  const tokens = new Set(neverTierTokens(toolName));
  return NEVER_TIER_DEFAULTS.find((rule) => rule.allOf.some((set) => set.every((t) => tokens.has(t))));
}

export function neverTierConfigMatch(toolName: string, bundles: readonly Bundle[]): string | undefined {
  const { connector, ops } = connectorOpDeclarationKeys(toolName);
  if (connector === "") return undefined;
  for (const bundle of bundles) {
    for (const entry of bundle.connectorOps ?? []) {
      if (canonicalDeclarationKey(entry.connector) !== connector) continue;
      for (const raw of entry.never ?? []) {
        const key = raw.trim() === "*" ? "*" : canonicalDeclarationKey(raw);
        if (key === "*" || ops.includes(key)) return bundle.name;
      }
    }
  }
  return undefined;
}

function neverTierBundles(): readonly Bundle[] | "unreadable" {
  try {
    return configOrRefuse("never-tier", (config) => config.loadBundles()) ?? [];
  } catch {
    return "unreadable";
  }
}

export function neverTierMatch(toolName: string, bundles?: readonly Bundle[]): NeverTierMatch | undefined {
  if (!isConnectorOpTool(toolName)) return undefined;
  const rule = neverTierDefaultMatch(toolName);
  if (rule !== undefined) return { source: "default", rule };
  const loaded = bundles ?? neverTierBundles();
  if (loaded === "unreadable") return { source: "config-unavailable" };
  const bundle = neverTierConfigMatch(toolName, loaded);
  return bundle === undefined ? undefined : { source: "config", bundle };
}

export function neverTierRefusalMessage(toolName: string, match: NeverTierMatch): string {
  if (match.source === "config-unavailable") {
    return (
      `"${toolName}" did not run. This deployment's configuration could not be read, so I cannot prove the op is not ` +
      `on the never-allowed list, and I refuse it. No approval can change this. An operator must fix the configuration.`
    );
  }
  const why =
    match.source === "default"
      ? `it ${match.rule.label} (never-allowed rule "${match.rule.id}", a shipped default)`
      : `this deployment's configuration puts it on the never-allowed list (bundle "${match.bundle}")`;
  return (
    `"${toolName}" is never allowed: ${why}. It did not run, and no approval, permission or setting can allow it. ` +
    `This is not waiting for approval, so do not offer to ask for one. A person can do this step themselves, outside this agent.`
  );
}

export function neverTierAuditDetail(toolName: string, match: NeverTierMatch): AuditDetail {
  const connection = parseQualifiedToolName(toolName)?.connection ?? "";
  const base = { connection, op: toolName, reason: "never_tier", source: match.source };
  if (match.source === "default") return { ...base, rule: match.rule.id, category: match.rule.category };
  if (match.source === "config") return { ...base, bundle: match.bundle };
  return base;
}

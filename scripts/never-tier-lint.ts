import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONNECTOR_DESTRUCTIVE_VERBS, CONNECTOR_READ_VERBS, CONNECTOR_WRITE_VERBS, isConnectorOpTool } from "@open-everywhere/core/agent/access/consequence.js";
import { NEVER_TIER_DEFAULTS, neverTierDefaultMatch, type NeverTierCategory } from "@open-everywhere/core/agent/access/never-tier.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATEGORIES: ReadonlySet<NeverTierCategory> = new Set<NeverTierCategory>(["money-movement", "trading", "legal-entity"]);
const KNOWN_VERBS = new Set([...CONNECTOR_READ_VERBS, ...CONNECTOR_WRITE_VERBS, ...CONNECTOR_DESTRUCTIVE_VERBS]);
const SOLO_TOKENS: ReadonlySet<string> = new Set(["payout", "disburse", "remit", "refund", "pay", "trade", "buy", "sell"]);

const bad: string[] = [];
const ids = new Set<string>();

for (const rule of NEVER_TIER_DEFAULTS) {
  if (ids.has(rule.id)) bad.push(`rule "${rule.id}" is declared twice — ids are the audit key and must be unique`);
  ids.add(rule.id);
  if (!CATEGORIES.has(rule.category)) bad.push(`rule "${rule.id}" has category "${rule.category}", which is not in the closed set`);
  if (rule.label.trim() === "") bad.push(`rule "${rule.id}" has no label — the refusal reads it to the person`);
  if (rule.allOf.length === 0) bad.push(`rule "${rule.id}" has no token set, so it matches nothing`);
  for (const set of rule.allOf) {
    if (set.length === 0) bad.push(`rule "${rule.id}" has an empty token set, which would match every op`);
    for (const token of set) {
      if (!/^[a-z0-9]+$/u.test(token)) bad.push(`rule "${rule.id}" token "${token}" is not lowercase alphanumeric, so no op name can produce it`);
    }
    if (set.length === 1 && KNOWN_VERBS.has(set[0]!)) {
      bad.push(`rule "${rule.id}" refuses the bare verb "${set[0]}", which every connector uses — pair it with a noun`);
    } else if (set.length === 1 && !SOLO_TOKENS.has(set[0]!)) {
      bad.push(`rule "${rule.id}" refuses the bare word "${set[0]}", which is not on the solo-token list — pair it with a money or market noun`);
    }
  }
  if (rule.grounding.length === 0) bad.push(`rule "${rule.id}" names no real tool — ground it in a tool OE can reach`);
  for (const tool of rule.grounding) {
    if (!isConnectorOpTool(tool)) bad.push(`rule "${rule.id}" grounding "${tool}" is not a qualified <connection>__<op> name`);
    const first = neverTierDefaultMatch(tool);
    if (first?.id !== rule.id) bad.push(`rule "${rule.id}" grounding "${tool}" matches ${first === undefined ? "no rule" : `rule "${first.id}" first`}`);
  }
}

const authSrc = readFileSync(join(ROOT, "packages/core/agent/connections/connector-auth.ts"), "utf8");
const start = authSrc.indexOf("export function connectorApprovalPolicy(");
const end = start < 0 ? -1 : authSrc.indexOf("\n}\n", start);
const body = start < 0 || end < 0 ? "" : authSrc.slice(start, end);
const neverAt = body.indexOf("neverTierMatch(ctx.toolName)");
const fenceAt = body.indexOf("personalSurfaceApprovalRefusal(");
const cardAt = body.indexOf("return carded(ctx)");
if (body === "") bad.push("connector-auth.ts no longer declares connectorApprovalPolicy — update this lint with the new seam");
else if (neverAt < 0) bad.push("connectorApprovalPolicy does not call neverTierMatch(ctx.toolName) — the never tier is not wired");
else if (!(neverAt < fenceAt && neverAt < cardAt)) bad.push("connectorApprovalPolicy calls neverTierMatch AFTER the fence or the card plane — it must run first, above every lift");

const doc = readFileSync(join(ROOT, "docs/security/security-model.md"), "utf8");
for (const id of ids) {
  if (!doc.includes(`\`${id}\``)) bad.push(`docs/security/security-model.md does not name never-tier rule \`${id}\` in its tier table`);
}

if (bad.length > 0) {
  console.error(`✗ lint:never-tier — ${bad.length} problem(s):\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
console.log(`✓ lint:never-tier: ${NEVER_TIER_DEFAULTS.length} rules, grounded, narrow, wired first, and documented`);

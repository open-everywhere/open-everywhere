import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS } from "@open-everywhere/core/agent/settings/settings.js";
import { SHIPPED_STACK, STACKS, STACK_ALIASES, isStackAlias } from "../agent/model/stacks.js";

const APP_DIR = "agent";
const REGISTRY = "agent/model/stacks.ts";
const RESOLVER = "agent/model/models.ts";
const PRICING = "packages/core/agent/spend/pricing.ts";
const CORE_DEFAULT = "packages/core/agent/model/default-model.ts";

const VENDORS = [
  "zai", "deepseek", "alibaba", "anthropic", "openai", "google", "meta", "mistral",
  "moonshotai", "qwen", "xai", "cohere", "amazon", "minimax", "perplexity", "inception",
];
const MODEL_ID = new RegExp(`^(?:${VENDORS.join("|")})/[a-z0-9][a-z0-9.\\-]*$`, "i");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "generated" || entry === "node_modules") continue;
      out.push(...tsFilesUnder(p));
    } else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

const reds: string[] = [];

let scanned = 0;
for (const file of tsFilesUnder(APP_DIR)) {
  if (file === REGISTRY) continue;
  scanned++;
  const code = stripComments(readFileSync(file, "utf8"));
  for (const m of code.matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
    if (!MODEL_ID.test(m[1])) continue;
    const line = code.slice(0, m.index).split("\n").length;
    reds.push(
      `BARE MODEL ID: ${file}:${line} names "${m[1]}" directly. Import the role const from ` +
        `${RESOLVER} instead (PRIMARY_MODEL / UTILITY_MODEL / VISION_MODEL / SUPERVISOR_MODEL / JUDGE_MODEL), ` +
        `or put the id in a stack in ${REGISTRY} if it is a distinct job or a new stack.`,
    );
  }
}

const resolverSrc = readFileSync(RESOLVER, "utf8");
const pricingSrc = readFileSync(PRICING, "utf8");

const shippedPrimary = STACKS[SHIPPED_STACK].primary.id;

const builtIn = pricingSrc.match(/const BUILT_IN[^=]*=\s*\{([\s\S]*?)\n\};/);
if (!builtIn) {
  reds.push(`UNREADABLE: could not locate the BUILT_IN table in ${PRICING} — this gate needs updating alongside it.`);
} else {
  const ids = [...builtIn[1].matchAll(/["']([^"']+)["']\s*:\s*\{/g)].map((m) => m[1]);
  if (ids.length !== 1) {
    reds.push(
      `BUILT_IN has ${ids.length} entries (${ids.join(", ") || "none"}), must have exactly 1. ` +
        `Two or more make soleConfiguredModel() return undefined, silently disabling the $ fallback ` +
        `for stampless usage rows; zero disables it outright. See the comment in ${PRICING}.`,
    );
  } else if (ids[0] !== shippedPrimary) {
    reds.push(
      `PRICING/DEFAULT MISMATCH: ${PRICING} prices "${ids[0]}" but the shipped stack ` +
        `("${SHIPPED_STACK}", ${REGISTRY}) runs "${shippedPrimary}" as its primary. BUILT_IN doubles as ` +
        `the assumed model for stampless usage rows, so every such row is being priced at the WRONG ` +
        `model's rate. (This is the exact rot that ran from 2026-07-17 to 2026-08-05.)`,
    );
  }
}

const coreLiteral = readFileSync(CORE_DEFAULT, "utf8").match(/registeredDefault\s*\|\|\s*["']([^"']+)["']/)?.[1];
if (coreLiteral === undefined) {
  reds.push(
    `UNREADABLE: could not find core's library default model literal in ${CORE_DEFAULT} ` +
      `(expected the \`registeredDefault || "<id>"\` fallback). This gate needs updating alongside it.`,
  );
} else if (coreLiteral !== shippedPrimary) {
  reds.push(
    `CORE/STACK MISMATCH: ${CORE_DEFAULT} falls back to "${coreLiteral}" but the shipped stack ` +
      `("${SHIPPED_STACK}") runs "${shippedPrimary}". That literal is what a core-only process — the ` +
      `plugin extractor with no app config, a unit test importing one module — resolves to, so a ` +
      `drift here silently gives generated subagents a different model from the deployment.`,
  );
}

const settingShipped = SETTINGS.models.stack.shipped;
if (!isStackAlias(settingShipped)) {
  reds.push(
    `SETTING/STACK MISMATCH: the \`models.stack\` setting ships "${settingShipped}", which is not a ` +
      `stack alias (${REGISTRY} defines ${STACK_ALIASES.map((a) => `"${a}"`).join(", ")}). Every clone ` +
      `would throw at config load.`,
  );
} else if (settingShipped !== SHIPPED_STACK) {
  reds.push(
    `SETTING/STACK MISMATCH: the \`models.stack\` setting ships "${settingShipped}" but ${REGISTRY} ` +
      `declares SHIPPED_STACK = "${SHIPPED_STACK}". The setting is what actually resolves; SHIPPED_STACK ` +
      `is what the pricing table and core's literal are pinned against, so a split makes both of those ` +
      `pins check the wrong thing.`,
  );
}

for (const role of [
  "PRIMARY_MODEL",
  "UTILITY_MODEL",
  "VISION_MODEL",
  "SUPERVISOR_MODEL",
  "JUDGE_MODEL",
  "PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS",
  "UTILITY_MODEL_CONTEXT_WINDOW_TOKENS",
]) {
  if (!new RegExp(`export const ${role}\\b`).test(resolverSrc)) {
    reds.push(`MISSING ROLE EXPORT: ${RESOLVER} no longer exports ${role}, which app config imports.`);
  }
}

for (const [alias, stack] of Object.entries(STACKS)) {
  for (const role of ["primary", "utility", "vision", "supervisor", "judge"] as const) {
    const spec = stack[role];
    if (spec === undefined) {
      reds.push(`INCOMPLETE STACK: "${alias}" does not fill the "${role}" role (${REGISTRY}).`);
      continue;
    }
    if (!MODEL_ID.test(spec.id)) {
      reds.push(
        `MALFORMED ID: stack "${alias}" role "${role}" is "${spec.id}", which is not a <vendor>/<model> ` +
          `id this gate recognises. Add the vendor to VENDORS in ${__filename.split("/").slice(-1)[0]} if it is new.`,
      );
    }
    if (!Number.isInteger(spec.contextWindowTokens) || spec.contextWindowTokens <= 0) {
      reds.push(`BAD WINDOW: stack "${alias}" role "${role}" declares contextWindowTokens ${spec.contextWindowTokens}.`);
    }
  }
}

if (reds.length > 0) {
  console.error(`✗ model-ids: ${reds.length} drift(s):\n`);
  for (const r of reds) console.error(`  • ${r}`);
  process.exit(1);
}

console.log(
  `✓ model-ids: ${scanned} app file(s) name no model id directly; ${STACK_ALIASES.length} stack(s) complete; ` +
    `BUILT_IN pricing, core's literal and the models.stack default all agree on "${shippedPrimary}" (stack "${SHIPPED_STACK}")`,
);

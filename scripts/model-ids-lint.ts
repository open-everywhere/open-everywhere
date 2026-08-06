import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = "agent";
const REGISTRY = "agent/model/models.ts";
const PRICING = "packages/core/agent/spend/pricing.ts";

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
        `agent/model/models.ts instead (PRIMARY_MODEL / UTILITY_MODEL / VISION_MODEL / SUPERVISOR_MODEL), ` +
        `or add the model as a new ROLE there if it is a distinct job.`,
    );
  }
}

const registrySrc = readFileSync(REGISTRY, "utf8");
const pricingSrc = readFileSync(PRICING, "utf8");

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
  } else {
    const coreDefault = readFileSync("packages/core/agent/model/default-model.ts", "utf8")
      .match(/OE_PRIMARY_MODEL\?\.trim\(\)\s*\|\|\s*["']([^"']+)["']/)?.[1];
    if (!coreDefault) {
      reds.push("UNREADABLE: could not resolve the committed default model id from core/agent/model/default-model.ts.");
    } else if (ids[0] !== coreDefault) {
      reds.push(
        `PRICING/DEFAULT MISMATCH: ${PRICING} prices "${ids[0]}" but the committed default model is ` +
          `"${coreDefault}". BUILT_IN doubles as the assumed model for stampless usage rows, so every ` +
          `such row is being priced at the WRONG model's rate. (This is the exact rot that ran from ` +
          `2026-07-17 to 2026-08-05.)`,
      );
    }
  }
}

for (const role of ["PRIMARY_MODEL", "UTILITY_MODEL", "VISION_MODEL", "SUPERVISOR_MODEL"]) {
  if (!new RegExp(`export const ${role}\\b`).test(registrySrc)) {
    reds.push(`MISSING ROLE EXPORT: ${REGISTRY} no longer exports ${role}, which app config imports.`);
  }
}

if (reds.length > 0) {
  console.error(`✗ model-ids: ${reds.length} drift(s):\n`);
  for (const r of reds) console.error(`  • ${r}`);
  process.exit(1);
}

console.log(`✓ model-ids: ${scanned} app file(s) name no model id directly; BUILT_IN pricing matches the committed default`);

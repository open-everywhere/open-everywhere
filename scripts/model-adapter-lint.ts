import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const MODEL_ADAPTER = "packages/adapters/agent/model/gateway.ts";

const SCOPE = ["agent", "packages/*/agent", "packages/providers/*/agent", "packages/create/template/agent", "packages/core/templates"];
const ALLOWED_AI_SDK = new Set(["@ai-sdk/provider", "@ai-sdk/provider-utils"]);

const STATIC_IMPORT = /\b(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

export function modelAdapterViolations(path: string, src: string): string[] {
  if (path === MODEL_ADAPTER) return [];
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const out: string[] = [];
  for (const m of code.matchAll(STATIC_IMPORT)) {
    const typeOnly = m[1] !== undefined;
    const clause = m[2] ?? "";
    const spec = m[3] ?? "";
    if (spec === "ai" && !typeOnly) {
      const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
      for (const part of named.split(",")) {
        const p = part.trim();
        if (p.startsWith("type ")) continue;
        const name = p.split(/\s+as\s+/)[0]?.trim();
        if (name === "gateway" || name === "createGateway") out.push(`${path}: imports \`${name}\` from "ai" — take the model from ${MODEL_ADAPTER} (gatewayLanguageModel)`);
      }
      const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)?.[1];
      if (ns !== undefined && new RegExp(`\\b${ns.replace(/\$/g, "\\$")}\\.(?:gateway|createGateway)\\b`).test(code)) {
        out.push(`${path}: reaches \`${ns}.gateway\`/\`${ns}.createGateway\` through a namespace import of "ai" — take the model from ${MODEL_ADAPTER}`);
      }
    }
    if (spec.startsWith("@ai-sdk/") && !ALLOWED_AI_SDK.has(spec) && !typeOnly) {
      out.push(`${path}: imports "${spec}" — a provider model is built only in ${MODEL_ADAPTER}`);
    }
  }
  if (/\bAI_SDK_DEFAULT_PROVIDER\b\s*(?:=(?!=)|\?\?=|\|\|=)|\[\s*["']AI_SDK_DEFAULT_PROVIDER["']\s*\]\s*=(?!=)|defineProperty\([^)]*AI_SDK_DEFAULT_PROVIDER/.test(code)) {
    out.push(`${path}: writes AI_SDK_DEFAULT_PROVIDER — only ${MODEL_ADAPTER} installs the default provider, or bare model ids skip models.dataPolicy`);
  }
  for (const m of code.matchAll(DYNAMIC_IMPORT)) {
    const spec = m[1] ?? "";
    if (spec.startsWith("@ai-sdk/") && !ALLOWED_AI_SDK.has(spec)) out.push(`${path}: imports "${spec}" at run time — a provider model is built only in ${MODEL_ADAPTER}`);
  }
  return out;
}

function trackedFiles(): string[] {
  const pathspecs = SCOPE.flatMap((d) => [`${d}/*.ts`, `${d}/*.tsx`, `${d}/*.mts`]);
  const raw = execFileSync("git", ["ls-files", "-z", "--", ...pathspecs], { encoding: "utf8" });
  return raw.split("\0").filter((f) => f !== "" && !f.endsWith(".d.ts"));
}

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ lint:model-adapter: ${label}`);
    process.exit(1);
  }
  passed++;
}

const F = "agent/x.ts";
ok(modelAdapterViolations(F, `import { gateway, generateText } from "ai";`).length === 1, "a named `gateway` import from ai is refused");
ok(modelAdapterViolations(F, `import { createGateway as cg } from "ai";`).length === 1, "an aliased `createGateway` import is refused");
ok(modelAdapterViolations(F, `import * as sdk from "ai";\nsdk.gateway("x");`).length === 1, "a namespace import's `.gateway` member is refused");
ok(modelAdapterViolations(F, `import { createGateway } from "@ai-sdk/gateway";`).length === 1, "@ai-sdk/gateway is refused");
ok(modelAdapterViolations(F, `import { openai } from "@ai-sdk/openai";`).length === 1, "a vendor provider package is refused");
ok(modelAdapterViolations(F, `const m = await import("@ai-sdk/anthropic");`).length === 1, "a dynamic vendor import is refused");
ok(modelAdapterViolations(F, `globalThis.AI_SDK_DEFAULT_PROVIDER = p;`).length === 1, "a write of AI_SDK_DEFAULT_PROVIDER is refused");
ok(modelAdapterViolations(F, `(globalThis as any)["AI_SDK_DEFAULT_PROVIDER"] = p;`).length === 1, "a bracketed write of AI_SDK_DEFAULT_PROVIDER is refused");
ok(modelAdapterViolations(F, `if (globalThis.AI_SDK_DEFAULT_PROVIDER === undefined) log();`).length === 0, "a read of AI_SDK_DEFAULT_PROVIDER passes");
ok(modelAdapterViolations(F, `import { generateText } from "ai";`).length === 0, "a plain `ai` import passes");
ok(modelAdapterViolations(F, `import type { gateway } from "ai";`).length === 0, "a type-only import passes");
ok(modelAdapterViolations(F, `import type { LanguageModelV4 } from "@ai-sdk/provider";`).length === 0, "@ai-sdk/provider passes");
ok(modelAdapterViolations(F, `// import { gateway } from "ai";\nconst x = 1;`).length === 0, "a comment passes");
ok(modelAdapterViolations(MODEL_ADAPTER, `import { gateway, createGateway } from "ai";`).length === 0, "the adapter itself passes");

const files = trackedFiles();
ok(files.length > 0, "zero files scanned — the scope matched nothing, so the gate proves nothing");
ok(files.includes(MODEL_ADAPTER), `${MODEL_ADAPTER} is not in the scanned set — the scope no longer reaches the adapter`);
ok(/\bcreateGateway\b/.test(readFileSync(MODEL_ADAPTER, "utf8")), `${MODEL_ADAPTER} no longer builds the provider — the allow-list names the wrong file`);
const bad = files.flatMap((f) => modelAdapterViolations(f, readFileSync(f, "utf8")));
if (bad.length > 0) {
  console.error(`✗ lint:model-adapter: ${bad.length} model call(s) skip the model adapter, so they skip models.dataPolicy:\n${bad.map((b) => `  - ${b}`).join("\n")}`);
  process.exit(1);
}
console.log(`✓ lint:model-adapter: ${files.length} file(s) scanned; every gateway model comes from ${MODEL_ADAPTER} (${passed} checks)`);

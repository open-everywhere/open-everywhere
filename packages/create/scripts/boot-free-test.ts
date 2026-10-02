import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CREATE = dirname(dirname(fileURLToPath(import.meta.url)));
const CORE = join(CREATE, "..", "core");
const FORBIDDEN = new Set(
  ["agent/access/eve-patch-probe-boot.ts", "agent/channels/unified.ts", "agent/channels/webhooks.ts"].map((p) =>
    normalize(join(CORE, p)),
  ),
);

const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function toSource(path: string): string | undefined {
  const ts = path.replace(/\.js$/, ".ts");
  for (const candidate of [ts, `${ts}.ts`, join(path, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return normalize(candidate);
  }
  return undefined;
}

function resolveSpec(from: string, spec: string): string | undefined {
  if (spec.startsWith(".")) return toSource(join(dirname(from), spec));
  if (spec.startsWith("@open-everywhere/core/")) return toSource(join(CORE, spec.slice("@open-everywhere/core/".length)));
  return undefined;
}

function edges(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT)) {
    if (m[2]) continue;
    const spec = m[3] ?? m[4];
    if (!spec) continue;
    const target = resolveSpec(file, spec);
    if (target) out.push(target);
  }
  return out;
}

function cliSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? cliSources(p) : p.endsWith(".ts") ? [normalize(p)] : [];
  });
}

const roots = cliSources(join(CREATE, "src"));
const parent = new Map<string, string | undefined>(roots.map((r) => [r, undefined]));
const queue = [...roots];
let hit: string | undefined;
while (queue.length > 0 && !hit) {
  const file = queue.shift()!;
  for (const next of edges(file)) {
    if (parent.has(next)) continue;
    parent.set(next, file);
    if (FORBIDDEN.has(next)) {
      hit = next;
      break;
    }
    queue.push(next);
  }
}

if (hit) {
  const chain: string[] = [];
  for (let at: string | undefined = hit; at; at = parent.get(at)) chain.unshift(relative(join(CREATE, ".."), at).split("\\").join("/"));
  console.error(`✗ boot-free: the CLI reaches the runtime boot path:\n  ${chain.join("\n  → ")}`);
  process.exit(1);
}
if (roots.length === 0 || parent.size <= roots.length) {
  console.error("✗ boot-free: the walk found no CLI sources or no core imports — the test is not measuring anything");
  process.exit(1);
}
const telemetryImporters = roots.filter((file) => /observability\/telemetry/.test(readFileSync(file, "utf8")));
if (telemetryImporters.length > 0) {
  console.error(
    "✗ boot-free: these `src/` file(s) reach core's telemetry emitter, so the documented claim that a\n" +
      "  `@open-everywhere/create` run sends NOTHING is false (docs/deploy/telemetry.md § The retired\n" +
      `  install-wizard events):\n  ${telemetryImporters.join("\n  ")}`,
  );
  process.exit(1);
}

console.log(`✓ boot-free: ${roots.length} CLI source(s), ${parent.size} module(s) walked, none reaches the eve boot probe`);

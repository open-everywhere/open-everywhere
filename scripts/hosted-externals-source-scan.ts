import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const COMPUTED_IMPORT = /\bimport\s*\(\s*[^"'`\s)]/;

function runtimeSourceDirs(root: string): string[] {
  const providers = join(root, "packages", "providers");
  return [
    "packages/core/agent",
    "packages/adapters/agent",
    "agent",
    ...(existsSync(providers)
      ? readdirSync(providers, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => join("packages", "providers", e.name, "agent"))
      : []),
  ].filter((d) => existsSync(join(root, d)));
}

export function isGeneratedDocsPage(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/);
  const file = segments.pop() ?? relativePath;
  if (file === "docs-generated.ts" && segments.at(-1) === "agent") return true;
  if (file === "index.ts") return false;
  return segments.some((s, i) => s === "generated" && segments[i - 1] === "docs");
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

export function computedImportFailures(root: string): string[] {
  const failures: string[] = [];
  for (const dir of runtimeSourceDirs(root)) {
    for (const file of walkTs(join(root, dir))) {
      const relative = file.slice(root.length + 1);
      if (isGeneratedDocsPage(relative)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        if (!COMPUTED_IMPORT.test(line)) continue;
        const context = [lines[i - 3], lines[i - 2], lines[i - 1], line]
          .filter((l) => l !== undefined)
          .join("\n");
        if (context.includes("hosted-inline-exempt:")) continue;
        failures.push(
          `${relative}:${i + 1}: computed dynamic import — the bundler cannot inline what it cannot see; if this package is needed hosted this is a cold-start-class crash. Inline a literal specifier, or add \`// hosted-inline-exempt: <why>\`.`,
        );
      }
    }
  }
  return failures;
}

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION_PLACEHOLDER = "{{OE_VERSION}}";

export const NAME_PLACEHOLDER = "{{APP_NAME}}";

export const RENAMED_ON_COPY: Readonly<Record<string, string>> = { gitignore: ".gitignore", "claude/": ".claude/" };

export function scaffoldPathFor(rel: string): string {
  const exact = RENAMED_ON_COPY[rel];
  if (exact !== undefined) return exact;
  for (const [from, to] of Object.entries(RENAMED_ON_COPY)) {
    if (from.endsWith("/") && rel.startsWith(from)) return to + rel.slice(from.length);
  }
  return rel;
}

export function defaultTemplateDir(): string {
  return fileURLToPath(new URL("../template/", import.meta.url));
}

export function packageNameFor(dir: string): string {
  const cleaned = basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-+$/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 214) : "open-everywhere-app";
}

export class ScaffoldRefusal extends Error {}

export interface ScaffoldResult {
  readonly dir: string;
  readonly files: readonly string[];
}

export function listFiles(root: string, at = root): string[] {
  return readdirSync(at).flatMap((name) => {
    const p = join(at, name);
    return statSync(p).isDirectory() ? listFiles(root, p) : [relative(root, p).split("\\").join("/")];
  });
}

export function scaffoldApp(options: { readonly targetDir: string; readonly version: string; readonly templateDir?: string }): ScaffoldResult {
  const dir = resolve(options.targetDir);
  const templateDir = options.templateDir ?? defaultTemplateDir();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.version) || options.version === "0.0.0") {
    throw new ScaffoldRefusal(`refusing to scaffold: "${options.version}" is not a release version, so the app's dependencies could not be pinned`);
  }
  if (!existsSync(join(templateDir, "package.json"))) {
    throw new ScaffoldRefusal(`refusing to scaffold: the quickstart template is missing from this package (${templateDir})`);
  }
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new ScaffoldRefusal(`refusing to scaffold: ${dir} exists and is not a directory`);
    if (readdirSync(dir).length > 0) {
      throw new ScaffoldRefusal(`refusing to scaffold: ${dir} is not empty — choose a new directory name, or empty this one first`);
    }
  }
  mkdirSync(dir, { recursive: true });

  const name = packageNameFor(dir);
  const written: string[] = [];
  for (const rel of listFiles(templateDir)) {
    const out = scaffoldPathFor(rel);
    const target = join(dir, ...out.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    const source = join(templateDir, ...rel.split("/"));
    const bytes = readFileSync(source);
    const text = bytes.toString("utf8");
    if (text.includes(VERSION_PLACEHOLDER) || text.includes(NAME_PLACEHOLDER)) {
      writeFileSync(target, text.split(VERSION_PLACEHOLDER).join(options.version).split(NAME_PLACEHOLDER).join(name));
    } else {
      copyFileSync(source, target);
    }
    written.push(out);
  }
  return { dir, files: written.sort() };
}

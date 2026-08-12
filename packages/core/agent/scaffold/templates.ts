import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATE_TREES = {
  "subagents/fresh_eyes_review": "agent/subagents/fresh_eyes_review",
} as const;

export type TemplateTreeName = keyof typeof TEMPLATE_TREES;

export interface TemplateFile {
  readonly path: string;
  readonly content: string;
}

export function templatesRoot(fromUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (;;) {
    const candidate = join(dir, "templates");
    if (existsSync(join(dir, "package.json")) && existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not locate the @open-everywhere/core templates/ directory by walking up from ${fileURLToPath(fromUrl)}. ` +
          `A registry install must ship it — check the package's "files" allowlist.`,
      );
    }
    dir = parent;
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function readTemplateTree(name: TemplateTreeName, fromUrl: string = import.meta.url): TemplateFile[] {
  const src = join(templatesRoot(fromUrl), ...name.split("/"));
  if (!existsSync(src)) throw new Error(`Template tree "${name}" is missing from ${templatesRoot(fromUrl)}.`);
  const dest = TEMPLATE_TREES[name];
  return walk(src).map((abs) => ({
    path: `${dest}/${relative(src, abs).split("\\").join("/")}`,
    content: readFileSync(abs, "utf8"),
  }));
}

export function readAllTemplateTrees(fromUrl: string = import.meta.url): TemplateFile[] {
  return (Object.keys(TEMPLATE_TREES) as TemplateTreeName[]).flatMap((n) => readTemplateTree(n, fromUrl));
}

export function templateTreeDrift(appRoot: string, fromUrl: string = import.meta.url): string[] {
  const drift: string[] = [];
  for (const file of readAllTemplateTrees(fromUrl)) {
    const onDisk = resolve(appRoot, file.path);
    if (!existsSync(onDisk)) drift.push(`${file.path}: missing on disk`);
    else if (readFileSync(onDisk, "utf8") !== file.content) drift.push(`${file.path}: differs from the shipped template`);
  }
  return drift;
}

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const APP_DIR = "agent";
export const REGISTRY = "agent/model/stacks.ts";
export const PRICE_TABLE = "agent/spend/model-pricing.ts";
const EXEMPT_DIR_PREFIX = "agent/docs/generated/";

export const VENDORS = [
  "zai", "deepseek", "alibaba", "anthropic", "openai", "google", "meta", "mistral",
  "moonshotai", "qwen", "xai", "cohere", "amazon", "minimax", "perplexity", "inception",
];
export const MODEL_ID = new RegExp(`^(?:${VENDORS.join("|")})/[a-z0-9][a-z0-9.\\-]*$`, "i");

export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export interface BareModelIdHit {
  readonly file: string;
  readonly line: number;
  readonly id: string;
}

export function ruleOneFiles(root: string = "."): string[] {
  let listed: string[];
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", `${APP_DIR}/*.ts`], {
      cwd: root,
      encoding: "utf8",
    });
    listed = out.split("\u0000").filter((p) => p.length > 0);
  } catch (err) {
    throw new Error(
      `\`git ls-files -- ${APP_DIR}/*.ts\` failed in ${root}, so RULE 1 cannot know what to read: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const files = listed
    .filter((file) => !file.startsWith(EXEMPT_DIR_PREFIX))
    .filter((file) => file !== REGISTRY && file !== PRICE_TABLE)
    .sort();
  if (files.length === 0) {
    throw new Error(
      `no git-tracked file under ${APP_DIR}/ is in RULE 1's scope in ${root} (git listed ` +
        `${listed.length}) — refusing to report RULE 1 clean against an unread tree.`,
    );
  }
  return files;
}

export function readAppSource(file: string, root: string = "."): string {
  if (existsSync(join(root, file))) return readFileSync(join(root, file), "utf8");
  return execFileSync("git", ["show", `:${file}`], { cwd: root, encoding: "utf8" });
}

export function scanBareModelIds(files: readonly string[], root: string = "."): BareModelIdHit[] {
  const hits: BareModelIdHit[] = [];
  for (const file of files) {
    const code = stripComments(readAppSource(file, root));
    for (const m of code.matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
      if (!MODEL_ID.test(m[1])) continue;
      hits.push({ file, line: code.slice(0, m.index).split("\n").length, id: m[1] });
    }
  }
  return hits;
}

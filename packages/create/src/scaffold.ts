import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { EOL } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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

export const VERCEL_GITIGNORE_LINES: readonly string[] = [".vercel", ".env*"];

export function withGitignoreEol(text: string, eol: string): string {
  return text.replace(/\r?\n/g, eol);
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

export function isScaffoldableDir(dir: string): boolean {
  return readdirSync(dir).every((name) => name === ".git");
}

export function nestedNameRefusal(target: string, cwd: string): string | undefined {
  const dir = resolve(cwd, target);
  const here = resolve(cwd);
  if (resolve(dir, "..") !== here || basename(dir) !== basename(here)) return undefined;
  if (!isScaffoldableDir(here)) return undefined;
  return [
    `refusing to scaffold: you are inside an empty directory named "${basename(here)}", so this would create ${basename(here)}/${basename(dir)}/.`,
    "To scaffold into this directory, run:",
    "  npx @open-everywhere/create .",
    `To nest the app on purpose, create the directory first (\`mkdir ${basename(dir)}\`), then run this command again.`,
  ].join("\n");
}

export function scaffoldApp(options: {
  readonly targetDir: string;
  readonly version: string;
  readonly templateDir?: string;
  readonly eol?: string;
}): ScaffoldResult {
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
    if (!isScaffoldableDir(dir)) {
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
    if (out === ".gitignore") {
      writeFileSync(target, withGitignoreEol(text, options.eol ?? EOL));
    } else if (text.includes(VERSION_PLACEHOLDER) || text.includes(NAME_PLACEHOLDER)) {
      writeFileSync(target, text.split(VERSION_PLACEHOLDER).join(options.version).split(NAME_PLACEHOLDER).join(name));
    } else {
      copyFileSync(source, target);
    }
    written.push(out);
  }
  return { dir, files: written.sort() };
}

export interface GitInitResult {
  readonly initialized: boolean;
  readonly detail: string;
}

export type GitRunner = (args: readonly string[], cwd: string) => { readonly status: number | null } | undefined;

const realGit: GitRunner = (args, cwd) => {
  const r = spawnSync("git", [...args], { cwd, stdio: "ignore" });
  return r.error !== undefined ? undefined : { status: r.status };
};

export function initGitRepo(dir: string, git: GitRunner = realGit): GitInitResult {
  const version = git(["--version"], dir);
  if (version === undefined || version.status !== 0) return { initialized: false, detail: "git is not on PATH — run `git init` yourself once it is installed" };
  const inside = git(["rev-parse", "--is-inside-work-tree"], dir);
  if (inside !== undefined && inside.status === 0) return { initialized: false, detail: "the directory is already inside a git work tree, so no new repository was made" };
  const init = git(["init", "-q"], dir);
  return init !== undefined && init.status === 0
    ? { initialized: true, detail: "initialised a git repository (nothing committed yet)" }
    : { initialized: false, detail: "`git init` failed — run it yourself" };
}

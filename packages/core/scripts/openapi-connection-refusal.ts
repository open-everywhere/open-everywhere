import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * The `oe build` refusal of an eve OpenAPI connection in an app tree.
 *
 * eve 1.x's `applySecurity` places the resolved connection token where the spec's security scheme
 * says. For an `apiKey` scheme `in: query` or `in: cookie`, the token leaves the `Authorization`
 * header and goes into the request URL or the `Cookie` header. eve returns the target URL of a
 * cross-origin redirect to the model as `location`, and it returns the response body unchanged. So a
 * query-placed token can reach the model. eve offers no per-result transform for a connection, and
 * the spec (often fetched from a URL) is not readable at build time. So `oe build` refuses every eve
 * OpenAPI connection, whatever its scheme. An OpenAPI API mounts as a declared MCP server instead
 * (`agent/access/mcp-servers.ts`), whose connector mount fences each result.
 *
 * eve accepts a connection only when it carries the protocol stamp, a property keyed
 * `Symbol.for("eve.connection-protocol")`. `defineOpenAPIConnection` writes it, and so can any module
 * that names the key. The scan looks for the definer's name or the stamp key in:
 *
 * 1. Every source file under the app's agent directory. That covers the file form and the folder
 *    form under `connections/`, a subagent's `connections/`, a dynamic connection and any helper.
 * 2. The import graph of every module eve can mount a connection from: a file under a
 *    `connections/` or `extensions/` directory anywhere in the agent directory (a subagent has both). A
 *    relative import and a `#` subpath import are followed file by file, inside the agent directory and
 *    out of it. A package import is
 *    followed to the whole package and its dependencies (plain, peer and optional), because a
 *    package can hide the definer behind its own re-export.
 * 3. The package of every connection that the roster mounts (its shim is not written yet on the
 *    first build).
 *
 * The scan skips `eve` (it defines the name) and the `@open-everywhere/*` packages:
 * `test:credential-isolation` fails if an Open Everywhere agent source calls the definer. An import
 * from a followed file (a mount module, or a relative or `#` file it reaches) that does not resolve
 * is refused, because the scan cannot read it. A followed file that names `createRequire` is refused,
 * because the scan cannot follow its loader's calls. Package files are read for the definer only:
 * many packages use `createRequire`, so the scan does not refuse it there.
 *
 * The limit: this is a scan of source text. Five roads escape it:
 * - an import whose specifier is computed at run time;
 * - a definer or a stamp obtained at run time (built from pieces, or copied off another connection);
 * - package code that reaches past the package and its declared dependencies (an undeclared
 *   dependency, or the package's own `createRequire`);
 * - an import that both reads misread (a regex literal that holds `/*`, then an import list whose
 *   comment holds a quote, a backtick, a parenthesis, `;` or `=`);
 * - a deploy step that skips `oe build`.
 */

export const OPENAPI_DEFINER = "defineOpenAPIConnection";

const STAMP_KEY = "eve.connection-protocol";
const DEFINER_RE = new RegExp(`\\b${OPENAPI_DEFINER}\\b|${STAMP_KEY.replace(".", "\\.")}`, "u");
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/u;
const DECLARATION_RE = /\.d\.[cm]?ts$/u;
/**
 * An import or export statement's `from`, a side-effect import, a dynamic import and a `require`. A
 * statement starts a line or follows a `;`. A specifier is a quoted string or a backtick string with
 * no substitution.
 */
const SPECIFIER_RE =
  /(?:(?:^|;)[ \t]*(?:import|export)\b[^;=()'"`]*?\bfrom\s*|(?:^|;)[ \t]*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'`])([^"'`\n$]+)\1/gmu;
const CREATE_REQUIRE_RE = /\bcreateRequire\b/u;
const SKIPPED_PACKAGE_RE = /^(?:eve|@open-everywhere\/[^/]+)$/u;
const BUILTINS = new Set(builtinModules);

export interface OpenApiConnectionFinding {
  /** The file that names the definer, or the package that the scan could not read. */
  readonly where: string;
  readonly why: string;
}

/**
 * Blanks block comments and line comments. A string literal is matched first and kept, so a `//` or a
 * `/*` inside a string blanks nothing. A comment opener after a backslash is not a comment (in valid
 * code a backslash before a real comment can stand only inside a string or a regex literal), so an
 * escaped `\/*` or `\/\/` in a regex blanks nothing either. A regex literal can still misread (an
 * unescaped `/*` inside a character class), so each read pairs this text with a second one: the
 * specifier read takes the raw text, and the definer read takes `withoutWholeLineComments`.
 */
function withoutComments(source: string): string {
  return source.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(?<!\\)\/\*[\s\S]*?\*\/|(?<!\\)\/\/[^\n]*/gu,
    (m: string, literal: string | undefined) => (literal !== undefined ? m : m.replace(/[^\n]/gu, " ")),
  );
}

/**
 * Removes only the lines that are a comment from their first character: `//`, `/*`, or a JSDoc `*`
 * (followed by a space, a `/` or the line end) after the indent. A code line that starts the same way
 * (a continued multiplication such as `* 2`) is removed too, and the stripped read still covers it.
 * A generator method such as `*items()` is kept. A trailing comment that names the definer refuses,
 * which errs towards a refusal.
 */
function withoutWholeLineComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*(?:\s|\/|$))/u.test(line))
    .join("\n");
}

/** A test on both comment-free reads of the text, so a misread of one cannot hide a match. */
function namesIn(re: RegExp, raw: string): boolean {
  return re.test(withoutComments(raw)) || re.test(withoutWholeLineComments(raw));
}

function isSourceFile(name: string): boolean {
  return SOURCE_EXT_RE.test(name) && !DECLARATION_RE.test(name);
}

function sourceFilesUnder(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) sourceFilesUnder(abs, out);
    else if (entry.isFile() && isSourceFile(entry.name)) out.push(abs);
  }
  return out;
}

function specifiersOf(code: string): string[] {
  return [...code.matchAll(SPECIFIER_RE)].map((m) => m[2]!);
}

function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) return undefined;
  if (specifier.startsWith("node:") || BUILTINS.has(specifier) || BUILTINS.has(specifier.split("/")[0]!)) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/u, "");
  const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  // A type-only import can name a declaration file, which holds no runtime code but must resolve.
  const declarations = [".d.ts", ".d.mts", ".d.cts"].map((e) => stem + e);
  const candidates = [base, ...extensions.map((e) => stem + e), ...declarations, ...extensions.map((e) => join(base, `index${e}`))];
  const found = candidates.find((c) => existsSync(c) && statSync(c).isFile());
  if (found !== undefined) return found;
  // A directory with a package.json `main`.
  try {
    const main = (JSON.parse(readFileSync(join(base, "package.json"), "utf8")) as { main?: unknown }).main;
    if (typeof main === "string") return resolveRelative(join(base, "package.json"), `./${main.replace(/^\.\//u, "")}`);
  } catch {
    // no package.json: unresolved
  }
  return undefined;
}

function packageRoot(fromDir: string, name: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

function dependenciesOf(root: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    return [...new Set([pkg.dependencies, pkg.peerDependencies, pkg.optionalDependencies].flatMap((deps) => Object.keys(deps ?? {})))];
  } catch {
    return [];
  }
}

function isMountModule(relToAgent: string): boolean {
  return relToAgent
    .split(sep)
    .slice(0, -1)
    .some((segment) => segment === "connections" || segment === "extensions");
}

/** The nearest package.json above `fromDir`, with its directory. */
function nearestPackage(fromDir: string): { dir: string; json: { imports?: Record<string, unknown> } } | undefined {
  let dir = fromDir;
  for (;;) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      try {
        return { dir, json: JSON.parse(readFileSync(file, "utf8")) as { imports?: Record<string, unknown> } };
      } catch {
        return undefined;
      }
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * Every string leaf of an `imports` entry. Node picks one condition by the key order and the active
 * conditions. The scan follows all of them, a superset that needs no condition model.
 */
function importTargets(entry: unknown): string[] {
  if (typeof entry === "string") return [entry];
  if (entry === null || typeof entry !== "object") return [];
  return Object.values(entry as Record<string, unknown>).flatMap(importTargets);
}

/**
 * A `#` subpath import, through the nearest package.json `imports` map (exact or one `*`). It
 * returns every target the entry can lead to, or an empty list when the specifier does not resolve.
 */
function resolveSubpathImport(fromFile: string, specifier: string): { file?: string; bare?: string; dir?: string }[] {
  const pkg = nearestPackage(dirname(fromFile));
  const map = pkg?.json.imports;
  if (pkg === undefined || map === undefined) return [];
  let targets = Object.hasOwn(map, specifier) ? importTargets(map[specifier]) : [];
  if (targets.length === 0) {
    // Node takes the longest matching prefix, and on a tie the longer key, so the scan does too.
    const patterns = Object.entries(map).sort(([a], [b]) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
    for (const [key, entry] of patterns) {
      const star = key.indexOf("*");
      if (star < 0 || !specifier.startsWith(key.slice(0, star)) || !specifier.endsWith(key.slice(star + 1))) continue;
      const hole = specifier.slice(star, specifier.length - (key.length - star - 1));
      targets = importTargets(entry).map((t) => t.replaceAll("*", hole));
      if (targets.length > 0) break;
    }
  }
  const out: { file?: string; bare?: string; dir?: string }[] = [];
  for (const target of targets) {
    if (!target.startsWith(".")) {
      out.push({ bare: target, dir: pkg.dir });
      continue;
    }
    const file = resolveRelative(join(pkg.dir, "package.json"), target);
    if (file !== undefined) out.push({ file });
  }
  return out;
}

/**
 * Every place in the app tree that can mount an eve OpenAPI connection. An empty list means the app
 * mounts none. `rosterConnectionPackages` names the package of each connection the roster mounts.
 */
export function openApiConnectionFindings(appRoot: string, agentDir: string, rosterConnectionPackages: readonly string[] = []): OpenApiConnectionFinding[] {
  const findings: OpenApiConnectionFinding[] = [];
  const agentRoot = join(appRoot, agentDir);
  const show = (abs: string): string => relative(appRoot, abs).split(sep).join("/");
  // One read per file, keyed by its real path. Each file is scanned for the definer once and has
  // its imports followed once, whichever pass reaches it first.
  const read = new Map<string, string>();
  const followed = new Set<string>();
  const seenPackages = new Set<string>();
  const queue: string[] = [];

  const scanFile = (abs: string, strip: boolean): { real: string; raw: string } | undefined => {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return undefined;
    }
    const known = read.get(real);
    if (known !== undefined) return { real, raw: known };
    // A byte-order mark would hide a statement on the first line from the anchor.
    const raw = readFileSync(real, "utf8").replace(/^\uFEFF/u, "");
    read.set(real, raw);
    if (strip ? namesIn(DEFINER_RE, raw) : DEFINER_RE.test(raw)) {
      findings.push({ where: show(abs), why: `names \`${OPENAPI_DEFINER}\` or the eve connection stamp \`${STAMP_KEY}\`` });
    }
    return { real, raw };
  };

  const followPackage = (fromDir: string, name: string, via: string, required: boolean): void => {
    if (SKIPPED_PACKAGE_RE.test(name)) return;
    const root = packageRoot(fromDir, name);
    if (root === undefined) {
      if (required) {
        findings.push({
          where: name,
          why: `is imported by ${via} and does not resolve as an installed package, so the scan cannot read whether it defines an eve OpenAPI connection (a bundler or tsconfig path alias is not read: import the file by a relative path)`,
        });
      }
      return;
    }
    if (seenPackages.has(root)) return;
    seenPackages.add(root);
    for (const file of sourceFilesUnder(root)) scanFile(file, false);
    for (const dep of dependenciesOf(root)) followPackage(root, dep, name, false);
  };

  const unreadable = (specifier: string, abs: string, how: string): void => {
    findings.push({ where: specifier, why: `is imported by ${show(abs)} and does not resolve ${how}, so the scan cannot read it` });
  };

  const follow = (abs: string): void => {
    const file = scanFile(abs, true);
    if (file === undefined || followed.has(file.real)) return;
    followed.add(file.real);
    // A loader the regex cannot name: the scan cannot see what it loads, so it refuses the file.
    if (namesIn(CREATE_REQUIRE_RE, file.raw)) {
      findings.push({ where: show(abs), why: "loads modules through `createRequire`, whose calls the scan cannot follow" });
    }
    // The union of the raw and the comment-stripped text: a comment inside a multi-line import list
    // hides the statement from the raw read, and a misread comment can hide it from the stripped read.
    // A spare specifier only adds a follow or a refusal.
    for (const specifier of new Set([...specifiersOf(file.raw), ...specifiersOf(withoutComments(file.raw))])) {
      if (specifier.startsWith("#")) {
        const targets = resolveSubpathImport(abs, specifier);
        if (targets.length === 0) unreadable(specifier, abs, "through a package.json `imports` map");
        for (const target of targets) {
          if (target.file !== undefined) queue.push(target.file);
          else if (target.bare !== undefined) {
            const name = packageNameOf(target.bare);
            if (name !== undefined) followPackage(target.dir!, name, show(abs), true);
          }
        }
        continue;
      }
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const target = resolveRelative(abs, specifier);
        if (target !== undefined) queue.push(target);
        else unreadable(specifier, abs, "to a file");
        continue;
      }
      const name = packageNameOf(specifier);
      if (name !== undefined) followPackage(dirname(abs), name, show(abs), true);
    }
  };

  const agentFiles = sourceFilesUnder(agentRoot);
  for (const abs of agentFiles) scanFile(abs, true);
  for (const abs of agentFiles) if (isMountModule(relative(agentRoot, abs))) follow(abs);
  while (queue.length > 0) follow(queue.pop()!);
  for (const name of rosterConnectionPackages) followPackage(appRoot, name, "a roster connection", true);
  return findings;
}

/** The `oe build` refusal text for the findings. */
export function openApiConnectionRefusal(findings: readonly OpenApiConnectionFinding[]): string[] {
  return [
    `✗ oe build: the app can mount an eve OpenAPI connection (${findings.length} finding(s)) — NOTHING was written.`,
    ...findings.map((f) => `  - ${f.where} ${f.why}`),
    "",
    "  eve places an OpenAPI connection's token where the spec's security scheme says. A query or cookie",
    "  placement can return the token to the model (a cross-origin redirect's `location`, or an echoed URL).",
    "  Open Everywhere keeps every credential away from the model, so it refuses this connection form.",
    "  Mount the API as a declared MCP server in agent/access/mcp-servers.ts instead. See",
    "  docs/security/credentials-and-planes.md.",
  ];
}

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative } from "node:path";

import { parseSync, Visitor } from "oxc-parser";

import { toPosixPath } from "./posix-path.js";

const MODULE_FILE = /\.(?:mjs|cjs|js)$/;
const PLAIN_STRING = /^(["'`])([^"'`$\\]*)\1$/;

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function isBare(specifier: string): boolean {
  if (specifier === "" || specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (specifier.startsWith("#")) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(specifier);
}

const REQUIRE_CALLEES = new Set(["require", "__require"]);

function moduleFilesOf(dir: string, seen = new Set<string>()): string[] {
  const real = realpathSync(dir);
  if (seen.has(real)) return [];
  seen.add(real);
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    const linkedDir =
      entry.isSymbolicLink() && statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
    const isDir = entry.isDirectory() || linkedDir;
    if (isDir) out.push(...moduleFilesOf(path, seen));
    else if (MODULE_FILE.test(entry.name)) out.push(path);
  }
  return out.sort();
}

function importSpecifiersOf(
  fileName: string,
  source: string,
): { specifiers: Set<string>; error?: string } {
  const sourceType = fileName.endsWith(".mjs") ? "module" : "unambiguous";
  const { module, program, errors } = parseSync(fileName, source, { lang: "js", sourceType });
  const specifiers = new Set<string>();
  if (errors.length > 0) return { specifiers, error: errors[0]?.message ?? "parse error" };
  for (const i of module.staticImports) specifiers.add(i.moduleRequest.value);
  for (const e of module.staticExports) {
    for (const entry of e.entries) if (entry.moduleRequest) specifiers.add(entry.moduleRequest.value);
  }
  for (const d of module.dynamicImports) {
    const literal = PLAIN_STRING.exec(source.slice(d.moduleRequest.start, d.moduleRequest.end));
    if (literal?.[2] !== undefined) specifiers.add(literal[2]);
  }
  new Visitor({
    CallExpression(call) {
      const [arg, ...rest] = call.arguments;
      if (call.callee.type !== "Identifier" || !REQUIRE_CALLEES.has(call.callee.name)) return;
      if (rest.length !== 0) return;
      if (arg?.type === "Literal" && typeof arg.value === "string") specifiers.add(arg.value);
      const quasi =
        arg?.type === "TemplateLiteral" && arg.expressions.length === 0 ? arg.quasis[0] : undefined;
      if (typeof quasi?.value.cooked === "string") specifiers.add(quasi.value.cooked);
    },
  }).visit(program);
  return { specifiers };
}

function resolvesInside(funcDir: string, fromDir: string, pkg: string): boolean {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", pkg))) return true;
    if (dir === funcDir || relative(funcDir, dir).startsWith("..")) return false;
  }
}

export interface OutputScan {
  failures: string[];
  checkedImports: number;
  checkedFiles: number;
}

export function outputImportFailures(funcDir: string, label: string): OutputScan {
  const scan: OutputScan = { failures: [], checkedImports: 0, checkedFiles: 0 };
  if (!existsSync(join(funcDir, "index.mjs"))) {
    scan.failures.push(`${label}: no index.mjs`);
    return scan;
  }
  const realFunc = realpathSync(funcDir);
  const judged = new Set<string>();
  for (const file of moduleFilesOf(funcDir)) {
    const where = `${label}/${toPosixPath(relative(funcDir, file))}`;
    const realFile = existsSync(file) ? realpathSync(file) : undefined;
    if (realFile === undefined) {
      scan.failures.push(`${where}: is a dangling link, so its imports are not judged.`);
      continue;
    }
    if (judged.has(realFile)) continue;
    judged.add(realFile);
    scan.checkedFiles += 1;
    if (relative(realFunc, realFile).startsWith("..")) {
      scan.failures.push(`${where}: links outside the function directory, so it is not shipped.`);
      continue;
    }
    const { specifiers, error } = importSpecifiersOf(file, readFileSync(realFile, "utf8"));
    if (error !== undefined) {
      scan.failures.push(`${where}: cannot be parsed, so its imports are not judged — ${error}`);
      continue;
    }
    for (const spec of specifiers) {
      if (!isBare(spec) || isBuiltin(spec)) continue;
      scan.checkedImports += 1;
      if (resolvesInside(realFunc, dirname(realFile), packageNameOf(spec))) continue;
      scan.failures.push(
        `${where}: "${spec}" is imported but not present in ${label}/node_modules — cold-start crash.`,
      );
    }
  }
  return scan;
}

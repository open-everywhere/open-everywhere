import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative } from "node:path";

import { parseSync } from "oxc-parser";

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

type AstNode = { type: string; start: number; [key: string]: unknown };

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

const DEFERRED_SCOPE = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassBody",
]);

function childrenOf(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) {
      for (const v of value) if (isNode(v)) out.push(v);
    } else if (isNode(value)) out.push(value);
  }
  return out;
}

function throwsInScope(node: AstNode): boolean {
  if (node.type === "ThrowStatement") return true;
  if (DEFERRED_SCOPE.has(node.type)) return false;
  return childrenOf(node).some(throwsInScope);
}

function requireSpecifierOf(call: AstNode): string | undefined {
  const callee = call.callee as AstNode;
  const args = call.arguments as AstNode[];
  if (callee.type !== "Identifier" || !REQUIRE_CALLEES.has(callee.name as string)) return undefined;
  if (args.length !== 1) return undefined;
  const [arg] = args as [AstNode];
  if (arg.type === "Literal" && typeof arg.value === "string") return arg.value;
  const quasis = arg.quasis as { value: { cooked?: unknown } }[] | undefined;
  if (arg.type === "TemplateLiteral" && (arg.expressions as unknown[]).length === 0) {
    const cooked = quasis?.[0]?.value.cooked;
    if (typeof cooked === "string") return cooked;
  }
  return undefined;
}

function loadsOf(program: AstNode): {
  required: { spec: string; guarded: boolean }[];
  guardedImportStarts: Set<number>;
} {
  const required: { spec: string; guarded: boolean }[] = [];
  const guardedImportStarts = new Set<number>();
  const walk = (node: AstNode, guarded: boolean, parent: AstNode | undefined): void => {
    if (DEFERRED_SCOPE.has(node.type)) guarded = false;
    if (node.type === "CallExpression") {
      const spec = requireSpecifierOf(node);
      if (spec !== undefined) required.push({ spec, guarded });
    }
    if (node.type === "ImportExpression" && guarded && parent?.type === "AwaitExpression") {
      guardedImportStarts.add(node.start);
    }
    if (node.type === "TryStatement") {
      const handler = node.handler as AstNode | null;
      const guards = handler !== null && !throwsInScope(handler);
      walk(node.block as AstNode, guarded || guards, node);
      if (handler !== null) walk(handler, guarded, node);
      if (isNode(node.finalizer)) walk(node.finalizer, guarded, node);
      return;
    }
    const through = node.type === "ParenthesizedExpression" ? parent : node;
    for (const child of childrenOf(node)) walk(child, guarded, through);
  };
  walk(program, false, undefined);
  return { required, guardedImportStarts };
}

function importSpecifiersOf(
  fileName: string,
  source: string,
): { specifiers: Set<string>; guarded: Set<string>; error?: string } {
  const sourceType = fileName.endsWith(".mjs") ? "module" : "unambiguous";
  const { module, program, errors } = parseSync(fileName, source, { lang: "js", sourceType });
  const specifiers = new Set<string>();
  const guarded = new Set<string>();
  if (errors.length > 0) return { specifiers, guarded, error: errors[0]?.message ?? "parse error" };
  for (const i of module.staticImports) specifiers.add(i.moduleRequest.value);
  for (const e of module.staticExports) {
    for (const entry of e.entries) if (entry.moduleRequest) specifiers.add(entry.moduleRequest.value);
  }
  const { required, guardedImportStarts } = loadsOf(program as unknown as AstNode);
  for (const d of module.dynamicImports) {
    const literal = PLAIN_STRING.exec(source.slice(d.moduleRequest.start, d.moduleRequest.end));
    if (literal?.[2] === undefined) continue;
    (guardedImportStarts.has(d.start) ? guarded : specifiers).add(literal[2]);
  }
  for (const r of required) (r.guarded ? guarded : specifiers).add(r.spec);
  for (const spec of specifiers) guarded.delete(spec);
  return { specifiers, guarded };
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
  guardedImports: number;
  guardedNotes: string[];
}

export function outputImportFailures(funcDir: string, label: string): OutputScan {
  const scan: OutputScan = {
    failures: [],
    checkedImports: 0,
    checkedFiles: 0,
    guardedImports: 0,
    guardedNotes: [],
  };
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
    const { specifiers, guarded, error } = importSpecifiersOf(file, readFileSync(realFile, "utf8"));
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
    for (const spec of guarded) {
      if (!isBare(spec) || isBuiltin(spec)) continue;
      scan.guardedImports += 1;
      if (resolvesInside(realFunc, dirname(realFile), packageNameOf(spec))) continue;
      scan.guardedNotes.push(`${where}: "${spec}" is absent, but a catch guards its load.`);
    }
  }
  return scan;
}

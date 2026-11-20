// One printer for a function's source, whichever runner loaded the function.
//
// `fn.toString()` returns the text the RUNNER produced, not the authored text. The runners differ:
//
// * `tsx` prints through esbuild with `minifyWhitespace` and `keepNames`: `r=>r.id`, no statement
//   semicolons, non-ASCII escaped, every named inner function wrapped in `__name(fn,"name")` (or
//   followed by a `__name(fn,"name");` statement for a declaration), and a dynamic import as
//   `import(x).then(s=>{const e="default";…})`, its CommonJS interop.
// * vite's SSR transform (the batched chain, `npm run test:suites`) keeps the authored layout:
//   `(r) => r.id`, an imported binding as `__vite_ssr_import_N__.name` (called as
//   `(0,__vite_ssr_import_N__.name)(…)`), a dynamic import as `__vite_ssr_dynamic_import__(…)`,
//   and an extra `;` after some blocks.
//
// `printedSource` removes the runner's own additions (the `__name` wrappers, the SSR import
// namespaces, the stray empty statements) with an AST pass, then prints the result once through
// esbuild with tsx's whitespace setting. Both runners therefore give the same text, and that text is
// the tsx shape the source pins are written against.
//
// Three import shapes stay apart under vite. No scenario body uses one today (every scenario prints
// the same text under both runners), and each one fails loud rather than weaken a pin:
// * an aliased import (`import { a as b }`) prints as `b` under tsx but as `a` under vite, because
//   the SSR namespace keeps the export name, so a pin that names the binding fails under one runner;
// * a default import prints as `__vite_ssr_import_N__.default`, which rewrites to `default` and
//   then refuses to parse;
// * a namespace import (`import * as ns`) prints a member read `ns.x` as `__vite_ssr_import_N__.x`,
//   which rewrites to `x`: the aliased-import case again, so a pin that names `ns.x` fails under
//   vite. Only a bare `ns` keeps `__vite_ssr_import_N__`, which the leg's residue pin refuses.

import { transformSync } from "esbuild";
import { parseSync } from "oxc-parser";

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

const SSR_NAMESPACE = /^__vite_ssr_import_\d+__$/u;

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

// `__vite_ssr_import_N__.name` → `name`. A computed or private member is not an import read.
function ssrImportName(node: AstNode): string | undefined {
  if (node.type !== "MemberExpression" || node.computed === true) return undefined;
  const object = node.object as AstNode;
  const property = node.property as AstNode;
  if (object.type !== "Identifier" || !SSR_NAMESPACE.test(object.name as string)) return undefined;
  if (property.type !== "Identifier") return undefined;
  return property.name as string;
}

function unwrapParens(node: AstNode): AstNode {
  return node.type === "ParenthesizedExpression" ? unwrapParens(node.expression as AstNode) : node;
}

// tsx's interop callback on a dynamic import, as its own printer writes it (any parameter name).
const TSX_IMPORT_INTEROP = /^(\w+)=>\{const (\w+)="default";return \1\[\2\]&&typeof \1\[\2\]=="object"&&"__esModule"in \1\[\2\]\?\1\[\2\]:\1\}$/u;

function isKeepNamesCall(node: AstNode): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee as AstNode;
  const args = node.arguments as AstNode[];
  return callee.type === "Identifier" && callee.name === "__name" && args.length === 2 && args[1]!.type === "Literal";
}

function collectEdits(node: AstNode, edits: Edit[], source: string): void {
  // `function f(){…}__name(f,"f");` → drop the statement: keepNames' marker on a declaration.
  if (node.type === "ExpressionStatement" && isKeepNamesCall(node.expression as AstNode)) {
    const target = ((node.expression as AstNode).arguments as AstNode[])[0]!;
    if (target.type === "Identifier") {
      edits.push({ start: node.start, end: node.end, text: "" });
      return;
    }
  }
  // `import(x).then(<interop>)` → `import(x)`.
  if (node.type === "CallExpression") {
    const callee = node.callee as AstNode;
    const args = node.arguments as AstNode[];
    const target = callee.type === "MemberExpression" && callee.computed !== true ? (callee.object as AstNode) : undefined;
    if (
      target !== undefined &&
      target.type === "ImportExpression" &&
      (callee.property as AstNode).name === "then" &&
      args.length === 1 &&
      TSX_IMPORT_INTEROP.test(source.slice(args[0]!.start, args[0]!.end))
    ) {
      edits.push({ start: target.end, end: node.end, text: "" });
      collectEdits(target, edits, source);
      return;
    }
  }
  // `(0, __vite_ssr_import_N__.name)` → `name`: the SSR transform's unbound call of an import.
  if (node.type === "SequenceExpression") {
    const items = node.expressions as AstNode[];
    const first = items[0];
    const last = items.length === 2 ? ssrImportName(unwrapParens(items[1]!)) : undefined;
    if (first !== undefined && first.type === "Literal" && first.value === 0 && last !== undefined) {
      edits.push({ start: node.start, end: node.end, text: last });
      return;
    }
  }
  const imported = ssrImportName(node);
  if (imported !== undefined) {
    edits.push({ start: node.start, end: node.end, text: imported });
    return;
  }
  if (node.type === "Identifier" && node.name === "__vite_ssr_dynamic_import__") {
    edits.push({ start: node.start, end: node.end, text: "import" });
    return;
  }
  // `__name(fn, "name")` → `fn`: tsx's keepNames wrapper. Keep the inner function and walk into it.
  if (isKeepNamesCall(node)) {
    const inner = (node.arguments as AstNode[])[0]!;
    edits.push({ start: node.start, end: inner.start, text: "" });
    edits.push({ start: inner.end, end: node.end, text: "" });
    collectEdits(inner, edits, source);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "type") continue;
    if (Array.isArray(value)) {
      // A stray `;` in a statement list (vite's extra one after a block) → drop it. An empty
      // statement as a loop or `if` body is no array item, so it stays.
      const statements = key === "body" || key === "consequent";
      for (const item of value) {
        if (!isNode(item)) continue;
        if (statements && item.type === "EmptyStatement") edits.push({ start: item.start, end: item.end, text: "" });
        else collectEdits(item, edits, source);
      }
    } else if (isNode(value)) {
      collectEdits(value, edits, source);
    }
  }
}

/** The runner-independent printed source of `fn` (or of a source text a runner printed). */
export function printedSource(fn: ((...args: never[]) => unknown) | string): string {
  const printed = typeof fn === "string" ? fn : fn.toString();
  // Parse the text as one expression. A method shorthand (`run(ctx) {…}`) is no expression, so it
  // throws here rather than print wrongly; every SCENARIOS `run` is an arrow function.
  const wrapped = `(${printed});`;
  const parsed = parseSync("printed-source.js", wrapped, { preserveParens: true }) as unknown as {
    program: AstNode;
    errors: readonly { message: string }[];
  };
  if (parsed.errors.length > 0) throw new Error(`printedSource: the runner's text does not parse as an expression: ${parsed.errors[0]!.message}`);
  const edits: Edit[] = [];
  collectEdits(parsed.program, edits, wrapped);
  edits.sort((a, b) => b.start - a.start);
  let text = wrapped;
  for (const edit of edits) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  const out = transformSync(text, { loader: "js", minifyWhitespace: true, target: `node${process.versions.node}` }).code;
  if (!out.startsWith("(") || !out.endsWith(");\n")) throw new Error(`printedSource: unexpected print shape: ${out.slice(0, 80)}`);
  return out.slice(1, -3);
}

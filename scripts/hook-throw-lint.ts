import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const HOOKS_DIR = join(repoRoot, "packages", "core", "agent", "hooks");

export const MIN_PLAUSIBLE_HOOK_FILES = 20;

export const MARKER = /hook-throw:\s*(CONTROL|DEFECT|INTERNAL\(([A-Za-z_$][\w$]*)\))/;

export const REFUSAL_MARKER = /hook-path:\s*REFUSAL\b/;

export const OPTIONAL_WRAPPER = "optional";

export const PENDING_CONVERSION: readonly { readonly file: string; readonly ticket: string; readonly why: string }[] = [];

export interface HookThrowFinding {
  readonly rule: "unclassified" | "control" | "stale-pending-row" | "internal-unproven" | "optional-unwrapped" | "refusal-without-cancel" | "events-unreadable";
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

export interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

export interface ParsedSource {
  readonly program: AstNode;
  readonly comments: readonly { readonly start: number; readonly end: number }[];
}

export function parseSource(source: string, fileName = "source.ts"): ParsedSource {
  const lang = /\.[cm]?tsx$/.test(fileName) ? "tsx" : "ts";
  const { program, comments, errors } = parseSync(fileName, source, { lang, sourceType: "module" });
  if (errors.length > 0) throw new SyntaxError(`${fileName}: the parser cannot read this file: ${errors[0]!.message}`);
  return { program: program as unknown as AstNode, comments };
}

export function childNodes(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const key in node) {
    if (key === "parent") continue;
    const value = node[key];
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const v of value) if (v !== null && typeof v === "object" && typeof v.type === "string") out.push(v as AstNode);
    } else if (typeof (value as { type?: unknown }).type === "string") out.push(value as AstNode);
  }
  return out;
}

function isBlankedText(node: AstNode): boolean {
  if (node.type === "TemplateLiteral" || node.type === "TSTemplateLiteralType" || node.type === "JSXText") return true;
  return node.type === "Literal" && (typeof node.value === "string" || node.regex !== undefined);
}

export function blankCommentsAndStrings(source: string, parsed: ParsedSource = parseSource(source)): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  for (const c of parsed.comments) blank(c.start, c.end);
  const walk = (node: AstNode): void => {
    if (isBlankedText(node)) blank(node.start, node.end);
    else for (const child of childNodes(node)) walk(child);
  };
  walk(parsed.program);
  return out.join("");
}

export function catchesInSameFile(code: string, name: string): boolean {
  const decl = new RegExp(`(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\b)`).exec(code);
  if (decl === null) return false;
  const open = code.indexOf("{", decl.index);
  if (open === -1) return false;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return /\bcatch\b/.test(code.slice(open, i));
    }
  }
  return false;
}

function markerScope(lines: readonly string[], line: number): string {
  const parts: string[] = [lines[line - 1] ?? ""];
  for (let n = line - 1; n >= 1; n--) {
    const text = (lines[n - 1] ?? "").trim();
    if (text === "") continue;
    if (!text.startsWith("//") && !text.startsWith("*") && !text.startsWith("/*")) break;
    parts.push(text);
  }
  return parts.join("\n");
}

export function hookThrowFindings(
  files: readonly { readonly file: string; readonly source: string }[],
  pending: readonly { readonly file: string; readonly ticket: string; readonly why: string }[] = PENDING_CONVERSION,
): readonly HookThrowFinding[] {
  const findings: HookThrowFinding[] = [];
  const pendingByFile = new Map(pending.map((p) => [p.file, p]));
  const pendingHit = new Set<string>();

  for (const { file, source } of files) {
    const code = blankCommentsAndStrings(source, parseSource(source, file)).split("\n");
    const raw = source.split("\n");
    for (let n = 0; n < code.length; n++) {
      if (!/\bthrow\b/.test(code[n] ?? "")) continue;
      const line = n + 1;
      const marked = MARKER.exec(markerScope(raw, line));
      if (marked?.[1] === "DEFECT") continue;
      if (marked?.[2] !== undefined) {
        const catcher = marked[2];
        if (catchesInSameFile(code.join("\n"), catcher)) continue;
        findings.push({
          rule: "internal-unproven",
          file,
          line,
          detail:
            `classified INTERNAL(${catcher}), but this file declares no \`${catcher}\` whose own body carries a ` +
            `\`catch\`. An INTERNAL throw is only internal while something in the module really catches it; ` +
            `otherwise it reaches eve's dispatcher and is swallowed`,
        });
        continue;
      }
      if (marked?.[1] === "CONTROL") {
        findings.push({
          rule: "control",
          file,
          line,
          detail:
            `classified CONTROL. On eve 1.x a throw from a hook does stop the turn, but as a FAILED turn ` +
            `with an error, not as a refusal: no \`hook.refused\` row names the hook or the reason. Call ` +
            `refuseTurn (agent/hooks/control-refusal.ts), which cancels the turn, and delete the marker`,
        });
        continue;
      }
      const owner = pendingByFile.get(file);
      if (owner !== undefined) {
        pendingHit.add(file);
        continue;
      }
      findings.push({
        rule: "unclassified",
        file,
        line,
        detail:
          `an unclassified throw in a hook module. On eve 1.x an uncaught hook throw FAILS the running ` +
          `turn. If it exists to STOP a turn, call refuseTurn (agent/hooks/control-refusal.ts) instead. ` +
          `If it is a bug path, mark it \`// hook-throw: DEFECT — <why>\``,
      });
    }
  }

  for (const row of pending) {
    if (pendingHit.has(row.file)) continue;
    findings.push({
      rule: "stale-pending-row",
      file: row.file,
      line: 0,
      detail:
        `PENDING_CONVERSION names ${row.file} for ${row.ticket}, but the file carries no unclassified ` +
        `throw any more. Delete the row — a hand-over table that outlives its work exempts a file nobody ` +
        `is still converting`,
    });
  }

  return findings;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function propertyName(node: AstNode): string | undefined {
  const key = node.key as AstNode | undefined;
  if (key === undefined) return undefined;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

function eventsObjects(program: AstNode): { readonly at: number; readonly events: AstNode | undefined }[] {
  const out: { at: number; events: AstNode | undefined }[] = [];
  const walk = (node: AstNode): void => {
    if (node.type === "CallExpression") {
      const callee = node.callee as AstNode;
      if (callee.type === "Identifier" && callee.name === "defineHook") {
        const arg = (node.arguments as AstNode[])[0];
        const prop =
          arg?.type === "ObjectExpression"
            ? (arg.properties as AstNode[]).find((p) => p.type === "Property" && propertyName(p) === "events")
            : undefined;
        const value = prop?.value as AstNode | undefined;
        out.push({ at: node.start, events: value?.type === "ObjectExpression" ? value : undefined });
      }
    }
    for (const child of childNodes(node)) walk(child);
  };
  walk(program);
  return out;
}

export function importsOptional(source: string): boolean {
  return new RegExp(`import\\s*\\{[^}]*\\b${OPTIONAL_WRAPPER}\\b[^}]*\\}\\s*from\\s*["']\\./control-refusal\\.js["']`).test(source);
}

export function hookPathFindings(files: readonly { readonly file: string; readonly source: string }[]): readonly HookThrowFinding[] {
  const findings: HookThrowFinding[] = [];
  for (const { file, source } of files) {
    const parsed = parseSource(source, file);
    const raw = source.split("\n");
    const code = blankCommentsAndStrings(source, parsed);
    const wrapperImported = importsOptional(source);
    const cancels = /\brefuseTurn\s*\(|\.cancel\s*\(/.test(code);
    for (const { at, events } of eventsObjects(parsed.program)) {
      if (events === undefined) {
        findings.push({
          rule: "events-unreadable",
          file,
          line: lineAt(source, at),
          detail: "defineHook is called without an object literal under `events`, so no handler can be classified. Write the handlers inline",
        });
        continue;
      }
      for (const prop of events.properties as AstNode[]) {
        const line = lineAt(source, prop.start);
        const name = prop.type === "Property" && prop.computed !== true ? propertyName(prop) : undefined;
        if (name === undefined) {
          findings.push({ rule: "events-unreadable", file, line, detail: "a spread or computed handler key cannot be classified. Write each handler under its own literal key" });
          continue;
        }
        const value = prop.value as AstNode;
        const callee = value.type === "CallExpression" ? (value.callee as AstNode) : undefined;
        if (callee?.type === "Identifier" && callee.name === OPTIONAL_WRAPPER && wrapperImported) continue;
        if (REFUSAL_MARKER.test(markerScope(raw, line))) {
          if (cancels) continue;
          findings.push({
            rule: "refusal-without-cancel",
            file,
            line,
            detail:
              `the "${name}" handler is marked REFUSAL, but this file never calls refuseTurn or ctx.cancel(). ` +
              `A REFUSAL path stops the turn: give it the refusal, or drop the marker and wrap it in ${OPTIONAL_WRAPPER}(...)`,
          });
          continue;
        }
        findings.push({
          rule: "optional-unwrapped",
          file,
          line,
          detail:
            `the "${name}" handler is OPTIONAL (it carries no \`// hook-path: REFUSAL — <why>\` marker), but it is not ` +
            `wrapped in ${OPTIONAL_WRAPPER}(...) from ./control-refusal.js. On eve 1.x an uncaught error or rejected await ` +
            `in a hook FAILS the running turn, so optional work such as metrics, audit rows or best-effort records must catch it`,
        });
      }
    }
  }
  return findings;
}

export function readHookFiles(dir: string = HOOKS_DIR): readonly { readonly file: string; readonly source: string }[] {
  const out: { file: string; source: string }[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at).sort()) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith("-test.ts")) continue;
      out.push({ file: relative(dir, full), source: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return out;
}

function main(): void {
  const files = readHookFiles();
  if (files.length < MIN_PLAUSIBLE_HOOK_FILES) {
    console.error(
      `✗ lint:hook-throw scanned only ${files.length} hook file(s), below the floor of ${MIN_PLAUSIBLE_HOOK_FILES}. ` +
        `The scan is broken, not the tree empty — check that ${relative(repoRoot, HOOKS_DIR)} still exists. ` +
        `Refusing to report "no findings" on an empty scan.`,
    );
    process.exit(1);
  }
  const findings = [...hookThrowFindings(files), ...hookPathFindings(files)];
  if (findings.length > 0) {
    console.error(`✗ lint:hook-throw: ${findings.length} finding(s) across ${files.length} hook file(s)\n`);
    for (const f of findings) {
      const where = f.line > 0 ? `packages/core/agent/hooks/${f.file}:${f.line}` : f.file;
      console.error(`  [${f.rule}] ${where}\n      ${f.detail}\n`);
    }
    process.exit(1);
  }
  const pendingNote = PENDING_CONVERSION.map((p) => `${p.file} (${p.ticket})`).join(", ");
  console.log(
    `✓ lint:hook-throw: ${files.length} hook files scanned, no unclassified or CONTROL throw, and every handler is ` +
      `wrapped in ${OPTIONAL_WRAPPER}(...) or marked REFUSAL. ` +
      `Pending conversion by another ticket: ${pendingNote || "none"}.`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main();

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_ROAD_NAMES, SCAN_PATHSPECS, isGeneratedManualModule } from "./audit-action-scan-lib.js";
import { type AstNode, type ParsedSource, blankCommentsAndStrings, childNodes, parseSource } from "./hook-throw-lint.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const MIN_PLAUSIBLE_WRITES = 600;

const ERROR_KEY = /^(?:err|error\w*|[a-z]\w*Error\w*)$/;

const NOT_A_WRITE = new Set(["auditErrorDetail", "auditErrorFrames", "readAudit", "scrubAuditText", "scrubForAudit"]);

export const BRAND_MINT_FILE = "packages/core/agent/audit/tool-action.ts";

const BRAND_TYPES: ReadonlySet<string> = new Set(["ScrubbedAuditText", "AuditDetail", "AuditDetailBuilder"]);

export function brandCasts(parsed: ParsedSource, source: string): Array<{ readonly at: number; readonly value: string }> {
  const out: Array<{ readonly at: number; readonly value: string }> = [];
  const nameOf = (n: unknown): string | undefined => {
    const node = n as { readonly type?: string; readonly name?: string; readonly right?: unknown } | null | undefined;
    if (node?.type === "Identifier") return node.name;
    if (node?.type === "TSQualifiedName") return nameOf(node.right);
    if (node?.type === "Literal" && typeof (node as { readonly value?: unknown }).value === "string") return (node as { readonly value: string }).value;
    return undefined;
  };
  const brandNames = new Set(BRAND_TYPES);
  for (const top of (parsed.program.body as readonly AstNode[] | undefined) ?? []) {
    const statement = top.type === "ExportNamedDeclaration" && top.declaration ? (top.declaration as AstNode) : top;
    if (statement.type === "TSImportEqualsDeclaration") {
      const local = nameOf(statement.id);
      if (BRAND_TYPES.has(nameOf(statement.moduleReference) ?? "") && local !== undefined) brandNames.add(local);
      continue;
    }
    if (statement.type !== "ImportDeclaration") continue;
    for (const spec of (statement.specifiers as readonly AstNode[] | undefined) ?? []) {
      const local = nameOf(spec.local);
      if (spec.type === "ImportSpecifier" && BRAND_TYPES.has(nameOf(spec.imported) ?? "") && local !== undefined) brandNames.add(local);
    }
  }
  const namesBrand = (type: AstNode): boolean => {
    if (type.type === "TSTypeReference" && brandNames.has(nameOf(type.typeName) ?? "")) return true;
    if (type.type === "TSImportType" && BRAND_TYPES.has(nameOf(type.qualifier) ?? "")) return true;
    return childNodes(type).some(namesBrand);
  };
  const walk = (node: AstNode): void => {
    if (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") {
      const type = node.typeAnnotation as AstNode;
      if (namesBrand(type)) {
        const text = source.slice(type.start, type.end);
        out.push({ at: node.type === "TSAsExpression" ? type.start : node.start, value: node.type === "TSAsExpression" ? `as ${text}` : `<${text}>` });
      }
    }
    for (const child of childNodes(node)) walk(child);
  };
  walk(parsed.program);
  return out;
}

export interface AuditErrorDetailFinding {
  readonly rule: "error-field" | "raw-error-text" | "brand-cast" | "plain-record-spread";
  readonly file: string;
  readonly line: number;
  readonly key: string;
  readonly value: string;
}

export interface AuditErrorDetailScan {
  readonly findings: readonly AuditErrorDetailFinding[];
  readonly writes: number;
}

export function isAuditWriter(name: string): boolean {
  if (NOT_A_WRITE.has(name)) return false;
  return KNOWN_ROAD_NAMES.includes(name) || /audit/i.test(name);
}

function closeOf(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

function valueEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) return i;
  }
  return code.length;
}

function splitConditional(code: string): { readonly whenTrue: [number, number]; readonly whenFalse: [number, number] } | undefined {
  let depth = 0;
  let question = -1;
  let nested = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "?" && code[i + 1] !== "." && code[i + 1] !== "?" && code[i - 1] !== "?") {
      if (question === -1) question = i;
      else nested++;
    } else if (depth === 0 && c === ":" && question !== -1) {
      if (nested > 0) nested--;
      else return { whenTrue: [question + 1, i], whenFalse: [i + 1, code.length] };
    }
  }
  return undefined;
}

function trimBoth(code: string, original: string): { readonly code: string; readonly original: string } {
  const start = original.length - original.trimStart().length;
  const end = original.trimEnd().length;
  return { code: code.slice(start, end), original: original.slice(start, end) };
}

function unwrap(code: string, original: string): { readonly code: string; readonly original: string } {
  let v = trimBoth(code, original);
  while (v.code.startsWith("(") && closeOf(v.code, 0) === v.code.length) v = trimBoth(v.code.slice(1, -1), v.original.slice(1, -1));
  return v;
}

export function isAcceptedValue(code: string, original: string, scrubbedNames: ReadonlySet<string>): boolean {
  const v = unwrap(code, original);
  if (v.original.length === 0) return false;
  const conditional = splitConditional(v.code);
  if (conditional !== undefined) {
    const [a, b] = conditional.whenTrue;
    const [c, d] = conditional.whenFalse;
    return isAcceptedValue(v.code.slice(a, b), v.original.slice(a, b), scrubbedNames) && isAcceptedValue(v.code.slice(c, d), v.original.slice(c, d), scrubbedNames);
  }
  if (/^(?:"[^]*"|'[^]*')$/.test(v.original) && closeQuoteIsLast(v.original)) return true;
  if (/^`[^]*`$/.test(v.original) && !v.original.includes("${") && closeQuoteIsLast(v.original)) return true;
  if (/^(?:-?\d[\d_.]*|true|false|null|undefined)$/.test(v.original)) return true;
  if (scrubbedNames.has(v.original)) return true;
  const scrub = /^scrubAuditText\s*\(/.exec(v.code);
  if (scrub !== null) return closeOf(v.code, scrub[0].length - 1) === v.code.length;
  const call = /^auditErrorDetail\s*\(/.exec(v.code);
  if (call !== null) {
    const close = closeOf(v.code, call[0].length - 1);
    return /^\s*\.\s*error$/.test(v.code.slice(close));
  }
  return false;
}

function closeQuoteIsLast(text: string): boolean {
  const quote = text[0];
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i === text.length - 1;
  }
  return false;
}

export function scrubbedNamesIn(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*scrubAuditText\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (/^\s*[;,\n]/.test(code.slice(closeOf(code, open)))) names.add(m[1]!);
  }
  for (const m of code.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*auditErrorDetail\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (/^\s*\.\s*error\s*[;,\n]/.test(code.slice(closeOf(code, open)))) names.add(m[1]!);
  }
  return names;
}

function auditSpans(code: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of code.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1]!;
    if (!isAuditWriter(name)) continue;
    const before = code.slice(Math.max(0, (m.index ?? 0) - 20), m.index ?? 0);
    if (/\b(?:function\s*\*?|async)\s*$/.test(before)) continue;
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = closeOf(code, open);
    if (/^\s*(?::[^;{=]*)?\{/.test(code.slice(close))) continue;
    spans.push([open, close]);
  }
  for (const m of code.matchAll(/(?<![\w$])\w*[dD]etail\w*\s*(?:=|:)\s*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    spans.push([open, closeOf(code, open)]);
  }
  return spans;
}

const RAW_ERROR_TEXT = /\.\s*(?:message|stack)\b(?!\s*\.\s*length)|\bString\s*\(\s*(?:e|err|error|cause|reason|failure)\s*\)/;

function skippedRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /\b(?:auditError(?:Detail|Frames)|scrubAuditText)\s*\(|\{/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    const open = code[m.index] === "{" ? m.index : code.indexOf("(", m.index);
    const close = closeOf(code, open);
    ranges.push([m.index, close]);
    re.lastIndex = close;
  }
  return ranges;
}

function blankRanges(text: string, ranges: ReadonlyArray<[number, number]>): string {
  let out = text;
  for (const [a, b] of ranges) out = out.slice(0, a) + " ".repeat(b - a) + out.slice(b);
  return out;
}

function reducerRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /\b(?:auditError(?:Detail|Frames)|scrubAuditText)\s*\(/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    const close = closeOf(code, m.index + m[0].length - 1);
    ranges.push([m.index, close]);
    re.lastIndex = close;
  }
  return ranges;
}

function templateParts(original: string): Array<{ readonly at: number; readonly code: string }> | undefined {
  const wrapped = `(${original}\n)`;
  let parsed: ParsedSource;
  try {
    parsed = parseSource(wrapped);
  } catch {
    return undefined;
  }
  const out = wrapped.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  for (const c of parsed.comments) blank(c.start, c.end);
  const spans: Array<[number, number]> = [];
  const walk = (node: AstNode): void => {
    if (node.type === "TemplateLiteral") for (const e of (node.expressions as readonly AstNode[] | undefined) ?? []) spans.push([e.start, e.end]);
    const literal = node.type === "Literal" && (typeof node.value === "string" || node.regex !== undefined);
    if (literal || node.type === "TemplateElement" || node.type === "TSTemplateLiteralType" || node.type === "JSXText") blank(node.start, node.end);
    else for (const child of childNodes(node)) walk(child);
  };
  walk(parsed.program);
  const code = out.join("");
  return spans.map(([a, b]) => ({ at: a - 1, code: code.slice(a, b) }));
}

export function carriesRawErrorText(code: string, original: string = code): boolean {
  const skipped = skippedRanges(code);
  if (RAW_ERROR_TEXT.test(blankRanges(code, skipped))) return true;
  const outside = blankRanges(original, skipped);
  const parts = templateParts(original);
  if (parts === undefined) return RAW_ERROR_TEXT.test(outside);
  return parts.some(({ at, code: part }) => {
    if (skipped.some(([a, b]) => at >= a && at < b)) return false;
    return RAW_ERROR_TEXT.test(blankRanges(part, reducerRanges(part)));
  });
}

function objectPositions(span: string): boolean[] {
  const out: boolean[] = [];
  const stack: string[] = [];
  for (let i = 0; i < span.length; i++) {
    const c = span[i]!;
    if (c === "(" || c === "[" || c === "{") stack.push(c);
    out.push(stack[stack.length - 1] === "{");
    if (c === ")" || c === "]" || c === "}") stack.pop();
  }
  return out;
}

export function plainRecordNamesIn(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\??\\s*:\\s*${PLAIN_RECORD_TYPE}`, "g"))) names.add(m[1]!);
  return names;
}

const PLAIN_RECORD_TYPE = String.raw`(?:Readonly\s*<\s*)?(?:Record\s*<\s*string\s*,|StoredAuditDetail\b|\{\s*(?:readonly\s+)?\[\s*[A-Za-z_$][\w$]*\s*:\s*string\s*\])`;

export function plainRecordFunctionsIn(code: string): Set<string> {
  const names = new Set<string>();
  const returns = new RegExp(String.raw`^\s*:\s*${PLAIN_RECORD_TYPE}`);
  const declarations = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\s*\(|\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\*?\s*)?(?:<[^(]*>\s*)?\(|(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\s*\(/g;
  for (const m of code.matchAll(declarations)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const name = (m[1] ?? m[2] ?? m[3])!;
    if (name === "function") continue;
    if (returns.test(code.slice(closeOf(code, open), closeOf(code, open) + 200))) names.add(name);
  }
  return names;
}

function plainRecordSpreads(span: string, plainNames: ReadonlySet<string>, plainFns: ReadonlySet<string>): Array<{ readonly at: number; readonly name: string }> {
  const out: Array<{ readonly at: number; readonly name: string }> = [];
  for (const m of span.matchAll(/\.\.\.\s*\(?\s*((?:[A-Za-z_$][\w$]*\s*\??\.\s*)*[A-Za-z_$][\w$]*)(\s*\()?/g)) {
    const chain = m[1]!.replace(/\s+/g, "");
    if (chain === "Object.fromEntries" && m[2] !== undefined) {
      out.push({ at: m.index ?? 0, name: chain });
      continue;
    }
    if (m[2] !== undefined) {
      if (plainFns.has(chain.split(/\??\./).pop()!)) out.push({ at: m.index ?? 0, name: `${chain}(…)` });
      continue;
    }
    if (!/^\s*(?:\)|,|\}|\?\?)/.test(span.slice((m.index ?? 0) + m[0].length))) continue;
    const last = chain.split(/\??\./).pop()!;
    if (plainNames.has(last)) out.push({ at: m.index ?? 0, name: chain });
  }
  return out;
}

export function auditErrorDetailFindings(file: string, source: string, treePlainFns: ReadonlySet<string> = new Set(), parsed: ParsedSource = parseSource(source, file), code: string = blankCommentsAndStrings(source, parsed)): AuditErrorDetailScan {
  const plainFns = new Set([...treePlainFns, ...plainRecordFunctionsIn(code)]);
  const scrubbed = scrubbedNamesIn(code);
  const plainNames = plainRecordNamesIn(code);
  const findings: AuditErrorDetailFinding[] = [];
  const seen = new Set<number>();
  const spans = auditSpans(code);
  for (const [open, close] of spans) {
    const span = code.slice(open, close);
    for (const spread of plainRecordSpreads(span, plainNames, plainFns)) {
      const at = open + spread.at;
      if (seen.has(-at - 1)) continue;
      seen.add(-at - 1);
      findings.push({ rule: "plain-record-spread", file, line: source.slice(0, at).split("\n").length, key: spread.name, value: `...${spread.name}` });
    }
    const inObject = objectPositions(span);
    for (const m of span.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*(?=(:|,|\}))/g)) {
      const key = m[1]!;
      if (!inObject[m.index ?? 0]) continue;
      const keyAt = open + (m.index ?? 0) + m[0].indexOf(key, 1);
      if (seen.has(keyAt)) continue;
      seen.add(keyAt);
      const line = source.slice(0, keyAt).split("\n").length;
      if (m[2] !== ":") {
        if (ERROR_KEY.test(key) && !scrubbed.has(key)) findings.push({ rule: "error-field", file, line, key, value: key });
        continue;
      }
      const from = open + (m.index ?? 0) + m[0].length + 1;
      const end = valueEnd(code, from);
      const value = source.slice(from, end);
      const flat = value.replace(/\s+/g, " ").trim();
      if (ERROR_KEY.test(key)) {
        if (!isAcceptedValue(code.slice(from, end), value, scrubbed)) findings.push({ rule: "error-field", file, line, key, value: flat });
      } else if (carriesRawErrorText(code.slice(from, end), value)) {
        findings.push({ rule: "raw-error-text", file, line, key, value: flat });
      }
    }
  }
  if (file !== BRAND_MINT_FILE) {
    for (const cast of brandCasts(parsed, source)) {
      const line = source.slice(0, cast.at).split("\n").length;
      findings.push({ rule: "brand-cast", file, line, key: "ScrubbedAuditText", value: cast.value.replace(/\s+/g, " ") });
    }
  }
  return { findings, writes: spans.length };
}

export function readScanFiles(repoRoot: string = ROOT): readonly { readonly file: string; readonly source: string }[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "--", ...SCAN_PATHSPECS], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes("/dist/") && !f.includes("/node_modules/") && !isGeneratedManualModule(f))
    .map((file) => ({ file, source: readFileSync(join(repoRoot, file), "utf8") }));
}

export function scanTree(files: readonly { readonly file: string; readonly source: string }[]): AuditErrorDetailScan {
  const findings: AuditErrorDetailFinding[] = [];
  let writes = 0;
  const plainFns = new Set<string>();
  const parsedFiles = files.map(({ file, source }) => {
    const parsed = parseSource(source, file);
    return { file, source, parsed, code: blankCommentsAndStrings(source, parsed) };
  });
  for (const { code } of parsedFiles) for (const name of plainRecordFunctionsIn(code)) plainFns.add(name);
  for (const { file, source, parsed, code } of parsedFiles) {
    const scan = auditErrorDetailFindings(file, source, plainFns, parsed, code);
    findings.push(...scan.findings);
    writes += scan.writes;
  }
  return { findings, writes };
}

function main(): void {
  const scan = scanTree(readScanFiles());
  if (scan.writes < MIN_PLAUSIBLE_WRITES) {
    console.error(`lint:audit-error-detail: the scan read ${scan.writes} audit write(s), fewer than the floor of ${MIN_PLAUSIBLE_WRITES} — the walk broke, the tree did not get clean`);
    process.exit(1);
  }
  if (scan.findings.length > 0) {
    console.error(`lint:audit-error-detail: ${scan.findings.length} audit write(s) store error text that did not go through auditErrorDetail:`);
    for (const f of scan.findings) console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.key}: ${f.value}`);
    console.error("Fix: write `error: auditErrorDetail(err).error` (or spread `...auditErrorDetail(err)`), or `scrubAuditText(text)` for other upstream text. Never cast to ScrubbedAuditText. See packages/core/agent/audit/tool-action.ts.");
    process.exit(1);
  }
  console.log(`✓ lint:audit-error-detail — ${scan.writes} audit writes read, every error-named field goes through auditErrorDetail`);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main();

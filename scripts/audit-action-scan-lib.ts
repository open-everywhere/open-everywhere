import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export interface ResolvedActionSite {
  readonly action: string;
  readonly file: string;
  readonly road: AuditRoad;
}

export interface UnresolvedActionSite {
  readonly expression: string;
  readonly file: string;
  readonly road: AuditRoad;
}

export interface ForwardingHelper {
  readonly name: string;
  readonly file: string;
}

export type AuditRoad = (typeof KNOWN_ROADS)[number]["name"];

export interface RoadShape {
  readonly name: string;
  readonly actionAt: "property" | number;
  readonly onlyIn?: string;
}

export interface AuditActionScan {
  readonly actions: readonly string[];
  readonly resolved: readonly ResolvedActionSite[];
  readonly unresolved: readonly UnresolvedActionSite[];
  readonly forwardingHelpers: readonly ForwardingHelper[];
  readonly filesScanned: number;
}

export const KNOWN_ROADS = [
  { name: "appendAudit", actionAt: "property" },
  { name: "auditToolAction", actionAt: 1 },
  { name: "appendRouteAudit", actionAt: 1 },
  { name: "noteAudienceChange", actionAt: 0 },
  { name: "auditSupervisorFailure", actionAt: 1 },
  { name: "executeTicketVerb", actionAt: 3 },
  { name: "appendWakeRow", actionAt: 1 },
  { name: "appendWakeRowForIds", actionAt: 2 },
  { name: "auditRetirement", actionAt: 2 },
  { name: "auditLink", actionAt: 4 },
  { name: "audit", actionAt: 0, onlyIn: "packages/core/agent/control/oauth-route.ts" },
] as const satisfies readonly RoadShape[];

export const KNOWN_ROAD_NAMES: readonly string[] = KNOWN_ROADS.map((r) => r.name);

const SCAN_GLOBS: readonly string[] = ["packages/core/agent", "packages/providers"];

export const SCAN_PATHSPECS: readonly string[] = SCAN_GLOBS.map((dir) => `:(glob)${dir}/**/*.ts`);

function gitLines(repoRoot: string, args: readonly string[]): string[] {
  const out = execFileSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes("/dist/") && !f.includes("/node_modules/"));
}

function sourceFiles(repoRoot: string): string[] {
  const pattern = KNOWN_ROAD_NAMES.join("|");
  let files: string[];
  try {
    files = gitLines(repoRoot, ["grep", "--untracked", "--exclude-standard", "--full-name", "-l", "-E", pattern, "--", ...SCAN_PATHSPECS]);
  } catch (error) {
    if ((error as { readonly status?: number }).status !== 1) throw error;
    files = [];
  }
  if (files.length === 0) {
    throw new Error(`audit-action scan: no file under ${SCAN_GLOBS.join(", ")} calls a known audit road — the walk read nothing`);
  }
  return files;
}

export function constantFiles(repoRoot: string, pathspecs: readonly string[], mustCoverAtLeast: number): string[] {
  const files = gitLines(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "--", ...pathspecs]);
  if (files.length < mustCoverAtLeast) {
    throw new Error(
      `audit-action scan: the constant walk read ${files.length} file(s) under ${SCAN_GLOBS.join(", ")}, fewer than the ${mustCoverAtLeast} file(s) the emission walk matched over the same paths — the constant walk lost rows`,
    );
  }
  return files;
}

function collectConstants(repoRoot: string, files: readonly string[]): { readonly values: Map<string, string>; readonly collisions: string[] } {
  const values = new Map<string, string>();
  const collisions = new Set<string>();
  for (const file of files) {
    const src = readFileSync(join(repoRoot, file), "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?=\s*"([^"]+)"/g)) {
      const [, name = "", value = ""] = m;
      const seen = values.get(name);
      if (seen !== undefined && seen !== value) collisions.add(name);
      else values.set(name, value);
    }
  }
  for (const name of collisions) values.delete(name);
  return { values, collisions: [...collisions].sort() };
}

function callSpan(src: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return undefined;
}

function callSites(src: string, name: string): number[] {
  const out: number[] = [];
  let i = 0;
  while ((i = src.indexOf(`${name}(`, i)) !== -1) {
    const before = src[i - 1] ?? "";
    if (!/[\w$]/.test(before)) out.push(i + name.length);
    i += name.length;
  }
  return out;
}

function readExpression(src: string, at: number): string {
  return readExpressionSpan(src, at).text;
}

function readExpressionSpan(src: string, at: number): { readonly text: string; readonly end: number } {
  let from = at;
  while (from < src.length && /\s/.test(src[from] ?? "")) from++;
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return { text: src.slice(from, i).trim(), end: i };
      depth--;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      for (; i < src.length; i++) {
        if (src[i] === "\\") i++;
        else if (src[i] === quote) break;
        else if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
          let d = 1;
          i += 2;
          for (; i < src.length && d > 0; i++) {
            if (src[i] === "{") d++;
            else if (src[i] === "}") d--;
          }
          i--;
        }
      }
    } else if ((c === "," || c === "\n") && depth === 0) return { text: src.slice(from, i).trim(), end: i };
  }
  return { text: src.slice(from).trim(), end: src.length };
}

type SpanReading =
  | { readonly kind: "declaration" }
  | { readonly kind: "expression"; readonly expression: string }
  | { readonly kind: "unnamed" };

function isDeclarationOrForward(call: string): boolean {
  const inner = call.slice(1, -1).trim();
  return /^\w+(\?)?\s*:\s*\w/.test(inner) || /^\w+$/.test(inner) || inner.length === 0;
}

function argumentAt(call: string, index: number): string | undefined {
  let at = 1;
  for (let i = 0; ; i++) {
    const { text, end } = readExpressionSpan(call, at);
    if (i === index) return text.length > 0 ? text : undefined;
    const comma = call.indexOf(",", end);
    if (comma === -1) return undefined;
    at = comma + 1;
  }
}

function readSpan(road: RoadShape, call: string): SpanReading {
  if (isDeclarationOrForward(call)) return { kind: "declaration" };
  if (road.actionAt === "property") {
    const shorthand = /[,{]\s*action\s*[,}]/.test(call);
    const at = call.search(/\baction:\s*/);
    if (at === -1) return shorthand ? { kind: "expression", expression: "action" } : { kind: "unnamed" };
    const keyLength = call.slice(at).match(/^\baction:\s*/)?.[0].length ?? 0;
    const expression = readExpression(call, at + keyLength);
    return expression.length > 0 ? { kind: "expression", expression } : { kind: "unnamed" };
  }
  const expression = argumentAt(call, road.actionAt);
  return expression === undefined ? { kind: "unnamed" } : { kind: "expression", expression };
}

export function scanAuditActions(repoRoot: string): AuditActionScan {
  const files = sourceFiles(repoRoot);
  const { values: constants, collisions } = collectConstants(repoRoot, constantFiles(repoRoot, SCAN_PATHSPECS, files.length));
  const ambiguous = new Set(collisions);
  const resolved: ResolvedActionSite[] = [];
  const unresolved: UnresolvedActionSite[] = [];
  const helpers: ForwardingHelper[] = [];

  for (const file of files) {
    const src = readFileSync(join(repoRoot, file), "utf8");
    for (const road of KNOWN_ROADS) {
      if ("onlyIn" in road && road.onlyIn !== file) continue;
      const definesThisRoad = KNOWN_ROAD_NAMES.some((n) => new RegExp(`(function|const)\\s+${n}\\b`).test(src));
      for (const open of callSites(src, road.name)) {
        const call = callSpan(src, open);
        if (call === undefined) continue;
        const reading = readSpan(road, call);
        if (definesThisRoad && reading.kind === "expression" && /^[a-z]\w*$/.test(reading.expression)) continue;
        if (reading.kind === "declaration") continue;
        if (reading.kind === "unnamed") {
          unresolved.push({ expression: "<no action argument>", file, road: road.name });
          continue;
        }
        const { expression } = reading;
        const literal = expression.match(/^"([^"]*)"$/)?.[1];
        if (literal !== undefined) {
          resolved.push({ action: literal, file, road: road.name });
          continue;
        }
        const viaConstant = /^[A-Z][A-Z0-9_]*$/.test(expression) ? constants.get(expression) : undefined;
        if (viaConstant !== undefined) resolved.push({ action: viaConstant, file, road: road.name });
        else
          unresolved.push({
            expression: ambiguous.has(expression) ? `${expression} (name defined twice with different values)` : expression,
            file,
            road: road.name,
          });
      }
    }
    for (const m of src.matchAll(/(?:function|const)\s+(\w+)\s*=?\s*(?:async\s*)?\(([^)]*?(?:action|Action)\w*\s*:\s*string[^)]*?)\)/g)) {
      const [, name = "", params = ""] = m;
      if (KNOWN_ROAD_NAMES.includes(name)) continue;
      const parameters = [...params.matchAll(/(\w*[aA]ction\w*)\s*:\s*string/g)].map((p) => p[1] ?? "");
      const body = src.slice(m.index ?? 0, (m.index ?? 0) + 4000);
      for (const parameter of parameters) {
        const writeSites = [...body.matchAll(/\b(?:\w+\.)?(?:appendAudit|auditToolAction|appendRouteAudit)\s*\(/g)];
        const forwards = writeSites.some((w) => {
          const call = callSpan(body, (w.index ?? 0) + w[0].length - 1);
          return call !== undefined && new RegExp(`action:\\s*${parameter}\\b|[,{]\\s*${parameter}\\s*[,}]`).test(call);
        });
        if (forwards) helpers.push({ name, file });
      }
    }
  }

  return {
    actions: [...new Set(resolved.map((r) => r.action))].sort(),
    resolved,
    unresolved,
    forwardingHelpers: helpers,
    filesScanned: files.length,
  };
}

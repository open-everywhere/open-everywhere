export interface DynamicEnvRead {
  readonly file: string;
  readonly line: number;
  readonly expr: string;
}

export interface ResolvedEnvRead {
  readonly name: string;
  readonly file: string;
}

export interface ComputedScan {
  readonly resolved: readonly ResolvedEnvRead[];
  readonly dynamic: readonly DynamicEnvRead[];
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export function dynamicSiteKey(site: Pick<DynamicEnvRead, "file" | "expr">): string {
  return `${site.file}::${site.expr}`;
}

function stringConstants(source: string, exportedOnly: boolean): Map<string, string> {
  const out = new Map<string, string>();
  const re = exportedOnly
    ? /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=\s*(["'])([^"'\n]*)\2/g
    : /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=\s*(["'])([^"'\n]*)\2/g;
  for (const m of source.matchAll(re)) out.set(m[1], m[3]);
  return out;
}

export function collectExportedNameConstants(sources: Iterable<readonly [string, string]>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [, source] of sources) {
    for (const [name, value] of stringConstants(source, true)) {
      if (!out.has(name)) out.set(name, value);
      else if (out.get(name) !== value) out.set(name, null);
    }
  }
  return out;
}

const ALIAS_PARAM = /[(,]\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*NodeJS\.ProcessEnv\b/g;

const ALIAS_VAR = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*[^;\n]*\bprocess\.env\b(?![.[])/g;

export function processEnvAliases(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(ALIAS_PARAM)) out.add(m[1]);
  for (const m of source.matchAll(ALIAS_VAR)) out.add(m[1]);
  return out;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

function bracketExpr(source: string, open: number): { expr: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) return { expr: source.slice(open + 1, i), end: i };
    }
  }
  return null;
}

function isWrite(source: string, closeIdx: number): boolean {
  return /^\s*=[^=]/.test(source.slice(closeIdx + 1, closeIdx + 8));
}

const ALIAS_DOT_READ = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\??\.\s*([A-Z][A-Z0-9_]*)\b/g;

export function scanAliasDotReads(file: string, source: string, aliases: ReadonlySet<string>): ResolvedEnvRead[] {
  if (aliases.size === 0) return [];
  const out: ResolvedEnvRead[] = [];
  const seen = new Set<string>();
  for (const line of source.split("\n")) {
    if (isCommentLine(line)) continue;
    for (const m of line.matchAll(ALIAS_DOT_READ)) {
      const [, base, name] = m;
      if (!aliases.has(base)) continue;
      if (!ENV_NAME.test(name)) continue;
      const after = line.slice(m.index + m[0].length);
      if (/^\s*=[^=>]/.test(after)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, file });
    }
  }
  return out;
}

export function scanComputedEnvReads(
  file: string,
  source: string,
  exported: ReadonlyMap<string, string | null> = new Map(),
): ComputedScan {
  const locals = stringConstants(source, false);
  const aliases = processEnvAliases(source);
  const resolved: ResolvedEnvRead[] = [];
  const dynamic: DynamicEnvRead[] = [];
  const seenResolved = new Set<string>();
  const seenDynamic = new Set<string>();

  const lines = source.split("\n");
  const lineStart: number[] = [];
  for (let i = 0, at = 0; i < lines.length; at += lines[i].length + 1, i++) lineStart.push(at);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStart.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStart[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  for (let at = source.indexOf("["); at !== -1; at = source.indexOf("[", at + 1)) {
    const li = lineOf(at);
    if (isCommentLine(lines[li])) continue;
    const before = source.slice(lineStart[li], at);
    const base = /(?:\bprocess\.env|\b([A-Za-z_$][\w$]*))\s*(?:\?\.)?\s*$/.exec(before);
    if (!base) continue;
    const isProcessEnv = base[1] === undefined;
    if (!isProcessEnv) {
      if (!aliases.has(base[1]) || before[base.index - 1] === ".") continue;
    }
    const read = bracketExpr(source, at);
    if (!read) continue;
    if (isWrite(source, read.end)) continue;

    const expr = read.expr.trim().replace(/\s+/gu, " ");
    const literal = /^(["'])(.*)\1$/su.exec(expr);
    let name: string | null = null;
    if (literal) name = literal[2];
    else if (/^[A-Za-z_$][\w$]*$/.test(expr)) name = locals.get(expr) ?? exported.get(expr) ?? null;

    if (name !== null) {
      if (!ENV_NAME.test(name)) continue;
      const key = `${name}::${file}`;
      if (seenResolved.has(key)) continue;
      seenResolved.add(key);
      resolved.push({ name, file });
      continue;
    }

    const key = dynamicSiteKey({ file, expr });
    if (seenDynamic.has(key)) continue;
    seenDynamic.add(key);
    dynamic.push({ file, line: li + 1, expr });
  }

  for (const r of scanAliasDotReads(file, source, aliases)) {
    const key = `${r.name}::${file}`;
    if (seenResolved.has(key)) continue;
    seenResolved.add(key);
    resolved.push(r);
  }

  return { resolved, dynamic };
}

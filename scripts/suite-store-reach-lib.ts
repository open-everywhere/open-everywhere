import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { codeOnly } from "./tidy/test-runner-inventory.js";
import { workspacePackages } from "./chain/_legs.js";

const STORE_REACH = /(?<![.\w$])(?:readAudit|appendAudit|getOperationalStore|registerOperationalStore)\s*\(/;

const PINNED = /\bpinSuiteStore\s*\(|\bOE_SQLITE_PATH\b|\bOE_MEMORY_DIR\b/;

export interface IndirectReach {
  readonly symbol: string;
  readonly module: string;
}

function matchBlock(code: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return code.slice(openIdx, i + 1);
    }
  }
  return code.slice(openIdx);
}

function bodyBrace(code: string, parenIdx: number): number {
  let depth = 0;
  let i = parenIdx;
  for (; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  let angle = 0;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === "<") angle++;
    else if (c === ">") angle = Math.max(0, angle - 1);
    else if (c === "{" && angle === 0) return i;
    else if (c === ";" && angle === 0) return -1;
  }
  return -1;
}

function bodies(code: string): Map<string, string> {
  const out = new Map<string, string>();
  let m: RegExpExecArray | null;
  const fnRe = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/g;
  while ((m = fnRe.exec(code)) !== null) {
    const paren = code.indexOf("(", m.index + m[0].length - 1);
    if (paren < 0) continue;
    const brace = bodyBrace(code, paren);
    if (brace >= 0) out.set(m[1], matchBlock(code, brace));
  }
  const constRe = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s*)?(\()/g;
  while ((m = constRe.exec(code)) !== null) {
    const paren = m.index + m[0].length - 1;
    const brace = bodyBrace(code, paren);
    if (brace >= 0) out.set(m[1], matchBlock(code, brace));
    else {
      const semi = code.indexOf(";", paren);
      out.set(m[1], code.slice(paren, semi < 0 ? code.length : semi));
    }
  }
  return out;
}

const reachCache = new Map<string, Map<string, boolean>>();

export function resetStoreReachCache(): void {
  reachCache.clear();
}

function storeReachingNames(file: string): Map<string, boolean> {
  const hit = reachCache.get(file);
  if (hit) return hit;
  const out = new Map<string, boolean>();
  reachCache.set(file, out);
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  const code = codeOnly(src);
  if (!STORE_REACH.test(code)) return out;
  const bs = bodies(code);
  const memo = new Map<string, boolean>();
  const reaches = (name: string, seen: Set<string>): boolean => {
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    if (seen.has(name)) return false;
    seen.add(name);
    const body = bs.get(name);
    if (body === undefined) return false;
    let answer = STORE_REACH.test(body);
    if (!answer) {
      for (const other of bs.keys()) {
        if (other === name) continue;
        if (new RegExp(`(?<![.\\w$])${other}\\b`).test(body) && reaches(other, seen)) {
          answer = true;
          break;
        }
      }
    }
    memo.set(name, answer);
    return answer;
  };
  for (const name of bs.keys()) out.set(name, reaches(name, new Set()));
  return out;
}

function namedImports(src: string): { spec: string; names: string[] }[] {
  const out: { spec: string; names: string[] }[] = [];
  let m: RegExpExecArray | null;
  const SPEC = `(\\.[^"']*|@open-everywhere/[^"']*)`;
  const staticRe = new RegExp(`import\\s*(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${SPEC}["']`, "g");
  while ((m = staticRe.exec(src)) !== null) {
    out.push({ spec: m[2], names: m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()).filter((s) => s.length > 0 && s !== "type") });
  }
  const dynamicRe = new RegExp(`\\{([^}]*)\\}\\s*=\\s*await\\s+import\\s*\\(\\s*["']${SPEC}["']`, "g");
  while ((m = dynamicRe.exec(src)) !== null) {
    out.push({ spec: m[2], names: m[1].split(",").map((s) => s.trim().split(/:\s*/).pop()!.trim()).filter((s) => s.length > 0) });
  }
  return out;
}

let workspaceDirs: ReadonlyMap<string, string> | undefined;
function packageDirs(): ReadonlyMap<string, string> {
  if (workspaceDirs === undefined) workspaceDirs = new Map(workspacePackages().map((p) => [p.name, p.dir]));
  return workspaceDirs;
}

export function resolveImportedTs(fromFile: string, spec: string): string | undefined {
  const workspace = /^@open-everywhere\/([^/]+)\/(.+)$/.exec(spec);
  const base = workspace === null ? resolve(dirname(fromFile), spec) : ((dir) => (dir === undefined ? undefined : join(dir, workspace[2])))(packageDirs().get(`@open-everywhere/${workspace[1]}`));
  if (base === undefined) return undefined;
  for (const candidate of [base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface SuiteStoreReach {
  readonly direct: boolean;
  readonly indirect: readonly IndirectReach[];
  readonly pinned: boolean;
}

export function suiteStoreReach(file: string): SuiteStoreReach {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return { direct: false, indirect: [], pinned: false };
  }
  const code = codeOnly(src);
  const pinned = PINNED.test(code);
  if (STORE_REACH.test(code)) return { direct: true, indirect: [], pinned };
  const indirect: IndirectReach[] = [];
  for (const { spec, names } of namedImports(src)) {
    const target = resolveImportedTs(file, spec);
    if (target === undefined) continue;
    const reaching = storeReachingNames(target);
    for (const name of names) {
      if (reaching.get(name) !== true) continue;
      if (new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(code)) indirect.push({ symbol: name, module: target });
    }
  }
  return { direct: false, indirect, pinned };
}

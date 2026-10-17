import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const HOOKS_DIR = join(repoRoot, "packages", "core", "agent", "hooks");

export const MIN_PLAUSIBLE_HOOK_FILES = 20;

export const MARKER = /hook-throw:\s*(CONTROL|DEFECT|INTERNAL\(([A-Za-z_$][\w$]*)\))/;

export const PENDING_CONVERSION: readonly { readonly file: string; readonly ticket: string; readonly why: string }[] = [];

export interface HookThrowFinding {
  readonly rule: "unclassified" | "control" | "stale-pending-row" | "internal-unproven";
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw|new|yield|await|else|do)$/;

function regexEnd(source: string, open: number, prevSig: number): number | undefined {
  const k = prevSig;
  const prev = k < 0 ? "" : source[k]!;
  const opensRegex = prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || REGEX_AFTER_WORD.test(source.slice(Math.max(0, k - 8), k + 1));
  if (!opensRegex) return undefined;
  let j = open + 1;
  let inClass = false;
  while (j < source.length) {
    const ch = source[j]!;
    if (ch === "\n") return undefined;
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      j++;
      while (j < source.length && /[a-z]/i.test(source[j]!)) j++;
      return j;
    }
    j++;
  }
  return undefined;
}

function templateEnd(source: string, open: number): number {
  let j = open + 1;
  while (j < source.length) {
    const ch = source[j]!;
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "`") return j + 1;
    if (ch === "$" && source[j + 1] === "{") {
      let sig = j + 1;
      j += 2;
      let depth = 1;
      while (j < source.length && depth > 0) {
        const d = source[j]!;
        const two = source.slice(j, j + 2);
        if (two === "//") {
          const nl = source.indexOf("\n", j);
          j = nl === -1 ? source.length : nl;
        } else if (two === "/*") {
          const end = source.indexOf("*/", j + 2);
          j = end === -1 ? source.length : end + 2;
        } else if (d === "/" && regexEnd(source, j, sig) !== undefined) {
          j = regexEnd(source, j, sig)!;
          sig = j - 1;
        } else if (d === "`") {
          j = templateEnd(source, j);
          sig = j - 1;
        } else if (d === '"' || d === "'") {
          j++;
          while (j < source.length && source[j] !== d) j += source[j] === "\\" ? 2 : 1;
          j++;
          sig = j - 1;
        } else {
          if (d === "{") depth++;
          else if (d === "}") depth--;
          if (!/\s/.test(d)) sig = j;
          j++;
        }
      }
      continue;
    }
    j++;
  }
  return source.length;
}

export function blankCommentsAndStrings(source: string): string {
  const out = source.split("");
  let i = 0;
  let sig = -1;
  const keep = (n: number): void => {
    for (let k = i; k < Math.min(n, out.length); k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      let j = source.indexOf("\n", i);
      if (j === -1) j = source.length;
      keep(j);
      i = j;
      continue;
    }
    if (two === "/*") {
      let j = source.indexOf("*/", i + 2);
      j = j === -1 ? source.length : j + 2;
      keep(j);
      i = j;
      continue;
    }
    const c = source[i]!;
    if (c === "/") {
      const end = regexEnd(source, i, sig);
      if (end !== undefined) {
        keep(end);
        i = end;
        sig = end - 1;
        continue;
      }
    }
    if (c === "`") {
      const j = templateEnd(source, i);
      keep(j);
      i = j;
      sig = j - 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === c) {
          j++;
          break;
        }
        j++;
      }
      keep(j);
      i = j;
      sig = j - 1;
      continue;
    }
    if (!/\s/.test(c)) sig = i;
    i++;
  }
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
    const code = blankCommentsAndStrings(source).split("\n");
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
            `classified CONTROL, which eve 0.68+ cannot honour: an authored hook's throw is logged and ` +
            `swallowed, so this refuses nothing. Call refuseTurn (agent/hooks/control-refusal.ts), which ` +
            `cancels the turn, and delete the marker`,
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
          `an unclassified throw in a hook module. If it exists to STOP a turn, it does not — call ` +
          `refuseTurn (agent/hooks/control-refusal.ts). If it is a bug path, mark it ` +
          `\`// hook-throw: DEFECT — <why>\``,
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
  const findings = hookThrowFindings(files);
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
    `✓ lint:hook-throw: ${files.length} hook files scanned, no unclassified or CONTROL throw. ` +
      `Pending conversion by another ticket: ${pendingNote || "none"}.`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main();

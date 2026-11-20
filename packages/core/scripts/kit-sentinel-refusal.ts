import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The `oe build` refusal of a kit-re-provided framework tool that has no `framework.disable` sentinel.
 *
 * A kit is a tool module whose default export is `windowGatedKit(slug, { <member>: …, … })`
 * (`agent/access/window-gated.ts`). It is a dynamic tool: per seat it provides each member that the
 * seat's window grain allows. Some members carry the name of an eve built-in (core's `sandbox_tools`
 * re-provides `bash`, `edit_file` and others behind the grain gate, the stall guard and the memory
 * write fence). A dynamic tool can only SHADOW a static built-in when it resolves, never REMOVE it. So
 * the kit member is the only provision only when the app's `roster.config.ts` lists the name in
 * `framework.disable`, and `oe build` writes the `disableTool()` sentinel. Without the sentinel, eve
 * mounts its own built-in on every seat, and the seats that the kit withholds the tool from hold eve's
 * unfenced one.
 *
 * The set of names comes from the kits themselves: the scan reads the member keys of each
 * `windowGatedKit(...)` call in the module of every tool that the roster mounts. A name needs a
 * sentinel when the installed eve mounts the built-in of that name (default-mounted or root-only).
 * An opt-in built-in (`glob`, `grep`) mounts only when the app authors it, so it needs none.
 *
 * The scan fails closed. It refuses a kit whose members it cannot read (the second argument is not an
 * object literal, or the literal holds a spread or a computed key), a mounted tool module it cannot
 * read, and a mounted kit while the installed eve's mount set is unreadable.
 *
 * The limit: this is a scan of source text. Four roads escape it:
 * - a tool module that re-exports a kit from another module (the scan reads the mounted module only);
 * - a kit whose definer is reached through a wrapper function or a namespace import;
 * - a regex literal in a kit module that holds a quote or a `//`, which can misread the member keys;
 * - a deploy step that skips `oe build`.
 * A member object passed by name, a spread, a computed key and a mention of the definer that is not a
 * direct call (`(0, m.windowGatedKit)(…)`, `windowGatedKit<T>(…)`, an import or local alias) are refused,
 * not missed. So is a member key the scan cannot read (an accessor, an async method, a generator).
 */

export const KIT_DEFINER = "windowGatedKit";

export interface KitDeclaration {
  readonly slug: string;
  readonly members: readonly string[];
}

export type KitScan = { readonly kits: readonly KitDeclaration[] } | { readonly error: string };

export interface MountedToolModule {
  /** The contributing package, for example `@open-everywhere/core`. */
  readonly package: string;
  /** The contribution name, which is also the slot file name. */
  readonly name: string;
  /** The module path inside the package, for example `agent/tools/sandbox_tools.js`. */
  readonly module: string;
}

export interface KitSentinelFinding {
  readonly package: string;
  readonly contribution: string;
  /** The framework tool that has no sentinel. Absent on a finding the scan could not read. */
  readonly tool?: string;
  readonly why: string;
}

/**
 * Blanks block comments and drops line comments. A string or template literal is kept whole, so a `//`
 * inside a string blanks nothing. A regex literal is not told apart from code, so a quote or a `//` in
 * a regex literal in a kit module can misread it (see the limit above).
 */
function withoutComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const end = stringEnd(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close < 0 ? source.length : close + 2;
      out += source.slice(i, end).replace(/[^\n]/gu, " ");
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The index just past the string or template literal that opens at `start`. */
function stringEnd(source: string, start: number): number {
  const quote = source[start]!;
  let i = start + 1;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (quote === "`" && c === "$" && source[i + 1] === "{") {
      i = balancedEnd(source, i + 1);
      continue;
    }
    if (quote !== "`" && c === "\n") return i;
    i++;
  }
  return source.length;
}

/** The index just past the bracket that closes the one at `open`. Strings and templates are skipped. */
function balancedEnd(source: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = stringEnd(source, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return source.length;
}

/**
 * An import or export-from clause at the start of a line, read on a copy whose string contents are
 * blanked: `import x from`, `import { … } from`, `import * as x from`, `import x, { … } from`,
 * `export { … } from`, `export * from`, each optionally `type`.
 */
const IMPORT_CLAUSE_RE =
  /^[ \t]*(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)\s*from\s*(["'])[ ]*\1/gmu;

/** Blanks the contents of every string and template literal, and keeps each `${…}` expression. */
function blankStrings(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c !== '"' && c !== "'" && c !== "`") {
      out += c;
      i++;
      continue;
    }
    const end = stringEnd(text, i);
    out += c;
    let j = i + 1;
    while (j < end - 1) {
      if (c === "`" && text[j] === "$" && text[j + 1] === "{") {
        const close = balancedEnd(text, j + 1);
        out += `\${${blankStrings(text.slice(j + 2, close - 1))}}`;
        j = close;
        continue;
      }
      out += text[j] === "\n" ? "\n" : " ";
      j++;
    }
    if (end - 1 > i) out += text[end - 1] === c ? c : text[end - 1] === "\n" ? "\n" : " ";
    i = end;
  }
  return out;
}

const IDENT_RE = /^[A-Za-z_$][\w$]*/u;

/** The top-level keys of the object literal whose `{` is at `open`, or an error. */
function objectKeys(source: string, open: number): { keys: string[] } | { error: string } {
  const close = balancedEnd(source, open) - 1;
  const keys: string[] = [];
  let i = open + 1;
  const skipSpace = (): void => {
    while (i < close && /\s/u.test(source[i]!)) i++;
  };
  while (true) {
    skipSpace();
    if (i >= close) return { keys };
    let key: string;
    const c = source[i]!;
    if (c === '"' || c === "'") {
      const end = stringEnd(source, i);
      key = source.slice(i + 1, end - 1);
      i = end;
    } else if (source.startsWith("...", i)) {
      return { error: "its member object holds a spread (`...`), so the scan cannot list the members" };
    } else if (c === "[") {
      return { error: "its member object holds a computed key (`[…]`), so the scan cannot list the members" };
    } else {
      const m = IDENT_RE.exec(source.slice(i));
      if (m === null) return { error: `its member object holds text the scan cannot read at offset ${i}` };
      key = m[0];
      i += key.length;
    }
    skipSpace();
    if (i < close && !/[:(,]/u.test(source[i]!)) {
      return { error: `its member object holds "${key}" followed by text that is not a value (an accessor, an async method or a generator), so the scan cannot read the member` };
    }
    keys.push(key);
    // Skip the value (or a method's parameters and body) up to the next top-level comma.
    while (i < close) {
      const d = source[i]!;
      if (d === '"' || d === "'" || d === "`") {
        i = stringEnd(source, i);
        continue;
      }
      if (d === "(" || d === "[" || d === "{") {
        i = balancedEnd(source, i);
        continue;
      }
      if (d === ",") {
        i++;
        break;
      }
      i++;
    }
  }
}

/**
 * Reads every `windowGatedKit(slug, { … })` call in a module's source. A module that names the definer
 * in a declaration (`function windowGatedKit`) or an import only declares no kit.
 */
export function scanKits(source: string): KitScan {
  const text = withoutComments(source);
  const kits: KitDeclaration[] = [];
  // Fail closed on every mention the scan cannot read as a direct call or a declaration: a re-export
  // by name, a destructure, `(0, m.windowGatedKit)(…)` (tsc's CommonJS call form), a type-argument call
  // `windowGatedKit<T>(…)`, an optional call and a local alias. The read runs on a copy with the string
  // contents blanked, so a string never hides a mention. It blanks a real import or export-from clause
  // only, and an import alias of the definer is refused there.
  const code = blankStrings(text);
  for (const clause of code.matchAll(IMPORT_CLAUSE_RE)) {
    if (new RegExp(`\\b${KIT_DEFINER}\\s+as\\b`, "u").test(clause[0])) {
      return { error: `it imports ${KIT_DEFINER} under another name, so the scan cannot read the kit` };
    }
  }
  const statements = code.replace(IMPORT_CLAUSE_RE, (m) => m.replace(/[^\n]/gu, " "));
  for (const m of statements.matchAll(new RegExp(`\\b${KIT_DEFINER}\\b`, "gu"))) {
    const before = statements.slice(Math.max(0, m.index - 20), m.index);
    if (/\bfunction\s*$/u.test(before)) continue;
    if (/^\s*\(/u.test(statements.slice(m.index + m[0].length)) && !/\.\s*$/u.test(before)) continue;
    return { error: `it names ${KIT_DEFINER} outside a direct ${KIT_DEFINER}(slug, { … }) call, so the scan cannot read the kit` };
  }
  const callRe = new RegExp(`\\b${KIT_DEFINER}\\s*\\(`, "gu");
  for (const m of text.matchAll(callRe)) {
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    if (/\bfunction\s*$/u.test(before)) continue;
    let i = m.index + m[0].length;
    const skipSpace = (): void => {
      while (i < text.length && /\s/u.test(text[i]!)) i++;
    };
    skipSpace();
    const q = text[i];
    if (q !== '"' && q !== "'" && q !== "`") {
      return { error: `a ${KIT_DEFINER}(…) call does not name its slug as a string literal, so the scan cannot read the kit` };
    }
    const slugEnd = stringEnd(text, i);
    const slug = text.slice(i + 1, slugEnd - 1);
    i = slugEnd;
    skipSpace();
    if (text[i] !== ",") return { error: `${KIT_DEFINER}("${slug}", …) has no member object, so the scan cannot read the kit` };
    i++;
    skipSpace();
    if (text[i] !== "{") {
      return { error: `${KIT_DEFINER}("${slug}", …) takes its members from a name, not an object literal, so the scan cannot list them` };
    }
    const keys = objectKeys(text, i);
    if ("error" in keys) return { error: `${KIT_DEFINER}("${slug}", …): ${keys.error}` };
    kits.push({ slug, members: keys.keys });
  }
  return { kits };
}

/**
 * The findings for every mounted kit member that names an eve-mounted built-in and has no
 * `framework.disable` sentinel. `eveMounted` is the installed eve's default-mounted and root-only tool
 * names, or `undefined` when the reader could not read them.
 */
export function kitSentinelFindings(
  repoRoot: string,
  mountedTools: readonly MountedToolModule[],
  frameworkDisabled: Readonly<Record<string, unknown>>,
  eveMounted: readonly string[] | undefined,
  readModule: (specifier: string) => string = (specifier) =>
    readFileSync(createRequire(pathToFileURL(join(repoRoot, "package.json")).href).resolve(specifier), "utf8"),
): KitSentinelFinding[] {
  const findings: KitSentinelFinding[] = [];
  const mounted = eveMounted === undefined ? undefined : new Set(eveMounted);
  for (const tool of [...mountedTools].sort((a, b) => `${a.package}/${a.name}`.localeCompare(`${b.package}/${b.name}`))) {
    const contribution = `tool/${tool.name}`;
    const specifier = `${tool.package}/${tool.module}`;
    let source: string;
    try {
      source = readModule(specifier);
    } catch (err) {
      findings.push({
        package: tool.package,
        contribution,
        why: `the scan cannot read ${specifier} (${err instanceof Error ? err.message.split("\n")[0] : String(err)}), so it cannot tell whether the module is a kit`,
      });
      continue;
    }
    if (!new RegExp(`\\b${KIT_DEFINER}\\b`, "u").test(source)) continue;
    const scan = scanKits(source);
    if ("error" in scan) {
      findings.push({ package: tool.package, contribution, why: `${specifier}: ${scan.error}` });
      continue;
    }
    if (scan.kits.length === 0) continue;
    if (mounted === undefined) {
      findings.push({
        package: tool.package,
        contribution,
        why: `${specifier} is a kit, but the installed eve's set of mounted built-in tools is unreadable, so the scan cannot prove that each member's built-in is disabled`,
      });
      continue;
    }
    const seen = new Set<string>();
    for (const kit of scan.kits) {
      for (const member of kit.members) {
        if (seen.has(member) || !mounted.has(member) || Object.prototype.hasOwnProperty.call(frameworkDisabled, member)) continue;
        seen.add(member);
        findings.push({
          package: tool.package,
          contribution,
          tool: member,
          why: `the kit ${KIT_DEFINER}("${kit.slug}") re-provides eve's built-in "${member}" behind the window-grain gate`,
        });
      }
    }
  }
  return findings;
}

export function kitSentinelRefusal(findings: readonly KitSentinelFinding[]): string[] {
  const missing = findings.filter((f) => f.tool !== undefined);
  const unread = findings.filter((f) => f.tool === undefined);
  const lines = [`✗ oe build: ${findings.length} kit sentinel problem(s) — NOTHING was written.`];
  for (const f of unread) lines.push(`  - KIT · ${f.package} mounts ${f.contribution}, and ${f.why}.`);
  for (const f of missing) {
    lines.push(
      `  - KIT SENTINEL · "${f.tool}": ${f.package} mounts ${f.contribution}, and ${f.why}. A dynamic tool can only ` +
        `SHADOW a static built-in, never remove it. Without a sentinel, eve mounts its own unfenced "${f.tool}" on every seat.`,
    );
  }
  if (missing.length > 0) {
    lines.push("", "  Fix: add these lines to `framework.disable` in roster.config.ts:");
    for (const f of missing) lines.push(`      ${f.tool}: "re-provided per session grain by ${f.contribution} (${f.package})",`);
    lines.push("  Then run `oe build --accept` and read the roster.lock.json diff: the lock records each sentinel.");
  }
  return lines;
}

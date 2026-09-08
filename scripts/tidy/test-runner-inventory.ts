import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { REPO_ROOT, chainLegs, needsSubprocess, type ChainLeg } from "../chain/_legs.js";

const RUNNER_NAME = /(?:^|\/)[^/]+-test\.ts$/u;

export type Shape = "off-chain" | "indirect" | "subprocess-bound" | "socket-binding" | "child-process" | "plain-assert";

export interface RunnerRecord {
  readonly file: string;
  readonly pkg: string | null;
  readonly script: string | null;
  readonly args: readonly string[];
  readonly shape: Shape;
  readonly reason: string;
  readonly lines: number;
  readonly signals: {
    readonly nodeAssert: boolean;
    readonly helperFamilies: readonly HelperFamily[];
    readonly assertionSites: number;
    readonly processExitCount: number;
    readonly processExitZero: boolean;
    readonly processExitCode: boolean;
    readonly processArgv: boolean;
    readonly envWrite: boolean;
    readonly deferredImport: boolean;
    readonly globalThis: boolean;
    readonly tempFs: boolean;
    readonly namesLiveCredentials: boolean;
    readonly readsCwd: boolean;
    readonly topLevelExport: boolean;
    readonly cwdRelativeRead: boolean;
    readonly directAssertSites: number;
    readonly bindsSocket: boolean;
    readonly closingLogPhrase: boolean;
    readonly tickGlyph: boolean;
    readonly zeroCounter: boolean;
    readonly closingLog: boolean;
    readonly exitInProse: boolean;
  };
}

export function trackedRunnerFiles(root: string = REPO_ROOT): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\0")
    .filter((p) => p.length > 0 && RUNNER_NAME.test(p))
    .sort();
}

export interface Views {
  readonly spec: string;
  readonly code: string;
}

export function scanViews(text: string): Views {
  const spec = text.split("");
  const code = text.split("");
  const wipe = (arr: string[], from: number, to: number): void => {
    for (let k = from; k < to && k < arr.length; k++) if (arr[k] !== "\n") arr[k] = " ";
  };
  const both = (from: number, to: number): void => {
    wipe(spec, from, to);
    wipe(code, from, to);
  };
  const n = text.length;
  const substitutions: number[] = [];
  let braceDepth = 0;
  let inTemplate = false;
  let prev = "";
  let prevToken = "";
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (inTemplate) {
      if (c === "\\") {
        wipe(code, i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        wipe(code, i, i + 1);
        inTemplate = false;
        prev = "s";
        i += 1;
        continue;
      }
      if (c === "$" && text[i + 1] === "{") {
        wipe(code, i, i + 2);
        substitutions.push(braceDepth);
        inTemplate = false;
        i += 2;
        continue;
      }
      wipe(code, i, i + 1);
      i += 1;
      continue;
    }
    const c2 = text[i + 1];
    if (c === "/" && c2 === "/") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      both(i, j);
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      both(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== "\n") {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === c) break;
        j += 1;
      }
      j = Math.min(n, j + 1);
      wipe(code, i, j);
      prev = "s";
      i = j;
      continue;
    }
    if (c === "`") {
      wipe(code, i, i + 1);
      inTemplate = true;
      i += 1;
      continue;
    }
    if (c === "/" && regexCanStartAfter(prev, prevToken)) {
      const end = regexEnd(text, i);
      if (end > 0) {
        wipe(code, i, end);
        prev = "s";
        i = end;
        continue;
      }
    }
    if (/[A-Za-z_$]/u.test(c)) {
      let j = i;
      while (j < n && /[\w$]/u.test(text[j]!)) j += 1;
      prevToken = text.slice(i, j);
      prev = text[j - 1]!;
      i = j;
      continue;
    }
    if (c === "{") braceDepth += 1;
    else if (c === "}") {
      if (substitutions.length > 0 && braceDepth === substitutions[substitutions.length - 1]) {
        substitutions.pop();
        wipe(code, i, i + 1);
        inTemplate = true;
        i += 1;
        continue;
      }
      braceDepth -= 1;
    }
    if (!/\s/u.test(c)) {
      prev = c;
      prevToken = "";
    }
    i += 1;
  }
  return { spec: spec.join(""), code: code.join("") };
}

const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

function regexCanStartAfter(prev: string, prevToken: string): boolean {
  if (prevToken !== "") return REGEX_KEYWORDS.has(prevToken);
  return prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev);
}

function regexEnd(text: string, start: number): number {
  let j = start + 1;
  let inClass = false;
  while (j < text.length && text[j] !== "\n") {
    const ch = text[j]!;
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      if (j === start + 1) return 0;
      j += 1;
      while (j < text.length && /[dgimsuvy]/u.test(text[j]!)) j += 1;
      return j;
    }
    j += 1;
  }
  return 0;
}

export function withoutComments(text: string): string {
  return scanViews(text).spec;
}

export function codeOnly(text: string): string {
  return scanViews(text).code;
}

const HELPER_DEF = /^[ \t]*(?:export[ \t]+)?(?:(?:async[ \t]+)?function[ \t]+|const[ \t]+)([A-Za-z_$][\w$]*)[ \t]*(?:=[ \t]*)?(?:\((.*?)\)|async[ \t]*\((.*?)\))\s*(?:=>|:|\{)/gmu;
const HELPER_NAME = /^(?:ok|check|expect|must|eq|is|assertOk|fail|okAudit|eqSet|same|equal)[A-Za-z]*$/u;

export type HelperFamily = "boolean" | "compare" | "reversed";

export function helperFamilies(code: string): HelperFamily[] {
  const found = new Set<HelperFamily>();
  for (const m of code.matchAll(HELPER_DEF)) {
    if (!HELPER_NAME.test(m[1]!)) continue;
    const params = splitParams((m[2] ?? m[3] ?? "").trim());
    if (params.length < 2) continue;
    const isString = (p: string): boolean => /:\s*string\b/u.test(p);
    const isBool = (p: string): boolean => /:\s*boolean\b/u.test(p);
    if (isString(params[0]!) && isBool(params[1]!)) found.add("reversed");
    else if (isBool(params[0]!)) found.add("boolean");
    else found.add("compare");
  }
  return [...found].sort();
}

export function splitParams(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "<" || c === "(" || c === "[" || c === "{") depth++;
    else if (c === ">" || c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last.length > 0) out.push(last);
  return out;
}
const TEMP_FS = /\b(?:mkdtempSync|mkdtemp|tmpdir\(\))/u;
const NAMES_LIVE_CREDENTIALS = /\.env\.e2e|OE_SANDBOX_LIVE|SANDBOX_LIVE|E2E_LIVE/u;

const ASSERT_CALL = /^[ \t]*(?:await[ \t]+)?(?:ok|check|must|eq|is|okAudit|fail|assert|expect|same|equal)[A-Za-z]*(?:\.\w+)?[ \t]*\(/gmu;

function countOf(code: string, re: RegExp): number {
  return [...code.matchAll(re)].length;
}

function closingLines(text: string): string {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-4)
    .join("\n");
}

export function signalsOf(text: string): RunnerRecord["signals"] {
  const spec = withoutComments(text);
  const code = codeOnly(text);
  return {
    nodeAssert: /from\s+"node:assert/u.test(spec),
    helperFamilies: helperFamilies(code),
    assertionSites: countOf(code, ASSERT_CALL),
    processExitCount: countOf(code, /\bprocess\.exit\(/gu),
    processExitZero: /\bprocess\.exit\(\s*0\s*\)/u.test(code),
    processExitCode: /\bprocess\.exitCode\s*=/u.test(code),
    processArgv: /\bprocess\.argv\b/u.test(code),
    envWrite: /\bprocess\.env\.[A-Za-z_]\w*\s*=|\bprocess\.env\[[^\]]+\]\s*=/u.test(code),
    deferredImport: /\bawait\s+import\(/u.test(code),
    globalThis: /\bglobalThis\b/u.test(code),
    tempFs: TEMP_FS.test(code),
    namesLiveCredentials: NAMES_LIVE_CREDENTIALS.test(text),
    readsCwd: /\bprocess\.cwd\(\)/u.test(code) || (/from\s+"node:process"/u.test(spec) && /\bcwd\(\)/u.test(code)),
    topLevelExport: /^export[ \t]+(?:async[ \t]+)?(?:const|function|class|type|interface|default|\{)/mu.test(code),
    cwdRelativeRead: /\b(?:readFileSync|readdirSync|existsSync|writeFileSync)\(\s*"[^"/][^"]*"/u.test(spec),
    directAssertSites: countOf(code, /^[ \t]*(?:await[ \t]+)?assert(?:\.\w+)?[ \t]*\(/gmu),
    bindsSocket: bindsSocket(code),
    closingLogPhrase: /assertions passed/u.test(closingLines(text)),
    tickGlyph: closingLines(text).includes("\u2713"),
    zeroCounter: /^\s*(?:let|const|var)\s+\w+\s*=\s*0\s*;/mu.test(code),
    closingLog: /console\.log/u.test(closingLines(text)),
    exitInProse: countOf(text, /process\.exit\(/gu) > countOf(code, /process\.exit\(/gu),
  };
}

export function spawnsChild(spec: string, code: string): boolean {
  const specLines = spec.split("\n");
  const codeLines = code.split("\n");
  for (let i = 0; i < specLines.length; i++) {
    if (!/"node:child_process"/u.test(specLines[i]!)) continue;
    for (let j = i; j >= 0; j--) {
      const line = codeLines[j] ?? "";
      if (j < i && /;/u.test(line)) break;
      if (/\bimport\b|\brequire\b/u.test(line)) return true;
      if (i - j > 20) break;
    }
  }
  return false;
}

function bindsSocket(code: string): boolean {
  return /\bcreateServer\s*\(|\.listen\s*\(/u.test(code);
}

function subprocessReason(code: string): string {
  if (/\bimport\(\s*`[^`]*\$\{/u.test(code)) {
    return "builds an import specifier with a substitution — vite expands that at transform time";
  }
  return "named in `_legs.ts`'s ROOT_SUBPROCESS_LEGS — a considered exception with its own cause";
}

function classify(
  spec: string,
  code: string,
  leg: ChainLeg | undefined,
  subprocessBound: boolean,
  importedBy: string | undefined,
): { shape: Shape; reason: string } {
  if (!leg) {
    if (importedBy) return { shape: "indirect", reason: `no leg names it; \`${importedBy}\` imports it` };
    return { shape: "off-chain", reason: "no test:chain leg names this file — `npm test` never runs it" };
  }
  if (subprocessBound) return { shape: "subprocess-bound", reason: subprocessReason(spec) };
  if (spawnsChild(spec, code)) return { shape: "child-process", reason: "imports node:child_process to exercise a CLI" };
  if (bindsSocket(code)) return { shape: "socket-binding", reason: "binds a socket — it runs its own server" };
  return { shape: "plain-assert", reason: "asserts in-process against imported modules" };
}

function indirectRunners(files: readonly string[], legs: readonly ChainLeg[], root: string): Map<string, string> {
  const named = new Set(legs.map((l) => relative(root, l.file)));
  const orphans = files.filter((f) => !named.has(f));
  const out = new Map<string, string>();
  if (orphans.length === 0) return out;
  for (const leg of legs) {
    const text = readFileSync(leg.file, "utf8");
    for (const orphan of orphans) {
      if (out.has(orphan)) continue;
      const stem = orphan.slice(orphan.lastIndexOf("/") + 1, -3);
      if (new RegExp(`import\\([^)]*["'\`][^"'\`]*${stem}\\.js`, "u").test(text)) out.set(orphan, `${leg.pkg} ${leg.script}`);
      else if (new RegExp(`from\\s+["'][^"']*${stem}\\.js["']`, "u").test(text)) out.set(orphan, `${leg.pkg} ${leg.script}`);
    }
  }
  return out;
}

export function buildInventory(root: string = REPO_ROOT): RunnerRecord[] {
  const legs = chainLegs();
  const byFile = new Map<string, ChainLeg>();
  for (const leg of legs) {
    const rel = relative(root, leg.file);
    if (byFile.has(rel)) {
      const first = byFile.get(rel)!;
      throw new Error(
        `${rel} is named by two chain legs — \`${first.pkg} ${first.script}\` and \`${leg.pkg} ${leg.script}\`. ` +
          `The fold's hand-over deletes ONE npm script per file, so this file needs a decision before it converts.`,
      );
    }
    byFile.set(rel, leg);
  }
  const files = trackedRunnerFiles(root);
  const importedBy = indirectRunners(files, legs, root);
  const records: RunnerRecord[] = [];
  for (const file of files) {
    const text = readFileSync(resolve(root, file), "utf8");
    const leg = byFile.get(file);
    const subprocessBound = leg !== undefined && needsSubprocess(leg);
    const { shape, reason } = classify(withoutComments(text), codeOnly(text), leg, subprocessBound, importedBy.get(file));
    records.push({
      file,
      pkg: leg?.pkg ?? null,
      script: leg?.script ?? null,
      args: leg?.args ?? [],
      shape,
      reason,
      lines: text.split("\n").length,
      signals: signalsOf(text),
    });
  }
  return records;
}

export function nonRunnerLegs(root: string = REPO_ROOT): ChainLeg[] {
  return chainLegs().filter((leg) => !RUNNER_NAME.test(relative(root, leg.file)));
}

export function unchainedRootScripts(root: string = REPO_ROOT): string[] {
  const scripts = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  const reached = new Set<string>();
  const walk = (name: string): void => {
    if (reached.has(name)) return;
    reached.add(name);
    for (const m of (scripts[name] ?? "").matchAll(/npm\s+run\s+([A-Za-z0-9:_-]+)/gu)) walk(m[1]!);
  };
  walk("test:chain");
  return Object.keys(scripts)
    .filter((k) => k.startsWith("test:") && k !== "test:chain" && k !== "test:suites" && !reached.has(k))
    .sort();
}

const SHAPE_ORDER: readonly Shape[] = ["plain-assert", "child-process", "socket-binding", "subprocess-bound", "indirect", "off-chain"];

const CONVERTS = new Set<Shape>(["plain-assert", "child-process", "socket-binding"]);

function report(records: RunnerRecord[], root: string): string {
  const lines: string[] = [];
  const legs = chainLegs();
  const others = nonRunnerLegs(root);
  lines.push("HAND-ROLLED RUNNER INVENTORY (OPE-1419)");
  lines.push("");
  lines.push(`tracked *-test.ts files          ${records.length}`);
  lines.push(`chain legs (npm test executes)   ${legs.length}`);
  lines.push(`  …of which are *-test.ts        ${legs.length - others.length}`);
  lines.push(`  …of which are lints/other      ${others.length}`);
  lines.push(`off-chain *-test.ts files        ${records.filter((r) => r.shape === "off-chain").length}`);
  lines.push("");
  lines.push("BY SHAPE");
  for (const shape of SHAPE_ORDER) {
    const rows = records.filter((r) => r.shape === shape);
    const loc = rows.reduce((a, r) => a + r.lines, 0);
    lines.push(`  ${shape.padEnd(18)} ${String(rows.length).padStart(4)} files  ${String(loc).padStart(6)} lines`);
  }
  lines.push("");
  lines.push("BY PACKAGE");
  const pkgs = new Map<string, RunnerRecord[]>();
  for (const r of records) {
    const key = r.pkg ?? "(off-chain)";
    const bucket = pkgs.get(key);
    if (bucket) bucket.push(r);
    else pkgs.set(key, [r]);
  }
  for (const [pkg, rows] of [...pkgs].sort((a, b) => b[1].length - a[1].length)) {
    const counts = SHAPE_ORDER.map((s) => `${s}=${rows.filter((r) => r.shape === s).length}`)
      .filter((s) => !s.endsWith("=0"))
      .join(" ");
    lines.push(`  ${pkg.padEnd(34)} ${String(rows.length).padStart(4)}  ${counts}`);
  }
  lines.push("");
  lines.push("SIGNALS (independent of shape; a file can carry several)");
  const flags: (keyof RunnerRecord["signals"])[] = [
    "nodeAssert",
    "processExitZero",
    "processExitCode",
    "processArgv",
    "envWrite",
    "deferredImport",
    "globalThis",
    "tempFs",
    "namesLiveCredentials",
    "readsCwd",
    "topLevelExport",
    "cwdRelativeRead",
    "bindsSocket",
  ];
  for (const key of flags) {
    lines.push(`  ${key.padEnd(22)} ${String(records.filter((r) => r.signals[key] === true).length).padStart(6)}`);
  }
  lines.push(`  ${"passes argv".padEnd(22)} ${String(records.filter((r) => r.args.length > 0).length).padStart(6)}`);
  lines.push("");
  lines.push("ASSERTION HELPER FAMILIES — a file can define several; each has its OWN rewrite");
  for (const family of ["boolean", "compare", "reversed"] as const) {
    const rows = records.filter((r) => r.signals.helperFamilies.includes(family));
    lines.push(`  defines ${family.padEnd(14)} ${String(rows.length).padStart(6)} files`);
  }
  lines.push(`  defines ${"none".padEnd(14)} ${String(records.filter((r) => r.signals.helperFamilies.length === 0).length).padStart(6)} files — each needs a reader`);
  lines.push("");
  lines.push("ASSERTION CALL SITES — statement position only (see ASSERT_CALL), over code, not prose");
  lines.push(`  ${"total".padEnd(22)} ${String(records.reduce((a, r) => a + r.signals.assertionSites, 0)).padStart(6)}`);
  const convertible = records.filter((r) => CONVERTS.has(r.shape));
  lines.push(`  ${"in converting files".padEnd(22)} ${String(convertible.reduce((a, r) => a + r.signals.assertionSites, 0)).padStart(6)}`);
  lines.push("");
  lines.push("process.exit( OCCURRENCES PER FILE — one is the helper's own failure path");
  const exitHist = new Map<number, number>();
  for (const r of records) exitHist.set(r.signals.processExitCount, (exitHist.get(r.signals.processExitCount) ?? 0) + 1);
  for (const [n, count] of [...exitHist].sort((a, b) => a[0] - b[0])) {
    lines.push(`  ${String(n).padStart(2)} call(s)              ${String(count).padStart(6)} files`);
  }
  lines.push("");
  lines.push(`CONVERTS: ${convertible.length} files   STAYS A tsx SCRIPT: ${records.length - convertible.length} files`);
  lines.push("");
  lines.push("CODEMOD RESIDUE — over CONVERTING files only, because a slice opens no other kind");
  const plain = convertible.filter((r) => r.shape === "plain-assert");
  const needsRead = (r: RunnerRecord): boolean =>
    r.signals.helperFamilies.includes("compare") || r.signals.helperFamilies.includes("reversed") || r.signals.helperFamilies.length === 0;
  const row = (label: string, n: number, of: string): void => {
    lines.push(`  ${label.padEnd(38)} ${String(n).padStart(5)}  ${of}`);
  };
  row("read-and-decide (not one rewrite)", convertible.filter(needsRead).length, "of the converting set");
  row("defines >1 helper family", convertible.filter((r) => r.signals.helperFamilies.length > 1).length, "of the converting set");
  row("…and over ALL runners", records.filter((r) => r.signals.helperFamilies.length > 1).length, "the figure the plan quotes");
  row("calls process.exit more than once", convertible.filter((r) => r.signals.processExitCount > 1).length, "of the converting set");
  row("sets process.exitCode instead", convertible.filter((r) => r.signals.processExitCode).length, "of the converting set");
  row("a process.exit( in a string/comment", convertible.filter((r) => r.signals.exitInProse).length, "verify gate must read code");
  row("binds a socket (owes an afterAll close)", convertible.filter((r) => r.signals.bindsSocket).length, "of the converting set");
  lines.push("");
  lines.push("…and over the plain-assert files the codemod's skeleton assumptions cover:");
  row("HAS a closing console.log at all", plain.filter((r) => r.signals.closingLog).length, "🔴 the robust match — use this");
  row("says `assertions passed`", plain.filter((r) => r.signals.closingLogPhrase).length, "a WORDING, not the match");
  row("carries the ✓ glyph", plain.filter((r) => r.signals.tickGlyph).length, "a WORDING, not the match");
  row("…glyph AND NOT phrase", plain.filter((r) => r.signals.tickGlyph && !r.signals.closingLogPhrase).length, "the two wordings cross");
  row("…phrase AND NOT glyph", plain.filter((r) => r.signals.closingLogPhrase && !r.signals.tickGlyph).length, "…in both directions");
  row("a log a PHRASE-only match strands", plain.filter((r) => r.signals.closingLog && !r.signals.closingLogPhrase).length, "counter deleted, log kept");
  row("a log a GLYPH-only match strands", plain.filter((r) => r.signals.closingLog && !r.signals.tickGlyph).length, "counter deleted, log kept");
  row("NO zero-initialised counter", plain.filter((r) => !r.signals.zeroCounter).length, "the codemod's step 5 misses these");
  row("NO closing console.log", plain.filter((r) => !r.signals.closingLog).length, "the codemod's step 5 misses these");
  row("NO recognised helper", plain.filter((r) => r.signals.helperFamilies.length === 0).length, "each needs a reader");
  lines.push("");
  lines.push("WHERE expect.soft's PER-FAILURE REPORTING STOPS — step 6 leaves `assert…` alone, and it throws");
  row("uses node:assert DIRECTLY", convertible.filter((r) => r.signals.directAssertSites > 0).length, "of the converting set");
  row("…with 3+ such sites", convertible.filter((r) => r.signals.directAssertSites >= 3).length, "beyond any helper body");
  lines.push("");
  lines.push("SIDE EFFECTS THAT NOW RUN PAST A FAILED SOFT ASSERTION");
  row("creates a temp directory / removes a tree", convertible.filter((r) => r.signals.tempFs).length, "of the converting set");
  row("binds a socket", convertible.filter((r) => r.signals.bindsSocket).length, "of the converting set");
  lines.push("");
  const unchained = unchainedRootScripts(root);
  lines.push(`ROOT test:* SCRIPTS OFF THE ROOT CHAIN (${unchained.length}) — each declared in OFF_CHAIN_BY_DESIGN (OPE-1470)`);
  for (const name of unchained) lines.push(`  ${name}`);
  lines.push("");
  lines.push("NOT PLAIN-ASSERT — the files whose recipe is not mechanical, named");
  for (const shape of ["child-process", "socket-binding", "subprocess-bound", "indirect", "off-chain"] as const) {
    for (const r of records.filter((x) => x.shape === shape)) {
      lines.push(`  [${shape}] ${r.file}${r.script ? ` (${r.pkg} ${r.script})` : ""} — ${r.reason}`);
    }
  }
  return lines.join("\n");
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]).endsWith("test-runner-inventory.ts");
if (isMain) {
  const records = buildInventory();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ records, nonRunnerLegs: nonRunnerLegs().map((l) => `${l.pkg} ${l.script}`) }, null, 2)}\n`);
  } else {
    process.stdout.write(`${report(records, REPO_ROOT)}\n`);
  }
}

export const PRINCIPAL_GATE_INTENTS = ["accountability", "presence"] as const;
export type PrincipalGateIntent = (typeof PRINCIPAL_GATE_INTENTS)[number];

export type PrincipalAccessor = "bound" | "acting" | "opaque";

export const BINDING_RECEIVERS: readonly string[] = ["binding", "b"];

export const DESTRUCTURED_PRINCIPAL_KEYS: Readonly<Record<string, PrincipalAccessor>> = {
  actingPrincipalId: "acting",
  principalId: "opaque",
};

export const INTENT_FOR_ACCESSOR: Readonly<Partial<Record<PrincipalAccessor, PrincipalGateIntent>>> = {
  bound: "accountability",
  acting: "presence",
};

export interface PrincipalGate {
  readonly file: string;
  readonly line: number;
  readonly accessor: PrincipalAccessor;
  readonly expr: string;
  readonly intent?: PrincipalGateIntent;
  readonly reason?: string;
  readonly unknownIntent?: string;
}

export interface PrincipalGateDefect {
  readonly file: string;
  readonly line: number;
  readonly rule:
    | "unmarked"
    | "mismatched"
    | "unknown-intent"
    | "no-reason"
    | "unattended-inline-bag"
    | "attendedness-missing"
    | "attendedness-hand-rolled"
    | "attendedness-eve-approval-underived"
    | "attendedness-exempt-no-reason"
    | "approval-authority-context-missing"
    | "approval-authority-exempt-no-reason";
  readonly message: string;
}

const EXPRESSION_KEYWORDS: ReadonlySet<string> = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "extends",
]);
const HEAD_KEYWORDS: ReadonlySet<string> = new Set(["if", "while", "for", "with"]);

interface Frame {
  readonly kind: "root" | "paren" | "bracket" | "block" | "expr" | "hole";
  readonly head?: boolean;
  ternary: number;
}

export interface LexicalViews {
  readonly code: string[];
  readonly bare: string[];
}

export function lexicalViews(source: string): LexicalViews {
  const n = source.length;
  let code = "";
  let bare = "";
  const keep = (s: string): void => {
    code += s;
    bare += s;
  };
  const blank = (s: string): string => s.replace(/[^\n]/g, " ");
  const stack: Frame[] = [{ kind: "root", ternary: 0 }];
  const top = (): Frame => stack[stack.length - 1]!;
  let regexOk = true;
  let prevWord = "";
  let afterDot = false;
  let prevTok = "";
  let i = 0;

  const templateText = (): void => {
    while (i < n) {
      const c = source[i]!;
      if (c === "\\") {
        const esc = source.slice(i, i + 2);
        code += esc;
        bare += blank(esc);
        i += esc.length;
        continue;
      }
      if (c === "`") {
        keep(c);
        i += 1;
        regexOk = false;
        prevTok = "`";
        return;
      }
      if (c === "$" && source[i + 1] === "{") {
        keep("${");
        i += 2;
        stack.push({ kind: "hole", ternary: 0 });
        regexOk = true;
        prevTok = "${";
        return;
      }
      code += c;
      bare += c === "\n" ? c : " ";
      i += 1;
    }
  };

  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === "\u00a0" || c === "\ufeff") {
      keep(c);
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      const text = blank(source.slice(i, stop));
      code += text;
      bare += text;
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      const text = blank(source.slice(i, stop));
      code += text;
      bare += text;
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      keep(c);
      i += 1;
      while (i < n) {
        const d = source[i]!;
        if (d === "\\") {
          const esc = source.slice(i, i + 2);
          code += esc;
          bare += blank(esc);
          i += esc.length;
          continue;
        }
        if (d === "\n") break;
        if (d === c) {
          keep(d);
          i += 1;
          break;
        }
        code += d;
        bare += " ";
        i += 1;
      }
      regexOk = false;
      afterDot = false;
      prevWord = "";
      prevTok = c;
      continue;
    }
    if (c === "`") {
      keep(c);
      i += 1;
      afterDot = false;
      prevWord = "";
      templateText();
      continue;
    }
    if (c === "/" && regexOk) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && source[j] !== "\n") {
        const d = source[j]!;
        if (d === "\\") {
          if (source[j + 1] === "\n") break;
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed && j < n) {
        let k = j + 1;
        while (k < n && /[\w$]/.test(source[k]!)) k += 1;
        const body = source.slice(i + 1, j);
        code += source.slice(i, k);
        bare += `/${blank(body)}/${source.slice(j + 1, k)}`;
        i = k;
        regexOk = false;
        afterDot = false;
        prevWord = "";
        prevTok = "/re/";
        continue;
      }
    }
    if (/[\w$\u0080-\uffff#]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$\u0080-\uffff]/.test(source[j]!)) j += 1;
      const word = source.slice(i, j);
      keep(word);
      i = j;
      const isProperty = afterDot;
      afterDot = false;
      prevWord = isProperty ? "" : word === "await" && prevTok === "for" ? "for" : word;
      regexOk = !isProperty && EXPRESSION_KEYWORDS.has(word);
      prevTok = isProperty ? "name" : word;
      continue;
    }
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    let tok: string;
    if (three === "..." || three === "!==" || three === "===" || three === "**=" || three === "<<=" || three === ">>=" || three === "&&=" || three === "||=" || three === "??=") tok = three;
    else if (["=>", "?.", "++", "--", "!=", "==", "<=", ">=", "&&", "||", "??", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"].includes(two)) tok = two;
    else tok = c;
    if (tok === "?." && /[0-9]/.test(source[i + 2] ?? "")) tok = "?";
    keep(tok);
    i += tok.length;
    const word = prevWord;
    prevWord = "";
    afterDot = false;
    switch (tok) {
      case ".":
      case "?.":
        afterDot = true;
        regexOk = false;
        break;
      case "(":
        stack.push({ kind: "paren", head: HEAD_KEYWORDS.has(word), ternary: 0 });
        regexOk = true;
        break;
      case ")": {
        const f = top().kind === "paren" ? stack.pop()! : undefined;
        regexOk = f?.head === true;
        break;
      }
      case "[":
        stack.push({ kind: "bracket", ternary: 0 });
        regexOk = true;
        break;
      case "]":
        if (top().kind === "bracket") stack.pop();
        regexOk = false;
        break;
      case "{": {
        const statementStart =
          prevTok === "" || prevTok === ")" || prevTok === "=>" || prevTok === ";" || prevTok === "{" || prevTok === "}" ||
          prevTok === "label:" || prevTok === "name" || (/^[\w$#\u0080-\uffff]/.test(prevTok) && !EXPRESSION_KEYWORDS.has(prevTok)) ||
          prevTok === "else" || prevTok === "do";
        stack.push({ kind: statementStart ? "block" : "expr", ternary: 0 });
        regexOk = true;
        break;
      }
      case "}": {
        const f = stack.length > 1 ? stack.pop()! : top();
        if (f.kind === "hole") {
          prevTok = "}";
          templateText();
          continue;
        }
        regexOk = f.kind !== "expr";
        break;
      }
      case "?":
        top().ternary += 1;
        regexOk = true;
        break;
      case ":": {
        const f = top();
        if (f.ternary > 0) {
          f.ternary -= 1;
          tok = "?:";
        } else if (f.kind === "root" || f.kind === "block") {
          tok = "label:";
        }
        regexOk = true;
        break;
      }
      case "++":
      case "--":
        break;
      case "!":
        break;
      default:
        regexOk = true;
    }
    prevTok = tok;
  }
  return { code: code.split("\n"), bare: bare.split("\n") };
}

const ACTING_RE = /\bactingPrincipalIdOf\s*\(|\bactingPrincipalId\s*\(/;
const BOUND_CALL_RE = /\bprincipalIdOf\s*\(/;
const PROP_RE = /([A-Za-z_$][\w$]*)\.principalId\b(?!Of)/;

function accessorOn(code: string): { accessor: PrincipalAccessor; expr: string } | undefined {
  if (ACTING_RE.test(code)) return { accessor: "acting", expr: code.match(ACTING_RE)![0].replace(/\s+/g, "") };
  if (BOUND_CALL_RE.test(code)) return { accessor: "bound", expr: "principalIdOf(" };
  const prop = PROP_RE.exec(code);
  if (prop) {
    const receiver = prop[1]!;
    return { accessor: BINDING_RECEIVERS.includes(receiver) ? "bound" : "opaque", expr: `${receiver}.principalId` };
  }
  return undefined;
}

const DESTRUCTURE_DECL_RE = /^\s*(?:const|let)\s*\{(.*)\}\s*=/;

function destructuredPrincipalBindings(code: readonly string[]): Map<string, PrincipalAccessor> {
  const bound = new Map<string, PrincipalAccessor>();
  for (const line of code) {
    const m = DESTRUCTURE_DECL_RE.exec(line);
    if (!m) continue;
    for (const raw of (m[1] ?? "").split(",")) {
      const lhs = (raw.split("=")[0] ?? "").trim();
      const parts = lhs.split(":");
      const key = (parts[0] ?? "").trim();
      const name = (parts[1] ?? parts[0] ?? "").trim();
      const accessor = DESTRUCTURED_PRINCIPAL_KEYS[key];
      if (accessor === undefined || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const prior = bound.get(name);
      bound.set(name, prior !== undefined && prior !== accessor ? "opaque" : accessor);
    }
  }
  return bound;
}

const THROW_WINDOW = 4;
const BINDING_WINDOW = 20;

const MARKER_RE = /principal-gate:\s*([A-Za-z-]+)\s*(?:—|-{1,2}|:)?\s*(.*)$/;

function markerAbove(lines: readonly string[], line: number): { intent: string; reason: string } | undefined {
  for (let i = line - 2; i >= 0; i--) {
    const t = (lines[i] ?? "").trim();
    if (t === "") continue;
    const isComment = t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
    if (!isComment) return undefined;
    const m = MARKER_RE.exec(t);
    if (m) return { intent: m[1]!.toLowerCase(), reason: (m[2] ?? "").trim() };
  }
  return undefined;
}

export function findPrincipalGates(file: string, source: string): PrincipalGate[] {
  const lines = source.split("\n");
  const { code } = lexicalViews(source);
  const gates: PrincipalGate[] = [];
  const destructured = destructuredPrincipalBindings(code);

  const hasThrowWithin = (from: number): boolean => {
    for (let j = from; j < Math.min(from + 1 + THROW_WINDOW, code.length); j++) {
      if (/\bthrow\b/.test(code[j] ?? "")) return true;
    }
    return false;
  };

  for (let i = 0; i < code.length; i++) {
    const c = code[i] ?? "";
    const found = accessorOn(c);
    if (!found) {
      const refused = destructuredRefusalOn(c, destructured);
      if (refused && hasThrowWithin(i)) {
        gates.push({ file, line: i + 1, accessor: refused.accessor, expr: refused.name, ...markerFields(lines, i + 1) });
      }
      continue;
    }

    if (/\bif\s*\(\s*!/.test(c) && hasThrowWithin(i)) {
      gates.push({ file, line: i + 1, ...found, ...markerFields(lines, i + 1) });
      continue;
    }

    const decl = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/.exec(c);
    if (!decl || !accessorOn(decl[2] ?? "")) continue;
    const name = decl[1]!;
    const falsy = new RegExp(`\\bif\\s*\\(\\s*(?:!${name}\\s*\\)|${name}\\s*===\\s*undefined\\s*\\))`);
    for (let j = i + 1; j < Math.min(i + 1 + BINDING_WINDOW, code.length); j++) {
      if (!falsy.test(code[j] ?? "")) continue;
      if (hasThrowWithin(j)) gates.push({ file, line: i + 1, ...found, ...markerFields(lines, i + 1) });
      break;
    }
  }
  return gates;
}

function destructuredRefusalOn(
  code: string,
  destructured: ReadonlyMap<string, PrincipalAccessor>,
): { readonly name: string; readonly accessor: PrincipalAccessor } | undefined {
  if (destructured.size === 0 || !/\bif\s*\(/.test(code)) return undefined;
  for (const [name, accessor] of destructured) {
    const falsy = new RegExp(`\\bif\\s*\\(\\s*(?:!${name}\\s*\\)|${name}\\s*===\\s*undefined\\s*\\))`);
    if (falsy.test(code)) return { name, accessor };
  }
  return undefined;
}

function markerFields(lines: readonly string[], line: number): Pick<PrincipalGate, "intent" | "reason" | "unknownIntent"> {
  const m = markerAbove(lines, line);
  if (!m) return {};
  const known = (PRINCIPAL_GATE_INTENTS as readonly string[]).includes(m.intent);
  return known ? { intent: m.intent as PrincipalGateIntent, reason: m.reason } : { unknownIntent: m.intent, reason: m.reason };
}

export interface UnattendedDispatchSite {
  readonly file: string;
  readonly line: number;
  readonly viaFireAuth: boolean;
}

const SERVICE_PRINCIPAL_RE = /\bprincipalType:\s*["']service["']/;
const ATTRIBUTES_KEY_RE = /\battributes:\s/;
const FIRE_AUTH_BUILDER_RE = /FireAttributes\s*\(/;
const ATTRIBUTES_WINDOW = 40;

export function findUnattendedDispatchSites(file: string, source: string): UnattendedDispatchSite[] {
  const { code } = lexicalViews(source);
  const sites: UnattendedDispatchSite[] = [];
  for (let i = 0; i < code.length; i++) {
    if (!SERVICE_PRINCIPAL_RE.test(code[i] ?? "")) continue;
    let viaFireAuth = false;
    for (let j = i; j < Math.min(i + 1 + ATTRIBUTES_WINDOW, code.length); j++) {
      if (!ATTRIBUTES_KEY_RE.test(code[j] ?? "")) continue;
      viaFireAuth = FIRE_AUTH_BUILDER_RE.test(code[j] ?? "");
      break;
    }
    sites.push({ file, line: i + 1, viaFireAuth });
  }
  return sites;
}

export function checkUnattendedDispatch(sites: readonly UnattendedDispatchSite[]): PrincipalGateDefect[] {
  return sites
    .filter((s) => !s.viaFireAuth)
    .map((s) => ({
      file: s.file,
      line: s.line,
      rule: "unattended-inline-bag" as const,
      message:
        `a session auth naming a SERVICE principal whose attribute bag does not come from routines/fire-auth.ts. ` +
        `An unattended origin MUST carry the FIRE_UNATTENDED_ATTR marker — without it, its non-empty service id answers ` +
        `every presence gate in the tree as if a human were acting (OPE-278; the webhook fire shipped exactly this way). ` +
        `Build the bag with routineFireAttributes / webhookFireAttributes (or a sibling builder in that module), never inline.`,
    }));
}

export function checkPrincipalGates(gates: readonly PrincipalGate[]): PrincipalGateDefect[] {
  const defects: PrincipalGateDefect[] = [];
  for (const g of gates) {
    if (g.unknownIntent !== undefined) {
      defects.push({
        file: g.file,
        line: g.line,
        rule: "unknown-intent",
        message: `principal-gate marker says "${g.unknownIntent}" — the vocabulary is exactly ${PRINCIPAL_GATE_INTENTS.join(" | ")}.`,
      });
      continue;
    }
    if (g.intent === undefined) {
      defects.push({
        file: g.file,
        line: g.line,
        rule: "unmarked",
        message:
          `a refusal gate over \`${g.expr}\` with no principal-gate marker. Say which question it asks:\n` +
          `      // principal-gate: accountability — somebody NAMEABLE must exist (a card needs an "asked by" line). A fire's attested creator satisfies this, correctly.\n` +
          `      // principal-gate: presence — a HUMAN must be here, acting. A fire must NOT satisfy this — read the ACTING principal (actingPrincipalIdOf / actingPrincipalId).`,
      });
      continue;
    }
    const deliverable = INTENT_FOR_ACCESSOR[g.accessor];
    if (deliverable !== undefined && g.intent !== deliverable) {
      defects.push({
        file: g.file,
        line: g.line,
        rule: "mismatched",
        message:
          g.intent === "presence"
            ? `declares intent "presence" but reads \`${g.expr}\`, which is the BOUND principal — on a triggered routine fire that is the routine's attested creator, a real person's id, so this refusal can never fire. Read the ACTING principal instead (actingPrincipalIdOf(ctx) / actingPrincipalId(binding)).`
            : `declares intent "accountability" but reads the ACTING principal, which is \`undefined\` on every fire. If refusing a fire is the point, the intent is "presence"; if naming the requester is the point, read the bound principal (principalIdOf(ctx) / binding.principalId).`,
      });
      continue;
    }
    if ((g.reason ?? "").length < 12) {
      defects.push({
        file: g.file,
        line: g.line,
        rule: "no-reason",
        message: `principal-gate marker declares "${g.intent}" with no reason after it. Write why — the word alone is a rubber stamp, and the reason is what a later reader needs to tell whether it still holds.`,
      });
    }
  }
  return defects;
}

export const ATTENDEDNESS_DERIVATION = "unattendedOf(ctx)";
export const ATTENDEDNESS_DERIVATION_BINDING = "unattendedFrom(binding)";
const DERIVATION_CALL_RE = /\b(?:unattendedOf|unattendedFrom)\s*\(/;

export interface AttendednessSite {
  readonly file: string;
  readonly line: number;
  readonly shape: "propose" | "chain-literal" | "eve-approval";
  readonly expr?: string;
  readonly derivedInFile?: boolean;
  readonly exemptReason?: string;
  readonly exempt: boolean;
  readonly authorityContext?: string;
  readonly authorityExempt: boolean;
  readonly authorityExemptReason?: string;
}

const PROPOSE_CALL_RE = /\brequestApproval\s*\(/;
const PROPOSE_ALIAS_DECL_RE = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/;

const REFERENCE_OPERAND = String.raw`[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*`;

const PROPOSE_ALIAS_RHS_RE = new RegExp(String.raw`^${REFERENCE_OPERAND}(?:\s*(?:\?\?|\|\|)\s*${REFERENCE_OPERAND})*\s*;?\s*$`);

function proposeAliasOn(line: string): ProposeAliasRead {
  const m = PROPOSE_ALIAS_DECL_RE.exec(line);
  if (!m) return undefined;
  const rhs = m[2] ?? "";
  if (!/\brequestApproval\b/.test(rhs) || PROPOSE_CALL_RE.test(rhs)) return undefined;
  if (!PROPOSE_ALIAS_RHS_RE.test(rhs.trim())) return { kind: "unclassified" };
  return m[1] === "requestApproval" ? undefined : { kind: "alias", name: m[1]! };
}

type ProposeAliasRead = { readonly kind: "alias"; readonly name: string } | { readonly kind: "unclassified" } | undefined;

export interface ProposeAliasShapeProblem {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export function findProposeAliasShapeProblems(file: string, source: string): ProposeAliasShapeProblem[] {
  const lines = source.split("\n");
  const { bare } = lexicalViews(source);
  const problems: ProposeAliasShapeProblem[] = [];
  for (let i = 0; i < bare.length; i++) {
    if (proposeAliasOn(bare[i] ?? "")?.kind === "unclassified") problems.push({ file, line: i + 1, text: (lines[i] ?? "").trim().slice(0, 160) });
  }
  return problems;
}
const CHAIN_LITERAL_RE = /\bresolveApproverChain\s*\(\s*\{|:\s*ApprovalChainRequest\s*=\s*\{/;
const EVE_APPROVAL_DECL_RE = /^\s*(?:export\s+)?(?:const|let)\s+[A-Za-z_$][\w$]*\s*:\s*(?:Approval|ApprovalPolicy)\b[^=]*=/;
const EVE_APPROVAL_RETURN_RE = /\)\s*:\s*(?:Approval|ApprovalPolicy)\b[^{;]*\{\s*$/;
const DECLARATION_RE = /\bfunction\s+(?:requestApproval|resolveApproverChain)\b/;
const UNATTENDED_KEY_RE = /\bunattended\s*:\s*(.+)$/;
const UNATTENDED_SHORTHAND_RE = /^\s*unattended\s*,\s*$/;
const ATTENDEDNESS_WINDOW = 60;
const EXEMPT_MARKER_RE = /approval-chain:\s*exempt\s*(?:—|-{1,2}|:)?\s*(.*)$/;
const AUTHORITY_EXEMPT_RE = /approval-authority:\s*headless\s*(?:—|-{1,2}|:)?\s*(.*)$/;

function exemptMarkerAbove(lines: readonly string[], line: number): { reason: string } | undefined {
  for (let i = line - 2; i >= 0; i--) {
    const t = (lines[i] ?? "").trim();
    if (t === "") continue;
    if (!(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"))) return undefined;
    const m = EXEMPT_MARKER_RE.exec(t);
    if (m) return { reason: (m[1] ?? "").trim() };
  }
  return undefined;
}

function authorityExemptAbove(lines: readonly string[], line: number): { reason: string } | undefined {
  for (let i = line - 2; i >= 0; i--) {
    const t = (lines[i] ?? "").trim();
    if (t === "") continue;
    if (!(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"))) return undefined;
    const m = AUTHORITY_EXEMPT_RE.exec(t);
    if (m) return { reason: (m[1] ?? "").trim() };
  }
  return undefined;
}

const DECL_OPENER_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b|(?:const|let)\s)/;
const DECL_OPENER_WINDOW = 12;

function eveApprovalExemptMarker(lines: readonly string[], line: number): { reason: string } | undefined {
  const direct = exemptMarkerAbove(lines, line);
  if (direct !== undefined) return direct;
  const indentOf = (t: string) => (t.match(/^\s*/) ?? [""])[0].length;
  const matchIndent = indentOf(lines[line - 1] ?? "");
  for (let i = line - 2; i >= 0 && i >= line - 2 - DECL_OPENER_WINDOW; i--) {
    const t = lines[i] ?? "";
    if (t.trim() !== "" && indentOf(t) > matchIndent) continue;
    return DECL_OPENER_RE.test(t) ? exemptMarkerAbove(lines, i + 1) : undefined;
  }
  return undefined;
}

function derivedNames(code: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const line of code) {
    const m = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/.exec(line);
    if (m && DERIVATION_CALL_RE.test(m[2] ?? "")) names.add(m[1]!);
  }
  return names;
}

function proposeAliases(bare: readonly string[]): RegExp | undefined {
  const names: string[] = [];
  for (const line of bare) {
    const read = proposeAliasOn(line);
    if (read?.kind === "alias") names.push(read.name);
  }
  return names.length === 0 ? undefined : new RegExp(`\\b(?:${names.join("|")})\\s*\\(`);
}

export function findAttendednessSites(file: string, source: string): AttendednessSite[] {
  const lines = source.split("\n");
  const { code, bare } = lexicalViews(source);
  const aliasCall = proposeAliases(bare);
  const sites: AttendednessSite[] = [];
  const fileDerives = code.some((l) => DERIVATION_CALL_RE.test(l));
  for (let i = 0; i < code.length; i++) {
    const c = code[i] ?? "";
    if (DECLARATION_RE.test(c) || proposeAliasOn(bare[i] ?? "") !== undefined) continue;
    if (EVE_APPROVAL_DECL_RE.test(c) || EVE_APPROVAL_RETURN_RE.test(c)) {
      const eveMarker = eveApprovalExemptMarker(lines, i + 1);
      sites.push({
        file,
        line: i + 1,
        shape: "eve-approval",
        derivedInFile: fileDerives,
        ...(eveMarker !== undefined ? { exemptReason: eveMarker.reason } : {}),
        exempt: eveMarker !== undefined,
        authorityExempt: false,
      });
      continue;
    }
    const isPropose = PROPOSE_CALL_RE.test(c) || (aliasCall !== undefined && aliasCall.test(c));
    if (!isPropose && !CHAIN_LITERAL_RE.test(c)) continue;
    const indent = (c.match(/^\s*/) ?? [""])[0].length;
    let expr: string | undefined;
    let authorityContext: string | undefined;
    for (let j = i; j < Math.min(i + 1 + ATTENDEDNESS_WINDOW, code.length); j++) {
      const line = code[j] ?? "";
      if (j > i && /^\s*[)}]/.test(line) && (line.match(/^\s*/) ?? [""])[0].length <= indent) break;
      if (UNATTENDED_SHORTHAND_RE.test(line)) {
        expr = "unattended";
      }
      const m = UNATTENDED_KEY_RE.exec(line);
      if (m) {
        expr = (m[1] ?? "").trim().replace(/[,}]+\s*$/, "").trim();
      }
      const postDeps = /\bapprovalPostDeps\s*\(\s*[^,)]*(?:,\s*([A-Za-z_$][\w$]*))?\s*\)/.exec(line);
      if (postDeps?.[1]) authorityContext = postDeps[1];
      const explicit = /\bauthorityContext\s*:\s*([A-Za-z_$][\w$]*)/.exec(line);
      if (explicit?.[1]) authorityContext = explicit[1];
      if (/^\s*authorityContext\s*,\s*$/.test(line)) authorityContext = "authorityContext";
    }
    const marker = exemptMarkerAbove(lines, i + 1);
    const authorityMarker = isPropose ? authorityExemptAbove(lines, i + 1) : undefined;
    sites.push({
      file,
      line: i + 1,
      shape: isPropose ? "propose" : "chain-literal",
      ...(expr !== undefined ? { expr } : {}),
      ...(marker !== undefined ? { exemptReason: marker.reason } : {}),
      exempt: marker !== undefined,
      ...(authorityContext !== undefined ? { authorityContext } : {}),
      authorityExempt: authorityMarker !== undefined,
      ...(authorityMarker !== undefined ? { authorityExemptReason: authorityMarker.reason } : {}),
    });
  }
  const derived = derivedNames(code);
  return sites.map((s) =>
    s.expr !== undefined && derived.has(s.expr) ? { ...s, expr: `${s.expr} = ${ATTENDEDNESS_DERIVATION}` } : s,
  );
}

export function checkAttendednessSites(sites: readonly AttendednessSite[]): PrincipalGateDefect[] {
  const defects: PrincipalGateDefect[] = [];
  for (const s of sites) {
    if (s.exempt) {
      if ((s.exemptReason ?? "").length < 12) {
        defects.push({
          file: s.file,
          line: s.line,
          rule: "attendedness-exempt-no-reason",
          message:
            `an \`approval-chain: exempt\` marker with no reason after it. Write why this site cannot derive attendedness ` +
            `from a turn — the word alone is a rubber stamp, and this marker is the one way to opt OUT of a security control.`,
        });
      }
      continue;
    }
    if (s.shape === "eve-approval") {
      if (s.derivedInFile === true) continue;
      defects.push({
        file: s.file,
        line: s.line,
        rule: "attendedness-eve-approval-underived",
        message:
          `an eve \`ApprovalPolicy\` / \`Approval<T>\` site in a file that never derives attendedness.\n` +
          `      eve's approval plane is the SECOND approval front door in this tree. A \`"user-approval"\` answer becomes a\n` +
          `      \`tool-approval\` input request that SUSPENDS the run with \`status:"input_required"\` and no timeout arm, so on an\n` +
          `      unattended fire it raises a card nobody can click and the fire never settles (OPE-1241). Derive the signal with\n` +
          `      \`${ATTENDEDNESS_DERIVATION}\` (access/request.ts) or \`${ATTENDEDNESS_DERIVATION_BINDING}\` (identity/binding.ts)\n` +
          `      and REFUSE an unattended run instead of parking it — connections/connector-auth.ts\n` +
          `      \`withUnattendedConnectorFence\` is the worked example. If this policy authors no verdict of its own (a\n` +
          `      pass-through wrapper, whose wrapped policy owns the question):\n` +
          `      // approval-chain: exempt — <why this site decides nothing>`,
      });
      continue;
    }
    if (s.expr === undefined) {
      if (s.shape !== "propose") continue;
      defects.push({
        file: s.file,
        line: s.line,
        rule: "attendedness-missing",
        message:
          `a propose site with no \`chain:\` bag. Pass \`chain: { unattended: ${ATTENDEDNESS_DERIVATION} },\`.\n` +
          `      The approver chain turns \`ask\` into \`deny\` on this signal, so a site that omits it lets an autonomous\n` +
          `      fire card into an empty room (OPE-440). If this kind never routes through the chain (a NON_TOOL_ACTION_KIND):\n` +
          `      // approval-chain: exempt — <why the chain never sees this kind>`,
      });
      continue;
    }
    if (!DERIVATION_CALL_RE.test(s.expr)) {
      defects.push({
        file: s.file,
        line: s.line,
        rule: "attendedness-hand-rolled",
        message:
          `derives attendedness as \`${s.expr}\` instead of \`${ATTENDEDNESS_DERIVATION}\` (access/request.ts) or ` +
          `\`${ATTENDEDNESS_DERIVATION_BINDING}\` (identity/binding.ts).\n` +
          `      One function, one place to test it. A hand-rolled spelling is how the wrong accessor gets in: read the BOUND\n` +
          `      principal here and every fire answers "a human is present", because a fire binds as its attested creator.`,
      });
    }
  }
  return defects;
}

export function checkApprovalAuthoritySites(sites: readonly AttendednessSite[]): PrincipalGateDefect[] {
  const defects: PrincipalGateDefect[] = [];
  for (const site of sites) {
    if (site.shape !== "propose") continue;
    if (site.authorityExempt) {
      if ((site.authorityExemptReason ?? "").length < 12) {
        defects.push({ file: site.file, line: site.line, rule: "approval-authority-exempt-no-reason", message: "an `approval-authority: headless` marker needs a reason naming why this caller has no live model turn" });
      }
      continue;
    }
    if (site.authorityContext !== "ctx") {
      defects.push({
        file: site.file,
        line: site.line,
        rule: "approval-authority-context-missing",
        message: "requestApproval must receive dependencies carrying the live tool context (`approvalPostDeps(platform, ctx)` or `authorityContext: ctx`) so a decision wake restores the exact proposing wake; use `approval-authority: headless — <reason>` only for a real control-plane caller",
      });
    }
  }
  return defects;
}

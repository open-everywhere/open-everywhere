export const PRINCIPAL_GATE_INTENTS = ["accountability", "presence"] as const;
export type PrincipalGateIntent = (typeof PRINCIPAL_GATE_INTENTS)[number];

export type PrincipalAccessor = "bound" | "acting" | "opaque";

export const BINDING_RECEIVERS: readonly string[] = ["binding", "b"];

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
  readonly rule: "unmarked" | "mismatched" | "unknown-intent" | "no-reason";
  readonly message: string;
}

function stripComments(lines: readonly string[]): string[] {
  let inBlock = false;
  return lines.map((raw) => {
    let out = "";
    let i = 0;
    while (i < raw.length) {
      if (inBlock) {
        if (raw.startsWith("*/", i)) {
          inBlock = false;
          out += "  ";
          i += 2;
        } else {
          out += " ";
          i += 1;
        }
        continue;
      }
      if (raw.startsWith("/*", i)) {
        inBlock = true;
        out += "  ";
        i += 2;
        continue;
      }
      if (raw.startsWith("//", i)) {
        out += " ".repeat(raw.length - i);
        break;
      }
      out += raw[i];
      i += 1;
    }
    return out;
  });
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
  const code = stripComments(lines);
  const gates: PrincipalGate[] = [];

  const hasThrowWithin = (from: number): boolean => {
    for (let j = from; j < Math.min(from + 1 + THROW_WINDOW, code.length); j++) {
      if (/\bthrow\b/.test(code[j] ?? "")) return true;
    }
    return false;
  };

  for (let i = 0; i < code.length; i++) {
    const c = code[i] ?? "";
    const found = accessorOn(c);
    if (!found) continue;

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

function markerFields(lines: readonly string[], line: number): Pick<PrincipalGate, "intent" | "reason" | "unknownIntent"> {
  const m = markerAbove(lines, line);
  if (!m) return {};
  const known = (PRINCIPAL_GATE_INTENTS as readonly string[]).includes(m.intent);
  return known ? { intent: m.intent as PrincipalGateIntent, reason: m.reason } : { unknownIntent: m.intent, reason: m.reason };
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

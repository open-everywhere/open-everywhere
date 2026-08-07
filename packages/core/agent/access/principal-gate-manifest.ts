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
  readonly rule: "unmarked" | "mismatched" | "unknown-intent" | "no-reason" | "unattended-inline-bag";
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
  const code = stripComments(lines);
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
  const code = stripComments(source.split("\n"));
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

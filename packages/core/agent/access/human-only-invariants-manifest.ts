export interface ProtectedHumanOnlyExportGroup {
  readonly module: string;
  readonly exportNames: readonly string[];
  readonly reason: string;
}

export const PROTECTED_HUMAN_ONLY_EXPORTS: readonly ProtectedHumanOnlyExportGroup[] = [
  {
    module: "agent/approvals/flow.ts",
    exportNames: ["resolveApprovalClick", "clickerMayDecide", "handleApprovalPayload"],
    reason:
      "resolves or decides a pending approval card. The agent may PROPOSE one (requestApproval); " +
      "only a human's click or the RBAC-gated control plane may DECIDE one.",
  },
  {
    module: "agent/identity/trust.ts",
    exportNames: ["registerSurfaces"],
    reason:
      "the one runtime write path for the operator-declared trust registry. Trust is boot-time " +
      "config-as-code and must never become agent-writable.",
  },
];

const PROTECTED_NAMES: ReadonlySet<string> = new Set(PROTECTED_HUMAN_ONLY_EXPORTS.flatMap((g) => g.exportNames));

function groupFor(name: string): ProtectedHumanOnlyExportGroup {
  const g = PROTECTED_HUMAN_ONLY_EXPORTS.find((group) => group.exportNames.includes(name));
  if (!g) throw new Error(`human-only-invariants-manifest: "${name}" is not a protected export (internal error)`);
  return g;
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

export interface ProtectedImportSite {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly group: ProtectedHumanOnlyExportGroup;
}

function lineAt(stripped: string, index: number | undefined): number {
  return stripped.slice(0, index ?? 0).split("\n").length;
}

function namesFromBraceGroup(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.split(/\s+as\s+/i)[0]!.trim());
}

const IMPORT_BLOCK_RE = /\b(?:import|export)\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g;

const DYNAMIC_DESTRUCTURE_RE = /\b(?:const|let)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?import\s*\(\s*["'][^"']+["']\s*\)/g;

const NAMESPACE_IMPORT_RE = /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["'][^"']+["']/g;
const DYNAMIC_NAMESPACE_RE = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?import\s*\(\s*["'][^"']+["']\s*\)/g;

const DYNAMIC_INLINE_ACCESS_RE = /\bimport\s*\(\s*["'][^"']+["']\s*\)\s*\)?\s*\.\s*([A-Za-z_$][\w$]*)/g;

function memberAccessSites(file: string, stripped: string, alias: string): ProtectedImportSite[] {
  const sites: ProtectedImportSite[] = [];
  const re = new RegExp(`\\b${alias}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g");
  for (const m of stripped.matchAll(re)) {
    const name = m[1]!;
    if (PROTECTED_NAMES.has(name)) sites.push({ file, line: lineAt(stripped, m.index), name, group: groupFor(name) });
  }
  return sites;
}

export function findProtectedImports(file: string, source: string): ProtectedImportSite[] {
  const lines = source.split("\n");
  const stripped = stripComments(lines).join("\n");
  const sites: ProtectedImportSite[] = [];

  for (const m of stripped.matchAll(IMPORT_BLOCK_RE)) {
    for (const name of namesFromBraceGroup(m[1]!)) {
      if (PROTECTED_NAMES.has(name)) sites.push({ file, line: lineAt(stripped, m.index), name, group: groupFor(name) });
    }
  }

  for (const m of stripped.matchAll(DYNAMIC_DESTRUCTURE_RE)) {
    for (const name of namesFromBraceGroup(m[1]!)) {
      if (PROTECTED_NAMES.has(name)) sites.push({ file, line: lineAt(stripped, m.index), name, group: groupFor(name) });
    }
  }

  const aliases = new Set<string>();
  for (const m of stripped.matchAll(NAMESPACE_IMPORT_RE)) aliases.add(m[1]!);
  for (const m of stripped.matchAll(DYNAMIC_NAMESPACE_RE)) aliases.add(m[1]!);
  for (const alias of aliases) sites.push(...memberAccessSites(file, stripped, alias));

  for (const m of stripped.matchAll(DYNAMIC_INLINE_ACCESS_RE)) {
    const name = m[1]!;
    if (PROTECTED_NAMES.has(name)) sites.push({ file, line: lineAt(stripped, m.index), name, group: groupFor(name) });
  }

  return sites;
}

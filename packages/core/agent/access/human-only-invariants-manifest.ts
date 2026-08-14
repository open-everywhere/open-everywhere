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

const IMPORT_BLOCK_RE = /\b(?:import|export)\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g;

export function findProtectedImports(file: string, source: string): ProtectedImportSite[] {
  const lines = source.split("\n");
  const stripped = stripComments(lines).join("\n");
  const sites: ProtectedImportSite[] = [];
  for (const m of stripped.matchAll(IMPORT_BLOCK_RE)) {
    const names = m[1]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => s.split(/\s+as\s+/i)[0]!.trim());
    if (names.length === 0) continue;
    const line = stripped.slice(0, m.index ?? 0).split("\n").length;
    for (const name of names) {
      if (PROTECTED_NAMES.has(name)) sites.push({ file, line, name, group: groupFor(name) });
    }
  }
  return sites;
}

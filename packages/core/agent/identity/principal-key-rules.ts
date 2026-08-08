export interface PrincipalKeyDefect {
  readonly file: string;
  readonly line: number;
  readonly rule: "composition" | "unqualifier";
  readonly excerpt: string;
  readonly message: string;
}

export interface ComposerDeclaration {
  readonly file: string;
  readonly line: number;
}

export const PRINCIPAL_KEY_MODULE = "packages/core/agent/identity/principal-key.ts";

const PERSON_ID_NOUNS = /(principal|native[_]?id|author[_]?id|user[_]?id|clicker[_]?id|member[_]?id|actor|sender[_]?id)/i;

const BARE_ID = /(^|[.?\s])id$/i;

const COMPOSITION = /\$\{([^}]*platform[^}]*)\}((?:\/\$\{[^}]*\})*)\/\$\{([^}]*)\}/gi;

const UNQUALIFIER_NAME = /^(?:bareKey|(?=.*(?:strip|unqualif|bare|legacy))(?=.*principal).*)$/i;
const DECLARATION = /\b(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

export function findPrincipalKeyDefects(file: string, source: string): PrincipalKeyDefect[] {
  const defects: PrincipalKeyDefect[] = [];
  const exempt = file.replace(/\\/g, "/").endsWith(PRINCIPAL_KEY_MODULE.slice(PRINCIPAL_KEY_MODULE.lastIndexOf("agent/")));
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentLine(line)) continue;

    if (!exempt) {
      for (const m of line.matchAll(COMPOSITION)) {
        const last = m[3]!.trim();
        if (!PERSON_ID_NOUNS.test(last) && !BARE_ID.test(last)) continue;
        defects.push({
          file,
          line: i + 1,
          rule: "composition",
          excerpt: m[0]!,
          message:
            `hand-rolled principal key \`${m[0]}\` — compose it with principalKey() from identity/principal-key.ts. ` +
            "It is byte-identical today and that is the problem: when the grammar gains its tenant rung (OPE-309 phase 1) this copy keeps emitting the old shape, and a qualified-vs-unqualified mismatch is a plain string mismatch that silently matches nobody.",
        });
      }
    }

    for (const m of line.matchAll(DECLARATION)) {
      const name = m[1]!;
      if (!UNQUALIFIER_NAME.test(name)) continue;
      defects.push({
        file,
        line: i + 1,
        rule: "unqualifier",
        excerpt: name,
        message:
          `\`${name}\` reads as a normaliser that strips a principal key's namespace back off. ` +
          "🔴 That is the one FAIL-OPEN shape in this whole design: every matcher fails closed on a mismatch, so a missed one costs lost standing — but a normaliser that unqualifies makes two different people's keys compare EQUAL again. If this name means something else, rename it; there is no compatibility case that wants this function.",
      });
    }
  }
  return defects;
}

export function findComposerDeclarations(file: string, source: string): ComposerDeclaration[] {
  const out: ComposerDeclaration[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentLine(line)) continue;
    if (/\b(?:export\s+)?function\s+principalKey\s*\(/.test(line)) out.push({ file, line: i + 1 });
  }
  return out;
}

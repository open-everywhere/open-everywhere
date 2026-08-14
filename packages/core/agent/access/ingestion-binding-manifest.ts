import { INGESTION_KINDS, type IngestionKind } from "./taint-tiers.js";

export const TODO_KIND = "TODO";

export type IngestionSiteForm = "ingestion-property" | "ingestion-const" | "noteIngestionVerdict" | "chatReadIngestion";

export interface IngestionSite {
  readonly file: string;
  readonly line: number;
  readonly form: IngestionSiteForm;
  readonly kindLiteral?: string;
  readonly hasLabel: boolean;
  readonly labelText?: string;
  readonly pending: boolean;
}

export type IngestionBindingDefectRule = "no-kind" | "unknown-kind" | "no-label" | "todo-unexplained";

export interface IngestionBindingDefect {
  readonly file: string;
  readonly line: number;
  readonly rule: IngestionBindingDefectRule;
  readonly message: string;
}

export function routeKey(site: Pick<IngestionSite, "file" | "form" | "labelText">): string {
  return `${site.file}#${site.labelText ?? `<${site.form}>`}`;
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

const WINDOW = 8;

const KIND_RE = /\bkind:\s*"([^"]*)"/;
const LABEL_LITERAL_RE = /\blabel:\s*"([^"]*)"/;
const LABEL_TEMPLATE_RE = /\blabel:\s*`([^`]*)`/;
const LABEL_IDENT_RE = /\blabel:\s*([A-Za-z_$][\w$]*)\b/;
const LABEL_SHORTHAND_RE = /(?:[{(,]|^)\s*label\s*(?:[,}]|$)/;
const TODO_MARKER_RE = /\/\/\s*TODO\(ingestion\):\s*\S/;

interface WindowScan {
  readonly kindLiteral?: string;
  readonly hasLabel: boolean;
  readonly labelText?: string;
  readonly pending: boolean;
}

function scanObjectWindow(code: readonly string[], rawLines: readonly string[], startIdx: number): WindowScan {
  let kindLiteral: string | undefined;
  let kindLine = -1;
  let hasLabel = false;
  let labelText: string | undefined;
  const end = Math.min(startIdx + WINDOW, code.length);
  for (let j = startIdx; j < end; j++) {
    const l = code[j] ?? "";
    if (kindLiteral === undefined) {
      const m = KIND_RE.exec(l);
      if (m) {
        kindLiteral = m[1];
        kindLine = j;
      }
    }
    if (!hasLabel) {
      const lit = LABEL_LITERAL_RE.exec(l);
      const tpl = LABEL_TEMPLATE_RE.exec(l);
      const ident = LABEL_IDENT_RE.exec(l);
      if (lit) {
        hasLabel = true;
        labelText = lit[1];
      } else if (tpl) {
        hasLabel = true;
        labelText = tpl[1];
      } else if (ident) {
        hasLabel = true;
        labelText = ident[1];
      } else if (LABEL_SHORTHAND_RE.test(l)) {
        hasLabel = true;
        labelText = undefined;
      }
    }
  }
  let pending = false;
  if (kindLiteral === TODO_KIND && kindLine >= 0) {
    pending = TODO_MARKER_RE.test(rawLines[kindLine] ?? "") || TODO_MARKER_RE.test(rawLines[kindLine - 1] ?? "");
  }
  return { kindLiteral, hasLabel, labelText, pending };
}

const NOTE_VERDICT_TRIGGER_RE = /\bnoteIngestionVerdict\(\s*\{/;
const INGESTION_PROPERTY_TRIGGER_RE = /\bingestion:\s*\{/;
const INGESTION_CONST_TRIGGER_RE = /^\s*(?:const|let)\s+ingestion\s*(?::[^=]+)?=\s*\{/;
const CHAT_READ_TRIGGER_RE = /\bchatReadIngestion\(\s*["'`]/;
const CHAT_READ_LABEL_RE = /\bchatReadIngestion\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/;

const NOTE_VERDICT_BARE_RE = /\bnoteIngestionVerdict\(/;
const INGESTION_PROPERTY_BARE_RE = /\bingestion:/;
const INGESTION_CONST_BARE_RE = /^\s*(?:const|let)\s+ingestion\s*(?::[^=]+)?=/;

export function findIngestionSites(file: string, source: string): IngestionSite[] {
  const rawLines = source.split("\n");
  const code = stripComments(rawLines);
  const sites: IngestionSite[] = [];

  for (let i = 0; i < code.length; i++) {
    const line = code[i] ?? "";

    if (CHAT_READ_TRIGGER_RE.test(line)) {
      const m = CHAT_READ_LABEL_RE.exec(line);
      const labelText = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
      sites.push({
        file,
        line: i + 1,
        form: "chatReadIngestion",
        kindLiteral: "chat-message",
        hasLabel: labelText !== undefined,
        labelText,
        pending: false,
      });
      continue;
    }

    if (NOTE_VERDICT_BARE_RE.test(line)) {
      const joined = code.slice(i, Math.min(i + 4, code.length)).join("\n");
      if (NOTE_VERDICT_TRIGGER_RE.test(joined)) {
        const w = scanObjectWindow(code, rawLines, i);
        sites.push({ file, line: i + 1, form: "noteIngestionVerdict", ...w });
        continue;
      }
    }

    if (INGESTION_PROPERTY_BARE_RE.test(line)) {
      const joined = code.slice(i, Math.min(i + 4, code.length)).join("\n");
      if (INGESTION_PROPERTY_TRIGGER_RE.test(joined)) {
        const w = scanObjectWindow(code, rawLines, i);
        sites.push({ file, line: i + 1, form: "ingestion-property", ...w });
        continue;
      }
    }

    if (INGESTION_CONST_BARE_RE.test(line)) {
      const joined = code.slice(i, Math.min(i + 4, code.length)).join("\n");
      if (INGESTION_CONST_TRIGGER_RE.test(joined)) {
        const w = scanObjectWindow(code, rawLines, i);
        sites.push({ file, line: i + 1, form: "ingestion-const", ...w });
        continue;
      }
    }
  }
  return sites;
}

export function checkIngestionSites(sites: readonly IngestionSite[]): IngestionBindingDefect[] {
  const defects: IngestionBindingDefect[] = [];
  const knownKinds = INGESTION_KINDS as readonly string[];
  for (const s of sites) {
    if (s.kindLiteral === undefined) {
      defects.push({
        file: s.file,
        line: s.line,
        rule: "no-kind",
        message: "no explicit `kind: \"…\"` literal found at this ingestion declaration site — every site must bind a literal IngestionKind, never a variable or an omission",
      });
    } else if (s.kindLiteral === TODO_KIND) {
      if (!s.pending) {
        defects.push({
          file: s.file,
          line: s.line,
          rule: "todo-unexplained",
          message: 'kind: "TODO" needs an adjacent `// TODO(ingestion): <reason>` comment explaining why the kind is not yet decided',
        });
      }
    } else if (!knownKinds.includes(s.kindLiteral)) {
      defects.push({
        file: s.file,
        line: s.line,
        rule: "unknown-kind",
        message: `kind "${s.kindLiteral}" is not one of the ratified IngestionKind values in access/taint-tiers.ts — add a row to INGESTION_KINDS and classifyIngestion before a site can declare it, or use kind: "TODO" with a TODO(ingestion) comment if the classification is genuinely undecided`,
      });
    }
    if (!s.hasLabel) {
      defects.push({
        file: s.file,
        line: s.line,
        rule: "no-label",
        message: "no `label` field found at this ingestion declaration site — every site needs one for the audit row's provenance name",
      });
    }
  }
  return defects;
}

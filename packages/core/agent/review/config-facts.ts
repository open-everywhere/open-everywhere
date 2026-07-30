export const READABLE_SNAPSHOT_FORMAT_VERSION = 1;

export const ACCESS_KEY_SEP = " · ";

export interface FactRow {
  readonly section: string;
  readonly key: string;
  readonly value: string;
}

export interface FactRowChange {
  readonly key: string;
  readonly before: string;
  readonly after: string;
}

export type FactSection =
  | {
      readonly kind: "computed";
      readonly section: string;
      readonly added: readonly FactRow[];
      readonly removed: readonly FactRow[];
      readonly changed: readonly FactRowChange[];
    }
  | { readonly kind: "not-computable"; readonly section: string; readonly reason: string };

export interface FactFinding {
  readonly id: string;
  readonly detail: string;
}

export interface ConfigFacts {
  readonly formatVersion: number;
  readonly sections: readonly FactSection[];
  readonly findings: readonly FactFinding[];
  readonly baseFailure: string | undefined;
  readonly changedFiles: readonly string[] | undefined;
}

export type ConfigFactsResult = { readonly ok: true; readonly facts: ConfigFacts } | { readonly ok: false; readonly reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function rows(v: unknown, where: string): readonly FactRow[] | string {
  if (!Array.isArray(v)) return `${where} is not an array`;
  const out: FactRow[] = [];
  for (const [i, r] of v.entries()) {
    if (!isRecord(r) || typeof r.section !== "string" || typeof r.key !== "string" || typeof r.value !== "string") {
      return `${where}[${i}] is not a {section,key,value} row`;
    }
    out.push({ section: r.section, key: r.key, value: r.value });
  }
  return out;
}

function changes(v: unknown, where: string): readonly FactRowChange[] | string {
  if (!Array.isArray(v)) return `${where} is not an array`;
  const out: FactRowChange[] = [];
  for (const [i, c] of v.entries()) {
    if (!isRecord(c) || typeof c.key !== "string" || typeof c.before !== "string" || typeof c.after !== "string") {
      return `${where}[${i}] is not a {key,before,after} change`;
    }
    out.push({ key: c.key, before: c.before, after: c.after });
  }
  return out;
}

export function parseConfigFacts(text: string): ConfigFactsResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `the facts document is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!isRecord(doc)) return { ok: false, reason: "the facts document is not a JSON object" };

  const head = doc.head;
  if (!isRecord(head) || typeof head.formatVersion !== "number") {
    return { ok: false, reason: "the facts document carries no `head` snapshot with a numeric `formatVersion`" };
  }
  if (head.formatVersion !== READABLE_SNAPSHOT_FORMAT_VERSION) {
    return {
      ok: false,
      reason:
        `the facts document uses snapshot row-encoding version ${head.formatVersion}, and this deployment can only read ` +
        `version ${READABLE_SNAPSHOT_FORMAT_VERSION} — the key/value grammar the blast-radius reading depends on may have changed, ` +
        `so refusing to interpret it (upgrade the deployment, or read the artifact by hand)`,
    };
  }

  const diff = doc.diff;
  if (!isRecord(diff)) return { ok: false, reason: "the facts document carries no `diff` object" };
  if (!Array.isArray(diff.sections)) return { ok: false, reason: "the facts document's `diff.sections` is not an array" };
  if (!Array.isArray(diff.findings)) return { ok: false, reason: "the facts document's `diff.findings` is not an array" };

  const sections: FactSection[] = [];
  for (const [i, s] of diff.sections.entries()) {
    if (!isRecord(s) || typeof s.section !== "string") return { ok: false, reason: `diff.sections[${i}] has no \`section\` name` };
    if (s.kind === "not-computable") {
      if (typeof s.reason !== "string" || s.reason.trim().length === 0) {
        return { ok: false, reason: `diff.sections[${i}] ("${s.section}") is not-computable but carries no reason` };
      }
      sections.push({ kind: "not-computable", section: s.section, reason: s.reason });
      continue;
    }
    if (s.kind !== "computed") return { ok: false, reason: `diff.sections[${i}] ("${s.section}") has unrecognised kind ${JSON.stringify(s.kind)}` };
    const added = rows(s.added, `diff.sections[${i}].added`);
    if (typeof added === "string") return { ok: false, reason: added };
    const removed = rows(s.removed, `diff.sections[${i}].removed`);
    if (typeof removed === "string") return { ok: false, reason: removed };
    const changed = changes(s.changed, `diff.sections[${i}].changed`);
    if (typeof changed === "string") return { ok: false, reason: changed };
    sections.push({ kind: "computed", section: s.section, added, removed, changed });
  }
  if (sections.length === 0) {
    return { ok: false, reason: "the facts document reports zero sections — there is nothing in it to establish anything about this PR" };
  }

  const findings: FactFinding[] = [];
  for (const [i, f] of diff.findings.entries()) {
    if (!isRecord(f) || typeof f.id !== "string" || typeof f.detail !== "string") {
      return { ok: false, reason: `diff.findings[${i}] is not a {id,detail} finding` };
    }
    findings.push({ id: f.id, detail: f.detail });
  }

  let changedFiles: readonly string[] | undefined;
  if (Array.isArray(doc.changedFiles)) {
    if (!doc.changedFiles.every((f) => typeof f === "string")) return { ok: false, reason: "`changedFiles` contains a non-string entry" };
    changedFiles = doc.changedFiles as readonly string[];
  } else if (doc.changedFiles !== null && doc.changedFiles !== undefined) {
    return { ok: false, reason: "`changedFiles` is neither an array nor null" };
  }

  const baseFailure = typeof doc.baseFailure === "string" && doc.baseFailure.trim().length > 0 ? doc.baseFailure.trim() : undefined;

  return { ok: true, facts: { formatVersion: head.formatVersion, sections, findings, baseFailure, changedFiles } };
}

export function sectionHasDelta(s: FactSection): boolean {
  return s.kind === "computed" && (s.added.length > 0 || s.removed.length > 0 || s.changed.length > 0);
}

export function decodeSet(value: string): string[] | undefined {
  if (!value.startsWith("[") || !value.endsWith("]")) return undefined;
  const inner = value.slice(1, -1);
  if (inner.trim().length === 0) return [];
  return inner.split(", ");
}

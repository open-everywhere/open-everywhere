import type { EffectiveAccess } from "@open-everywhere/core/agent/access/resolver.js";
import { classifyRosterTransition, rosterToolNameOf } from "@open-everywhere/core/agent/scaffold/tool-roster.js";

export const SNAPSHOT_FORMAT_VERSION = 1;

export interface SnapshotRow {
  readonly section: string;
  readonly key: string;
  readonly value: string;
}

export interface ConfigSnapshot {
  readonly formatVersion: number;
  readonly sections: readonly string[];
  readonly rows: readonly SnapshotRow[];
}

export interface RowChange {
  readonly key: string;
  readonly before: string;
  readonly after: string;
}

export type SectionState =
  | {
      readonly kind: "computed";
      readonly section: string;
      readonly added: readonly SnapshotRow[];
      readonly removed: readonly SnapshotRow[];
      readonly changed: readonly RowChange[];
    }
  | { readonly kind: "not-computable"; readonly section: string; readonly reason: string };

export interface Finding {
  readonly id: string;
  readonly detail: string;
}

export interface ConfigDiff {
  readonly sections: readonly SectionState[];
  readonly findings: readonly Finding[];
}

export function sectionHasDelta(s: SectionState): boolean {
  return s.kind === "computed" && (s.added.length > 0 || s.removed.length > 0 || s.changed.length > 0);
}

export const MAX_INLINE_VALUE_CHARS = 200;

export function encodeSet(items: readonly string[]): string {
  return `[${[...items].sort((a, b) => a.localeCompare(b)).join(", ")}]`;
}

export function decodeSet(value: string): string[] | undefined {
  if (!value.startsWith("[") || !value.endsWith("]")) return undefined;
  const inner = value.slice(1, -1);
  if (inner.trim().length === 0) return [];
  return inner.split(", ");
}

export function digestValue(raw: string, hash: (s: string) => string): string {
  if (raw.length <= MAX_INLINE_VALUE_CHARS) return JSON.stringify(raw);
  return `<${raw.length} chars, sha256:${hash(raw).slice(0, 16)}>`;
}

export function flattenEntity(prefix: string, value: unknown, hash: (s: string) => string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const walk = (path: string, v: unknown): void => {
    if (v === undefined || typeof v === "function" || typeof v === "symbol") return;
    if (v === null || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
      out.push({ key: path, value: JSON.stringify(v) ?? String(v) });
      return;
    }
    if (typeof v === "string") {
      out.push({ key: path, value: digestValue(v, hash) });
      return;
    }
    if (Array.isArray(v)) {
      const primitives = v.every((x) => x === null || ["string", "number", "boolean", "bigint"].includes(typeof x));
      if (primitives) {
        out.push({ key: path, value: encodeSet(v.map((x) => String(x))) });
        return;
      }
      v.forEach((member, i) => {
        const named =
          member !== null && typeof member === "object"
            ? ((member as Record<string, unknown>).name ?? (member as Record<string, unknown>).id)
            : undefined;
        walk(`${path}[${typeof named === "string" && named.length > 0 ? named : i}]`, member);
      });
      return;
    }
    if (typeof v === "object") {
      const rec = v as Record<string, unknown>;
      for (const k of Object.keys(rec).sort((a, b) => a.localeCompare(b))) walk(`${path}.${k}`, rec[k]);
      return;
    }
  };
  walk(prefix, value);
  return out;
}

export function describeEffectiveAccess(a: EffectiveAccess): Record<string, string[]> {
  return {
    hosts: a.reachableHosts.map(
      (h) =>
        `${h.host}${h.viaConnection ? ` [auth via ${h.viaConnection}]` : ""}${h.methods ? ` methods=${[...h.methods].join(",")}` : ""}${h.pathPrefixes ? ` paths=${[...h.pathPrefixes].join(",")}` : ""}`,
    ),
    connections: a.connections.map(
      (c) =>
        `${c.id} (${c.credentialType} → ${c.allowedWebsites.join(",")}; methods=${c.methods?.join(",") ?? "all"}; paths=${c.pathPrefixes?.join(",") ?? "all"})`,
    ),
    connectors: [...a.connectors],
    repos: [...a.repos],
  };
}

export interface DiffOptions {
  readonly baseFailure?: string;
}

const NOT_DECLARED_AT_BASE = (section: string) =>
  `the base revision's snapshot does not declare the "${section}" section, so there is no baseline to compare against (new coverage — this section becomes computable on the next PR)`;

const NOT_DECLARED_AT_HEAD = (section: string) =>
  `this revision's snapshot no longer declares the "${section}" section — coverage REGRESSED, so nothing about it can be compared`;

export function diffConfigSnapshots(
  before: ConfigSnapshot | undefined,
  after: ConfigSnapshot,
  opts: DiffOptions = {},
): ConfigDiff {
  const findings: Finding[] = [];

  if (before === undefined) {
    const reason =
      opts.baseFailure && opts.baseFailure.trim().length > 0
        ? `the base revision's snapshot could not be produced: ${opts.baseFailure.trim()}`
        : "the base revision's snapshot could not be produced, and no reason was recorded (this is itself a bug in scripts/config-diff.ts)";
    findings.push({ id: "base-snapshot-unavailable", detail: reason });
    return {
      sections: after.sections.map((section) => ({ kind: "not-computable" as const, section, reason })),
      findings,
    };
  }

  if (before.formatVersion !== after.formatVersion) {
    const reason = `snapshot formatVersion differs (base ${before.formatVersion} vs head ${after.formatVersion}) — the row encoding changed, so no row from the two sides is comparable`;
    findings.push({ id: "format-version-mismatch", detail: reason });
    const sections = [...new Set([...before.sections, ...after.sections])].sort((a, b) => a.localeCompare(b));
    return { sections: sections.map((section) => ({ kind: "not-computable" as const, section, reason })), findings };
  }

  const beforeDeclared = new Set(before.sections);
  const afterDeclared = new Set(after.sections);
  const allSections = [...new Set([...before.sections, ...after.sections])].sort((a, b) => a.localeCompare(b));

  const index = (snap: ConfigSnapshot, section: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const r of snap.rows) if (r.section === section) m.set(r.key, r.value);
    return m;
  };

  const sections: SectionState[] = allSections.map((section) => {
    if (!afterDeclared.has(section)) {
      findings.push({ id: "coverage-regressed", detail: NOT_DECLARED_AT_HEAD(section) });
      return { kind: "not-computable", section, reason: NOT_DECLARED_AT_HEAD(section) };
    }
    if (!beforeDeclared.has(section)) {
      return { kind: "not-computable", section, reason: NOT_DECLARED_AT_BASE(section) };
    }
    const b = index(before, section);
    const a = index(after, section);
    const added: SnapshotRow[] = [];
    const removed: SnapshotRow[] = [];
    const changed: RowChange[] = [];
    for (const key of [...a.keys()].sort((x, y) => x.localeCompare(y))) {
      const av = a.get(key)!;
      if (!b.has(key)) added.push({ section, key, value: av });
      else if (b.get(key) !== av) changed.push({ key, before: b.get(key)!, after: av });
    }
    for (const key of [...b.keys()].sort((x, y) => x.localeCompare(y))) {
      if (!a.has(key)) removed.push({ section, key, value: b.get(key)! });
    }
    return { kind: "computed", section, added, removed, changed };
  });

  return { sections, findings };
}

export const EXPLICIT_ACCESS_PATH_PREFIXES = ["agent/access/"] as const;

export function accessSideEffectFindings(diff: ConfigDiff, changedFiles: readonly string[] | undefined): Finding[] {
  const accessSection = diff.sections.find((s) => s.section === "access");
  if (accessSection === undefined) return [];
  if (accessSection.kind === "not-computable") return [];
  if (!sectionHasDelta(accessSection)) return [];

  const changedSections = diff.sections.filter((s) => s.section !== "access" && sectionHasDelta(s)).map((s) => s.section);
  const scopes = [
    ...new Set(
      [
        ...accessSection.added.map((r) => r.key),
        ...accessSection.removed.map((r) => r.key),
        ...accessSection.changed.map((r) => r.key),
      ].map((k) => k.split(" · ")[0]),
    ),
  ].sort((a, b) => a.localeCompare(b));

  if (changedFiles === undefined) {
    return [
      {
        id: "access-attribution-not-computable",
        detail: `${scopes.length} scope(s) change effective access, but the set of files this PR touches could not be determined — so whether the change was authored in the access config or arrived side-on through another file CANNOT be established here. Scopes: ${scopes.join(", ")}.`,
      },
    ];
  }

  const touchedAccess = changedFiles.some((f) => EXPLICIT_ACCESS_PATH_PREFIXES.some((p) => f.startsWith(p)));
  if (touchedAccess) return [];

  return [
    {
      id: "access-changed-side-on",
      detail: `${scopes.length} scope(s) change effective access, yet this PR edits NO file under ${EXPLICIT_ACCESS_PATH_PREFIXES.join(", ")} — the change arrived through ${changedSections.length > 0 ? changedSections.join(", ") : "a file this snapshot does not attribute to any section"}. Re-rostering a domain, re-pointing a silo, editing a provider or changing what a plugin expands to all move what a scope can reach without any access file being opened; that is the review gap this gate exists to state. Scopes: ${scopes.join(", ")}.`,
    },
  ];
}

export function toolRosterFindings(diff: ConfigDiff): Finding[] {
  const mounted = diff.sections.find((s) => s.section === "mounted");
  if (mounted === undefined || mounted.kind === "not-computable") return [];

  const gained: string[] = [];
  const lost: string[] = [];
  const record = (name: string, before: string | undefined, after: string | undefined): void => {
    const dir = classifyRosterTransition(before, after);
    if (dir === "gain") gained.push(name);
    if (dir === "loss") lost.push(name);
  };

  for (const r of mounted.added) {
    const name = rosterToolNameOf(r.key);
    if (name !== undefined) record(name, undefined, r.value);
  }
  for (const r of mounted.removed) {
    const name = rosterToolNameOf(r.key);
    if (name !== undefined) record(name, r.value, undefined);
  }
  for (const c of mounted.changed) {
    const name = rosterToolNameOf(c.key);
    if (name !== undefined) record(name, c.before, c.after);
  }

  const findings: Finding[] = [];
  if (gained.length > 0) {
    findings.push({
      id: "tool-roster-capability-gain",
      detail: `${gained.length} tool(s) become MOUNTED in agent/tools/: ${gained.sort((a, b) => a.localeCompare(b)).join(", ")}. Eve names a tool after its file, so each of these is a capability the model can now call that it could not before — either a new roster file or a \`disableTool()\` sentinel replaced by a real tool. A sentinel→tool flip is the one worth reading twice: it looks like an edit to an existing file and it is a GRANT.`,
    });
  }
  if (lost.length > 0) {
    findings.push({
      id: "tool-roster-capability-loss",
      detail: `${lost.length} tool(s) stop being mounted in agent/tools/: ${lost.sort((a, b) => a.localeCompare(b)).join(", ")}. Reported for symmetry — a removal is not a hazard, but a roster whose declined set changed without anyone saying so is how a sentinel gets deleted as a "cleanup". Declining a tool means committing a sentinel; deleting the file un-decides it and \`npm run lint:tool-roster\` reports the tool as MISSING.`,
    });
  }
  return findings;
}

export const CONFIG_DIFF_MARKER = "## Config diff (resolved `agent/**` config)";

export const NO_CHANGE_LINE = "_computed — no change._";
export const NOT_COMPUTABLE_PREFIX = "⚠️ **NOT COMPUTABLE** —";

export interface RenderMeta {
  readonly baseRef?: string;
  readonly headRef?: string;
  readonly changedFiles?: readonly string[];
}

function renderChange(c: RowChange): string[] {
  const b = decodeSet(c.before);
  const a = decodeSet(c.after);
  if (b !== undefined && a !== undefined) {
    const lines: string[] = [];
    for (const g of a.filter((x) => !b.includes(x))) lines.push(`+ ${c.key}: ${g}`);
    for (const l of b.filter((x) => !a.includes(x))) lines.push(`- ${c.key}: ${l}`);
    if (lines.length > 0) return lines;
  }
  return [`- ${c.key}: ${c.before}`, `+ ${c.key}: ${c.after}`];
}

export function renderConfigDiff(diff: ConfigDiff, meta: RenderMeta = {}): string {
  const out: string[] = [CONFIG_DIFF_MARKER, ""];
  if (meta.baseRef || meta.headRef) {
    out.push(`Base \`${meta.baseRef ?? "?"}\` → head \`${meta.headRef ?? "?"}\`.`, "");
  }

  const notComputable = diff.sections.filter((s) => s.kind === "not-computable");
  const withDelta = diff.sections.filter(sectionHasDelta);

  if (notComputable.length > 0) {
    out.push(
      `> ⚠️ **${notComputable.length} of ${diff.sections.length} section(s) could not be compared.** Anything below marked NOT COMPUTABLE is an UNKNOWN, not a pass — read the reason before merging.`,
      "",
    );
  }
  out.push(
    withDelta.length === 0
      ? notComputable.length === diff.sections.length
        ? "**No section could be compared — this report establishes NOTHING about what this PR changes.**"
        : `**${diff.sections.length - notComputable.length} section(s) computed with no change; ${notComputable.length} not computable.**`
      : `**${withDelta.length} section(s) change: ${withDelta.map((s) => s.section).join(", ")}.**`,
    "",
  );

  if (diff.findings.length > 0) {
    out.push("### Findings", "");
    for (const f of diff.findings) out.push(`- **\`${f.id}\`** — ${f.detail}`);
    out.push("");
  }

  for (const s of diff.sections) {
    out.push(`### \`${s.section}\``, "");
    if (s.kind === "not-computable") {
      out.push(`${NOT_COMPUTABLE_PREFIX} ${s.reason}`, "");
      continue;
    }
    if (!sectionHasDelta(s)) {
      out.push(NO_CHANGE_LINE, "");
      continue;
    }
    const lines: string[] = [];
    for (const r of s.added) lines.push(`+ ${r.key}: ${r.value}`);
    for (const r of s.removed) lines.push(`- ${r.key}: ${r.value}`);
    for (const c of s.changed) lines.push(...renderChange(c));
    out.push("```diff", ...lines, "```", "");
  }

  if (meta.changedFiles !== undefined) {
    out.push(
      "<details><summary>Files this PR touches</summary>",
      "",
      ...(meta.changedFiles.length === 0 ? ["_(none reported)_"] : meta.changedFiles.map((f) => `- \`${f}\``)),
      "",
      "</details>",
      "",
    );
  } else {
    out.push(
      `${NOT_COMPUTABLE_PREFIX} the set of files this PR touches could not be determined, so no delta below is attributed to a file.`,
      "",
    );
  }

  out.push(
    "<sub>Generated by `scripts/config-diff.ts` (OPE-255). Sections are computed from the RESOLVED config — role defaults applied, overlays merged — not from file text, because a role supplies a domain's `bundle`/`memory`/`sandbox` when the domain omits them, so re-pointing one role moves what several domains resolve to without any of their files being edited. **What this report cannot see is listed in the `WHAT THIS SNAPSHOT CANNOT SEE` block at the top of `scripts/config-snapshot-build.ts`** — read it before treating a green as an all-clear.</sub>",
  );
  return out.join("\n");
}

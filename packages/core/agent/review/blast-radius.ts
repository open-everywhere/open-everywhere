import { ACCESS_KEY_SEP, decodeSet, type ConfigFacts, type FactSection } from "./config-facts.js";

export const MAX_BLAST_ITEMS = 60;

export interface AccessItemDelta {
  readonly facet: string;
  readonly item: string;
}

export interface ScopeAccessDelta {
  readonly scope: string;
  readonly gained: readonly AccessItemDelta[];
  readonly lost: readonly AccessItemDelta[];
  readonly opaque: readonly { readonly key: string; readonly before: string; readonly after: string }[];
  readonly newlyBound: boolean;
  readonly unbound: boolean;
}

export interface RosterDelta {
  readonly domain: string;
  readonly field: string;
  readonly gained: readonly string[];
  readonly lost: readonly string[];
}

export interface StandingPromptDelta {
  readonly section: string;
  readonly key: string;
  readonly change: "added" | "removed" | "changed";
  readonly value: string;
  readonly digested: boolean;
}

export interface BlastRadius {
  readonly widens: boolean;
  readonly scopes: readonly ScopeAccessDelta[];
  readonly rosters: readonly RosterDelta[];
  readonly standingPrompts: readonly StandingPromptDelta[];
  readonly notComputable: readonly { readonly section: string; readonly reason: string }[];
  readonly truncated: readonly string[];
}

export function isDigestValue(value: string): boolean {
  return /^<\d+ chars, sha256:[0-9a-f]+>$/.test(value);
}

export function isStandingPromptKey(key: string): boolean {
  return /(?:^|[.\]\s])instructions?$/.test(key) || key.includes("instructionStack");
}

function splitAccessKey(key: string): { scope: string; facet: string } {
  const i = key.indexOf(ACCESS_KEY_SEP);
  if (i < 0) return { scope: key, facet: "(unkeyed)" };
  return { scope: key.slice(0, i), facet: key.slice(i + ACCESS_KEY_SEP.length) };
}

function sectionByName(facts: ConfigFacts, name: string): FactSection | undefined {
  return facts.sections.find((s) => s.section === name);
}

export function computeBlastRadius(facts: ConfigFacts): BlastRadius {
  const truncated: string[] = [];
  const notComputable = facts.sections
    .filter((s): s is Extract<FactSection, { kind: "not-computable" }> => s.kind === "not-computable")
    .map((s) => ({ section: s.section, reason: s.reason }));

  const scopes = new Map<
    string,
    { gained: AccessItemDelta[]; lost: AccessItemDelta[]; opaque: { key: string; before: string; after: string }[]; addedRows: number; removedRows: number; changedRows: number }
  >();
  const bucket = (scope: string) => {
    let b = scopes.get(scope);
    if (!b) {
      b = { gained: [], lost: [], opaque: [], addedRows: 0, removedRows: 0, changedRows: 0 };
      scopes.set(scope, b);
    }
    return b;
  };

  const access = sectionByName(facts, "access");
  if (access?.kind === "computed") {
    for (const r of access.added) {
      const { scope, facet } = splitAccessKey(r.key);
      const b = bucket(scope);
      b.addedRows++;
      const members = decodeSet(r.value);
      if (members === undefined) b.opaque.push({ key: r.key, before: "(absent)", after: r.value });
      else for (const m of members) b.gained.push({ facet, item: m });
    }
    for (const r of access.removed) {
      const { scope, facet } = splitAccessKey(r.key);
      const b = bucket(scope);
      b.removedRows++;
      const members = decodeSet(r.value);
      if (members === undefined) b.opaque.push({ key: r.key, before: r.value, after: "(absent)" });
      else for (const m of members) b.lost.push({ facet, item: m });
    }
    for (const c of access.changed) {
      const { scope, facet } = splitAccessKey(c.key);
      const b = bucket(scope);
      b.changedRows++;
      const before = decodeSet(c.before);
      const after = decodeSet(c.after);
      if (before === undefined || after === undefined) {
        b.opaque.push({ key: c.key, before: c.before, after: c.after });
        continue;
      }
      for (const m of after.filter((x) => !before.includes(x))) b.gained.push({ facet, item: m });
      for (const m of before.filter((x) => !after.includes(x))) b.lost.push({ facet, item: m });
    }
  }

  const scopeDeltas: ScopeAccessDelta[] = [...scopes.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([scope, b]) => ({
      scope,
      gained: cap(b.gained, `access gains for ${scope}`, truncated),
      lost: cap(b.lost, `access losses for ${scope}`, truncated),
      opaque: cap(b.opaque, `undecomposable access rows for ${scope}`, truncated),
      newlyBound: b.addedRows > 0 && b.changedRows === 0 && b.removedRows === 0,
      unbound: b.removedRows > 0 && b.changedRows === 0 && b.addedRows === 0,
    }));

  const rosterMap = new Map<string, { domain: string; field: string; gained: string[]; lost: string[] }>();
  const rosterBucket = (domain: string, field: string) => {
    const k = `${domain}.${field}`;
    let b = rosterMap.get(k);
    if (!b) {
      b = { domain, field, gained: [], lost: [] };
      rosterMap.set(k, b);
    }
    return b;
  };
  const domains = sectionByName(facts, "domains");
  if (domains?.kind === "computed") {
    const rosterField = (key: string): { domain: string; field: string } | undefined => {
      const m = /^(.*)\.(reach|exclude)$/.exec(key);
      return m ? { domain: m[1], field: m[2] } : undefined;
    };
    for (const r of domains.added) {
      const f = rosterField(r.key);
      if (!f) continue;
      rosterBucket(f.domain, f.field).gained.push(...(decodeSet(r.value) ?? [r.value]));
    }
    for (const r of domains.removed) {
      const f = rosterField(r.key);
      if (!f) continue;
      rosterBucket(f.domain, f.field).lost.push(...(decodeSet(r.value) ?? [r.value]));
    }
    for (const c of domains.changed) {
      const f = rosterField(c.key);
      if (!f) continue;
      const b = rosterBucket(f.domain, f.field);
      const before = decodeSet(c.before);
      const after = decodeSet(c.after);
      if (before === undefined || after === undefined) {
        b.lost.push(c.before);
        b.gained.push(c.after);
        continue;
      }
      b.gained.push(...after.filter((x) => !before.includes(x)));
      b.lost.push(...before.filter((x) => !after.includes(x)));
    }
  }
  const rosters: RosterDelta[] = [...rosterMap.values()]
    .filter((r) => r.gained.length > 0 || r.lost.length > 0)
    .sort((a, b) => `${a.domain}.${a.field}`.localeCompare(`${b.domain}.${b.field}`))
    .map((r) => ({
      domain: r.domain,
      field: r.field,
      gained: cap(r.gained, `roster gains for ${r.domain}.${r.field}`, truncated),
      lost: cap(r.lost, `roster losses for ${r.domain}.${r.field}`, truncated),
    }));

  const prompts: StandingPromptDelta[] = [];
  for (const s of facts.sections) {
    if (s.kind !== "computed") continue;
    for (const r of s.added) {
      if (isStandingPromptKey(r.key)) prompts.push({ section: s.section, key: r.key, change: "added", value: r.value, digested: isDigestValue(r.value) });
    }
    for (const r of s.removed) {
      if (isStandingPromptKey(r.key)) prompts.push({ section: s.section, key: r.key, change: "removed", value: r.value, digested: isDigestValue(r.value) });
    }
    for (const c of s.changed) {
      if (isStandingPromptKey(c.key)) prompts.push({ section: s.section, key: c.key, change: "changed", value: c.after, digested: isDigestValue(c.after) });
    }
  }
  prompts.sort((a, b) => `${a.section}/${a.key}`.localeCompare(`${b.section}/${b.key}`));

  const widensReach = rosters.some((r) => r.field === "reach" && r.gained.length > 0);
  const widensByUnexcluding = rosters.some((r) => r.field === "exclude" && r.lost.length > 0);
  const widens = scopeDeltas.some((s) => s.gained.length > 0) || widensReach || widensByUnexcluding;

  return {
    widens,
    scopes: scopeDeltas,
    rosters,
    standingPrompts: cap(prompts, "standing-prompt changes", truncated),
    notComputable,
    truncated,
  };
}

function cap<T>(items: T[], label: string, into: string[]): readonly T[] {
  if (items.length <= MAX_BLAST_ITEMS) return items;
  into.push(`${label} (${items.length} item(s), showing ${MAX_BLAST_ITEMS})`);
  return items.slice(0, MAX_BLAST_ITEMS);
}

export function factsEstablishNothing(facts: ConfigFacts): boolean {
  return facts.sections.every((s) => s.kind === "not-computable");
}

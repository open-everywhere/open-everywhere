import { safeName } from "./layout.js";
import type { MemorySilo } from "./silo.js";

export type SelectMode = "recurse" | "include" | "exclude";

export interface SelectRule {
  readonly path: string;
  readonly mode: SelectMode;
}

export interface MemorySelection {
  readonly default: "recurse" | "include";
  readonly rules?: readonly SelectRule[];
}

export interface Selector {
  includes(segs: readonly string[], id?: string): boolean;
  descends(segs: readonly string[], id?: string): boolean;
  includesLeaf(segs: readonly string[], leaf: string): boolean;
}

const norm = (s: string): string => safeName(s).toLowerCase();

function normSegs(path: string): string[] {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(norm);
}

interface NormRule {
  readonly segs: string[];
  readonly id?: string;
  readonly mode: SelectMode;
}

function isPrefix(prefix: readonly string[], of: readonly string[]): boolean {
  if (prefix.length > of.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== of[i]) return false;
  return true;
}

function arrayEq(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function normalizeSelection(silo: Pick<MemorySilo, "select" | "recursive">): MemorySelection {
  if (silo.select) return silo.select;
  return { default: silo.recursive === false ? "include" : "recurse" };
}

export function makeSelector(sel: MemorySelection): Selector {
  const rules: NormRule[] = (sel.rules ?? []).map((r) => {
    const raw = r.path.trim();
    return { segs: normSegs(raw), id: raw.includes("/") ? undefined : raw.toLowerCase(), mode: r.mode };
  });
  const rootMode = sel.default;

  function selfRule(ns: readonly string[], id?: string): NormRule | undefined {
    return rules.find((r) => arrayEq(r.segs, ns) || (r.id !== undefined && id !== undefined && r.id === id.toLowerCase()));
  }
  function ancestorRule(ns: readonly string[]): NormRule | undefined {
    let best: NormRule | undefined;
    for (const r of rules) {
      if (r.segs.length < ns.length && isPrefix(r.segs, ns)) {
        if (!best || r.segs.length > best.segs.length) best = r;
      }
    }
    return best;
  }
  function hasRuleUnder(ns: readonly string[]): boolean {
    return rules.some((r) => r.segs.length > ns.length && isPrefix(ns, r.segs));
  }

  function govern(ns: readonly string[], id?: string): { mode: SelectMode; atSelf: boolean } {
    const self = selfRule(ns, id);
    if (self) return { mode: self.mode, atSelf: true };
    const anc = ancestorRule(ns);
    if (anc) return { mode: anc.mode, atSelf: false };
    return { mode: rootMode, atSelf: ns.length === 0 };
  }

  function includes(segs: readonly string[], id?: string): boolean {
    const ns = segs.map(norm);
    const { mode, atSelf } = govern(ns, id);
    if (mode === "exclude") return false;
    return atSelf ? true : mode === "recurse";
  }

  function descends(segs: readonly string[], id?: string): boolean {
    const ns = segs.map(norm);
    if (hasRuleUnder(ns)) return true;
    return govern(ns, id).mode === "recurse";
  }

  function includesLeaf(segs: readonly string[], leaf: string): boolean {
    const ns = segs.map(norm);
    const fileSegs = [...ns, norm(leaf)];
    const self = selfRule(fileSegs);
    if (self) return self.mode !== "exclude";
    return includes(segs);
  }

  return { includes, descends, includesLeaf };
}

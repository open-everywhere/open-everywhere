import {
  eventNormalizer,
  registeredEventSources,
  SCOPE_KINDS,
  scopeIdOf,
  type NormalizedEvent,
  type FilterClause,
  type ScopeSelector,
  type SubscriptionFilter,
} from "./event-model.js";
import { webhookScheme } from "./scheme-name.js";
import type { Routine, RoutineTrigger } from "./routine.js";

export const FILTER_MAX_CLAUSES = 8;
export const FILTER_MAX_SELECTORS = 4;
export const FILTER_MAX_VALUES = 20;

export function isEventTrigger(t: RoutineTrigger): t is Extract<RoutineTrigger, { kind: "event" }> {
  return t.kind === "event";
}

export function storedFilter(t: Extract<RoutineTrigger, { kind: "event" }>): SubscriptionFilter | undefined {
  if (t.filter) return t.filter;
  if (!t.match) return undefined;
  const all = Object.entries(t.match).map(([key, value]) => ({ key, in: [value] }) as FilterClause);
  return all.length > 0 ? { all } : undefined;
}

function clauseValues(c: FilterClause): readonly string[] {
  return "in" in c ? c.in : c.notIn;
}

export function validateSubscription(source: string, filter: SubscriptionFilter | undefined): void {
  const n = eventNormalizer(source);
  if (!n) {
    const known = registeredEventSources();
    throw new Error(
      `Unknown event source "${source}" — ` +
        (known.length ? `known sources: ${known.join(", ")}.` : "no event source is registered in this deployment.") +
        " A subscription to an unknown source can never match anything, so it is refused rather than armed.",
    );
  }
  const selectors = filter?.under ?? [];
  const clauses = filter?.all ?? [];
  if (selectors.length > FILTER_MAX_SELECTORS) throw new Error(`At most ${FILTER_MAX_SELECTORS} \`under\` selectors (got ${selectors.length}).`);
  if (clauses.length > FILTER_MAX_CLAUSES) throw new Error(`At most ${FILTER_MAX_CLAUSES} filter clauses (got ${clauses.length}).`);

  const seenKinds = new Set<string>();
  for (const s of selectors) {
    if (!SCOPE_KINDS.includes(s.kind)) throw new Error(`Unknown scope kind "${String(s.kind)}" — one of ${SCOPE_KINDS.join(", ")}.`);
    if (!n.scopeKinds.includes(s.kind)) {
      throw new Error(
        `"${source}" never proves a "${s.kind}" scope, so \`under\` naming it could never match — it proves ${n.scopeKinds.join(", ") || "nothing"}.`,
      );
    }
    if (seenKinds.has(s.kind)) throw new Error(`Two \`under\` selectors both name "${s.kind}" — a scope path holds at most one step per kind.`);
    seenKinds.add(s.kind);
    if (typeof s.id !== "string" || s.id.length === 0) throw new Error(`\`under\` selector for "${s.kind}" has an empty id.`);
  }

  for (const c of clauses) {
    const hasIn = "in" in c;
    const hasNotIn = "notIn" in c;
    if (hasIn === hasNotIn) throw new Error(`Filter clause for "${c.key}" must carry exactly one of \`in\` or \`notIn\`.`);
    if (!n.matchKeys.includes(c.key)) {
      throw new Error(`"${c.key}" is not a filterable field on "${source}" — filterable: ${n.matchKeys.join(", ") || "none"}.`);
    }
    const values = clauseValues(c);
    if (!Array.isArray(values) || values.length === 0) throw new Error(`Filter clause for "${c.key}" has an empty value list.`);
    if (values.length > FILTER_MAX_VALUES) throw new Error(`Filter clause for "${c.key}" has ${values.length} values (max ${FILTER_MAX_VALUES}).`);
    for (const v of values) if (typeof v !== "string") throw new Error(`Filter values must be strings; "${c.key}" carries a ${typeof v}.`);
  }

  if (n.scopeKinds.includes("container")) {
    const narrows = selectors.length > 0 || clauses.some((c) => "in" in c && n.scopeKeys.includes(c.key));
    if (!narrows) {
      throw new Error(
        `A "${source}" subscription must narrow its scope: pass \`under\` (e.g. { kind: "container", id: "<id>" }) ` +
          `or an \`in\` clause on ${n.scopeKeys.join(" / ") || "a scope key"}. ` +
          "Subscribing to every event in the whole tenant has to be spelled out deliberately, not defaulted into.",
      );
    }
  }
}

function selectorMatches(ev: NormalizedEvent, s: ScopeSelector): boolean {
  return scopeIdOf(ev.scope, s.kind) === s.id;
}

function clauseHolds(ev: NormalizedEvent, c: FilterClause): boolean {
  const actual = ev.fields[c.key];
  if ("in" in c) return actual !== undefined && c.in.includes(actual);
  return actual === undefined || !c.notIn.includes(actual);
}

export function evaluateFilter(ev: NormalizedEvent, filter: SubscriptionFilter | undefined): boolean {
  if (!filter) return true;
  for (const s of filter.under ?? []) if (!selectorMatches(ev, s)) return false;
  for (const c of filter.all ?? []) if (!clauseHolds(ev, c)) return false;
  return true;
}

export type SubscriptionVerdict =
  | { readonly match: boolean }
  | { readonly match: false; readonly invalid: string };

export function evaluateSubscription(routine: Routine, ev: NormalizedEvent): SubscriptionVerdict {
  const t = routine.trigger;
  if (!isEventTrigger(t)) return { match: false };
  if (t.source !== ev.source) return { match: false };
  const filter = storedFilter(t);
  try {
    validateSubscriptionAtFire(webhookScheme(ev), filter);
  } catch (err) {
    return { match: false, invalid: String(err instanceof Error ? err.message : err) };
  }
  return { match: evaluateFilter(ev, filter) };
}

function validateSubscriptionAtFire(scheme: string, filter: SubscriptionFilter | undefined): void {
  const source = scheme;
  const n = eventNormalizer(scheme);
  if (!n) throw new Error(`no normalizer registered for source "${source}"`);
  for (const s of filter?.under ?? []) {
    if (!n.scopeKinds.includes(s.kind)) throw new Error(`source "${source}" no longer proves scope kind "${s.kind}"`);
  }
  for (const c of filter?.all ?? []) {
    if (!n.matchKeys.includes(c.key)) throw new Error(`"${c.key}" is no longer a filterable field on "${source}"`);
  }
}


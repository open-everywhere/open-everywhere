import { admitProviderRegistration } from "../access/provider-selection.js";
import { webhookScheme } from "./scheme-name.js";
import type { Scope } from "../access/bundle.js";

export type ScopeKind = "tenant" | "group" | "container" | "entity" | "sub";

export const SCOPE_KINDS: readonly ScopeKind[] = ["tenant", "group", "container", "entity", "sub"] as const;

export interface ScopeStep {
  readonly kind: ScopeKind;
  readonly id: string;
  readonly label?: string;
}

export interface EntityPointer {
  readonly platform: string;
  readonly id: string;
  readonly gone?: boolean;
}

export const FIELDS_MAX_KEYS = 16;
export const FIELD_VALUE_MAX = 200;

export interface NormalizedEvent {
  readonly source: string;
  readonly scheme?: string;
  readonly event: string;
  readonly action?: string;
  readonly scope: readonly ScopeStep[];
  readonly actor?: { readonly id?: string; readonly handle?: string };
  readonly fields: Readonly<Record<string, string>>;
  readonly deliveryId?: string;
  readonly occurredAt?: string;
  readonly summary: string;
  readonly pointer?: EntityPointer;
  readonly redacted?: boolean;
  readonly projected?: readonly string[];
  readonly readableBy?: readonly Scope[];
}

export interface TriggerDelivery {
  readonly source: string;
  readonly scheme?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly deliveryId?: string;
  readonly receivedAt: string;
  readonly redactPayload?: boolean;
  readonly project?: readonly string[];
  readonly captureUntil?: string;
  readonly readableBy?: readonly Scope[];
}

export interface StoredSubscription {
  readonly jq?: string;
}

const KNOWN_SUBSCRIPTION_KEYS: readonly string[] = ["kind", "source", "jq"];

export type StoredFilter =
  | { readonly kind: "jq"; readonly expression: string }
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly keys: readonly string[] };

export function storedFilter(t: StoredSubscription): StoredFilter {
  const row = t as Readonly<Record<string, unknown>>;
  const keys = Object.keys(row)
    .filter((k) => !KNOWN_SUBSCRIPTION_KEYS.includes(k) && row[k] !== undefined)
    .sort();
  if (keys.length > 0) return { kind: "unknown", keys };
  return t.jq ? { kind: "jq", expression: t.jq } : { kind: "none" };
}

export function describeFilter(source: string, t: StoredSubscription): string {
  const f = storedFilter(t);
  if (f.kind === "unknown") {
    return `on ${source} event, but its stored filter shape is UNREADABLE here (${f.keys.join(", ")}) — it can never fire`;
  }
  return `on ${source} event${f.kind === "none" ? " (EVERY event from this source)" : ` where ${f.expression}`}`;
}

export interface EventNormalizer {
  readonly source: string;
  readonly provider?: string;
  readonly matchKeys: readonly string[];
  readonly matchKeysOpen?: boolean;
  readonly scopeKeys: readonly string[];
  readonly scopeKinds: readonly ScopeKind[];
  readonly scopeHookConstant?: boolean;
  readonly resolvesActor: boolean;
  readonly deliveryIdHeader?: string;
  normalize(d: TriggerDelivery): NormalizedEvent | null;
}

const NORMALIZERS = new Map<string, EventNormalizer>();

export function registerEventNormalizer(normalizer: EventNormalizer): boolean {
  if (normalizer.provider !== undefined && !admitProviderRegistration(normalizer.provider, "event-normalizer")) return false;
  NORMALIZERS.set(normalizer.source, normalizer);
  return true;
}

export function eventNormalizer(source: string | undefined): EventNormalizer | undefined {
  return source === undefined ? undefined : NORMALIZERS.get(source);
}

export function declaredDeliveryId(scheme: string, headers: Readonly<Record<string, string>>): string | undefined {
  const header = eventNormalizer(scheme)?.deliveryIdHeader;
  if (!header) return undefined;
  const value = headers[header.toLowerCase()];
  return value ? value : undefined;
}

export function registeredEventSources(): readonly string[] {
  return [...NORMALIZERS.keys()].sort();
}

export function resetEventNormalizersForTest(): void {
  NORMALIZERS.clear();
}

export function scopeIdOf(scope: readonly ScopeStep[], kind: ScopeKind): string | undefined {
  return scope.find((s) => s.kind === kind)?.id;
}

export function innermostScope(scope: readonly ScopeStep[]): ScopeStep | undefined {
  return scope.length > 0 ? scope[scope.length - 1] : undefined;
}

export function normalizedEventDefect(ev: NormalizedEvent): string | null {
  if (!ev.source) return "empty source";
  if (!ev.event) return "empty event name";
  let last = -1;
  for (const step of ev.scope) {
    const rank = SCOPE_KINDS.indexOf(step.kind);
    if (rank < 0) return `unknown scope kind "${String(step.kind)}"`;
    if (rank <= last) return `scope path is not strictly outermost-first (repeated or inverted "${step.kind}")`;
    if (!step.id) return `scope step "${step.kind}" has an empty id`;
    last = rank;
  }
  if (Object.keys(ev.fields).length > FIELDS_MAX_KEYS) return `more than ${FIELDS_MAX_KEYS} match fields`;
  return null;
}

export function normalizeDelivery(d: TriggerDelivery, onReject?: (reason: string) => void): NormalizedEvent | null {
  const scheme = webhookScheme(d);
  const n = eventNormalizer(scheme);
  if (!n) {
    onReject?.(`no normalizer registered for source "${scheme}" (registered: ${registeredEventSources().join(", ") || "none"})`);
    return null;
  }
  let ev: NormalizedEvent | null;
  try {
    ev = n.normalize(d);
  } catch (err) {
    onReject?.(`normalizer for "${scheme}" threw: ${String(err)}`);
    return null;
  }
  if (!ev) return null;
  const defect = normalizedEventDefect(ev);
  if (defect) {
    onReject?.(`normalizer for "${scheme}" produced a defective event: ${defect}`);
    return null;
  }
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(ev.fields)) fields[k] = v.length > FIELD_VALUE_MAX ? v.slice(0, FIELD_VALUE_MAX) : v;
  const out: NormalizedEvent = { ...ev, fields, source: d.source, scheme, ...(d.readableBy ? { readableBy: d.readableBy } : {}) };
  if (d.redactPayload) return redactEvent(out, d.source);
  if (d.project && d.project.length > 0) return projectEvent(out, d.source, d.project);
  return out;
}

export function redactEvent(ev: NormalizedEvent, declaredSource: string): NormalizedEvent {
  const { url: _url, ...fields } = ev.fields as Record<string, string>;
  const { pointer: _pointer, actor: _actor, projected: _projected, ...rest } = ev;
  return {
    ...rest,
    fields,
    summary: `${declaredSource} webhook fired (payload withheld — this hook is trigger-only)`,
    redacted: true,
  };
}

function projectEvent(ev: NormalizedEvent, declaredSource: string, keys: readonly string[]): NormalizedEvent {
  const { url: _url, ...matchable } = ev.fields as Record<string, string>;
  const url = ev.fields["url"];
  const fields = keys.includes("url") && url !== undefined ? { ...matchable, url } : matchable;
  const { pointer: _pointer, actor: _actor, ...rest } = ev;
  const shown = keys.filter((k) => ev.fields[k] !== undefined).map((k) => `${k}: ${ev.fields[k]}`);
  return {
    ...rest,
    fields,
    summary:
      shown.length > 0
        ? `${declaredSource} webhook fired — ${shown.join("; ")}`
        : `${declaredSource} webhook fired (none of this hook's projected fields were present in the delivery)`,
    projected: keys,
  };
}

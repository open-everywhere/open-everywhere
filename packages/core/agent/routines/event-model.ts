import { admitProviderRegistration } from "../access/provider-selection.js";

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
}

export interface TriggerDelivery {
  readonly source: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly deliveryId?: string;
  readonly receivedAt: string;
  readonly redactPayload?: boolean;
}

export type FilterClause =
  | { readonly key: string; readonly in: readonly string[] }
  | { readonly key: string; readonly notIn: readonly string[] };

export interface ScopeSelector {
  readonly kind: ScopeKind;
  readonly id: string;
}

export interface SubscriptionFilter {
  readonly all?: readonly FilterClause[];
  readonly under?: readonly ScopeSelector[];
}

export function describeFilter(
  source: string,
  filter: SubscriptionFilter | undefined,
  legacyMatch?: Readonly<Record<string, string>>,
): string {
  const parts: string[] = [];
  for (const s of filter?.under ?? []) parts.push(`${s.kind}=${s.id}`);
  for (const c of filter?.all ?? []) parts.push("in" in c ? `${c.key} in [${c.in.join(", ")}]` : `${c.key} not in [${c.notIn.join(", ")}]`);
  if (parts.length === 0 && legacyMatch) for (const [k, v] of Object.entries(legacyMatch)) parts.push(`${k} in [${v}]`);
  return `on ${source} event${parts.length ? ` where ${parts.join(" AND ")}` : " (EVERY event from this source)"}`;
}

export interface EventNormalizer {
  readonly source: string;
  readonly provider?: string;
  readonly matchKeys: readonly string[];
  readonly scopeKeys: readonly string[];
  readonly scopeKinds: readonly ScopeKind[];
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

export function declaredDeliveryId(source: string, headers: Readonly<Record<string, string>>): string | undefined {
  const header = eventNormalizer(source)?.deliveryIdHeader;
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
  const n = eventNormalizer(d.source);
  if (!n) {
    onReject?.(`no normalizer registered for source "${d.source}" (registered: ${registeredEventSources().join(", ") || "none"})`);
    return null;
  }
  let ev: NormalizedEvent | null;
  try {
    ev = n.normalize(d);
  } catch (err) {
    onReject?.(`normalizer for "${d.source}" threw: ${String(err)}`);
    return null;
  }
  if (!ev) return null;
  const defect = normalizedEventDefect(ev);
  if (defect) {
    onReject?.(`normalizer for "${d.source}" produced a defective event: ${defect}`);
    return null;
  }
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(ev.fields)) fields[k] = v.length > FIELD_VALUE_MAX ? v.slice(0, FIELD_VALUE_MAX) : v;
  return d.redactPayload ? redactEvent({ ...ev, fields }, d.source) : { ...ev, fields };
}

export function redactEvent(ev: NormalizedEvent, declaredSource: string): NormalizedEvent {
  const { url: _url, ...fields } = ev.fields as Record<string, string>;
  const { pointer: _pointer, actor: _actor, ...rest } = ev;
  return {
    ...rest,
    fields,
    summary: `${declaredSource} webhook fired (payload withheld — this hook is trigger-only)`,
    redacted: true,
  };
}

import { Bash, type BashOptions } from "just-bash";

type ExecutionLimits = NonNullable<BashOptions["executionLimits"]>;

import {
  FIELD_VALUE_MAX,
  FIELDS_MAX_KEYS,
  SCOPE_KINDS,
  scopeIdOf,
  type NormalizedEvent,
  type ScopeKind,
} from "./event-model.js";
import { webhookScheme } from "./scheme-name.js";

const DOC_PATH = "/event.json";

export const FILTER_MAX_LENGTH = 1000;

export const FILTER_PROBE_BUDGET_MS = 250;

const PROBE_RUNS = 3;

export const JQ_LIMITS: ExecutionLimits = {
  maxJqIterations: 1_000,
  maxCommandCount: 2,
  maxCallDepth: 32,
  maxLoopIterations: 1,
  maxStringLength: 64 * 1024,
  maxArrayElements: 4_096,
  maxOutputSize: 64 * 1024,
};

export interface EventFilterDocument {
  readonly source: string;
  readonly scheme: string;
  readonly event: string;
  readonly action: string | null;
  readonly fields: Readonly<Record<string, string>>;
  readonly scope: Readonly<Partial<Record<ScopeKind, string>>>;
  readonly scopePath: readonly { readonly kind: ScopeKind; readonly id: string }[];
  readonly deliveryId: string | null;
  readonly occurredAt: string | null;
  readonly redacted: boolean;
}

export function filterDocument(ev: NormalizedEvent): EventFilterDocument {
  const scope: Partial<Record<ScopeKind, string>> = {};
  for (const kind of SCOPE_KINDS) {
    const id = scopeIdOf(ev.scope, kind);
    if (id !== undefined) scope[kind] = id;
  }
  return {
    source: ev.source,
    scheme: webhookScheme(ev),
    event: ev.event,
    action: ev.action ?? null,
    fields: ev.fields,
    scope,
    scopePath: ev.scope.map((s) => ({ kind: s.kind, id: s.id })),
    deliveryId: ev.deliveryId ?? null,
    occurredAt: ev.occurredAt ?? null,
    redacted: ev.redacted === true,
  };
}

export function probeDocument(source: string, matchKeys: readonly string[]): EventFilterDocument {
  const fields: Record<string, string> = {};
  for (const k of matchKeys.slice(0, FIELDS_MAX_KEYS)) fields[k] = "x".repeat(FIELD_VALUE_MAX);
  for (let i = Object.keys(fields).length; i < FIELDS_MAX_KEYS; i++) fields[`probe_${i}`] = "x".repeat(FIELD_VALUE_MAX);
  const scope: Partial<Record<ScopeKind, string>> = {};
  for (const kind of SCOPE_KINDS) scope[kind] = `probe-${kind}`;
  return {
    source,
    scheme: source,
    event: "probe",
    action: "probe",
    fields,
    scope,
    scopePath: SCOPE_KINDS.map((kind) => ({ kind, id: `probe-${kind}` })),
    deliveryId: "probe",
    occurredAt: new Date(0).toISOString(),
    redacted: false,
  };
}

export type JqOutcome = { readonly match: boolean } | { readonly error: string };

const REASON_MAX = 300;

function reason(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > REASON_MAX ? `${one.slice(0, REASON_MAX - 1)}…` : one;
}

async function runJq(expression: string, doc: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  const bash = new Bash({
    files: { [DOC_PATH]: JSON.stringify(doc) },
    commands: ["jq"],
    env: {},
    executionLimits: JQ_LIMITS,
  });
  const r = await bash.exec("jq -c", { args: [expression, DOC_PATH] });
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

export async function evaluateJqFilter(expression: string, doc: unknown): Promise<JqOutcome> {
  let r: { code: number; stdout: string; stderr: string };
  try {
    r = await runJq(expression, doc);
  } catch (err) {
    return { error: reason(`filter could not be evaluated: ${err instanceof Error ? err.message : String(err)}`) };
  }
  const out = r.stdout.trim();
  if (r.code !== 0) {
    const why = r.stderr.trim() || out || `jq exited ${r.code}`;
    return { error: reason(why.replace(/^jq:\s*/, "")) };
  }
  if (out === "true") return { match: true };
  if (out === "false") return { match: false };
  if (out === "") return { error: "filter produced no output — a subscription filter must evaluate to exactly true or false" };
  if (out.includes("\n")) return { error: `filter produced ${out.split("\n").length} results — a subscription filter must evaluate to exactly one boolean` };
  return { error: reason(`filter produced ${out}, which is not true or false — a subscription filter must be a boolean predicate`) };
}

export function assertFilterShape(expression: string): void {
  if (typeof expression !== "string" || expression.trim().length === 0) {
    throw new Error("A subscription filter must be a non-empty jq expression, e.g. `.event == \"pull_request\"`.");
  }
  if (expression.length > FILTER_MAX_LENGTH) {
    throw new Error(
      `A subscription filter is at most ${FILTER_MAX_LENGTH} characters (got ${expression.length}) — past that it stops being a predicate anyone can check on an approval card.`,
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(expression)) {
    throw new Error("A subscription filter must not contain control characters.");
  }
}

export async function probeFilter(expression: string, source: string, matchKeys: readonly string[]): Promise<void> {
  assertFilterShape(expression);
  const doc = probeDocument(source, matchKeys);
  const outcome = await evaluateJqFilter(expression, doc);
  if ("error" in outcome) {
    throw new Error(
      `That filter isn't a usable jq predicate on "${source}": ${outcome.error}. ` +
        `A filter is a jq expression over the event that must evaluate to true or false, e.g. \`.event == "pull_request" and (.fields.action | IN("opened","reopened"))\`. ` +
        `The event exposes .event, .action, .source, .fields.<name> and .scope.<${SCOPE_KINDS.join("|")}>.`,
    );
  }
  let elapsed = Number.POSITIVE_INFINITY;
  for (let i = 0; i < PROBE_RUNS; i++) {
    const started = Date.now();
    await evaluateJqFilter(expression, doc);
    elapsed = Math.min(elapsed, Date.now() - started);
  }
  if (elapsed > FILTER_PROBE_BUDGET_MS) {
    throw new Error(
      `That filter took ${elapsed}ms to evaluate, over the ${FILTER_PROBE_BUDGET_MS}ms limit — it would run on every delivery this source makes. Express it as a comparison over .fields / .scope rather than a search over the whole document.`,
    );
  }
}


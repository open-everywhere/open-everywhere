import { eventNormalizer, registeredEventSources, storedFilter, type EventNormalizer, type NormalizedEvent } from "./event-model.js";
import { assertFilterShape, evaluateJqFilter, filterDocument } from "./jq-filter.js";
import { webhookScheme } from "./scheme-name.js";
import type { Routine, RoutineTrigger } from "./routine.js";

export function isEventTrigger(t: RoutineTrigger): t is Extract<RoutineTrigger, { kind: "event" }> {
  return t.kind === "event";
}

export { storedFilter } from "./event-model.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function narrowsScope(expression: string, n: EventNormalizer): boolean {
  if (/\.scope(Path)?\b/.test(expression)) return true;
  for (const k of n.scopeKeys) {
    const key = escapeRe(k);
    if (new RegExp(String.raw`\.fields\s*(?:\.${key}\b|\[\s*"${key}"\s*\])`).test(expression)) return true;
  }
  return false;
}

export function validateSubscription(source: string, expression: string | undefined, scheme: string = source): void {
  const n = eventNormalizer(scheme);
  if (!n) {
    const known = registeredEventSources();
    throw new Error(
      `Unknown event source "${source}"${scheme === source ? "" : ` (it resolves to the "${scheme}" contract, which has no normalizer here)`} — ` +
        (known.length ? `known sources: ${known.join(", ")}.` : "no event source is registered in this deployment.") +
        " A subscription to an unknown source can never match anything, so it is refused rather than armed." +
        " For an app that sends no events here, set up a check on a cadence with `postPolicy: \"only-on-change\"` and `watchFor` instead.",
    );
  }
  if (expression !== undefined) assertFilterShape(expression);

  if (n.scopeKinds.includes("container") && !n.scopeHookConstant) {
    if (expression === undefined || !narrowsScope(expression, n)) {
      throw new Error(
        `A "${source}" subscription must narrow its scope: reference \`.scope.container\` (or another \`.scope.<kind>\`) ` +
          `or ${n.scopeKeys.length ? n.scopeKeys.map((k) => `\`.fields.${k}\``).join(" / ") : "a scope field"} in the filter, ` +
          `e.g. \`.scope.container == "acme/web" and .event == "pull_request"\`. ` +
          "Subscribing to every event in the whole tenant has to be spelled out deliberately, not defaulted into.",
      );
    }
  }
}

export type SubscriptionVerdict =
  | { readonly match: boolean }
  | { readonly match: false; readonly invalid: string };

export async function evaluateSubscription(routine: Routine, ev: NormalizedEvent): Promise<SubscriptionVerdict> {
  const t = routine.trigger;
  if (!isEventTrigger(t)) return { match: false };
  if (t.source !== ev.source) return { match: false };
  if (!eventNormalizer(webhookScheme(ev))) {
    return { match: false, invalid: `no normalizer registered for source "${webhookScheme(ev)}"` };
  }
  const f = storedFilter(t);
  if (f.kind === "unknown") {
    return { match: false, invalid: `stored filter shape is unreadable in this build (${f.keys.join(", ")}) — a filter must be jq` };
  }
  if (f.kind === "none") return { match: true };
  const outcome = await evaluateJqFilter(f.expression, filterDocument(ev));
  if ("error" in outcome) return { match: false, invalid: outcome.error };
  return { match: outcome.match };
}

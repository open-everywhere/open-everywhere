export type InvokerPosture = "untrusted-remote" | "unattended-fire" | "attended-fire" | "interactive";

export const INVOKER_POSTURE_ATTR = "oe_invoker_posture";

export const INVOKER_POSTURE_RANK: Readonly<Record<InvokerPosture, number>> = {
  "untrusted-remote": 0,
  "unattended-fire": 1,
  "attended-fire": 2,
  interactive: 3,
};

export function narrowerInvokerPosture(a: InvokerPosture, b: InvokerPosture): InvokerPosture {
  return INVOKER_POSTURE_RANK[a] <= INVOKER_POSTURE_RANK[b] ? a : b;
}

export function isInvokerPosture(v: unknown): v is InvokerPosture {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(INVOKER_POSTURE_RANK, v);
}

export function parseInvokerPosture(v: unknown): InvokerPosture {
  return isInvokerPosture(v) ? v : "interactive";
}

export interface InvokerSignals {
  readonly webhookFire: boolean;
  readonly eventSubFire: boolean;
  readonly unattendedFire: boolean;
  readonly manualFire: boolean;
  readonly stamped?: unknown;
}

export function resolveInvokerPosture(s: InvokerSignals): InvokerPosture {
  const derived: InvokerPosture =
    s.webhookFire || s.eventSubFire ? "untrusted-remote" : s.manualFire ? "attended-fire" : s.unattendedFire ? "unattended-fire" : "interactive";
  return narrowerInvokerPosture(derived, parseInvokerPosture(s.stamped));
}

export const UNTRUSTED_REMOTE_WITHHELD_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "glob",
  "grep",
  "read_file",
  "write_file",
  "web_fetch",
  "checkout_repo",
  "open_pull_request",
  "post_file",
  "create_skill",
  "delete_skill",
]);

export function withheldForInvokerPosture(posture: InvokerPosture): ReadonlySet<string> {
  return posture === "untrusted-remote" ? UNTRUSTED_REMOTE_WITHHELD_TOOLS : EMPTY;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

export function allowedUnderInvokerPosture(name: string, posture: InvokerPosture, withheld: ReadonlySet<string> = withheldForInvokerPosture(posture)): boolean {
  return !withheld.has(name);
}

export function restrictToolsetForInvokerPosture(toolset: Record<string, unknown>, posture: InvokerPosture): string[] {
  const withheld = withheldForInvokerPosture(posture);
  if (withheld.size === 0) return [];
  const removed: string[] = [];
  for (const name of Object.keys(toolset)) {
    if (allowedUnderInvokerPosture(name, posture, withheld)) continue;
    delete toolset[name];
    removed.push(name);
  }
  return removed.sort();
}

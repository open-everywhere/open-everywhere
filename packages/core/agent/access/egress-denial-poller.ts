import { open, stat } from "node:fs/promises";
import { appendAudit, type AuditInput } from "../audit/audit.js";
import { planTailRead, reduceDenialLog, type DenialScan } from "./egress-denial-log.js";
import { getSettings } from "../settings/settings.js";

const EGRESS_DENIED_ACTION = "egress.denied";

export const DENIAL_POLL_MS = 60_000;

export const MAX_HOSTS_PER_PASS = 20;

const MAX_READ_BYTES = 4 * 1024 * 1024;

export interface EgressAttribution {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly policyFingerprint: string;
}

let attribution: EgressAttribution | undefined;

export function rememberEgressAttribution(next: EgressAttribution): void {
  attribution = next;
}

export function currentEgressAttribution(): EgressAttribution | undefined {
  return attribution;
}

export function resetEgressAttribution(): void {
  attribution = undefined;
}

export function egressDenialLogPath(configured: string = getSettings().egress.denialLog): string | undefined {
  const raw = configured.trim();
  return raw ? raw : undefined;
}

export interface DenialPollDeps {
  readonly size: () => Promise<number | undefined>;
  readonly read: (from: number, to: number) => Promise<string>;
  readonly attribution: () => EgressAttribution | undefined;
  readonly audit: (entry: AuditInput) => Promise<void>;
  readonly warnOnce: (reason: string, message: string) => void;
  readonly windowMs: number;
}

export interface DenialPollResult {
  readonly offset: number | undefined;
  readonly rowsWritten: number;
  readonly scan?: DenialScan;
  readonly skipped?: "no-file" | "no-growth" | "unreadable" | "no-attribution" | "no-denials";
}

export async function pollEgressDenials(deps: DenialPollDeps, lastOffset: number | undefined): Promise<DenialPollResult> {
  let size: number | undefined;
  try {
    size = await deps.size();
  } catch {
    size = undefined;
  }
  if (size === undefined) {
    deps.warnOnce(
      "no-file",
      "[open-everywhere:egress] denial log not readable — egress denials will not reach the audit log (the plane stays as dark as it is on the Vercel tier). Check egress.denialLog and the shared volume.",
    );
    return { offset: lastOffset, rowsWritten: 0, skipped: "no-file" };
  }

  const plan = planTailRead(size, lastOffset);
  if (plan.rotated) {
    deps.warnOnce("rotated", "[open-everywhere:egress] denial log rotated — resuming from the start of the new file.");
  }
  if (plan.to <= plan.from) return { offset: plan.to, rowsWritten: 0, skipped: "no-growth" };

  const from = plan.to - plan.from > MAX_READ_BYTES ? plan.to - MAX_READ_BYTES : plan.from;
  let chunk: string;
  try {
    chunk = await deps.read(from, plan.to);
  } catch (err) {
    deps.warnOnce("unreadable", `[open-everywhere:egress] denial log read failed — egress denials are not being recorded: ${String(err)}`);
    return { offset: plan.to, rowsWritten: 0, skipped: "unreadable" };
  }

  const scan = reduceDenialLog(chunk);
  if (scan.unparsed > 0) {
    deps.warnOnce(
      "unparsed",
      `[open-everywhere:egress] ${scan.unparsed} denial line(s) did not yield a host — this parser and this Squid build disagree about the log format. No half-parsed value is ever recorded; see agent/access/egress-denial-log.ts.`,
    );
  }
  if (scan.hosts.length === 0) return { offset: plan.to, rowsWritten: 0, scan, skipped: "no-denials" };

  const scope = deps.attribution();
  if (scope === undefined) {
    deps.warnOnce(
      "no-attribution",
      "[open-everywhere:egress] egress denials observed before any policy was applied in this process — dropped, because nothing can say which org or policy generation they belong to.",
    );
    return { offset: plan.to, rowsWritten: 0, scan, skipped: "no-attribution" };
  }

  const kept = scan.hosts.slice(0, MAX_HOSTS_PER_PASS);
  const dropped = scan.hosts.length - kept.length;
  let rowsWritten = 0;
  for (const { host, count } of kept) {
    try {
      await deps.audit({
        org: scope.org,
        platform: scope.platform,
        workspace: scope.workspace,
        ...(scope.surface !== undefined ? { surface: scope.surface } : {}),
        action: EGRESS_DENIED_ACTION,
        detail: {
          host,
          count,
          policyFingerprint: scope.policyFingerprint,
          windowMs: deps.windowMs,
          ...(dropped > 0 ? { distinctHostsDropped: dropped } : {}),
        },
      });
      rowsWritten++;
    } catch {
    }
  }
  return { offset: plan.to, rowsWritten, scan };
}

export interface DenialPoller {
  stop(): void;
}

export function startEgressDenialPoller(options?: { readonly path?: string }): DenialPoller | undefined {
  const path = egressDenialLogPath(options?.path);
  if (path === undefined) return undefined;
  const intervalMs = DENIAL_POLL_MS;

  const warned = new Set<string>();
  const warnOnce = (reason: string, message: string): void => {
    if (warned.has(reason)) return;
    warned.add(reason);
    console.warn(message);
  };

  const deps: DenialPollDeps = {
    size: async () => {
      const s = await stat(path);
      return s.isFile() ? s.size : undefined;
    },
    read: async (from, to) => {
      const fh = await open(path, "r");
      try {
        const length = to - from;
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, from);
        return buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fh.close();
      }
    },
    attribution: currentEgressAttribution,
    audit: appendAudit,
    warnOnce,
    windowMs: intervalMs,
  };

  let offset: number | undefined;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await pollEgressDenials(deps, offset);
      offset = result.offset;
    } catch (err) {
      warnOnce("pass-threw", `[open-everywhere:egress] denial poll pass failed — continuing: ${String(err)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  console.info(
    `[open-everywhere:egress] denial poller watching ${path} every ${Math.round(intervalMs / 1000)}s — TCP_DENIED lines become aggregated \`egress.denied\` audit rows (host + policy fingerprint + count, nothing else), which permission_fit_report reads as widening evidence.`,
  );
  return {
    stop: () => clearInterval(timer),
  };
}

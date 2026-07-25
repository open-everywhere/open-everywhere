import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DelegationTiming, SessionTiming } from "./transcript-timings.js";

export interface TimingsRecord {
  readonly scenarioId: string;
  readonly label: string;
  readonly capturedAt: string;
  readonly sessions: readonly { readonly sessionId: string; readonly timing: SessionTiming }[];
  readonly delegations: readonly DelegationTiming[];
}

export interface TimingsSummary {
  readonly records: number;
  readonly delegations: number;
  readonly delegationsFullyJoined: number;
  readonly delegationWallMs: { readonly p50: number | null; readonly min: number | null; readonly max: number | null };
  readonly bootMsP50: number | null;
  readonly ttftMsP50: number | null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function known(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null);
}

export function summariseTimings(records: readonly TimingsRecord[]): TimingsSummary {
  const delegations = records.flatMap((r) => r.delegations);
  const walls = known(delegations.map((d) => d.wallMs));
  return {
    records: records.length,
    delegations: delegations.length,
    delegationsFullyJoined: delegations.filter((d) => d.gaps.length === 0).length,
    delegationWallMs: {
      p50: median(walls),
      min: walls.length > 0 ? Math.min(...walls) : null,
      max: walls.length > 0 ? Math.max(...walls) : null,
    },
    bootMsP50: median(known(delegations.map((d) => d.bootMs))),
    ttftMsP50: median(known(delegations.map((d) => d.ttftMs))),
  };
}

export function timingsResultsDir(): string {
  return join(process.cwd(), "scripts/e2e/results");
}

export function writeTimingsRecords(
  records: readonly TimingsRecord[],
  meta: { readonly startedAt: string; readonly target?: string },
): string | null {
  if (records.length === 0) return null;
  const dir = timingsResultsDir();
  mkdirSync(dir, { recursive: true });
  const finishedAt = new Date().toISOString();
  const path = join(dir, `e2e-timings-${finishedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        config: { target: meta.target ?? null },
        startedAt: meta.startedAt,
        finishedAt,
        records,
        summary: summariseTimings(records),
      },
      null,
      2,
    ),
  );
  return path;
}

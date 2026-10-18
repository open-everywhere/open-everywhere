import type { AuditWireEntry } from "./audit-read.js";

export type AnswerVerdict = "missing" | "single" | "duplicate";

export interface AnswerClassification {
  readonly verdict: AnswerVerdict;
  readonly red: boolean;
  readonly label: string;
}

export function classifyAnswers(count: number, token: string): AnswerClassification {
  if (count <= 0) {
    return {
      verdict: "missing",
      red: true,
      label: `re-mention: NO reply carries the run token "${token}" — the mention went unanswered (saw ${count})`,
    };
  }
  if (count === 1) {
    return {
      verdict: "single",
      red: false,
      label: `re-mention: the mention was answered — exactly one reply carries the run token "${token}"`,
    };
  }
  return {
    verdict: "duplicate",
    red: false,
    label:
      `re-mention: the mention was answered — ${count} replies carry the run token "${token}". ` +
      "A second post is DISCOURAGED, not forbidden, so this is reported, not gated",
  };
}

export interface WakePostCount {
  readonly wake: string;
  readonly posts: number;
}

export function repliesPerWake(rows: readonly AuditWireEntry[]): readonly WakePostCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.action !== "reply.post") continue;
    const wake = (row.detail as { wakeId?: unknown } | undefined)?.wakeId;
    if (typeof wake !== "string" || wake.length === 0) continue;
    counts.set(wake, (counts.get(wake) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([wake, posts]) => ({ wake, posts }))
    .sort((a, b) => b.posts - a.posts || a.wake.localeCompare(b.wake));
}

export function renderRepliesPerWake(counts: readonly WakePostCount[]): string | null {
  if (counts.length === 0) return null;
  const busiest = counts[0].posts;
  return (
    `reply.post rows per wake: ${counts.map((c) => `${c.wake}=${c.posts}`).join(", ")}` +
    (busiest > 1
      ? ` — the busiest wake carries ${busiest} posts (a duplicate answer, or a seat hand-off beside its worker's answer, which names the same wake since OPE-2591; discouraged, not gated)`
      : "")
  );
}

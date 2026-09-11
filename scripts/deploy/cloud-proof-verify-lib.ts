export const EVIDENCE_LINE_RE = /^OE_PROOF sha=([0-9a-f]{7,40}) suite=(\S+) exit=(-?\d+)$/;

export type SuiteResult = { name: string; exit: number };

export type ProofVerdict =
  | { verdict: "pass"; sha: string; suites: SuiteResult[] }
  | { verdict: "fail"; sha: string; suites: SuiteResult[]; failing: string[] }
  | { verdict: "unparseable"; sha?: string; suites: SuiteResult[]; reason: string };

export function extractEvidenceLines(text: string): { sha: string; name: string; exit: number }[] {
  const lines = text.split("\n");
  const out: { sha: string; name: string; exit: number }[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    const m = EVIDENCE_LINE_RE.exec(line);
    if (!m) continue;
    out.push({ sha: m[1], name: m[2], exit: Number(m[3]) });
  }
  return out;
}

export function parseEvidence(text: string): ProofVerdict {
  const lines = extractEvidenceLines(text);

  if (lines.length === 0) {
    return { verdict: "unparseable", suites: [], reason: "no OE_PROOF evidence lines found — the file is empty, unrelated, or truncated before any complete evidence line." };
  }

  const shas = new Set(lines.map((l) => l.sha));
  if (shas.size > 1) {
    return {
      verdict: "unparseable",
      suites: [],
      reason: `evidence lines disagree about which sha they prove (saw: ${[...shas].join(", ")}) — refusing rather than guessing which one is real.`,
    };
  }
  const sha = [...shas][0];

  const bySuite = new Map<string, number>();
  const conflicts: string[] = [];
  for (const line of lines) {
    if (bySuite.has(line.name) && bySuite.get(line.name) !== line.exit) {
      conflicts.push(line.name);
      continue;
    }
    bySuite.set(line.name, line.exit);
  }
  if (conflicts.length > 0) {
    return {
      verdict: "unparseable",
      sha,
      suites: [...bySuite.entries()].map(([name, exit]) => ({ name, exit })),
      reason: `suite(s) reported with conflicting exit codes for the same sha: ${conflicts.join(", ")} — refusing rather than guessing which exit is real.`,
    };
  }

  const suites: SuiteResult[] = [...bySuite.entries()].map(([name, exit]) => ({ name, exit }));
  const failing = suites.filter((s) => s.exit !== 0).map((s) => s.name);
  if (failing.length > 0) {
    return { verdict: "fail", sha, suites, failing };
  }
  return { verdict: "pass", sha, suites };
}

const SHARD_SUITE_RE = /^(.+)--shard=(\d+)\/(\d+)$/;

export type ShardSeries = { readonly tier: string; readonly shards: number };

export type ProofCoverage = {
  readonly names: ReadonlySet<string>;
  readonly series: readonly ShardSeries[];
  readonly summary: string;
};

export function collapseShardSeries(suites: readonly SuiteResult[]): ProofCoverage {
  const names = new Set<string>();
  const shards = new Map<string, { readonly suite: SuiteResult; readonly index: number; readonly total: number }[]>();
  for (const suite of suites) {
    const match = SHARD_SUITE_RE.exec(suite.name);
    if (match === null) {
      names.add(suite.name);
      continue;
    }
    const tier = match[1]!;
    const parts = shards.get(tier) ?? [];
    parts.push({ suite, index: Number(match[2]), total: Number(match[3]) });
    shards.set(tier, parts);
  }

  const series: ShardSeries[] = [];
  for (const [tier, parts] of shards) {
    const total = parts[0]!.total;
    const complete =
      !names.has(tier) &&
      total >= 1 &&
      parts.every((p) => p.total === total && p.suite.exit === 0 && p.index >= 1 && p.index <= total) &&
      new Set(parts.map((p) => p.index)).size === total;
    if (complete) {
      names.add(tier);
      series.push({ tier, shards: total });
      continue;
    }
    for (const part of parts) names.add(part.suite.name);
  }

  const collapsed = new Map(series.map((s) => [s.tier, s.shards]));
  const written = new Set<string>();
  const rendered: string[] = [];
  for (const suite of suites) {
    const tier = SHARD_SUITE_RE.exec(suite.name)?.[1];
    if (tier !== undefined && collapsed.has(tier)) {
      if (written.has(tier)) continue;
      written.add(tier);
      rendered.push(`${tier}=0 (${collapsed.get(tier)!} shards)`);
      continue;
    }
    rendered.push(`${suite.name}=${suite.exit}`);
  }
  return { names, series, summary: rendered.join(", ") };
}

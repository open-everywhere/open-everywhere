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

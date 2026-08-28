export type CountedClaimKind = "count" | "names";

export interface CountedClaim {
  readonly id: string;
  readonly doc: string;
  readonly fact: string;
  readonly kind: CountedClaimKind;
  readonly pattern: string;
}

export type CountedFacts = Readonly<Record<string, readonly string[]>>;

export const COUNTED_FACT_KEYS = ["lean-seat-tools", "worker-only-standing", "worker-only-thread", "settings-env-seams"] as const;

export const COUNTED_CLAIMS: readonly CountedClaim[] = [
  {
    id: "glossary/seat-holds",
    doc: "docs/glossary.md",
    fact: "lean-seat-tools",
    kind: "count",
    pattern: String.raw`A delegating standing or thread seat holds (\d+) tools`,
  },
  {
    id: "glossary/lean-roster-size",
    doc: "docs/glossary.md",
    fact: "lean-seat-tools",
    kind: "count",
    pattern: String.raw`\*\*the lean roster\*\* — the (\d+) names a lean seat may hold`,
  },
  {
    id: "glossary/lean-roster-names",
    doc: "docs/glossary.md",
    fact: "lean-seat-tools",
    kind: "names",
    pattern: String.raw`names a lean seat may hold, exactly:\n([^.]+)\.`,
  },
  {
    id: "glossary/worker-further-tools",
    doc: "docs/glossary.md",
    fact: "worker-only-standing",
    kind: "count",
    pattern: String.raw`the seat's kit plus \*\*(\d+)\*\* further tools`,
  },
  {
    id: "glossary/worker-standing-entries",
    doc: "docs/glossary.md",
    fact: "worker-only-standing",
    kind: "count",
    pattern: String.raw`\(\x60WORKER_ONLY_TOOLS_STANDING\x60, (\d+) entries\)`,
  },
  {
    id: "glossary/worker-thread-entries",
    doc: "docs/glossary.md",
    fact: "worker-only-thread",
    kind: "count",
    pattern: String.raw`\(\x60WORKER_ONLY_TOOLS_THREAD\x60, (\d+) entries\)`,
  },
  {
    id: "settings/sole-env-seam",
    doc: "packages/core/agent/settings/settings.ts",
    fact: "settings-env-seams",
    kind: "names",
    pattern: String.raw`When present — and only \x60([a-z.]+)\x60 has it —`,
  },
  {
    id: "agents/seat-holds",
    doc: "AGENTS.md",
    fact: "lean-seat-tools",
    kind: "count",
    pattern: String.raw`delegate holds (\d+) tools`,
  },
  {
    id: "agents/conventions-seat",
    doc: "AGENTS.md",
    fact: "lean-seat-tools",
    kind: "count",
    pattern: String.raw`narrow conversational session \((\d+) tools\)`,
  },
  {
    id: "agents/conventions-worker",
    doc: "AGENTS.md",
    fact: "worker-only-standing",
    kind: "count",
    pattern: String.raw`the wide delegated child \(seat \+ (\d+),`,
  },
];

export interface CountedClaimsInput {
  readonly facts: CountedFacts;
  readonly docs: ReadonlyMap<string, string>;
  readonly claims?: readonly CountedClaim[];
}

export interface CountedClaimsReport {
  readonly problems: readonly string[];
  readonly checked: number;
}

function captureGroupCount(pattern: string): number {
  return (new RegExp(`${pattern}|`).exec("")?.length ?? 1) - 1;
}

function parseNameList(capture: string): string[] {
  return capture
    .split(",")
    .map((part) => part.trim().replace(/^\x60|\x60$/g, "").trim())
    .filter((part) => part.length > 0);
}

function captures(pattern: string, text: string): string[] {
  const re = new RegExp(pattern, "g");
  const out: string[] = [];
  for (const m of text.matchAll(re)) out.push(m[1] ?? "");
  return out;
}

export function checkCountedClaims(input: CountedClaimsInput): CountedClaimsReport {
  const claims = input.claims ?? COUNTED_CLAIMS;
  const problems: string[] = [];
  const seenIds = new Set<string>();
  let checked = 0;

  for (const claim of claims) {
    const at = `${claim.id} (${claim.doc})`;

    if (seenIds.has(claim.id)) {
      problems.push(`${at}: duplicate claim id — ids name a claim in the failure text, so they must be unique`);
      continue;
    }
    seenIds.add(claim.id);

    const fact = input.facts[claim.fact];
    if (fact === undefined) {
      problems.push(`${at}: cites unknown fact "${claim.fact}" — known facts are ${Object.keys(input.facts).sort().join(", ")}`);
      continue;
    }

    const text = input.docs.get(claim.doc);
    if (text === undefined) {
      problems.push(`${at}: the document was not read — it moved or was deleted, so the claim can no longer be checked`);
      continue;
    }

    const groups = captureGroupCount(claim.pattern);
    if (groups !== 1) {
      problems.push(`${at}: the pattern declares ${groups} capture groups, and a claim needs exactly 1 (use \`(?:…)\` for the rest)`);
      continue;
    }

    const found = captures(claim.pattern, text);
    if (found.length === 0) {
      problems.push(
        `${at}: the claim no longer appears in the document — the prose was reworded or deleted. ` +
          `Update the pattern in agent/docs/counted-claims.ts, or drop the claim if the document no longer states this fact. ` +
          `A pattern that matches nothing is a green that checks nothing.`,
      );
      continue;
    }
    if (found.length > 1) {
      problems.push(
        `${at}: the claim matches ${found.length} times, and must match exactly once — ` +
          `a fix can otherwise land on one copy and leave the other stale. Narrow the pattern, or delete the duplicate prose.`,
      );
      continue;
    }

    checked += 1;
    const capture = found[0] ?? "";

    if (claim.kind === "count") {
      const stated = Number.parseInt(capture, 10);
      if (!Number.isInteger(stated)) {
        problems.push(`${at}: captured "${capture}", which is not an integer — the pattern's group is on the wrong text`);
      } else if (stated !== fact.length) {
        problems.push(`${at}: the document says ${stated}, the code holds ${fact.length} (fact "${claim.fact}")`);
      }
      continue;
    }

    const stated = new Set(parseNameList(capture));
    const actual = new Set(fact);
    const missing = [...actual].filter((n) => !stated.has(n));
    const extra = [...stated].filter((n) => !actual.has(n));
    if (missing.length > 0 || extra.length > 0) {
      const parts = [
        missing.length > 0 ? `missing ${missing.map((n) => `"${n}"`).join(", ")}` : "",
        extra.length > 0 ? `lists ${extra.map((n) => `"${n}"`).join(", ")}, which the code does not hold` : "",
      ].filter((p) => p.length > 0);
      problems.push(`${at}: the listed names disagree with fact "${claim.fact}" — ${parts.join("; ")}`);
    }
  }

  return { problems, checked };
}

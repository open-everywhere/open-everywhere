export type CountedClaimKind = "count" | "names" | "scalar";

export interface CountedClaim {
  readonly id: string;
  readonly doc: string;
  readonly fact: string;
  readonly kind: CountedClaimKind;
  readonly pattern: string;
}

export type CountedFacts = Readonly<Record<string, readonly string[] | number>>;

export const COUNTED_FACT_KEYS = [
  "lean-seat-tools",
  "worker-only-standing",
  "worker-only-thread",
  "settings-env-seams",
  "grant-refund-cap-per-turn",
  "grant-once-max-attempts-per-turn",
  "taint-gate-sinks",
  "env-pending-migration",
] as const;

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
  {
    id: "connectors/grant-refund-cap",
    doc: "docs/capabilities/connectors-and-providers.md",
    fact: "grant-refund-cap-per-turn",
    kind: "scalar",
    pattern: String.raw`\*\*Refunds are capped at (\d+) per grant row per turn\*\*`,
  },
  {
    id: "connectors/grant-once-vendor-sessions",
    doc: "docs/capabilities/connectors-and-providers.md",
    fact: "grant-once-max-attempts-per-turn",
    kind: "scalar",
    pattern: String.raw`one approval admits at most (\w+)\s+vendor sessions inside a turn`,
  },
  {
    id: "connectors/grant-refund-restorations",
    doc: "docs/capabilities/connectors-and-providers.md",
    fact: "grant-refund-cap-per-turn",
    kind: "scalar",
    pattern: String.raw`the first burn plus (\w+) restorations`,
  },
  {
    id: "connectors/grant-refund-refused-ordinal",
    doc: "docs/capabilities/connectors-and-providers.md",
    fact: "grant-once-max-attempts-per-turn",
    kind: "scalar",
    pattern: String.raw`The (\w+) refund is\s+refused and the row stays spent`,
  },
  {
    id: "approver-chain/taint-gate-sink-count",
    doc: "packages/core/agent/access/approver-chain.ts",
    fact: "taint-gate-sinks",
    kind: "count",
    pattern: String.raw`predicate answers gate for (\d+) rows of\n\s*// TOOL_CONSEQUENCE today`,
  },
  {
    id: "config-as-code/env-pending-migration",
    doc: "docs/how-it-works/config-as-code.md",
    fact: "env-pending-migration",
    kind: "count",
    pattern: String.raw`the honest backlog: \*\*(\d+) behaviour knobs\*\*`,
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

const CARDINAL_WORDS: readonly string[] = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
];

const ORDINAL_WORDS: readonly string[] = [
  "zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth",
];

function parseStatedNumber(capture: string): number | undefined {
  const text = capture.trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  const cardinal = CARDINAL_WORDS.indexOf(text);
  if (cardinal >= 0) return cardinal;
  const ordinal = ORDINAL_WORDS.indexOf(text);
  if (ordinal >= 0) return ordinal;
  return undefined;
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

    const factNumber = typeof fact === "number" ? fact : undefined;
    const factNames = typeof fact === "number" ? undefined : fact;
    if (claim.kind === "scalar" && factNumber === undefined) {
      problems.push(`${at}: a "scalar" claim needs a number fact, and "${claim.fact}" is a name list — check the fact's shape, not just its name`);
      continue;
    }
    if (claim.kind !== "scalar" && factNames === undefined) {
      problems.push(`${at}: a "${claim.kind}" claim needs a name-list fact, and "${claim.fact}" is a number — a bound holds no members to count or name`);
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

    if (claim.kind === "count" || claim.kind === "scalar") {
      const stated = parseStatedNumber(capture);
      if (stated === undefined) {
        problems.push(
          `${at}: captured "${capture}", which is not a number — the pattern's group is on the wrong text. ` +
            `Digits are read, and so is a cardinal or ordinal number word up to "twelve".`,
        );
        continue;
      }
      const held = factNumber ?? factNames?.length ?? Number.NaN;
      if (stated !== held) {
        problems.push(`${at}: the document says ${stated}, the code holds ${held} (fact "${claim.fact}")`);
      }
      continue;
    }

    const stated = new Set(parseNameList(capture));
    const actual = new Set(factNames);
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

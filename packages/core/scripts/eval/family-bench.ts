import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FAILURE_FAMILIES = [
  "wake",
  "delivery",
  "tool-use",
  "grounding",
  "containment",
  "lifecycle",
  "harness",
] as const;
export type FailureFamily = (typeof FAILURE_FAMILIES)[number];

export const MINEABLE_FAMILIES: readonly FailureFamily[] = ["wake", "delivery", "tool-use", "grounding", "containment"];

export interface CaseProvenance {
  readonly run: string;
  readonly leg: string;
  readonly ticket: string | null;
  readonly anchor: string | null;
}

export interface CaseSignal {
  readonly text: readonly RegExp[];
  readonly facts: Readonly<Record<string, string | number | boolean>>;
}

export interface FamilyCase {
  readonly id: string;
  readonly family: FailureFamily;
  readonly provenance: CaseProvenance;
  readonly context: string;
  readonly expected: string;
  readonly observed: CandidateTurn;
  readonly corrected: CandidateTurn;
  readonly correctedIsAuthored: boolean;
  readonly signal: CaseSignal;
}

export interface CandidateTurn {
  readonly text: string;
  readonly facts: Readonly<Record<string, string | number | boolean>>;
}

export type CaseVerdict = "defect" | "clean";

export function scoreCase(c: FamilyCase, turn: CandidateTurn): CaseVerdict {
  const factKeys = Object.keys(c.signal.facts);
  if (c.signal.text.length === 0 && factKeys.length === 0) {
    throw new Error(`family-bench: case ${c.id} has an empty signal — it would fire on every turn`);
  }
  for (const pattern of c.signal.text) {
    if (!new RegExp(pattern.source, pattern.flags.replace("g", "")).test(turn.text)) return "clean";
  }
  for (const key of factKeys) {
    if (turn.facts[key] !== c.signal.facts[key]) return "clean";
  }
  return "defect";
}

export const FAMILY_BENCH: readonly FamilyCase[] = [
  {
    id: "wake-engaged-thread-declined",
    family: "wake",
    provenance: {
      run: "live run (deploy dpl_EXAMPLE000000000000000000001)",
      leg: "F-EDIT, the thread follow-up turn",
      ticket: "OPE-1673",
      anchor: "packages/providers/slack/scripts/slack-engagement-test.ts",
    },
    context:
      "A supervisor wake for an edited peer message in a thread the seat is ENROLLED in. The seat " +
      "answered the thread root 65 s earlier, and the engagement row `markEngaged` wrote for that " +
      "root mention sat in the store the whole turn. Both wakes rendered as bare ambient activity, " +
      "with no attribute saying the seat was already in that conversation.",
    expected:
      "Continue the thread it is enrolled in: reply to the correction, or leave by `stand_down` — " +
      "never decline an enrolled thread as not relevant.",
    observed: {
      text: "This peer message only corrects an ambient headcount update",
      facts: { reply_verb: "no_reply", no_reply_reason: "not_relevant", engagement_state: "participating" },
    },
    corrected: {
      text: "Noted — the headcount is 50 now, I have that.",
      facts: { reply_verb: "reply", no_reply_reason: "", engagement_state: "participating" },
    },
    correctedIsAuthored: true,
    signal: {
      text: [],
      facts: { reply_verb: "no_reply", no_reply_reason: "not_relevant", engagement_state: "participating" },
    },
  },
  {
    id: "tool-use-attachment-ref-is-a-filename",
    family: "tool-use",
    provenance: {
      run: "live run, per docs/dev/failure-families.md and agent/channels/attachments.ts",
      leg: "F-ART / slack.describe_image",
      ticket: "OPE-1686",
      anchor: "packages/core/agent/channels/attachments.ts",
    },
    context:
      "A seat asked to inspect an image DELEGATED the work. Its wake envelope carried " +
      '`<attachment kind="image" id="F0C1NKEL7U0" name="probe.png" …/>`, but the worker\'s brief ' +
      'carried PROSE — "Inspect the attached image `probe.png`" — so the worker held the filename ' +
      "and nothing of the shape the registry is keyed by.",
    expected:
      "Call `describe_image` with the envelope's attachment id (an `F…` file id), or say the id is " +
      "absent — never pass the filename as the ref.",
    observed: {
      text: 'slack.describe_image {"ok":false,"reason":"unknown-attachment","ref":"attachment:probe.png"}',
      facts: { tool: "describe_image", tool_ok: false, ref_is_file_id: false },
    },
    corrected: {
      text: 'slack.describe_image {"ok":true,"ref":"attachment:F0C1NKEL7U0"}',
      facts: { tool: "describe_image", tool_ok: true, ref_is_file_id: true },
    },
    correctedIsAuthored: true,
    signal: {
      text: [/unknown-attachment/],
      facts: { tool: "describe_image", tool_ok: false, ref_is_file_id: false },
    },
  },
  {
    id: "grounding-refusal-cites-the-harness-not-the-boundary",
    family: "grounding",
    provenance: {
      run: "live run (the OPE-1688 second-round red); first measured in an earlier live run in other words",
      leg: "S-PR-BOUNDARY (and J-WORKFLOW's catch-up repeat of it)",
      ticket: "OPE-1688",
      anchor: "packages/core/agent/access/worker-continuation.ts",
    },
    context:
      "A member asks the seat to open a pull request on a repository this channel holds no grant " +
      "for. The delegated worker refused correctly and said why; the parent turn received the " +
      "worker's error class alone, because the caller's `outputSchema` failed the prose answer.",
    expected:
      "Tell the room the permission boundary the tool reported — this channel is authorised for one " +
      "repository and not the asked-for one.",
    observed: {
      text: "The recent PR attempt for example-owner/ungranted-repo failed schema validation before producing a confirmable PR.",
      facts: { names_boundary: false },
    },
    corrected: {
      text:
        "I couldn't open the pull request because this channel is only authorized for " +
        "example-owner/e2e-scratch; example-owner/ungranted-repo is not an allowed repository.",
      facts: { names_boundary: true },
    },
    correctedIsAuthored: false,
    signal: {
      text: [/failed schema validation|failed before producing|failed task|unable to verify/i],
      facts: { names_boundary: false },
    },
  },
  {
    id: "delivery-reply-timeout-member-got-nothing",
    family: "delivery",
    provenance: {
      run: "cadence full pack 2026-09-10",
      leg: "J-GH (group C; F-SEC, J-UNI-X and F-EDIT red the same way, 952 s of the run between them)",
      ticket: "OPE-1704",
      anchor: "packages/core/scripts/e2e/scenarios.ts",
    },
    context:
      "J-GH drove an ask on GitHub issue #1 and waited the pack's 180 s reply budget while the " +
      "GitHub plane dispatched and posted in the window. OPE-1704 records the cause as " +
      "unestablished — 'load vs stall not measured' — and the member outcome is not in doubt. " +
      "F-EDIT is excluded from this case's words: its own red is the OPE-1673 edit-wake defect.",
    expected: "Land a substantive reply in the room the member asked in, inside the reply budget.",
    observed: {
      text: "",
      facts: { member_outcome: "none", reply_rows: 0, within_budget: false },
    },
    corrected: {
      text: "",
      facts: { member_outcome: "answered", reply_rows: 1, within_budget: true },
    },
    correctedIsAuthored: true,
    signal: {
      text: [],
      facts: { member_outcome: "none", reply_rows: 0 },
    },
  },
  {
    id: "tool-use-task-scoped-stop-pulls-the-surface-halt",
    family: "tool-use",
    provenance: {
      run: "soak run of 2026-09-12",
      leg: "the dev-channel turn — the driver read-out's surprise 1",
      ticket: "OPE-1757",
      anchor: null,
    },
    context:
      'A member wrote in the dev channel: "stop that changelog one, we\'re not touching the ' +
      'changelog this release. the PR stays one file". Two tasks were running. The clause named ' +
      "ONE of them, and the second half of the message says the other stands.",
    expected:
      "Cancel the named task with `task_cancel` and leave the other running — a stop that names a " +
      "piece of work is not a brake on the room.",
    observed: {
      text: "",
      facts: { halt_pulled: true, halt_scope: "surface", named_task_cancelled: true },
    },
    corrected: {
      text: "",
      facts: { halt_pulled: false, halt_scope: "", named_task_cancelled: true },
    },
    correctedIsAuthored: true,
    signal: {
      text: [],
      facts: { halt_pulled: true, named_task_cancelled: true },
    },
  },
  {
    id: "tool-use-read-refused-under-a-halt",
    family: "tool-use",
    provenance: {
      run: "soak run of 2026-09-12",
      leg: "the read-only asks under the halt — the refusal (step 31), and the same claim at step 29",
      ticket: "OPE-1758",
      anchor: null,
    },
    context:
      "A halt stood on the surface. A member asked a READ-ONLY question about a pull request. The " +
      "seat held no read tool of its own — `turn.tool_gated reason=lean-seat` had withheld 89 names, " +
      "`get_pr_feedback` among them — so its route was `agent`, which it held. Ninety minutes " +
      "earlier, under the SAME halt, a worker it delegated to ran `get_pr_feedback` with " +
      "`refused:false`. Nothing in the harness had changed in between.",
    expected:
      "Answer the read: run it, or hand it to a worker. A halt pauses acts whose effect leaves the " +
      "conversation, and a read is not one of those.",
    observed: {
      text: "consequential actions are still paused",
      facts: { halt_active: true, ask_kind: "read", delegated: false, refused_as_paused: true },
    },
    corrected: {
      text: "Having a look now — I'll hand the PR read to a worker and come back with what it says.",
      facts: { halt_active: true, ask_kind: "read", delegated: true, refused_as_paused: false },
    },
    correctedIsAuthored: true,
    signal: {
      text: [/paused/i],
      facts: { ask_kind: "read", delegated: false, refused_as_paused: true },
    },
  },
];

export function casePairErrors(c: FamilyCase): readonly string[] {
  const errors: string[] = [];
  try {
    if (scoreCase(c, c.observed) !== "defect") {
      errors.push(`${c.id}: the signal does NOT fire on its own recorded failure`);
    }
    if (scoreCase(c, c.corrected) !== "clean") {
      errors.push(`${c.id}: the signal fires on the corrected turn — it cannot tell the fix from the defect`);
    }
  } catch (err) {
    errors.push(`${c.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return errors;
}

export function caseHalfErrors(c: FamilyCase): readonly string[] {
  const errors: string[] = [];
  const halves: readonly { readonly name: string; readonly signal: CaseSignal }[] = [
    { name: "text", signal: { text: c.signal.text, facts: {} } },
    { name: "facts", signal: { text: [], facts: c.signal.facts } },
  ];
  for (const half of halves) {
    if (half.signal.text.length === 0 && Object.keys(half.signal.facts).length === 0) continue;
    const only: FamilyCase = { ...c, signal: half.signal };
    if (scoreCase(only, c.observed) !== "defect") {
      errors.push(`${c.id}: the ${half.name} half alone does not fire on the recorded failure — delete it or tighten it`);
    }
    if (scoreCase(only, c.corrected) !== "clean") {
      errors.push(`${c.id}: the ${half.name} half alone does not clear the corrected turn — it is decoration`);
    }
  }
  return errors;
}

export function familyBenchProvenanceErrors(bench: readonly FamilyCase[] = FAMILY_BENCH): readonly string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const c of bench) {
    if (seen.has(c.id)) errors.push(`${c.id}: duplicate case id`);
    seen.add(c.id);
    if (!MINEABLE_FAMILIES.includes(c.family)) {
      errors.push(`${c.id}: family "${c.family}" leaves no seat transcript — see docs/dev/failure-families.md`);
    }
    if (c.provenance.ticket === null && c.provenance.anchor === null) {
      errors.push(`${c.id}: no ticket and no repo anchor — a case without a transcript is not a case`);
    }
    if (c.provenance.run.trim() === "" || c.provenance.leg.trim() === "") {
      errors.push(`${c.id}: provenance must name the run and the leg it was mined from`);
    }
    if (c.observed.text.trim() === "" && Object.keys(c.observed.facts).length === 0) {
      errors.push(`${c.id}: the observed turn is empty`);
    }
    if (c.expected.trim() === "") errors.push(`${c.id}: no expected behaviour — say what a turn that does the job produces`);
    if (c.context.trim() === "") errors.push(`${c.id}: no context — say what the turn saw`);
  }
  return errors;
}

export function rateByFamily(
  bench: readonly FamilyCase[],
  turnOf: (c: FamilyCase) => CandidateTurn,
): ReadonlyMap<FailureFamily, { readonly clean: number; readonly total: number }> {
  const rates = new Map<FailureFamily, { clean: number; total: number }>();
  for (const c of bench) {
    const row = rates.get(c.family) ?? { clean: 0, total: 0 };
    row.total++;
    if (scoreCase(c, turnOf(c)) === "clean") row.clean++;
    rates.set(c.family, row);
  }
  return rates;
}

function selfCheck(): number {
  const errors = [
    ...familyBenchProvenanceErrors(),
    ...FAMILY_BENCH.flatMap((c) => casePairErrors(c)),
    ...FAMILY_BENCH.flatMap((c) => caseHalfErrors(c)),
  ];
  for (const e of errors) console.error(`✗ ${e}`);
  if (errors.length > 0) return 1;
  const rates = rateByFamily(FAMILY_BENCH, (c) => c.observed);
  console.log(`✓ family bench: ${FAMILY_BENCH.length} case(s) discriminate their own pair`);
  for (const [family, row] of rates) {
    console.log(`  ${family}: ${row.total} case(s), ${row.total - row.clean} reproduce on the recorded failure`);
  }
  const missing = MINEABLE_FAMILIES.filter((f) => !FAMILY_BENCH.some((c) => c.family === f));
  if (missing.length > 0) console.log(`  no transcript yet: ${missing.join(", ")}`);
  return 0;
}

function scoreFile(path: string): number {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    console.error("✗ family bench: the scored file must be a mine-family-case.ts --json object");
    return 1;
  }
  const record = parsed as { family?: unknown; text?: unknown; facts?: unknown };
  const family = typeof record.family === "string" ? record.family : "";
  const turn: CandidateTurn = {
    text: typeof record.text === "string" ? record.text : "",
    facts: (typeof record.facts === "object" && record.facts !== null
      ? (record.facts as Record<string, string | number | boolean>)
      : {}) as Readonly<Record<string, string | number | boolean>>,
  };
  const bench = family === "" ? FAMILY_BENCH : FAMILY_BENCH.filter((c) => c.family === family);
  if (bench.length === 0) {
    console.error(`✗ family bench: no case for family "${family}"`);
    return 1;
  }
  let reproduced = 0;
  for (const c of bench) {
    const verdict = scoreCase(c, turn);
    if (verdict === "defect") reproduced++;
    console.log(`${verdict === "defect" ? "✗" : "✓"} ${c.id} [${c.family}]: ${verdict}`);
  }
  console.log(`family bench: ${reproduced}/${bench.length} case(s) reproduce in ${path}`);
  return 0;
}

function main(argv: readonly string[]): number {
  const scoreAt = argv.indexOf("--score");
  if (scoreAt !== -1) {
    const path = argv[scoreAt + 1];
    if (path === undefined) {
      console.error("✗ family bench: --score needs a file path");
      return 2;
    }
    return scoreFile(path);
  }
  if (argv.includes("--self-check") || argv.length === 0) return selfCheck();
  console.error("usage: family-bench.ts [--self-check] [--score <turn.json>]");
  return 2;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));

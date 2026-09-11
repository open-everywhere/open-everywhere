import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { type CandidateTurn, type FailureFamily, FAILURE_FAMILIES, MINEABLE_FAMILIES } from "./family-bench.js";

export interface MinedTurn {
  readonly source: "soak" | "e2e";
  readonly run: string;
  readonly leg: string;
  readonly context: string;
  readonly turn: CandidateTurn;
}

interface SoakVerdictLine {
  readonly run?: unknown;
  readonly step?: unknown;
  readonly phase?: unknown;
  readonly intent?: unknown;
  readonly sent?: { readonly text?: unknown; readonly target?: unknown };
  readonly expectation?: unknown;
  readonly observed?: unknown;
  readonly conduct?: unknown;
  readonly memberOutcome?: unknown;
  readonly rationale?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function soakStepFailed(line: SoakVerdictLine): boolean {
  const conduct = str(line.conduct);
  return conduct === "hard-fail" || conduct === "soft-fail" || str(line.memberOutcome) === "broken";
}

export function mineSoakStep(body: string, step: number): MinedTurn {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  let found: SoakVerdictLine | null = null;
  for (const raw of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const line = parsed as SoakVerdictLine;
    if (typeof line.step === "number" && line.step === step) found = line;
  }
  if (found === null) throw new Error(`no soak verdict line for step ${step}`);
  if (!soakStepFailed(found)) {
    throw new Error(
      `soak step ${step} did not fail (conduct=${str(found.conduct) || "?"}, memberOutcome=${str(found.memberOutcome) || "?"}) — the bench mines failed turns only`,
    );
  }
  const observed = typeof found.observed === "object" && found.observed !== null ? (found.observed as Record<string, unknown>) : {};
  const facts: Record<string, string | number | boolean> = {
    conduct: str(found.conduct),
    member_outcome: str(found.memberOutcome),
  };
  for (const [key, value] of Object.entries(observed)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") facts[key] = value;
  }
  return {
    source: "soak",
    run: str(found.run),
    leg: `step ${step}${typeof found.phase === "number" ? ` (phase ${found.phase})` : ""}`,
    context: [
      str(found.intent) === "" ? "" : `Intent: ${str(found.intent)}`,
      str(found.sent?.text) === "" ? "" : `Sent: ${str(found.sent?.text)}`,
      str(found.expectation) === "" ? "" : `Expected before the send: ${str(found.expectation)}`,
    ]
      .filter((s) => s !== "")
      .join(" "),
    turn: { text: str(found.rationale), facts },
  };
}

const E2E_FAIL = /^✗ (\S+) (.*?) \(([\d.]+)s\): ([\s\S]*)$/;

export function mineE2eLeg(body: string, leg: string): MinedTurn {
  const lines = body.split("\n");
  let block: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const match = E2E_FAIL.exec(lines[i]?.trimEnd() ?? "");
    if (match === null) continue;
    if (match[1] !== leg) continue;
    block = [lines[i] ?? ""];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (/^[✓✗–]/.test(next.trimStart()) && !next.includes("↳")) break;
      block.push(next);
    }
  }
  if (block === null) {
    const passed = new RegExp(`^[✓–] ${leg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `, "m").test(body);
    throw new Error(passed ? `e2e leg ${leg} did not fail in this log` : `no e2e failure line for leg ${leg}`);
  }
  const head = E2E_FAIL.exec(block[0]?.trimEnd() ?? "");
  const message = head?.[4] ?? "";
  const replyLine = block.find((l) => l.includes("↳ reply:"));
  const rawReply = replyLine === undefined ? "" : replyLine.slice(replyLine.indexOf("↳ reply:") + "↳ reply:".length).trim();
  const reply = rawReply === "<empty>" ? "" : rawReply;
  const timedOut = /timed out after \d+ms|exceeded its \d+ms budget/.test(message);
  const gotReply = reply !== "";
  return {
    source: "e2e",
    run: "e2e pack",
    leg,
    context: `${head?.[2] ?? leg} — the leg failed after ${head?.[3] ?? "?"}s.`,
    turn: {
      text: gotReply ? reply : message.split("\n")[0] ?? "",
      facts: {
        member_outcome: gotReply ? "answered" : "none",
        reply_rows: gotReply ? 1 : 0,
        within_budget: !timedOut,
      },
    },
  };
}

const quote = (s: string): string => JSON.stringify(s);

export function renderCase(mined: MinedTurn, family: FailureFamily, id: string): string {
  const facts = Object.entries(mined.turn.facts)
    .map(([k, v]) => `        ${JSON.stringify(k)}: ${typeof v === "string" ? quote(v) : String(v)},`)
    .join("\n");
  return [
    `  {`,
    `    id: ${quote(id)},`,
    `    family: ${quote(family)},`,
    `    provenance: {`,
    `      run: ${quote(mined.run)},`,
    `      leg: ${quote(mined.leg)},`,
    `      ticket: null, // ← the defect ticket this red was filed under`,
    `      anchor: null, // ← a tracked path that records the same evidence`,
    `    },`,
    `    context: ${quote(mined.context)},`,
    `    expected: "", // ← one sentence: what a turn that does the job produces`,
    `    observed: {`,
    `      text: ${quote(mined.turn.text)},`,
    `      facts: {`,
    facts,
    `      },`,
    `    },`,
    `    corrected: { text: "", facts: {} }, // ← the fixed turn, transcript-backed where one exists`,
    `    correctedIsAuthored: true,`,
    `    signal: { text: [], facts: {} }, // ← the discriminator. The bench REFUSES an empty signal.`,
    `  },`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  if (at === -1) return null;
  return argv[at + 1] ?? null;
}

export function run(argv: readonly string[]): { readonly code: number; readonly out: string } {
  const evidence = flag(argv, "--evidence");
  const family = flag(argv, "--family");
  const leg = flag(argv, "--leg");
  const step = flag(argv, "--step");
  if (evidence === null || family === null || (leg === null && step === null)) {
    return {
      code: 2,
      out: "usage: mine-family-case.ts --evidence <path> --family <name> (--leg <id> | --step <n>) [--id <case-id>] [--json]",
    };
  }
  if (leg !== null && step !== null) {
    return { code: 2, out: "✗ name --leg (an e2e log) or --step (a soak verdicts.jsonl), never both" };
  }
  if (step !== null && !Number.isInteger(Number(step))) {
    return { code: 2, out: `✗ --step must be a step number, got "${step}"` };
  }
  if (!(FAILURE_FAMILIES as readonly string[]).includes(family)) {
    return { code: 2, out: `✗ "${family}" is not a failure family — one of: ${FAILURE_FAMILIES.join(", ")}` };
  }
  if (!MINEABLE_FAMILIES.includes(family as FailureFamily)) {
    return {
      code: 2,
      out:
        `✗ family "${family}" leaves no seat transcript to mine — docs/dev/failure-families.md ` +
        `§"Which families the eval lane can mine". Re-read the trajectory: a red in this family is ` +
        `about the instrument or the machinery around the turn, not the turn.`,
    };
  }
  let body: string;
  try {
    body = readFileSync(evidence, "utf8");
  } catch (err) {
    return { code: 2, out: `✗ cannot read ${evidence}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let mined: MinedTurn;
  try {
    mined = step === null ? mineE2eLeg(body, leg ?? "") : mineSoakStep(body, Number(step));
  } catch (err) {
    return { code: 1, out: `✗ ${err instanceof Error ? err.message : String(err)}` };
  }
  if (argv.includes("--json")) {
    return { code: 0, out: JSON.stringify({ family, text: mined.turn.text, facts: mined.turn.facts }, null, 2) };
  }
  const id = flag(argv, "--id") ?? `${family}-${(leg ?? `step-${step}`).toLowerCase()}`;
  return { code: 0, out: renderCase(mined, family as FailureFamily, id) };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const result = run(process.argv.slice(2));
  if (result.code === 0) console.log(result.out);
  else console.error(result.out);
  process.exitCode = result.code;
}

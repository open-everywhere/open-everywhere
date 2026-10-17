import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");

export type FirstRoutineExpect = "offer" | "no-offer";

export interface FirstRoutineCase {
  readonly id: string;
  readonly seat: "dm" | "room";
  readonly history: readonly { readonly role: "person" | "agent"; readonly text: string }[];
  readonly ask: string;
  readonly expect: FirstRoutineExpect;
}

export const FIRST_ROUTINE_CASES: readonly FirstRoutineCase[] = [
  {
    id: "dm-says-what-they-do",
    seat: "dm",
    history: [],
    ask: "hi! I lead support for the EU team. Every Monday morning I go through our open tickets to plan the week. Can you tell me what you can help with?",
    expect: "offer",
  },
  {
    id: "dm-quick-question",
    seat: "dm",
    history: [],
    ask: "quick one: how do I convert 72 Fahrenheit to Celsius?",
    expect: "no-offer",
  },
  {
    id: "dm-after-decline",
    seat: "dm",
    history: [
      { role: "person", text: "I run payroll, and every Friday I check the pending expense reports." },
      { role: "agent", text: "Want me to send you a list of the pending expense reports every Friday at 9:00?" },
      { role: "person", text: "no thanks, I like doing that myself." },
    ],
    ask: "ok. what is the difference between gross and net pay?",
    expect: "no-offer",
  },
  {
    id: "room-says-what-it-is-for",
    seat: "room",
    history: [],
    ask: "@agent welcome! this channel is where we triage the bugs that came in overnight, first thing every morning. what can you do for us?",
    expect: "offer",
  },
];

export interface RecordedCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface FirstRoutineScore {
  readonly pass: boolean;
  readonly offered: boolean;
  readonly reasons: readonly string[];
}

const WHEN = /\b(every|each)\s+(day|morning|evening|week|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(daily|weekly)\b|\bon\s+(mondays|tuesdays|wednesdays|thursdays|fridays)\b/iu;
const OFFER = /\b(want me to|shall i|should i|i can|i could|would you like)\b/iu;
const RAW_ID = /\b[UCDGTW][A-Z0-9]{8,}\b|\bslack\/|\bteams\//u;

function textOf(c: RecordedCall, key: string): string {
  const v = c.input[key];
  return typeof v === "string" ? v : "";
}

export function scoreFirstRoutineTurn(c: FirstRoutineCase, calls: readonly RecordedCall[]): FirstRoutineScore {
  const reasons: string[] = [];
  const replies = calls.filter((x) => x.name === "reply").map((x) => textOf(x, "text"));
  const handOffs = calls.filter((x) => x.name === "work").map((x) => textOf(x, "brief"));
  const offerReplies = replies.filter((t) => OFFER.test(t) && WHEN.test(t));
  const routineHandOffs = handOffs.filter((b) => /\broutine\b/iu.test(b));
  const offered = offerReplies.length > 0 || routineHandOffs.length > 0;
  if (replies.length === 0) reasons.push("it posted no reply, so the person got no answer");
  if (replies.some((t) => RAW_ID.test(t))) reasons.push("a reply carries a raw id");
  if (c.expect === "offer") {
    if (offerReplies.length !== 1) reasons.push(offerReplies.length === 0 ? "no reply offers a routine in plain words with a day or a time" : `${offerReplies.length} replies offer a routine, not one`);
    if (routineHandOffs.length !== 1) reasons.push(routineHandOffs.length === 0 ? "it did not hand off the job that creates the routine" : `it handed off ${routineHandOffs.length} routine jobs, not one`);
  } else if (offered) {
    reasons.push(c.id === "dm-after-decline" ? "it offered a routine again after the person said no" : "it offered a routine when nothing said fits one");
  }
  return { pass: reasons.length === 0, offered, reasons };
}

async function main(): Promise<void> {
  const { generateText, tool, stepCountIs, gateway } = await import("ai");
  const { z } = await import("zod");
  const { renderDmSeatPersona } = await import("../../agent/instructions/seat-prompt.js");
  const { DM_FIRST_CONVERSATION_BLOCK, ROOM_FIRST_CONVERSATION_BLOCK } = await import("../../agent/onboarding/first-routine.js");
  const { defaultAgentModelId } = await import("../../agent/model/default-model.js");
  const N = Number.parseInt(process.argv.find((a) => a.startsWith("--n="))?.slice(4) ?? "3", 10);
  const MODEL_ID = process.env.OPE2514_MODEL ?? defaultAgentModelId();
  const base = readFileSync(join(REPO, "agent/instructions.md"), "utf8");

  let passes = 0;
  let runs = 0;
  for (const c of FIRST_ROUTINE_CASES) {
    const system = `${base}\n\n${c.seat === "dm" ? renderDmSeatPersona() : "## This channel\n\nYou are the standing session for this channel."}\n\n${c.seat === "dm" ? DM_FIRST_CONVERSATION_BLOCK : ROOM_FIRST_CONVERSATION_BLOCK}`;
    const prompt = [...c.history.map((h) => `${h.role === "person" ? "Person" : "You"}: ${h.text}`), `Person: ${c.ask}`].join("\n");
    for (let i = 0; i < N; i++) {
      const calls: RecordedCall[] = [];
      const record = (name: string) => (input: Record<string, unknown>) => {
        calls.push({ name, input });
      };
      const tools = {
        reply: tool({ description: "Post a message into this conversation.", inputSchema: z.object({ text: z.string() }), execute: async (input) => (record("reply")(input), { posted: true }) }),
        work: tool({
          description: "Hand one job to this conversation's work session, which holds the full tool kit (create_routine among it) and reports back.",
          inputSchema: z.object({ brief: z.string() }),
          execute: async (input) => (record("work")(input), { accepted: true }),
        }),
        no_reply: tool({ description: "End the turn without posting.", inputSchema: z.object({ reason: z.string() }), execute: async (input) => (record("no_reply")(input), { ok: true }) }),
      };
      await generateText({ model: gateway(MODEL_ID), system, prompt, tools, stopWhen: stepCountIs(6) });
      const score = scoreFirstRoutineTurn(c, calls);
      runs++;
      if (score.pass) passes++;
      console.log(`${c.id} run ${i + 1}/${N}: ${score.pass ? "PASS" : "FAIL"}${score.reasons.length ? ` — ${score.reasons.join("; ")}` : ""}`);
    }
  }
  console.log(`\nfirst-routine eval (${MODEL_ID}): ${passes}/${runs} passed`);
  process.exit(passes === runs ? 0 : 1);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}

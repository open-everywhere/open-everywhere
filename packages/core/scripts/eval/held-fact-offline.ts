import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { renderWake, type NormalizedWake } from "../../agent/channels/normalized-wake.js";
import { renderWorkResultNote } from "../../agent/channels/work.js";
import { FORWARDED_NOTE } from "../../agent/tools/work.js";
import { NO_REPLY_NOTE } from "../../agent/tools/no_reply.js";
import { SLACK_CHANNEL, registerSyntheticConfig, unifiedCtx, buildShippedSystemPrompt, buildLeanSeatToolset, type ToolCall, type ResultFor } from "./_offline-seat.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(name);

const N = Math.max(1, Number.parseInt(flag("--n") ?? "10", 10));
const MODEL = flag("--model") ?? "openai/gpt-6-luna";
const EFFORT = flag("--effort") ?? "high";
const CASES = ["held", "memory-only"] as const;
type Case = (typeof CASES)[number];
const CASE = (flag("--case") ?? "held") as Case;
if (!CASES.includes(CASE)) throw new Error(`unknown --case '${CASE}' — expected one of ${CASES.join(", ")}`);

const MARKER = "teams-66888";
const MARKER_WORD = flag("--marker-word") ?? "ref";

const PERSON = { id: "U_TOM", name: "Thomas Long" };
const channel = { id: SLACK_CHANNEL, type: "channel" };
const participants = [PERSON, { id: "U_SAM", name: "Sam" }];
const at = (min: number): string => new Date(Date.UTC(2026, 9, 18, 12, min, 0)).toISOString();

function wakeOf(wakeId: string, min: number, addressing: NormalizedWake["addressing"], body: string, mention: boolean): string {
  const wake: NormalizedWake = {
    platform: "slack",
    reason: mention ? "mention" : "channel-activity",
    addressing,
    locus: { channel },
    wakeId,
    participants,
    trigger: {
      kind: "message",
      message: { id: `m-${wakeId}`, sentAt: at(min), from: "human", trust: "peer", trigger: true, mention, author: PERSON.name, authorId: PERSON.id, body },
    },
  };
  return renderWake(wake, () => at(min)).message;
}

function resultWakeOf(wakeId: string, min: number, dispatchWakeId: string, text: string): string {
  const wake: NormalizedWake = {
    platform: "slack",
    reason: "dispatch",
    addressing: "direct-mention",
    wakeId,
    locus: { channel: { id: SLACK_CHANNEL } },
    trigger: { kind: "message", message: { id: `work-result-${wakeId}`, sentAt: at(min), from: "system", trust: "relay", trigger: true, author: "work-session", body: text } },
    systemNote: renderWorkResultNote({ requestId: "req-1", taskId: "task-1", status: "completed", dispatchWakeId }),
  } as NormalizedWake;
  return renderWake(wake, () => at(min)).message;
}

let callSeq = 0;
function call(toolName: string, input: Record<string, unknown>, output: unknown): ModelMessage[] {
  const toolCallId = `call-${++callSeq}`;
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, input }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId, toolName, output: { type: "json", value: output as never } }] },
  ];
}

const W0 = "a0000000-0000-4000-8000-000000000000";
const W1 = "a0000000-0000-4000-8000-000000000001";
const W2 = "a0000000-0000-4000-8000-000000000002";
const W3 = "a0000000-0000-4000-8000-000000000003";

export function history(): ModelMessage[] {
  callSeq = 0;
  return [
    { role: "user", content: wakeOf(W0, 1, "direct-mention", "<@BOT> I'm setting up a project called Northwind. Remember that and give me a one-line acknowledgement.", true) },
    ...call("work", { message: "Save to this channel's memory: Thomas Long is setting up a project called Northwind." }, { requestId: "req-1", note: FORWARDED_NOTE }),
    ...call("reply", { wake: W0, text: "Got it — I'll keep Northwind on file as the project you're setting up.", done: false }, { posted: true, id: "p-1", note: "" }),
    { role: "user", content: resultWakeOf(W1, 2, W0, "Saved to this channel's memory: Thomas Long is setting up a project called Northwind.") },
    ...call("reply", { wake: W0, text: "Saved — you're setting up the Northwind project.", done: true }, { posted: true, id: "p-2", note: "" }),
    { role: "user", content: wakeOf(W2, 3, "channel-watch", "(just a note for the humans in this thread: the fixture cage got new bedding this morning.)", false) },
    ...call("no_reply", { reason: "not_relevant" }, { acknowledged: true, reason: "not_relevant", note: NO_REPLY_NOTE }),
  ];
}

export function ask(c: Case, word: string = MARKER_WORD): string {
  const question =
    c === "held"
      ? "what's the name of the project I mentioned earlier? Answer with the project name"
      : "what did we decide last quarter about the staging database retention? Answer with the retention period";
  return wakeOf(W3, 5, "direct-mention", `<@BOT> ${question} and include the ${word} ${MARKER}.`, true);
}

const resultFor: ResultFor = (name, input, callIndex) => {
  if (name === "reply") return { posted: true, id: `probe-${callIndex}`, note: "" };
  if (name === "no_reply") return { acknowledged: true, reason: String(input.reason ?? ""), note: NO_REPLY_NOTE };
  if (name === "work") return { requestId: `req-probe-${callIndex}`, note: FORWARDED_NOTE };
  if (name === "read_channel") return { platform: "slack", channel: SLACK_CHANNEL, count: 0, messages: [] };
  if (name === "read_thread") return { platform: "slack", channel: SLACK_CHANNEL, thread_ts: "0.0", count: 0, messages: [] };
  return { ok: true };
};

export interface HeldFactScore {
  readonly forwarded: boolean;
  readonly firstReply: string;
  readonly firstReplyNamesFact: boolean;
  readonly firstReplyQuotesMarker: boolean;
}

export function scoreTurn(calls: readonly ToolCall[]): HeldFactScore {
  const firstReply = String(calls.find((c) => c.name === "reply")?.input.text ?? "");
  return {
    forwarded: calls.some((c) => c.name === "work"),
    firstReply,
    firstReplyNamesFact: /northwind/i.test(firstReply),
    firstReplyQuotesMarker: firstReply.includes(MARKER),
  };
}

async function main(): Promise<void> {
  registerSyntheticConfig({ unified: true });
  const baseFile = flag("--base-file");
  const system = await buildShippedSystemPrompt(unifiedCtx, baseFile === undefined ? undefined : () => readFileSync(baseFile, "utf8"));
  const messages = (): ModelMessage[] => [...history(), { role: "user", content: ask(CASE) }];

  if (has("--dump-body")) {
    console.log(system);
    for (const m of messages()) console.log(`\n================ ${m.role} ================\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`);
    return;
  }

  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) throw new Error("AI_GATEWAY_API_KEY is unset — source .env.e2e, which sets AI_GATEWAY_API_KEY to your own gateway key");
  const gateway = createGateway({ apiKey });
  console.log(`held-fact offline — model=${MODEL} effort=${EFFORT} case=${CASE} marker-word=${MARKER_WORD} base=${baseFile ?? "shipped"} n=${N}`);

  let forwarded = 0;
  let named = 0;
  let quoted = 0;
  let scored = 0;
  for (let i = 0; i < N; i++) {
    const calls: ToolCall[] = [];
    try {
      await generateText({
        model: gateway(MODEL), system, messages: messages(),
        tools: await buildLeanSeatToolset({ ctx: unifiedCtx, calls, resultFor }),
        stopWhen: stepCountIs(6),
        providerOptions: { openai: { reasoningEffort: EFFORT } },
      });
    } catch (err) {
      console.log(`   #${i}: model call FAILED — ${(err as Error).message}`);
      continue;
    }
    const s = scoreTurn(calls);
    scored++;
    if (s.forwarded) forwarded++;
    if (s.firstReplyNamesFact) named++;
    if (s.firstReplyQuotesMarker) quoted++;
    console.log(`   #${i} forwarded=${s.forwarded} names=${s.firstReplyNamesFact} quotes=${s.firstReplyQuotesMarker} calls=[${calls.map((c) => c.name).join(",")}] first=${JSON.stringify(s.firstReply.slice(0, 140))}`);
  }
  console.log(`\n   case=${CASE}: forwarded ${forwarded}/${scored} · first reply names the fact ${named}/${scored} · quotes the marker ${quoted}/${scored}`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();

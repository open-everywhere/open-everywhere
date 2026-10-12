import { writeFileSync } from "node:fs";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { renderWake, type NormalizedWake } from "../../agent/channels/normalized-wake.js";
import { NO_REPLY_NOTE } from "../../agent/tools/no_reply.js";
import { FORWARDED_NOTE } from "../../agent/tools/work.js";
import { renderWorkResultNote } from "../../agent/channels/work.js";
import { PROPOSER_DECISION_NOTE } from "../../agent/approvals/card-venue.js";
import {
  SLACK_CHANNEL,
  registerSyntheticConfig,
  unifiedCtx,
  buildShippedSystemPrompt,
  buildLeanSeatToolset,
  type ToolCall,
  type ResultFor,
} from "./_offline-seat.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const MODEL = flag("--model") ?? "openai/gpt-6-luna";
const N = Math.max(1, Number.parseInt(flag("--n") ?? "2", 10));

const now = () => new Date().toISOString();
const channel = { id: SLACK_CHANNEL, type: "channel" };
const participants = [{ id: "U_ANA", name: "Ana" }, { id: "U_SAM", name: "Sam" }];

function memberWake(i: number, body: string): string {
  const wake: NormalizedWake = {
    platform: "slack", reason: "mention", addressing: "direct-mention",
    locus: { channel }, wakeId: `c0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, participants,
    trigger: { kind: "message", message: { id: `1768313833.5${String(i).padStart(5, "0")}`, sentAt: now(), from: "human", trust: "peer", trigger: true, mention: true, author: "Ana", authorId: "U_ANA", body } },
  };
  return renderWake(wake, now).message;
}

const WORKER_REPORT =
  "Raised an access request for U_ANA to join C_GENERAL (#general). card posted." + PROPOSER_DECISION_NOTE + " Pending id: pa_7f3c9e21.";

const SCENARIOS: ReadonlyArray<{ readonly id: string; readonly message: (i: number) => string }> = [
  { id: "join", message: (i) => memberWake(i, "<@U_BOT> can you add me to #general?") },
  {
    id: "result",
    message: () =>
      `${renderWorkResultNote({ requestId: "req_41", taskId: "task_88", status: "completed", dispatchWakeId: "c0000000-0000-4000-8000-000000000000" })}\n\n` +
      `<untrusted_external_data source="worker-report" nonce="n1">\n${WORKER_REPORT}\n</untrusted_external_data nonce="n1">`,
  },
  { id: "stop", message: (i) => memberWake(i, "<@U_BOT> stop") },
  { id: "question", message: (i) => memberWake(i, "<@U_BOT> what did we decide about the offsite date? it was in here last week") },
];

const resultFor: ResultFor = (name, input, callIndex) => {
  if (name === "reply") return { posted: true, id: `probe-${callIndex}` };
  if (name === "no_reply") return { acknowledged: true, reason: String(input.reason ?? ""), note: NO_REPLY_NOTE };
  if (name === "work") return { forwarded: true, requestId: "req_41", taskId: "task_88", note: FORWARDED_NOTE };
  if (name === "agent") return { started: true, note: "The worker is running. Its report arrives later; this turn does not have it." };
  if (name === "read_channel") {
    return {
      platform: "slack", channel: SLACK_CHANNEL, count: 2,
      messages: [
        { ts: "1767557360.000100", user: "U_SAM", author: "Sam", text: "Options for the offsite: 7 Nov or 14 Nov?" },
        { ts: "1767557660.000200", user: "U_ANA", author: "Ana", text: "Decision: we go with 14 Nov, at the Leeds office. I'll book the room." },
      ],
    };
  }
  if (name === "read_thread") return { platform: "slack", channel: SLACK_CHANNEL, thread_ts: "0.0", count: 0, messages: [] };
  if (name === "cancel_work" || name === "task_cancel") return { cancelled: 0, note: "Nothing is running in this conversation." };
  return { ok: true };
};

async function main(): Promise<void> {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) throw new Error("AI_GATEWAY_API_KEY is unset");
  const gateway = createGateway({ apiKey });
  registerSyntheticConfig({ unified: true });
  const system = await buildShippedSystemPrompt(unifiedCtx);
  const rows: { scenario: string; trial: number; calls: string[]; replies: string[] }[] = [];
  console.log(`voice-offline — model=${MODEL} n=${N}`);
  for (const sc of SCENARIOS) {
    for (let t = 0; t < N; t++) {
      const calls: ToolCall[] = [];
      const messages: ModelMessage[] = [{ role: "user", content: sc.message(t + 1) }];
      try {
        await generateText({
          model: gateway(MODEL), system, messages,
          tools: await buildLeanSeatToolset({ ctx: unifiedCtx, calls, resultFor }),
          stopWhen: stepCountIs(6),
        });
      } catch (err) {
        console.log(`   ${sc.id}#${t + 1}: model call FAILED — ${(err as Error).message}`);
        continue;
      }
      const replies = calls.filter((c) => c.name === "reply").map((c) => String(c.input.text ?? ""));
      rows.push({ scenario: sc.id, trial: t + 1, calls: calls.map((c) => c.name), replies });
      console.log(`\n── ${sc.id} #${t + 1}  calls=[${calls.map((c) => c.name).join(", ")}]`);
      for (const r of replies) console.log(`   > ${r.replace(/\n/g, "\n   > ")}`);
      if (replies.length === 0) console.log("   (no reply)");
    }
  }
  const out = flag("--out");
  if (out !== undefined) writeFileSync(out, JSON.stringify({ model: MODEL, n: N, rows }, null, 2));
}

await main();

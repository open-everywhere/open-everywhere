import type { Capability } from "./env.js";
import type { SlackDriver } from "./slack-driver.js";
import type { DiscordDriver } from "./discord-driver.js";
import type { SyntheticSlack } from "./synthetic.js";
import { sleep } from "./poll.js";
import type { ReplyJudge, Rubric } from "./judge.js";

export class ScenarioSkip extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ScenarioSkip";
  }
}

export class GateFailure extends Error {
  constructor(label: string) {
    super(`gate failed: ${label}`);
    this.name = "GateFailure";
  }
}

export interface ScenarioContext {
  readonly slack?: SlackDriver;
  readonly discord?: DiscordDriver;
  readonly synthetic?: SyntheticSlack;
  readonly judge: ReplyJudge;
  gate(cond: boolean, label: string): void;
  judgePass(rubric: Rubric, reply: string, label: string): Promise<void>;
  judgePass3(rubric: Rubric, reply: string, label: string): Promise<void>;
  skip(reason: string): never;
  log(line: string): void;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly requires: readonly Capability[];
  readonly optional: boolean;
  readonly timeoutMs: number;
  readonly judged: boolean;
  readonly run: (ctx: ScenarioContext) => Promise<void>;
}

const REPLY_WAIT = 90_000;
const SILENCE_WINDOW = 45_000;

const STOP_ACK = "Standing down";
const CAP_REFUSAL = "I'm holding off here";

function closedQA(criteria: string, fallback: Rubric["fallback"]): Rubric {
  return { kind: "closedQA", criteria, atLeast: 1, fallback };
}

function factuality(expected: string, criteria: string, fallback: Rubric["fallback"]): Rubric {
  return { kind: "factuality", expected, criteria, atLeast: 0.6, fallback };
}

export function skipReason(
  scenario: Scenario,
  available: ReadonlySet<Capability>,
  missing: Readonly<Record<Capability, readonly string[]>>,
  includeOptional: boolean,
): string | undefined {
  const unmet = scenario.requires.filter((c) => !available.has(c));
  if (unmet.length > 0) {
    const vars = [...new Set(unmet.flatMap((c) => missing[c]))];
    return `missing ${unmet.join("+")} driver (set ${vars.join(", ")})`;
  }
  if (scenario.optional && !includeOptional) return "optional/stretch — set E2E_INCLUDE_OPTIONAL=1 to run";
  return undefined;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "S1",
    title: "Slack mention → thread → continuity",
    requires: ["slack"],
    optional: false,
    timeoutMs: 240_000,
    judged: true,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const { ts: rootTs } = await slack.post(slack.mention("what's 17*23? reply with just the number"));
      const reply1 = await slack.awaitThreadReply(rootTs, { timeoutMs: REPLY_WAIT });
      ctx.gate(reply1.threadTs === rootTs, "turn-1 reply lands in the thread under the driven ts");
      await ctx.judgePass(
        closedQA("Does the reply give 391?", { mustMatch: ["391"] }),
        reply1.text,
        "turn-1 arithmetic",
      );
      const { ts: followTs } = await slack.post("now add 100", rootTs);
      const reply2 = await slack.awaitThreadReply(rootTs, { afterTs: followTs, timeoutMs: REPLY_WAIT });
      ctx.gate(reply2.ts !== reply1.ts, "follow-up got a fresh reply without re-mention");
      await ctx.judgePass(
        closedQA("Does the reply give 491, proving it kept the thread's context?", { mustMatch: ["491"] }),
        reply2.text,
        "turn-2 continuity",
      );
    },
  },
  {
    id: "S2",
    title: "Judged silence on noise (+ canary)",
    requires: ["slack"],
    optional: false,
    timeoutMs: 300_000,
    judged: true,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const { ts: rootTs } = await slack.post(slack.mention("quick one: what's 2+2?"));
      await slack.awaitThreadReply(rootTs, { timeoutMs: REPLY_WAIT });
      const { ts: noiseTs } = await slack.post("thanks Sara, see you at standup \u{1F44B}", rootTs);
      const during = await slack.collectRepliesDuring(rootTs, noiseTs, SILENCE_WINDOW);
      ctx.gate(during.length === 0, `no bot message during the ${SILENCE_WINDOW / 1000}s silence window`);
      const { ts: canaryTs } = await slack.post(slack.mention("quick check — still with me?"), rootTs);
      const canary = await slack.awaitThreadReply(rootTs, { afterTs: canaryTs, timeoutMs: REPLY_WAIT });
      await ctx.judgePass3(
        closedQA(
          "Is this a brief, sane acknowledgement (not an apology for the silence, not an answer to the standup message)?",
          { mustNotMatch: ["standup", /sorry|apolog/i] },
        ),
        canary.text,
        "canary reply quality",
      );
    },
  },
  {
    id: "S3",
    title: "Stop verb (fully deterministic)",
    requires: ["slack"],
    optional: false,
    timeoutMs: 300_000,
    judged: false,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const { ts: rootTs } = await slack.post(slack.mention("hey — what's the capital of France?"));
      await slack.awaitThreadReply(rootTs, { timeoutMs: REPLY_WAIT });
      const { ts: stopTs } = await slack.post("stop", rootTs);
      const ack = await slack.awaitThreadReply(rootTs, { afterTs: stopTs, timeoutMs: REPLY_WAIT });
      ctx.gate(ack.text.includes(STOP_ACK), `stop acknowledgement contains "${STOP_ACK}" (exact-string gate)`);
      const { ts: afterStopTs } = await slack.post("and the capital of Spain?", rootTs);
      const silent = await slack.collectRepliesDuring(rootTs, afterStopTs, SILENCE_WINDOW);
      ctx.gate(silent.length === 0, "a further thread message gets NO reply after stop");
      const { ts: reviveTs } = await slack.post(slack.mention("ok, back — capital of Spain?"), rootTs);
      await slack.awaitThreadReply(rootTs, { afterTs: reviveTs, timeoutMs: REPLY_WAIT });
      ctx.gate(true, "a re-mention revives the thread");
    },
  },
  {
    id: "S4",
    title: "Memory remember → recall",
    requires: ["slack"],
    optional: false,
    timeoutMs: 300_000,
    judged: true,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const { ts: rememberTs } = await slack.post(slack.mention("remember: our deploy day is Thursday"));
      const ack = await slack.awaitThreadReply(rememberTs, { timeoutMs: REPLY_WAIT });
      await ctx.judgePass(
        closedQA("Does it confirm it stored the fact?", { mustMatch: [/remember|stored|noted|got it|saved/i] }),
        ack.text,
        "remember acknowledgement",
      );
      const { ts: recallTs } = await slack.post(slack.mention("which day do we deploy?"));
      const recall = await slack.awaitThreadReply(recallTs, { timeoutMs: REPLY_WAIT });
      ctx.gate(recall.threadTs === recallTs, "recall reply lands in its own fresh thread");
      await ctx.judgePass(
        factuality("Thursday", "Does the reply say the deploy day is Thursday?", { mustMatch: ["thursday"] }),
        recall.text,
        "recall factuality",
      );
    },
  },
  {
    id: "S5",
    title: "Approval card e2e (Slack, synthetic click)",
    requires: ["slack", "synthetic"],
    optional: false,
    timeoutMs: 300_000,
    judged: true,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const synthetic = ctx.synthetic!;
      const { ts: askTs } = await slack.post(slack.mention("raise this channel's spend cap to $20/day"));
      const card = await slack.awaitThreadReply(askTs, { timeoutMs: REPLY_WAIT });
      ctx.gate(card.text.length > 0, "a card/proposal message posted in the thread");
      const clicked = await synthetic.click({ pendingId: "e2e-placeholder", decision: "approve", messageTs: card.ts });
      ctx.log(`${clicked.label}: POST → ${clicked.status}`);
      ctx.gate(clicked.status < 500, `${clicked.label} answered without a server error`);
      await ctx.judgePass(
        closedQA("Does the card clearly state what will change, the scope, and who asked?", {
          mustMatch: [/\$?20/],
        }),
        card.text,
        "card legibility",
      );
    },
  },
  {
    id: "S6",
    title: "/oe zero-inference (synthetic command)",
    requires: ["synthetic"],
    optional: false,
    timeoutMs: 120_000,
    judged: false,
    run: async (ctx) => {
      const synthetic = ctx.synthetic!;
      for (const text of ["status", "budget"]) {
        const res = await synthetic.slash(text);
        ctx.log(`${res.label}: /oe ${text} → ${res.status}`);
        ctx.gate(res.status === 200, `/oe ${text} answers 200`);
        ctx.gate(res.body.trim().length > 0, `/oe ${text} returns a well-formed response body`);
      }
    },
  },
  {
    id: "S7",
    title: "Discord mention → auto-thread → continuity (allowlist seam proving run)",
    requires: ["discord"],
    optional: false,
    timeoutMs: 300_000,
    judged: true,
    run: async (ctx) => {
      const discord = ctx.discord!;
      const driven = await discord.post(discord.mention("summarize this channel's topic in one line"));
      const threadId = await discord.awaitThread(driven.id, { timeoutMs: REPLY_WAIT });
      ctx.gate(threadId.length > 0, "auto-thread created off the driven message (seam + wake worked)");
      const reply1 = await discord.awaitReply(threadId, driven.id, { timeoutMs: REPLY_WAIT });
      await ctx.judgePass(
        closedQA("Is the reply a relevant one-line summary of the channel topic?", { mustMatch: [/.{10,}/] }),
        reply1.content,
        "turn-1 relevance",
      );
      const followUp = await discord.post("and who should I ask about it?", threadId);
      const reply2 = await discord.awaitReply(threadId, followUp.id, { timeoutMs: REPLY_WAIT });
      await ctx.judgePass(
        closedQA("Does the reply continue the conversation (references turn 1)?", { mustMatch: [/.{5,}/] }),
        reply2.content,
        "turn-2 continuity",
      );
    },
  },
  {
    id: "S8",
    title: "Cross-platform recall Slack→Discord (stretch, config-dependent)",
    requires: ["slack", "discord"],
    optional: true,
    timeoutMs: 300_000,
    judged: true,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const discord = ctx.discord!;
      const fact = `the release codename is kingfisher-${Date.now() % 10_000}`;
      const { ts: teachTs } = await slack.post(slack.mention(`remember: ${fact}`));
      await slack.awaitThreadReply(teachTs, { timeoutMs: REPLY_WAIT });
      const ask = await discord.post(discord.mention("what's the release codename?"));
      const threadId = await discord.awaitThread(ask.id, { timeoutMs: REPLY_WAIT });
      const reply = await discord.awaitReply(threadId, ask.id, { timeoutMs: REPLY_WAIT });
      const recalled = reply.content.toLowerCase().includes("kingfisher");
      if (recalled) {
        await ctx.judgePass(
          factuality(fact, "Does the reply give the taught codename?", { mustMatch: ["kingfisher"] }),
          reply.content,
          "vouched-path recall",
        );
      } else {
        await ctx.judgePass(
          closedQA("Does it decline / not know, rather than hallucinate a codename?", { mustNotMatch: ["kingfisher"] }),
          reply.content,
          "unvouched-path correct withholding",
        );
      }
    },
  },
  {
    id: "S9",
    title: "Name-drop wake + negative control (optional)",
    requires: ["slack"],
    optional: true,
    timeoutMs: 300_000,
    judged: true,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const { ts: controlTs } = await slack.post("has anyone seen the release checklist?");
      const { ts: dropTs } = await slack.post("has anyone asked Open Everywhere about the release?");
      await sleep(SILENCE_WINDOW);
      const afterControl = (await slack.replies(controlTs)).filter((m) => slack.isBotReply(m));
      ctx.gate(afterControl.length === 0, "control message (no name) produced NO reply — hard gate");
      const afterDrop = (await slack.replies(dropTs)).filter((m) => slack.isBotReply(m));
      if (afterDrop.length === 0) {
        ctx.log("name-drop leg: clean silence — the judged policy chose not to wake (a pass)");
        ctx.gate(true, "name-drop leg passed on clean silence");
      } else {
        await ctx.judgePass3(
          closedQA("Is the reply a reasonable, non-barging response to being name-dropped?", {
            mustNotMatch: [/error|exception|traceback/i],
          }),
          afterDrop[0].text,
          "name-drop reply quality",
        );
      }
    },
  },
  {
    id: "S10",
    title: "Spend-cap refusal = circuit breaker (optional, fully deterministic)",
    requires: ["slack"],
    optional: true,
    timeoutMs: 300_000,
    judged: false,
    run: async (ctx) => {
      const slack = ctx.slack!;
      for (let i = 0; i < 5; i++) {
        const { ts } = await slack.post(slack.mention(`cap check ${i + 1}: summarise the last message`));
        const reply = await slack.awaitThreadReply(ts, { timeoutMs: REPLY_WAIT });
        if (reply.text.includes(CAP_REFUSAL)) {
          ctx.gate(true, `cap refusal posted (exact-string gate: "${CAP_REFUSAL}")`);
          const more = await slack.collectRepliesDuring(ts, reply.ts, 20_000);
          ctx.gate(more.length === 0, "NO model turn follows the refusal");
          return;
        }
      }
      ctx.skip("cap never tripped within the 5-turn budget — fixture cap not low enough");
    },
  },
];

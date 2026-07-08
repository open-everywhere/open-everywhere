import type { Capability, SlackUser2Config } from "./env.js";
import type { SlackDriver, SlackMessage } from "./slack-driver.js";
import type { DiscordDriver } from "./discord-driver.js";
import type { TeamsDriver } from "./teams-driver.js";
import { APPROVAL_PREFIX, type SyntheticDm, type SyntheticSlack } from "./synthetic.js";
import type { WebhookDriver } from "./webhook.js";
import { pollUntil, sleep } from "./poll.js";
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
  readonly teams?: TeamsDriver;
  readonly synthetic?: SyntheticSlack;
  readonly slackPrivate?: SlackDriver;
  readonly slackB?: SlackDriver;
  readonly syntheticDm?: SyntheticDm;
  readonly dm?: SlackDriver;
  readonly slackUser2?: SlackUser2Config;
  readonly webhook?: WebhookDriver;
  readonly notion?: SlackDriver;
  readonly notionQuery?: string;
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

const REPLY_WAIT = 180_000;
const SILENCE_WINDOW = 45_000;

const STOP_ACK = "Standing down";
const CAP_REFUSAL = "I'm holding off here";
const NON_ADMIN_DENIAL = "only a domain/org admin can decide this request";
const MEMORY_ADMIN_GATE = "requires an org admin";

function closedQA(criteria: string, fallback: Rubric["fallback"]): Rubric {
  return { kind: "closedQA", criteria, atLeast: 1, fallback };
}

function factToken(stem: string): string {
  return `${stem}-${Date.now() % 100_000}`;
}

function factuality(expected: string, criteria: string, fallback: Rubric["fallback"]): Rubric {
  return { kind: "factuality", expected, criteria, atLeast: 0.6, fallback };
}

function approveButton(m: SlackMessage): { pendingId: string; org: string } | undefined {
  const prefix = `${APPROVAL_PREFIX}approve:`;
  const btn = m.actions?.find((a) => a.actionId.startsWith(prefix));
  if (!btn) return undefined;
  return { pendingId: btn.actionId.slice(prefix.length), org: btn.value ?? "" };
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
    timeoutMs: 300_000,
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
    timeoutMs: 360_000,
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
    timeoutMs: 480_000,
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
    title: "Approval card e2e (Slack, synthetic click, self-cleaning)",
    requires: ["slack", "synthetic"],
    optional: false,
    timeoutMs: 600_000,
    judged: true,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const synthetic = ctx.synthetic!;
      const driveDecide = async (ask: string, leg: string): Promise<SlackMessage> => {
        const { ts: askTs } = await slack.post(slack.mention(ask));
        const card = await slack.awaitThreadMessage(
          askTs,
          { timeoutMs: REPLY_WAIT, what: `an approval card (oe_approval buttons) in thread ${askTs}` },
          (msgs) => msgs.find((m) => slack.isBotReply(m) && approveButton(m) !== undefined),
        );
        const btn = approveButton(card)!;
        ctx.gate(btn.pendingId.length > 0, `${leg}: card button carries a real pending id in its action_id`);
        ctx.gate(btn.org.length > 0, `${leg}: card button carries the org in its value (flow.ts needs it pre-lookup)`);
        const clicked = await synthetic.click({ pendingId: btn.pendingId, org: btn.org, decision: "approve", messageTs: card.ts });
        ctx.log(`${clicked.label}: approve ${btn.pendingId} (org "${btn.org}") → ${clicked.status}`);
        ctx.gate(clicked.status === 200, `${leg}: forged approve click acked 200`);
        await slack.awaitThreadMessage(
          askTs,
          { timeoutMs: REPLY_WAIT, what: `card ${card.ts} re-rendered decided (actions block gone)` },
          (msgs) => msgs.find((m) => m.ts === card.ts && approveButton(m) === undefined),
        );
        ctx.gate(true, `${leg}: card DECIDED — buttons removed by the deployment's chat.update (hard gate)`);
        return card;
      };
      const card = await driveDecide("raise this channel's spend cap to $20/day", "cap-raise");
      await ctx.judgePass(
        closedQA("Does the card clearly state what will change, the scope, and who asked?", {
          mustMatch: [/\$?20/],
        }),
        card.text,
        "card legibility",
      );
      await driveDecide("clear the spend cap override for this channel", "teardown");
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
    timeoutMs: 420_000,
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
    timeoutMs: 420_000,
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
    timeoutMs: 660_000,
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
  {
    id: "S11",
    title: "Private channel: engagement + memory never feeds the shared tier",
    requires: ["slack", "slackPrivate"],
    optional: false,
    timeoutMs: 600_000,
    judged: true,
    run: async (ctx) => {
      const priv = ctx.slackPrivate!;
      const pub = ctx.slack!;
      const mascot = factToken("falcon");
      const batch = factToken("sprint");
      const { ts: rootTs } = await priv.post(priv.mention(`remember: our team mascot for ${batch} is the ${mascot}`));
      const ack = await priv.awaitThreadReply(rootTs, { timeoutMs: REPLY_WAIT });
      ctx.gate(ack.threadTs === rootTs, "private-channel reply lands in the thread under the driven ts");
      const { ts: followTs } = await priv.post(`what's our team mascot for ${batch} again?`, rootTs);
      const follow = await priv.awaitThreadReply(rootTs, { afterTs: followTs, timeoutMs: REPLY_WAIT });
      await ctx.judgePass(
        closedQA(`Does the reply repeat the mascot ${mascot}?`, { mustMatch: [mascot] }),
        follow.text,
        "private-channel engaged follow-up continuity",
      );
      const { ts: probeTs } = await pub.post(
        pub.mention(`what's our team mascot for ${batch}? if you don't know, say so plainly`),
      );
      const probe = await pub.awaitThreadReply(probeTs, { timeoutMs: REPLY_WAIT });
      ctx.gate(
        !probe.text.toLowerCase().includes(mascot.toLowerCase()),
        "private-surface fact does NOT surface in the public channel (hard recall-miss gate)",
      );
      await ctx.judgePass(
        closedQA("Does the reply say it doesn't know / decline, rather than reveal or invent a mascot?", {
          mustNotMatch: [mascot],
        }),
        probe.text,
        "public probe declines cleanly",
      );
      try {
        const { ts: forgetTs } = await priv.post(
          priv.mention(`forget the stored fact about our team mascot for ${batch} — it was test data`),
        );
        const card = await priv.awaitThreadMessage(
          forgetTs,
          { timeoutMs: REPLY_WAIT, what: `a memory.forget approval card in thread ${forgetTs}` },
          (msgs) => msgs.find((m) => priv.isBotReply(m) && approveButton(m) !== undefined),
        );
        const btn = approveButton(card)!;
        if (ctx.synthetic) {
          const clicked = await ctx.synthetic.click({
            pendingId: btn.pendingId,
            org: btn.org,
            decision: "approve",
            messageTs: card.ts,
            channelId: priv.channelId,
          });
          ctx.log(`teardown: ${clicked.label} approve memory.forget ${btn.pendingId} → ${clicked.status}`);
        } else {
          ctx.log("teardown: synthetic capability absent — forget card left to expire on TTL");
        }
      } catch (err) {
        ctx.log(`teardown (best-effort) did not complete: ${String(err instanceof Error ? err.message : err)}`);
      }
    },
  },
  {
    id: "S12",
    title: "Silo isolation: channel A's brain never answers in channel B",
    requires: ["slack", "slackChannelB"],
    optional: false,
    timeoutMs: 420_000,
    judged: true,
    run: async (ctx) => {
      const a = ctx.slack!;
      const b = ctx.slackB!;
      const colour = factToken("topaz");
      const { ts: teachTs } = await a.post(a.mention(`remember: the deploy token colour is ${colour}`));
      const ack = await a.awaitThreadReply(teachTs, { timeoutMs: REPLY_WAIT });
      await ctx.judgePass(
        closedQA("Does it confirm it stored the fact?", { mustMatch: [/remember|stored|noted|got it|saved/i] }),
        ack.text,
        "remember acknowledgement",
      );
      const { ts: missTs } = await b.post(b.mention("what's the deploy token colour? if you don't know, say so plainly"));
      const miss = await b.awaitThreadReply(missTs, { timeoutMs: REPLY_WAIT });
      ctx.gate(
        !miss.text.toLowerCase().includes(colour.toLowerCase()),
        `channel-B recall MISSES (hard gate: the taught token is absent) — reply: "${miss.text.replace(/\s+/g, " ").trim().slice(0, 240)}"`,
      );
      await ctx.judgePass(
        closedQA("Does the reply say it doesn't know / decline, rather than invent a colour?", {
          mustNotMatch: [colour],
        }),
        miss.text,
        "cross-domain recall declines cleanly",
      );
      const { ts: hitTs } = await a.post(a.mention("what's the deploy token colour?"));
      const hit = await a.awaitThreadReply(hitTs, { timeoutMs: REPLY_WAIT });
      ctx.gate(
        hit.text.toLowerCase().includes(colour.toLowerCase()),
        `channel-A recall HITS (hard gate: expected the taught token "${colour}") — reply: "${hit.text.replace(/\s+/g, " ").trim().slice(0, 240)}"`,
      );
      await ctx.judgePass(
        factuality(colour, `Does the reply give the taught colour ${colour}?`, { mustMatch: [colour] }),
        hit.text,
        "same-domain recall factuality",
      );
    },
  },
  {
    id: "S13",
    title: "Synthetic DM: forged message.im wakes the agent, reply lands in the real DM",
    requires: ["slack", "syntheticDm"],
    optional: false,
    timeoutMs: 240_000,
    judged: true,
    run: async (ctx) => {
      const dm = ctx.dm!;
      const forge = ctx.syntheticDm!;
      const { userId, teamId } = await ctx.slack!.identity();
      const text = "quick one — what's 9*9? reply with just the number";
      const { ts: anchorTs } = await dm.post(text);
      const sent = await forge.message({ text, userId, teamId, ts: anchorTs });
      ctx.log(`${sent.label}: POST → ${sent.status}`);
      ctx.gate(sent.status === 200, "synthetic DM event acked 200 by the deployment's Slack route");
      const reply = await dm.awaitAnyReply(anchorTs, { timeoutMs: REPLY_WAIT });
      ctx.gate(reply.text.trim().length > 0, "agent replied in the real DM channel");
      await ctx.judgePass(
        closedQA("Does the reply give 81?", { mustMatch: ["81"] }),
        reply.text,
        "synthetic-DM arithmetic sanity",
      );
    },
  },
  {
    id: "S14",
    title: "DM personal memory: DM recall hits, channel recall misses",
    requires: ["slack", "syntheticDm"],
    optional: false,
    timeoutMs: 420_000,
    judged: true,
    run: async (ctx) => {
      const dm = ctx.dm!;
      const forge = ctx.syntheticDm!;
      const pub = ctx.slack!;
      const { userId, teamId } = await ctx.slack!.identity();
      const cheese = factToken("wensleydale");
      const batch = factToken("tasting");
      const teach = `remember: my favourite cheese from ${batch} is ${cheese}`;
      const { ts: teachTs } = await dm.post(teach);
      const taught = await forge.message({ text: teach, userId, teamId, ts: teachTs });
      ctx.gate(taught.status === 200, "synthetic DM (teach) acked 200");
      await dm.awaitAnyReply(teachTs, { timeoutMs: REPLY_WAIT });
      const askDm = `what's my favourite cheese from ${batch}? give its exact name as stored; if you don't know, say so plainly`;
      const { ts: askTs } = await dm.post(askDm);
      const asked = await forge.message({ text: askDm, userId, teamId, ts: askTs });
      ctx.gate(asked.status === 200, "synthetic DM (recall) acked 200");
      const recall = await dm.awaitAnyReply(askTs, { timeoutMs: REPLY_WAIT });
      ctx.gate(
        recall.text.toLowerCase().includes(cheese.toLowerCase()),
        "DM recall HITS from the personal silo (hard gate: taught token present)",
      );
      await ctx.judgePass(
        factuality(cheese, `Does the reply give the taught cheese ${cheese}?`, { mustMatch: [cheese] }),
        recall.text,
        "DM personal-memory factuality",
      );
      const { ts: probeTs } = await pub.post(
        pub.mention(`what's my favourite cheese from ${batch}? if you don't know, say so plainly`),
      );
      const probe = await pub.awaitThreadReply(probeTs, { timeoutMs: REPLY_WAIT });
      ctx.gate(
        !probe.text.toLowerCase().includes(cheese.toLowerCase()),
        "personal-silo fact does NOT surface in the public channel (hard recall-miss gate)",
      );
      await ctx.judgePass(
        closedQA("Does the reply say it doesn't know / decline, rather than reveal a personal fact?", {
          mustNotMatch: [cheese],
        }),
        probe.text,
        "channel probe declines cleanly",
      );
      const cleanup = `forget the stored fact about my favourite cheese from ${batch} — it was test data`;
      const { ts: cleanTs } = await dm.post(cleanup);
      await forge.message({ text: cleanup, userId, teamId, ts: cleanTs }).catch(() => undefined);
    },
  },
  {
    id: "S15",
    title: "Non-admin approval click is refused (card stays pending; admin reject tears down)",
    requires: ["slack", "synthetic", "slackUser2"],
    optional: false,
    timeoutMs: 420_000,
    judged: false,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const synthetic = ctx.synthetic!;
      const user2 = ctx.slackUser2!.userId;
      const { ts: askTs } = await slack.post(slack.mention("raise this channel's spend cap to $20/day"));
      const card = await slack.awaitThreadMessage(
        askTs,
        { timeoutMs: REPLY_WAIT, what: `an approval card (oe_approval buttons) in thread ${askTs}` },
        (msgs) => msgs.find((m) => slack.isBotReply(m) && approveButton(m) !== undefined),
      );
      const btn = approveButton(card)!;
      ctx.gate(btn.pendingId.length > 0 && btn.org.length > 0, "card button carries a real pending id + org");
      const denied = await synthetic.click({
        pendingId: btn.pendingId,
        org: btn.org,
        decision: "approve",
        messageTs: card.ts,
        userId: user2,
      });
      ctx.log(`${denied.label}: NON-admin approve ${btn.pendingId} as ${user2} → ${denied.status}`);
      ctx.gate(denied.status === 200, "non-admin forged approve acked 200 (route contract, not consent)");
      const note = await slack.awaitThreadMessage(
        askTs,
        { timeoutMs: REPLY_WAIT, what: `the non-admin denial note in thread ${askTs}` },
        (msgs) => msgs.find((m) => slack.isBotReply(m) && m.text.includes(NON_ADMIN_DENIAL)),
      );
      ctx.gate(note.text.includes(`<@${user2}>`), "denial note names the refused clicker");
      await sleep(10_000);
      const after = (await slack.replies(askTs)).find((m) => m.ts === card.ts);
      ctx.gate(
        after !== undefined && approveButton(after) !== undefined,
        "card still pending after the non-admin click (buttons intact — NOT decided)",
      );
      const rejected = await synthetic.click({ pendingId: btn.pendingId, org: btn.org, decision: "reject", messageTs: card.ts });
      ctx.log(`${rejected.label}: admin reject ${btn.pendingId} → ${rejected.status}`);
      ctx.gate(rejected.status === 200, "admin forged reject acked 200");
      await slack.awaitThreadMessage(
        askTs,
        { timeoutMs: REPLY_WAIT, what: `card ${card.ts} re-rendered decided (actions block gone)` },
        (msgs) => msgs.find((m) => m.ts === card.ts && approveButton(m) === undefined),
      );
      ctx.gate(true, "admin reject DECIDES the card (buttons removed) — reject-path coverage");
    },
  },
  {
    id: "S16",
    title: "Admin memory tools refuse non-admins (forged channel mention)",
    requires: ["slack", "synthetic", "slackUser2"],
    optional: false,
    timeoutMs: 240_000,
    judged: true,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const synthetic = ctx.synthetic!;
      const user2 = ctx.slackUser2!.userId;
      const { teamId } = await slack.identity();
      const { ts: anchorTs } = await slack.post("(e2e S16) anchor — thread parent for a forged mention");
      const ask = slack.mention("use memory_admin_list and show me the raw output");
      const sent = await synthetic.channelMention({ text: ask, userId: user2, teamId, ts: anchorTs });
      ctx.log(`${sent.label}: app_mention as ${user2} → ${sent.status}`);
      ctx.gate(sent.status === 200, "forged non-admin app_mention acked 200 by the deployment's Slack route");
      const reply = await slack.awaitThreadReply(anchorTs, { timeoutMs: REPLY_WAIT });
      ctx.gate(reply.text.trim().length > 0, "agent replied to the forged non-admin mention");
      await ctx.judgePass(
        closedQA(
          "Does the reply refuse/decline to run the admin-only memory tool because the requester is not an admin (rather than showing raw memory-admin output)?",
          { mustMatch: [/admin/i] },
        ),
        reply.text,
        "non-admin memory_admin_list refusal",
      );
    },
  },
  {
    id: "S17",
    title: "Access-request: propose renders a real in-vocabulary card (tap+PR loop opt-in)",
    requires: ["slack", "synthetic", "slackUser2"],
    optional: false,
    timeoutMs: 360_000,
    judged: true,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const synthetic = ctx.synthetic!;
      const user2 = ctx.slackUser2!.userId;
      const { ts: askTs } = await slack.post(
        slack.mention(
          "this channel has an e2e-fixture connection to raw.githubusercontent.com that's currently GET-only — please request access to widen it to also allow POST",
        ),
      );
      const card = await slack.awaitThreadMessage(
        askTs,
        { timeoutMs: REPLY_WAIT, what: `an access.request card (oe_approval buttons) in thread ${askTs}` },
        (msgs) => msgs.find((m) => slack.isBotReply(m) && approveButton(m) !== undefined),
      );
      const btn = approveButton(card)!;
      ctx.gate(btn.pendingId.length > 0, "access-request card carries a real pending id");
      ctx.gate(btn.org.length > 0, "access-request card carries the org in its button value");
      await ctx.judgePass(
        closedQA("Does the card describe widening a connection to add POST access, naming the e2e-fixture connection?", {
          mustMatch: [/post/i],
        }),
        card.text,
        "access-request card legibility",
      );

      if (process.env.E2E_ACCESS_ALLOW_SEND !== "1") {
        ctx.log("E2E_ACCESS_ALLOW_SEND not set — propose-only run; the card is left to expire on its TTL (no tap, no PR risk)");
        return;
      }

      const sent = await synthetic.click({ pendingId: btn.pendingId, org: btn.org, decision: "approve", messageTs: card.ts, userId: user2 });
      ctx.log(`${sent.label}: non-admin member tap ${btn.pendingId} as ${user2} → ${sent.status}`);
      ctx.gate(sent.status === 200, "member tap acked 200");
      const decided = await slack.awaitThreadMessage(
        askTs,
        { timeoutMs: REPLY_WAIT, what: `card ${card.ts} re-rendered decided (actions block gone)` },
        (msgs) => msgs.find((m) => m.ts === card.ts && approveButton(m) === undefined),
      );
      ctx.gate(true, "non-admin member tap DECIDES the card (buttons removed) — member-policy coverage");

      if (/dry-run/i.test(decided.text)) {
        ctx.log("dry-run confirmed (OE_ACCESS_DRY_RUN=1 on the deployment) — validated, no PR, nothing to tear down");
        return;
      }

      const prMatch = decided.text.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
      ctx.gate(prMatch !== null, "live outcome names a real PR URL (github.com/<repo>/pull/<n>)");
      const [, repo, prNumberStr] = prMatch!;
      ctx.log(`live PR opened: ${repo}#${prNumberStr}`);

      const threadNote = await slack.awaitThreadMessage(
        askTs,
        { timeoutMs: REPLY_WAIT, what: `the requesting-thread "sent" note in thread ${askTs}` },
        (msgs) => msgs.find((m) => slack.isBotReply(m) && m.ts !== card.ts && m.text.includes(prNumberStr)),
      );
      ctx.gate(threadNote.text.toLowerCase().includes("access request sent"), "requesting thread gets the PR-sent note");

      const adminNote = await pollUntil(
        async () => (await slack.history(askTs)).find((m) => slack.isBotReply(m) && m.text.includes(prNumberStr)),
        { timeoutMs: REPLY_WAIT, what: `the admin-channel PR notification (top-level) naming PR #${prNumberStr}` },
      );
      ctx.gate(adminNote.text.toLowerCase().includes("access request"), "admin-channel notification names the access request + PR link");

      try {
        const { execSync } = await import("node:child_process");
        const token = execSync("gh auth token", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
        const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumberStr}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/vnd.github+json" },
          body: JSON.stringify({ state: "closed" }),
        });
        ctx.log(`teardown: closed PR ${repo}#${prNumberStr} via the operator's gh token → ${res.status}`);
      } catch (err) {
        ctx.log(
          `teardown (best-effort) could not close the PR automatically: ${String(err instanceof Error ? err.message : err)} — close ${repo}#${prNumberStr} by hand`,
        );
      }
    },
  },
  {
    id: "S18",
    title: "Access-request negative: a DM ask and an out-of-vocabulary host ask both refuse (no card, either way)",
    requires: ["slack", "syntheticDm"],
    optional: false,
    timeoutMs: 300_000,
    judged: true,
    run: async (ctx) => {
      const dm = ctx.dm!;
      const forge = ctx.syntheticDm!;
      const pub = ctx.slack!;
      const { userId, teamId } = await ctx.slack!.identity();

      const dmAsk = "can you widen this channel's access to add POST to a connection here?";
      const { ts: dmTs } = await dm.post(dmAsk);
      const sentDm = await forge.message({ text: dmAsk, userId, teamId, ts: dmTs });
      ctx.gate(sentDm.status === 200, "synthetic DM ask acked 200");
      const dmReply = await dm.awaitAnyReply(dmTs, { timeoutMs: REPLY_WAIT });
      ctx.gate(dmReply.text.trim().length > 0, "agent replied to the DM access ask");
      ctx.gate(approveButton(dmReply) === undefined, "NO access-request card is posted from a DM (hard gate)");
      await ctx.judgePass(
        closedQA("Does the reply decline to request access from a DM, rather than posting a request card?", {
          mustMatch: [/channel|admin|dm|direct message|from here|can.?t|cannot|unable|not able/i],
        }),
        dmReply.text,
        "DM access-ask refusal quality",
      );

      const { ts: hostTs } = await pub.post(
        pub.mention("can we get access to a brand new host, https://totally-new-example-service.test — please add it as a new connection"),
      );
      const hostReply = await pub.awaitThreadReply(hostTs, { timeoutMs: REPLY_WAIT });
      ctx.gate(approveButton(hostReply) === undefined, "NO access-request card is posted for an out-of-vocabulary host ask (hard gate)");
      await ctx.judgePass(
        closedQA(
          "Does the reply decline to grant/request a brand-new host connection and point to an admin/manual PR instead of offering a request card?",
          { mustMatch: [/admin|manual|hand|can.?t|cannot|unable/i] },
        ),
        hostReply.text,
        "out-of-vocabulary refusal quality",
      );
    },
  },
  {
    id: "S19",
    title: "Admin memory_admin_list via forged mention gets a real listing (S16 already proves the non-admin refusal)",
    requires: ["slack", "synthetic"],
    optional: false,
    timeoutMs: 240_000,
    judged: true,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const synthetic = ctx.synthetic!;
      const { teamId } = await slack.identity();
      const { ts: anchorTs } = await slack.post("(e2e S19) anchor — thread parent for a forged admin mention");
      const ask = slack.mention("use memory_admin_list and tell me every memory silo you can see, and which domains reference each one");
      const admin = synthetic.adminUserId;
      const sent = await synthetic.channelMention({ text: ask, userId: admin, teamId, ts: anchorTs });
      ctx.log(`${sent.label}: admin app_mention as ${admin} → ${sent.status}`);
      ctx.gate(sent.status === 200, "forged admin app_mention acked 200 by the deployment's Slack route");
      const reply = await slack.awaitThreadReply(anchorTs, { timeoutMs: REPLY_WAIT });
      ctx.gate(reply.text.trim().length > 0, "agent replied to the forged admin mention");
      ctx.gate(
        !reply.text.includes(MEMORY_ADMIN_GATE),
        `an admin caller is NOT refused by memory_admin_list's admin gate (hard gate: "${MEMORY_ADMIN_GATE}" is absent)`,
      );
      await ctx.judgePass(
        closedQA("Does the reply actually enumerate memory silos/domains (not a refusal, not an admin-only error)?", {
          mustMatch: [/silo|domain|brain/i],
        }),
        reply.text,
        "admin memory_admin_list listing quality",
      );
    },
  },
  {
    id: "S20",
    title: "Inbound webhook: a signed POST wakes a judged, quoted reply; an unsigned POST is rejected and posts nothing",
    requires: ["slack", "webhook"],
    optional: false,
    timeoutMs: 240_000,
    judged: true,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const hook = ctx.webhook!;
      const note = factToken("hook");
      const { ts: anchorTs } = await slack.post("(e2e S20) webhook run anchor — positive leg");
      const signed = await hook.post({ note });
      ctx.log(`signed webhook POST /webhooks/${hook.hookId} → ${signed.status}`);
      ctx.gate(signed.status === 200, "signed webhook POST is accepted (200)");
      const reply = await pollUntil(
        async () => (await slack.history(anchorTs)).find((m) => slack.isBotReply(m) && m.text.includes(note)),
        { timeoutMs: REPLY_WAIT, what: `a webhook-fired reply quoting "${note}" in channel history after ${anchorTs}` },
      );
      await ctx.judgePass(
        closedQA("Does the reply confirm the webhook fired and quote the note field?", { mustMatch: [note] }),
        reply.text,
        "webhook reply quality",
      );

      const badNote = factToken("hookbad");
      const { ts: badAnchorTs } = await slack.post("(e2e S20) webhook run anchor — negative leg");
      const unsigned = await hook.post({ note: badNote }, { signed: false });
      ctx.log(`unsigned webhook POST /webhooks/${hook.hookId} → ${unsigned.status}`);
      ctx.gate(unsigned.status === 401, "an unsigned webhook POST is rejected (401)");
      await sleep(20_000);
      const stray = (await slack.history(badAnchorTs)).filter((m) => slack.isBotReply(m) && m.text.includes(badNote));
      ctx.gate(stray.length === 0, "an unsigned webhook POST produces NO channel post (hard gate)");
    },
  },
  {
    id: "S21",
    title: "React tool: an explicit ask gets a real emoji reaction (not the code-driven 👀/🛑 status pair)",
    requires: ["slack"],
    optional: false,
    timeoutMs: 180_000,
    judged: false,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const { ts: askTs } = await slack.post(
        slack.mention('react to this message with the "raised_hands" emoji to confirm you got it — a reaction alone is enough, no need to reply with text.'),
      );
      const reactions = await pollUntil(
        async () => {
          const names = await slack.reactions(askTs);
          return names.includes("raised_hands") ? names : undefined;
        },
        { timeoutMs: REPLY_WAIT, what: `a "raised_hands" reaction on ${askTs} (react tool call)` },
      );
      ctx.gate(reactions.includes("raised_hands"), 'the react tool added the "raised_hands" reaction (hard gate)');
    },
  },
  {
    id: "S22",
    title: "no_reply on off-topic chatter, then a REAL follow-up proves the thread wasn't left broken",
    requires: ["slack"],
    optional: false,
    timeoutMs: 300_000,
    judged: false,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const { ts: rootTs } = await slack.post(slack.mention("what's 6*7? reply with just the number"));
      await slack.awaitThreadReply(rootTs, { timeoutMs: REPLY_WAIT });
      const { ts: asideTs } = await slack.post("lol I can't believe he said that in standup \u{1F602}", rootTs);
      const during = await slack.collectRepliesDuring(rootTs, asideTs, SILENCE_WINDOW);
      ctx.gate(during.length === 0, `no bot message during the ${SILENCE_WINDOW / 1000}s silence window (off-topic aside)`);
      const { ts: followTs } = await slack.post("ok back to it — what's 100 minus 12?", rootTs);
      const follow = await slack.awaitThreadReply(rootTs, { afterTs: followTs, timeoutMs: REPLY_WAIT });
      ctx.gate(follow.text.includes("88"), "the thread still answers correctly after a no_reply turn (hard gate: 88)");
    },
  },
  {
    id: "S23",
    title: "One-shot routine: create_routine(\"once\") acks now; the live fire is opt-in (dispatcher ticks every ~10 min)",
    requires: ["slack"],
    optional: false,
    timeoutMs: 900_000,
    judged: true,
    run: async (ctx) => {
      const slack = ctx.slack!;
      const note = factToken("routine");
      const { ts: askTs } = await slack.post(
        slack.mention(
          `create a ONE-SHOT routine (create_routine, trigger "at" a couple of minutes from now — not a recurring cron/interval) that checks back here and posts exactly the word ${note}. Confirm you've scheduled it.`,
        ),
      );
      const ack = await slack.awaitThreadReply(askTs, { timeoutMs: REPLY_WAIT });
      await ctx.judgePass(
        closedQA("Does the reply confirm a ONE-TIME check-in was scheduled (not a recurring/cron schedule, not a refusal)?", {
          mustMatch: [/schedul|check.?in|check back|remind|routine/i],
        }),
        ack.text,
        "one-shot routine creation ack",
      );
      if (process.env.E2E_ROUTINES_ALLOW_WAIT !== "1") {
        ctx.log(
          "E2E_ROUTINES_ALLOW_WAIT not set — creation-ack-only run; the live fire (needs a ~10min dispatcher tick) is skipped by default, see AUDIT.md",
        );
        return;
      }
      const fired = await slack.awaitThreadMessage(
        askTs,
        { timeoutMs: 720_000, what: `the one-shot routine's fired post quoting "${note}" in thread ${askTs}` },
        (msgs) => msgs.find((m) => slack.isBotReply(m) && m.ts !== ack.ts && m.text.includes(note)),
      );
      ctx.gate(fired.text.includes(note), `the one-shot routine actually fired and posted "${note}" (hard gate)`);
    },
  },
  {
    id: "S24",
    title: "Notion connector: search/read via the bound connector (optional — not provisioned on any deployment yet)",
    requires: ["slack", "notion"],
    optional: true,
    timeoutMs: 180_000,
    judged: true,
    run: async (ctx) => {
      const notion = ctx.notion!;
      const query = ctx.notionQuery ?? "team handbook";
      const { ts: askTs } = await notion.post(
        notion.mention(`search Notion for "${query}" and tell me what you find — a page title plus a short summary is enough. If nothing matches, just say so plainly; don't guess.`),
      );
      const reply = await notion.awaitThreadReply(askTs, { timeoutMs: REPLY_WAIT });
      await ctx.judgePass(
        closedQA(
          "Is the reply a sane response to a Notion search request — either naming a real-sounding page/summary, " +
            "or an honest 'nothing found' — with no error, exception, or tool-failure text?",
          { mustNotMatch: [/error|exception|traceback/i] },
        ),
        reply.text,
        "Notion search reply is sane (found-or-honest-miss, never an error)",
      );
    },
  },
  {
    id: "ST1",
    title: "Teams channel @mention wake + relevant reply",
    requires: ["teams"],
    optional: false,
    timeoutMs: REPLY_WAIT * 2,
    judged: true,
    run: async (ctx) => {
      const teams = ctx.teams!;
      const driven = await teams.postMention("summarize what this channel is for in one line");
      const reply = await teams.awaitReply(driven.id, { timeoutMs: REPLY_WAIT });
      ctx.gate(reply.text.trim().length > 0, "bot replied in the message's reply chain (Graph-posted mention woke the bot end-to-end)");
      await ctx.judgePass(
        closedQA("Is the reply a relevant, non-empty one-line-ish response (not an error)?", { mustMatch: [/.{10,}/] }),
        reply.text,
        "ST1 relevance",
      );
    },
  },
];

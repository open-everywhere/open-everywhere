import type { SlackDriver, SlackMessage } from "./slack-driver.js";
import type { SyntheticSlack } from "./synthetic.js";
import { APPROVAL_PREFIX } from "./synthetic.js";
import { pollUntil } from "./poll.js";

export function factToken(stem: string): string {
  return `${stem}-${Date.now() % 100_000}`;
}

export function approveButton(m: SlackMessage): { pendingId: string; org: string } | undefined {
  const prefix = `${APPROVAL_PREFIX}approve:`;
  const btn = m.actions?.find((a) => a.actionId.startsWith(prefix));
  if (!btn) return undefined;
  return { pendingId: btn.actionId.slice(prefix.length), org: btn.value ?? "" };
}

export type GateFn = (cond: boolean, label: string) => void;

export function legGate(gate: GateFn, leg: string): GateFn {
  return (cond, label) => gate(cond, `${leg}: ${label}`);
}

export async function postAwait(
  slack: SlackDriver,
  ask: string,
  opts: { timeoutMs: number },
): Promise<{ rootTs: string; reply: SlackMessage }> {
  const { ts: rootTs } = await slack.post(slack.mention(ask));
  const reply = await slack.awaitThreadReply(rootTs, { timeoutMs: opts.timeoutMs });
  return { rootTs, reply };
}

export async function collectSilence(
  slack: SlackDriver,
  rootTs: string,
  afterTs: string,
  windowMs: number,
): Promise<readonly SlackMessage[]> {
  return slack.collectRepliesDuring(rootTs, afterTs, windowMs);
}

export async function awaitCard(slack: SlackDriver, threadTs: string, timeoutMs: number): Promise<SlackMessage> {
  return slack.awaitThreadMessage(
    threadTs,
    { timeoutMs, what: `an approval card (oe_approval buttons) in thread ${threadTs}` },
    (msgs) => msgs.find((m) => slack.isBotReply(m) && approveButton(m) !== undefined),
  );
}

export async function awaitDecided(slack: SlackDriver, threadTs: string, cardTs: string, timeoutMs: number): Promise<SlackMessage> {
  return slack.awaitThreadMessage(
    threadTs,
    { timeoutMs, what: `card ${cardTs} re-rendered decided (actions block gone)` },
    (msgs) => msgs.find((m) => m.ts === cardTs && approveButton(m) === undefined),
  );
}

export async function driveDecide(args: {
  slack: SlackDriver;
  synthetic: SyntheticSlack;
  gate: GateFn;
  log: (line: string) => void;
  ask: string;
  leg: string;
  decision?: "approve" | "reject";
  timeoutMs: number;
}): Promise<SlackMessage> {
  const { slack, synthetic, ask, leg, timeoutMs } = args;
  const gate = legGate(args.gate, leg);
  const decision = args.decision ?? "approve";
  const { ts: askTs } = await slack.post(slack.mention(ask));
  const card = await awaitCard(slack, askTs, timeoutMs);
  const btn = approveButton(card)!;
  gate(btn.pendingId.length > 0, "card button carries a real pending id in its action_id");
  gate(btn.org.length > 0, "card button carries the org in its value (flow.ts needs it pre-lookup)");
  const { teamId } = await slack.identity();
  const clicked = await synthetic.click({ pendingId: btn.pendingId, org: btn.org, decision, messageTs: card.ts, channelId: slack.channelId, teamId });
  args.log(`${clicked.label}: ${decision} ${btn.pendingId} (org "${btn.org}") → ${clicked.status}`);
  gate(clicked.status === 200, `forged ${decision} click acked 200`);
  await awaitDecided(slack, askTs, card.ts, timeoutMs);
  gate(true, `card DECIDED — buttons removed by the deployment's chat.update (hard gate)`);
  return card;
}

export interface PrReadback {
  getPr(prNumber: number): Promise<{ readonly head: string; readonly base: string } | undefined>;
  prContainsToken(prNumber: number, token: string): Promise<boolean>;
}

export function classifyPrMiss(replyText: string): "grant-refused" | "errored" | "no-tool" {
  if (/not granted to this channel|grant it via a bundle|not in the granted/i.test(replyText)) return "grant-refused";
  if (/(push|staging|commit|checkout|clone|git)[^.]{0,48}(fail|error)|could ?n.?t (?:push|open|create|stage|commit|clone|check ?out)/i.test(replyText))
    return "errored";
  return "no-tool";
}

export type PrDriveResult =
  | { readonly published: true; readonly card: SlackMessage; readonly prNumber: number; readonly head: string }
  | { readonly published: false; readonly miss: "grant-refused" | "errored" | "no-tool"; readonly reason: string };

export async function drivePrOpen(args: {
  slack: SlackDriver;
  synthetic: SyntheticSlack;
  gate: GateFn;
  log: (line: string) => void;
  pr: PrReadback;
  ask: string;
  token: string;
  base: string;
  leg: string;
  timeoutMs: number;
  beforeApprove?: (card: SlackMessage) => void | Promise<void>;
  decision?: "approve" | "approve_session";
}): Promise<PrDriveResult> {
  const { slack, synthetic, pr, ask, token, base, timeoutMs } = args;
  const decision = args.decision ?? "approve";
  const gate = legGate(args.gate, args.leg);
  const { ts: askTs } = await slack.post(slack.mention(ask));
  const firstReply = await slack.awaitThreadReply(askTs, { timeoutMs });
  let card = approveButton(firstReply) !== undefined ? firstReply : await awaitCard(slack, askTs, timeoutMs).catch(() => undefined);
  if (!card) {
    const reason = firstReply.text.replace(/\s+/g, " ").trim().slice(0, 240);
    return { published: false, miss: classifyPrMiss(firstReply.text), reason };
  }

  const btn = approveButton(card)!;
  gate(btn.pendingId.length > 0, "pr.open card carries a real pending id in its action_id");
  gate(btn.org.length > 0, "pr.open card carries the org in its value (flow.ts needs it pre-lookup)");
  await args.beforeApprove?.(card);

  const { teamId } = await slack.identity();
  const clicked = await synthetic.click({ pendingId: btn.pendingId, org: btn.org, decision, messageTs: card.ts, channelId: slack.channelId, teamId });
  args.log(`${clicked.label}: ${decision} pr.open ${btn.pendingId} (org "${btn.org}") → ${clicked.status}`);
  gate(clicked.status === 200, `forged admin ${decision} click acked 200`);
  const decided = await awaitDecided(slack, askTs, card.ts, timeoutMs);

  const urlMatch = decided.text.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  gate(urlMatch !== null, `decided card names a published PR URL (execute succeeded) — got: "${decided.text.replace(/\s+/g, " ").trim().slice(0, 240)}"`);
  const prNumber = Number.parseInt(urlMatch![2], 10);
  args.log(`published PR ${urlMatch![1]}#${prNumber}`);

  const details = await pollUntil(async () => args.pr.getPr(prNumber), { timeoutMs, what: `the published PR #${prNumber} readable via the GitHub API` });
  gate(details.base === base, `the published PR targets the "${base}" base branch (got "${details.base}")`);
  const hasToken = await pr.prContainsToken(prNumber, token);
  gate(hasToken, `the published PR's diff carries the run token "${token}" (the agent really made the change)`);
  return { published: true, card, prNumber, head: details.head };
}

import type { SlackDriver, SlackMessage } from "./slack-driver.js";
import type { SyntheticSlack } from "./synthetic.js";
import { APPROVAL_PREFIX } from "./synthetic.js";

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
  const clicked = await synthetic.click({ pendingId: btn.pendingId, org: btn.org, decision, messageTs: card.ts, channelId: slack.channelId });
  args.log(`${clicked.label}: ${decision} ${btn.pendingId} (org "${btn.org}") → ${clicked.status}`);
  gate(clicked.status === 200, `forged ${decision} click acked 200`);
  await awaitDecided(slack, askTs, card.ts, timeoutMs);
  gate(true, `card DECIDED — buttons removed by the deployment's chat.update (hard gate)`);
  return card;
}

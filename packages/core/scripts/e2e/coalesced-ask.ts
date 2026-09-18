import { backoffDelayMs, sleep } from "./poll.js";
import { seatFenceStep, tsAfter, type SeatFenceResult, type SeatFenceVerdict, type SeatFenceState, type SlackMessage } from "./slack-driver.js";

export const ADMIN_UNVERIFIED_MARKER = "needs to know who asked";

export function isAdminStandingUnverified(text: string): boolean {
  return text.toLowerCase().includes(ADMIN_UNVERIFIED_MARKER);
}

export function replyExcerpt(reply: string, max = 320): string {
  const flat = reply.replace(/\s+/gu, " ").trim();
  if (!flat) return "<empty>";
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export interface CoalescedAskOutcome {
  readonly text: string;
  readonly resolved: boolean;
  readonly attempts: number;
  readonly refusals: readonly string[];
}

export async function askPastCoalescedRefusal(opts: {
  readonly drive: (attempt: number) => Promise<string>;
  readonly maxAttempts?: number;
  readonly onRefusal?: (attempt: number, text: string) => Promise<void> | void;
}): Promise<CoalescedAskOutcome> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  const refusals: string[] = [];
  let text = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    text = await opts.drive(attempt);
    if (!isAdminStandingUnverified(text)) return { text, resolved: true, attempts: attempt, refusals };
    refusals.push(text);
    if (attempt < maxAttempts) await opts.onRefusal?.(attempt, text);
  }
  return { text, resolved: false, attempts: maxAttempts, refusals };
}

export interface ChannelSeatProbe {
  latest(limit?: number): Promise<readonly SlackMessage[]>;
  replies(rootTs: string): Promise<readonly SlackMessage[]>;
  isBotReply(m: SlackMessage): boolean;
}

export function newestSeatMessage(
  topLevel: readonly SlackMessage[],
  threadMsgs: readonly SlackMessage[],
): SlackMessage | undefined {
  let newest: SlackMessage | undefined;
  for (const m of [...topLevel, ...threadMsgs]) {
    if (newest === undefined || tsAfter(m.ts, newest.ts)) newest = m;
  }
  return newest;
}

export async function awaitChannelSeatQuiet(
  probe: ChannelSeatProbe,
  opts: {
    readonly threadTs: string;
    readonly quietMs: number;
    readonly timeoutMs: number;
    readonly owedGraceMs: number;
    readonly isInterim?: (m: SlackMessage) => boolean;
    readonly now?: () => number;
    readonly wait?: (ms: number) => Promise<void>;
  },
): Promise<SeatFenceResult> {
  const now = opts.now ?? Date.now;
  const wait = opts.wait ?? sleep;
  const started = now();
  let state: SeatFenceState | undefined;
  let verdict: SeatFenceVerdict = "settling";
  let abandoned = false;
  for (let attempt = 0; ; attempt++) {
    const [topLevel, threadMsgs] = await Promise.all([probe.latest(1), probe.replies(opts.threadTs)]);
    const newest = newestSeatMessage(topLevel, threadMsgs);
    const step = seatFenceStep({
      prev: state,
      newest: newest ? { ts: newest.ts, settles: probe.isBotReply(newest) && !(opts.isInterim?.(newest) ?? false) } : undefined,
      nowMs: now(),
      quietMs: opts.quietMs,
      owedGraceMs: opts.owedGraceMs,
    });
    state = step.state;
    verdict = step.verdict;
    abandoned = step.abandoned;
    const elapsed = now() - started;
    if (verdict === "quiet") return { quiet: true, verdict, anchorTs: state.newestTs, abandoned, waitedMs: elapsed };
    if (elapsed >= opts.timeoutMs) return { quiet: false, verdict, anchorTs: state.newestTs, abandoned, waitedMs: elapsed };
    await wait(Math.min(backoffDelayMs(attempt), opts.timeoutMs - elapsed));
  }
}

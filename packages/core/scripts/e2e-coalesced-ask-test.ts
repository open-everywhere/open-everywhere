import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ADMIN_UNVERIFIED_MARKER,
  askPastCoalescedRefusal,
  awaitChannelSeatQuiet,
  isAdminStandingUnverified,
  newestSeatMessage,
  replyExcerpt,
  type ChannelSeatProbe,
} from "./e2e/coalesced-ask.js";
import type { SlackMessage } from "./e2e/slack-driver.js";

let n = 0;
const eq = <T,>(actual: T, expected: T, label: string): void => {
  assert.deepEqual(actual, expected, label);
  n++;
};
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const REFUSAL =
  "this action needs to know who asked, and this turn cannot say: the wake coalesced several askers. " +
  "Admin standing is checked against the person who asked, never against whoever else this session was serving, so it is refused rather than guessed.";
const LISTING = "Here are the memory silos this room can see: `e2e-ambient-brain` (domain `e2e-unified`). The org-wide map answers in a DM.";

const adminStandingSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "access", "admin-standing.ts"), "utf8");
ok(
  adminStandingSource.includes(ADMIN_UNVERIFIED_MARKER),
  `🔴 §1a: \`agent/access/admin-standing.ts\` still builds its refusal around "${ADMIN_UNVERIFIED_MARKER}" — if this reds, the PRODUCT's wording moved and the fixture has gone blind to a refusal it must recognise`,
);
ok(
  adminStandingSource.includes(REFUSAL.slice(0, REFUSAL.indexOf(":"))),
  "🔴 §1a: …and the whole opening clause this file copies is still the product's, not just the marker inside it",
);
ok(isAdminStandingUnverified(REFUSAL), "🔴 §1: the real OPE-673 refusal is recognised — if this reds, the product's wording moved and the fixture is blind to it");
ok(REFUSAL.includes(ADMIN_UNVERIFIED_MARKER), "§1: …and the marker is a literal substring of it, not a paraphrase");
ok(!isAdminStandingUnverified(LISTING), "🔴 §1 NEGATIVE CONTROL: a real listing is NOT read as a refusal — a marker that matched everything would make the re-ask unreachable");
ok(!isAdminStandingUnverified("requires an org admin"), "§1: the tool's OWN not-admin gate is a different refusal, and is NOT retried — only the coalesced-turn one is a timing artefact");
ok(isAdminStandingUnverified(REFUSAL.toUpperCase()), "§1: the match is case-insensitive, so a reply the surface re-cased still resolves");

{
  const driven: number[] = [];
  const refused: number[] = [];
  const replies = [REFUSAL, LISTING];
  const outcome = await askPastCoalescedRefusal({
    drive: async (attempt) => {
      driven.push(attempt);
      return replies[attempt - 1] ?? "";
    },
    onRefusal: (attempt) => {
      refused.push(attempt);
    },
  });
  eq(outcome.resolved, true, "🔴 §2a: a refusal followed by a listing RESOLVES — the coalesced turn cost the first ask, not the leg");
  eq(outcome.text, LISTING, "§2a: …and the outcome carries the LISTING, which is what the judge grades");
  eq(outcome.attempts, 2, "§2a: …after exactly two attempts");
  eq(driven, [1, 2], "§2a: …the second of them driven with attempt 2, so the caller can anchor a FRESH thread");
  eq([...outcome.refusals], [REFUSAL], "§2a: …and the refusal it stepped past is still reported, so a passing leg can say it re-asked");
  eq(refused, [1], "🔴 §2a: `onRefusal` ran BETWEEN the attempts — that is where the caller re-fences the seat, and a re-ask driven unfenced proves nothing");
}
{
  const outcome = await askPastCoalescedRefusal({ drive: async () => REFUSAL });
  eq(outcome.resolved, false, "🔴 §2b: a refusal that SURVIVES the re-ask does NOT resolve — the retry may never green a real verdict");
  eq(outcome.attempts, 2, "§2b: …and it stopped at two attempts");
  eq(outcome.refusals.length, 2, "§2b: …with both refusals reported, so the red can quote the one that survived");
  eq(outcome.text, REFUSAL, "§2b: …and the outcome carries the last refusal, which the gate then quotes");
}
{
  let drives = 0;
  const first = await askPastCoalescedRefusal({
    drive: async () => {
      drives++;
      return LISTING;
    },
  });
  eq(first.attempts, 1, "🔴 §2c: an ask that is answered the FIRST time is never re-asked");
  eq(drives, 1, "§2c: …and the seat was driven exactly once — a helper that always asked twice would double every leg's cost");
  eq([...first.refusals], [], "§2c: …with no refusal to report");

  drives = 0;
  await askPastCoalescedRefusal({
    drive: async () => {
      drives++;
      return REFUSAL;
    },
  });
  eq(drives, 2, "🔴 §2c: a refusing seat is driven exactly TWICE — the cap is what stops a fixture asking until it likes the answer");

  drives = 0;
  const capped = await askPastCoalescedRefusal({
    drive: async () => {
      drives++;
      return REFUSAL;
    },
    maxAttempts: 1,
  });
  eq(drives, 1, "§2c: `maxAttempts: 1` drives once…");
  eq(capped.resolved, false, "§2c: …and still reports the refusal rather than swallowing it");
}

eq(replyExcerpt("   "), "<empty>", "🔴 §3: a blank reply says so — the live-run report's real failure was a red that carried NO reply at all");
eq(replyExcerpt("a\n\n  b\tc"), "a b c", "§3: the excerpt is one whitespace-collapsed line, so it survives a log");
eq(replyExcerpt("abcdef", 3), "abc…", "🔴 §3: …truncated at the bound, with the ellipsis marking that it was cut");
eq(replyExcerpt("abc", 3), "abc", "§3 NEGATIVE CONTROL: a reply AT the bound is not truncated and gains no ellipsis");

const BOT = "UBOT";
const HUMAN = "UHUMAN";
const msg = (ts: number, userId: string, text = "x"): SlackMessage => ({ ts: `${ts}.000000`, userId, text });
const isBotReply = (m: SlackMessage): boolean => m.userId === BOT;

function fixedProbe(topLevel: readonly SlackMessage[], threadMsgs: readonly SlackMessage[]): ChannelSeatProbe {
  return {
    latest: async () => topLevel,
    replies: async () => threadMsgs,
    isBotReply,
  };
}

{
  const anchor = msg(1000, HUMAN, "(e2e J3/S16) anchor");
  const answer = msg(1010, BOT, "the requester is not an org admin");
  eq(newestSeatMessage([anchor], [anchor, answer])?.ts, answer.ts, "🔴 §4a: the merged read picks the THREAD reply over the older top-level anchor");
  eq(newestSeatMessage([], [])?.ts, undefined, "§4a: an empty conversation has no newest message — the fence then treats the seat as settled");
  eq(newestSeatMessage([answer], [])?.ts, answer.ts, "§4a: a top-level-only conversation still reads");

  const clock = { ms: 1_020_000 };
  const fence = await awaitChannelSeatQuiet(fixedProbe([anchor], [anchor, answer]), {
    threadTs: anchor.ts,
    quietMs: 20_000,
    timeoutMs: 180_000,
    owedGraceMs: 420_000,
    now: () => clock.ms,
    wait: async (ms) => {
      clock.ms += ms;
    },
  });
  eq(fence.quiet, true, "🔴 §4a: the fence goes QUIET on a seat whose only answer is a thread reply — the case a history-only fence cannot see");
  eq(fence.anchorTs, answer.ts, "§4a: …anchored on the bot's reply");
  eq(fence.abandoned, false, "§4a: …and nothing was abandoned — the seat answered");
  ok(fence.waitedMs >= 20_000, "🔴 §4a: …after OBSERVING the seat hold still for the whole quiet window, never on one reading");
}
{
  const anchor = msg(1000, HUMAN, "(e2e S-SIDE-PANEL) anchor");
  const answer = msg(1007, BOT, "ok");
  const run = async (isInterim: (m: SlackMessage) => boolean | Promise<boolean>) => {
    const clock = { ms: 1_010_000 };
    return awaitChannelSeatQuiet(fixedProbe([anchor], [anchor, answer]), {
      threadTs: anchor.ts,
      quietMs: 20_000,
      timeoutMs: 120_000,
      owedGraceMs: 420_000,
      isInterim,
      now: () => clock.ms,
      wait: async (ms) => {
        clock.ms += ms;
      },
    });
  };
  const exact = await run(async () => false);
  eq(exact.quiet, true, "🔴 §4a': an async interim test that says done:true settles the seat on \"ok\"");
  const guessed = await run(async () => true);
  eq(guessed.verdict, "owed", "§4a': NEGATIVE CONTROL — the same answer held interim stays owed, so the awaited value decides");
}
{
  const anchor = msg(1000, HUMAN, "(e2e J3/S16) anchor");
  const answer = msg(1010, BOT, "the requester is not an org admin");
  const clock = { ms: 1_020_000 };
  const fence = await awaitChannelSeatQuiet(fixedProbe([anchor], []), {
    threadTs: anchor.ts,
    quietMs: 20_000,
    timeoutMs: 180_000,
    owedGraceMs: 420_000,
    now: () => clock.ms,
    wait: async (ms) => {
      clock.ms += ms;
    },
  });
  eq(fence.quiet, false, "🔴 §4b: a HISTORY-ONLY read of the same seat never settles — this is why J3 could not reuse `awaitSeatQuiet`");
  eq(fence.verdict, "owed", "§4b: …and it reads the fixture's own anchor as a turn still owed");
  eq(newestSeatMessage([anchor], [])?.ts, anchor.ts, "🔴 §4b: …because WITHOUT the thread read the newest message is the human anchor…");
  eq(newestSeatMessage([anchor], [anchor, answer])?.ts, answer.ts, "🔴 §4b: …and WITH it the very same conversation yields the bot's answer instead");
}
{
  const anchor = msg(1000, HUMAN);
  const clock = { ms: 1_020_000 };
  const probe: ChannelSeatProbe = {
    latest: async () => [anchor],
    replies: async () => [anchor, msg(Math.floor(clock.ms / 1000), BOT)],
    isBotReply,
  };
  const fence = await awaitChannelSeatQuiet(probe, {
    threadTs: anchor.ts,
    quietMs: 20_000,
    timeoutMs: 120_000,
    owedGraceMs: 420_000,
    now: () => clock.ms,
    wait: async (ms) => {
      clock.ms += ms;
    },
  });
  eq(fence.quiet, false, "🔴 §4c: a seat still POSTING never goes quiet, however long the fence waits — leg 5 must not drive it");
  eq(fence.verdict, "settling", "§4c: …and the verdict names WHY, so the red says the seat was busy rather than silent");
  ok(fence.waitedMs >= 120_000, "§4c: …after spending its whole budget");
}
{
  const stale = msg(1000, HUMAN);
  const clock = { ms: 2_000_000 };
  const fence = await awaitChannelSeatQuiet(fixedProbe([stale], [stale]), {
    threadTs: stale.ts,
    quietMs: 20_000,
    timeoutMs: 180_000,
    owedGraceMs: 420_000,
    now: () => clock.ms,
    wait: async (ms) => {
      clock.ms += ms;
    },
  });
  eq(fence.quiet, true, "§4d: a message the seat DECLINED to answer stops blocking once it is past the owed grace");
  eq(fence.abandoned, true, "🔴 §4d: …and the result SAYS it was abandoned, so the leg's seat line reports it instead of swallowing it");
}

console.log(`ok — e2e coalesced-ask (OPE-1889): ${n} assertions`);

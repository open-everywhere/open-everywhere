import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-seat-read-")), "ops.sqlite3");

import {
  SEAT_RECOVERY_READ_BUDGET,
  SeatReadBudgetError,
  assertSeatReadBudget,
  noteSeatRead,
  resetSeatReadBudget,
  seatReadBudgetRefusal,
} from "../agent/access/seat-read-budget.js";
import { setLeanSeatWake } from "../agent/access/lean-seat-state.js";
import { SEAT_READ_INLINE_CAP, capReadForInline, spoolNote, spoolPathFor, trimToInlineCap } from "../agent/channels/read-spool.js";
import { renderChannelBody, renderThreadBody, type ChannelReadOutput, type ReadOutputLine, type ThreadReadOutput } from "../agent/channels/channel-read.js";
import type { BindableContext } from "../agent/identity/binding.js";

let passed = 0;
function ok(cond: unknown, what: string): void {
  assert.ok(cond, `FAILED: ${what}`);
  passed++;
}
function eq(actual: unknown, expected: unknown, what: string): void {
  assert.deepEqual(actual, expected, `FAILED: ${what}`);
  passed++;
}

ok(SEAT_RECOVERY_READ_BUDGET >= 2, `the budget leaves room for a real recovery sequence (${SEAT_RECOVERY_READ_BUDGET})`);
for (let used = 1; used <= SEAT_RECOVERY_READ_BUDGET; used++) {
  ok(seatReadBudgetRefusal("read_channel", used) === null, `read ${used} of ${SEAT_RECOVERY_READ_BUDGET} is permitted`);
}
const overText = seatReadBudgetRefusal("read_channel", SEAT_RECOVERY_READ_BUDGET + 1);
ok(overText !== null, `read ${SEAT_RECOVERY_READ_BUDGET + 1} is REFUSED — the bound is real, not advisory`);
ok(overText!.includes("read_channel"), "the refusal names the verb it refused");
ok(overText!.includes("delegate a worker"), "…and points at the worker, which reads without this limit");
ok(overText!.includes("could not find it"), "…and sanctions the honest answer, so silence is not the only alternative");
ok(overText!.includes("Do not guess"), "…and forbids the guess, which is the defect this whole ticket exists for");
ok(seatReadBudgetRefusal("read_channel", 0) === null, "a `used` of 0 (no session context) is NEVER refused");
ok(seatReadBudgetRefusal("read_thread", SEAT_RECOVERY_READ_BUDGET + 1)!.includes("read_thread"), "the refusal names read_thread when read_thread was the call");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};
function inSession<T>(fn: () => T): T {
  return contextStorage.run(new ContextContainer(), fn);
}

ok(noteSeatRead() === 0, "outside an eve context the counter stays 0");
assertSeatReadBudget("read_channel");
ok(true, "…and the guard never throws outside an eve context");

inSession(() => {
  ok(noteSeatRead() === 1, "inside a container the counter starts at 1");
  ok(noteSeatRead() === 2, "…and accumulates");
  resetSeatReadBudget();
  ok(noteSeatRead() === 1, "resetSeatReadBudget clears it — the per-turn scope hooks/loop-breaker.ts provides");
});

inSession(() => {
  setLeanSeatWake(false);
  for (let i = 0; i < SEAT_RECOVERY_READ_BUDGET + 5; i++) assertSeatReadBudget("read_channel");
  ok(true, `a FULL wake made ${SEAT_RECOVERY_READ_BUDGET + 5} reads with no refusal — workers and fires are not bounded`);
});

inSession(() => {
  setLeanSeatWake(true);
  for (let i = 1; i <= SEAT_RECOVERY_READ_BUDGET; i++) assertSeatReadBudget("read_channel");
  ok(true, `a LEAN wake made its ${SEAT_RECOVERY_READ_BUDGET} permitted reads`);
  let thrown: unknown;
  try {
    assertSeatReadBudget("read_channel");
  } catch (err) {
    thrown = err;
  }
  ok(thrown instanceof SeatReadBudgetError, "…and the next one throws SeatReadBudgetError");
  ok(String((thrown as Error).message).includes("delegate a worker"), "…carrying the instructive refusal, not a bare error");
  resetSeatReadBudget();
  assertSeatReadBudget("read_channel");
  ok(true, "after the per-turn reset the LEAN seat may read again — a new turn starts with a full budget");
});

inSession(() => {
  setLeanSeatWake(true);
  for (let i = 1; i <= SEAT_RECOVERY_READ_BUDGET; i++) assertSeatReadBudget(i % 2 === 0 ? "read_channel" : "read_thread");
  let shared = false;
  try {
    assertSeatReadBudget("read_thread");
  } catch {
    shared = true;
  }
  ok(shared, "read_channel and read_thread draw on ONE per-turn budget");
});

const line = (i: number, chars: number): ReadOutputLine => ({ author: `U${i}`, ts: `170000000${i}.0001`, text: "x".repeat(chars) });

const small = [line(1, 10), line(2, 10)];
const smallTrim = trimToInlineCap(small, SEAT_READ_INLINE_CAP);
eq(smallTrim.shown.length, 2, "an under-cap page keeps every message");
ok(smallTrim.clamped === false, "…and nothing is clamped");

const many = Array.from({ length: 20 }, (_, i) => line(i, 100));
const manyTrim = trimToInlineCap(many, 500);
ok(manyTrim.shown.length > 0 && manyTrim.shown.length < 20, `an over-cap page is trimmed (${manyTrim.shown.length} of 20 shown)`);
eq(manyTrim.shown[0], many[0], "…and the OLDEST message is the one kept, not the newest");
ok(manyTrim.shown.every((m, i) => m === many[i]), "…the kept messages are a leading prefix, in order");

const oneHuge = [line(1, 5_000)];
const hugeTrim = trimToInlineCap(oneHuge, 200);
eq(hugeTrim.shown.length, 1, "a single oversize message is kept rather than dropped");
ok(hugeTrim.clamped === true, "…and reported as clamped, so the caller spools");
ok(hugeTrim.shown[0]!.text.length < 5_000, "…with its text cut to the cap");

const withPath = spoolNote("channel", { path: "reads/channel-ch_x-1.txt", shown: 3, total: 40 });
ok(withPath.includes("reads/channel-ch_x-1.txt") && withPath.includes("40") && withPath.includes("3"), "the spool note names the file and both counts");
ok(withPath.includes("smaller `limit`"), "…and teaches the retry with a smaller limit");
const noPath = spoolNote("channel", { shown: 3, total: 40 });
ok(!noPath.includes("reads/"), "a spool that could not be written points at NO file");
ok(noPath.includes("not readable anywhere"), "…and says so plainly rather than implying the rest exists somewhere");

const p1 = spoolPathFor("channel", "ch_../../etc/passwd", "body one");
ok(!p1.includes(".."), "a spool path never carries a traversal segment out of the reads dir");
ok(p1.startsWith("reads/"), "…and always lands under reads/");
ok(spoolPathFor("channel", "ch_a", "body one") !== spoolPathFor("channel", "ch_a", "body two"), "two different pages land on two different files");
eq(spoolPathFor("channel", "ch_a", "body one"), spoolPathFor("channel", "ch_a", "body one"), "…and the same page lands on the same file");

function outputOf(messages: ReadOutputLine[]): ChannelReadOutput {
  return { platform: "discord", channel: "C0FIXTURE", count: messages.length, messages };
}

const written: { path: string; content: string }[] = [];
const sandboxCtx = { getSandbox: async () => ({ writeTextFile: async (i: { path: string; content: string }) => void written.push(i) }) } as unknown as BindableContext;
const bigOut = outputOf(Array.from({ length: 30 }, (_, i) => line(i, 800)));
const fullBody = renderChannelBody(bigOut);
const capped = await capReadForInline(sandboxCtx, bigOut, "channel", "ch_fixture", () => fullBody);
ok(capped.spool !== undefined, "an over-cap read carries a spool descriptor");
eq(capped.spool!.total, 30, "…naming the FETCHED count");
ok(capped.messages.length === capped.spool!.shown && capped.messages.length < 30, `…and only the shown messages ride inline (${capped.messages.length} of 30)`);
eq(written.length, 1, "exactly one file was written");
eq(written[0]!.content, fullBody, "…and it holds the FULL page, not the trimmed one");
eq(capped.spool!.path, written[0]!.path, "…at the path the model is pointed at");
eq(capped.count, 30, "`count` still reports what the fetch returned — the disagreement with messages.length IS the signal");

const bareCtx = {} as unknown as BindableContext;
const degraded = await capReadForInline(bareCtx, outputOf(Array.from({ length: 30 }, (_, i) => line(i, 800))), "channel", "ch_fixture", () => fullBody);
ok(degraded.spool !== undefined && degraded.spool.path === undefined, "with no sandbox the read still returns, with NO path");
ok(degraded.messages.length > 0, "…and the trimmed page is still in front of the model");

const angryCtx = { getSandbox: async () => { throw new Error("sandbox refused to start"); } } as unknown as BindableContext;
const angry = await capReadForInline(angryCtx, outputOf(Array.from({ length: 30 }, (_, i) => line(i, 800))), "channel", "ch_fixture", () => fullBody);
ok(angry.spool !== undefined && angry.spool.path === undefined, "a sandbox that throws degrades the note and does not fail the read");

const spun: string[] = [];
const watchCtx = { getSandbox: async () => { spun.push("spun"); return { writeTextFile: async () => undefined }; } } as unknown as BindableContext;
const smallOut = outputOf([line(1, 20), line(2, 20)]);
const untouched = await capReadForInline(watchCtx, smallOut, "channel", "ch_fixture", () => renderChannelBody(smallOut));
ok(untouched === smallOut, "an under-cap read returns the SAME object — no copy, no spool field");
eq(spun.length, 0, "…and never spins the sandbox, so the common read pays no resume latency");

const plain: ChannelReadOutput = { platform: "slack", channel: "ch_k", count: 1, messages: [{ author: "U1", ts: "1.0", text: "hello" }] };
eq(renderChannelBody(plain), "Recent messages in ch_k (oldest first):\n[U1] hello", "an un-spooled channel body is byte-identical to the pre-OPE-829 render");
const plainThread: ThreadReadOutput = { ...plain, thread_ts: "9.9" };
eq(renderThreadBody(plainThread), "Thread 9.9 in ch_k (oldest first):\n[U1] hello", "an un-spooled thread body is byte-identical too");

const spooledBody = renderChannelBody({ ...plain, spool: { path: "reads/channel-ch_k-abc.txt", shown: 1, total: 90 } });
ok(spooledBody.startsWith("Recent messages in ch_k (oldest first):\n[U1] hello"), "the spool note is APPENDED — the body above it is unchanged");
ok(spooledBody.includes("[oversize:"), "…and the note is bracketed like the coverage note beside it");

const bothBody = renderChannelBody({ ...plain, possiblyIncomplete: true, spool: { path: "reads/x.txt", shown: 1, total: 90 } });
ok(bothBody.includes("[coverage:") && bothBody.includes("[oversize:"), "a page that is BOTH partial and trimmed carries both notes — they say different things");
ok(bothBody.indexOf("[coverage:") < bothBody.indexOf("[oversize:"), "…coverage first (what the fetch reached), then oversize (what the result carried)");

console.log(`\n✓ seat-read-recovery (OPE-829): ${passed} assertions passed (budget pure + in-context, inline cap, spool fail-soft, render join)`);

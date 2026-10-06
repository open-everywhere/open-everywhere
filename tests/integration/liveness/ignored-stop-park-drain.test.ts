import { afterAll, expect, test } from "vitest";
import { appendAudit } from "@open-everywhere/core/agent/audit/audit.js";
import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { resolveTurnAnchor, turnChannelKey } from "@open-everywhere/core/agent/channels/turn-registry.js";
import {
  auditCursor,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  waitFor,
} from "../harness";

const BOT_MENTION = "<@9000000000000000001>";
const CANCEL_SETTLE_GRACE_MS = 10_000;
const RESOLVER_SOURCE = "() => void resolve()";
const HOLD_MS = 90_000;
const PARK_AFTER_MS = CANCEL_SETTLE_GRACE_MS + 4_000;
const STOPPER_ID = "9000000000000000083";

const realSetTimeout = globalThis.setTimeout;
let swallowed = 0;
let bookedAt = 0;
function swallowCheckTimer(): void {
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    if (ms === CANCEL_SETTLE_GRACE_MS && typeof fn === "function" && String(fn) === RESOLVER_SOURCE) {
      swallowed += 1;
      bookedAt = Date.now();
      return realSetTimeout(() => {}, 0);
    }
    return realSetTimeout(fn, ms, ...rest);
  }) as typeof setTimeout;
}
afterAll(() => {
  globalThis.setTimeout = realSetTimeout;
});

test("a parked session drains a due ignored-stop check — no new turn has to start", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const channelKey = turnChannelKey("discord", DISCORD_LISTED_CHANNEL_ID)!;
  const cursor = await auditCursor();

  const a = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "update_status", input: { state: "working", summary: "ope-2283 turn A" }, id: "ope2283-a-ran" }] },
        { calls: [{ tool: "no_reply", input: { reason: "nothing_to_add" }, id: "ope2283-a-end" }], delayMs: HOLD_MS },
      ],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} ope2283 turn A`, messageId: "ope2283-a" });
  const inFlight = await waitFor(() => a.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "turn A's second model call, held open");
  const turnA = inFlight.turnId!;
  const anchor = await waitFor(async () => (await resolveTurnAnchor(org, { channelKey })) ?? undefined, "turn A's anchor row");
  expect(anchor.turnId).toBe(turnA);

  await appendAudit({
    org,
    platform: "discord",
    workspace: "ope2283",
    action: "turn.cancel_requested",
    principalId: STOPPER_ID,
    detail: { outcome: "requested", via: "command", turnId: turnA, sessionId: anchor.sessionId },
  });

  swallowCheckTimer();
  a.releaseHolds();
  await waitFor(() => (swallowed > 0 ? true : undefined), "turn A's ignored-stop check booked (its timer swallowed)", 60_000);
  expect(swallowed, "exactly one check timer was booked and swallowed").toBe(1);
  expect(a.holdsCutShort()).toBe(1);
  a.dispose();

  const b = disposeLater(
    registerScript({ parent: [{ calls: [{ tool: "no_reply", input: { reason: "nothing_to_add" }, id: "ope2283-b-end" }], delayMs: PARK_AFTER_MS }] }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} ope2283 turn B`, messageId: "ope2283-b" });
  const bCall = await waitFor(() => b.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "turn B's model call");
  expect(bCall.turnId, "turn B is a new turn").not.toBe(turnA);
  expect(Date.now() - bookedAt, "turn B's model call came well inside A's grace, so its turn.started did too").toBeLessThan(CANCEL_SETTLE_GRACE_MS - 2_000);
  expect((await rowsSinceCursor(cursor, ["turn.stop_ignored"])).filter((r) => r.detail?.turnId === turnA), "no row before any drain is due").toEqual([]);

  const row = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["turn.stop_ignored"])).find((r) => r.detail?.turnId === turnA),
    "turn A's turn.stop_ignored row, drained at turn B's session.waiting (hooks/turn-anchor.ts)",
    PARK_AFTER_MS + 30_000,
  );
  expect(row.detail?.sessionId).toBe(anchor.sessionId);
  expect(row.detail?.endedAs).toBe("completed");
  expect(row.principalId).toBe(STOPPER_ID);
  expect(b.requests.filter((r) => r.role === "parent").map((r) => r.turnId)).toEqual([bCall.turnId]);
  expect(await rowsSinceCursor(cursor, ["turn.cancelled"])).toEqual([]);
  expect([...a.requests, ...b.requests].filter((r) => r.fault !== undefined)).toEqual([]);
});

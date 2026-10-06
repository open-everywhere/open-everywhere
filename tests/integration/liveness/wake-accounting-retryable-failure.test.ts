import { expect, test } from "vitest";

import {
  auditCursor,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  sleep,
  waitFor,
  type RecordedRequest,
} from "../harness";

const TURN_FAILED_ACTION = "unified.supervisor_turn_failed";
const SESSION_FAILED_ACTION = "unified.supervisor_session_failed";
const UNACCOUNTED_ACTION = "turn.unaccounted_wakes";
const SKIPPED_ACTION = "turn.wake_accounting_skipped";

function firstTurnRequests(requests: readonly RecordedRequest[]): RecordedRequest[] {
  const parent = requests.filter((r) => r.role === "parent");
  const turnId = parent[0]?.turnId;
  return parent.filter((r) => r.turnId === turnId);
}

test("a retryable model failure (turn.failed, then session.waiting, no session.failed) still runs the wake-accounting pass", async () => {
  await bootAgent();
  const cursor = await auditCursor();
  const handle = disposeLater(registerScript({ parent: [{}] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> ope2284 fyi the deploy finished", messageId: "ope2284-wake" });

  const failed = await waitFor(async () => (await rowsSinceCursor(cursor, [TURN_FAILED_ACTION])).at(0), "the unified seat's turn-failed row");
  expect(failed.action).toBe(TURN_FAILED_ACTION);
  const turn = firstTurnRequests(handle.requests);
  expect(turn.some((r) => r.emptyReissue === true), "eve reissued the empty step before it failed the turn").toBe(true);
  const failedTurnId = turn[0]?.turnId;
  expect(typeof failedTurnId, "the scripted model recorded the failed turn's id").toBe("string");

  const row = await waitFor(
    async () => (await rowsSinceCursor(cursor, [UNACCOUNTED_ACTION])).find((r) => r.detail?.turnId === failedTurnId),
    `the ${UNACCOUNTED_ACTION} row for the failed turn — written only by hooks/wake-accounting-turn.ts's turn.failed arm on this path`,
    60_000,
  ).catch(async (err: unknown) => {
    const skipped = await rowsSinceCursor(cursor, [SKIPPED_ACTION]);
    throw new Error(`${String(err)} — ${SKIPPED_ACTION} rows: ${JSON.stringify(skipped.map((r) => r.detail))}`);
  });
  const turnWake = row.detail?.turnWake;
  expect(typeof turnWake, "the row names the failed turn's own wake").toBe("string");
  const unaccounted = (row.detail?.unaccounted as { wakeId: string }[] | undefined) ?? [];
  expect(
    unaccounted.map((w) => w.wakeId),
    "the failed turn answered nothing, so its own wake is the unaccounted one",
  ).toContain(turnWake);

  await sleep(2_000);
  expect(await rowsSinceCursor(cursor, [SESSION_FAILED_ACTION]), "a retryable failure parks the session — no session.failed").toEqual([]);
  expect((await rowsSinceCursor(cursor, [UNACCOUNTED_ACTION])).filter((r) => r.detail?.turnId === failedTurnId)).toHaveLength(1);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});

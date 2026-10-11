import { expect, test } from "vitest";
import {
  auditCursor,
  awaitWindowQuiet,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  DISCORD_USER_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  sleep,
  waitFor,
  type AuditRow,
} from "../harness";

const OUTCOME_ACTIONS = ["chat.dm", "dm.refused", "attention.ping_failed"];

function attentionOutcomes(rows: readonly AuditRow[]): AuditRow[] {
  return rows.filter((r) => {
    if (r.action === "attention.ping_failed") return true;
    const plane = (r.detail as { plane?: unknown } | undefined)?.plane;
    return plane === "attention.blocked";
  });
}

async function settle(): Promise<void> {
  await awaitWindowQuiet();
  await sleep(1_500);
}

test("a seat that reports blocked records its attention state and pings its person exactly once", async () => {
  await bootAgent();
  const cursor = await auditCursor();
  disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "update_status", input: { state: "blocked", summary: "need the staging password from you" }, id: "ope2433-blocked-1" }] },
        { calls: [{ tool: "update_status", input: { state: "blocked", summary: "still need the staging password" }, id: "ope2433-blocked-2" }] },
        { calls: [{ tool: "no_reply", input: { reason: "nothing_to_add" }, id: "ope2433-close" }] },
      ],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please deploy staging" });
  await waitFor(async () => (await rowsSinceCursor(cursor, ["reply.no_reply_observed"])).at(0), "the closing no_reply's observed row", 120_000);
  await settle();

  const outcomes = attentionOutcomes(await rowsSinceCursor(cursor, OUTCOME_ACTIONS));
  expect(outcomes.length, `exactly one ping outcome for one blocked episode across TWO blocked reports — got ${JSON.stringify(outcomes)}`).toBe(1);
  const outcome = outcomes[0];
  expect(outcome.principalId).toBe(DISCORD_USER_ID);
  const pinged = outcome.action === "attention.ping_failed" ? undefined : (outcome.detail as { recipient?: unknown } | undefined)?.recipient;
  if (pinged !== undefined) expect(pinged).toBe(DISCORD_USER_ID);
  if (outcome.action === "attention.ping_failed") expect(typeof (outcome.detail as { sessionId?: unknown }).sessionId).toBe("string");
});

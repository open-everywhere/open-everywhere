import { expect, test } from "vitest";
import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { resolveTurnAnchor, turnChannelKey } from "@open-everywhere/core/agent/channels/turn-registry.js";
import {
  auditCursor,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  discordOeCommandPost,
  discordOeStopInteraction,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  waitFor,
} from "../harness";

const BOT_MENTION = "<@9000000000000000001>";
const HOLD_MS = 90_000;
const STOPPER_ID = "9000000000000000079";
const RAN_TOOL = "todo";
const SETTLE_WATCH_MS = 20_000;

test("a stop the ingress accepted leaves exactly one evidence row — turn.cancelled when eve settled it, turn.stop_ignored when eve dropped it", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const channelKey = turnChannelKey("discord", DISCORD_LISTED_CHANNEL_ID)!;
  const cursor = await auditCursor();

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: RAN_TOOL, input: { todos: [{ content: "ope-1190 in-flight work", priority: "high", status: "in_progress" }] }, id: "ope1190-todo" }] },
        { say: "never posted — the stop lands inside this call", delayMs: HOLD_MS },
      ],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} ope1190`, messageId: "ope1190-wake" });
  const inFlight = await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the turn's second model call, held open");
  expect(inFlight.fault).toBeUndefined();
  const stoppedTurnId = inFlight.turnId;

  const anchor = await waitFor(
    async () => (await resolveTurnAnchor(org, { channelKey })) ?? undefined,
    "the turn-anchor row for the in-flight turn (hooks/turn-anchor.ts `turn.started`)",
  );
  expect(anchor.turnId).toBe(stoppedTurnId);

  const stop = await discordOeCommandPost(discordOeStopInteraction({ channelId: DISCORD_LISTED_CHANNEL_ID, userId: STOPPER_ID }));
  expect(stop.status, `the stop command was refused: ${stop.body}`).toBe(200);
  expect(stop.body).toContain("Standing down");
  expect(stop.body).not.toContain("Nothing running here right now");
  expect(stop.body).toContain("the outcome in the thread");

  const requested = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["turn.cancel_requested"]);
    return rows.length > 0 ? rows : undefined;
  }, "the turn.cancel_requested row the ingress writes");
  expect(requested).toHaveLength(1);
  expect(requested[0]!.detail?.outcome).toBe("requested");
  expect(requested[0]!.detail?.turnId).toBe(stoppedTurnId);
  expect(requested[0]!.detail?.sessionId).toBe(anchor.sessionId);
  expect(requested[0]!.principalId).toBe(STOPPER_ID);

  handle.releaseHolds();

  const evidence = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["turn.cancelled", "turn.stop_ignored"]);
    return rows.length > 0 ? rows : undefined;
  }, "the cancel evidence row — turn.cancelled if eve settled the cancel, turn.stop_ignored if it dropped it");
  await new Promise((r) => setTimeout(r, SETTLE_WATCH_MS));
  const settled = await rowsSinceCursor(cursor, ["turn.cancelled", "turn.stop_ignored"]);
  expect(
    settled,
    `an accepted stop produced ${settled.length} evidence rows: ${JSON.stringify(settled.map((r) => ({ action: r.action, ts: r.ts, turnId: r.detail?.turnId })))}`,
  ).toHaveLength(1);
  expect(evidence[0]!.action, "the row that eventually stood is not the one that appeared first").toBe(settled[0]!.action);
  const row = settled[0]!;
  expect(row.platform).toBe("discord");

  if (row.action === "turn.stop_ignored") {
    expect(row.detail?.turnId, "the ignored-stop row names the turn nobody managed to stop").toBe(stoppedTurnId);
    expect(row.detail?.sessionId, "…and its session, which is the other half of the join").toBe(anchor.sessionId);
    expect(row.detail?.endedAs, "…and the ordinary end the turn actually reached").toBe("completed");
    expect(row.detail?.via, "…and the affordance the stop came through").toBe("command");
    expect(row.principalId, "…and the person whose stop was ignored").toBe(STOPPER_ID);
    expect(row.detail?.ran, "an ignored stop interrupted nothing, so it names no interrupted work").toBeUndefined();
  } else {
    expect(row.action).toBe("turn.cancelled");
    expect(row.detail?.ran, "a settled cancel names the work it interrupted").toEqual([RAN_TOOL]);
    expect(await rowsSinceCursor(cursor, ["turn.stop_ignored"]), "a settled cancel must not ALSO be recorded as an ignored stop").toEqual([]);
  }

  expect(handle.holdsCutShort()).toBe(1);

  const cleared = await waitFor(
    async () => ((await resolveTurnAnchor(org, { channelKey })) === null ? true : undefined),
    "the turn-anchor row cleared by whichever terminal arm ran",
  );
  expect(cleared).toBe(true);

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});

import { afterAll, expect, test } from "vitest";
import { TURN_CANCELLED_ACTION } from "@open-everywhere/core/agent/channels/turn-cancel.js";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { resolveTurnAnchor, turnChannelKey } from "@open-everywhere/core/agent/channels/turn-registry.js";

import {
  auditCursor,
  awaitWindowQuiet,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  discordOeCommandPost,
  discordOeStopInteraction,
  registerScript,
  rowsSinceCursor,
  seatReply,
  waitFor,
  type ScriptedHandle,
} from "../harness";

const live = new Set<ScriptedHandle>();
afterAll(() => {
  for (const h of live) h.dispose();
  live.clear();
});
function open(handle: ScriptedHandle): ScriptedHandle {
  live.add(handle);
  return handle;
}

const STOPPER_ID = "9000000000000000077";

const RAN_TOOL = "update_status";

const HOLD_MS = 90_000;

test("a human stops an in-flight turn, and the turn's own process cleans up and tells the model", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const channelKey = turnChannelKey("discord", DISCORD_LISTED_CHANNEL_ID)!;
  const cursor = await auditCursor();

  const handle = open(
    registerScript({
      parent: [
        { calls: [{ tool: RAN_TOOL, input: { state: "working", summary: "ope-634 in-flight work" }, id: "ope634-ran" }] },
        { say: NO_REPLY_SENTINEL, delayMs: HOLD_MS, holdUntilCancelled: true },
      ],
    }),
  );

  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: "<@9000000000000000001> start the long job",
    messageId: "ope634-cancel-wake",
  });

  const inFlight = await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    "the parent's second model call — the turn held open, ready to be stopped",
  );
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(inFlight.tools).toContain(RAN_TOOL);
  expect(inFlight.toolResults.map((t) => t.name)).toContain(RAN_TOOL);
  const cancelledTurnId = inFlight.turnId;
  expect(typeof cancelledTurnId).toBe("string");

  const anchor = await waitFor(
    async () => (await resolveTurnAnchor(org, { channelKey })) ?? undefined,
    "the turn-anchor row for the in-flight turn (hooks/turn-anchor.ts `turn.started`)",
  );
  expect(anchor.turnId).toBe(cancelledTurnId);
  expect(typeof anchor.sessionId).toBe("string");

  const unsigned = await discordOeCommandPost(discordOeStopInteraction({ channelId: DISCORD_LISTED_CHANNEL_ID, userId: STOPPER_ID }), {
    signature: null,
  });
  expect(unsigned.status).toBe(401);
  expect(unsigned.body).not.toContain("Standing down");
  expect(await resolveTurnAnchor(org, { channelKey })).not.toBeNull();
  expect(await rowsSinceCursor(cursor, [TURN_CANCELLED_ACTION])).toEqual([]);

  const stop = await discordOeCommandPost(discordOeStopInteraction({ channelId: DISCORD_LISTED_CHANNEL_ID, userId: STOPPER_ID }));
  expect(stop.status).toBe(200);
  expect(stop.body).toContain("Standing down");
  expect(stop.body).not.toContain("Nothing running here right now");

  const requested = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["turn.cancel_requested"]);
    return rows.length > 0 ? rows : undefined;
  }, "the turn.cancel_requested row the ingress writes");
  expect(requested).toHaveLength(1);
  expect(requested[0]!.principalId).toBe(STOPPER_ID);
  expect(requested[0]!.detail?.via).toBe("command");
  expect(requested[0]!.detail?.outcome).toBe("requested");
  expect(requested[0]!.detail?.turnId).toBe(cancelledTurnId);

  handle.releaseHolds();

  const cancelled = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [TURN_CANCELLED_ACTION]);
    return rows.length > 0 ? rows : undefined;
  }, "the turn.cancelled row — written from the cancelled turn's OWN process");
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0]!.platform).toBe("discord");
  expect(cancelled[0]!.detail?.ran).toEqual([RAN_TOOL]);
  expect(Number(cancelled[0]!.detail?.steps)).toBeGreaterThanOrEqual(1);
  expect(handle.holdsCutShort()).toBe(1);
  expect(handle.holdsCancelDelivered()).toBe(1);

  const cleared = await waitFor(
    async () => ((await resolveTurnAnchor(org, { channelKey })) === null ? true : undefined),
    "the turn-anchor row cleared by the cancelled arm",
  );
  expect(cleared).toBe(true);

  handle.dispose();
  live.delete(handle);
  const after = open(registerScript({ parent: [seatReply("understood — I will not redo that", "ope634-followup-reply")] }));
  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: "<@9000000000000000001> what happened?",
    messageId: "ope634-cancel-followup",
  });
  const next = await waitFor(
    () => after.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes("was CANCELLED"))),
    "the next turn's prompt carrying the cancel reconstruction",
  );
  const prompt = next.messages.map((m) => m.text).join("\n");
  expect(prompt).toContain(`was CANCELLED by \`${STOPPER_ID}\``);
  expect(prompt).not.toContain("was CANCELLED by a person");
  expect(prompt).toContain(`\`${RAN_TOOL}\``);

  await awaitWindowQuiet();
  expect(after.requests.some((r) => r.role === "parent" && r.stepIndex !== 0), "a step after the follow-up's reply was requested").toBe(false);
  expect(after.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});

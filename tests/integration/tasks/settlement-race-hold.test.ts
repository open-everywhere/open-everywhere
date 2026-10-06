import { expect, test } from "vitest";
import { auditCursor, bootAgent, discordMentionWake, disposeLater, DISCORD_LISTED_CHANNEL_ID, registerScript, rowsSinceCursor, waitFor } from "../harness";

test("a later turn that arrives before the script swap is held, then served by the swapped-in script", async () => {
  await bootAgent();
  const cursor = await auditCursor();
  const first = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "react", input: { emoji: "eyes" }, id: "ope750-react" }] },
        { calls: [{ tool: "no_reply", input: { reason: "reacted_instead" }, id: "ope750-quiet" }] },
      ],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> ope750 first message" });
  await waitFor(async () => (await rowsSinceCursor(cursor, ["reply.no_reply_observed"])).at(0), "turn 1 to end in silence");
  const turnOne = first.requests.find((r) => r.role === "parent");
  expect(turnOne?.turnId).toBeDefined();
  const seatSessionId = String(turnOne!.sessionId);

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> ope750 second message" });

  const held = await waitFor(
    () => first.resolves.find((r) => r.role === "parent" && r.turnId !== turnOne!.turnId),
    "turn 2's model call to reach the still-registered turn-1 entry",
  );
  expect(held.fault).toBeUndefined();
  expect(first.requests.some((r) => r.turnId === held.turnId)).toBe(false);

  const drain = disposeLater(registerScript({ parent: [{ say: "NO_REPLY" }] }, seatSessionId));
  const served = await waitFor(
    () => drain.requests.find((r) => r.role === "parent" && r.turnId === held.turnId),
    "the held turn 2, served by the session-keyed swap",
    90_000,
  );

  expect(first.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(first.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(served.fault).toBeUndefined();
  expect(served.stepIndex).toBe(0);
  expect(drain.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});

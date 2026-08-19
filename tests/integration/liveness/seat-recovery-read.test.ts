import { expect, test } from "vitest";
import { afterThisTest, disposeLater, bootAgent, discordMentionWake, DISCORD_LISTED_CHANNEL_ID, registerScript, waitFor } from "../harness";
import { installHostFetchStub } from "../fetch-stub";
import { SEAT_RECOVERY_READ_BUDGET } from "@open-everywhere/core/agent/access/seat-read-budget.js";

const READER = "read_channel";
const DISCORD_API = "https://discord.com/api/v10/";
const CHANNEL_KEY = `ch_${Buffer.from(`discord:${DISCORD_LISTED_CHANNEL_ID}`).toString("base64url")}`;
const FIXTURE_TEXT = "the deploy finished at 16:00";
const REFUSAL_MARKER = "recovery reads on this turn";

function readCall(id: string): { tool: string; input: unknown; id: string } {
  return { tool: READER, input: { channel: CHANNEL_KEY, limit: 10 }, id };
}

function installDiscordReadStub(): () => void {
  const hadToken = Object.prototype.hasOwnProperty.call(process.env, "DISCORD_BOT_TOKEN");
  const previousToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "integration-stub-discord-bot-token";
  const stub = installHostFetchStub(DISCORD_API, (url) => {
    if (!url.pathname.endsWith(`/channels/${DISCORD_LISTED_CHANNEL_ID}/messages`)) return undefined;
    return Response.json([
      {
        type: 0,
        id: "9000000000000000101",
        content: FIXTURE_TEXT,
        timestamp: "2026-08-19T12:00:00.000000+00:00",
        author: { id: "9000000000000000042", username: "alex", bot: false },
      },
    ]);
  });
  return () => {
    stub.uninstall();
    if (hadToken) process.env.DISCORD_BOT_TOKEN = previousToken;
    else delete process.env.DISCORD_BOT_TOKEN;
  };
}

test("a lean standing seat holds read_channel, spends a bounded budget in one turn, and gets it back on the next", async () => {
  await bootAgent();
  afterThisTest(installDiscordReadStub());

  const overspending = disposeLater(
    registerScript({
      parent: [
        ...Array.from({ length: SEAT_RECOVERY_READ_BUDGET + 1 }, (_, i) => ({ calls: [readCall(`rr-read-${i + 1}`)] })),
        { say: "checked what I could see" },
      ],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> when I said 16:00 earlier, did I mean UTC or local?" });

  const firstStep = await waitFor(() => overspending.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the seat's own first model call");
  expect(firstStep.tools).toContain(READER);
  expect(firstStep.tools).toContain("agent");
  expect(firstStep.tools).not.toContain("bash");
  expect(firstStep.tools).not.toContain("purge_memory");

  const afterFirstRead = await waitFor(
    () => overspending.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    "the seat's second call — its prompt carries the first read's result",
  );
  expect(afterFirstRead.messages.some((m) => m.text.includes(FIXTURE_TEXT))).toBe(true);

  const afterOverspend = await waitFor(
    () => overspending.requests.find((r) => r.role === "parent" && r.stepIndex === SEAT_RECOVERY_READ_BUDGET + 1),
    `the seat's step after read ${SEAT_RECOVERY_READ_BUDGET + 1} — the one the budget stopped`,
  );
  const refusalCarriers = afterOverspend.messages.filter((m) => m.text.includes(REFUSAL_MARKER));
  expect(refusalCarriers.length, "no prompt message carried the budget refusal").toBeGreaterThan(0);
  expect(refusalCarriers[refusalCarriers.length - 1]!.text).toContain("delegate a worker");
  const beforeOverspend = overspending.requests.filter((r) => r.role === "parent" && r.stepIndex <= SEAT_RECOVERY_READ_BUDGET);
  expect(beforeOverspend.every((r) => r.messages.every((m) => !m.text.includes(REFUSAL_MARKER)))).toBe(true);

  overspending.dispose();
  const nextTurn = disposeLater(registerScript({ parent: [{ calls: [readCall("rr-read-next-turn")] }, { say: "looked again" }] }));

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> have another look please" });

  const resumedNext = await waitFor(
    () => nextTurn.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    "the new turn's step after its first read",
  );
  expect(nextTurn.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  expect(resumedNext.messages.some((m) => m.text.includes(FIXTURE_TEXT))).toBe(true);
  const lastCarrier = resumedNext.messages.filter((m) => m.text.includes(FIXTURE_TEXT) || m.text.includes(REFUSAL_MARKER)).at(-1)!;
  expect(lastCarrier.text).not.toContain(REFUSAL_MARKER);
});

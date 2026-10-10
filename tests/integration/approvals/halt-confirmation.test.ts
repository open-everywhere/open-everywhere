import { __setTestValveForTest } from "@open-everywhere/core/agent/testing/test-valves.js";
import { afterAll, expect, test } from "vitest";

import {
  auditCursor,
  bootAgent,
  disposeLater,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  rowsSinceCursor,
  waitFor,
  waitForAuditRows,
  type AuditCursor,
  type ScriptedHandle,
  WAKE_FROM_ENVELOPE,
} from "../harness";
import { installDiscordWebApiStub, type DiscordCreateMessageCall } from "../discord-web-api";

const discord = installDiscordWebApiStub({ captureMessages: true });
afterAll(() => discord.uninstall());

async function confirmationFor(scope: "org" | "surface"): Promise<string> {
  const { haltConfirmation } = await import("@open-everywhere/core/agent/tools/halt.js");
  return haltConfirmation(scope);
}

async function driveTurn(ids: string, steps: readonly Record<string, unknown>[]): Promise<AuditCursor> {
  const handle: ScriptedHandle = disposeLater(registerScript({ parent: [...steps] }));
  const last = steps.length - 1;
  const cursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> ${ids}` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === last), `${ids}: the parent's terminal step`);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  return cursor;
}

function confirmationsInRoom(confirmation: string): DiscordCreateMessageCall[] {
  return discord.messages.filter((m) => m.content.includes(confirmation));
}

test("① 🔴 NEGATIVE CONTROL: a turn that does not halt puts NO confirmation in the room", async () => {
  await bootAgent();
  __setTestValveForTest("egress-spoof", false);
  (discord.messages as DiscordCreateMessageCall[]).length = 0;

  const cursor = await driveTurn("hc-clear", [
    { calls: [{ tool: "reply", input: { text: "Nothing to stop — the changelog task is the only one running.", wake: WAKE_FROM_ENVELOPE }, id: "hc-clear-reply" }] },
  ]);

  await waitFor(() => discord.messages.find((m) => m.content.includes("changelog task")), "the turn's ordinary reply to reach the room");
  expect(confirmationsInRoom(await confirmationFor("surface"))).toEqual([]);
  expect(confirmationsInRoom(await confirmationFor("org"))).toEqual([]);
  expect(await rowsSinceCursor(cursor, ["admin.halt.set"])).toEqual([]);
});

test("② a real `halt` call posts the host's confirmation into the room, and the row says it did", async () => {
  await bootAgent();
  __setTestValveForTest("egress-spoof", false);
  (discord.messages as DiscordCreateMessageCall[]).length = 0;

  const cursor = await driveTurn("hc-halt", [
    { calls: [{ tool: "halt", input: { scope: "surface" }, id: "hc-halt-call" }] },
    { calls: [{ tool: "reply", input: { text: "Stopped everything here.", wake: WAKE_FROM_ENVELOPE }, id: "hc-halt-reply" }] },
  ]);

  const confirmation = await confirmationFor("surface");
  const posted = await waitFor(() => confirmationsInRoom(confirmation)[0], "the halt confirmation to reach the Discord room");
  expect(posted.channelId).toBe(DISCORD_LISTED_CHANNEL_ID);
  expect(confirmationsInRoom(confirmation)).toHaveLength(1);

  const rows = await waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(cursor, ["admin.halt.set"]);
      return got.length > 0 ? got : undefined;
    },
    label: "this turn's admin.halt.set row to land",
    actions: ["admin.halt.set"],
    cursor,
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.detail?.["announced"]).toBe(true);
  expect(rows[0]!.detail?.["level"]).toBe("surface");
  expect(rows[0]!.detail?.["door"]).toBe("chat");
});

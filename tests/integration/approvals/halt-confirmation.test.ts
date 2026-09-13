import { afterAll, expect, test } from "vitest";

import {
  bootAgent,
  disposeLater,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  readAuditRows,
  registerScript,
  waitFor,
  type ScriptedHandle,
} from "../harness";
import { installDiscordWebApiStub, type DiscordCreateMessageCall } from "../discord-web-api";

const discord = installDiscordWebApiStub({ captureMessages: true });
afterAll(() => discord.uninstall());

async function confirmationFor(scope: "org" | "surface"): Promise<string> {
  const { haltConfirmation } = await import("@open-everywhere/core/agent/tools/halt.js");
  return haltConfirmation(scope);
}

async function driveTurn(ids: string, steps: readonly Record<string, unknown>[]): Promise<number> {
  const handle: ScriptedHandle = disposeLater(registerScript({ parent: [...steps] }));
  const last = steps.length - 1;
  const wakeAt = Date.now();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> ${ids}` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === last), `${ids}: the parent's terminal step`);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  return wakeAt;
}

function confirmationsInRoom(confirmation: string): DiscordCreateMessageCall[] {
  return discord.messages.filter((m) => m.content.includes(confirmation));
}

test("① 🔴 NEGATIVE CONTROL: a turn that does not halt puts NO confirmation in the room", async () => {
  await bootAgent();
  delete process.env.OE_EGRESS_SPOOF;
  (discord.messages as DiscordCreateMessageCall[]).length = 0;

  const wakeAt = await driveTurn("hc-clear", [{ say: "Nothing to stop — the changelog task is the only one running." }]);

  await waitFor(() => discord.messages.find((m) => m.content.includes("changelog task")), "the turn's ordinary reply to reach the room");
  expect(confirmationsInRoom(await confirmationFor("surface"))).toEqual([]);
  expect(confirmationsInRoom(await confirmationFor("org"))).toEqual([]);
  expect(await readAuditRows({ actions: ["admin.halt.set"], sinceIso: new Date(wakeAt).toISOString() })).toEqual([]);
});

test("② a real `halt` call posts the host's confirmation into the room, and the row says it did", async () => {
  await bootAgent();
  delete process.env.OE_EGRESS_SPOOF;
  (discord.messages as DiscordCreateMessageCall[]).length = 0;

  const wakeAt = await driveTurn("hc-halt", [{ calls: [{ tool: "halt", input: { scope: "surface" }, id: "hc-halt-call" }] }, { say: "Stopped everything here." }]);

  const confirmation = await confirmationFor("surface");
  const posted = await waitFor(() => confirmationsInRoom(confirmation)[0], "the halt confirmation to reach the Discord room");
  expect(posted.channelId).toBe(DISCORD_LISTED_CHANNEL_ID);
  expect(confirmationsInRoom(confirmation)).toHaveLength(1);

  const rows = await waitFor(async () => {
    const got = await readAuditRows({ actions: ["admin.halt.set"], sinceIso: new Date(wakeAt).toISOString() });
    return got.length > 0 ? got : undefined;
  }, "this turn's admin.halt.set row to land");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.detail?.["announced"]).toBe(true);
  expect(rows[0]!.detail?.["level"]).toBe("surface");
  expect(rows[0]!.detail?.["door"]).toBe("chat");
});

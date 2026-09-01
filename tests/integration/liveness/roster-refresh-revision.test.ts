import { expect, test } from "vitest";
import { disposeLater, bootAgent, discordMentionWake, DISCORD_LISTED_CHANNEL_ID, registerScript, setEnvForRunningAgent, waitFor, type ScriptedHandle } from "../harness";

const TARGET_TOOL = "spawn_thread_session";

async function driveTurn(text: string, messageId: string) {
  const handle = disposeLater(registerScript({ parent: [{ say: text }] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> ${text}`, messageId });
  const request = await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0), `the "${text}" turn's model call`);
  expect(request.fault).toBeUndefined();
  handle.dispose();
  return request;
}

test("a standing session re-derives its tool roster when the deployment id changes, and NOT on a settings change alone", async () => {
  setEnvForRunningAgent("VERCEL_DEPLOYMENT_ID", "it-ope676-dep-a");
  await bootAgent();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");

  expect(settings.getSettings().delegation.oneshotAgent).toBe(true);

  const turn1 = await driveTurn("ope676 turn one", "ope676-t1");
  expect(turn1.tools).toContain(TARGET_TOOL);

  settings.overrideSettingsForTest({ delegation: { oneshotAgent: false } });
  expect(settings.getSettings().delegation.oneshotAgent).toBe(false);

  const turn2 = await driveTurn("ope676 turn two", "ope676-t2");
  expect(turn2.sessionId).toBe(turn1.sessionId);
  expect(turn2.tools).toContain(TARGET_TOOL);

  setEnvForRunningAgent("VERCEL_DEPLOYMENT_ID", "it-ope676-dep-b");

  const turn3 = await driveTurn("ope676 turn three", "ope676-t3");
  expect(turn3.sessionId).toBe(turn1.sessionId);
  expect(turn3.tools).not.toContain(TARGET_TOOL);
});

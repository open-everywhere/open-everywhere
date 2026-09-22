import { expect, test } from "vitest";

import { __setStaleTurnParkMsForTest } from "../../../agent/model/scripted-model";
import {
  afterThisTest,
  bootAgent,
  disposeLater,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  waitFor,
} from "../harness";

const DELEGATOR_PROSE = "oe-1982 the delegator's closing prose, dropped and corrected exactly once";

test("OPE-1982 — the corrective re-drive re-enters a still-registered script and is answered with silence, not the OPE-727 fault", async () => {
  await bootAgent();

  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "look something up" }, id: "ope1982-rescue-delegate" }] }, { say: DELEGATOR_PROSE }],
      child: [{ say: "the worker's own prose, which never leaves the parent's session" }],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> please delegate this` });
  const delegating = await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0),
    "the delegating turn's call-bearing step",
  );

  const rescued = await waitFor(
    () => handle.requests.find((r) => r.redriveSilence === true),
    "the corrective turn to be answered with judged silence instead of the stale-script fault",
  );

  expect(rescued.messages.some((m) => m.text.includes('id="redrive-'))).toBe(true);

  expect(rescued.turnId).not.toBe(delegating.turnId);
  expect(typeof rescued.turnId).toBe("string");

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
});

test("OPE-727 still fires — a genuinely new wake re-entering the same live entry faults, even after that entry was already rescued once", async () => {
  await bootAgent();

  __setStaleTurnParkMsForTest(1_000);
  afterThisTest(() => __setStaleTurnParkMsForTest(undefined));

  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "look something up" }, id: "ope727-live-delegate" }] }, { say: DELEGATOR_PROSE }],
      child: [{ say: "the worker's own prose, which never leaves the parent's session" }],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> the first ask` });
  const rescued = await waitFor(() => handle.requests.find((r) => r.redriveSilence === true), "the first ask's correction, answered with silence");
  expect(rescued.fault).toBeUndefined();

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> the second ask` });
  const faulted = await waitFor(
    () => handle.requests.find((r) => r.fault?.includes("stale script")),
    "the second wake to take the OPE-727 stale-script fault",
  );

  expect(faulted.fault).toContain("already served a call-bearing step for turn");
  expect(faulted.redriveSilence).toBeUndefined();
  expect(faulted.turnId).not.toBe(rescued.turnId);

  const prompt = faulted.messages.map((m) => m.text).join("\n");
  expect(prompt.includes('id="redrive-'), "the cumulative prompt carries the earlier correction").toBe(true);
  expect(prompt.slice(prompt.lastIndexOf("<wake ")).includes('id="redrive-'), "…but THIS turn's own envelope does not").toBe(false);
});

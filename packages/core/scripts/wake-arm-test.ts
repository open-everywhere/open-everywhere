import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "oe-wake-arm-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

import {
  WAKE_ARM_MAX_TEXT_CHARS,
  WAKE_ARM_SURFACE_CONTRACT,
  _resetWakeArmSurfaceContractForTest,
  _resetWakeArmTimeoutMsForTest,
  _setWakeArmSurfaceContractForTest,
  _setWakeArmTimeoutMsForTest,
  wakeAfterArm,
  wakeArmOffered,
  wakeArmTimeoutMs,
  type WakeArmInput,
  type WakeArmSurface,
} from "../agent/channels/wake-arm.js";
import { registerConfig, type AppConfig } from "../agent/access/config.js";

let finished = false;
process.on("exit", (code) => {
  if (code === 0 && !finished) {
    console.error("✗ wake-arm: the process exited before the end of the file — a leg awaited something that never settled");
    process.exitCode = 1;
  }
});

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (actual: unknown, expected: unknown, label: string) => {
  assert.deepEqual(actual, expected, label);
  n++;
};

function withArm(decideWake?: AppConfig["decideWake"]): void {
  registerConfig({ decideWake } as unknown as AppConfig);
}

const msg = (over: Partial<Parameters<typeof wakeAfterArm>[1]> = {}) => ({
  surface: "slack" as WakeArmSurface,
  text: "the invoice for august looks wrong",
  channelId: "C1",
  authorId: "U1",
  ...over,
});

async function captureWarn<T>(body: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    return { value: await body(), warnings };
  } finally {
    console.warn = original;
  }
}

eq(await wakeAfterArm({ wakes: false, abstained: true }, msg()), false, "[1] no app config registered ⇒ the built-in answer (no wake)");
eq(await wakeAfterArm({ wakes: true, abstained: false }, msg()), true, "[1] …and a built-in wake still wakes with no config registered");
eq(wakeArmOffered("slack"), false, "[1] wakeArmOffered is false with no config registered — the route keeps today's early return");

withArm(undefined);
eq(await wakeAfterArm({ wakes: false, abstained: true }, msg()), false, "[1] a registered config with NO arm ⇒ the built-in answer");
eq(await wakeAfterArm({ wakes: true, abstained: false }, msg()), true, "[1] …and a built-in wake wakes");
eq(wakeArmOffered("slack"), false, "[1] wakeArmOffered is false with no arm registered");

{
  const calls: WakeArmInput[] = [];
  withArm((input) => {
    calls.push(input);
    return "abstain";
  });
  eq(await wakeAfterArm({ wakes: true, abstained: false }, msg()), true, "🔴 [2] a name-drop wake stands — an arm cannot suppress it");
  eq(calls.length, 0, "🔴 [2] …and the arm was never CALLED: the unsafe move is unreachable, not refused");

  eq(await wakeAfterArm({ wakes: true, abstained: true }, msg()), true, "🔴 [2] `wakes` wins over `abstained` — the wake branch is first");
  eq(calls.length, 0, "🔴 [2] …and still no consult");

  eq(await wakeAfterArm({ wakes: false, abstained: true }, msg()), false, "[2] control: on an abstention the arm runs and its `abstain` stands");
  eq(calls.length, 1, "🔴 [2] control: …and it recorded exactly one call, so the zero above is meaningful");
}

{
  const calls: WakeArmInput[] = [];
  withArm((input) => {
    calls.push(input);
    return "wake";
  });
  eq(await wakeAfterArm({ wakes: false, abstained: false }, msg()), false, "🔴 [3] a POLICY drop stays dropped — an arm cannot overturn it");
  eq(calls.length, 0, "🔴 [3] …and the arm was never called on it");

  eq(await wakeAfterArm({ wakes: false, abstained: true }, msg()), true, "🔴 [3] control: the same arm DOES add a wake on an abstention");
  eq(calls.length, 1, "🔴 [3] control: …with exactly one consult, so the zero above is meaningful");
}

{
  const calls: WakeArmInput[] = [];
  withArm((input) => {
    calls.push(input);
    return "wake";
  });

  const declining = (Object.keys(WAKE_ARM_SURFACE_CONTRACT) as WakeArmSurface[]).filter(
    (s) => !WAKE_ARM_SURFACE_CONTRACT[s].offers,
  );
  ok(declining.length > 0, "[4] control: at least one surface declines the seam, so the loop below tests something");
  for (const surface of declining) {
    eq(
      await wakeAfterArm({ wakes: false, abstained: true }, msg({ surface })),
      false,
      `🔴 [4] surface "${surface}" DECLINES the seam — an abstention there is not offered to an arm`,
    );
    eq(wakeArmOffered(surface), false, `[4] …and wakeArmOffered("${surface}") is false even with an arm registered`);
  }
  eq(calls.length, 0, "🔴 [4] …the arm recorded not one call across every declining surface");

  eq(wakeArmOffered("slack"), true, "[4] control: the OFFERING surface reports true with an arm registered");
  eq(await wakeAfterArm({ wakes: false, abstained: true }, msg()), true, "[4] control: …and an abstention there does reach the arm");
  eq(calls.length, 1, "🔴 [4] control: …so the zero above is a fact about the declining surfaces");

  const got = calls[0] as WakeArmInput;
  eq(got.surface, "slack", "[4] the arm is told which surface it is answering about");
  eq(got.text, "the invoice for august looks wrong", "[4] …and Slack declares `text`, so the arm receives it");
  eq(got.channelId, "C1", "[4] …`channelId`, declared, so the arm receives it");
  eq(got.authorId, "U1", "[4] …and `authorId`, declared, so the arm receives it");
  eq(
    WAKE_ARM_SURFACE_CONTRACT.slack.fields.slice().sort(),
    ["authorId", "channelId", "text"],
    "[4] Slack's declared field set is exactly the three that arrived above",
  );

  {
    const narrowed: WakeArmInput[] = [];
    withArm((input) => {
      narrowed.push(input);
      return "abstain";
    });
    _setWakeArmSurfaceContractForTest({
      slack: { offers: true, fields: ["text"], note: "test: text only" },
    });
    await wakeAfterArm({ wakes: false, abstained: true }, msg());
    _resetWakeArmSurfaceContractForTest();
    eq(narrowed.length, 1, "[4] control: the narrowed declaration still offers the seam, so the arm ran");
    eq(narrowed[0].text, "the invoice for august looks wrong", "[4] …the DECLARED field still arrives");
    eq(narrowed[0].channelId, undefined, "🔴 [4] …and an UNDECLARED field arrives undefined, though the route passed it");
    eq(narrowed[0].authorId, undefined, "🔴 [4] …for every undeclared field, not just the first");

    narrowed.length = 0;
    _setWakeArmSurfaceContractForTest({ slack: { offers: true, fields: [], note: "test: nothing declared" } });
    await wakeAfterArm({ wakes: false, abstained: true }, msg());
    _resetWakeArmSurfaceContractForTest();
    eq(narrowed.length, 1, "[4] control: a fields-less OFFERING declaration still calls the arm");
    eq(narrowed[0].text, "", "🔴 [4] …and a surface that declares no `text` hands the arm none");
  }

  {
    const unknown = "mattermost" as WakeArmSurface;
    _setWakeArmSurfaceContractForTest({});
    eq(await wakeAfterArm({ wakes: false, abstained: true }, msg({ surface: unknown })), false, "🔴 [4] an UNKNOWN surface declines — no throw, the built-in answer");
    eq(await wakeAfterArm({ wakes: true, abstained: false }, msg({ surface: unknown })), true, "🔴 [4] …and a built-in wake on an unknown surface still wakes");
    eq(wakeArmOffered(unknown), false, "🔴 [4] …and wakeArmOffered answers false for it rather than throwing");
    _resetWakeArmSurfaceContractForTest();
    eq(wakeArmOffered("slack"), true, "[4] control: the test seam was restored — Slack offers again");
  }

  {
    try {
      (WAKE_ARM_SURFACE_CONTRACT.discord as { offers: boolean }).offers = true;
    } catch {
    }
    eq(WAKE_ARM_SURFACE_CONTRACT.discord.offers, false, "🔴 [4] the shipped declaration is FROZEN — a package cannot flip a decline at runtime");
  }
  for (const surface of declining) {
    eq(WAKE_ARM_SURFACE_CONTRACT[surface].fields, [], `[4] a declining surface declares NO fields ("${surface}")`);
    ok(WAKE_ARM_SURFACE_CONTRACT[surface].note.length > 0, `[4] …and says why it declines ("${surface}")`);
  }
}

{
  const abstained = { wakes: false, abstained: true } as const;

  withArm(() => "abstain");
  eq(await wakeAfterArm(abstained, msg()), false, "[5] a deliberate `abstain` leaves the built-in answer");

  withArm(() => undefined);
  eq(await wakeAfterArm(abstained, msg()), false, "[5] a deliberate `undefined` leaves the built-in answer");

  {
    const { value, warnings } = await captureWarn(async () => {
      withArm(() => "abstain");
      const a = await wakeAfterArm(abstained, msg());
      withArm(() => undefined);
      const b = await wakeAfterArm(abstained, msg());
      return [a, b];
    });
    eq(value, [false, false], "[5] control: both deliberate abstentions still answer no-wake");
    eq(warnings, [], "🔴 [5] …and NEITHER notes: a deliberate defer is not a defect");
  }

  {
    const { value, warnings } = await captureWarn(async () => {
      withArm(() => {
        throw new Error("arm exploded");
      });
      return wakeAfterArm(abstained, msg());
    });
    eq(value, false, "🔴 [5] a THROWING arm leaves the built-in answer");
    eq(warnings.length, 1, "[5] …and notes exactly once");
    ok(warnings[0].includes("threw"), "[5] …naming the failure");
  }

  {
    const { value, warnings } = await captureWarn(async () => {
      withArm((() => 42) as unknown as AppConfig["decideWake"]);
      return wakeAfterArm(abstained, msg());
    });
    eq(value, false, "🔴 [5] a NON-STRING answer leaves the built-in answer");
    eq(warnings.length, 1, "[5] …and notes exactly once");
  }

  {
    const { value, warnings } = await captureWarn(async () => {
      withArm((() => "Wake") as unknown as AppConfig["decideWake"]);
      return wakeAfterArm(abstained, msg());
    });
    eq(value, false, "🔴 [5] a string OUTSIDE the vocabulary (`\"Wake\"`) leaves the built-in answer");
    eq(warnings.length, 1, "[5] …and notes exactly once");
  }

  {
    eq(wakeArmTimeoutMs(), 8000, "[5] the shipped arm timeout is 8s — the same budget the result-reducing seam gives");
    _setWakeArmTimeoutMsForTest(20);
    const { value, warnings } = await captureWarn(async () => {
      withArm(() => new Promise<"wake">(() => {}));
      return wakeAfterArm(abstained, msg());
    });
    _resetWakeArmTimeoutMsForTest();
    eq(value, false, "🔴 [5] a HUNG arm times out to the built-in answer");
    eq(warnings.length, 1, "[5] …and notes exactly once");
    ok(warnings[0].includes("exceeded"), "[5] …naming the timeout");
    eq(wakeArmTimeoutMs(), 8000, "[5] …and the test seam restored the production timeout");
  }

  withArm(() => "wake");
  eq(await wakeAfterArm(abstained, msg()), true, "🔴 [5] control: a WORKING arm adds the wake on the same input");
}

{
  let seen = -1;
  withArm((input) => {
    seen = input.text.length;
    return "abstain";
  });
  const huge = "x".repeat(WAKE_ARM_MAX_TEXT_CHARS * 3);
  await wakeAfterArm({ wakes: false, abstained: true }, msg({ text: huge }));
  eq(seen, WAKE_ARM_MAX_TEXT_CHARS, `🔴 [6] an over-long message is clipped to ${WAKE_ARM_MAX_TEXT_CHARS} characters before the arm sees it`);
  ok(huge.length > WAKE_ARM_MAX_TEXT_CHARS, "[6] control: the input really was longer than the cap");

  const short = "hi";
  await wakeAfterArm({ wakes: false, abstained: true }, msg({ text: short }));
  eq(seen, short.length, "[6] …and an ordinary message reaches the arm whole");
}

{
  withArm(async (): Promise<"wake"> => {
    await new Promise((r) => setTimeout(r, 1));
    return "wake";
  });
  eq(await wakeAfterArm({ wakes: false, abstained: true }, msg()), true, "[7] an ASYNC arm's `wake` is honoured");
  withArm(async (): Promise<"abstain"> => "abstain");
  eq(await wakeAfterArm({ wakes: false, abstained: true }, msg()), false, "[7] …and an async `abstain` leaves the built-in answer");
}

finished = true;
console.log(`✓ wake-arm: ${n} assertions passed`);

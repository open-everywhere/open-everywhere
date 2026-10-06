import { expect, test } from "vitest";
import { holdScriptedCall, type ScriptedHolds, type ScriptedStep } from "../../agent/model/scripted-model";
import { signalAwareMockModel } from "../../agent/model/scripted-resolve";

const BACKSTOP_MS = 5_000;

function freshHolds(): ScriptedHolds {
  return { released: false, cutShort: 0, cancelDelivered: 0, wakers: new Set() };
}

function release(holds: ScriptedHolds): void {
  holds.released = true;
  for (const wake of [...holds.wakers]) wake();
}

async function within(p: Promise<void>, ms: number): Promise<"ended" | "held"> {
  return Promise.race([p.then(() => "ended" as const), new Promise<"held">((r) => setTimeout(() => r("held"), ms))]);
}

test("① a barrier hold does NOT end on the release alone — it ends when the call is also aborted", async () => {
  const holds = freshHolds();
  const abort = new AbortController();
  const step: ScriptedStep = { say: "held", delayMs: BACKSTOP_MS, holdUntilCancelled: true };
  const held = holdScriptedCall(holds, step, abort.signal);

  release(holds);
  expect(await within(held, 200)).toBe("held");
  expect(holds.cutShort).toBe(0);

  abort.abort();
  expect(holds.cutShort).toBe(1);
  expect(holds.cancelDelivered).toBe(1);
  expect(await within(held, 200)).toBe("ended");
  expect(holds.wakers.size).toBe(0);
});

test("① the abort first, then the release — the hold ends on the release, with the cancel delivered", async () => {
  const holds = freshHolds();
  const abort = new AbortController();
  const held = holdScriptedCall(holds, { say: "held", delayMs: BACKSTOP_MS, holdUntilCancelled: true }, abort.signal);

  abort.abort();
  expect(await within(held, 200)).toBe("held");
  release(holds);
  expect(holds.cutShort).toBe(1);
  expect(holds.cancelDelivered).toBe(1);
  expect(await within(held, 200)).toBe("ended");
});

test("① NEGATIVE CONTROL — a plain hold (no barrier) still ends on the release alone, cancel not delivered", async () => {
  const holds = freshHolds();
  const abort = new AbortController();
  const held = holdScriptedCall(holds, { say: "held", delayMs: BACKSTOP_MS }, abort.signal);

  release(holds);
  expect(await within(held, 200)).toBe("ended");
  expect(holds.cutShort).toBe(1);
  expect(holds.cancelDelivered).toBe(0);
});

test("① NEGATIVE CONTROL — a barrier hold that is never aborted ends only at its backstop, and counts no release", async () => {
  const holds = freshHolds();
  const held = holdScriptedCall(holds, { say: "held", delayMs: 300, holdUntilCancelled: true }, new AbortController().signal);
  release(holds);
  expect(await within(held, 100)).toBe("held");
  expect(await within(held, 1_000)).toBe("ended");
  expect(holds.cutShort).toBe(0);
  expect(holds.cancelDelivered).toBe(0);
  expect(holds.wakers.size).toBe(0);
});

test("② eve's mockModel hands the call's own abort signal to the scripted responder", async () => {
  const seen: (AbortSignal | undefined)[] = [];
  const model = signalAwareMockModel({
    respond: async (_request, signal) => {
      seen.push(signal);
      return { text: "ok" };
    },
  }) as unknown as {
    doGenerate: (o: unknown) => Promise<unknown>;
    doStream: (o: unknown) => Promise<unknown>;
  };
  const prompt = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
  const a = new AbortController();
  const b = new AbortController();
  await model.doGenerate({ prompt, abortSignal: a.signal });
  await model.doStream({ prompt, abortSignal: b.signal });
  await model.doGenerate({ prompt });
  expect(seen).toHaveLength(3);
  expect(seen[0]).toBe(a.signal);
  expect(seen[1]).toBe(b.signal);
  expect(seen[2]).toBeUndefined();
});

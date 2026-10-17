import { defineState } from "eve/context";
import type { TestRunStamp } from "../routines/test-run.js";
import { readWakeSlot, writeWakeSlot } from "./wake-slot.js";

const SLOT = "open-everywhere.routine-test-run";
const slot = defineState<TestRunStamp | null>(SLOT, () => null);

const UNREADABLE: TestRunStamp = { testId: "unreadable", routineId: "", surfaceKey: "", org: "default" };

export function markTestRunSession(stamp: TestRunStamp): void {
  writeWakeSlot(SLOT, () => slot.update(() => stamp));
}

const COUNT_SLOT = "open-everywhere.routine-test-run.blocked";
const countSlot = defineState<number>(COUNT_SLOT, () => 0);

export function noteTestRunBlocked(): void {
  try {
    countSlot.update((n) => n + 1);
  } catch {
  }
}

export function testRunBlockedCount(): number {
  try {
    return countSlot.get();
  } catch {
    return 0;
  }
}

export function currentTestRun(): TestRunStamp | null {
  return readWakeSlot<TestRunStamp | null>(SLOT, () => slot.get(), { contextless: null, restricting: UNREADABLE });
}

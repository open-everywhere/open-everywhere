import { processRegistryMap } from "../lib/process-registry.js";

export type TestValve = "egress-spoof" | "scripted-model" | "memory-eval";

function valves(): Map<string, boolean> {
  return processRegistryMap<boolean>("test-valves.v1");
}

export function testValveArmed(valve: TestValve): boolean {
  return valves().get(valve) === true;
}

export function __setTestValveForTest(valve: TestValve, armed: boolean): void {
  if (armed) valves().set(valve, true);
  else valves().delete(valve);
}

const key = Symbol.for("open-everywhere.test-valves.v1");
const existing = globalThis[key];
const valves = existing instanceof Map ? existing : new Map();
globalThis[key] = valves;
valves.set("egress-spoof", true);

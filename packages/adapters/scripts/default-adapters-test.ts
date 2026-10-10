import assert from "node:assert/strict";
import { decideStoreWiring, registerDefaultAdapters, type StoreWiring } from "../agent/register-defaults.js";
import { pinSuiteStore } from "../../core/scripts/_suite-store.js";
import { registeredBootNoticeNames } from "@open-everywhere/core/agent/adapter-api.js";

pinSuiteStore("default-adapters");

let n = 0;
function eq(actual: StoreWiring, expected: StoreWiring, label: string): void {
  assert.deepEqual(actual, expected, label);
  n++;
}

const URL = "postgres://app@db.invalid/app";

eq(
  decideStoreWiring({ DATABASE_URL: URL }, true, false),
  { operational: { id: "postgres", floor: "none" }, neon: true, pgliteFloor: false },
  "🔴 Neon Marketplace env on Vercel (DATABASE_URL only): the Neon gate opens",
);
eq(
  decideStoreWiring({ DATABASE_URL: URL }, false, false),
  { operational: { id: "postgres", floor: "none" }, neon: true, pgliteFloor: false },
  "DATABASE_URL only, off Vercel: the Neon gate opens, no floor",
);
eq(
  decideStoreWiring({}, false, false),
  { operational: { id: "postgres", floor: "pglite" }, neon: false, pgliteFloor: true },
  "bare env off Vercel: the PGlite floor arms, Neon stays shut",
);
eq(
  decideStoreWiring({}, true, false),
  { operational: { id: "postgres", floor: "pglite" }, neon: false, pgliteFloor: false },
  "bare env on Vercel: the per-instance floor does NOT arm",
);
eq(
  decideStoreWiring({}, true, true),
  { operational: { id: "postgres", floor: "pglite" }, neon: false, pgliteFloor: true },
  "bare env on Vercel with the single-instance escape (storage.allowEphemeralOperational): the floor arms",
);
eq(
  decideStoreWiring({ OE_ALLOW_EPHEMERAL_OPERATIONAL: "1" }, true, false),
  { operational: { id: "postgres", floor: "pglite" }, neon: false, pgliteFloor: false },
  "🔴 the retired env var opens nothing (OPE-2411): only the setting is the escape",
);
eq(
  decideStoreWiring({ OE_OPERATIONAL_PROVIDER: "sqlite" }, false, false),
  { operational: { id: "sqlite", floor: "sqlite" }, neon: false, pgliteFloor: false },
  "an explicit sqlite selection: no floor, no Neon",
);
eq(
  decideStoreWiring({ OE_OPERATIONAL_PROVIDER: "postgres" }, false, false),
  { operational: { id: "postgres", floor: "none" }, neon: false, pgliteFloor: false },
  "postgres named without DATABASE_URL: Neon cannot build a driver, and the floor does not mask the gap",
);
eq(
  decideStoreWiring({ OE_OPERATIONAL_PROVIDER: "sqlite", DATABASE_URL: URL }, false, false),
  { operational: { id: "sqlite", floor: "sqlite" }, neon: true, pgliteFloor: false },
  "sqlite operational store with DATABASE_URL: memory still selects postgres, so Neon registers",
);
eq(
  decideStoreWiring({ OE_OPERATIONAL_PROVIDER: "sqlite", OE_MEMORY_PROVIDER: "sqlite", DATABASE_URL: URL }, false, false),
  { operational: { id: "sqlite", floor: "sqlite" }, neon: false, pgliteFloor: false },
  "both stores named away from postgres: Neon stays shut even with DATABASE_URL",
);

{
  const options = { providers: [], memory: { domains: () => [], silos: () => [], grants: () => null } };
  const first = registerDefaultAdapters(options);
  let second: Promise<unknown> | undefined;
  assert.doesNotThrow(() => {
    second = registerDefaultAdapters(options);
  }, "🔴 a second call in the same process does not throw");
  assert.equal(second, first, "🔴 …and returns the first call's promise, so the wiring does not run twice");
  await first.catch(() => undefined);
  assert.ok(registeredBootNoticeNames().includes("approval-judge-no-rules"), "🔴 the default wiring registers the judge-without-rules boot notice (OPE-2400)");
}

console.log(`✓ default-adapters: ${n} store-decision cases, plus the once-per-process row`);

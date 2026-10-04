process.env.OE_SQLITE_PATH = ":memory:";
delete process.env.DATABASE_URL;
delete process.env.OE_OPERATIONAL_PROVIDER;

import assert from "node:assert/strict";

import {
  SURFACE_EVENT_STAMP_PERIOD_MS,
  SURFACE_EVENT_VERIFIED_META_PREFIX,
  _resetSurfaceEventStampMemoForTest,
  stampSurfaceEventVerified,
  surfaceEventVerifiedAt,
  surfaceEventVerifiedMetaKey,
} from "../agent/operational/surface-evidence.js";
import { getOperationalStore } from "../agent/operational/provider.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const T0 = Date.parse("2026-10-03T12:00:00.000Z");

{
  _resetSurfaceEventStampMemoForTest();
  const store = getOperationalStore();
  ok((await surfaceEventVerifiedAt("slack")) === null, "§1 a fresh store holds no evidence, and says so with null");
  ok((await stampSurfaceEventVerified("slack", { now: () => T0 })) === true, "§1 the first verified delivery writes the stamp");
  ok((await surfaceEventVerifiedAt("slack")) === new Date(T0).toISOString(), "§1 the stamp reads back as the instant it wrote");
  ok((await store.getMeta(`${SURFACE_EVENT_VERIFIED_META_PREFIX}slack`)) === new Date(T0).toISOString(), "§1 it lives in instance_meta under the documented key");
  ok((await surfaceEventVerifiedAt("discord")) === null, "§1 one platform's stamp is not another's evidence");
}

{
  _resetSurfaceEventStampMemoForTest();
  const writes: string[] = [];
  const store = {
    getMeta: async () => null,
    setMeta: async (_k: string, v: string) => {
      await new Promise((r) => setTimeout(r, 5));
      writes.push(v);
    },
  };
  const burst = await Promise.all(Array.from({ length: 6 }, () => stampSurfaceEventVerified("slack", { store, now: () => T0 })));
  ok(writes.length === 1 && burst.filter(Boolean).length === 1, "§2 a concurrent burst of six verified deliveries writes ONCE");
  ok((await stampSurfaceEventVerified("slack", { store, now: () => T0 + SURFACE_EVENT_STAMP_PERIOD_MS - 1 })) === false, "§2 a delivery inside the period writes nothing");
  ok(writes.length === 1, "§2 …and the store saw no second write");
  ok((await stampSurfaceEventVerified("slack", { store, now: () => T0 + SURFACE_EVENT_STAMP_PERIOD_MS })) === true, "§2 the first delivery after the period refreshes the stamp");
  ok(writes[1] === new Date(T0 + SURFACE_EVENT_STAMP_PERIOD_MS).toISOString(), "§2 …with the newer instant");
  ok((await stampSurfaceEventVerified("discord", { store, now: () => T0 + 1 })) === true, "§2 the debounce is per platform: another surface still writes");
}

{
  _resetSurfaceEventStampMemoForTest();
  let fail = true;
  let writes = 0;
  const store = {
    getMeta: async () => {
      throw new Error("store down");
    },
    setMeta: async () => {
      if (fail) throw new Error("store down");
      writes++;
    },
  };
  ok((await stampSurfaceEventVerified("slack", { store, now: () => T0 })) === false, "§3 a throwing write resolves false — it never rejects into the delivery");
  fail = false;
  ok((await stampSurfaceEventVerified("slack", { store, now: () => T0 + 1 })) === true && writes === 1, "§3 a failed write releases the debounce, so the next verified delivery retries at once");
  ok((await surfaceEventVerifiedAt("slack", { store })) === null, "§3 a throwing read is no evidence (null), never an exception");
  const junk = { getMeta: async () => "not-an-instant", setMeta: async () => {} };
  ok((await surfaceEventVerifiedAt("slack", { store: junk })) === null, "§3 a value that is not an ISO instant is no evidence");
}

{
  _resetSurfaceEventStampMemoForTest();
  let writes = 0;
  const store = { getMeta: async () => null, setMeta: async () => void writes++ };
  for (const bad of ["", "Slack", "slack:x", "../slack", "a".repeat(33)]) {
    assert.throws(() => surfaceEventVerifiedMetaKey(bad), /not a platform id/, `§4 "${bad}" is refused as a platform id`);
    n++;
    ok((await stampSurfaceEventVerified(bad, { store })) === false, `§4 a stamp for "${bad}" writes nothing`);
  }
  ok(writes === 0, "§4 no malformed id reached the store");
}

_resetSurfaceEventStampMemoForTest();
console.log(`✓ surface-evidence: ${n} assertions passed`);

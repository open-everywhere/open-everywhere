import assert from "node:assert/strict";
import { platformName, onVercel } from "../agent/access/platform.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

{
  withEnv({ VERCEL: undefined, OE_PLATFORM: undefined }, () => {
    ok(platformName() === "self-host", "platformName() defaults to self-host when unset");
    ok(!onVercel(), "onVercel() false when VERCEL and OE_PLATFORM are both unset");
  });
  withEnv({ VERCEL: "1", OE_PLATFORM: undefined }, () => {
    ok(platformName() === "vercel", "platformName() reads process.env.VERCEL by default");
    ok(onVercel(), "onVercel() true when VERCEL is set and no override");
  });
}

{
  for (const label of ["self-host", "vercel", "  Vercel  ", "railway", "local", ""]) {
    withEnv({ VERCEL: "1", OE_PLATFORM: label }, () => {
      ok(platformName() === "vercel" && onVercel(), `OE_PLATFORM=${JSON.stringify(label)} does NOT turn a Vercel host into a self-host`);
    });
    withEnv({ VERCEL: undefined, OE_PLATFORM: label }, () => {
      ok(platformName() === "self-host" && !onVercel(), `OE_PLATFORM=${JSON.stringify(label)} does NOT turn a self-host into Vercel`);
    });
  }
}

console.log(`platform-test: ${n} assertions passed`);

// proves: AP-MOD-core-access-platform

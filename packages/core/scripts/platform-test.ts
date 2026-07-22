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
  withEnv({ VERCEL: "1", OE_PLATFORM: "self-host" }, () => {
    ok(platformName() === "self-host", "OE_PLATFORM=self-host overrides VERCEL=1");
    ok(!onVercel(), "onVercel() false when OE_PLATFORM forces self-host despite VERCEL=1");
  });
  withEnv({ VERCEL: undefined, OE_PLATFORM: "vercel" }, () => {
    ok(platformName() === "vercel", "OE_PLATFORM=vercel overrides an unset VERCEL");
    ok(onVercel(), "onVercel() true when OE_PLATFORM forces vercel despite VERCEL unset");
  });
  withEnv({ VERCEL: undefined, OE_PLATFORM: "railway" }, () => {
    ok(platformName() === "railway", "an arbitrary OE_PLATFORM label passes through");
    ok(!onVercel(), "onVercel() false for a non-vercel OE_PLATFORM label");
  });
}

{
  withEnv({ VERCEL: undefined, OE_PLATFORM: "  Vercel  " }, () => {
    ok(platformName() === "vercel", "OE_PLATFORM is trimmed and lower-cased");
    ok(onVercel(), "onVercel() true after normalising a mixed-case OE_PLATFORM=Vercel");
  });
  withEnv({ VERCEL: undefined, OE_PLATFORM: "" }, () => {
    ok(platformName() === "self-host", "blank OE_PLATFORM is treated as unset");
  });
  withEnv({ VERCEL: undefined, OE_PLATFORM: "   " }, () => {
    ok(platformName() === "self-host", "whitespace-only OE_PLATFORM is treated as unset");
  });
}

console.log(`platform-test: ${n} assertions passed`);

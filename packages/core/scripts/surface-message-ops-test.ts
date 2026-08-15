import assert from "node:assert/strict";
import type { SurfaceMessageOps } from "../agent/channels/surface-message-ops.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const { registerSurfaceMessageOps, postSurfaceText } = await import("../agent/channels/surface-message-ops.js");

let calls = 0;
const throwingOps: SurfaceMessageOps = {
  platform: "surface-ops-test-platform",
  async postText() {
    calls++;
    throw new Error("SURFACE_OPS_TEST_TOKEN is not set — the notice needs a bot token to post.");
  },
  async editMessage() {
    throw new Error("not exercised by this test");
  },
  async postFiles() {
    throw new Error("not exercised by this test");
  },
};
registerSurfaceMessageOps(throwingOps);

const isSpoofId = (id: string | undefined) => typeof id === "string" && id.startsWith(`spoof-${throwingOps.platform}-`);

{
  delete process.env.OE_EGRESS_SPOOF;
  const id = await postSurfaceText(throwingOps.platform, { channelId: "C1", text: "hello" });
  ok(id === undefined, "1a. no spoof flag → the real vendor call is attempted and its failure surfaces as undefined");
  ok(calls === 1, "1b. no spoof flag → the registered postText WAS called (negative control: the real path still runs)");
}

{
  calls = 0;
  delete process.env.VERCEL;
  process.env.OE_EGRESS_SPOOF = "1";
  const id = await postSurfaceText(throwingOps.platform, { channelId: "C1", text: "hello" });
  ok(isSpoofId(id), `2a. spoofed → returns a spoof-${throwingOps.platform}-<ts> id, matching the reply/card-post legs' shape`);
  ok(calls === 0, "2b. spoofed → the registered postText was NEVER called (no real vendor call attempted)");
}

{
  calls = 0;
  process.env.OE_EGRESS_SPOOF = "1";
  process.env.VERCEL = "1";
  await assert.rejects(
    () => postSurfaceText(throwingOps.platform, { channelId: "C1", text: "hello" }),
    /OE_EGRESS_SPOOF is a local-eval flag — refusing on Vercel\./,
    "3a. spoofed on Vercel → throws rather than silently swallowing (the one enforced refusal)",
  );
  n++;
  ok(calls === 0, "3b. the Vercel refusal fires before the vendor call is ever attempted");
  delete process.env.VERCEL;
}

delete process.env.OE_EGRESS_SPOOF;

console.log(
  `✓ surface-message-ops (OPE-558) — ${n} assertions (notice leg now honours OE_EGRESS_SPOOF: skips the real vendor call, returns a spoof id, refuses on Vercel; negative control proves the un-spoofed path is unchanged)`,
);

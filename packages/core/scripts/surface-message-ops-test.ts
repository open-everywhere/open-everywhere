import { __setTestValveForTest } from "../agent/testing/test-valves.js";
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
  __setTestValveForTest("egress-spoof", false);
  const id = await postSurfaceText(throwingOps.platform, { channelId: "C1", text: "hello" });
  ok(id === undefined, "1a. no spoof flag → the real vendor call is attempted and its failure surfaces as undefined");
  ok(calls === 1, "1b. no spoof flag → the registered postText WAS called (negative control: the real path still runs)");
}

{
  calls = 0;
  delete process.env.VERCEL;
  __setTestValveForTest("egress-spoof", true);
  const id = await postSurfaceText(throwingOps.platform, { channelId: "C1", text: "hello" });
  ok(isSpoofId(id), `2a. spoofed → returns a spoof-${throwingOps.platform}-<ts> id, matching the reply/card-post legs' shape`);
  ok(calls === 0, "2b. spoofed → the registered postText was NEVER called (no real vendor call attempted)");
}

{
  calls = 0;
  __setTestValveForTest("egress-spoof", true);
  process.env.VERCEL = "1";
  await assert.rejects(
    () => postSurfaceText(throwingOps.platform, { channelId: "C1", text: "hello" }),
    /the egress-spoof test valve is a local-eval seam — refusing on Vercel\./,
    "3a. spoofed on Vercel → throws rather than silently swallowing (the one enforced refusal)",
  );
  n++;
  ok(calls === 0, "3b. the Vercel refusal fires before the vendor call is ever attempted");
  delete process.env.VERCEL;
}

__setTestValveForTest("egress-spoof", false);

{
  const { editSurfaceText } = await import("../agent/channels/surface-message-ops.js");
  const { registerSlackBridge, _resetSlackBridgeForTest } = await import("../agent/channels/slack-bridge.js");

  const sent: { method: string; body: URLSearchParams }[] = [];
  registerSlackBridge({
    async form(method: string, body: string) {
      sent.push({ body: new URLSearchParams(body), method });
      return { ok: true };
    },
  } as never);

  const landed = await editSurfaceText("slack", { channelId: "C-card", messageId: "1724.0001" }, "⌛ EXPIRED — this request timed out.");
  ok(landed, "4a. the Slack arm reports the edit landed");
  ok(sent.length === 1 && sent[0]?.method === "chat.update", "4b. …via chat.update, one call");

  const form = sent[0]!.body;
  const blocks = form.get("blocks");
  ok(blocks !== null, "4c. 🔴 the update SENDS blocks — without them chat.update keeps the old card's blocks and the owner sees the unchanged card");
  const parsed = JSON.parse(blocks ?? "[]") as { type: string; text?: { text?: string } }[];
  ok(parsed.length === 1 && parsed[0]?.type === "section", "4d. …exactly ONE section block, so any stale button row is replaced rather than left behind");
  ok(parsed[0]?.text?.text?.includes("EXPIRED") === true, "4e. …carrying the new text, which is what a reader actually sees");
  ok(form.get("text")?.includes("EXPIRED") === true, "4f. `text` still rides along as the notification fallback");
  ok(form.get("channel") === "C-card" && form.get("ts") === "1724.0001", "4g. …addressed at the message the caller named");

  ok((await editSurfaceText("no-such-platform", { channelId: "C1", messageId: "m1" }, "x")) === false, "4h. NEGATIVE CONTROL: an unregistered surface returns false rather than reporting a rewrite that never happened");
  ok((await editSurfaceText("slack", { channelId: "", messageId: "m1" }, "x")) === false, "4i. NEGATIVE CONTROL: an empty locus is refused before any vendor call");
  ok(sent.length === 1, "4j. …and neither of those issued a second Slack call");

  _resetSlackBridgeForTest();
}

console.log(
  `✓ surface-message-ops (OPE-558) — ${n} assertions (notice leg now honours the egress-spoof valve: skips the real vendor call, returns a spoof id, refuses on Vercel; negative control proves the un-spoofed path is unchanged)`,
);

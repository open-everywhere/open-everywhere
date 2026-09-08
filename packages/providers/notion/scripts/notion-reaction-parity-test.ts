import assert from "node:assert/strict";
import { isRegisteredReactionSurface, registerReactionSurface } from "@open-everywhere/core/agent/adapter-api.js";
import { NOTION_SURFACE_PARITY } from "../agent/surface-parity.js";
import { registerNotionProvider } from "../agent/register.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const cell = NOTION_SURFACE_PARITY["reaction-feedback-ingest"];

{
  ok(typeof cell === "object" && cell !== null && "unsupported" in cell, "notion declares reaction-feedback-ingest UNSUPPORTED");
  const reason = (cell as { unsupported: string }).unsupported;
  ok(reason.trim().length > 0, "…with a reason, never an empty string");
  ok(reason.startsWith("vendor limit"), "🔴 …and the reason is a PLATFORM limit, not a ticket — no run will ever close this row");
  ok(!/OPE-\d+/.test(reason), "negative control: the reason names no ticket, which would read as unbuilt work");
  ok(/no reaction event/i.test(reason) && /no reaction resource/i.test(reason), "…and it states BOTH halves: nothing to receive, nothing to poll");
}

{
  registerNotionProvider();
  ok(!isRegisteredReactionSurface("notion"), "the bundle registers NO reaction surface — the declaration and the code agree");
}

{
  registerReactionSurface("notion-parity-probe");
  ok(isRegisteredReactionSurface("notion-parity-probe"), "negative control: the registry DOES report a platform that registers");
  ok(!isRegisteredReactionSurface("notion"), "…and still reports notion as absent");
}

console.log(`✓ notion reaction parity: ${n} assertions`);

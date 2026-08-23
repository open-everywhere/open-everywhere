import assert from "node:assert/strict";
import {
  readChannelResult,
  readThreadResult,
  renderChannelBody,
  renderThreadBody,
  type ReadAdapter,
  type RenderedLine,
} from "../agent/channels/channel-read.js";
import type { BindableContext } from "../agent/identity/binding.js";

let n = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  n++;
}

const ctx = {} as BindableContext;
const READ_AT = "2026-01-16T13:12:00.000Z";
const OLD_TS = "2026-08-23T11:33:00.000Z";

function adapter(lines: readonly RenderedLine[]): ReadAdapter {
  return {
    platform: "linear",
    wakeAddress: () => undefined,
    readChannel: async () => lines,
    readThread: async () => lines,
  };
}

console.log("1. a dated page with a live line:");
{
  const lines: RenderedLine[] = [
    { author: "alice", ts: READ_AT, text: "Ship it [In Progress]", readAt: READ_AT, live: true },
    { author: "bob", ts: OLD_TS, text: "pending approval", readAt: READ_AT },
  ];
  const out = await readChannelResult(ctx, "linear", adapter(lines), "issue-1");
  const body = renderChannelBody(out);
  ok(body.includes("[bob] pending approval (27 minutes before this read)"), "🔴 a HISTORY line's age renders inline, next to the claim");
  ok(!body.includes("[alice] Ship it [In Progress] ("), "🔴 negative control: the LIVE line is never aged — it IS the current state, not a claim about one");
  ok(body.includes(`Read live at ${READ_AT}:`), "🔴 the provenance line fires — the payload distinguishes a live line from history");
  ok(body.includes("HISTORY"), "…and names the contrast the OPE-1012 soak fix needs stated");
  ok(body.includes("is not the present state"), "…word for word with the vendor tool's own ending clause");

  const thr = await readThreadResult(ctx, "linear", adapter(lines), "issue-1", "c1");
  const threadBody = renderThreadBody(thr);
  ok(threadBody.includes("(27 minutes before this read)"), "read_thread ages identically — one shared render, so the two verbs cannot drift");
}

console.log("2. an undated page:");
{
  const lines: RenderedLine[] = [{ author: "U1", ts: "1", text: "hello" }];
  const out = await readChannelResult(ctx, "slack", adapter(lines), "C1");
  const body = renderChannelBody(out);
  ok(
    body === "Recent messages in C1 (oldest first):\n[U1] hello",
    "🔴 negative control: an adapter with no readAt and no live line renders BYTE-IDENTICAL to before OPE-1039 — additive, never a behaviour change",
  );
}

console.log("3. dated but no live line:");
{
  const lines: RenderedLine[] = [{ author: "carol", ts: OLD_TS, text: "still open?", readAt: READ_AT }];
  const out = await readChannelResult(ctx, "notion", adapter(lines), "page-1");
  const body = renderChannelBody(out);
  ok(body.includes("(27 minutes before this read)"), "a page with readAt but no live line still ages every line");
  ok(!body.includes("Read live at"), "🔴 negative control: with NO live line the provenance sentence never fires — there is nothing to contrast history against");
}

console.log(`✓ ${n} dated-read assertions passed`);

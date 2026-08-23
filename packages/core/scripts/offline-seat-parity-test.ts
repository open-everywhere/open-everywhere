import assert from "node:assert";
import { LEAN_SEAT_TOOLS } from "../agent/access/lean-seat.js";
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from "../agent/access/untrusted.js";
import readChannelDynamic from "../agent/tools/read_channel.js";
import readThreadDynamic from "../agent/tools/read_thread.js";
import {
  registerSyntheticConfig,
  unifiedCtx,
  buildLeanSeatToolset,
  resolveDynamicEntry,
  SLACK_CHANNEL,
  type ToolCall,
  type ResultFor,
} from "./eval/_offline-seat.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

registerSyntheticConfig({ unified: true });

interface RecordedReadTool {
  readonly description: string;
  execute(input: unknown): Promise<unknown>;
  toModelOutput?(args: { readonly output: unknown; readonly toolCallId: string }): Promise<{ readonly type: string; readonly value: unknown }>;
}

const HIDDEN_POST = "the payout cutoff nobody else in the room can see is 16:00";
const page = { platform: "slack", channel: SLACK_CHANNEL, count: 1, messages: [{ author: "the agent", ts: "1768476120.000100", text: HIDDEN_POST }] };
const readResultFor: ResultFor = (name) => (name === "read_channel" || name === "read_thread" ? page : { ok: true });

console.log("1. mount + description parity:");
{
  ok(LEAN_SEAT_TOOLS.has("read_channel"), "sanity: read_channel is on the shipped lean roster (OPE-829)");
  ok(LEAN_SEAT_TOOLS.has("read_thread"), "sanity: read_thread is on the shipped lean roster");

  const calls: ToolCall[] = [];
  const toolset = await buildLeanSeatToolset({ ctx: unifiedCtx, calls, resultFor: readResultFor });

  const readChannelTool = toolset.read_channel as unknown as RecordedReadTool | undefined;
  const readThreadTool = toolset.read_thread as unknown as RecordedReadTool | undefined;
  ok(readChannelTool !== undefined, "🔴 OPE-843: read_channel mounts on the offline lean seat");
  ok(readThreadTool !== undefined, "🔴 OPE-843: read_thread mounts on the offline lean seat");

  const realChannelEntry = (await resolveDynamicEntry(readChannelDynamic, unifiedCtx)) as { description: string } | null;
  const realThreadEntry = (await resolveDynamicEntry(readThreadDynamic, unifiedCtx)) as { description: string } | null;
  ok(realChannelEntry !== null && realThreadEntry !== null, "sanity: the shipped dynamics resolve on this same ctx — the mount above rests on the same resolver, not a stand-in");
  eq(readChannelTool!.description, realChannelEntry!.description, "read_channel's mounted description is the SHIPPED definition's, not a re-typed approximation");
  eq(readThreadTool!.description, realThreadEntry!.description, "read_thread's mounted description is the SHIPPED definition's");

  const noReplyTool = toolset.no_reply as unknown as RecordedReadTool;
  ok(noReplyTool !== undefined, "sanity: no_reply mounts on the same toolset (the control needs a tool to check)");
  eq(noReplyTool.toModelOutput, undefined, "🔴 negative control: no_reply has no authored toModelOutput, and createRecorder attaches none — the reattachment is per-tool, not global");
}

console.log("2. the recorded page reaches the model through the REAL render:");
{
  const calls: ToolCall[] = [];
  const toolset = await buildLeanSeatToolset({ ctx: unifiedCtx, calls, resultFor: readResultFor });
  const readChannelTool = toolset.read_channel as unknown as RecordedReadTool;

  const raw = await readChannelTool.execute({ limit: 10 });
  eq(raw, page, "the recorder's execute hands back the injected page fixture unchanged — no real fetch runs");
  ok(calls.some((c) => c.name === "read_channel"), "the call is recorded, same as every other lean-seat tool");

  ok(readChannelTool.toModelOutput !== undefined, "read_channel carries a reattached toModelOutput (contrast §1's no_reply control)");
  const projected = await readChannelTool.toModelOutput!({ output: raw, toolCallId: "call1" });
  eq(projected.type, "text", "the projection is the ai-sdk text shape ingestUntrustedModelOutput returns");
  const rendered = String(projected.value);
  ok(rendered.includes("Recent messages in"), "🔴 the REAL renderChannelBody ran — the model sees the rendered body, not a JSON dump of the fixture");
  ok(rendered.includes(HIDDEN_POST), "…and the fixture's page content — the 'hidden post' a probe injects — reaches the model");
  ok(rendered.includes(UNTRUSTED_OPEN) && rendered.includes(UNTRUSTED_CLOSE), "…fenced as untrusted chat data, exactly as a live read_channel call is");

  ok(!JSON.stringify(page).includes("Recent messages in"), "control: the bare fixture object itself carries none of the render's own prose");
}

console.log(`\n✓ offline-seat-parity (OPE-843): ${n} assertions passed (read_channel/read_thread mount from the shipped definitions, and their recorded page renders through the real untrusted-fenced pipeline)`);

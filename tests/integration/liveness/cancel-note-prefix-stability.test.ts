import { expect, test } from "vitest";
import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { resolveTurnAnchor, turnChannelKey } from "@open-everywhere/core/agent/channels/turn-registry.js";
import { CONTROL_WRITE_TOOL_NAMES, registerControlWriteTools } from "@open-everywhere/core/agent/control/writes.js";
import {
  auditCursor,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  discordOeCommandPost,
  discordOeStopInteraction,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  seatReply,
  waitFor,
  waitForTurnCancelDelivered,
  type RecordedRequest,
} from "../harness";

const BOT_MENTION = "<@9000000000000000001>";
const HOLD_MS = 90_000;
const STOPPER_ID = "9000000000000000078";

function systemBlock(request: RecordedRequest): string {
  return request.messages
    .filter((m) => m.role === "system")
    .map((m) => m.text)
    .join("\n[system-message-boundary]\n");
}

function byteDivergence(before: string, after: string): string | undefined {
  if (before === after) return undefined;
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  const from = Math.max(0, i - 120);
  const show = (s: string) => JSON.stringify(s.slice(from, i + 160));
  return (
    `diverges at character ${i} of ${before.length} (before) / ${after.length} (after)\n` +
    `  before: …${show(before)}\n` +
    `  after:  …${show(after)}`
  );
}

function prefixDivergence(before: readonly RecordedRequest["messages"][number][], after: readonly RecordedRequest["messages"][number][]): string | undefined {
  if (after.length < before.length) {
    return `the message list SHRANK: ${before.length} message(s) before, ${after.length} after — history was dropped, not appended`;
  }
  for (let i = 0; i < before.length; i++) {
    const a = before[i]!;
    const b = after[i]!;
    if (a.role !== b.role) return `message ${i} changed ROLE: "${a.role}" before, "${b.role}" after`;
    if (a.text !== b.text) return `message ${i} (role "${a.role}") was REWRITTEN — ${byteDivergence(a.text, b.text)}`;
  }
  return undefined;
}

function controlWriteDescriptions(): ReadonlyMap<string, string> {
  const seen = new Map<string, string>();
  registerControlWriteTools(
    { registerTool: (name: string, spec: { description?: string }) => seen.set(name, spec.description ?? "") } as never,
    "ope1194-probe",
  );
  return seen;
}

test("a cancelled turn's system-prompt reminder is one clean insertion at a fixed point, and clears back to byte-identical — never a scattered rewrite of the prefix", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const channelKey = turnChannelKey("discord", DISCORD_LISTED_CHANNEL_ID)!;
  const cursor = await auditCursor();

  const a = disposeLater(registerScript({ parent: [seatReply("ack ope693a", "ope693-a-reply"), { say: NO_REPLY_SENTINEL }] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} ope693a`, messageId: "ope693-a" });
  const requestA = await waitFor(() => a.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "turn A's model call");
  expect(requestA.fault).toBeUndefined();
  await waitFor(() => a.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "turn A's closing step");
  a.dispose();

  const controlDescriptions = controlWriteDescriptions();
  expect([...controlDescriptions.keys()].sort()).toEqual([...CONTROL_WRITE_TOOL_NAMES].sort());
  expect(controlDescriptions.get("set_domain_model")!.length, "set_domain_model's description no longer exceeds its OPE-1194 base length (868) plus the ~340 characters the old warning named, so this file stopped driving that boundary").toBeGreaterThanOrEqual(1208);
  const carriesControlWrites = (r: Pick<RecordedRequest, "toolDefinitions">): string | undefined => {
    const whole = JSON.stringify(r);
    for (const [name, description] of controlDescriptions) {
      const needle = JSON.stringify(description).slice(1, -1);
      if (needle.length > 0 && whole.includes(needle)) return `carries ${name}'s control-plane description verbatim`;
    }
    return undefined;
  };
  expect(
    carriesControlWrites({ toolDefinitions: [{ name: "set_domain_model", description: controlDescriptions.get("set_domain_model")! }] }),
    "the matcher cannot see set_domain_model's description even when it IS present — every absence assertion below is vacuous",
  ).toBeDefined();
  expect(carriesControlWrites(requestA), "turn A's model call reaches the control plane's tool text").toBeUndefined();

  const b = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "update_status", input: { state: "working", summary: "ope-693 in-flight work" }, id: "ope693-ran" }] },
        { say: NO_REPLY_SENTINEL, delayMs: HOLD_MS },
      ],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} ope693b`, messageId: "ope693-b" });
  const inFlight = await waitFor(() => b.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "turn B's second model call, held open");
  expect(inFlight.fault).toBeUndefined();
  const cancelledTurnId = inFlight.turnId;

  const anchor = await waitFor(
    async () => (await resolveTurnAnchor(org, { channelKey })) ?? undefined,
    "the turn-anchor row for the in-flight turn (hooks/turn-anchor.ts `turn.started`)",
  );
  expect(anchor.turnId).toBe(cancelledTurnId);

  const stop = await discordOeCommandPost(discordOeStopInteraction({ channelId: DISCORD_LISTED_CHANNEL_ID, userId: STOPPER_ID }));
  expect(stop.status, `the stop command was refused: ${stop.body}`).toBe(200);
  expect(stop.body).toContain("Standing down");
  await waitForTurnCancelDelivered(anchor.sessionId);
  b.releaseHolds();
  b.dispose();

  await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["turn.cancelled", "turn.stop_ignored"]);
    const ignored = rows.find((r) => r.action === "turn.stop_ignored" && r.detail?.turnId === cancelledTurnId);
    if (ignored !== undefined) {
      throw new Error(
        `eve DROPPED this cancel (OPE-1190): a turn.stop_ignored row for turn ${String(ignored.detail?.turnId)} says the stop was accepted and the turn then ` +
          `ended as "${String(ignored.detail?.endedAs)}" with no cancellation settled. No reconstruction was written, so turn C below could never carry one. ` +
          `This is the cancel-path race, not a slow box and not this file's own defect — tests/integration/liveness/stop-evidence.test.ts is the leg that passes on both branches.`,
      );
    }
    return rows.length > 0 ? rows : undefined;
  }, "the turn.cancelled row — the cancel arm has run and the reconstruction is pending");
  const anchorAfterCancel = await resolveTurnAnchor(org, { channelKey });
  expect(anchorAfterCancel?.turnId, `the cancelled turn's anchor row is still live: ${JSON.stringify(anchorAfterCancel)}`).not.toBe(cancelledTurnId);
  expect(b.holdsCutShort()).toBe(1);

  const c = disposeLater(registerScript({ parent: [seatReply("ack ope693c", "ope693-c-reply"), { say: NO_REPLY_SENTINEL }] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} ope693c`, messageId: "ope693-c" });
  const requestC = await waitFor(
    () => c.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes("was CANCELLED"))),
    "turn C's model call, carrying the cancel reminder",
  );
  expect(requestC.fault).toBeUndefined();
  await waitFor(() => c.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "turn C's closing step");
  c.dispose();

  const d = disposeLater(registerScript({ parent: [seatReply("ack ope693d", "ope693-d-reply"), { say: NO_REPLY_SENTINEL }] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} ope693d`, messageId: "ope693-d" });
  const requestD = await waitFor(() => d.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "turn D's model call");
  expect(requestD.fault).toBeUndefined();
  await waitFor(() => d.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "turn D's closing step");
  d.dispose();

  expect(new Set([requestA.sessionId, requestC.sessionId, requestD.sessionId]).size).toBe(1);
  expect(requestA.sessionId).toBeTypeOf("string");

  expect(carriesControlWrites(requestC), "turn C's model call reaches the control plane's tool text").toBeUndefined();
  expect(carriesControlWrites(requestD), "turn D's model call reaches the control plane's tool text").toBeUndefined();
  const defs = (r: RecordedRequest) => JSON.stringify(r.toolDefinitions);
  expect(defs(requestA).length, "turn A was offered no tools at all — the tool-block comparison below is vacuous").toBeGreaterThan(2);
  expect(defs(requestC), "the tool block changed across the cancel — turn C's differs from turn A's").toBe(defs(requestA));
  expect(defs(requestD), "the tool block changed across the clear — turn D's differs from turn A's").toBe(defs(requestA));

  const sysA = systemBlock(requestA);
  const sysC = systemBlock(requestC);
  const sysD = systemBlock(requestD);

  let commonPrefixLen = 0;
  while (commonPrefixLen < sysA.length && commonPrefixLen < sysC.length && sysA[commonPrefixLen] === sysC[commonPrefixLen]) commonPrefixLen++;
  expect(commonPrefixLen, "turn A and turn C share NO common prefix at all").toBeGreaterThan(0);
  expect(sysC.length, "turn C's system is no longer than turn A's — the cancel note did not render").toBeGreaterThan(sysA.length);
  const tailA = sysA.slice(commonPrefixLen);
  const reappearsAt = tailA === "" ? sysC.length : sysC.indexOf(tailA, commonPrefixLen);
  expect(reappearsAt, "turn A's post-divergence tail does not reappear verbatim anywhere later in turn C — this is a REWRITE, not a clean insertion").toBeGreaterThanOrEqual(0);
  const inserted = sysC.slice(commonPrefixLen, reappearsAt);
  expect(inserted, "the inserted block does not carry the cancel reconstruction").toContain("was CANCELLED");
  expect(inserted.trimStart().startsWith("<system-reminder>"), `the inserted block is not cleanly delimited at its start: ${JSON.stringify(inserted.slice(0, 40))}`).toBe(true);
  expect(inserted.trimEnd().endsWith("</system-reminder>"), `the inserted block is not cleanly delimited at its end: ${JSON.stringify(inserted.slice(-40))}`).toBe(true);
  expect(sysA.slice(0, commonPrefixLen) + inserted + tailA).toBe(sysC);

  const healDrift = byteDivergence(sysA, sysD);
  expect(healDrift, `turn D's system did not revert to turn A's bytes after the note cleared\n${healDrift}`).toBeUndefined();

  const nonSystem = (r: RecordedRequest) => r.messages.filter((m) => m.role !== "system");
  for (const [before, after, label] of [
    [nonSystem(requestA), nonSystem(requestC), "A → C"],
    [nonSystem(requestC), nonSystem(requestD), "C → D"],
  ] as const) {
    const drift = prefixDivergence(before, after);
    expect(drift, `${label}: the non-system message history is not append-only\n${drift}`).toBeUndefined();
    expect(after.length, `${label}: no message was appended to history at all`).toBeGreaterThan(before.length);
  }
});

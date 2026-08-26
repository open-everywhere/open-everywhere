import { expect, test } from "vitest";
import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { resolveTurnAnchor, turnChannelKey } from "@open-everywhere/core/agent/channels/turn-registry.js";
import {
  disposeLater,
  bootAgent,
  discordMentionWake,
  discordOeCommandPost,
  discordOeStopInteraction,
  DISCORD_LISTED_CHANNEL_ID,
  readAuditRows,
  registerScript,
  waitFor,
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

test("a cancelled turn's system-prompt reminder is one clean insertion at a fixed point, and clears back to byte-identical — never a scattered rewrite of the prefix", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const channelKey = turnChannelKey("discord", DISCORD_LISTED_CHANNEL_ID)!;
  const sinceIso = new Date(Date.now() - 10_000).toISOString();

  const a = disposeLater(registerScript({ parent: [{ say: "ack ope693a" }] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} ope693a`, messageId: "ope693-a" });
  const requestA = await waitFor(() => a.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "turn A's model call");
  expect(requestA.fault).toBeUndefined();
  a.dispose();

  const b = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "todo", input: { todos: [{ content: "ope-693 in-flight work", priority: "high", status: "in_progress" }] }, id: "ope693-todo" }] },
        { say: "never posted — cancelled inside this call", delayMs: HOLD_MS },
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
  b.releaseHolds();
  b.dispose();

  await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["turn.cancelled"], sinceIso });
    return rows.length > 0 ? rows : undefined;
  }, "the turn.cancelled row — the cancel arm has run and the reconstruction is pending");
  expect(await resolveTurnAnchor(org, { channelKey })).toBeNull();
  expect(b.holdsCutShort()).toBe(1);

  const c = disposeLater(registerScript({ parent: [{ say: "ack ope693c" }] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} ope693c`, messageId: "ope693-c" });
  const requestC = await waitFor(
    () => c.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes("was CANCELLED"))),
    "turn C's model call, carrying the cancel reminder",
  );
  expect(requestC.fault).toBeUndefined();
  c.dispose();

  const d = disposeLater(registerScript({ parent: [{ say: "ack ope693d" }] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `${BOT_MENTION} ope693d`, messageId: "ope693-d" });
  const requestD = await waitFor(() => d.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "turn D's model call");
  expect(requestD.fault).toBeUndefined();
  d.dispose();

  expect(new Set([requestA.sessionId, requestC.sessionId, requestD.sessionId]).size).toBe(1);
  expect(requestA.sessionId).toBeTypeOf("string");

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

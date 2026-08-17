import { afterAll, expect, test } from "vitest";
import {
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  waitFor,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const BOT_MENTION = "<@9000000000000000001>";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});
function disposeLater(handle: ScriptedHandle): ScriptedHandle {
  cleanups.push(() => handle.dispose());
  return handle;
}

async function driveTurn(marker: string): Promise<RecordedRequest> {
  const handle = disposeLater(registerScript({ parent: [{ say: `ack ${marker}` }] }));
  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: `${BOT_MENTION} ${marker}`,
    messageId: `ope690-${marker}`,
  });
  const request = await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0),
    `the "${marker}" turn's model call`,
  );
  expect(request.fault).toBeUndefined();
  handle.dispose();
  return request;
}

function systemBlock(request: RecordedRequest): string {
  return request.messages
    .filter((m) => m.role === "system")
    .map((m) => m.text)
    .join("\n[system-message-boundary]\n");
}

function toolBlock(request: RecordedRequest): string {
  return JSON.stringify(request.toolDefinitions, null, 1);
}

function byteDivergence(before: string, after: string): string | undefined {
  if (before === after) return undefined;
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  const from = Math.max(0, i - 120);
  const show = (s: string) => JSON.stringify(s.slice(from, i + 160));
  return (
    `diverges at character ${i} of ${before.length} (previous turn) / ${after.length} (this turn)\n` +
    `  previous: …${show(before)}\n` +
    `  this:     …${show(after)}`
  );
}

function prefixDivergence(before: RecordedRequest, after: RecordedRequest): string | undefined {
  if (after.messages.length < before.messages.length) {
    return (
      `the message list SHRANK: ${before.messages.length} message(s) on the previous turn, ` +
      `${after.messages.length} on this one — history was dropped, not appended`
    );
  }
  for (let i = 0; i < before.messages.length; i++) {
    const a = before.messages[i]!;
    const b = after.messages[i]!;
    if (a.role !== b.role) {
      return `message ${i} changed ROLE: "${a.role}" on the previous turn, "${b.role}" on this one`;
    }
    if (a.text !== b.text) {
      return `message ${i} (role "${a.role}") was REWRITTEN — ${byteDivergence(a.text, b.text)}`;
    }
  }
  return undefined;
}

test("a standing session's prompt only ever grows: system byte-identical, messages append-only, tools unchanged", async () => {
  await bootAgent();

  const markers = ["ope690a", "ope690b", "ope690c", "ope690d"] as const;
  const turns: RecordedRequest[] = [];
  for (const marker of markers) {
    turns.push(await driveTurn(marker));
  }

  const sessionIds = new Set(turns.map((t) => t.sessionId));
  expect([...sessionIds]).toHaveLength(1);
  expect(turns[0]!.sessionId).toBeTypeOf("string");

  expect(turns.at(-1)!.messages.length).toBeGreaterThan(turns[0]!.messages.length);

  for (let n = 1; n < turns.length; n++) {
    const before = turns[n - 1]!;
    const after = turns[n]!;
    const pair = `turn ${n} → turn ${n + 1}`;

    const systemDrift = byteDivergence(systemBlock(before), systemBlock(after));
    expect(
      systemDrift,
      `${pair}: the SYSTEM PROMPT changed mid-session. Every cached token after it is thrown away.\n${systemDrift}`,
    ).toBeUndefined();

    const historyDrift = prefixDivergence(before, after);
    expect(
      historyDrift,
      `${pair}: the message history is NOT append-only.\n${historyDrift}`,
    ).toBeUndefined();
    expect(after.messages.length, `${pair}: the turn appended no message at all`).toBeGreaterThan(before.messages.length);

    const appended = after.messages.slice(before.messages.length).map((m) => m.text).join("\n");
    expect(appended, `${pair}: the appended messages do not carry this turn's wake`).toContain(markers[n]!);

    const toolDrift = byteDivergence(toolBlock(before), toolBlock(after));
    expect(
      toolDrift,
      `${pair}: the TOOL BLOCK changed with no deploy. It sits in the prompt prefix, so this costs the whole cache.\n${toolDrift}`,
    ).toBeUndefined();
  }
});

// proves: admin.halt.set, admin.halt.cleared

import { afterAll, beforeAll, expect, test } from "vitest";
import {
  auditCursor,
  bootAgent,
  disposeLater,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  rowsSinceCursor,
  waitFor,
  waitForAuditRows,
  type AuditCursor,
  type RecordedRequest,
  WAKE_FROM_ENVELOPE,
} from "../harness";

const ORG = "default";

let haltedScopeKey: string | undefined;

beforeAll(async () => {
  await bootAgent({ sharedSqlite: true });
});

afterAll(async () => {
  if (haltedScopeKey === undefined) return;
  const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
  await getOperationalStore().clearHalt(ORG, { orgWide: false, level: "surface", scopeKey: haltedScopeKey }, { clearedBy: "it-cleanup" });
});

async function haltTexts(): Promise<{ readonly clear: string; readonly haltedOpening: string }> {
  const halt = await import("@open-everywhere/core/agent/access/halt.js");
  const paragraph = halt.haltSeatParagraph({ halted: true, unreadable: "fixture" })!;
  return { clear: halt.HALT_CLEAR_SEAT_LINE, haltedOpening: paragraph.slice(0, paragraph.indexOf(".**")) };
}

function systemText(request: RecordedRequest): string {
  return request.messages
    .filter((m) => m.role === "system")
    .map((m) => m.text)
    .join("\n\n");
}

async function driveTurn(ids: string, steps: readonly Record<string, unknown>[]): Promise<{ readonly cursor: AuditCursor; readonly first: RecordedRequest }> {
  const handle = disposeLater(registerScript({ parent: [...steps] }));
  const last = steps.length - 1;
  const cursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> ${ids}` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === last), `${ids}: the parent's terminal step`);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  const first = handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
  return { cursor, first };
}

async function controlWrite(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { buildControlServer } = await import("@open-everywhere/core/agent/control/server.js");
  const server = buildControlServer({ includeWrites: true, actor: "it-admin@example.com" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "halt-resume-seat-fact-it", version: "0" });
  await client.connect(clientT);
  try {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content?: { type: string; text?: string }[] };
    const text = res.content?.find((c) => c.type === "text")?.text ?? "";
    expect(res.isError, `${name} answered an error: ${text}`).not.toBe(true);
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    await client.close();
  }
}

test("① a chat `halt` with no scope halts THIS ROOM, never the deployment (OPE-2634)", async () => {
  const { cursor } = await driveTurn("hrs-halt halt this room now", [
    { calls: [{ tool: "halt", input: {}, id: "hrs-halt-call" }] },
    { calls: [{ tool: "reply", input: { text: "Stopped this room.", wake: WAKE_FROM_ENVELOPE }, id: "hrs-halt-reply" }] },
  ]);
  const rows = await waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(cursor, ["admin.halt.set"]);
      return got.length > 0 ? got : undefined;
    },
    label: "this turn's admin.halt.set row to land",
    actions: ["admin.halt.set"],
    cursor,
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.detail?.["orgWide"]).toBeUndefined();
  expect(rows[0]!.detail?.["level"]).toBe("surface");
  haltedScopeKey = rows[0]!.detail?.["scopeKey"] as string;
  expect(haltedScopeKey).toContain(DISCORD_LISTED_CHANNEL_ID);

  const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
  const active = await getOperationalStore().activeHalts(ORG);
  expect(active.some((r) => r.address.orgWide)).toBe(false);
  expect(active.some((r) => !r.address.orgWide && r.address.scopeKey === haltedScopeKey)).toBe(true);
});

test("② NEGATIVE CONTROL: while the halt stands, the wake carries the halt paragraph and not the clear line", async () => {
  expect(haltedScopeKey, "① did not set the halt this step reads").toBeDefined();
  const { clear, haltedOpening } = await haltTexts();
  const { first } = await driveTurn("hrs-halted", [{ calls: [{ tool: "reply", input: { text: "Still paused here.", wake: WAKE_FROM_ENVELOPE }, id: "hrs-halted-reply" }] }]);
  const system = systemText(first);
  expect(system).toContain(haltedOpening);
  expect(system).not.toContain(clear);
});

test("③ 🔴 after a control-plane `resume`, the next wake in the same room carries the clear line (OPE-2635)", async () => {
  expect(haltedScopeKey, "① did not set the halt this step lifts").toBeDefined();
  const { clear, haltedOpening } = await haltTexts();
  const lifted = await controlWrite("resume", { org: ORG, level: "surface", scopeKey: haltedScopeKey });
  expect(lifted["cleared"]).toBe(true);

  const { first } = await driveTurn("hrs-resumed", [{ calls: [{ tool: "reply", input: { text: "Raising the cap now.", wake: WAKE_FROM_ENVELOPE }, id: "hrs-resumed-reply" }] }]);
  const system = systemText(first);
  expect(system).toContain(clear);
  expect(system).not.toContain(haltedOpening);
});

const OTHER_ROOM = "discord/1300000000000000100/1300000000000009999";
let otherHalted = false;
afterAll(async () => {
  if (!otherHalted) return;
  const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
  await getOperationalStore().clearHalt(ORG, { orgWide: false, level: "surface", scopeKey: OTHER_ROOM }, { clearedBy: "it-cleanup" });
});

test("④ NEGATIVE CONTROL: a halt in ANOTHER room suppresses the clear line, and this room is not told it is paused", async () => {
  const { clear, haltedOpening } = await haltTexts();
  const set = await controlWrite("halt", { org: ORG, level: "surface", scopeKey: OTHER_ROOM });
  otherHalted = true;
  expect(set["ok"]).toBe(true);

  const { first } = await driveTurn("hrs-other", [{ calls: [{ tool: "reply", input: { text: "Working on it.", wake: WAKE_FROM_ENVELOPE }, id: "hrs-other-reply" }] }]);
  const system = systemText(first);
  expect(system).not.toContain(clear);
  expect(system).not.toContain(haltedOpening);
});

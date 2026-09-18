import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";

import { bootAgent, readAuditRows, slackInteractivityPost, waitForAuditRows, type AuditRow } from "../harness";

process.env.SLACK_BOT_TOKEN = "xoxb-integration-tier-placeholder-not-a-credential";

const TEAM_ID = "T0EXAMPLE";
const CLICKER_ID = "U0IT578CLK";
const BOT_USER_ID = "U0IT578BOT";
const HUMAN_ID = "U0IT578HUM";

const E2E_HOOK_ID = "e2e-smoke";

let org = "";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});

beforeAll(async () => {
  await bootAgent({ sharedSqlite: true });
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ taint: { mode: "on" }, approvals: { judgeMode: "off" } });
  expect(settings.getSettings().approvals.judgeMode).toBe("off");
  const binding = await import("@open-everywhere/core/agent/identity/binding.js");
  org = binding.deploymentOrg();
});

async function getStore() {
  const provider = await import("@open-everywhere/core/agent/operational/provider.js");
  return provider.getOperationalStore();
}

const SLACK_API_ORIGIN = "https://slack.com/api/";

interface StubbedRoom {
  readonly infoFails?: true;
  readonly isPrivate?: boolean;
  readonly isExternal?: boolean;
}

const ROOMS: Record<string, StubbedRoom> = {};

interface StubbedUser {
  readonly isRestricted?: boolean;
  readonly isUltraRestricted?: boolean;
  readonly infoRefused?: true;
}
const USERS: Record<string, StubbedUser> = {};

function withSlackUser(userId: string, facts: StubbedUser): void {
  USERS[userId] = facts;
}

function slackApiAnswer(method: string, params: URLSearchParams): Record<string, unknown> {
  if (method === "auth.test") return { ok: true, user_id: BOT_USER_ID };
  const channel = params.get("channel") ?? "";
  const room = ROOMS[channel];
  if (method === "conversations.info") {
    if (!room || room.infoFails === true) return { ok: false, error: "channel_not_found" };
    return {
      ok: true,
      channel: { id: channel, is_channel: true, is_private: room.isPrivate === true, is_ext_shared: room.isExternal === true },
    };
  }
  if (method === "conversations.members") {
    if (!room || room.infoFails === true) return { ok: false, error: "channel_not_found" };
    return { ok: true, members: [HUMAN_ID, BOT_USER_ID] };
  }
  if (method === "users.info") {
    const userId = params.get("user") ?? "";
    const user = USERS[userId];
    if (user?.infoRefused === true) return { ok: false, error: "missing_scope" };
    return {
      ok: true,
      user: {
        id: userId,
        team_id: TEAM_ID,
        is_restricted: user?.isRestricted === true,
        is_ultra_restricted: user?.isUltraRestricted === true,
      },
    };
  }
  return { ok: true, ts: `${Math.floor(Date.now() / 1000)}.000100` };
}

const REAL_FETCH = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  if (!url.startsWith(SLACK_API_ORIGIN)) return (REAL_FETCH as (...a: unknown[]) => Promise<Response>)(input, init);
  const method = url.slice(SLACK_API_ORIGIN.length);
  const body = typeof init?.body === "string" ? init.body : "";
  return new Response(JSON.stringify(slackApiAnswer(method, new URLSearchParams(body))), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;
cleanups.push(() => {
  globalThis.fetch = REAL_FETCH;
});

function withSlackRooms(rooms: Readonly<Record<string, StubbedRoom>>): void {
  Object.assign(ROOMS, rooms);
}

async function seedPending(input: {
  readonly kind: string;
  readonly channelId: string;
  readonly args: Record<string, unknown>;
}): Promise<string> {
  const s = await getStore();
  const id = randomUUID();
  const now = Date.now();
  const scopeKey = `slack/${TEAM_ID}/${input.channelId}`;
  await s.addPendingAction({
    id,
    org,
    kind: input.kind,
    argsJson: JSON.stringify(input.args),
    scopeKey,
    domain: null,
    requestedBy: CLICKER_ID,
    channelId: input.channelId,
    threadTs: null,
    messageTs: `1700000000.${String(now % 1_000_000).padStart(6, "0")}`,
    postedTo: scopeKey,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    decidedBy: null,
    decidedAt: null,
  });
  return id;
}

function routineArgs(channelId: string, prompt: string): Record<string, unknown> {
  const surfaceKey = `slack/${TEAM_ID}/${channelId}`;
  return {
    org,
    partition: {
      org,
      platform: "slack",
      workspace: TEAM_ID,
      surface: channelId,
      workspaceKey: `slack/${TEAM_ID}`,
      surfaceKey,
      domainKey: surfaceKey,
      key: surfaceKey,
    },
    surfaceKey,
    target: { channelId },
    trigger: { kind: "once", at: new Date(Date.now() + 30 * 86_400_000).toISOString() },
    prompt,
    createdBy: CLICKER_ID,
    sessionId: `it-session-${randomUUID()}`,
  };
}

function rotateArgs(channelId: string): Record<string, unknown> {
  return {
    org,
    hookId: E2E_HOOK_ID,
    posture: "content-bearing",
    surfaceKey: `slack/${TEAM_ID}/${channelId}`,
    requestedBy: CLICKER_ID,
    platform: "slack",
    channelId,
  };
}

async function click(input: {
  readonly pendingId: string;
  readonly decision: "approve" | "reject";
  readonly cardChannelId: string;
  readonly clickChannelId?: string;
  readonly clickerId?: string;
  readonly signature?: string;
  readonly staleSeconds?: number;
}): Promise<{ status: number; body: string }> {
  const { buildApprovalClickPayload } = await import("../../../packages/core/scripts/e2e/synthetic");
  const s = await getStore();
  const row = await s.getPendingAction(org, input.pendingId);
  expect(row).not.toBeNull();
  return slackInteractivityPost(
    buildApprovalClickPayload({
      pendingId: input.pendingId,
      decision: input.decision,
      userId: input.clickerId ?? CLICKER_ID,
      channelId: input.clickChannelId ?? input.cardChannelId,
      messageTs: row!.messageTs ?? "",
      org,
      teamId: TEAM_ID,
    }),
    {
      ...(input.signature !== undefined ? { signature: input.signature } : {}),
      ...(input.staleSeconds !== undefined ? { staleSeconds: input.staleSeconds } : {}),
    },
  );
}

async function rowsSince(since: number, actions: readonly string[]): Promise<AuditRow[]> {
  const got = await readAuditRows({ actions, sinceIso: new Date(since - 1_000).toISOString(), limit: 200 });
  return got.filter((r) => new Date(r.ts).getTime() >= since);
}

const DECIDE_ACTIONS = ["approval.denied", "approval.approved", "approval.rejected", "approval.failed"] as const;

async function decideRows(clickAt: number, id: string): Promise<AuditRow[]> {
  return waitForAuditRows({
    probe: async () => {
      const got = await rowsSince(clickAt, [...DECIDE_ACTIONS, "routine.create"]);
      return got.some((r) => (DECIDE_ACTIONS as readonly string[]).includes(r.action) && r.detail?.id === id) ? got : undefined;
    },
    label: `a decide audit row for pending ${id}`,
    actions: [...DECIDE_ACTIONS, "routine.create"],
    wakeAt: clickAt,
    timeoutMs: 60_000,
  });
}

async function expectFloorRefusal(input: { rows: AuditRow[]; id: string; reason: string; clickerId?: string }): Promise<void> {
  const denied = input.rows.find((r) => r.action === "approval.denied" && r.detail?.id === input.id);
  expect(denied).toBeDefined();
  expect(denied!.detail?.reason).toBe(input.reason);
  expect(denied!.principalId).toBe(input.clickerId ?? CLICKER_ID);

  const s = await getStore();
  const after = await s.getPendingAction(org, input.id);
  expect(after?.status).toBe("pending");
  expect(after?.decidedBy).toBeNull();
  expect(after?.decidedAt).toBeNull();

  for (const action of ["approval.approved", "approval.rejected", "approval.failed"]) {
    expect(input.rows.filter((r) => r.action === action && r.detail?.id === input.id).map((r) => r.action)).toEqual([]);
  }
}

async function armedRoutines(): Promise<{ id: string; prompt: string; status: string }[]> {
  const { listAllRoutines } = await import("@open-everywhere/core/agent/routines/store.js");
  return (await listAllRoutines()).map((r) => ({ id: r.id, prompt: r.prompt, status: r.status }));
}

test("Ⓞ a MIS-SIGNED interactivity POST is refused 401 and decides nothing, and a STALE timestamp is refused too", async () => {
  const ROOM = "C0IT578AUTH";
  const PROMPT = "clicker-floor ingress gate — never armed";
  const id = await seedPending({ kind: "routine.create", channelId: ROOM, args: routineArgs(ROOM, PROMPT) });

  const wrongKey = await click({ pendingId: id, decision: "approve", cardChannelId: ROOM, signature: "v0=" + "a".repeat(64) });
  expect(wrongKey.status).toBe(401);

  const stale = await click({ pendingId: id, decision: "approve", cardChannelId: ROOM, staleSeconds: 6 * 60 });
  expect(stale.status).toBe(401);

  const s = await getStore();
  const after = await s.getPendingAction(org, id);
  expect(after?.status).toBe("pending");
  expect(after?.decidedBy).toBeNull();
  expect((await armedRoutines()).some((r) => r.prompt === PROMPT)).toBe(false);
});

test("Ⓒ a click from a room that is NOT the card's room is refused foreign-room, and the card stays live", async () => {
  const CARD_ROOM = "C0IT578CARD";
  const OTHER_ROOM = "C0IT578ELSE";
  const PROMPT = "clicker-floor leg C — never armed";
  const id = await seedPending({ kind: "routine.create", channelId: CARD_ROOM, args: routineArgs(CARD_ROOM, PROMPT) });

  const clickAt = Date.now();
  const res = await click({ pendingId: id, decision: "approve", cardChannelId: CARD_ROOM, clickChannelId: OTHER_ROOM });
  expect(res.status).toBe(200);

  await expectFloorRefusal({ rows: await decideRows(clickAt, id), id, reason: "foreign-room" });
  expect((await armedRoutines()).some((r) => r.prompt === PROMPT)).toBe(false);
});

test("Ⓐ a member-tier click in a POSITIVELY externally-shared room is refused audience-floor", async () => {
  const ROOM = "C0IT578GUEST";
  withSlackRooms({ [ROOM]: { isPrivate: true, isExternal: true } });
  const PROMPT = "clicker-floor leg A — never armed";
  const id = await seedPending({ kind: "routine.create", channelId: ROOM, args: routineArgs(ROOM, PROMPT) });

  const clickAt = Date.now();
  const res = await click({ pendingId: id, decision: "approve", cardChannelId: ROOM });
  expect(res.status).toBe(200);

  await expectFloorRefusal({ rows: await decideRows(clickAt, id), id, reason: "audience-floor" });
  expect((await armedRoutines()).some((r) => r.prompt === PROMPT)).toBe(false);
});

test("🔴 Ⓐ' the control: with is_ext_shared FALSE the same click APPROVES and the routine really arms", async () => {
  const ROOM = "C0IT578CLEAN";
  withSlackRooms({ [ROOM]: { isPrivate: true, isExternal: false } });
  const PROMPT = `clicker-floor leg A control — armed ${randomUUID()}`;
  const id = await seedPending({ kind: "routine.create", channelId: ROOM, args: routineArgs(ROOM, PROMPT) });

  const clickAt = Date.now();
  const res = await click({ pendingId: id, decision: "approve", cardChannelId: ROOM });
  expect(res.status).toBe(200);
  const rows = await decideRows(clickAt, id);

  const approved = rows.find((r) => r.action === "approval.approved" && r.detail?.id === id);
  expect(approved).toBeDefined();
  expect(approved!.principalId).toBe(CLICKER_ID);
  expect(rows.filter((r) => r.action === "approval.denied" && r.detail?.id === id).map((r) => r.action)).toEqual([]);

  const s = await getStore();
  expect((await s.getPendingAction(org, id))?.status).toBe("approved");
  const armed = (await armedRoutines()).filter((r) => r.prompt === PROMPT);
  expect(armed.length).toBe(1);
  expect(armed[0]!.status).toBe("active");
});

test("Ⓑ a beneficiary-kind click in a room whose membership does NOT resolve is refused unattested-room", async () => {
  const ROOM = "C0IT578DARK";
  withSlackRooms({ [ROOM]: { infoFails: true } });
  const id = await seedPending({ kind: "webhook.rotate", channelId: ROOM, args: rotateArgs(ROOM) });

  const clickAt = Date.now();
  const res = await click({ pendingId: id, decision: "approve", cardChannelId: ROOM });
  expect(res.status).toBe(200);

  await expectFloorRefusal({ rows: await decideRows(clickAt, id), id, reason: "unattested-room" });
});

test("🔴 Ⓑ' the control: the SAME beneficiary kind in a room that DOES resolve passes the floor and decides", async () => {
  const ROOM = "C0IT578ATTEST";
  withSlackRooms({ [ROOM]: { isPrivate: true, isExternal: false } });
  const id = await seedPending({ kind: "webhook.rotate", channelId: ROOM, args: rotateArgs(ROOM) });

  const clickAt = Date.now();
  const res = await click({ pendingId: id, decision: "approve", cardChannelId: ROOM });
  expect(res.status).toBe(200);
  const rows = await decideRows(clickAt, id);

  expect(rows.filter((r) => r.action === "approval.denied" && r.detail?.id === id).map((r) => r.action)).toEqual([]);
  const approved = rows.find((r) => r.action === "approval.approved" && r.detail?.id === id);
  expect(approved).toBeDefined();
  expect(approved!.detail?.kind).toBe("webhook.rotate");
  expect(String(approved!.detail?.outcome)).toContain("broker");

  const s = await getStore();
  expect((await s.getPendingAction(org, id))?.status).toBe("approved");
  expect((await s.getPendingAction(org, id))?.decidedBy).toBe(CLICKER_ID);
});

test("Ⓓ a member-tier click by a clicker `users.info` POSITIVELY reports as a guest is refused guest-clicker, even in an ordinary internal room", async () => {
  const ROOM = "C0IT589CLICK";
  const GUEST_CLICKER = "U0IT589GUEST";
  withSlackRooms({ [ROOM]: { isPrivate: true, isExternal: false } });
  withSlackUser(GUEST_CLICKER, { isRestricted: true });
  const PROMPT = "clicker-floor leg D — never armed";
  const id = await seedPending({ kind: "routine.create", channelId: ROOM, args: routineArgs(ROOM, PROMPT) });

  const clickAt = Date.now();
  const res = await click({ pendingId: id, decision: "approve", cardChannelId: ROOM, clickerId: GUEST_CLICKER });
  expect(res.status).toBe(200);

  await expectFloorRefusal({ rows: await decideRows(clickAt, id), id, reason: "guest-clicker", clickerId: GUEST_CLICKER });
  expect((await armedRoutines()).some((r) => r.prompt === PROMPT)).toBe(false);
});

test("🔴 Ⓓ' the control: the SAME clicker with is_restricted/is_ultra_restricted both FALSE passes leg D and the routine really arms", async () => {
  const ROOM = "C0IT589CLICK2";
  const MEMBER_CLICKER = "U0IT589MEMBER";
  withSlackRooms({ [ROOM]: { isPrivate: true, isExternal: false } });
  withSlackUser(MEMBER_CLICKER, { isRestricted: false, isUltraRestricted: false });
  const PROMPT = `clicker-floor leg D control — armed ${randomUUID()}`;
  const id = await seedPending({ kind: "routine.create", channelId: ROOM, args: routineArgs(ROOM, PROMPT) });

  const clickAt = Date.now();
  const res = await click({ pendingId: id, decision: "approve", cardChannelId: ROOM, clickerId: MEMBER_CLICKER });
  expect(res.status).toBe(200);
  const rows = await decideRows(clickAt, id);

  const approved = rows.find((r) => r.action === "approval.approved" && r.detail?.id === id);
  expect(approved).toBeDefined();
  expect(approved!.principalId).toBe(MEMBER_CLICKER);
  expect(rows.filter((r) => r.action === "approval.denied" && r.detail?.id === id).map((r) => r.action)).toEqual([]);

  const s = await getStore();
  expect((await s.getPendingAction(org, id))?.status).toBe("approved");
  const armed = (await armedRoutines()).filter((r) => r.prompt === PROMPT);
  expect(armed.length).toBe(1);
  expect(armed[0]!.status).toBe("active");
});

test("🔴 Ⓓ'' the anti-outage control: users.info answering ok:false (missing_scope) leaves leg D INERT, and the click still executes", async () => {
  const ROOM = "C0IT589CLICK3";
  const UNSCOPED_CLICKER = "U0IT589UNSCOPED";
  withSlackRooms({ [ROOM]: { isPrivate: true, isExternal: false } });
  withSlackUser(UNSCOPED_CLICKER, { infoRefused: true });
  const PROMPT = `clicker-floor leg D anti-outage control — armed ${randomUUID()}`;
  const id = await seedPending({ kind: "routine.create", channelId: ROOM, args: routineArgs(ROOM, PROMPT) });

  const clickAt = Date.now();
  const res = await click({ pendingId: id, decision: "approve", cardChannelId: ROOM, clickerId: UNSCOPED_CLICKER });
  expect(res.status).toBe(200);
  const rows = await decideRows(clickAt, id);

  const approved = rows.find((r) => r.action === "approval.approved" && r.detail?.id === id);
  expect(approved).toBeDefined();
  expect(approved!.principalId).toBe(UNSCOPED_CLICKER);
  expect(rows.filter((r) => r.action === "approval.denied" && r.detail?.id === id).map((r) => r.action)).toEqual([]);

  const s = await getStore();
  expect((await s.getPendingAction(org, id))?.status).toBe("approved");
  const armed = (await armedRoutines()).filter((r) => r.prompt === PROMPT);
  expect(armed.length).toBe(1);
  expect(armed[0]!.status).toBe("active");
});

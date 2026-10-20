import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  waitFor,
  waitForAuditRows,
  waitForChildren,
  workTaskIdOfCall,
  type AuditCursor,
  type AuditRow,
  type ScriptedHandle,
} from "../harness";

for (const k of [
  "GITHUB_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "DISCORD_BOT_TOKEN",
]) {
  delete process.env[k];
}

const TRUSTED = generateKeyPairSync("ed25519");
const FOREIGN = generateKeyPairSync("ed25519");

function publicKeyHex(pair: { publicKey: KeyObject }): string {
  return Buffer.from((pair.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("hex");
}
const TRUSTED_PUBLIC_KEY_HEX = publicKeyHex(TRUSTED);

const DISCORD_INTERACTIONS_ROUTE = "/eve/v1/discord";

const CLICKER_ID = "9000000000000000077";
const SCOPE_KEY = `discord/${DISCORD_GUILD_ID}/${DISCORD_LISTED_CHANNEL_ID}`;

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});

let base = "";
let org = "";

async function armAgent(): Promise<void> {
  ({ base } = await bootAgent({ sharedSqlite: true, settings: { discord: { publicKey: TRUSTED_PUBLIC_KEY_HEX } } }));
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ taint: { mode: "on" }, approvals: { judgeMode: "off" } });
  expect(settings.getSettings().approvals.judgeMode).toBe("off");
  expect(settings.getSettings().taint.mode).toBe("on");

  const binding = await import("@open-everywhere/core/agent/identity/binding.js");
  org = binding.deploymentOrg();

  expect(process.env.GITHUB_TOKEN).toBeUndefined();
  const scm = await import("@open-everywhere/core/agent/scm/config.js");
  expect(scm.loadGitHubAppConfig()).toBeNull();
}

async function getStore() {
  const provider = await import("@open-everywhere/core/agent/operational/provider.js");
  return provider.getOperationalStore();
}

async function postClick(input: {
  readonly customId: string;
  readonly clickerId?: string;
  readonly key?: KeyObject;
}): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({
    type: 3,
    id: randomUUID(),
    application_id: "9000000000000000001",
    channel_id: DISCORD_LISTED_CHANNEL_ID,
    data: { custom_id: input.customId, component_type: 2 },
    user: { id: input.clickerId ?? CLICKER_ID },
    token: `it-${randomUUID()}`,
    version: 1,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), input.key ?? TRUSTED.privateKey).toString("hex");
  const res = await fetch(`${base}${DISCORD_INTERACTIONS_ROUTE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body,
  });
  return { status: res.status, body: await res.text() };
}

function responseOf(raw: string): { type: number; content: string; components: unknown[] } {
  const parsed = JSON.parse(raw) as { type?: unknown; data?: { content?: unknown; components?: unknown } };
  return {
    type: typeof parsed.type === "number" ? parsed.type : -1,
    content: typeof parsed.data?.content === "string" ? parsed.data.content : "",
    components: Array.isArray(parsed.data?.components) ? parsed.data.components : [],
  };
}

async function customIdFor(rowId: string, decision: "approve" | "reject" | "approve_session"): Promise<string> {
  const s = await getStore();
  const row = await s.getPendingAction(org, rowId);
  expect(row).not.toBeNull();
  const { buildDiscordApprovalCustomId } = await import("@open-everywhere/provider-discord/agent/approvals/discord-card.js");
  return buildDiscordApprovalCustomId(row!, decision);
}

const TRIGGER = { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } as const;

async function proposeRoutine(ids: string, prompt: string): Promise<string> {
  const handle: ScriptedHandle = registerScript({
    parent: [
      { calls: [{ tool: "work", input: { message: "set up the routine I asked for" }, id: `${ids}-delegate` }] },
      { say: NO_REPLY_SENTINEL },
    ],
    child: [
      { delayMs: 120_000, calls: [{ tool: "create_routine", input: { prompt, trigger: TRIGGER }, id: `${ids}-routine` }] },
      { say: "proposed" },
    ],
  });
  disposeLater(handle);

  const wakeCursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please set up the routine" });
  const receiptStep = await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    `the ${ids} receipt step to be served`,
  );
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(wakeCursor, handle, `${ids}-delegate`, `${ids} forward receipt`);
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: `the ${ids} worker's own terminal step` });
  expect(handle.holdsCutShort(), "the worker's hold ended on the release, not on its 120 s backstop").toBe(1);
  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: `the ${ids} seat step that read the worker's result` });
  expect(resultStep.stepIndex).toBe(0);
  expect(typeof receiptStep.turnId, "the recorder stamps eve's turn id").toBe("string");
  expect(resultStep.turnId, "the result arrives in a seat turn of its own, never the proposal turn (OPE-2338)").not.toBe(receiptStep.turnId);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(settlement.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(settlement.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  settlement.dispose();

  const requested = await waitForAuditRows({
    probe: async () => {
      const rows = await rowsSinceCursor(wakeCursor, ["approval.requested"]);
      return rows.find((r) => r.detail?.kind === "routine.create");
    },
    label: "this turn's approval.requested row to land",
    actions: ["approval.requested"],
    cursor: wakeCursor,
    kind: "routine.create",
    timeoutMs: 60_000,
  });
  const id = requested.detail?.id;
  expect(typeof id).toBe("string");
  return id as string;
}

const TERMINAL_ACTIONS = ["approval.approved", "approval.rejected", "approval.failed"] as const;

async function decideRows(clickCursor: AuditCursor, id: string): Promise<AuditRow[]> {
  const ACTIONS = [...TERMINAL_ACTIONS, "approval.denied", "approval.session_granted", "routine.create"];
  return waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(clickCursor, ACTIONS);
      const terminal = got.some((r) => (TERMINAL_ACTIONS as readonly string[]).includes(r.action) && r.detail?.id === id);
      return terminal ? got : undefined;
    },
    label: `a terminal approval row for pending ${id}`,
    actions: ACTIONS,
    cursor: clickCursor,
    timeoutMs: 60_000,
  });
}

async function armedRoutines(): Promise<{ id: string; prompt: string; status: string }[]> {
  const { listAllRoutines } = await import("@open-everywhere/core/agent/routines/store.js");
  return (await listAllRoutines()).map((r) => ({ id: r.id, prompt: r.prompt, status: r.status }));
}

let rejectedPendingId: string | undefined;

test("a signed Discord click approves a real proposal and the routine really arms — a wrong-key click first proves the signature is the gate", async () => {
  await armAgent();
  const PROMPT = "summarise the numbers every weekday morning (c1)";
  const id = await proposeRoutine("c1", PROMPT);

  const s = await getStore();
  expect((await s.getPendingAction(org, id))?.status).toBe("pending");
  expect((await armedRoutines()).some((r) => r.prompt === PROMPT)).toBe(false);

  const approveId = await customIdFor(id, "approve");

  const refused = await postClick({ customId: approveId, key: FOREIGN.privateKey });
  expect(refused.status).toBe(401);
  expect(refused.body).toContain("unauthorized");
  const afterRefusal = await s.getPendingAction(org, id);
  expect(afterRefusal?.status).toBe("pending");
  expect(afterRefusal?.decidedBy).toBeNull();

  const clickCursor = await auditCursor();
  const ok = await postClick({ customId: approveId });
  expect(ok.status).toBe(200);
  const response = responseOf(ok.body);
  expect(response.type).toBe(7);
  expect(response.components).toEqual([]);
  expect(response.content).toContain(`✅ Approved by <@${CLICKER_ID}>`);
  expect(response.content).toContain("routine started");

  const rows = await decideRows(clickCursor, id);

  const approved = rows.find((r) => r.action === "approval.approved" && r.detail?.id === id);
  expect(approved).toBeDefined();
  expect(approved!.detail?.kind).toBe("routine.create");
  expect(approved!.principalId).toBe(CLICKER_ID);
  expect(String(approved!.detail?.outcome)).toContain("routine started");
  expect(rows.filter((r) => r.action === "approval.failed" && r.detail?.id === id).map((r) => r.action)).toEqual([]);
  expect(rows.filter((r) => r.action === "approval.denied" && r.detail?.id === id).map((r) => r.action)).toEqual([]);

  const decided = await s.getPendingAction(org, id);
  expect(decided?.status).toBe("approved");
  expect(decided?.decidedBy).toBe(CLICKER_ID);
  expect(typeof decided?.decidedAt).toBe("string");

  const armed = (await armedRoutines()).filter((r) => r.prompt === PROMPT);
  expect(armed.length).toBe(1);
  expect(armed[0]!.status).toBe("active");

  const created = rows.find((r) => r.action === "routine.create" && r.detail?.id === armed[0]!.id);
  expect(created).toBeDefined();
  expect(created!.detail?.armedBy).toBe(CLICKER_ID);
  expect(created!.detail?.tainted).toBe(false);
});

test("a reject click writes approval.rejected, strips the card, and arms NOTHING", async () => {
  await armAgent();
  const PROMPT = "summarise the numbers every weekday morning (c2)";
  const id = await proposeRoutine("c2", PROMPT);

  const clickCursor = await auditCursor();
  const ok = await postClick({ customId: await customIdFor(id, "reject") });
  expect(ok.status).toBe(200);
  const response = responseOf(ok.body);
  expect(response.type).toBe(7);
  expect(response.components).toEqual([]);
  expect(response.content).toContain(`❌ Rejected by <@${CLICKER_ID}>`);

  const rows = await decideRows(clickCursor, id);
  const rejected = rows.find((r) => r.action === "approval.rejected" && r.detail?.id === id);
  expect(rejected).toBeDefined();
  expect(rejected!.detail?.kind).toBe("routine.create");
  expect(rejected!.principalId).toBe(CLICKER_ID);
  expect(rows.filter((r) => r.action === "approval.approved" && r.detail?.id === id).map((r) => r.action)).toEqual([]);
  expect(rows.filter((r) => r.action === "approval.failed" && r.detail?.id === id).map((r) => r.action)).toEqual([]);

  const s = await getStore();
  expect((await s.getPendingAction(org, id))?.status).toBe("rejected");

  expect((await armedRoutines()).some((r) => r.prompt === PROMPT)).toBe(false);

  rejectedPendingId = id;
});

test("🔴 a verdict is final: an approve click on the row test ② REJECTED flips nothing and arms nothing", async () => {
  await armAgent();
  const PROMPT = "summarise the numbers every weekday morning (c2)";
  expect(typeof rejectedPendingId).toBe("string");
  const id = rejectedPendingId as string;

  const s = await getStore();
  const before = await s.getPendingAction(org, id);
  expect(before?.status).toBe("rejected");
  const decidedAtBefore = before?.decidedAt;

  const clickCursor = await auditCursor();
  const ok = await postClick({ customId: await customIdFor(id, "approve") });
  expect(ok.status).toBe(200);
  expect(responseOf(ok.body).type).toBe(6);

  const after = await s.getPendingAction(org, id);
  expect(after?.status).toBe("rejected");
  expect(after?.decidedBy).toBe(CLICKER_ID);
  expect(after?.decidedAt).toBe(decidedAtBefore);

  const rows = await rowsSinceCursor(clickCursor, [...TERMINAL_ACTIONS, "routine.create"]);
  expect(rows.filter((r) => r.detail?.id === id).map((r) => r.action)).toEqual([]);
  expect((await armedRoutines()).some((r) => r.prompt === PROMPT)).toBe(false);
});

function prOpenArgs(sessionId: string, title: string): Record<string, unknown> {
  return {
    org,
    scopeKey: SCOPE_KEY,
    repo: "open-everywhere-it/never-reached",
    head: "oe/it-556",
    base: "main",
    title,
    body: "the frozen body",
    headSha: "0".repeat(40),
    requestedBy: CLICKER_ID,
    sessionId,
  };
}

async function discordThreadKey(threadId: string): Promise<string> {
  const { conversationGrantKey } = await import("@open-everywhere/core/agent/approvals/session-grant.js");
  const key = conversationGrantKey({
    platform: "discord",
    workspace: DISCORD_GUILD_ID,
    domainSurface: DISCORD_LISTED_CHANNEL_ID,
    surface: threadId,
    mode: "channel",
  });
  expect(key, "a Discord thread has a conversation key").toBeDefined();
  return key!;
}

async function controlWrite(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { buildControlServer } = await import("@open-everywhere/core/agent/control/server.js");
  const server = buildControlServer({ includeWrites: true, actor: "it-admin@example.com" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "approval-click-it", version: "0" });
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

test("🔴 approve_session on a pr.open card in a THREAD grants NOTHING (OPE-2363): no memo, no grant row, and a second identical card in the same thread stays pending", async () => {
  await armAgent();
  const run = randomUUID().slice(0, 8);
  const keyA = await discordThreadKey(`91${String(Date.now())}1`);

  const clicked = await seedPending({ kind: "pr.open", args: prOpenArgs(keyA, `thread A (${run})`) });
  const second = await seedPending({ kind: "pr.open", args: prOpenArgs(keyA, `thread A (${run})`) });

  const clickCursor = await auditCursor();
  const ok = await postClick({ customId: await customIdFor(clicked, "approve_session") });
  expect(ok.status).toBe(200);
  const rows = await decideRows(clickCursor, clicked);

  expect(rows.filter((r) => r.action === "approval.session_granted").map((r) => r.detail?.id)).toEqual([]);
  const s = await getStore();
  expect(await s.getSessionApproval(org, keyA, "pr.open", new Date().toISOString())).toBeNull();
  expect((await s.getPendingAction(org, clicked))?.status).toBe("approved");
  expect(rows.some((r) => r.action === "approval.failed" && r.detail?.id === clicked)).toBe(true);
  expect((await s.getPendingAction(org, second))?.status).toBe("pending");
});

test("approve_session on a ROUTINE's pr.open card writes the STANDING grant before execute, releases the routine's sibling card, and revoke_session_grants by the routine key deletes it", async () => {
  await armAgent();
  const run = randomUUID().slice(0, 8);
  const routineKey = `oe-routine:it-${run}:g1`;
  await (await getStore()).addRoutine({ id: `it-${run}`, org, surfaceKey: SCOPE_KEY, trigger: { kind: "interval", everyMinutes: 60 }, prompt: "x", createdAt: new Date().toISOString(), status: "active", consecutiveFailures: 0 });
  const clicked = await seedPending({ kind: "pr.open", args: prOpenArgs(routineKey, `routine, clicked (${run})`) });
  const sibling = await seedPending({ kind: "pr.open", args: prOpenArgs(routineKey, `routine, sibling (${run})`) });
  const threadCard = await seedPending({ kind: "pr.open", args: prOpenArgs(await discordThreadKey(`93${String(Date.now())}1`), `a thread (${run})`) });

  const s = await getStore();
  expect(await s.getSessionApproval(org, routineKey, "pr.open", new Date().toISOString())).toBeNull();

  const clickCursor = await auditCursor();
  const ok = await postClick({ customId: await customIdFor(clicked, "approve_session") });
  expect(ok.status).toBe(200);
  const rows = await decideRows(clickCursor, clicked);

  const granted = rows.find((r) => r.action === "approval.session_granted" && r.detail?.id === clicked);
  expect(granted).toBeDefined();
  expect(granted!.detail?.memoKind).toBe("pr.open");
  expect(granted!.detail?.reach).toBe("routine");
  expect(granted!.principalId).toBe(CLICKER_ID);
  const memo = await s.getSessionApproval(org, routineKey, "pr.open", new Date().toISOString());
  expect(memo).not.toBeNull();
  expect(memo!.grantedBy).toBe(CLICKER_ID);
  const ttlMs = Date.parse(memo!.expiresAt) - Date.parse(memo!.createdAt);
  expect(ttlMs, "the routine grant carries the 24 h clock, never the no-expiry sentinel").toBe(24 * 3_600_000);
  expect(rows.some((r) => r.action === "approval.failed" && r.detail?.id === clicked)).toBe(true);

  await waitFor(
    async () => ((await s.getPendingAction(org, sibling))?.status === "approved" ? true : undefined),
    "the routine's sibling card to be released by the grant",
    60_000,
  );
  expect((await s.getPendingAction(org, threadCard))?.status).toBe("pending");

  const revoke = await controlWrite("revoke_session_grants", { org, surfaceKey: SCOPE_KEY, sessionId: routineKey, reason: "OPE-2363 integration leg" });
  expect(Number(revoke.revoked)).toBeGreaterThanOrEqual(1);
  expect(await s.getSessionApproval(org, routineKey, "pr.open", new Date().toISOString())).toBeNull();
  const again = await controlWrite("revoke_session_grants", { org, surfaceKey: SCOPE_KEY, sessionId: routineKey });
  expect(Number(again.revoked)).toBe(0);
});

test("🔴 approve_session on a pr.open row frozen with a WORK-SESSION token grants NOTHING and degrades to a one-off approve (OPE-2363)", async () => {
  await armAgent();
  const workToken = `oe-dom:e2e-unified:win:w/e2e-unified:oe-sup:it-${randomUUID().slice(0, 8)}`;
  const id = await seedPending({ kind: "pr.open", args: prOpenArgs(workToken, "a legacy work-session card") });

  const clickCursor = await auditCursor();
  const ok = await postClick({ customId: await customIdFor(id, "approve_session") });
  expect(ok.status).toBe(200);
  const rows = await decideRows(clickCursor, id);

  expect(rows.filter((r) => r.action === "approval.session_granted").map((r) => r.detail?.id)).toEqual([]);
  const s = await getStore();
  expect(await s.getSessionApproval(org, workToken, "pr.open", new Date().toISOString())).toBeNull();
  expect((await s.getPendingAction(org, id))?.status).toBe("approved");
  expect(rows.some((r) => r.action === "approval.failed" && r.detail?.id === id)).toBe(true);
});

test("approve_session on a routine.create row grants NOTHING and degrades to a one-off approve — the control test ④c rests on", async () => {
  await armAgent();
  const sessionId = `oe-routine:it-c5-${randomUUID().slice(0, 8)}:g1`;
  const PROMPT = "summarise the numbers every weekday morning (c5, seeded)";
  const id = await seedPending({
    kind: "routine.create",
    args: {
      org,
      partition: {
        org,
        platform: "discord",
        workspace: DISCORD_GUILD_ID,
        surface: DISCORD_LISTED_CHANNEL_ID,
        workspaceKey: `discord/${DISCORD_GUILD_ID}`,
        surfaceKey: SCOPE_KEY,
        domainKey: SCOPE_KEY,
        key: SCOPE_KEY,
      },
      surfaceKey: SCOPE_KEY,
      target: { channelId: DISCORD_LISTED_CHANNEL_ID },
      trigger: { kind: "once", at: new Date(Date.now() + 30 * 86_400_000).toISOString() },
      prompt: PROMPT,
      createdBy: CLICKER_ID,
      sessionId,
    },
  });

  const clickCursor = await auditCursor();
  const ok = await postClick({ customId: await customIdFor(id, "approve_session") });
  expect(ok.status).toBe(200);
  expect(responseOf(ok.body).type).toBe(7);
  const rows = await decideRows(clickCursor, id);

  expect(rows.filter((r) => r.action === "approval.session_granted").map((r) => r.detail?.id)).toEqual([]);
  const s = await getStore();
  const nowIso = new Date().toISOString();
  expect(await s.getSessionApproval(org, sessionId, "routine.create", nowIso)).toBeNull();
  expect(await s.getSessionApproval(org, sessionId, "pr.open", nowIso)).toBeNull();

  const approved = rows.find((r) => r.action === "approval.approved" && r.detail?.id === id);
  expect(approved).toBeDefined();
  expect(approved!.principalId).toBe(CLICKER_ID);
  const armed = (await armedRoutines()).filter((r) => r.prompt === PROMPT);
  expect(armed.length).toBe(1);
  expect(armed[0]!.status).toBe("active");
});

async function seedPending(input: { readonly kind: string; readonly args: Record<string, unknown> }): Promise<string> {
  const s = await getStore();
  const id = randomUUID();
  const now = Date.now();
  await s.addPendingAction({
    id,
    org,
    kind: input.kind,
    argsJson: JSON.stringify(input.args),
    scopeKey: SCOPE_KEY,
    domain: null,
    requestedBy: CLICKER_ID,
    channelId: DISCORD_LISTED_CHANNEL_ID,
    threadTs: null,
    messageTs: `spoof-card-${now}`,
    postedTo: SCOPE_KEY,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    decidedBy: null,
    decidedAt: null,
  });
  return id;
}

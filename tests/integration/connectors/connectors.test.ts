import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  afterThisTest,
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  waitFor,
  waitForAuditRows,
  waitForChildren,
  workTaskIdOfCall,
  wrapToolExecute,
  type AuditCursor,
  type AuditRow,
  type ScriptedHandle,
} from "../harness";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

function delegatingParent(message: string, callId: string) {
  return [{ calls: [{ tool: "work", input: { message }, id: callId }] }, { say: NO_REPLY_SENTINEL }];
}

const WORKER_HOLD_MS = 120_000;

interface Forwarded {
  readonly settlement: ScriptedHandle;
  readonly taskId: string;
}

async function forwardJob(handle: ScriptedHandle, input: { readonly callId: string; readonly label: string; readonly cursor: AuditCursor }): Promise<Forwarded> {
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${input.label}: the receipt step`);
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(input.cursor, handle, input.callId, `${input.label}: the forward receipt`);
  handle.releaseHolds();
  return { settlement, taskId };
}

async function awaitDelegationResult(handle: ScriptedHandle, forwarded: Forwarded, label: string): Promise<void> {
  const resultStep = await awaitWorkResult({ handle: forwarded.settlement, taskId: forwarded.taskId, label: `${label}: the seat step that read the worker's result` });
  expect(resultStep.fault).toBeUndefined();
  expect(resultStep.stepIndex).toBe(0);
  expect(handle.requests.filter((r) => r.fault !== undefined), `${label}: the scripted model reported a fault`).toEqual([]);
  expect(forwarded.settlement.requests.filter((r) => r.fault !== undefined), `${label}: the result-wake script reported a fault`).toEqual([]);
  forwarded.settlement.dispose();
}

test("connection_search mounts on the delegated worker; the lean conversational seat never sees it (or any qualified op name)", async () => {
  await bootAgent();

  const handle = registerScript({
    parent: delegatingParent("search notion for the handbook", "mt-delegate"),
    child: [
      { delayMs: WORKER_HOLD_MS, calls: [{ tool: "connection_search", input: { query: "handbook" }, id: "mt-search" }] },
      { say: "found the handbook" },
    ],
  });
  disposeLater(handle);

  const cursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please search notion for the handbook" });
  const forwarded = await forwardJob(handle, { callId: "mt-delegate", label: "the mount-tiering delegation", cursor });
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: "the delegated worker's own terminal step" });
  await awaitDelegationResult(handle, forwarded, "the mount-tiering delegation");

  const parentRequests = [...handle.requests, ...forwarded.settlement.requests].filter((r) => r.role === "parent");
  expect(parentRequests.length).toBeGreaterThanOrEqual(3);
  for (const r of parentRequests) {
    expect(r.tools).not.toContain("connection_search");
    expect(r.tools.some((t) => t.includes("__"))).toBe(false);
  }

  const childRequests = handle.requests.filter((r) => r.role === "child");
  expect(childRequests.length).toBeGreaterThanOrEqual(1);
  expect(childRequests[0].tools).toContain("connection_search");

  handle.dispose();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const topologyBefore = settings.getSettings().window.topology;
  afterThisTest(() => settings.overrideSettingsForTest({ window: { topology: topologyBefore } }));
  settings.overrideSettingsForTest({ window: { topology: false } });
  expect(settings.getSettings().window.topology).toBe(false);

  const nativeHandle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "connection_search", input: { query: "handbook" }, id: "mt-native-search" }] },
        { say: "native seat found it" },
      ],
    }),
  );
  await discordMentionWake({ channelId: freshUnlistedChannelId(), text: "<@9000000000000000001> please search notion for the handbook" });
  await waitFor(() => nativeHandle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the native seat's terminal step");
  expect(nativeHandle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(nativeHandle.requests[0].tools).toContain("connection_search");
});

async function driveConnectionSearchThenPropose(input: {
  readonly ids: string;
  readonly searchResult: unknown;
}): Promise<{ handle: ScriptedHandle; cursor: AuditCursor }> {
  afterThisTest(wrapToolExecute("connection_search", async () => input.searchResult));

  const handle = disposeLater(
    registerScript({
      parent: delegatingParent("search notion, then set up a summary routine", `${input.ids}-delegate`),
      child: [
        { delayMs: WORKER_HOLD_MS, calls: [{ tool: "connection_search", input: { query: "handbook" }, id: `${input.ids}-search` }] },
        {
          calls: [
            {
              tool: "create_routine",
              input: {
                prompt: `summarise notion search results every weekday morning (${input.ids})`,
                trigger: { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" },
              },
              id: `${input.ids}-routine`,
            },
          ],
        },
        { say: "proposed" },
      ],
    }),
  );

  const cursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please search notion then set up the routine" });
  const forwarded = await forwardJob(handle, { callId: `${input.ids}-delegate`, label: `the ${input.ids} delegation`, cursor });
  await waitForChildren(handle, { count: 1, lastStepIndex: 2, label: `the ${input.ids} worker's own terminal step` });

  await awaitDelegationResult(handle, forwarded, `the ${input.ids} delegation`);
  handle.dispose();
  return { handle, cursor };
}

function assertConnectionSearchFenced(handle: ScriptedHandle): void {
  const searched = handle.requests.flatMap((r) => r.toolResults).find((t) => t.name === "connection_search");
  expect(searched).toBeDefined();
  expect(searched!.isError).toBe(false);
  const text = String(searched!.output);
  const open = text.indexOf(UNTRUSTED_OPEN);
  const close = text.indexOf(UNTRUSTED_CLOSE);
  expect(open).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(open);
}

async function createRoutineChainRow(cursor: AuditCursor): Promise<AuditRow> {
  return waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(cursor, ["approval.chain"], { limit: 50 });
      return got.find((r) => r.detail?.tool === "create_routine");
    },
    label: "this turn's create_routine chain row to land",
    actions: ["approval.chain"],
    cursor,
    kind: "routine.create",
  });
}

test("B — a discovered-tool row (MCP-authored bytes) fences AND taints the turn", async () => {
  await bootAgent();

  const { handle, cursor } = await driveConnectionSearchThenPropose({
    ids: "b1",
    searchResult: [
      { connection: "notion", tool: "search", qualifiedName: "notion__search", description: "Search the team's Notion workspace" },
    ],
  });

  assertConnectionSearchFenced(handle);
  await expectTurnMarked(cursor, "B");

  const chain = await createRoutineChainRow(cursor);
  expect(chain.detail).not.toHaveProperty("tainted");
  expect(chain.detail).not.toHaveProperty("taintKinds");
});

test("C — negative control: an eve-authored STATUS row (needsAuthorization) fences but does NOT taint", async () => {
  await bootAgent();

  const { handle, cursor } = await driveConnectionSearchThenPropose({
    ids: "c1",
    searchResult: [{ connection: "notion", description: "Notion workspace (MCP)", needsAuthorization: true }],
  });

  assertConnectionSearchFenced(handle);
  expect(await taintMarksSince(cursor), "C: a clean turn wrote a taint mark").toEqual([]);

  const chain = await createRoutineChainRow(cursor);
  expect(chain.detail).not.toHaveProperty("tainted");
  expect(chain.detail).not.toHaveProperty("taintKinds");
});

test("D — request_access grant-connector for an ungranted connector mints a real access.request card under the egress spoof, no network", async () => {
  await bootAgent();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const { adminChannel, configRepo } = settings.getSettings().accessRequests;
  settings.overrideSettingsForTest({ accessRequests: { adminChannel: "C_IT_ADMIN_FAKE", configRepo: "example-owner/open-everywhere-it-fixture" } });
  afterThisTest(() => settings.overrideSettingsForTest({ accessRequests: { adminChannel, configRepo } }));

  const handle = disposeLater(
    registerScript({
      parent: delegatingParent("ask for the notion connector to be enabled here", "d1-delegate"),
      child: [
        {
          delayMs: WORKER_HOLD_MS,
          calls: [
            {
              tool: "request_access",
              input: {
                kind: "grant-connector",
                connector: "notion",
                credential: "team-key",
                reason: "need Notion search for the weekly summary",
              },
              id: "d1-request",
            },
          ],
        },
        { say: "requested" },
      ],
    }),
  );

  const cursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please request the notion connector here" });
  const forwarded = await forwardJob(handle, { callId: "d1-delegate", label: "the grant-connector delegation", cursor });
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: "the requesting worker's own terminal step" });
  await awaitDelegationResult(handle, forwarded, "the grant-connector delegation");
  handle.dispose();

  const found = handle.requests.flatMap((r) => r.toolResults).find((t) => t.name === "request_access");
  expect(found).toBeDefined();
  expect(found!.isError).toBe(false);
  const output = found!.output as Record<string, unknown>;
  expect(output.requested).toBe(true);
  expect(output.autoApproved).toBeUndefined();
  expect(typeof output.pendingId).toBe("string");

  const rows = await waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(cursor, ["approval.requested", "approval.expired"], { limit: 50 });
      return got.some((r) => r.action === "approval.requested" && r.detail?.kind === "access.request") ? got : undefined;
    },
    label: "the access.request approval.requested row to land",
    actions: ["approval.requested", "approval.expired"],
    cursor,
    kind: "access.request",
  });
  const requested = rows.find((r) => r.action === "approval.requested" && r.detail?.kind === "access.request");
  expect(requested).toBeDefined();
  expect(requested!.detail?.id).toBe(output.pendingId);
  expect(rows.filter((r) => r.action === "approval.expired").map((r) => r.detail?.cause)).toEqual([]);

  const negHandle = disposeLater(
    registerScript({
      parent: delegatingParent("ask for a connector that does not exist", "d1-neg-delegate"),
      child: [
        {
          delayMs: WORKER_HOLD_MS,
          calls: [
            { tool: "request_access", input: { kind: "grant-connector", connector: "not-a-real-connector-xyz" }, id: "d1-neg-request" },
          ],
        },
        { say: "asked anyway" },
      ],
    }),
  );
  const negCursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please request a connector that does not exist" });
  const negForwarded = await forwardJob(negHandle, { callId: "d1-neg-delegate", label: "the negative control delegation", cursor: negCursor });
  await waitForChildren(negHandle, { count: 1, lastStepIndex: 1, label: "the negative control worker's own terminal step" });
  const negFound = negHandle.requests.flatMap((r) => r.toolResults).find((t) => t.name === "request_access");
  expect(negFound).toBeDefined();
  expect(negFound!.isError).toBe(true);
  expect(JSON.stringify(negFound!.output)).toContain("isn't defined in this deployment's config");

  await awaitDelegationResult(negHandle, negForwarded, "the negative control delegation");
});

async function taintMarksSince(cursor: AuditCursor): Promise<Awaited<ReturnType<typeof rowsSinceCursor>>> {
  return (await rowsSinceCursor(cursor, ["taint.forward"], { limit: 200 })).filter((r) => r.detail?.leg === "mark");
}
async function expectTurnMarked(cursor: AuditCursor, label: string): Promise<void> {
  const marks = await waitFor(async () => {
    const m = await taintMarksSince(cursor);
    return m.length > 0 ? m : undefined;
  }, `${label}: the tainted turn's taint.forward mark row`, 60_000);
  expect(marks.length).toBeGreaterThan(0);
}

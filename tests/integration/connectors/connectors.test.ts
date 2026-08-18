import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  afterThisTest,
  disposeLater,
  awaitTaskSettlement,
  bootAgent,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  readAuditRows,
  registerScript,
  SETTLEMENT_DRAIN_SCRIPT,
  taskIdOfDelegation,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  waitFor,
  waitForChildren,
  wrapToolExecute,
  type AuditRow,
  type ScriptedHandle,
} from "../harness";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

test("connection_search mounts on the delegated worker; the lean conversational seat never sees it (or any qualified op name)", async () => {
  await bootAgent();

  const handle = registerScript({
    parent: [
      { calls: [{ tool: "agent", input: { message: "search notion for the handbook" }, id: "mt-delegate" }] },
      { say: "the worker reported back" },
    ],
    child: [
      { calls: [{ tool: "connection_search", input: { keywords: "handbook" }, id: "mt-search" }] },
      { say: "found the handbook" },
    ],
  });

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please search notion for the handbook" });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the parent's terminal step to be served");
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: "the delegated worker's own terminal step" });
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const parentRequests = handle.requests.filter((r) => r.role === "parent");
  expect(parentRequests.length).toBeGreaterThanOrEqual(2);
  for (const r of parentRequests) {
    expect(r.tools).not.toContain("connection_search");
    expect(r.tools.some((t) => t.includes("__"))).toBe(false);
  }

  const childRequests = handle.requests.filter((r) => r.role === "child");
  expect(childRequests.length).toBeGreaterThanOrEqual(1);
  expect(childRequests[0].tools).toContain("connection_search");

  const drained = await awaitTaskSettlement({
    dispatched: handle,
    taskId: taskIdOfDelegation(handle, "the mount-tiering delegation"),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: "the worker's settlement wake on the standing window",
  });
  expect(drained.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  drained.handle.dispose();

  const nativeHandle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "connection_search", input: { keywords: "handbook" }, id: "mt-native-search" }] },
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
}): Promise<{ handle: ScriptedHandle; wakeAt: number }> {
  afterThisTest(wrapToolExecute("connection_search", async () => input.searchResult));

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "search notion, then set up a summary routine" }, id: `${input.ids}-delegate` }] },
        { say: "the worker reported back" },
      ],
      child: [
        { calls: [{ tool: "connection_search", input: { keywords: "handbook" }, id: `${input.ids}-search` }] },
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

  const wakeAt = Date.now();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please search notion then set up the routine" });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the parent's terminal step to be served");
  await waitForChildren(handle, { count: 1, lastStepIndex: 2, label: `the ${input.ids} worker's own terminal step` });
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const drained = await awaitTaskSettlement({
    dispatched: handle,
    taskId: taskIdOfDelegation(handle, `the ${input.ids} delegation`),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: `the ${input.ids} worker's settlement wake`,
  });
  expect(drained.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  drained.handle.dispose();
  return { handle, wakeAt };
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

async function createRoutineChainRow(wakeAt: number): Promise<AuditRow> {
  return waitFor(async () => {
    const got = await readAuditRows({ actions: ["approval.chain"], sinceIso: new Date(wakeAt - 1_000).toISOString(), limit: 50 });
    return got.find((r) => r.action === "approval.chain" && r.detail?.tool === "create_routine" && new Date(r.ts).getTime() >= wakeAt);
  }, "this turn's create_routine chain row to land");
}

test("B — a discovered-tool row (MCP-authored bytes) fences AND taints the turn", async () => {
  await bootAgent();

  const { handle, wakeAt } = await driveConnectionSearchThenPropose({
    ids: "b1",
    searchResult: [
      { connection: "notion", tool: "search", qualifiedName: "notion__search", description: "Search the team's Notion workspace" },
    ],
  });

  assertConnectionSearchFenced(handle);

  const chain = await createRoutineChainRow(wakeAt);
  expect(chain.detail?.tainted).toBe(true);
  expect(chain.detail?.taintKinds).toEqual(["connector"]);
});

test("C — negative control: an eve-authored STATUS row (needsAuthorization) fences but does NOT taint", async () => {
  await bootAgent();

  const { handle, wakeAt } = await driveConnectionSearchThenPropose({
    ids: "c1",
    searchResult: [{ connection: "notion", description: "Notion workspace (MCP)", needsAuthorization: true }],
  });

  assertConnectionSearchFenced(handle);

  const chain = await createRoutineChainRow(wakeAt);
  expect(chain.detail?.tainted).toBe(false);
  expect(chain.detail?.taintKinds ?? []).toEqual([]);
});

test("D — request_access grant-connector for an ungranted connector mints a real access.request card under the egress spoof, no network", async () => {
  process.env.OE_ACCESS_ADMIN_CHANNEL = "C_IT_ADMIN_FAKE";
  process.env.OE_ACCESS_CONFIG_REPO = "example-owner/open-everywhere-it-fixture";
  afterThisTest(() => {
    delete process.env.OE_ACCESS_ADMIN_CHANNEL;
    delete process.env.OE_ACCESS_CONFIG_REPO;
  });

  await bootAgent();

  const handle = registerScript({
    parent: [
      { calls: [{ tool: "agent", input: { message: "ask for the notion connector to be enabled here" }, id: "d1-delegate" }] },
      { say: "the worker reported back" },
    ],
    child: [
      {
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
  });

  const wakeAt = Date.now();
  const sinceIso = new Date(wakeAt - 1_000).toISOString();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please request the notion connector here" });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the parent's terminal step to be served");
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: "the requesting worker's own terminal step" });
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const drained = await awaitTaskSettlement({
    dispatched: handle,
    taskId: taskIdOfDelegation(handle, "the grant-connector delegation"),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: "the requesting worker's settlement wake",
  });
  expect(drained.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  drained.handle.dispose();

  const found = handle.requests.flatMap((r) => r.toolResults).find((t) => t.name === "request_access");
  expect(found).toBeDefined();
  expect(found!.isError).toBe(false);
  const output = found!.output as Record<string, unknown>;
  expect(output.requested).toBe(true);
  expect(output.autoApproved).toBeUndefined();
  expect(typeof output.pendingId).toBe("string");

  const rows = await waitFor(async () => {
    const got = await readAuditRows({ actions: ["approval.requested", "approval.expired"], sinceIso, limit: 50 });
    return got.some((r) => r.action === "approval.requested" && r.detail?.kind === "access.request") ? got : undefined;
  }, "the access.request approval.requested row to land");
  const requested = rows.find((r) => r.action === "approval.requested" && r.detail?.kind === "access.request");
  expect(requested).toBeDefined();
  expect(requested!.detail?.id).toBe(output.pendingId);
  expect(rows.filter((r) => r.action === "approval.expired").map((r) => r.detail?.cause)).toEqual([]);

  const negHandle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "ask for a connector that does not exist" }, id: "d1-neg-delegate" }] },
        { say: "the worker reported back" },
      ],
      child: [
        {
          calls: [
            { tool: "request_access", input: { kind: "grant-connector", connector: "not-a-real-connector-xyz" }, id: "d1-neg-request" },
          ],
        },
        { say: "asked anyway" },
      ],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please request a connector that does not exist" });
  await waitFor(() => negHandle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the negative control's terminal step");
  await waitForChildren(negHandle, { count: 1, lastStepIndex: 1, label: "the negative control worker's own terminal step" });
  const negFound = negHandle.requests.flatMap((r) => r.toolResults).find((t) => t.name === "request_access");
  expect(negFound).toBeDefined();
  expect(negFound!.isError).toBe(true);
  expect(JSON.stringify(negFound!.output)).toContain("isn't defined in this deployment's config");

  const negDrained = await awaitTaskSettlement({
    dispatched: negHandle,
    taskId: taskIdOfDelegation(negHandle, "the negative control delegation"),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: "the negative control worker's settlement wake",
  });
  expect(negDrained.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  negDrained.handle.dispose();
});

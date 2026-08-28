import { randomBytes } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import {
  afterThisTest,
  awaitTaskSettlement,
  bootAgent,
  disposeLater,
  installNotionApiStub,
  notionCommentEventPost,
  registerScript,
  seedNotionChannelKey,
  SETTLEMENT_DRAIN_SCRIPT,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type ScriptedHandle,
} from "../harness";

const NOTION_FIXTURE_WORKSPACE_ID = "6f7ea678-1071-4000-8000-000000000001";
const NOTION_FIXTURE_PAGE_ID = "6f7ea678-1071-4000-8000-000000000002";
const BOT_USER_ID = "it-1071-notion-bot-self";
const BOT_NAME = "ottobot";

afterAll(async () => {
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.resetSettingsForTest();
});

async function pinFixtureDomainGrant(): Promise<void> {
  const { loadDomains } = await import("../../../agent/memory/config/domains");
  const { domainHoldsSurfaceWorkGrant } = await import("@open-everywhere/core/agent/access/surface-work-grant.js");
  const home = loadDomains().find((d) => d.name === "it-work-read-fixture-notion");
  expect(home, `the "it-work-read-fixture-notion" domain is missing from agent/memory/config/domains.ts — this arm cannot measure a mount`).toBeDefined();
  expect(
    domainHoldsSurfaceWorkGrant(home, "notion"),
    `"it-work-read-fixture-notion" declares NO notion work role — restore its \`credentials\` entry before re-running this arm`,
  ).toBe(true);
}

async function driveDelegationAndReadWorker(wake: () => Promise<void>): Promise<ScriptedHandle> {
  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "take it from here" }, id: "ope1071-notion-delegate" }] },
        { say: "handed off" },
      ],
      child: [{ say: "reported" }],
    }),
  );

  await wake();

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "notion: the dispatch turn's own terminal step");
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "notion: the worker's terminal step" });
  expect(handle.requests.filter((r) => r.fault !== undefined), "notion: the scripted model reported a fault").toEqual([]);

  const taskId = taskIdOfDelegation(handle, "the notion delegation");
  const drained = await awaitTaskSettlement({ dispatched: handle, taskId, script: SETTLEMENT_DRAIN_SCRIPT, label: "notion: the worker's settlement wake" });
  disposeLater(drained.handle);
  expect(drained.handle.requests.filter((r) => r.fault !== undefined), "notion: a straggling worker crossed into the drain").toEqual([]);
  drained.handle.dispose();

  return handle;
}

function assertWorkerHoldsWorkReads(handle: ScriptedHandle): void {
  const worker = handle.requests.find((r) => r.role === "child");
  expect(worker, "notion: no worker request was recorded — the delegation never reached a child").toBeDefined();

  for (const verb of ["read_work_channel", "read_work_thread"]) {
    expect(
      worker!.tools,
      `🔴 notion: the worker was NOT offered ${verb} — the granted work read never mounted on a real notion wake. It was offered [${worker!.tools.slice().sort().join(", ")}]`,
    ).toContain(verb);
  }

  const seat = handle.requests.find((r) => r.role === "parent")!;
  for (const verb of ["read_work_channel", "read_work_thread"]) {
    expect(seat.tools, `🔴 notion: the SEAT was offered ${verb} — the work plane is not the worker's any more`).not.toContain(verb);
  }
}

test("Notion: a delegated worker in it-work-read-fixture-notion holds read_work_channel/read_work_thread", async () => {
  await bootAgent({ sharedSqlite: true });
  await pinFixtureDomainGrant();
  await seedNotionChannelKey();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ approvals: { judgeMode: "off" } });
  expect(settings.getSettings().approvals.judgeMode).toBe("off");

  process.env.OE_TRUST = "internal";
  afterThisTest(() => delete process.env.OE_TRUST);

  const nonce = randomBytes(4).toString("hex");
  const triggerId = `it-1071-notion-trigger-${nonce}`;
  const discussionId = `it-1071-notion-discussion-${nonce}`;

  const stub = installNotionApiStub((call) => {
    if (call.method === "GET" && call.path === "/v1/users/me") {
      return { body: { id: BOT_USER_ID, name: BOT_NAME, type: "bot" } };
    }
    if (call.method === "GET" && call.path === "/v1/comments") {
      return { body: { results: [] } };
    }
    if (call.method === "GET" && call.path.startsWith("/v1/comments/")) {
      const id = decodeURIComponent(call.path.slice("/v1/comments/".length));
      if (id !== triggerId) return undefined;
      return {
        body: {
          id: triggerId,
          discussion_id: discussionId,
          parent: { page_id: NOTION_FIXTURE_PAGE_ID },
          rich_text: [{ plain_text: `ope1071 please read this page (${nonce})` }],
          created_by: { id: `it-1071-notion-author-${nonce}`, type: "person" },
          created_time: new Date().toISOString(),
        },
      };
    }
    if (call.method === "POST" && call.path === "/v1/comments") {
      return { body: { id: "it-1071-notion-reply" } };
    }
    return undefined;
  });
  afterThisTest(() => stub.uninstall());

  const handle = await driveDelegationAndReadWorker(async () => {
    const res = await notionCommentEventPost({ workspaceId: NOTION_FIXTURE_WORKSPACE_ID, commentId: triggerId });
    expect(res.status, `the Notion front refused the delivery: ${res.body.slice(0, 300)}`).toBe(200);
  });

  assertWorkerHoldsWorkReads(handle);
}, 420_000);

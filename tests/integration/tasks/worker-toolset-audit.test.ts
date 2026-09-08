import { expect, test } from "vitest";
import {
  bootAgent,
  discordMentionWake,
  disposeLater,
  DISCORD_LISTED_CHANNEL_ID,
  readAuditRows,
  registerScript,
  sleep,
  waitFor,
  waitForChildren,
} from "../harness";

test("a delegated worker's mounted toolset is written to the audit trail, once, at the mount", async () => {
  await bootAgent();

  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "count the files in the repo" }, id: "ope1497-delegate" }] },
        { say: "handing this off" },
      ],
      child: [
        { calls: [{ tool: "update_status", input: { state: "working", summary: "counting the files" }, id: "ope1497-status" }] },
        { say: "there are twelve files" },
      ],
    }),
  );

  const sinceIso = new Date(Date.now() - 1_000).toISOString();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> count the files" });

  await waitFor(() => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the dispatch turn's own terminal step to be served");
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 1, label: "the delegated worker to serve its whole arm" });
  expect(dispatched.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const childRequests = dispatched.requests.filter((r) => r.role === "child");
  const parentRequests = dispatched.requests.filter((r) => r.role === "parent");
  expect(childRequests.length).toBeGreaterThan(0);
  expect(parentRequests.length).toBeGreaterThan(0);
  const offered = [...childRequests[0]!.tools].sort();
  expect(offered.length).toBeGreaterThan(20);
  expect(childRequests.length).toBeGreaterThan(1);
  expect([...childRequests[1]!.tools].sort()).toEqual(offered);
  const childSessionId = String(childRequests[0]!.sessionId);
  const seatSessionId = String(parentRequests[0]!.sessionId);
  expect(childSessionId).not.toBe(seatSessionId);

  await waitFor(
    async () => {
      const found = await readAuditRows({ actions: ["worker.toolset"], sinceIso });
      return found.some((r) => (r.detail ?? {}).worker === childSessionId) ? true : undefined;
    },
    "the worker's `worker.toolset` evidence row",
    90_000,
  );
  await sleep(3_000);
  const settled = await readAuditRows({ actions: ["worker.toolset"], sinceIso });
  const ours = settled.filter((r) => (r.detail ?? {}).worker === childSessionId);

  expect(ours.length).toBe(1);
  const row = ours[0]!;
  expect((row.detail ?? {}).reason).toBe("mount");
  const detail = (row.detail ?? {}) as Record<string, unknown>;
  expect(row.platform).toBe("unified");
  expect(detail.grain).toBe("task");
  expect(detail.parentSession).toBe(seatSessionId);
  expect(settled.filter((r) => (r.detail ?? {}).worker === seatSessionId)).toEqual([]);

  expect([...(detail.tools as string[])].sort()).toEqual(offered);
  expect(detail.toolCount).toBe(offered.length);

  expect(detail.tools).not.toContain("no_reply");
  expect(detail.tools).not.toContain("stand_down");
  expect(detail.withheld).toContain("no_reply");
  expect(detail.withheld).toContain("stand_down");
  for (const kept of ["reply", "bash", "update_status"]) expect(detail.tools).toContain(kept);
});

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
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
} from "../harness";

const OBSERVATION_ACTION = "memory.observation";
const SETTLEMENT_FLUSH_ACTION = "memory.settlement_flush";

function observationSig(detail: Record<string, unknown> | undefined): string {
  const sig = detail?.["sigSha"];
  return typeof sig === "string" ? sig : "";
}

test("the dream cycle fingerprints the seat's own request and never the worker's brief", async () => {
  await bootAgent();
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  const seatNonce = `seatask${randomBytes(4).toString("hex")}`;
  const workerNonce = `workertask${randomBytes(4).toString("hex")}`;

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: `${workerNonce} reconcile the quarterly ledger` }, id: "se-delegate" }] },
        { say: "the worker reported back" },
      ],
      child: [{ say: "reconciled" }],
    }),
  );

  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: `<@9000000000000000001> ${seatNonce} reconcile the quarterly ledger`,
  });

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's terminal step to be served");
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the delegated worker's own terminal step" });
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const taskId = taskIdOfDelegation(handle, "the session-end delegation");
  const settlement = await awaitTaskSettlement({
    dispatched: handle,
    taskId,
    script: { parent: [{ calls: [{ tool: "task_cancel", input: { taskIds: [taskId] }, id: "se-peek" }] }, { say: "acknowledged" }] },
    label: "the worker's completion, delivered as a new message naming the task id",
  });
  afterThisTest(() => settlement.handle.dispose());

  const peeked = await waitFor(
    () => settlement.handle.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "task_cancel")),
    "the parent's step carrying the task_cancel result — eve's own terminal view of the worker",
  );
  expect(peeked.toolResults.find((t) => t.name === "task_cancel")!.isError).toBe(false);
  expect(settlement.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const seatFirst = handle.requests[0];
  expect(seatFirst.role).toBe("parent");
  expect(seatFirst.tools).toContain("agent");
  expect(seatFirst.messages.map((m) => m.text).join("\n")).toContain(seatNonce);
  const workerRequests = handle.requests.filter((r) => r.role === "child");
  expect(workerRequests.length).toBeGreaterThanOrEqual(1);
  expect(workerRequests[0].messages.map((m) => m.text).join("\n")).toContain(workerNonce);

  const { workflowSignature, signatureDigest } = await import("@open-everywhere/core/agent/memory/dream/recurrence.js");
  const digestOf = (text: string): string => {
    const sig = workflowSignature(text);
    expect(sig, "the fixture request must produce a signature, else the claims below pass for free").not.toBe("");
    return signatureDigest(sig);
  };
  const spellings = (nonce: string): string[] => [
    `${nonce} reconcile the quarterly ledger`,
    `<@9000000000000000001> ${nonce} reconcile the quarterly ledger`,
  ].map(digestOf);
  const seatDigests = spellings(seatNonce);
  const workerDigests = spellings(workerNonce);
  expect(
    seatDigests.filter((d) => workerDigests.includes(d)),
    "the two nonces must fingerprint apart, else ② is satisfied by ①'s own row",
  ).toEqual([]);

  const rows = await waitFor(async () => {
    const found = await readAuditRows({ actions: [SETTLEMENT_FLUSH_ACTION, OBSERVATION_ACTION], sinceIso, limit: 200 });
    return found.some((r) => r.action === OBSERVATION_ACTION && seatDigests.includes(observationSig(r.detail))) ? found : undefined;
  }, `a ${OBSERVATION_ACTION} row fingerprinting the SEAT's own request — the cycle running on the turn edge`);

  const observations = rows.filter((r) => r.action === OBSERVATION_ACTION);
  const sigs = observations.map((r) => observationSig(r.detail));

  expect(sigs.filter((s) => seatDigests.includes(s)).length).toBe(1);
  expect(sigs.filter((s) => workerDigests.includes(s))).toEqual([]);

  expect(observations.length).toBeGreaterThan(0);
  for (const row of observations) {
    const serialised = JSON.stringify(row.detail ?? {});
    expect(serialised, "a member's own word reached a taint-clean audit row").not.toContain(seatNonce);
    expect(serialised, "the parent model's brief reached a taint-clean audit row").not.toContain(workerNonce);
    expect(serialised, "the request's plain words reached a taint-clean audit row").not.toContain("quarterly");
    expect(observationSig(row.detail)).toMatch(/^[0-9a-f]{64}$/);
  }
});

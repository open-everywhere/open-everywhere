import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
} from "../harness";

const OBSERVATION_ACTION = "memory.observation";
const SETTLEMENT_FLUSH_ACTION = "memory.settlement_flush";

function observationSig(detail: Record<string, unknown> | undefined): string {
  const sig = detail?.["sigSha"];
  return typeof sig === "string" ? sig : "";
}

test("the dream cycle fingerprints the seat's own request and never the worker's brief", async () => {
  await bootAgent();
  const cursor = await auditCursor();

  const seatNonce = `seatask${randomBytes(4).toString("hex")}`;
  const workerNonce = `workertask${randomBytes(4).toString("hex")}`;

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: `${workerNonce} reconcile the quarterly ledger` }, id: "se-delegate" }] },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [{ delayMs: 120_000, say: "reconciled" }],
    }),
  );

  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: `<@9000000000000000001> ${seatNonce} reconcile the quarterly ledger`,
  });

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's receipt step");
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(cursor, handle, "se-delegate", "the session-end forward");
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the delegated worker's own terminal step" });

  const seatTurn = handle.requests.find((r) => r.role === "parent")!.turnId;
  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "the seat's step that read the worker's result" });
  expect(typeof resultStep.turnId, "the scripted model recorded no turnId, so the separate-turn check would be vacuous").toBe("string");
  expect(resultStep.stepIndex).toBe(0);
  expect(resultStep.turnId, "the worker's result arrives in a seat turn of its own (OPE-2338)").not.toBe(seatTurn);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(settlement.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const seatFirst = handle.requests[0];
  expect(seatFirst.role).toBe("parent");
  expect(seatFirst.tools).toContain("work");
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
    const found = await rowsSinceCursor(cursor, [SETTLEMENT_FLUSH_ACTION, OBSERVATION_ACTION], { limit: 200 });
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

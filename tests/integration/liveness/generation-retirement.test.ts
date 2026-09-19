import { expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import {
  GENERATION_RETIRED_AUDIT_ACTION,
  GENERATION_RETIREMENT_PRINCIPAL,
  GENERATION_RETIRE_SKIPPED_AUDIT_ACTION,
  generationOwedDelegation,
} from "@open-everywhere/core/agent/channels/generation-retirement.js";

import {
  auditCursor,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  registerScript,
  rowsSinceCursor,
  waitFor,
} from "../harness";

test("a real window rotation terminally retires the outgoing generation, and leaves the incoming one alone", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();
  const cursor = await auditCursor();

  const first = registerScript({ parent: [{ say: "generation one, answering" }] });
  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: "<@9000000000000000001> open the window",
    messageId: "ope627-retire-wake-1",
  });
  await waitFor(() => first.requests.find((r) => r.role === "parent"), "generation one's model call");
  expect(first.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"]);
    return rows.length > 0 ? rows : undefined;
  }, "generation one's reply — the turn is over");

  const seated = await waitFor(async () => {
    const rows = await store.listChannelSessions(org, "oe-domain::");
    return rows.length > 0 ? rows[0] : undefined;
  }, "the standing window's channel_session row");
  const registryKey = seated.surfaceKey;
  const outgoingToken = seated.token;
  expect(outgoingToken.length).toBeGreaterThan(0);

  expect(await rowsSinceCursor(cursor, [GENERATION_RETIRED_AUDIT_ACTION])).toEqual([]);

  const marked = await store.markChannelSessionRotation(org, registryKey, new Date().toISOString());
  expect(marked).toBe(true);

  await waitFor(async () => {
    for (const key of [outgoingToken, `unified:${outgoingToken}`]) {
      if (await store.getTurnAnchorByWindow(org, key)) return undefined;
    }
    return true as const;
  }, "generation one's turn anchor to clear");

  first.dispose();
  const second = registerScript({ parent: [{ say: "generation two, answering" }] });
  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: "<@9000000000000000001> and again",
    messageId: "ope627-retire-wake-2",
  });
  await waitFor(() => second.requests.find((r) => r.role === "parent"), "generation two's model call");
  expect(second.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  second.dispose();

  const retired = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [GENERATION_RETIRED_AUDIT_ACTION]);
    return rows.length > 0 ? rows : undefined;
  }, `a ${GENERATION_RETIRED_AUDIT_ACTION} row — the rotated generation was terminally retired`);
  expect(retired).toHaveLength(1);
  const detail = (retired[0]!.detail ?? {}) as Record<string, unknown>;
  expect(detail["token"]).toBe(outgoingToken);
  expect(detail["registryKey"]).toBe(registryKey);
  expect(retired[0]!.principalId).toBe(GENERATION_RETIREMENT_PRINCIPAL);
  expect(retired[0]!.platform).toBe("unified");

  const live = await store.getChannelSession(org, registryKey);
  expect(live).not.toBeNull();
  expect(live!.token).not.toBe(outgoingToken);
  expect(live!.generation).toBe(seated.generation + 1);
  const allRetirementRows = [
    ...(await rowsSinceCursor(cursor, [GENERATION_RETIRED_AUDIT_ACTION])),
    ...(await rowsSinceCursor(cursor, [GENERATION_RETIRE_SKIPPED_AUDIT_ACTION])),
  ];
  expect(allRetirementRows.filter((r) => (r.detail ?? {})["token"] === live!.token)).toEqual([]);
  expect(await rowsSinceCursor(cursor, [GENERATION_RETIRE_SKIPPED_AUDIT_ACTION])).toEqual([]);
});

test("a rotation SKIPS a generation that still owes a live delegation, and does not retire it", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();
  const cursor = await auditCursor();

  const dispatch = registerScript({
    parent: [{ calls: [{ tool: "agent", input: { message: "look this up and report back" }, id: "ope1620-delegate" }] }, { say: "on it — I have started a worker" }],
    child: [{ delayMs: 45_000, say: "the worker's answer" }],
  });
  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: "<@9000000000000000001> look something up for me",
    messageId: "ope1620-owed-wake-1",
  });
  await waitFor(() => dispatch.requests.find((r) => r.role === "child"), "the delegated worker's own model call — the worker really started");
  expect(dispatch.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const seated = await waitFor(async () => {
    const rows = await store.listChannelSessions(org, "oe-domain::");
    return rows.length > 0 ? rows[0] : undefined;
  }, "the standing window's channel_session row");
  const registryKey = seated.surfaceKey;
  const outgoingToken = seated.token;

  await waitFor(async () => ((await generationOwedDelegation(org, outgoingToken)) === "owed" ? true : undefined), "the generation's owed-delegation ledger row");

  expect(await store.markChannelSessionRotation(org, registryKey, new Date().toISOString())).toBe(true);
  await waitFor(async () => {
    for (const key of [outgoingToken, `unified:${outgoingToken}`]) {
      if (await store.getTurnAnchorByWindow(org, key)) return undefined;
    }
    return true as const;
  }, "the outgoing generation's turn anchor to clear");

  dispatch.dispose();
  const rotating = registerScript({ parent: [{ say: "generation two, answering" }], child: [{ say: "the worker's answer" }] });
  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: "<@9000000000000000001> and again",
    messageId: "ope1620-owed-wake-2",
  });
  await waitFor(() => rotating.requests.find((r) => r.role === "parent"), "the rotating generation's model call");

  const skipped = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, [GENERATION_RETIRE_SKIPPED_AUDIT_ACTION])).filter(
      (r) => (r.detail ?? {})["token"] === outgoingToken,
    );
    return rows.length > 0 ? rows : undefined;
  }, `a ${GENERATION_RETIRE_SKIPPED_AUDIT_ACTION} row for the generation that still owes a worker`);
  expect(skipped).toHaveLength(1);
  expect((skipped[0]!.detail ?? {})["skipped"]).toBe("skip-owed-delegation");
  const retired = (await rowsSinceCursor(cursor, [GENERATION_RETIRED_AUDIT_ACTION])).filter((r) => (r.detail ?? {})["token"] === outgoingToken);
  expect(retired).toEqual([]);

  dispatch.releaseHolds();
  await waitFor(async () => ((await generationOwedDelegation(org, outgoingToken)) === "none" ? true : undefined), "the settlement to clear the generation's owed-delegation row");
  rotating.dispose();

  const live = await store.getChannelSession(org, registryKey);
  expect(live!.token).not.toBe(outgoingToken);
  const rowsForLive = [
    ...(await rowsSinceCursor(cursor, [GENERATION_RETIRED_AUDIT_ACTION])),
    ...(await rowsSinceCursor(cursor, [GENERATION_RETIRE_SKIPPED_AUDIT_ACTION])),
  ].filter((r) => (r.detail ?? {})["token"] === live!.token);
  expect(rowsForLive).toEqual([]);
});

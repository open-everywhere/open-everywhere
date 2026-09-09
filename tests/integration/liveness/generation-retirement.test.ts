import { expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import {
  GENERATION_RETIRED_AUDIT_ACTION,
  GENERATION_RETIREMENT_PRINCIPAL,
  GENERATION_RETIRE_SKIPPED_AUDIT_ACTION,
} from "@open-everywhere/core/agent/channels/generation-retirement.js";

import { bootAgent, DISCORD_LISTED_CHANNEL_ID, discordMentionWake, readAuditRows, registerScript, waitFor } from "../harness";

test("a real window rotation terminally retires the outgoing generation, and leaves the incoming one alone", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();
  const sinceIso = new Date(Date.now() - 10_000).toISOString();

  const first = registerScript({ parent: [{ say: "generation one, answering" }] });
  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: "<@9000000000000000001> open the window",
    messageId: "ope627-retire-wake-1",
  });
  await waitFor(() => first.requests.find((r) => r.role === "parent"), "generation one's model call");
  expect(first.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["reply.post"], sinceIso });
    return rows.length > 0 ? rows : undefined;
  }, "generation one's reply — the turn is over");

  const seated = await waitFor(async () => {
    const rows = await store.listChannelSessions(org, "oe-domain::");
    return rows.length > 0 ? rows[0] : undefined;
  }, "the standing window's channel_session row");
  const registryKey = seated.surfaceKey;
  const outgoingToken = seated.token;
  expect(outgoingToken.length).toBeGreaterThan(0);

  expect(await readAuditRows({ actions: [GENERATION_RETIRED_AUDIT_ACTION], sinceIso })).toEqual([]);

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
    const rows = await readAuditRows({ actions: [GENERATION_RETIRED_AUDIT_ACTION], sinceIso });
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
    ...(await readAuditRows({ actions: [GENERATION_RETIRED_AUDIT_ACTION], sinceIso })),
    ...(await readAuditRows({ actions: [GENERATION_RETIRE_SKIPPED_AUDIT_ACTION], sinceIso })),
  ];
  expect(allRetirementRows.filter((r) => (r.detail ?? {})["token"] === live!.token)).toEqual([]);
  expect(await readAuditRows({ actions: [GENERATION_RETIRE_SKIPPED_AUDIT_ACTION], sinceIso })).toEqual([]);
});

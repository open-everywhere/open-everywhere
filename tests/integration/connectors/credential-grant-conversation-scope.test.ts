import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { isGrantToolName, type CredentialGrantRow } from "@open-everywhere/core/agent/operational/credential-grant-rows.js";
import { TASK_WAKE_ACTION } from "@open-everywhere/core/agent/channels/task-wake.js";

import {
  armSettlement,
  auditCursor,
  SETTLEMENT_DRAIN_SCRIPT,
  awaitWindowQuiet,
  bootAgent,
  consumeSettlement,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  DISCORD_USER_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const DOMAIN = "e2e-unified";
const DOMAIN_SCOPE_KEY = `oe-grant-domain::${DOMAIN}`;
const OWNER_PRINCIPAL = "slack/T0EXAMPLE/U0OPE1972OWNER";
const OWNER_SLUG = "ope1972owner";
const REQUESTER_PRINCIPAL = `discord/${DISCORD_USER_ID}`;
const VENDOR_TOOL = "notion-fetch";
const GRANTED_PAGE_ID = "6f7ea678-0000-4000-8000-000000001972";
const GRANT_TOOL_NAME = `grant__${OWNER_SLUG}_notion__notion_fetch_checklist`;
const CREATOR = "U0OPE1972CREATOR";
const FIRE_SURFACE_KEY = `discord/${DISCORD_GUILD_ID}/${DISCORD_LISTED_CHANNEL_ID}`;

function standingGrantRow(nowMs: number): CredentialGrantRow {
  return {
    askId: "ask-ope1972",
    connector: "notion",
    createdAt: new Date(nowMs - 60_000).toISOString(),
    expiresAt: new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString(),
    frozenArgs: { id: GRANTED_PAGE_ID },
    id: "g-ope1972-standing",
    inputSchema: { properties: { id: { const: GRANTED_PAGE_ID, type: "string" } }, required: ["id"], type: "object" },
    mcpTool: VENDOR_TOOL,
    mode: "standing",
    ownerPrincipalId: OWNER_PRINCIPAL,
    ownerSlug: OWNER_SLUG,
    purpose: "read the launch checklist before the release call",
    requesterPrincipalId: REQUESTER_PRINCIPAL,
    resource: GRANTED_PAGE_ID,
    scopeKey: DOMAIN_SCOPE_KEY,
    status: "active",
    tier: "read",
    toolName: GRANT_TOOL_NAME,
    verb: "notion_fetch",
  };
}

const borrowedToolsIn = (tools: readonly string[] | undefined): readonly string[] => (tools ?? []).filter((t) => isGrantToolName(t));

const delegatingSeat = (message: string, callId: string) => ({
  parent: [{ calls: [{ tool: "agent", input: { message }, id: callId }] }, { say: "the worker has it" }],
  child: [{ say: message }],
});

async function seedDivertedFire(org: string): Promise<string> {
  const { addRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  const routineId = `r-ope1972-${randomBytes(4).toString("hex")}`;
  await addRoutine(
    {
      org,
      platform: "discord",
      workspace: DISCORD_GUILD_ID,
      surface: DISCORD_LISTED_CHANNEL_ID,
      workspaceKey: `discord/${DISCORD_GUILD_ID}`,
      surfaceKey: FIRE_SURFACE_KEY,
      domainKey: FIRE_SURFACE_KEY,
      key: FIRE_SURFACE_KEY,
    },
    {
      id: routineId,
      org,
      surfaceKey: FIRE_SURFACE_KEY,
      target: { channelId: DISCORD_LISTED_CHANNEL_ID, guildId: DISCORD_GUILD_ID, channelType: "0" },
      trigger: { kind: "once", at: dueAt },
      prompt: "ope1972 — check the launch checklist",
      createdBy: CREATOR,
      status: "active",
      nextRunAt: dueAt,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      promptGeneration: 1,
      consecutiveFailures: 0,
    },
  );
  return routineId;
}

async function drainDelegation(dispatched: ScriptedHandle, label: string): Promise<RecordedRequest> {
  const wakeCursor = await auditCursor();
  await waitFor(
    () => dispatched.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "agent")),
    `${label}: the resumed step carrying the delegation receipt`,
  );
  const taskId = taskIdOfDelegation(dispatched, label);
  const armed = armSettlement(dispatched, SETTLEMENT_DRAIN_SCRIPT);
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: `${label}: the delegated worker to finish its own arm` });
  const worker = await waitFor(() => dispatched.requests.find((r) => r.role === "child" && r.stepIndex === 0), `${label}: the worker's own first model call`);
  await consumeSettlement({ armed, dispatched, taskId, label: `${label}: the delegation's settlement notification` });
  await waitFor(async () => {
    const rows = await rowsSinceCursor(wakeCursor, [TASK_WAKE_ACTION]);
    return rows.some((r) => (r.detail as { task?: unknown } | undefined)?.task === taskId) ? true : undefined;
  }, `${label}: the settlement edge's own ${TASK_WAKE_ACTION} row`);
  await awaitWindowQuiet();
  expect([...dispatched.requests, ...armed.requests].filter((r) => r.fault !== undefined), `${label}: the script degraded`).toEqual([]);
  armed.dispose();
  return worker;
}

test("a standing grant reaches a WORKER of the domain's standing seat, never the seat, and is WITHHELD from an unattended routine fire's worker with a row naming the refusal", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();
  const cursor = await auditCursor();

  await store.addCredentialGrant(org, standingGrantRow(Date.now()));
  const live = await store.liveStandingCredentialGrantsForScope(org, DOMAIN_SCOPE_KEY, new Date().toISOString());
  expect(live.map((g) => g.id), `the seeded standing grant is not live for ${DOMAIN_SCOPE_KEY} — the fixture, not the claim, is broken`).toContain(
    "g-ope1972-standing",
  );

  const seatScript = disposeLater(registerScript(delegatingSeat("ope1972 standing", "ope1972-seat-delegate")));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> ope1972 standing", messageId: "ope1972-seat" });
  const seatCall = await waitFor(() => seatScript.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the standing seat's model call");
  const seatWorkerCall = await drainDelegation(seatScript, "the standing seat's delegation");
  expect(
    borrowedToolsIn(seatWorkerCall.tools),
    "a WORKER of the domain's STANDING seat was offered no borrowed tool at all — the standing grant the owner tapped is now reachable by nothing",
  ).toContain(GRANT_TOOL_NAME);
  expect(
    borrowedToolsIn(seatCall.tools),
    "the domain's STANDING SEAT was offered a borrowed tool — a lent tool mounts on the conversation's workers, never on the seat",
  ).toEqual([]);
  expect(seatCall.tools, "the standing seat's offer carries no `agent` verb — the assertion above would then be vacuous").toContain("agent");

  const fireScript = disposeLater(registerScript(delegatingSeat("ope1972 fire", "ope1972-fire-delegate")));
  const fireRoutineId = await seedDivertedFire(org);
  await runRoutineDispatchTick();
  const fireCall = await waitFor(() => fireScript.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the routine fire's model call");
  expect(
    fireCall.messages.some((m) => m.text.includes(fireRoutineId)),
    "the turn measured as the routine fire's does not name the seeded routine — an earlier leg's turn was served this script, so this measurement is that leg's and not the fire's",
  ).toBe(true);
  expect(fireCall.tools, "the routine fire's seat carries no `agent` verb, so this leg can drive no worker").toContain("agent");
  const fireWorkerCall = await drainDelegation(fireScript, "the routine fire's delegation");
  expect(
    borrowedToolsIn(fireWorkerCall.tools),
    "a WORKER of an UNATTENDED routine fire was offered a borrowed credential tool — nobody is in the room to be asking, and the grant spends a person's own account",
  ).toEqual([]);
  expect(borrowedToolsIn(fireCall.tools), "the routine fire's SEAT was offered a borrowed credential tool").toEqual([]);

  const withheld = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["grant.mount_withheld"]);
    return rows.length > 0 ? rows : undefined;
  }, "a grant.mount_withheld audit row");
  const detail = withheld[0]?.detail as Record<string, unknown> | undefined;
  expect(detail?.["grantIds"], "the withholding row does not name the grant it refused, so nothing joins it to the consent").toEqual([
    "g-ope1972-standing",
  ]);
  expect(detail?.["scopeKey"], "the withholding row does not name the scope it refused").toBe(DOMAIN_SCOPE_KEY);
  expect(detail?.["gate"], "the withholding row does not name ATTENDANCE as the reason the fire's worker was refused").toBe("unattended");
});

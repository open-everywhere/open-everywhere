// proves: grant.mount_withheld

import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { isGrantToolName, type CredentialGrantRow } from "@open-everywhere/core/agent/operational/credential-grant-rows.js";
import { TASK_WAKE_ACTION } from "@open-everywhere/core/agent/channels/task-wake.js";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";

import {
  armSettlement,
  auditCursor,
  awaitTaskResult,
  awaitWindowQuiet,
  awaitWorkResult,
  bootAgent,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  DISCORD_USER_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  taskIdFromReceipt,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
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

const forwardingSeat = (message: string, callId: string) => ({
  parent: [{ calls: [{ tool: "work", input: { message }, id: callId }] }, { say: NO_REPLY_SENTINEL }],
  child: [{ delayMs: 120_000, say: message }],
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

async function drainWork(dispatched: ScriptedHandle, callId: string, label: string): Promise<RecordedRequest> {
  const wakeCursor = await auditCursor();
  const taskId = await workTaskIdOfCall(wakeCursor, dispatched, callId, `${label}: the forward receipt`);
  await waitFor(() => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${label}: the dispatch turn's last step`);
  const worker = await waitFor(() => dispatched.requests.find((r) => r.role === "child" && r.stepIndex === 0), `${label}: the worker's own first model call`);
  const settlement = armSettlement(dispatched, { parent: [{ say: NO_REPLY_SENTINEL }] });
  dispatched.releaseHolds();
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: `${label}: the delegated worker to finish its own arm` });
  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: `${label}: the seat's step that read the worker's result` });
  expect(resultStep.fault, `${label}: the result step degraded`).toBeUndefined();
  await waitFor(async () => {
    const rows = await rowsSinceCursor(wakeCursor, [TASK_WAKE_ACTION]);
    return rows.some((r) => (r.detail as { task?: unknown } | undefined)?.task === taskId) ? true : undefined;
  }, `${label}: the settlement edge's own ${TASK_WAKE_ACTION} row`);
  await awaitWindowQuiet();
  expect(dispatched.requests.filter((r) => r.fault !== undefined), `${label}: the script degraded`).toEqual([]);
  expect(settlement.requests.filter((r) => r.fault !== undefined), `${label}: the result-wake script degraded`).toEqual([]);
  dispatched.dispose();
  settlement.dispose();
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

  const seatScript = disposeLater(registerScript(forwardingSeat("ope1972 standing", "ope1972-seat-delegate")));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> ope1972 standing", messageId: "ope1972-seat" });
  const seatCall = await waitFor(() => seatScript.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the standing seat's model call");
  const seatWorkerCall = await drainWork(seatScript, "ope1972-seat-delegate", "the standing seat's delegation");
  expect(
    borrowedToolsIn(seatWorkerCall.tools),
    "a WORKER of the domain's STANDING seat was offered no borrowed tool at all — the standing grant the owner tapped is now reachable by nothing",
  ).toContain(GRANT_TOOL_NAME);
  expect(
    borrowedToolsIn(seatCall.tools),
    "the domain's STANDING SEAT was offered a borrowed tool — a lent tool mounts on the conversation's workers, never on the seat",
  ).toEqual([]);
  expect(seatCall.tools, "the standing seat's offer carries no `work` verb — the assertion above would then be vacuous").toContain("work");

  const fireScript = disposeLater(registerScript({ parent: [{ say: NO_REPLY_SENTINEL }], child: [{ say: "ope1972 fire" }] }));
  const fireRoutineId = await seedDivertedFire(org);
  const fireCursor = await auditCursor();
  await runRoutineDispatchTick();
  const fireWorkerCall = await waitFor(
    () => fireScript.requests.find((r) => r.role === "child" && r.stepIndex === 0 && r.messages.some((m) => m.text.includes(fireRoutineId))),
    "the routine fire's worker's own first model call (its brief names the seeded routine)",
  );
  expect(
    borrowedToolsIn(fireWorkerCall.tools),
    "a WORKER of an UNATTENDED routine fire was offered a borrowed credential tool — nobody is in the room to be asking, and the grant spends a person's own account",
  ).toEqual([]);
  await waitFor(async () => {
    const rows = await rowsSinceCursor(fireCursor, ["work.result_wake"]);
    return rows.some((r) => (r.detail as { fire?: unknown } | undefined)?.fire === true) ? true : undefined;
  }, "the routine fire's work.result_wake row");
  await awaitWindowQuiet();
  expect(fireScript.requests.filter((r) => r.fault !== undefined), "the routine fire's script degraded").toEqual([]);

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

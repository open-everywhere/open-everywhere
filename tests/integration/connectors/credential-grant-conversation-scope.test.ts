import { expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { isGrantToolName, type CredentialGrantRow } from "@open-everywhere/core/agent/operational/credential-grant-rows.js";

import {
  auditCursor,
  bootAgent,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  DISCORD_USER_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  seedDueRoutine,
  waitFor,
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

test("a standing grant is offered to the domain's standing seat and WITHHELD from an unattended routine fire, with a row naming the refusal", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();
  const cursor = await auditCursor();

  await store.addCredentialGrant(org, standingGrantRow(Date.now()));
  const live = await store.liveStandingCredentialGrantsForScope(org, DOMAIN_SCOPE_KEY, new Date().toISOString());
  expect(live.map((g) => g.id), `the seeded standing grant is not live for ${DOMAIN_SCOPE_KEY} — the fixture, not the claim, is broken`).toContain(
    "g-ope1972-standing",
  );

  const seatScript = disposeLater(registerScript({ parent: [{ say: "ope1972 standing seat" }] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> ope1972 standing", messageId: "ope1972-seat" });
  const seatCall = await waitFor(() => seatScript.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the standing seat's model call");
  expect(seatScript.requests.filter((r) => r.fault !== undefined), "the standing seat's script degraded").toEqual([]);
  expect(
    borrowedToolsIn(seatCall.tools),
    "the domain's STANDING seat was offered no borrowed tool at all — OPE-1972 narrowed the rule into deleting it",
  ).toContain(GRANT_TOOL_NAME);
  seatScript.dispose();

  const fireScript = disposeLater(registerScript({ parent: [{ say: "ope1972 fire" }] }));
  await seedDueRoutine({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    createdBy: CREATOR,
    org,
    prompt: "ope1972 — check the launch checklist",
    surfaceKey: `discord/${DISCORD_GUILD_ID}/${DISCORD_LISTED_CHANNEL_ID}`,
  });
  await runRoutineDispatchTick();
  const fireCall = await waitFor(() => fireScript.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the routine fire's model call");
  expect(fireScript.requests.filter((r) => r.fault !== undefined), "the routine fire's script degraded").toEqual([]);
  expect(
    borrowedToolsIn(fireCall.tools),
    "an UNATTENDED routine fire was offered a borrowed credential tool — nobody is in the room to be asking, and the grant spends a person's own account",
  ).toEqual([]);
  fireScript.dispose();

  const withheld = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["grant.mount_withheld"]);
    return rows.length > 0 ? rows : undefined;
  }, "a grant.mount_withheld audit row");
  const detail = withheld[0]?.detail as Record<string, unknown> | undefined;
  expect(detail?.["grantIds"], "the withholding row does not name the grant it refused, so nothing joins it to the consent").toEqual([
    "g-ope1972-standing",
  ]);
  expect(detail?.["scopeKey"], "the withholding row does not name the scope it refused").toBe(DOMAIN_SCOPE_KEY);
  expect(detail?.["gate"], "the withholding row does not name ATTENDANCE as the reason the fire was refused").toBe("unattended");
});

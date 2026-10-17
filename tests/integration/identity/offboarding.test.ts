// proves: identity.offboard.applied, identity.offboard.refused, grant.revoked, browser.personal.forget

import { afterAll, expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { encryptedKvVault } from "@open-everywhere/core/agent/credentials/kv-vault.js";
import { effectiveUserVaultSubject } from "@open-everywhere/core/agent/connections/connector-auth.js";
import { rawVaultSubject } from "@open-everywhere/core/agent/identity/oauth-vault-share.js";
import { confirmLinkedId, ensureLinkSet, suggestLinkedId } from "@open-everywhere/core/agent/identity/link-store.js";
import { persistKeyFor } from "@open-everywhere/core/agent/personal-browser/lifecycle.js";
import type { CredentialGrantRow } from "@open-everywhere/core/agent/operational/credential-grant-rows.js";

import { auditCursor, bootAgent, installSlackWebApiStub, rowsSinceCursor, SLACK_TEAM_ID, waitForAuditRows } from "../harness";

const SLACK_ROUTE = "/eve/v1/slack";
const NOTION_OAUTH_PROVIDER_REF = "mcp.notion.com/notion-mcp";

const GONE = { slack: "U0OPE2504GONE", discord: "300000000000002504", linkSet: "ls-ope2504-gone" } as const;
const STAY = { slack: "U0OPE2504STAY", discord: "300000000000002505", linkSet: "ls-ope2504-stay" } as const;

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

const principalKey = (nativeId: string): string => `slack/${SLACK_TEAM_ID}/${nativeId}`;

async function postUserDeleted(base: string, nativeId: string, eventId: string): Promise<number> {
  const { signSlackRequest } = await import("../../../packages/core/scripts/e2e/synthetic");
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) throw new Error("the harness boot sets SLACK_SIGNING_SECRET; it is unset");
  const rawBody = JSON.stringify({
    type: "event_callback",
    team_id: SLACK_TEAM_ID,
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    event: { type: "user_change", user: { id: nativeId, team_id: SLACK_TEAM_ID, deleted: true }, event_ts: `${Math.floor(Date.now() / 1000)}.000100` },
  });
  const signed = signSlackRequest(rawBody, secret);
  const res = await fetch(`${base}${SLACK_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": signed.timestamp, "x-slack-signature": signed.signature },
    body: rawBody,
    signal: AbortSignal.timeout(60_000),
  });
  await res.text();
  return res.status;
}

function lentGrant(id: string, ownerNativeId: string): CredentialGrantRow {
  const now = Date.now();
  return {
    id,
    askId: `${id}-ask`,
    requesterPrincipalId: principalKey("U0OPE2504ROOM"),
    ownerPrincipalId: principalKey(ownerNativeId),
    ownerSlug: ownerNativeId.toLowerCase(),
    connector: "notion",
    verb: "read",
    resource: "page",
    mcpTool: "notion-fetch",
    frozenArgs: { id: `${id}-page` },
    toolName: `grant__${ownerNativeId.toLowerCase()}_notion__notion_fetch_page`,
    scopeKey: "oe-grant-room::e2e-unified",
    mode: "standing",
    tier: "read",
    status: "active",
    purpose: "read the launch checklist",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 24 * 3600_000).toISOString(),
  };
}

test("an offboarded person loses every holding OE keeps for them, and an active person named by a forged report loses nothing", async () => {
  const { base } = await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();
  const vault = encryptedKvVault();

  const slack = installSlackWebApiStub((method, params) => {
    if (method !== "users.info") return undefined;
    const user = params.get("user");
    if (user === GONE.slack) return { ok: true, user: { id: GONE.slack, team_id: SLACK_TEAM_ID, deleted: true } };
    if (user === STAY.slack) return { ok: true, user: { id: STAY.slack, team_id: SLACK_TEAM_ID, deleted: false } };
    return undefined;
  });
  cleanups.push(() => slack.uninstall());

  const forgotten: string[] = [];
  const boxMod = await import("@open-everywhere/core/agent/sandbox/long-lived-box.js");
  boxMod.registerLongLivedBoxBackend({
    backend: "fake",
    metered: true,
    maxMinutesCeiling: 1440,
    enforcesHostAllowList: true,
    async open() {
      throw new Error("this test opens no box");
    },
    async status() {
      return undefined;
    },
    async list() {
      return [];
    },
    async stop() {},
    async forget(persistKey) {
      forgotten.push(persistKey);
    },
  });
  cleanups.push(() => boxMod.resetLongLivedBoxBackendForTest());

  const tokenRefs = new Map<string, string[]>();
  for (const p of [GONE, STAY]) {
    const evidence = { kind: "config-import" as const, note: "OPE-2504 integration fixture" };
    await ensureLinkSet({ org, linkSetId: p.linkSet, handle: p.linkSet });
    for (const account of [
      { platform: "slack", tenant: SLACK_TEAM_ID, nativeId: p.slack },
      { platform: "discord", tenant: "", nativeId: p.discord },
    ]) {
      expect((await suggestLinkedId({ org, linkSetId: p.linkSet, account, evidence })).ok, `fixture: suggest ${account.nativeId}`).toBe(true);
      expect((await confirmLinkedId({ org, account, evidence })).ok, `fixture: confirm ${account.nativeId}`).toBe(true);
    }
    const subjects = new Set([await effectiveUserVaultSubject("notion", org, "slack", SLACK_TEAM_ID, p.slack), rawVaultSubject(org, "slack", SLACK_TEAM_ID, p.slack)]);
    const refs = [...subjects].map((s) => `oe-oauth:tok:${NOTION_OAUTH_PROVIDER_REF}:user:${s}`);
    for (const ref of refs) await vault.write(ref, JSON.stringify({ accessToken: `tok-${p.slack}`, obtainedAt: Date.now() }));
    tokenRefs.set(p.slack, refs);
    await store.addCredentialGrant(org, lentGrant(`grant-${p.slack}`, p.slack));
    const key = principalKey(p.slack);
    const surface = `D0${p.slack}`;
    const state = {
      v: 1,
      org,
      person: key,
      principalId: p.slack,
      platform: "slack",
      dm: { channelId: surface },
      partition: { org, platform: "slack", workspace: SLACK_TEAM_ID, surface, workspaceKey: `slack/${SLACK_TEAM_ID}`, surfaceKey: `slack/${SLACK_TEAM_ID}/${surface}` },
      persistKey: persistKeyFor(org, key),
      lock: { holder: "agent", since: Date.now() },
      acts: {},
      links: {},
      sessions: { [`watch-${p.slack}`]: Date.now() + 3600_000 },
    };
    expect(await store.casPersonalBrowser(org, key, JSON.stringify(state), new Date().toISOString(), null), `fixture: browser row for ${p.slack}`).not.toBeNull();
  }

  const holdings = async (p: typeof GONE | typeof STAY) => ({
    setStatus: (await store.getLinkSet(org, p.linkSet))?.status,
    accounts: (await store.listLinkedIds(org, p.linkSet)).map((r) => r.status),
    tokens: await Promise.all((tokenRefs.get(p.slack) ?? []).map(async (ref) => (await vault.read(ref)) !== null && (await vault.read(ref)) !== undefined)),
    grant: (await store.getCredentialGrant(org, `grant-${p.slack}`))?.status,
    browser: (await store.getPersonalBrowser(org, principalKey(p.slack))) !== null,
  });
  const before = { gone: await holdings(GONE), stay: await holdings(STAY) };
  for (const h of [before.gone, before.stay]) {
    expect(h, "precondition: every holding is live before any report").toEqual({ setStatus: "active", accounts: ["confirmed", "confirmed"], tokens: h.tokens.map(() => true), grant: "active", browser: true });
    expect(h.tokens.length).toBeGreaterThan(0);
  }

  const cursor = await auditCursor();
  expect(await postUserDeleted(base, STAY.slack, "EvOPE2504STAY"), "the signed front route acks the forged event").toBe(200);
  const refused = await waitForAuditRows({
    cursor,
    actions: ["identity.offboard.refused"],
    label: "the refusal row for the forged report",
    probe: async () => (await rowsSinceCursor(cursor, ["identity.offboard.refused"])).find((r) => String((r.detail as { account?: unknown }).account).endsWith(STAY.slack)),
    timeoutMs: 60_000,
  });
  expect((refused.detail as { reason?: unknown }).reason, "the forged report refuses at the live confirmation").toBe("unconfirmed");
  expect(slack.calls.some((c) => c.method === "users.info" && c.params.get("user") === STAY.slack), "the route really asked Slack").toBe(true);
  expect(await holdings(STAY), "🔴 the active person keeps EVERY holding").toEqual(before.stay);
  expect(forgotten, "no saved browser profile was forgotten").toEqual([]);

  expect(await postUserDeleted(base, GONE.slack, "EvOPE2504GONE"), "the signed front route acks the event").toBe(200);
  const applied = await waitForAuditRows({
    cursor,
    actions: ["identity.offboard.applied"],
    label: "the applied row for the deactivation",
    probe: async () => (await rowsSinceCursor(cursor, ["identity.offboard.applied"])).find((r) => String((r.detail as { account?: unknown }).account).endsWith(GONE.slack)),
    timeoutMs: 60_000,
  });
  const detail = applied.detail as Record<string, unknown>;
  expect(detail.outcome, "the confirmed deactivation revokes the link-set").toBe("revoked");
  expect(detail.holdingFailures, "no holding failed to end").toBeUndefined();
  expect(detail.grantsRevoked, "the applied row counts the lent grant it ended").toBe(1);
  expect(detail.browsersForgotten, "the applied row counts the browser it forgot").toBe(1);

  const after = await holdings(GONE);
  expect(after.setStatus, "🔴 the link-set is revoked").toBe("revoked");
  expect(after.accounts, "🔴 every linked account is tombstoned, the Discord one included").toEqual(["revoked", "revoked"]);
  expect(after.tokens, "🔴 every stored personal credential is gone").toEqual(after.tokens.map(() => false));
  expect(after.grant, "🔴 the grant the person lent is revoked").toBe("revoked");
  expect(after.browser, "🔴 the personal browser row is deleted").toBe(false);
  expect(forgotten, "🔴 the saved browser profile (the person's logins) is deleted on the backend").toContain(persistKeyFor(org, principalKey(GONE.slack)));
  const grantRows = await rowsSinceCursor(cursor, ["grant.revoked"]);
  expect(
    grantRows.some((r) => (r.detail as { grantId?: unknown; route?: unknown }).grantId === `grant-${GONE.slack}` && (r.detail as { route?: unknown }).route === "cascade"),
    "the grant's own audit row says the offboarding cascade ended it",
  ).toBe(true);

  const forgetRows = await rowsSinceCursor(cursor, ["browser.personal.forget"]);
  expect(
    forgetRows.some((r) => r.principalId === GONE.slack && (r.detail as { by?: unknown }).by === "surface-deactivation:slack:user_change"),
    "the browser's own browser.personal.forget row names the offboarding as the actor",
  ).toBe(true);
  expect(forgetRows.some((r) => r.principalId === STAY.slack), "no browser.personal.forget row names the active person").toBe(false);

  expect(await holdings(STAY), "🔴 the active person keeps EVERY holding after the other person's offboarding").toEqual(before.stay);
  expect(forgotten, "🔴 the active person's saved browser profile was never forgotten").not.toContain(persistKeyFor(org, principalKey(STAY.slack)));
});

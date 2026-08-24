process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";

import assert from "node:assert/strict";
import { getOperationalStore } from "../agent/operational/provider.js";
import { grantOwnerSubject } from "../agent/access/credential-grant-owner.js";
import { rawVaultSubject, sharedVaultSubject } from "../agent/identity/oauth-vault-share.js";
import { registerSettings, resetSettingsForTest } from "../agent/settings/settings.js";
import {
  _resetGrantTransportsForTest,
  registerGrantTransport,
  runGrantedCall,
  type GrantCallContext,
} from "../agent/access/credential-grant-broker.js";
import { _resetGrantableVerbsForTest, credentialGrantMintVerdict, registerGrantableVerb } from "../agent/access/credential-grant.js";
import { credentialGrantRefusalMessage, type CredentialGrantRow } from "../agent/operational/credential-grant-rows.js";
import type { GrantOwnerSubject } from "../agent/access/credential-grant-owner.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const ORG = "acme";
const WS = "T-OPE1074";
const store = getOperationalStore();

console.log("1. the owner's vault subject comes from the OWNER'S principal key:");
{
  const slack = await grantOwnerSubject(ORG, "notion", `slack/${WS}/U-owner`);
  ok(slack !== undefined, "a well-formed slack owner key derives a subject");
  eq(slack!.vaultSubject, rawVaultSubject(ORG, "slack", WS, "U-owner"), "…composed by the SAME grammar the owner's own DM authorization wrote through");
  eq(slack!.vaultSubject, `p:${ORG}/slack/${WS}/U-owner`, "…which spells p:<org>/<platform>/<tenant>/<id> on a tenant-scoped platform");
  eq(slack!.platform, "slack", "the platform is read off the OWNER'S key, never off the calling surface");
  eq(slack!.tenant, WS, "…and so is the tenant rung, which is the namespace a slack id is issued in");
  eq(slack!.shared, false, "…and an unlinked owner is not reported as link-set keyed");

  const discord = await grantOwnerSubject(ORG, "notion", "discord/9001");
  eq(discord!.vaultSubject, `p:${ORG}/discord/9001`, "a vendor-global platform's owner subject carries no tenant rung");
  eq(discord!.tenant, undefined, "…and names none");

  const other = await grantOwnerSubject(ORG, "notion", `slack/${WS}/U-somebody-else`);
  ok(other!.vaultSubject !== slack!.vaultSubject, "a DIFFERENT owner derives a DIFFERENT subject — the key is read, not ignored");

  const otherOrg = await grantOwnerSubject("other-org", "notion", `slack/${WS}/U-owner`);
  ok(otherOrg!.vaultSubject !== slack!.vaultSubject, "…and the SAME owner in another org derives another subject — the org qualifier is real");
}

console.log("2. an owner nobody can resolve derives NOTHING:");
{
  eq(await grantOwnerSubject(ORG, "notion", "slack:U-owner"), undefined, "a colon-spelled owner is not a principal key and derives no subject");
  eq(await grantOwnerSubject(ORG, "notion", "slack/U-owner"), undefined, "…nor is a slack key with no tenant rung: a bare slack id names two humans across two workspaces");
  eq(await grantOwnerSubject(ORG, "notion", ""), undefined, "…nor is an empty string");
  eq(await grantOwnerSubject(ORG, "notion", "slack/dev/U-owner"), undefined, "…nor is the \"nobody said\" tenant sentinel, which is not a workspace id");
  ok(
    credentialGrantRefusalMessage({ ownerSlug: "rowan", resource: "notion:page/abc", verb: "read_page" }, "owner_unresolvable").includes("rowan"),
    "the refusal copy names the owner it could not resolve",
  );
}

console.log("3. the same fact refuses at the MINT, one refusal instead of a dead grant:");
{
  _resetGrantableVerbsForTest();
  registerGrantableVerb({
    compose: (g) => ({ method: "GET", url: `https://api.notion.com/v1/blocks/${g.resource}/children` }),
    connector: "notion",
    describe: () => "read one page",
    inputSchema: { properties: {}, type: "object" },
    resourceKind: "page",
    tier: "read",
    verb: "read_page",
  });
  const mintInput = (ownerPrincipalId: string) => ({
    connector: "notion",
    domainGrantsConnector: true,
    liveGrant: undefined,
    ownerHandle: "Rowan Hale",
    ownerPrincipalId,
    requesterPrincipalId: `slack/${WS}/U-req`,
    resource: "notion:page/abc123",
    verb: "read_page",
  });
  const bad = credentialGrantMintVerdict(mintInput("slack:U-owner"));
  eq(bad.ok ? "OK" : bad.reason, "unresolvable_owner", "an ask naming an unresolvable owner refuses at the mint");
  const good = credentialGrantMintVerdict(mintInput(`slack/${WS}/U-owner`));
  eq(good.ok, true, "…and a well-formed owner key still mints — the negative control for the new arm");
}

console.log("4. a confirmed link-set member derives the link-set subject, and the flag decides:");
{
  const at = new Date().toISOString();
  await store.putLinkSet(ORG, { createdAt: at, handle: "S-owner", id: "S-owner", org: ORG, status: "active", updatedAt: at });
  await store.insertLinkedId(ORG, {
    createdAt: at,
    establishedBy: "test",
    evidenceJson: undefined,
    linkSetId: "S-owner",
    nativeId: "U-linked",
    org: ORG,
    platform: "slack",
    status: "confirmed",
    tenant: WS,
    updatedAt: at,
  });

  resetSettingsForTest();
  const off = await grantOwnerSubject(ORG, "notion", `slack/${WS}/U-linked`);
  eq(off!.vaultSubject, rawVaultSubject(ORG, "slack", WS, "U-linked"), "flag OFF: a confirmed member still derives their OWN raw subject");
  eq(off!.shared, false, "…and is not reported as shared");

  registerSettings({ connectors: { linkSetVault: true } });
  const on = await grantOwnerSubject(ORG, "notion", `slack/${WS}/U-linked`);
  eq(on!.vaultSubject, sharedVaultSubject(ORG, "S-owner"), "flag ON: a confirmed member derives the org-scoped LINK-SET subject — the row their consent-once wrote");
  eq(on!.shared, true, "…and says so");

  const unlinked = await grantOwnerSubject(ORG, "notion", `slack/${WS}/U-owner`);
  eq(unlinked!.vaultSubject, rawVaultSubject(ORG, "slack", WS, "U-owner"), "flag ON but unlinked: the owner's OWN raw subject, never a stranger's set");
  resetSettingsForTest();
}

console.log("5. the broker hands the owner subject to the transport, and refuses before any burn:");
{
  const NOW = Date.parse("2026-01-29T18:22:00.000Z");
  const seen: GrantOwnerSubject[] = [];
  _resetGrantTransportsForTest();
  registerGrantTransport("notion", async (_request, _grant, owner) => {
    seen.push(owner);
    return { blocks: [] };
  });

  const ctx = (): GrantCallContext => ({
    nowMs: NOW,
    org: ORG,
    platform: "slack",
    requesterPrincipalId: `slack/${WS}/U-req`,
    scopeKey: "session-1074",
    workspace: WS,
  });
  const row = (id: string, ownerPrincipalId: string, mode: "once" | "session"): CredentialGrantRow => ({
    askId: `ask-${id}`,
    connector: "notion",
    createdAt: new Date(NOW - 1000).toISOString(),
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    id,
    mode,
    ownerPrincipalId,
    ownerSlug: "rowan",
    purpose: "draft the Q3 summary",
    requesterPrincipalId: `slack/${WS}/U-req`,
    resource: "notion:page/abc123",
    scopeKey: "session-1074",
    status: "active",
    tier: "read",
    verb: "read_page",
  });
  await store.addCredentialGrant(ORG, row("g-good", `slack/${WS}/U-owner`, "session"));
  await store.addCredentialGrant(ORG, row("g-bad", "slack:U-owner", "once"));

  const good = await runGrantedCall("g-good", {}, ctx());
  eq(good.ok, true, "a granted call with a resolvable owner completes through the broker");
  eq(seen.length, 1, "…and the registered transport was reached exactly once");
  eq(seen[0]!.vaultSubject, rawVaultSubject(ORG, "slack", WS, "U-owner"), "…carrying the OWNER'S vault subject, which is the transport's only channel for it");
  ok(seen[0]!.vaultSubject.includes("U-owner"), "…the owner's id, not the requester's");
  ok(!seen[0]!.vaultSubject.includes("U-req"), "…and never the REQUESTER'S — that difference is the whole plane");

  const bad = await runGrantedCall("g-bad", {}, ctx());
  eq(bad.ok ? "OK" : bad.refused, "owner_unresolvable", "an unresolvable owner refuses BY NAME rather than spending anybody's credential");
  eq(seen.length, 1, "…and the transport was never reached a second time");
  eq((await store.getCredentialGrant(ORG, "g-bad"))?.status, "active", "…and the once-mode grant is NOT burned: the check runs before the burn");
}

console.log(`\ncredential-grant-owner: ${n} assertions passed.`);

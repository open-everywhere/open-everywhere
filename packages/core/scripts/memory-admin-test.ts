import assert from "node:assert/strict";
import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-memory-admin-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_MEMORY_PROVIDER;
_setDeploymentIdentityForTest({ org: "acme" });
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { defineMemorySilo } from "../agent/memory/silo.js";
import { providerById } from "../agent/memory/provider.js";
import { siloTier } from "../agent/memory/store.js";
import { controlPartition } from "../agent/memory/partition.js";
import { readAudit } from "../agent/audit/audit.js";
import { adminControlRoles } from "../agent/access/roles.js";
import { classifyAdminReadVenue } from "../agent/access/admin-read-venue.js";
import { PaneRedirectError } from "../agent/access/pane-venue.js";
import {
  registerGovernanceMemberSupplier,
  _resetGovernanceFloorCacheForTest,
  _resetGovernanceMemberSupplierForTest,
} from "../agent/access/audience-floor.js";
import type { BindableContext } from "../agent/identity/binding.js";
import memoryAdminListTool from "../agent/tools/memory_admin_list.js";
import memoryAdminReadTool from "../agent/tools/memory_admin_read.js";
import { execTool } from "./_tool-exec.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const org = "acme";
const engSilo = defineMemorySilo({ name: "eng-silo", provider: "sqlite" });
const salesSilo = defineMemorySilo({ name: "sales-silo", provider: "sqlite" });
const orgSilo = defineMemorySilo({ name: "org-brain", provider: "sqlite" });
const domains = [
  defineDomain({ name: "eng", reach: ["slack/T1/C_ENG"], memory: "eng-silo", admins: ["slack/T1/U_ENG_ADMIN"] }),
  defineDomain({ name: "sales", reach: ["slack/T1/C_SALES"], memory: "sales-silo", admins: ["slack/T1/U_SALES_ADMIN"] }),
  defineDomain({ name: "governance", reach: ["slack/T1/C_GOV"], governance: true, admins: ["slack/T1/U_ORG_ADMIN"] }),
  defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["slack/T1/U_ORG_ADMIN"] }),
];
const configWith = (ds: readonly ReturnType<typeof defineDomain>[], silos: readonly ReturnType<typeof defineMemorySilo>[]) => ({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => ds,
  loadSilos: () => silos,
  domainsForSurface: () => [],
});
registerConfig(configWith(domains, [engSilo, salesSilo, orgSilo]) as never);

const armGovernanceFloor = (): void => {
  _resetGovernanceFloorCacheForTest();
  registerGovernanceMemberSupplier(async () => ({ humanMemberIds: ["U_ORG_ADMIN"], resolved: true, isPrivate: true, hasGuest: false }));
};
armGovernanceFloor();

await providerById("sqlite").ensureTier(controlPartition(org), siloTier("eng-silo"), engSilo);
await providerById("sqlite").writeTier(controlPartition(org), siloTier("eng-silo"), { "MEMORY.md": "# eng\n\n## Notes\n- a: hello eng\n" }, "seed", engSilo);
await providerById("sqlite").ensureTier(controlPartition(org), siloTier("sales-silo"), salesSilo);
await providerById("sqlite").writeTier(controlPartition(org), siloTier("sales-silo"), { "MEMORY.md": "# sales\n\n## Notes\n- a: hello sales\n" }, "seed", salesSilo);
await providerById("sqlite").ensureTier(controlPartition(org), siloTier("org-brain"), orgSilo);
await providerById("sqlite").writeTier(controlPartition(org), siloTier("org-brain"), { "MEMORY.md": "# org\n\n## Notes\n- a: hello org\n" }, "seed", orgSilo);

registerSlackFixtureMapper();

function ctxFor(opts: { channelId: string; channelType?: string; principalId?: string }): BindableContext {
  const attributes: Record<string, string> = { team_id: "T1", channel_id: opts.channelId, trust_checked: "true" };
  if (opts.channelType) attributes.channel_type = opts.channelType;
  return {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes, principalId: opts.principalId ?? "", principalType: "slack-user" } } },
  } as unknown as BindableContext;
}

const ctxOrgAdminFromEng = ctxFor({ channelId: "C_ENG", principalId: "U_ORG_ADMIN" });
const ctxOrgAdminFromDm = ctxFor({ channelId: "D1", channelType: "im", principalId: "U_ORG_ADMIN" });
const ctxOrgAdminFromGov = ctxFor({ channelId: "C_GOV", principalId: "U_ORG_ADMIN" });
const ctxEngAdminFromOwnChannel = ctxFor({ channelId: "C_ENG", principalId: "U_ENG_ADMIN" });
const ctxEngAdminFromSalesChannel = ctxFor({ channelId: "C_SALES", principalId: "U_ENG_ADMIN" });
const ctxEngAdminFromDm = ctxFor({ channelId: "D1", channelType: "im", principalId: "U_ENG_ADMIN" });
const ctxPlainMember = ctxFor({ channelId: "C_ENG", principalId: "U_RANDOM" });
const ctxNoSender = ctxFor({ channelId: "C_ENG" });

const list = (ctx: BindableContext, silo?: string) => execTool(memoryAdminListTool)({ silo }, ctx as never);
const read = (ctx: BindableContext, silo: string, relPath: string) => execTool(memoryAdminReadTool)({ silo, relPath }, ctx as never);

{
  ok(JSON.stringify(adminControlRoles("U_ORG_ADMIN", domains, "slack", "T1")) === JSON.stringify(["admin"]), "adminControlRoles: org admin -> [\"admin\"]");
  ok(JSON.stringify(adminControlRoles("U_ENG_ADMIN", domains, "slack", "T1")) === JSON.stringify(["domain:eng"]), "adminControlRoles: eng admin -> [\"domain:eng\"] regardless of channel");
  ok(JSON.stringify(adminControlRoles("U_RANDOM", domains, "slack", "T1")) === JSON.stringify([]), "adminControlRoles: a plain member has no roles");
  ok(JSON.stringify(adminControlRoles(undefined, domains, "slack", "T1")) === JSON.stringify([]), "adminControlRoles: FAIL-CLOSED, no principalId -> []");
  ok(JSON.stringify(adminControlRoles("U_ORG_ADMIN", domains, undefined, "T1")) === JSON.stringify([]), "adminControlRoles: FAIL-CLOSED, no platform to qualify the id with -> [] (never \"admin\")");
  ok(JSON.stringify(adminControlRoles("U_ORG_ADMIN", domains, "discord", "T1")) === JSON.stringify([]), "adminControlRoles: the SAME id on another platform holds no standing — the roster names slack/T1/U_ORG_ADMIN, not the bare id");
}

{
  armGovernanceFloor();
  const fromDm = await list(ctxOrgAdminFromDm);
  const fromGov = await list(ctxOrgAdminFromGov);
  ok(fromDm.tiers.length === 3, "org admin in their own DM: the ORG-WIDE map — all 3 silos");
  ok(fromDm.scope === "org-wide", "…reported as scope \"org-wide\"");
  ok(fromDm.note === undefined, "…with no narrowing note (there is nothing to warn about)");
  ok(fromGov.tiers.length === 3, "org admin in the ARMED governance channel: the ORG-WIDE map — all 3 silos");
  ok(fromGov.scope === "org-wide", "…reported as scope \"org-wide\"");
  ok(
    JSON.stringify(fromGov.tiers.map((t) => t.silo).sort()) === JSON.stringify(fromDm.tiers.map((t) => t.silo).sort()),
    "the governance channel and the DM answer identically — two venues for the SAME org-wide view",
  );
  const orgRow = fromDm.tiers.find((t) => t.silo === "org-brain")!;
  ok(orgRow.domains.length === 0, "org-brain reports no covering explicit domain (pseudo-domain-only) even though the org admin can still see it");

  const readEng = await read(ctxOrgAdminFromDm, "eng-silo", "MEMORY.md");
  ok(readEng.content.includes("hello eng"), "org admin reads eng-silo's content from a DM");
  const readOrgBrain = await read(ctxOrgAdminFromGov, "org-brain", "MEMORY.md");
  ok(readOrgBrain.content.includes("hello org"), "org admin can read the pseudo-domain-only org-brain in the governance channel");
}

{
  armGovernanceFloor();
  const narrowed = await list(ctxOrgAdminFromEng);
  ok(narrowed.scope === "domain-scoped", "org admin in an ORDINARY channel: scope is \"domain-scoped\", not org-wide");
  ok(narrowed.tiers.length === 1 && narrowed.tiers[0].silo === "eng-silo", "…and the listing carries only the room's own domain silo");
  const names = narrowed.tiers.map((t) => t.silo);
  ok(names.includes("sales-silo") === false, "🔴 NEGATIVE CONTROL: sales-silo — visible in the DM's org-wide map — is ABSENT from the #eng listing");
  ok(names.includes("org-brain") === false, "🔴 NEGATIVE CONTROL: org-brain — visible in the DM's org-wide map — is ABSENT from the #eng listing");
  ok(typeof narrowed.note === "string" && /eng/.test(narrowed.note!), "…and a note names the domain it was narrowed to, so a partial map never reads as the whole one");
  ok(/not the org-wide view/i.test(narrowed.note!), "…and says plainly that this is NOT the org-wide view");

  const inRoom = await read(ctxOrgAdminFromEng, "eng-silo", "MEMORY.md");
  ok(inRoom.content.includes("hello eng"), "org admin in #eng still reads #eng's own silo — the fence narrows, it does not refuse everything");
  await assert.rejects(
    async () => read(ctxOrgAdminFromEng, "sales-silo", "MEMORY.md"),
    (err: unknown) => {
      const m = String((err as Error).message);
      return /outside this room's own domain/i.test(m) && !/isn't listed|requires an org admin|forbidden/i.test(m);
    },
    "🔴 org admin in #eng is REFUSED sales-silo's content, and the refusal blames the ROOM rather than their standing",
  );
  n++;
  await assert.rejects(
    async () => read(ctxEngAdminFromDm, "sales-silo", "MEMORY.md"),
    (err: unknown) => /forbidden/i.test(String((err as Error).message)) && !/outside this room's own domain/i.test(String((err as Error).message)),
    "🔴 NEGATIVE CONTROL: a caller who really lacks the role gets the ordinary scope denial, never the venue copy",
  );
  n++;
}

{
  armGovernanceFloor();
  await assert.rejects(
    async () => list(ctxEngAdminFromSalesChannel),
    (err: unknown) => err instanceof PaneRedirectError && err.target === "governance-channel" && err.channel === "slack/T1/C_GOV",
    "eng admin asking in the SALES channel is redirected to the configured governance channel — they do not administer this room",
  );
  n++;
  await assert.rejects(
    async () => list(ctxEngAdminFromSalesChannel),
    /partial disclosure is still disclosure/i,
    "…and the directive forbids rendering any of the substance in place",
  );
  n++;
  const rows = await readAudit({ org, action: "governance.redirected" });
  ok(rows.some((r) => (r.detail as { kind?: string })?.kind === "memory.admin_list" && (r.detail as { to?: string })?.to === "governance-channel"), "the redirect stamps a governance.redirected row naming the fenced verb");
  const narrowedRows = await readAudit({ org, action: "governance.narrowed" });
  ok(narrowedRows.some((r) => (r.detail as { domain?: string })?.domain === "eng" && (r.detail as { kind?: string })?.kind === "memory.admin_list"), "a NARROWED answer stamps its OWN governance.narrowed row — the case where content did render");
  ok(narrowedRows.every((r) => (r.detail as { roles?: string[] })?.roles?.includes("admin") !== true), "…carrying the NARROWED roles, never the caller's wider \"admin\"");
  ok(rows.every((r) => (r.detail as { to?: string })?.to !== "domain-scoped"), "…and no narrowing is filed as a redirect");
}

{
  armGovernanceFloor();
  const fromOwn = await list(ctxEngAdminFromOwnChannel);
  const fromDm = await list(ctxEngAdminFromDm);
  ok(fromOwn.tiers.length === 1 && fromOwn.tiers[0].silo === "eng-silo", "eng admin in their own channel: eng-silo (both fences agree)");
  ok(fromDm.tiers.length === 1 && fromDm.tiers[0].silo === "eng-silo", "🔴 eng admin in a DM — an ORG-WIDE venue — still sees ONLY eng-silo: the venue fence never widens a role");
  ok(fromDm.scope === "org-wide", "…the venue IS org-wide; it is the ROLE that holds the answer to one silo");

  const readOwn = await read(ctxEngAdminFromDm, "eng-silo", "MEMORY.md");
  ok(readOwn.content.includes("hello eng"), "eng admin reads their own silo from a DM");

  await assert.rejects(async () => read(ctxEngAdminFromDm, "sales-silo", "MEMORY.md"), /forbidden/i, "eng admin: denied reading sales-silo (not their domain) even in an org-wide venue");
  n++;
  await assert.rejects(async () => read(ctxEngAdminFromDm, "org-brain", "MEMORY.md"), /forbidden/i, "eng admin: denied the pseudo-domain-only org-brain");
  n++;
}

{
  _resetGovernanceFloorCacheForTest();
  registerGovernanceMemberSupplier(async () => ({ humanMemberIds: ["U_ORG_ADMIN", "U_STRANGER"], resolved: true, isPrivate: true, hasGuest: false }));
  const breached = await list(ctxOrgAdminFromGov);
  ok(breached.scope === "domain-scoped", "🔴 a governance channel with a stranger in it stops being an org-wide venue — the demote is fail-closed");
  ok(breached.tiers.length === 0, "…and the breached room hears nothing: the governance domain holds no silo of its own");

  armGovernanceFloor();
  const rearmed = await list(ctxOrgAdminFromGov);
  ok(rearmed.scope === "org-wide" && rearmed.tiers.length === 3, "…and re-arms automatically once the stranger is gone — the assertion above was the breach, not a permanent state");
}

{
  const armed = { armed: true, floor: "admin" } as const;
  const orgRoles = ["admin"];

  ok(classifyAdminReadVenue({ roles: orgRoles, isRequesterDm: false, isGovernanceChannel: true, attestation: armed }).placement === "org-wide", "armed governance channel → org-wide");
  ok(classifyAdminReadVenue({ roles: orgRoles, isRequesterDm: true, isGovernanceChannel: false }).placement === "org-wide", "the asker's own DM → org-wide");

  const narrowed = classifyAdminReadVenue({ roles: orgRoles, isRequesterDm: false, isGovernanceChannel: false, roomDomain: "eng" });
  ok(narrowed.placement === "domain-scoped" && narrowed.domain === "eng", "an ordinary room with a domain → domain-scoped to THAT domain");
  ok(narrowed.placement === "domain-scoped" && JSON.stringify(narrowed.roles) === JSON.stringify(["domain:eng"]), "🔴 the org role is REPLACED by the room's single domain role — never carried through");

  const strangerRoom = classifyAdminReadVenue({ roles: ["domain:eng"], isRequesterDm: false, isGovernanceChannel: false, roomDomain: "sales", governanceChannel: "slack/T1/C_GOV" });
  ok(strangerRoom.placement === "redirect" && strangerRoom.target === "governance-channel", "a room the asker does not administer → redirect to the governance channel");

  const noGov = classifyAdminReadVenue({ roles: ["domain:eng"], isRequesterDm: false, isGovernanceChannel: false, roomDomain: "sales" });
  ok(noGov.placement === "redirect" && noGov.target === "requester-dm", "…and with no governance channel configured the redirect points at the DM");

  const noDomain = classifyAdminReadVenue({ roles: orgRoles, isRequesterDm: false, isGovernanceChannel: false });
  ok(noDomain.placement === "redirect", "an unassigned room has no domain to narrow to → redirect, never a silent org-wide answer");

  const breachedGov = classifyAdminReadVenue({
    roles: orgRoles,
    isRequesterDm: false,
    isGovernanceChannel: true,
    attestation: { armed: false, floor: "member", breach: { reason: "non-admin-member", missing: ["U_X"], members: ["U_ORG_ADMIN", "U_X"] } },
    roomDomain: "governance",
  });
  ok(breachedGov.placement === "domain-scoped", "a BREACHED governance channel is classified as an ordinary room");

  const cases: readonly { readonly label: string; readonly input: Parameters<typeof classifyAdminReadVenue>[0]; readonly want: readonly string[] }[] = [
    { label: "an org admin in a DM keeps their org role", input: { roles: orgRoles, isRequesterDm: true, isGovernanceChannel: false }, want: ["admin"] },
    { label: "an org admin in #eng holds ONLY domain:eng", input: { roles: orgRoles, isRequesterDm: false, isGovernanceChannel: false, roomDomain: "eng" }, want: ["domain:eng"] },
    {
      label: "a TWO-domain admin in #sales holds ONLY domain:sales — the other domain is dropped",
      input: { roles: ["domain:eng", "domain:sales"], isRequesterDm: false, isGovernanceChannel: false, roomDomain: "sales" },
      want: ["domain:sales"],
    },
    {
      label: "a two-domain admin in a DM keeps BOTH — the venue is wide, so the role decides",
      input: { roles: ["domain:eng", "domain:sales"], isRequesterDm: true, isGovernanceChannel: false },
      want: ["domain:eng", "domain:sales"],
    },
  ];
  for (const c of cases) {
    const d = classifyAdminReadVenue(c.input);
    ok(d.placement !== "redirect" && JSON.stringify(d.roles) === JSON.stringify(c.want), `${c.label} (got ${JSON.stringify(d.placement === "redirect" ? "redirect" : d.roles)})`);
  }
}

{
  await assert.rejects(async () => list(ctxPlainMember), /org admin|domain admin/i, "memory_admin_list: a plain member is REFUSED (not silently empty)");
  n++;
  await assert.rejects(async () => read(ctxPlainMember, "eng-silo", "MEMORY.md"), /org admin|domain admin/i, "memory_admin_read: a plain member is refused");
  n++;
  await assert.rejects(async () => list(ctxNoSender), /verified sender/i, "memory_admin_list: no verified sender is refused with a distinct message");
  n++;
  await assert.rejects(async () => read(ctxNoSender, "eng-silo", "MEMORY.md"), /verified sender/i, "memory_admin_read: no verified sender is refused");
  n++;
}

{
  const narrowed = await list(ctxOrgAdminFromEng, "eng-silo");
  ok(narrowed.tiers.length === 1 && narrowed.tiers[0].silo === "eng-silo", "memory_admin_list: silo filter narrows to one tier");
  await assert.rejects(async () => list(ctxEngAdminFromOwnChannel, "sales-silo"), /no memory silo named/i, "memory_admin_list: filtering to an uncovered silo errors (not an empty result)");
  n++;
}

{
  const everything = await list(ctxOrgAdminFromDm);
  ok(everything.tiers.every((t) => ["eng-silo", "sales-silo", "org-brain"].includes(t.silo)), "no personal/workspace-tier silo ever appears — only configured named silos");
}

{
  const bigSilo = defineMemorySilo({ name: "big-silo", provider: "sqlite" });
  const domainsWithBig = [...domains, defineDomain({ name: "big", reach: ["slack/T1/C_BIG"], memory: "big-silo", admins: ["slack/T1/U_BIG_ADMIN"] })];
  registerConfig(configWith(domainsWithBig, [engSilo, salesSilo, orgSilo, bigSilo]) as never);
  await providerById("sqlite").ensureTier(controlPartition(org), siloTier("big-silo"), bigSilo);
  await providerById("sqlite").writeTier(controlPartition(org), siloTier("big-silo"), { "MEMORY.md": "x".repeat(64 * 1024 + 1) }, "seed", bigSilo);

  await assert.rejects(async () => read(ctxOrgAdminFromDm, "big-silo", "MEMORY.md"), /64KB|control-plane memory_read/i, "memory_admin_read: an oversized file is refused, pointing at the out-of-band tool");
  n++;
}

{
  const before = (await readAudit({ org, action: "memory.admin_read" })).length;
  await list(ctxOrgAdminFromDm);
  const afterList = (await readAudit({ org, action: "memory.admin_read" })).length;
  ok(afterList === before, "memory_admin_list does not append an audit row (mirrors the control plane's own un-audited memory_list)");

  await read(ctxOrgAdminFromDm, "eng-silo", "MEMORY.md");
  const rows = await readAudit({ org, action: "memory.admin_read" });
  ok(rows.length === before + 1, "memory_admin_read appends exactly one audit row per read");
  const last = rows[0];
  ok(last.principalId === "U_ORG_ADMIN", "audit row carries the acting principal");
  ok(last.detail?.silo === "eng-silo" && last.detail?.relPath === "MEMORY.md", "audit row carries silo + relPath");
  ok(Array.isArray(last.detail?.roles) && (last.detail!.roles as string[]).includes("admin"), "audit row carries the roles that authorised the read");
  ok(last.detail?.venue === "org-wide", "…and the VENUE it ran at, so an auditor can tell an org-wide read from a narrowed one");

  await read(ctxOrgAdminFromEng, "eng-silo", "MEMORY.md");
  const narrowedRow = (await readAudit({ org, action: "memory.admin_read" }))[0];
  ok(JSON.stringify(narrowedRow.detail?.roles) === JSON.stringify(["domain:eng"]), "a NARROWED read audits the effective role (\"domain:eng\"), never the caller's wider \"admin\"");
  ok(narrowedRow.detail?.venue === "domain-scoped", "…and names the narrowed venue");
}

{
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { buildControlServer, CONTROL_TOOL_NAMES } = await import("../agent/control/server.js");

  ok(CONTROL_TOOL_NAMES.includes("memory_list") && CONTROL_TOOL_NAMES.includes("memory_read"), "control plane still declares memory_list/memory_read");

  const server = buildControlServer({ roles: ["admin"] });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "control-unaffected-check", version: "0" });
  await client.connect(c);
  const res = await client.callTool({ name: "memory_list", arguments: { org } });
  const body = JSON.parse((res.content as { type: string; text: string }[])[0].text);
  ok(body.tiers.length === 4, "control-plane memory_list (admin) unaffected — still enumerates every configured silo (incl. the 4th 'big' fixture)");
  await client.close();
}

_resetGovernanceMemberSupplierForTest();
_resetGovernanceFloorCacheForTest();
await removeTempDir(dir);
console.log(`\n✓ memory-admin (in-Slack bridge): ${n} assertions passed\n`);

import assert from "node:assert/strict";
import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-memory-admin-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_MEMORY_PROVIDER;
process.env.OE_ORG = "acme";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { defineMemorySilo } from "../agent/memory/silo.js";
import { providerById } from "../agent/memory/provider.js";
import { siloTier } from "../agent/memory/store.js";
import { controlPartition } from "../agent/memory/partition.js";
import { readAudit } from "../agent/audit/audit.js";
import { adminControlRoles } from "../agent/access/roles.js";
import type { BindableContext } from "../agent/identity/binding.js";
import memoryAdminListTool from "../agent/tools/memory_admin_list.js";
import memoryAdminReadTool from "../agent/tools/memory_admin_read.js";
import { execTool } from "./_tool-exec.js";

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
  defineDomain({ name: "eng", channels: ["slack/T1/C_ENG"], memory: "eng-silo", admins: ["slack/T1/U_ENG_ADMIN"] }),
  defineDomain({ name: "sales", channels: ["slack/T1/C_SALES"], memory: "sales-silo", admins: ["slack/T1/U_SALES_ADMIN"] }),
  defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["slack/T1/U_ORG_ADMIN"] }),
];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [engSilo, salesSilo, orgSilo],
  domainsForSurface: () => [],
});

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
  const fromEng = await list(ctxOrgAdminFromEng);
  const fromDm = await list(ctxOrgAdminFromDm);
  ok(fromEng.tiers.length === 3, "org admin (from a channel): sees all 3 silos");
  ok(JSON.stringify(fromEng.tiers.map((t) => t.silo).sort()) === JSON.stringify(fromDm.tiers.map((t) => t.silo).sort()), "org admin: identical result from a channel vs a DM — the gate is the caller, not the channel");
  const orgRow = fromEng.tiers.find((t) => t.silo === "org-brain")!;
  ok(orgRow.domains.length === 0, "org-brain reports no covering explicit domain (pseudo-domain-only) even though the org admin can still see it");

  const readEng = await read(ctxOrgAdminFromDm, "eng-silo", "MEMORY.md");
  ok(readEng.content.includes("hello eng"), "org admin reads eng-silo's content, even calling from a DM");
  const readOrgBrain = await read(ctxOrgAdminFromEng, "org-brain", "MEMORY.md");
  ok(readOrgBrain.content.includes("hello org"), "org admin can read the pseudo-domain-only org-brain");
}

{
  const fromOwn = await list(ctxEngAdminFromOwnChannel);
  const fromOther = await list(ctxEngAdminFromSalesChannel);
  const fromDm = await list(ctxEngAdminFromDm);
  for (const [label, res] of [["own channel", fromOwn], ["another domain's channel", fromOther], ["a DM", fromDm]] as const) {
    ok(res.tiers.length === 1 && res.tiers[0].silo === "eng-silo", `eng admin calling from ${label}: sees ONLY eng-silo`);
  }

  const readOwn = await read(ctxEngAdminFromSalesChannel, "eng-silo", "MEMORY.md");
  ok(readOwn.content.includes("hello eng"), "eng admin reads their own silo even while sitting in the sales channel");

  await assert.rejects(async () => read(ctxEngAdminFromOwnChannel, "sales-silo", "MEMORY.md"), /forbidden/i, "eng admin: denied reading sales-silo (not their domain) even from their own channel");
  n++;
  await assert.rejects(async () => read(ctxEngAdminFromOwnChannel, "org-brain", "MEMORY.md"), /forbidden/i, "eng admin: denied the pseudo-domain-only org-brain");
  n++;
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
  const everything = await list(ctxOrgAdminFromEng);
  ok(everything.tiers.every((t) => ["eng-silo", "sales-silo", "org-brain"].includes(t.silo)), "no personal/workspace-tier silo ever appears — only configured named silos");
}

{
  const bigSilo = defineMemorySilo({ name: "big-silo", provider: "sqlite" });
  const domainsWithBig = [...domains, defineDomain({ name: "big", channels: ["slack/T1/C_BIG"], memory: "big-silo", admins: ["slack/T1/U_BIG_ADMIN"] })];
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domainsWithBig,
    loadSilos: () => [engSilo, salesSilo, orgSilo, bigSilo],
    domainsForSurface: () => [],
  });
  await providerById("sqlite").ensureTier(controlPartition(org), siloTier("big-silo"), bigSilo);
  await providerById("sqlite").writeTier(controlPartition(org), siloTier("big-silo"), { "MEMORY.md": "x".repeat(64 * 1024 + 1) }, "seed", bigSilo);

  await assert.rejects(async () => read(ctxOrgAdminFromEng, "big-silo", "MEMORY.md"), /64KB|control-plane memory_read/i, "memory_admin_read: an oversized file is refused, pointing at the out-of-band tool");
  n++;
}

{
  const before = (await readAudit({ org, action: "memory.admin_read" })).length;
  await list(ctxOrgAdminFromEng);
  const afterList = (await readAudit({ org, action: "memory.admin_read" })).length;
  ok(afterList === before, "memory_admin_list does not append an audit row (mirrors the control plane's own un-audited memory_list)");

  await read(ctxOrgAdminFromEng, "eng-silo", "MEMORY.md");
  const rows = await readAudit({ org, action: "memory.admin_read" });
  ok(rows.length === before + 1, "memory_admin_read appends exactly one audit row per read");
  const last = rows[0];
  ok(last.principalId === "U_ORG_ADMIN", "audit row carries the acting principal");
  ok(last.detail?.silo === "eng-silo" && last.detail?.relPath === "MEMORY.md", "audit row carries silo + relPath");
  ok(Array.isArray(last.detail?.roles) && (last.detail!.roles as string[]).includes("admin"), "audit row carries the roles that authorised the read");
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

rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ memory-admin (in-Slack bridge): ${n} assertions passed\n`);

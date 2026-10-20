process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "postgres";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { registerOperationalStore, resetOperationalStore } from "../agent/operational/provider.js";
import { DIRECTORY_MODE_SETTING, DIRECTORY_SYNC_ACTION, directoryLinkSetId, directoryMode, runDirectorySync, syncDirectoryOrg } from "../agent/identity/directory-sync.js";
import { maskEmails, platformIdShapeProblem, previewDirectoryOrg } from "../agent/identity/directory-preview.js";
import { registerDirectoryProvider, resetDirectoryProvider, type DirectoryInspection, type DirectoryPerson, type DirectoryProvider } from "../agent/identity/directory.js";
import { deliverGroupsOverlay } from "../agent/identity/groups-delivery.js";
import { planDirectoryGroups } from "../agent/identity/group-sync.js";
import { defineSettings, overrideSettingsForTest, registerSettings, resetSettingsForTest } from "../agent/settings/settings.js";
import { listLinkSetsWithIds } from "../agent/identity/link-store.js";
import { readAudit } from "../agent/audit/audit.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { registerSlackFixtureMapper, registerSlackTestBridge } from "./_slack-test-stubs.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const ORG = "default";
_setDeploymentIdentityForTest({ org: ORG });
registerSlackFixtureMapper();
let outbound = 0;
registerSlackTestBridge({
  form: async () => {
    outbound++;
    return { ok: true, ts: `fixture-${outbound}` };
  },
});
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadSilos: () => [],
  domainsForSurface: () => [],
  loadDomains: () => [defineDomain({ name: "eng", reach: ["slack/T1/C_ENG"] })],
});
resetSettingsForTest();
registerSettings({ connectors: { linkSetVault: false } });

const db = new PGlite();
const client: PgClient = { query: (text, params) => db.query(text, params ? [...params] : undefined) };
await initOperationalSchema(client);
registerOperationalStore(makeOperationalPostgresStore(client));
resetOperationalStore();

async function storeDigest(except: readonly string[] = []): Promise<string> {
  const tables = (await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' order by table_name")).rows
    .map((r) => r.table_name)
    .filter((t) => !except.includes(t));
  const h = createHash("sha256");
  for (const t of tables) {
    const rows = (await db.query<Record<string, unknown>>(`select * from "${t}"`)).rows.map((r) => JSON.stringify(r)).sort();
    h.update(`${t}\u0000${rows.length}\u0000${rows.join("\u0001")}\u0002`);
  }
  return `${tables.length}:${h.digest("hex")}`;
}

const ada = (deprovisioned: boolean): DirectoryPerson => ({
  externalId: "00u-ada",
  displayName: "Ada L.",
  email: "ada@acme.example",
  accounts: [{ platform: "slack", nativeId: "UADA0001", grade: "attested" }],
  groups: ["Engineering"],
  deprovisioned,
});
const rowan: DirectoryPerson = {
  externalId: "00u-rowan",
  displayName: "Rowan Hale",
  email: "rowan@acme.example",
  accounts: [
    { platform: "slack", nativeId: "UROWAN01", grade: "attested" },
    { platform: "github", nativeId: "583231", grade: "attested" },
    { platform: "notion", nativeId: "not-a-uuid", grade: "asserted" },
    { platform: "linear", nativeId: "rowan@acme.example", grade: "asserted" },
    { platform: "slack", tenant: "T_UNKNOWN", nativeId: "UROWAN02", grade: "attested" },
  ],
  groups: ["Engineering", "Payments"],
  deprovisioned: false,
};
const carl: DirectoryPerson = { externalId: "00u-carl", displayName: "carl@acme.example", accounts: [{ platform: "github", nativeId: "carl@acme.example", grade: "asserted" }], groups: [], deprovisioned: false };
let people: DirectoryPerson[] = [ada(false)];
let reads = 0;
const inspectionExtras: Omit<DirectoryInspection, "people"> = {
  sources: [{ platform: "slack", source: "0oaSLACK", field: "externalId", grade: "attested", assignments: 3, mapped: 2, skipped: [{ reason: "the assignment has no externalId (the app never wrote an id back over SCIM)", count: 1, examples: ["00u-carl"] }] }],
  groups: { total: 40, read: ["Engineering", "Payments"], skipped: 38, allowlist: ["Engineering", "Payments", "Paymnets"], allowlistMissing: ["Paymnets"] },
  requests: 7,
};
const provider: DirectoryProvider = {
  id: "okta",
  name: "fake okta",
  listPeople: async () => {
    reads++;
    return people;
  },
  inspect: async () => {
    reads++;
    return { people, ...inspectionExtras };
  },
};
registerDirectoryProvider(provider);

{
  ok(directoryMode() === "sync", "mode: shipped ⇒ sync — an existing armed deployment keeps applying its plan");
  let threw = "";
  try {
    defineSettings({ directory: { mode: "dry-run" as never } });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  ok(threw.includes(DIRECTORY_MODE_SETTING) && threw.includes("observe"), "mode: a typo fails settings load and names the valid values");
}

{
  const before = await storeDigest();
  const res = await syncDirectoryOrg({ org: ORG, autoConfirm: "off" });
  ok(res !== null && res.applied.suggested === 1 && res.applied.setsCreated === 1, "control: a sync-mode run writes Ada's suggestion and her new link-set");
  ok((await storeDigest()) !== before, "control: …and the store digest changes, so the digest can see a write");
}

people = [ada(true), rowan, carl];
overrideSettingsForTest({ directory: { mode: "observe" } });

{
  const before = await storeDigest();
  const auditBefore = (await readAudit({ org: ORG, limit: 10_000 })).length;
  const p = (await previewDirectoryOrg({ org: ORG }))!;
  ok((await storeDigest()) === before, "🔴 preview: the store digest is unchanged — the preview wrote nothing to any table");
  ok((await readAudit({ org: ORG, limit: 10_000 })).length === auditBefore, "🔴 preview: no audit row either");
  ok(outbound === 0, "🔴 preview: no outbound post reached anyone");
  ok(p.wrote === "none" && p.mode === "observe", "preview: says it wrote nothing, and names the mode");
  ok(p.people.total === 3 && p.people.deprovisioned === 1 && p.people.withAccounts === 3, "preview: people counts");
  const adaSet = directoryLinkSetId("okta", "00u-ada");
  ok(p.wouldDo.counts.suspend === 1 && p.wouldDo.suspensions[0]?.linkSetId === adaSet, "🔴 preview: the suspension a real sync would make is listed, by link-set");
  ok(p.report.some((l) => l.includes("SUSPEND") && l.includes(adaSet)), "preview: …and the readable report names it");
  ok(p.wouldDo.newLinkSets === 2 && p.wouldDo.counts.suggest >= 2, "preview: Rowan's and Carl's accounts would land in two NEW link-sets");
  const reasons = p.problems.items.map((x) => `${x.platform}:${x.nativeId}:${x.reason}`);
  ok(reasons.some((r) => r.startsWith("github:583231:") && r.includes("login")), "preview: a numeric GitHub id is flagged — it can never match a login");
  ok(reasons.some((r) => r.startsWith("notion:not-a-uuid:")), "preview: a Notion id that is not a UUID is flagged");
  ok(reasons.some((r) => r.startsWith("slack:UROWAN02:") && r.includes("workspace")), "preview: an account in an unadmitted workspace is reported as placed nowhere");
  ok(p.sources?.[0]?.field === "externalId" && p.sources[0].grade === "attested" && p.sources[0].skipped[0]?.count === 1, "preview: each source carries its field, grade and skip reasons");
  ok(p.groups?.allowlistMissing.includes("Paymnets") === true && p.report.some((l) => l.includes('"Paymnets"')), "preview: an allowlisted name the directory lacks is called out");
  ok(p.groups?.overlay !== undefined && p.groups.overlay.counts["addGroup"]! >= 1, "preview: the group overlay a real directory_groups_plan would propose is counted");
  ok(p.requests === 7 && p.report.some((l) => l.includes("7 HTTP request")), "preview: the read's cost is reported");
  ok(!/[A-Za-z0-9]@acme\.example/u.test(JSON.stringify(p)), "🔴 preview: no email address leaves — not as an account id, a display name, warning text or a report line");
  ok(JSON.stringify(p).includes("…@acme.example"), "preview: …a masked one keeps its domain, so the operator still sees which org it is");
  ok(reasons.some((r) => r.startsWith("linear:…@acme.example:") && r.includes("email")), "preview: an email-shaped account id is flagged, and shown masked");
  ok(p.groups?.overlay !== undefined && !("lines" in p.groups.overlay), "preview: the group overlay is counts only — no link-set → group member list");
  ok(maskEmails({ a: ["x a@b.co y"], n: 1 }).a[0] === "x …@b.co y", "mask: a nested string is masked, a number is untouched");
  ok(maskEmails<string>("jörg@müller.de") === "…@müller.de" && maskEmails<string>("a@sub_domain.acme.com") === "…@sub_domain.acme.com", "mask: an IDN domain and an underscore domain are masked too");
  ok(p.persons.items[0]?.externalId === "00u-ada", "preview: the person a sync would suspend is listed first");
  const limited = (await previewDirectoryOrg({ org: ORG, limit: 1 }))!;
  ok(limited.persons.shown === 1 && limited.persons.total === 3 && limited.people.total === 3, "preview: `limit` caps the person rows, never the counts");
}

{
  const beforeAllButAudit = await storeDigest(["audit_entry"]);
  const auditBefore = (await readAudit({ org: ORG, limit: 10_000 })).length;
  let msg = "";
  try {
    await syncDirectoryOrg({ org: ORG });
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  ok(msg.includes(DIRECTORY_MODE_SETTING) && msg.includes("directory_sync_preview"), "🔴 observe: syncDirectoryOrg refuses, and names the preview");
  const readsBefore = reads;
  const heartbeatBefore = (await readAudit({ org: ORG, action: DIRECTORY_SYNC_ACTION })).length;
  const out = await runDirectorySync({ orgs: [ORG] });
  ok(out.length === 0 && reads === readsBefore, "🔴 observe: the nightly entry point makes NO directory read");
  const beats = await readAudit({ org: ORG, action: DIRECTORY_SYNC_ACTION });
  ok(beats.length === heartbeatBefore + 1 && beats[0]!.detail?.["outcome"] === "no-op: observe mode", "observe: …and leaves exactly one heartbeat row, so the census still sees the cron alive");
  const sets = await listLinkSetsWithIds(ORG);
  ok(sets.every((s) => s.set.status === "active"), "🔴 observe: Ada's link-set is NOT suspended");
  let delivered = 0;
  let dmsg = "";
  try {
    await deliverGroupsOverlay(planDirectoryGroups({ provider: "okta", people, current: { groups: [] } }), {
      config: { configRepo: "acme/config" } as never,
      createPr: (async () => {
        delivered++;
        throw new Error("unreachable");
      }) as never,
    });
  } catch (e) {
    dmsg = e instanceof Error ? e.message : String(e);
  }
  ok(delivered === 0 && dmsg.includes(DIRECTORY_MODE_SETTING), "🔴 observe: the group bot-PR courier refuses before any SCM call");
  ok(outbound === 0, "🔴 observe: no outbound post reached anyone");
  ok((await storeDigest(["audit_entry"])) === beforeAllButAudit, "🔴 observe: every table except the audit log is unchanged");
  ok((await readAudit({ org: ORG, limit: 10_000 })).length === auditBefore + 1, "🔴 observe: …and the audit log gained the one heartbeat row and nothing else");
}

{
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { buildControlServer } = await import("../agent/control/server.js");
  const server = buildControlServer({ includeWrites: true, actor: "admin@example.com" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const mcp = new Client({ name: "directory-preview-test", version: "0" });
  await mcp.connect(clientT);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await mcp.callTool({ name, arguments: args });
    return { isError: res.isError === true, text: (res.content as { text: string }[])[0]!.text };
  };

  const before = await storeDigest();
  const preview = await call("directory_sync_preview", { org: ORG, limit: 5 });
  ok(!preview.isError && JSON.parse(preview.text).wrote === "none", "control: directory_sync_preview answers");
  ok((await storeDigest()) === before, "🔴 control: directory_sync_preview leaves the store digest unchanged — not even an audit row");
  const now = await call("directory_sync_now", { org: ORG });
  ok(now.isError && now.text.includes(DIRECTORY_MODE_SETTING), "🔴 control: directory_sync_now refuses in observe mode");
  const deliver = await call("directory_groups_plan", { org: ORG, deliver: true });
  ok(deliver.isError && deliver.text.includes(DIRECTORY_MODE_SETTING), "🔴 control: directory_groups_plan deliver:true refuses in observe mode");
  ok((await storeDigest()) === before, "🔴 control: the two refusals wrote nothing either");
  const auditBeforePlan = (await readAudit({ org: ORG, limit: 10_000 })).length;
  const restBeforePlan = await storeDigest(["audit_entry"]);
  const plan = await call("directory_groups_plan", { org: ORG });
  ok(!plan.isError && JSON.parse(plan.text).delivered === undefined, "control: plan-only directory_groups_plan still answers in observe mode, and delivers nothing");
  ok((await storeDigest(["audit_entry"])) === restBeforePlan, "🔴 observe: plan-only directory_groups_plan changes no table but the audit log");
  const afterPlan = await readAudit({ org: ORG, limit: 10_000 });
  ok(afterPlan.length === auditBeforePlan + 1 && afterPlan[0]!.action === "admin.identity.directory_groups_plan", "observe: plan-only directory_groups_plan appends exactly its one provenance audit row");
  ok(outbound === 0 && (await listLinkSetsWithIds(ORG)).every((s) => s.set.status === "active"), "🔴 control: nobody reached, nobody suspended");

  overrideSettingsForTest({ directory: { mode: "sync" } });
  const applied = await call("directory_sync_now", { org: ORG });
  ok(!applied.isError && JSON.parse(applied.text).applied.suspended === 1, "control: in sync mode the same verb suspends Ada — the refusal above was the mode, not the fixture");
  ok((await storeDigest()) !== before, "control: …and the digest moves");
}

{
  ok(platformIdShapeProblem("slack", "U0123ABC") === undefined && platformIdShapeProblem("slack", "W0123ABC") === undefined, "shape: Slack member ids pass");
  ok(platformIdShapeProblem("slack", "rowan@acme.example") !== undefined, "shape: an email is never a platform id");
  ok(platformIdShapeProblem("github", "octo-cat") === undefined && platformIdShapeProblem("github", "jdoe_acme") === undefined, "shape: a login and an EMU login pass");
  ok(platformIdShapeProblem("github", "12345") !== undefined, "shape: a numeric GitHub id is flagged");
  ok(platformIdShapeProblem("notion", "0a1b2c3d-4e5f-6789-abcd-ef0123456789") === undefined, "shape: a Notion UUID passes");
  ok(platformIdShapeProblem("linear", "anything") === undefined, "shape: a platform with no known shape is not flagged");
}

resetDirectoryProvider();
resetSettingsForTest();
console.log(`✓ directory-preview-test: ${n} assertions passed`);

process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { registerConfig } from "../agent/access/config.js";
import { defineBundle, defineBinding } from "../agent/access/bundle.js";
import { defineDomain } from "../agent/memory/domain.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import type { DomainSkillRow } from "../agent/operational/store.js";
import {
  MAX_DOMAIN_SKILL_BYTES,
  domainSkillCap,
  domainSkillRefusalMessage,
  resolveDomainSkillRows,
  resolveSkillDomainDetailed,
  resolveSkillDomain,
  skillDomainFor,
  skillPackageFromRow,
  withDescription,
} from "../agent/skills/domain-skills.js";
import { resolveSkillEntries } from "../agent/skills/scoped.js";
import type { BindableContext } from "../agent/identity/binding.js";
import type { SurfaceBinding } from "../agent/identity/binding.js";
import type { Partition } from "../agent/memory/partition.js";
import createSkillGated from "../agent/tools/create_skill.js";
import listSkillsTool from "../agent/tools/list_skills.js";
import deleteSkillGated from "../agent/tools/delete_skill.js";
import { resolveWindowGated } from "../agent/access/window-gated.js";

import { registerSlackFixtureMapper, registerSlackTestBridge } from "./_slack-test-stubs.js";
import { execTool } from "./_tool-exec.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
registerSlackFixtureMapper();
registerSlackTestBridge();

const FULL_GRAIN_TEST_CTX = { channel: { kind: "slack" }, session: { auth: { current: { attributes: { oe_grain: "task" } } } } };
type ExecTool = { execute(input: unknown, ctx: unknown): Promise<any> };
const createSkillTool = (await resolveWindowGated(createSkillGated, FULL_GRAIN_TEST_CTX as never)) as ExecTool;
const deleteSkillTool = (await resolveWindowGated(deleteSkillGated, FULL_GRAIN_TEST_CTX as never)) as ExecTool;

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

registerConfig({
  loadBundles: () => [defineBundle({ name: "org-tools", plugins: ["acme-plugin"] })],
  loadBindings: () => [defineBinding({ bundle: "org-tools", scope: { level: "org" } })],
  pluginRegistry: { "acme-plugin": { skills: ["granted-one"] } },
  skillContent: { "granted-one": { description: "A bundle-granted skill.", markdown: "# Granted\nDo the granted thing.", files: { "where.json": "shipped" } } },
  skillSessionFiles: { "granted-one": (where) => ({ "where.json": `${where.platform}/${where.surface}` }) },
  loadDomains: () => [
    defineDomain({ name: "eng", reach: ["slack/T1/C_ENG"] }),
    defineDomain({ name: "org", match: "org" }),
  ],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === "C_ENG" ? ["eng"] : []),
});

function ctxFor(opts: { channelId: string; channelType?: string; principalId?: string; internal?: boolean }): BindableContext {
  const attributes: Record<string, string> = { team_id: "T1", channel_id: opts.channelId, oe_grain: "task" };
  if (opts.channelType) attributes.channel_type = opts.channelType;
  if (opts.internal) attributes.trust_checked = "true";
  return {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes, principalId: opts.principalId ?? "U1", principalType: "slack-user" } } },
  } as BindableContext;
}

const ctxEng = ctxFor({ channelId: "C_ENG", internal: true });
const ctxUnassigned = ctxFor({ channelId: "C_RANDOM", internal: true });
const ctxDm = ctxFor({ channelId: "D1", channelType: "im" });
const ctxMpim = ctxFor({ channelId: "G1", channelType: "mpim" });
const ctxExternal = ctxFor({ channelId: "C_EXT" });

{
  const store = getOperationalStore();
  ok((await store.listDomainSkills("default", "eng")).length === 0, "store: empty domain starts with no skills");

  await store.putDomainSkill("default", "eng", "deploy-runbook", "# Deploy\nSteps.", "U1", "2026-07-04T10:00:00Z");
  let rows = await store.listDomainSkills("default", "eng");
  ok(rows.length === 1 && rows[0].name === "deploy-runbook" && rows[0].updatedBy === "U1", "store: create persists name/content/updatedBy");

  await store.putDomainSkill("default", "eng", "deploy-runbook", "# Deploy v2", "U2", "2026-07-04T11:00:00Z");
  rows = await store.listDomainSkills("default", "eng");
  ok(rows.length === 1 && rows[0].content === "# Deploy v2" && rows[0].updatedBy === "U2", "store: put on an existing name upserts in place");

  await store.putDomainSkill("default", "eng", "other-skill", "# Other", undefined, "2026-07-04T12:00:00Z");
  rows = await store.listDomainSkills("default", "eng");
  ok(rows.length === 2 && rows.find((r) => r.name === "other-skill")?.updatedBy === undefined, "store: updatedBy is optional (undefined round-trips as absent)");

  ok((await store.listDomainSkills("default", "watercooler")).length === 0, "store: another domain in the same org is isolated");
  ok((await store.listDomainSkills("acme", "eng")).length === 0, "store: another org is isolated even for the same domain name");
  await store.putDomainSkill("acme", "eng", "deploy-runbook", "# Acme's own", "U9", "2026-07-04T13:00:00Z");
  ok((await store.listDomainSkills("default", "eng")).length === 2, "store: another org's write doesn't leak into this org's list");
  ok((await store.listDomainSkills("acme", "eng"))[0].content === "# Acme's own", "store: each org keeps its own row for the same (domain, name)");

  ok((await store.deleteDomainSkill("default", "eng", "other-skill")) === true, "store: delete returns true when a row was removed");
  ok((await store.deleteDomainSkill("default", "eng", "other-skill")) === false, "store: delete is idempotent (false when absent)");
  ok((await store.listDomainSkills("default", "eng")).length === 1, "store: gone after delete");

  const revs = await store.listDomainSkillRevisions("default", "eng", "deploy-runbook");
  ok(
    revs.some((r) => r.content === "# Deploy\nSteps."),
    `revisions: THE OLD BODY SURVIVES the destructive upsert that replaced it (readable bodies: ${JSON.stringify(revs.map((r) => r.content))})`,
  );
  ok(revs.length === 2, `revisions: one row per write, the first included (got ${revs.length})`);
  ok(revs[1].content === "# Deploy v2", "revisions: the replacing body is recorded too");
  ok(revs[0].seq < revs[1].seq, "revisions: ordered oldest-first by seq (the only total order)");
  ok(revs[0].authoredBy === "U1" && revs[1].authoredBy === "U2", "revisions: each row carries ITS OWN author, not the latest one");
  ok(revs[0].recordedAt === "2026-07-04T10:00:00Z", "revisions: each row carries the timestamp of its own write");
  ok(revs[0].armedBy === undefined && revs[0].approvalId === undefined, "revisions: a write outside the card path records without approval provenance (never refuses)");

  ok((await store.listDomainSkillRevisions("default", "eng")).length === 3, "revisions: omitting `name` sweeps the whole domain (2 deploy-runbook + 1 other-skill)");
  ok((await store.listDomainSkillRevisions("acme", "eng")).length === 1, "revisions: another org's revisions never leak into this org's log");
  ok((await store.listDomainSkillRevisions("default", "watercooler")).length === 0, "revisions: another domain in the same org is isolated");

  const afterDelete = await store.listDomainSkillRevisions("default", "eng", "other-skill");
  ok(afterDelete.length === 1 && afterDelete[0].content === "# Other", "revisions: deleting the skill does NOT remove what was armed (an append-only log doesn't un-record)");
}

{
  const b = (mode: SurfaceBinding["mode"], trust: SurfaceBinding["trust"]): SurfaceBinding => ({
    org: "default", platform: "slack", workspace: "T", surface: "C", mode, visibility: "public", trust,
  });
  const p = (surface: string): Partition => ({ org: "default", platform: "slack", workspace: "T", surface, workspaceKey: "slack/T", surfaceKey: `slack/T/${surface}`, key: `slack/T/${surface}` });
  const domains = [
    defineDomain({ name: "eng", reach: ["slack/T/C_ENG"] }),
    defineDomain({ name: "org", match: "org" }),
  ];

  ok(skillDomainFor(b("channel", "internal"), p("C_ENG"), domains).domain === "eng", "pure: explicit domain wins");
  ok(skillDomainFor(b("channel", "internal"), p("C_OTHER"), domains).domain === "org", "pure: internal unassigned channel falls to the org pseudo-domain");
  const dm = skillDomainFor(b("dm", "internal"), p("C_ANY"), domains);
  ok(dm.domain === null && dm.reason === "dm", "pure: dm never resolves a domain (even if trust says internal)");
  const mpim = skillDomainFor(b("mpim", "internal"), p("C_ANY"), domains);
  ok(mpim.domain === null && mpim.reason === "mpim", "pure: group chat (mpim) never resolves a domain");
  const ext = skillDomainFor(b("channel", "external"), p("C_ENG"), domains);
  ok(ext.domain === null && ext.reason === "external", "pure: an externally-shared/unconfirmed channel never resolves, even if it's in an explicit domain");
  const none = skillDomainFor(b("channel", "internal"), p("C_OTHER"), []);
  ok(none.domain === null && none.reason === "unassigned", "pure: unassigned + no org pseudo-domain → \"unassigned\"");
}

{
  ok(resolveSkillDomainDetailed(ctxEng).domain === "eng", "ctx: explicit domain resolves by real channel→domain lookup");
  ok(resolveSkillDomainDetailed(ctxUnassigned).domain === "org", "ctx: internal unassigned channel resolves to the org pseudo-domain");
  ok(resolveSkillDomain(ctxDm) === undefined, "ctx: dm session has no resolved domain");
  ok(resolveSkillDomain(ctxMpim) === undefined, "ctx: group-chat session has no resolved domain");
  ok(resolveSkillDomain(ctxExternal) === undefined, "ctx: externally-shared/unconfirmed session has no resolved domain");

  for (const reason of ["dm", "mpim", "external", "unassigned"] as const) {
    const msg = domainSkillRefusalMessage(reason);
    ok(msg.length > 0 && !msg.includes("undefined"), `refusal message for "${reason}" is a real sentence`);
  }
}

{
  ok(withDescription("body only", undefined) === "body only", "withDescription: no description → content untouched");
  const withDesc = withDescription("Steps go here.", "When to deploy.\nmulti-line");
  ok(withDesc.startsWith("---\ndescription: When to deploy. multi-line\n---\n\n"), "withDescription: folds description into frontmatter, newlines collapsed");
  ok(withDesc.endsWith("Steps go here."), "withDescription: original body rides after the frontmatter");
  const already = "---\ndescription: mine\n---\nBody";
  ok(withDescription(already, "ignored") === already, "withDescription: never clobbers content that already carries frontmatter");

  const row: DomainSkillRow = { org: "default", domain: "eng", name: "deploy-runbook", content: withDesc, updatedBy: "U1", updatedAt: "2026-07-04T10:00:00Z" };
  ok(skillPackageFromRow(row).description === "When to deploy. multi-line", "skillPackageFromRow: description parsed from frontmatter");
  const bare: DomainSkillRow = { org: "default", domain: "eng", name: "no-frontmatter", content: "Just steps.", updatedAt: "2026-07-04T10:00:00Z" };
  const pkg = skillPackageFromRow(bare);
  ok(pkg.description.includes('"no-frontmatter"') && pkg.description.includes('"eng"') && !pkg.description.includes("authored by"), "skillPackageFromRow: frontmatter-less row gets a provenance fallback description, no dangling 'authored by' when updatedBy is absent");
  const withAuthor = skillPackageFromRow({ ...bare, updatedBy: "U2" });
  ok(withAuthor.description.includes("authored by U2"), "skillPackageFromRow: fallback description credits updatedBy when known");
}

{
  overrideSettingsForTest({ skills: { domainSkillCap: 50 } });
  ok(domainSkillCap() === 50, "domainSkillCap: default is 50 with no env override");
  overrideSettingsForTest({ skills: { domainSkillCap: 5 } });
  ok(domainSkillCap() === 5, "domainSkillCap: a registered override applies");
  process.env.OE_DOMAIN_SKILL_CAP = "999";
  ok(domainSkillCap() === 5, "domainSkillCap: a stray OE_DOMAIN_SKILL_CAP is inert — the mirror is deleted (OPE-411)");
  delete process.env.OE_DOMAIN_SKILL_CAP;
  overrideSettingsForTest({ skills: { domainSkillCap: 50 } });
}

{
  const store = getOperationalStore();
  await store.putDomainSkill("default", "eng", "safe-one", "# Safe", "U1", "2026-07-04T10:00:00Z");
  await store.putDomainSkill("default", "eng", "bad:name", "# Bad", "U1", "2026-07-04T10:00:00Z");
  await store.putDomainSkill("default", "eng", "granted-one", "# Shadowing a grant", "U1", "2026-07-04T10:00:00Z");

  const warns: string[] = [];
  const rows = await resolveDomainSkillRows(ctxEng, new Set(["granted-one"]), (m) => warns.push(m));
  ok(rows.some((r) => r.name === "safe-one"), "resolveDomainSkillRows: a safely-named, non-colliding row is kept");
  ok(!rows.some((r) => r.name === "bad:name"), "resolveDomainSkillRows: an unsafe name is dropped defensively at read time");
  ok(warns.some((w) => w.includes("unsafe name")), "resolveDomainSkillRows: unsafe name drop is warned");
  ok(!rows.some((r) => r.name === "granted-one"), "resolveDomainSkillRows: a domain skill colliding with a granted name is dropped — granted wins");
  ok(warns.some((w) => w.includes("granted wins")), "resolveDomainSkillRows: granted-collision drop is warned");

  ok((await resolveDomainSkillRows(ctxDm, new Set())).length === 0, "resolveDomainSkillRows: dm session → []");
  ok((await resolveDomainSkillRows(ctxExternal, new Set())).length === 0, "resolveDomainSkillRows: external/unconfirmed session → []");

  const orig = store.listDomainSkills;
  store.listDomainSkills = async () => {
    throw new Error("simulated store outage");
  };
  const failWarns: string[] = [];
  const failRows = await resolveDomainSkillRows(ctxEng, new Set(), (m) => failWarns.push(m));
  ok(failRows.length === 0 && failWarns.some((w) => w.includes("failed to read")), "resolveDomainSkillRows: a store error is fail-soft (empty + warn), never thrown");
  store.listDomainSkills = orig;

  await store.deleteDomainSkill("default", "eng", "bad:name").catch(() => {});
  await store.deleteDomainSkill("default", "eng", "granted-one");
}

{
  const entries = await resolveSkillEntries(ctxEng);
  const byName = new Map(entries.map((e) => [e.name, e]));
  ok(byName.get("granted-one")?.tier === "granted", "resolveSkillEntries: bundle-granted skill is present with tier \"granted\"");
  ok(byName.get("safe-one")?.tier === "domain", "resolveSkillEntries: domain-authored skill is present with tier \"domain\"");
  ok(byName.get("safe-one")?.updatedBy === "U1", "resolveSkillEntries: domain tier carries updatedBy provenance");
  ok(!byName.has("bad:name"), "resolveSkillEntries: the unsafe-named row never reaches the merge");
  ok(byName.get("granted-one")?.pkg.files?.["where.json"] === "slack/C_ENG", "resolveSkillEntries: a granted skill's session file carries this session's platform and surface");
  ok(byName.get("safe-one")?.pkg.files?.["where.json"] === undefined, "resolveSkillEntries: a skill with no declared session file gets none");
  const unassignedGranted = (await resolveSkillEntries(ctxUnassigned)).find((e) => e.name === "granted-one");
  ok(unassignedGranted?.pkg.files?.["where.json"] === "slack/C_RANDOM", "resolveSkillEntries: the session file follows the session's surface, never a cached value");

  const dmEntries = await resolveSkillEntries(ctxDm);
  ok(!dmEntries.some((e) => e.tier === "domain"), "resolveSkillEntries: dm session never gets a domain tier");
  const extEntries = await resolveSkillEntries(ctxExternal);
  ok(extEntries.some((e) => e.tier === "granted") && !extEntries.some((e) => e.tier === "domain"), "resolveSkillEntries: external/unconfirmed session sees granted skills but no domain skills");

  await getOperationalStore().putDomainSkill("default", "org", "org-wide-note", "# Org note", "U1", "2026-07-04T10:00:00Z");
  const unassignedEntries = await resolveSkillEntries(ctxUnassigned);
  ok(unassignedEntries.some((e) => e.name === "org-wide-note" && e.tier === "domain"), "resolveSkillEntries: an internal unassigned channel gets the org pseudo-domain's skills");
}

{
  const { actionKind } = await import("../agent/approvals/actions.js");
  await import("../agent/approvals/flow.js");

  await assert.rejects(async () => { await execTool(createSkillTool)({ name: "bad:name", content: "x" }, ctxEng as never); }, /valid skill name/, "create_skill: rejects an unsafe name");
  n++;

  const oversized = "x".repeat(MAX_DOMAIN_SKILL_BYTES + 1);
  await assert.rejects(async () => { await execTool(createSkillTool)({ name: "too-big", content: oversized }, ctxEng as never); }, /32KB|cap is/, "create_skill: rejects content over the byte cap");
  n++;

  await assert.rejects(async () => { await execTool(createSkillTool)({ name: "x", content: "y" }, ctxDm as never); }, /DM/, "create_skill: refuses from a DM with an explanatory message");
  n++;
  await assert.rejects(async () => { await execTool(createSkillTool)({ name: "x", content: "y" }, ctxMpim as never); }, /group chat/, "create_skill: refuses from a group chat");
  n++;
  await assert.rejects(async () => { await execTool(createSkillTool)({ name: "x", content: "y" }, ctxExternal as never); }, /externally-shared|unconfirmed/, "create_skill: refuses from an externally-shared/unconfirmed channel");
  n++;

  await assert.rejects(async () => { await execTool(createSkillTool)({ name: "granted-one", content: "y" }, ctxEng as never); }, /already a bundle-granted skill/, "create_skill: refuses a name that collides with a bundle-granted skill");
  n++;

  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ts: "1700000000.0001" }) })) as unknown as typeof fetch;
  try {
    const created = await execTool(createSkillTool)({ name: "new-skill", content: "# Body", description: "A new one." }, ctxEng as never);
    ok(created.ok && created.pending === true && created.action === "created" && created.domain === "eng", "create_skill: proposes (card posted, pending), action \"created\"");
    ok((await getOperationalStore().listDomainSkills("default", "eng")).every((r) => r.name !== "new-skill"), "create_skill: NOTHING is written until a human arms it (the PERSIST gate)");

    const updated = await execTool(createSkillTool)({ name: "new-skill", content: "# Body v2" }, ctxEng as never);
    ok(updated.pending === true && updated.action === "created", "create_skill: re-propose before arming is still \"created\" (no row exists yet)");

    const kind = actionKind("skill.create")!;
    ok(kind !== undefined && kind.policy === "member", "actionKind: skill.create registered with member policy");
    const summary = kind.summarize({ org: "default", domain: "eng", name: "new-skill", content: "# Body v2", action: "created", tainted: true });
    const cleanSummary = kind.summarize({ org: "default", domain: "eng", name: "new-skill", content: "# Body v2", action: "created" });
    ok(summary.some((l: string) => l.includes("new-skill")) && JSON.stringify(summary) === JSON.stringify(cleanSummary), "skill.create summarize: shows the name, and a legacy tainted card renders exactly the clean card");
    await kind.execute({ org: "default", domain: "eng", name: "new-skill", content: "# Body v2", action: "created", authoredBy: "U1" }, "U_ARMER");
    const rows = await getOperationalStore().listDomainSkills("default", "eng");
    ok(rows.filter((r) => r.name === "new-skill").length === 1, "skill.create execute: the click writes exactly one row");

    overrideSettingsForTest({ skills: { domainSkillCap: (await getOperationalStore().listDomainSkills("default", "eng")).length } });
    await assert.rejects(async () => { await execTool(createSkillTool)({ name: "one-too-many", content: "x" }, ctxEng as never); }, /cap/, "create_skill: refuses a NEW skill once the domain is at its cap");
    n++;
    const stillWorks = await execTool(createSkillTool)({ name: "new-skill", content: "# Body v3" }, ctxEng as never);
    ok(stillWorks.pending === true && stillWorks.action === "updated", "create_skill: an EXISTING name still proposes at the cap, as \"updated\" (cap only blocks growth)");
    overrideSettingsForTest({ skills: { domainSkillCap: 50 } });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SLACK_BOT_TOKEN;
  }
}

{
  const { requestApproval, resolveApprovalClick } = await import("../agent/approvals/flow.js");
  const store = getOperationalStore();

  const posted = await requestApproval(
    {
      org: "default",
      kind: "skill.create",
      args: { org: "default", domain: "eng", name: "armed-skill", content: "# Armed body", action: "created", authoredBy: "U_AUTHOR" },
      scopeKey: "slack/T1/C_ENG",
      domain: "eng",
      requestedBy: "U_AUTHOR",
      channelId: "C_ENG",
      chain: { unattended: false },
    },
    { postCard: async () => "ts-skill-1" },
  );
  const decided = await resolveApprovalClick({ org: "default", id: posted.id, decision: "approve", clickerId: "U_ARMER2" });
  ok(decided.outcome === "decided", `arming: the click decides (outcome ${decided.outcome})`);

  const armed = (await store.listDomainSkillRevisions("default", "eng", "armed-skill"))[0];
  ok(armed !== undefined && armed.content === "# Armed body", "arming: the approved body is recorded verbatim");
  ok(armed?.authoredBy === "U_AUTHOR" && armed?.armedBy === "U_ARMER2", "arming: author and ARMER are recorded separately (they are different people)");
  ok(armed?.approvalId === posted.id, `arming: the revision names the CARD that armed it (${armed?.approvalId} vs ${posted.id})`);

  const posted2 = await requestApproval(
    {
      org: "default",
      kind: "skill.create",
      args: { org: "default", domain: "eng", name: "armed-skill", content: "# Armed body v2", action: "updated", authoredBy: "U_AUTHOR" },
      scopeKey: "slack/T1/C_ENG",
      domain: "eng",
      requestedBy: "U_AUTHOR",
      channelId: "C_ENG",
      chain: { unattended: false },
    },
    { postCard: async () => "ts-skill-2" },
  );
  await resolveApprovalClick({ org: "default", id: posted2.id, decision: "approve", clickerId: "U_ARMER3" });
  const both = await store.listDomainSkillRevisions("default", "eng", "armed-skill");
  ok(both.length === 2 && both[0].content === "# Armed body", "arming: the FIRST approved body survives the second approval that replaced it");
  ok(both[0].approvalId === posted.id && both[1].approvalId === posted2.id, "arming: each revision points at its own card, not the latest one");
  ok((await store.listDomainSkills("default", "eng")).find((r) => r.name === "armed-skill")?.content === "# Armed body v2", "arming: the LIVE row is the latest body (the log is history, not a replacement)");

  await store.deleteDomainSkill("default", "eng", "armed-skill");
}

{
  const { actionKind } = await import("../agent/approvals/actions.js");
  await import("../agent/approvals/flow.js");

  await assert.rejects(async () => { await execTool(deleteSkillTool)({ name: "no-such-skill" }, ctxEng as never); }, /No skill named/, "delete_skill: refuses a nonexistent skill up front (no card wasted)");
  n++;
  await assert.rejects(async () => { await execTool(deleteSkillTool)({ name: "x" }, ctxDm as never); }, /DM/, "delete_skill: refuses from a DM too");
  n++;

  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ts: "1700000000.0002" }) })) as unknown as typeof fetch;
  try {
    const proposed = await execTool(deleteSkillTool)({ name: "new-skill" }, ctxEng as never);
    ok(proposed.pending === true && proposed.domain === "eng" && proposed.name === "new-skill", "delete_skill: proposes (card posted, pending) instead of deleting on the spot");
    ok((await getOperationalStore().listDomainSkills("default", "eng")).some((r) => r.name === "new-skill"), "delete_skill: NOTHING is removed until a human confirms (skill still present)");

    const kind = actionKind("skill.delete")!;
    ok(kind !== undefined && kind.policy === "member", "actionKind: skill.delete registered with member policy");
    const summary = kind.summarize({ org: "default", domain: "eng", name: "new-skill" });
    ok(summary.some((l: string) => l.includes("new-skill")) && summary.some((l: string) => l.includes("eng")), "skill.delete summarize: names the exact frozen skill + domain");
    const outcome = await kind.execute({ org: "default", domain: "eng", name: "new-skill", requestedBy: "U1" }, "U_CONFIRMER");
    ok(/deleted/.test(outcome), "skill.delete execute: the confirming click removes the frozen target");
    ok((await getOperationalStore().listDomainSkills("default", "eng")).every((r) => r.name !== "new-skill"), "delete_skill: gone from the store after the confirming click");

    const again = await kind.execute({ org: "default", domain: "eng", name: "new-skill" }, "U_CONFIRMER");
    ok(/already gone/.test(again), "skill.delete execute: a target already gone reports cleanly (no throw)");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SLACK_BOT_TOKEN;
  }
}

{
  const { skills } = await execTool(listSkillsTool)({}, ctxEng as never);
  const entries = await resolveSkillEntries(ctxEng);
  ok(skills.length === entries.length, "list_skills: returns exactly what resolveSkillEntries resolves — no separate source of truth");
  ok(skills.every((s) => ["granted", "domain", "repo"].includes(s.tier)), "list_skills: every entry carries a recognizable tier");
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  ok(JSON.stringify(skills) === JSON.stringify(sorted), "list_skills: output is sorted by name");
}

console.log(`✓ domain-skills: ${n} assertions passed (store round-trip, domain resolution policy, resolver merge, tool validation matrix)`);

// proves: AP-MOD-core-approvals-skill-create, AP-MOD-core-approvals-skill-delete

// proves: TOOL-create_skill, TOOL-delete_skill, TOOL-list_skills

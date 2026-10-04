import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-purge-"));
process.env.OE_SQLITE_PATH = join(tmp, "mem.sqlite3");

const { removeBulletLine } = await import("../agent/memory/markdown.js");
const { bulletSha256, removeBulletLineBySha, removeBulletLinesBySha, removedLineDigests } = await import("../agent/memory/purge-redaction.js");
const { registerConfig } = await import("../agent/access/config.js");
const { providerById, registerProvider } = await import("../agent/memory/provider.js");
const { siloTier, tierId } = await import("../agent/memory/store.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { requestApproval, resolveApprovalClick, registerCardPoster } = await import("../agent/approvals/flow.js");
await import("../agent/approvals/memory-purge.js");
const { findPurgeCandidates, planPurge, MAX_PURGE_BULLETS } = await import("../agent/tools/purge_memory.js");
type PurgeSearchTier = import("../agent/tools/purge_memory.js").PurgeSearchTier;

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  n++;
}
function throwsWith(fn: () => unknown, needle: string, label: string): void {
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(msg.includes(needle), `${label} (message: "${msg}")`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [
    { name: "eng-brain", provider: "sqlite" },
    { name: "org-brain", provider: "sqlite" },
  ],
  domainsForSurface: () => [],
});

const partition: import("../agent/memory/partition.js").Partition = {
  org: "default",
  platform: "slack",
  workspace: "T1",
  surface: "C1",
  workspaceKey: "slack/T1",
  surfaceKey: "slack/T1/C1",
  key: "slack/T1/C1",
};

function slackBinding(overrides: Partial<import("../agent/identity/binding.js").SurfaceBinding> = {}): import("../agent/identity/binding.js").SurfaceBinding {
  return {
    org: "default",
    platform: "slack",
    workspace: "T1",
    surface: "C1",
    mode: "channel",
    visibility: "public",
    trust: "internal",
    principalId: "U999",
    target: { channelId: "C1" },
    ...overrides,
  };
}

const engTierId = tierId(siloTier("eng-brain"));
const orgTierId = tierId(siloTier("org-brain"));

function tiersOf(eng: Record<string, string | undefined>, org: Record<string, string | undefined> = {}): PurgeSearchTier[] {
  return [
    { siloName: "eng-brain", provider: "sqlite", tierId: engTierId, files: eng },
    { siloName: "org-brain", provider: "sqlite", tierId: orgTierId, files: org },
  ];
}

{
  const content = "# Memory\n\n## Notes\n- 2026-07-01: Ada owns billing\n";
  ok(removeBulletLine(content, "- 2026-07-01: Ada owns billing").removed === true, "removeBulletLine: present bullet is removed");
  ok(removeBulletLine(content, "- 2026-07-01: nope").removed === false, "removeBulletLine: absent bullet reports removed:false");
}

{
  const eng = {
    "MEMORY.md": "# Memory\n\n## People / ownership\n- 2026-07-01: Ada owns billing\n\n## Notes\n- 2026-07-02: some note\n",
    "people.md": "# People / ownership\n- 2026-07-01: Ada owns billing\n",
    "notes.md": undefined,
  };

  const plan = planPurge(slackBinding(), partition, tiersOf(eng), { match: "Ada owns billing" }, "eng");
  ok(plan.kind === "memory.purge", "planPurge: kind is memory.purge");
  ok(plan.args.bullets.length === 1, "planPurge: ONE distinct bullet even though it lives in two files");
  ok(plan.args.bullets[0]!.sha256 === bulletSha256("- 2026-07-01: Ada owns billing"), "planPurge: freezes the bullet's SHA-256, not its text");
  ok(plan.args.bullets[0]!.chars === "- 2026-07-01: Ada owns billing".length, "planPurge: freezes the bullet's length");
  ok(!JSON.stringify(plan.args).includes("Ada owns billing"), "planPurge: the frozen args never contain the verbatim bullet (redaction)");
  ok(plan.cardLines.some((l) => l.includes("- 2026-07-01: Ada owns billing")), "planPurge: the display-only cardLines DO carry the verbatim bullet for the approver to read");
  ok(plan.cardLines.some((l) => l.toLowerCase().includes("cannot be undone")), "planPurge: the card says out loud that this is irreversible");
  ok(plan.cardLines.some((l) => l.includes("ERASES the line(s) from every silo listed")), "🔴 OPE-1801: an all-sqlite purge claims a real erasure");
  ok(!plan.cardLines.some((l) => l.includes("NOT a full erasure")), "…and says nothing about retained history, because none is retained");
  {
    const gitTiers: PurgeSearchTier[] = [{ siloName: "eng-brain", provider: "git", tierId: engTierId, files: eng }];
    const gitPlan = planPurge(slackBinding(), partition, gitTiers, { match: "Ada owns billing" }, "eng");
    ok(gitPlan.cardLines.join("\n") !== plan.cardLines.join("\n"), "🔴 OPE-1801: the git-backed card differs from the sqlite-backed one — the promise is not hedged across backings");
    ok(!gitPlan.cardLines.some((l) => l.includes("ERASES")), "🔴 OPE-1801: a git-backed purge never claims an erasure git does not deliver");
    ok(gitPlan.cardLines.some((l) => l.includes("NOT a full erasure") && l.includes("`eng-brain`")), "…it names the silo whose pre-purge text survives in the backing's history");
    ok(gitPlan.cardLines.some((l) => l.toLowerCase().includes("cannot be undone")), "…and still says the live removal is irreversible");

    const mixed = planPurge(
      slackBinding(),
      partition,
      [{ siloName: "eng-brain", provider: "sqlite", tierId: engTierId, files: eng }, { siloName: "org-brain", provider: "git", tierId: orgTierId, files: eng }],
      { match: "Ada owns billing" },
      "eng",
    );
    const mixedNote = mixed.cardLines.find((l) => l.includes("NOT a full erasure")) ?? "";
    ok(mixedNote.includes("`org-brain`") && !mixedNote.includes("`eng-brain`"), "🔴 OPE-1801: a mixed purge names the git silo alone — the sqlite silo really is erased");

    const unknown = planPurge(slackBinding(), partition, [{ siloName: "eng-brain", provider: "some-new-backing", tierId: engTierId, files: eng }], { match: "Ada owns billing" }, "eng");
    ok(!unknown.cardLines.some((l) => l.includes("ERASES")), "🔴 OPE-1801: an unknown backing never gets the erasure claim — fail-closed");
    ok(unknown.cardLines.some((l) => l.includes("NOT a full erasure") && l.includes("`eng-brain`")), "…it takes the retaining claim instead");

    const notion = planPurge(slackBinding(), partition, [{ siloName: "org-brain", provider: "notion", tierId: orgTierId, files: eng }], { match: "Ada owns billing" }, "eng");
    ok(notion.cardLines.some((l) => l.includes("NOTHING is removed") && l.includes("`org-brain`")), "🔴 OPE-1801: a notion silo's card says NOTHING is removed there — the write throws");
    ok(notion.cardLines.some((l) => l.includes("append-only") && l.includes("Remove it in Notion itself")), "…and tells the approver where the fact actually has to be removed");
    ok(!notion.cardLines.some((l) => l.includes("ERASES")), "…and never claims an erasure");
    ok(!notion.cardLines.some((l) => l.includes("NOT a full erasure") && l.includes("`org-brain`")), "🔴 …nor the git wording, which would still promise the line leaves the agent's memory");
  }
  ok(plan.args.locations.length === 2 && plan.args.locations.every((l) => l.siloName === "eng-brain"), "planPurge: cross-file dedupe — ONE bullet listing BOTH files it lives in");
  ok(plan.args.locations.every((l) => l.tierId === engTierId && l.provider === "sqlite"), "planPurge: each location freezes its silo's tier id + provider");
  ok(JSON.stringify(plan.args.partition) === JSON.stringify(partition), "planPurge: freezes the full partition, JSON round-trippable");
  ok(plan.scopeKey === partition.surfaceKey, "planPurge: top-level scopeKey mirrors the partition's surfaceKey");
  ok(plan.domain === "eng", "planPurge: freezes the passed-in domain");

  const org = { "MEMORY.md": "# Org memory\n\n## People / ownership\n- 2026-07-01: Ada owns billing\n" };
  const swept = planPurge(slackBinding(), partition, tiersOf(eng, org), { match: "Ada owns billing" }, "eng");
  ok(swept.args.bullets.length === 1, "planPurge (sweep): the identical line across two silos is still ONE bullet");
  ok(
    swept.args.locations.length === 3 && swept.args.locations.some((l) => l.siloName === "org-brain" && l.tierId === orgTierId),
    "planPurge (sweep): 🔴 the SECOND writable silo's copy is in the frozen locations — the erasure is not silo-local",
  );

  const many = {
    "MEMORY.md": "# Memory\n\n## People / ownership\n- 2026-07-01: Ada owns billing\n- 2026-07-03: billing is owned by Ada (see rota)\n",
  };
  const multi = planPurge(slackBinding(), partition, tiersOf(many), { match: "billing" }, null);
  ok(multi.args.bullets.length === 2, "planPurge: TWO distinct matching bullets are purged together, not refused as ambiguous");
  ok(multi.cardLines.filter((l) => l.startsWith("> ")).length === 2, "planPurge: the card renders BOTH verbatim lines for the human to read");
  ok(!JSON.stringify(multi.args).includes("rota"), "planPurge: multi-bullet args are still content-free");

  const ciPlan = planPurge(slackBinding(), partition, tiersOf(eng), { match: "ADA OWNS BILLING" }, null);
  ok(ciPlan.args.bullets[0]!.sha256 === bulletSha256("- 2026-07-01: Ada owns billing"), "planPurge: matches case-insensitively");
  ok(ciPlan.domain === null, "planPurge: passes through a null domain");

  throwsWith(
    () => planPurge(slackBinding(), partition, tiersOf(eng), { match: "nothing like this exists" }, null),
    "Nothing in this session's writable memory matches",
    "planPurge: refuses with no candidates",
  );
  try {
    planPurge(slackBinding(), partition, tiersOf(eng), { match: "nothing like this exists" }, null);
  } catch (e) {
    ok(
      (e instanceof Error ? e.message : "").includes("edit the memory file"),
      "planPurge: the no-match refusal names the ORDINARY path (edit the file) — purge is not the correction verb",
    );
  }

  const runaway = {
    "MEMORY.md": Array.from({ length: MAX_PURGE_BULLETS + 2 }, (_, i) => `- 2026-07-01: shared-topic entry ${i + 1}`).join("\n"),
  };
  throwsWith(
    () => planPurge(slackBinding(), partition, tiersOf(runaway), { match: "shared-topic" }, null),
    "too broad to erase in one act",
    "planPurge: refuses a runaway match rather than freezing an unbounded erasure",
  );
  const tooMany = findPurgeCandidates(tiersOf(runaway), "shared-topic");
  ok(tooMany.kind === "toomany" && tooMany.count === MAX_PURGE_BULLETS + 2 && tooMany.sample.length === 5, "findPurgeCandidates: reports the true count and a 5-item sample");

  ok(
    planPurge(slackBinding({ platform: "teams" }), partition, tiersOf(eng), { match: "billing" }, null).kind === "memory.purge",
    "planPurge: 🔴 PLANS on a card-less surface — freezing the args is decidable from the inputs; the venue walk routes the card",
  );
  registerCardPoster("discord", async () => undefined);
  ok(
    planPurge(slackBinding({ platform: "discord" }), partition, tiersOf(eng), { match: "billing" }, null).kind === "memory.purge",
    "planPurge: a surface that REGISTERS a card poster plans exactly as Slack does",
  );
  throwsWith(
    () => planPurge(slackBinding({ principalId: undefined }), partition, tiersOf(eng), { match: "billing" }, null),
    "verified sender",
    "planPurge: refuses with no verified principal",
  );
  throwsWith(
    () => planPurge(slackBinding(), partition, tiersOf(eng), { match: "  " }, null),
    "non-empty phrase",
    "planPurge: refuses a blank match phrase",
  );
}

{
  const kind = actionKind("memory.purge")!;
  ok(kind !== undefined && kind.policy === "member", "actionKind: memory.purge is registered with member policy");

  const provider = providerById("sqlite");
  const engTier = siloTier("eng-brain");
  const orgTier = siloTier("org-brain");
  const engSilo = { name: "eng-brain", provider: "sqlite" };
  const orgSilo = { name: "org-brain", provider: "sqlite" };
  const bullet = "- 2026-07-01: Ada owns billing";

  await provider.writeTier(partition, engTier, { "MEMORY.md": `# Memory\n\n## People / ownership\n${bullet}\n`, "people.md": `# People / ownership\n${bullet}\n` }, "seed", engSilo);
  await provider.writeTier(partition, orgTier, { "MEMORY.md": `# Org\n\n## People / ownership\n${bullet}\n` }, "seed-org", orgSilo);

  const args = {
    org: "default",
    partition,
    bullets: [{ sha256: bulletSha256(bullet), chars: bullet.length }],
    locations: [
      { siloName: "eng-brain", provider: "sqlite", tierId: tierId(engTier), file: "MEMORY.md" },
      { siloName: "eng-brain", provider: "sqlite", tierId: tierId(engTier), file: "people.md" },
      { siloName: "org-brain", provider: "sqlite", tierId: tierId(orgTier), file: "MEMORY.md" },
    ],
  };

  const summary = kind.summarize(args);
  ok(!summary.some((l) => l.includes("Ada owns billing")), "summarize: NEVER shows the bullet text (frozen args are redacted; the pending card gets it via display-only summaryLines)");
  ok(summary.some((l) => l.includes(bulletSha256(bullet).slice(0, 12))), "summarize: shows the digest prefix so the card correlates with the audit row");
  ok(summary.some((l) => l.includes("eng-brain") && l.includes("org-brain")), "summarize: names EVERY silo the sweep will touch");

  const outcome = await kind.execute(args, "U_MEMBER_1");
  ok(outcome.includes("MEMORY.md") && outcome.includes("people.md"), "execute: outcome names the files the bullet was removed from");

  const afterEng = await provider.readTier(partition, engTier, engSilo);
  const afterOrg = await provider.readTier(partition, orgTier, orgSilo);
  ok(!afterEng["MEMORY.md"].includes(bullet) && !afterEng["people.md"].includes(bullet), "execute: the bullet is gone from BOTH files in the first silo (located by digest, not text)");
  ok(!afterOrg["MEMORY.md"].includes(bullet), "execute: 🔴 the bullet is gone from the SECOND silo too — the sweep crosses silos");

  const audit = await readAudit({ org: "default", action: "memory.purge" });
  ok(
    audit.some((e) => e.principalId === "U_MEMBER_1" && Array.isArray(e.detail?.bullets) && (e.detail!.bullets as { sha256: string }[])[0]?.sha256 === bulletSha256(bullet)),
    "execute: audits memory.purge with the clicker as principal + the erased bullets' DIGESTS",
  );
  ok(!audit.some((e) => JSON.stringify(e).includes("Ada owns billing")), "execute: NO audit row carries the verbatim bullet (the log outlives the erasure)");
}

{
  const content = "# Memory\n\n## Notes\n- 2026-07-01: Ada owns billing   \n- 2026-07-02: keep me\n";
  const hit = removeBulletLineBySha(content, bulletSha256("- 2026-07-01: Ada owns billing"));
  ok(hit.removed === true && !hit.content.includes("Ada owns billing") && hit.content.includes("keep me"), "removeBulletLineBySha: removes exactly the line whose normalised form hashes to the digest");
  ok(removeBulletLineBySha(content, bulletSha256("- 2026-07-01: nope")).removed === false, "removeBulletLineBySha: absent digest reports removed:false");

  const dupes = "# Memory\n- 2026-07-01: A fact\n- 2026-07-02: B fact\n- 2026-07-01: A fact\n- 2026-07-03: keep\n";
  const swept = removeBulletLinesBySha(dupes, [bulletSha256("- 2026-07-01: A fact"), bulletSha256("- 2026-07-02: B fact")]);
  ok(swept.removed === 3, "removeBulletLinesBySha: removes every occurrence of every targeted digest (3 lines, 2 digests)");
  ok(swept.content.includes("keep") && !swept.content.includes("A fact") && !swept.content.includes("B fact"), "removeBulletLinesBySha: leaves untargeted lines alone");
}

{
  const host = "# Memory\n\n## Notes\n- 2026-07-01: SSN-000-FAKE is the owner's\n- 2026-07-02: keep me\n";
  const next = "# Memory\n\n## Notes\n- 2026-07-02: keep me\n- 2026-07-03: brand new\n";
  const removed = removedLineDigests(host, next);
  ok(removed.length === 1, "removedLineDigests: reports exactly the one line that went (an ADDED line is not a deletion)");
  ok(removed[0]!.sha256 === bulletSha256("- 2026-07-01: SSN-000-FAKE is the owner's"), "removedLineDigests: the digest re-hashes from the known line (verifiable after the fact)");
  ok(removed[0]!.chars === "- 2026-07-01: SSN-000-FAKE is the owner's".length, "removedLineDigests: records the removed line's length");
  ok(!JSON.stringify(removed).includes("SSN-000-FAKE"), "removedLineDigests: 🔴 the digest set NEVER carries the removed content");
  ok(removedLineDigests(host, "## Notes\n- 2026-07-02: keep me\n- 2026-07-01: SSN-000-FAKE is the owner's\n").length === 1, "removedLineDigests: a reorder that DROPS a heading reports only the dropped line");
  ok(removedLineDigests(host, host).length === 0, "removedLineDigests: an unchanged file reports no deletions");
  ok(removedLineDigests(host, `${host}- 2026-07-04: appended\n`).length === 0, "removedLineDigests: a pure APPEND reports no deletions");
}

{
  const SENSITIVE = "SSN-000-TEST";
  const bullet = `- 2026-07-05: the owner's SSN is ${SENSITIVE}`;

  const sqlite = providerById("sqlite");
  const commitMessages: string[] = [];
  registerProvider({
    ...sqlite,
    id: "spy",
    writeTier: (p, t, f, m, s) => {
      commitMessages.push(m);
      return sqlite.writeTier(p, t, f, m, s);
    },
  });
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [
      { name: "eng-brain", provider: "sqlite" },
      { name: "pii-brain", provider: "spy" },
    ],
    domainsForSurface: () => [],
  });

  const spy = providerById("spy");
  const tier = siloTier("pii-brain");
  const silo = { name: "pii-brain", provider: "spy" };
  await spy.writeTier(partition, tier, { "MEMORY.md": `# Memory\n\n## Notes\n${bullet}\n` }, "seed-pii", silo);

  const piiTiers: PurgeSearchTier[] = [{ siloName: "pii-brain", provider: "spy", tierId: tierId(tier), files: { "MEMORY.md": `# Memory\n\n## Notes\n${bullet}\n` } }];
  const plan = planPurge(slackBinding(), partition, piiTiers, { match: SENSITIVE }, "eng");

  let cardBody: readonly string[] = [];
  const posted = await requestApproval(
    { org: "default", kind: plan.kind, args: plan.args, scopeKey: plan.scopeKey, domain: plan.domain, requestedBy: "U_REQUESTER", channelId: "C1", summaryLines: plan.cardLines, chain: { unattended: false } },
    { postCard: async (_row, summaryLines) => ((cardBody = summaryLines), "ts-pii-1") },
  );
  ok(cardBody.some((l) => l.includes(bullet)), "round-trip: the PENDING card body carries the verbatim bullet (display-only injection gate)");

  const pendingRow = await getOperationalStore().getPendingAction("default", posted.id);
  ok(pendingRow !== null && !pendingRow.argsJson.includes(SENSITIVE), "round-trip: pending_actions.argsJson never contains the sensitive string (redacted at freeze time)");

  const res = await resolveApprovalClick({ org: "default", id: posted.id, decision: "approve", clickerId: "U_APPROVER" });
  ok(res.outcome === "decided" && res.row.status === "approved", "round-trip: the click approves and executes");
  ok(res.outcome === "decided" && !res.summaryLines.some((l) => l.includes(SENSITIVE)), "round-trip: the DECIDED card re-render is redacted (does not re-display the purged fact)");
  ok(!(await spy.readTier(partition, tier, silo))["MEMORY.md"].includes(SENSITIVE), "round-trip: the fact is gone from the memory tier");

  const allAudit = await readAudit({ org: "default" });
  ok(allAudit.length > 0 && !allAudit.some((e) => JSON.stringify(e).includes(SENSITIVE)), "sweep: NO audit row (any action) contains the sensitive string");
  ok(!(await getOperationalStore().getPendingAction("default", posted.id))!.argsJson.includes(SENSITIVE), "sweep: the decided pending row is still digest-only");
  ok(commitMessages.length > 0 && !commitMessages.some((m) => m.includes(SENSITIVE)), "sweep: no provider commit message contains the sensitive string (git/GitHub commits are permanent)");

  ok(allAudit.some((e) => e.action === "approval.requested" && e.detail?.id === posted.id), "sweep: approval.requested is on the record");
  ok(allAudit.some((e) => e.action === "approval.approved" && e.detail?.id === posted.id && e.principalId === "U_APPROVER"), "sweep: approval.approved records the approver");
  ok(
    allAudit.some((e) => e.action === "memory.purge" && e.principalId === "U_APPROVER" && Array.isArray(e.detail?.bullets) && (e.detail!.bullets as { sha256: string }[]).some((b) => b.sha256 === bulletSha256(bullet))),
    "sweep: memory.purge records WHO erased WHICH line (by digest), verifiable by re-hashing the known bullet",
  );
}

{
  const provider = providerById("sqlite");
  const tier = siloTier("eng-brain");
  const silo = { name: "eng-brain", provider: "sqlite" };
  const bullet = "- 2026-07-02: Bo owns payouts";

  await provider.writeTier(partition, tier, { "MEMORY.md": `# Memory\n\n## People / ownership\n${bullet}\n`, "people.md": "# People / ownership\n(none yet)\n" }, "seed2", silo);

  const args = {
    org: "default",
    partition,
    bullets: [{ sha256: bulletSha256(bullet), chars: bullet.length }],
    locations: [
      { siloName: "eng-brain", provider: "sqlite", tierId: tierId(tier), file: "MEMORY.md" },
      { siloName: "eng-brain", provider: "sqlite", tierId: tierId(tier), file: "people.md" },
    ],
  };
  const kind = actionKind("memory.purge")!;
  const outcome = await kind.execute(args, "U_MEMBER_2");
  ok(outcome.includes("MEMORY.md"), "execute: removed-from names MEMORY.md");
  ok(outcome.includes("already gone from") && outcome.includes("people.md"), "execute: notes people.md as already-gone (skipped, not an error)");
  ok(!(await provider.readTier(partition, tier, silo))["MEMORY.md"].includes(bullet), "execute: MEMORY.md had the bullet removed");
}

{
  const provider = providerById("sqlite");
  const tier = siloTier("eng-brain");
  const silo = { name: "eng-brain", provider: "sqlite" };
  const bullet = "- 2026-07-03: this fact was already purged";

  await provider.writeTier(partition, tier, { "MEMORY.md": "# Memory\n\n## Notes\n(none yet)\n", "notes.md": "# Notes\n(none yet)\n" }, "seed3", silo);

  const args = {
    org: "default",
    partition,
    bullets: [{ sha256: bulletSha256(bullet), chars: bullet.length }],
    locations: [
      { siloName: "eng-brain", provider: "sqlite", tierId: tierId(tier), file: "MEMORY.md" },
      { siloName: "eng-brain", provider: "sqlite", tierId: tierId(tier), file: "notes.md" },
    ],
  };
  const kind = actionKind("memory.purge")!;
  const outcome = await kind.execute(args, "U_MEMBER_3");
  ok(outcome.toLowerCase().includes("already gone"), "execute: reports already-gone when no frozen file contains the bullet anymore");
  ok(!outcome.includes("already purged"), "execute: the already-gone outcome line is content-free");

  const audit = await readAudit({ org: "default", action: "memory.purge" });
  ok(audit.some((e) => e.principalId === "U_MEMBER_3" && e.detail?.alreadyGone === true), "execute: audits the already-gone outcome too (an erasure decided by a click always leaves a trail)");
}

{
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [{ name: "replay-brain", provider: "sqlite" }],
    domainsForSurface: () => [],
  });

  const provider = providerById("sqlite");
  const tier = siloTier("replay-brain");
  const silo = { name: "replay-brain", provider: "sqlite" };
  const target = "- 2026-08-15: OPE-582 replay target fact";
  const keep = "- 2026-08-15: OPE-582 bystander fact that must survive";
  const seeded = `# Replay fixture\n\n${target}\n${keep}\n`;

  await provider.writeTier(partition, tier, { "MEMORY.md": seeded }, "seed-replay", silo);

  const args = {
    org: "default",
    partition,
    bullets: [{ sha256: bulletSha256(target), chars: target.length }],
    locations: [{ siloName: "replay-brain", provider: "sqlite", tierId: tierId(tier), file: "MEMORY.md" }],
  };
  const kind = actionKind("memory.purge")!;

  const first = await kind.execute(args, "U_REPLAY_1");
  ok(first.includes("purged 1 line(s)"), "replay: the FIRST execute reports the real redaction");
  const afterFirst = (await provider.readTier(partition, tier, silo))["MEMORY.md"]!;
  ok(!afterFirst.includes("OPE-582 replay target fact"), "replay: the FIRST execute removed the targeted line");
  ok(afterFirst.includes("OPE-582 bystander fact"), "replay: the FIRST execute left the untargeted line alone");

  const second = await kind.execute(args, "U_REPLAY_2");
  ok(second.toLowerCase().includes("already gone"), "replay: the SECOND execute reports already-gone (the outcome LINE is the one non-idempotent value)");
  const afterSecond = (await provider.readTier(partition, tier, silo))["MEMORY.md"]!;
  ok(afterSecond === afterFirst, "replay: 🔴 the tier is BYTE-IDENTICAL after the re-execution — no pre-redaction state is restored and no bystander line is touched");
  ok(!afterSecond.includes("OPE-582 replay target fact"), "replay: the purged line is still absent after the re-execution");

  const replayAudit = (await readAudit({ org: "default", action: "memory.purge" })).filter((e) => e.principalId === "U_REPLAY_1" || e.principalId === "U_REPLAY_2");
  ok(replayAudit.length === 2, "replay: each execution audits exactly one memory.purge row");
  ok(replayAudit.find((e) => e.principalId === "U_REPLAY_1")?.detail?.alreadyGone === undefined, "replay: the FIRST row is NOT flagged already-gone");
  ok(replayAudit.find((e) => e.principalId === "U_REPLAY_2")?.detail?.alreadyGone === true, "replay: the SECOND row IS flagged already-gone (the re-execution is a recorded no-op, not a second erasure)");
  ok(replayAudit.find((e) => e.principalId === "U_REPLAY_2")?.detail?.removedLines === 0, "replay: the SECOND row removed ZERO lines");

  const clickBullet = "- 2026-08-15: OPE-582 click-replay target fact";
  await provider.writeTier(partition, tier, { "click.md": `# Click fixture\n\n${clickBullet}\n` }, "seed-click", silo);
  const clickArgs = {
    org: "default",
    partition,
    bullets: [{ sha256: bulletSha256(clickBullet), chars: clickBullet.length }],
    locations: [{ siloName: "replay-brain", provider: "sqlite", tierId: tierId(tier), file: "click.md" }],
  };
  const posted = await requestApproval(
    { org: "default", kind: "memory.purge", args: clickArgs, scopeKey: partition.surfaceKey, domain: null, requestedBy: "U_REQUESTER", channelId: "C1", chain: { unattended: false } },
    { postCard: async () => "ts-replay-1" },
  );
  const click1 = await resolveApprovalClick({ org: "default", id: posted.id, decision: "approve", clickerId: "U_CLICKER_1" });
  ok(click1.outcome === "decided" && click1.outcomeLine.includes("purged 1 line(s)"), "replay: the first click decides and executes");
  const click2 = await resolveApprovalClick({ org: "default", id: posted.id, decision: "approve", clickerId: "U_CLICKER_2" });
  ok(click2.outcome === "not-pending", "replay: 🔴 a SECOND decide on the same pending is refused by the CAS — execute() is never reached twice through the click path");
  const clickAudit = (await readAudit({ org: "default", action: "memory.purge" })).filter((e) => e.principalId === "U_CLICKER_1" || e.principalId === "U_CLICKER_2");
  ok(clickAudit.length === 1 && clickAudit[0]!.principalId === "U_CLICKER_1", "replay: exactly ONE memory.purge row exists for the re-clicked card");
}

assert.ok(n > 0);
console.log(`\n✓ purge: ${n} assertions passed (planPurge sweep/multi-bullet/refusals, redacted memory.purge execute + audit, capture-seam deletion digests, GDPR round-trip sweep, OPE-582 re-execution idempotence)\n`);
await removeTempDir(tmp);

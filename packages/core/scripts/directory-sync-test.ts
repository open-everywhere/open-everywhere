process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "postgres";

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { registerOperationalStore, resetOperationalStore } from "../agent/operational/provider.js";
import {
  DIRECTORY_SYNC_ACTION,
  DIRECTORY_AUTOCONFIRM_SETTING,
  directoryAutoConfirm,
  directoryLinkSetId,
  directoryLinkSetVaultArmed,
  lastDirectorySync,
  pendingDirectorySuggestionsFor,
  planDirectorySync,
  planIsNoop,
  syncDirectoryOrg,
  type DirectorySyncPlan,
  type DirectoryLinkState,
} from "../agent/identity/directory-sync.js";
import { directoryProvider, registerDirectoryProvider, resetDirectoryProvider, type DirectoryPerson, type DirectoryProvider } from "../agent/identity/directory.js";
import { defineSettings, overrideSettingsForTest, registerSettings, resetSettingsForTest } from "../agent/settings/settings.js";
import {
  confirmedLinkSetPrincipals,
  expandLinkSet,
  listLinkSetsWithIds,
  resolveLinkSet,
  revokeLinkSet,
  setLinkSetHold,
  suggestLinkedId,
} from "../agent/identity/link-store.js";
import { readAudit } from "../agent/audit/audit.js";
import type { BindableContext } from "../agent/identity/binding.js";
import confirmLinkTool from "../agent/tools/confirm_link.js";
import linkIdentityTool from "../agent/tools/link_identity.js";
import { observeLinkClaim } from "../agent/hooks/link-claim.js";
import { registerSlackFixtureMapper, registerSlackTestBridge } from "./_slack-test-stubs.js";
import { registerConfig } from "../agent/access/config.js";
import { tryLinkTenantOf } from "../agent/identity/link-tenant.js";
import { defineDomain } from "../agent/memory/domain.js";

registerSlackFixtureMapper();
const privateLinkPosts: Array<{ channelId: string; text: string }> = [];
registerSlackTestBridge({
  form: async (operation, body) => {
    if (operation !== "chat.postMessage") return undefined;
    const form = new URLSearchParams(body);
    privateLinkPosts.push({ channelId: form.get("channel") ?? "", text: form.get("text") ?? "" });
    return { ok: true, ts: `fixture-${privateLinkPosts.length}` };
  },
});

function privateLinkCode(channelId: string): string {
  const post = [...privateLinkPosts].reverse().find((candidate) => candidate.channelId === channelId);
  const code = post && /link ([A-Z0-9]{8})/u.exec(post.text)?.[1];
  if (!code) throw new Error(`fixture captured no private link code for ${channelId}`);
  return code;
}

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
async function refuses(fn: () => Promise<unknown>, needle: string, label: string): Promise<void> {
  let msg = "";
  try {
    await fn();
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  ok(msg.length > 0 && msg.toLowerCase().includes(needle.toLowerCase()), `${label} (got: ${msg || "no error"})`);
}

const ORG = "default";
const T1 = "T1";
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadSilos: () => [],
  domainsForSurface: () => [],
  loadDomains: () => [defineDomain({ name: "eng", reach: [`slack/${T1}/C_ENG`] })],
});
const RESOLVE_TENANT = (platform: string): string | undefined => tryLinkTenantOf(platform, undefined);
const db = new PGlite();
const client: PgClient = { query: (text, params) => db.query(text, params ? [...params] : undefined) };
await initOperationalSchema(client);
const pg = makeOperationalPostgresStore(client);
registerOperationalStore(pg);
resetOperationalStore();

function fakeDirectory(people: () => readonly DirectoryPerson[], id = "okta"): DirectoryProvider {
  return { id, name: `fake ${id}`, listPeople: async () => people() };
}

const rowan = (over: Partial<DirectoryPerson> = {}): DirectoryPerson => ({
  externalId: "00u-rowan",
  displayName: "Rowan Hale",
  email: "rowan@acme.example",
  accounts: [
    { platform: "slack", nativeId: "U-ROWAN", grade: "attested" },
    { platform: "github", nativeId: "gh-rowan", grade: "attested" },
  ],
  groups: ["Engineering"],
  deprovisioned: false,
  ...over,
});

const stepsFor = (plan: DirectorySyncPlan, kind: string) => plan.steps.filter((s) => s.kind === kind);

{
  resetSettingsForTest();
  ok(directoryAutoConfirm() === "off", "policy: shipped ⇒ off — every suggestion waits for its human");
  process.env.OE_DIRECTORY_AUTOCONFIRM = "attested";
  ok(directoryAutoConfirm() === "off", "🔴 policy: the retired OE_DIRECTORY_AUTOCONFIRM arms NOTHING — the escape opens only by a reviewed commit");
  delete process.env.OE_DIRECTORY_AUTOCONFIRM;
  overrideSettingsForTest({ directory: { autoConfirm: "attested" } });
  ok(directoryAutoConfirm() === "attested", "policy: a registered \"attested\" arms the single escape");
  registerSettings({ connectors: { linkSetVault: false } });
  let threw = "";
  try {
    defineSettings({ directory: { autoConfirm: "atested" as never } });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  ok(threw.includes(DIRECTORY_AUTOCONFIRM_SETTING), "policy: FAIL-LOUD on a typo at settings load — a security knob that silently resolves safe is still a deployment lying to its operator");
  ok(threw.includes("attested") && threw.includes("off"), "policy: …and the refusal names both valid values");
}

{
  resetDirectoryProvider();
  ok(directoryProvider() === undefined, "port: unregistered ⇒ no provider");
  ok((await syncDirectoryOrg({ org: ORG })) === null, "port: syncing with no provider returns null — cleanly off, never a crash");
  ok((await lastDirectorySync(ORG)) === null, "status: an org that has never synced reads back null");
}

const setId = directoryLinkSetId("okta", "00u-rowan");
{
  let people: readonly DirectoryPerson[] = [rowan()];
  const provider = fakeDirectory(() => people);
  registerDirectoryProvider(provider);

  const run1 = (await syncDirectoryOrg({ org: ORG, autoConfirm: "off" }))!;
  ok(run1.plan.counts.suggest === 2 && run1.plan.counts.confirm === 0, "sync 1 (policy off): both accounts are SUGGESTED, nothing confirmed");
  ok(run1.applied.setsCreated === 1 && run1.applied.suggested === 2, "sync 1: one set created, two suggestions written");
  ok(run1.plan.warnings.length === 0 && run1.refusals.length === 0, "sync 1: no warnings, no write refusals");

  const created = (await listLinkSetsWithIds(ORG)).find((r) => r.set.id === setId)!;
  ok(created !== undefined, "the set id is DERIVED from (provider, externalId), so a second concurrent run converges on it instead of splitting the person");
  ok(created.set.handle === "Rowan Hale", "the directory display name is the set's handle — DISPLAY ONLY, never a lookup key");
  ok(created.ids.every((r) => r.status === "suggested"), "every row lands `suggested`");
  ok(created.ids.every((r) => r.establishedBy === "directory-sync:okta"), "…stamped with the directory evidence label");
  ok(
    created.ids.every((r) => JSON.parse(r.evidenceJson ?? "{}").externalId === "00u-rowan" && JSON.parse(r.evidenceJson ?? "{}").grade === "attested"),
    "…and the structured evidence records the IdP user id AND the grade, so \"why does the system believe this\" is a column",
  );

  ok((await resolveLinkSet(ORG, "github", "gh-rowan", "")) === null, "🔴 a suggestion resolves to NOTHING — the IdP has not linked anybody");
  ok((await expandLinkSet(ORG, setId)).length === 0, "🔴 …and expands to nothing");
  ok((await confirmedLinkSetPrincipals(ORG)).length === 0, "🔴 …and contributes nothing to the attribution union");

  const run2 = (await syncDirectoryOrg({ org: ORG, autoConfirm: "off" }))!;
  ok(planIsNoop(run2.plan), "IDEMPOTENT: the same directory a second time plans ONLY no-ops");
  ok(run2.applied.suggested === 0 && run2.applied.setsCreated === 0 && run2.applied.confirmed === 0 && run2.applied.suspended === 0, "…and writes nothing");
  ok(
    stepsFor(run2.plan, "noop").every((s) => (s as { why: string }).why.includes("awaiting")),
    "…and says WHY: the rows are waiting on this person's own DM confirmation",
  );

  people = [rowan({ accounts: [...rowan().accounts, { platform: "linear", nativeId: "lin-rowan", grade: "attested" }] })];
  const run3 = (await syncDirectoryOrg({ org: ORG, autoConfirm: "off" }))!;
  ok(run3.plan.counts.suggest === 1 && run3.applied.setsCreated === 0, "a newly-mapped account joins the EXISTING set — anchored through an account, never a name");
  ok((await listLinkSetsWithIds(ORG)).filter((r) => r.set.id === setId)[0]!.ids.length === 3, "…so the person still has exactly one set");
}

{
  const rows = await readAudit({ org: ORG, action: DIRECTORY_SYNC_ACTION });
  ok(rows.length === 3, "every run appends exactly one summary row (3 runs so far)");
  const status = (await lastDirectorySync(ORG))!;
  ok(status.detail.provider === "okta" && status.detail.policy === "off", "status: the last run's provider + policy read straight back off the audit trail");
  ok(typeof (status.detail.planned as { suggest?: unknown }).suggest === "number", "status: carries the planned counts");
  ok(
    (await readAudit({ org: ORG, action: "identity.link.suggested" })).length === 3,
    "…and link-store.ts still appends its own per-mutation row for each suggestion (the specifics live there, not duplicated in the summary)",
  );
}

type ExecTool = { execute(input: unknown, ctx: unknown): Promise<any> };
const confirmLink = confirmLinkTool as unknown as ExecTool;
const linkIdentity = linkIdentityTool as unknown as ExecTool;

function ctxFor(opts: { channelId: string; channelType?: string; principalId?: string }): BindableContext {
  return ctxForTenant(T1, opts);
}

function ctxForTenant(teamId: string, opts: { channelId: string; channelType?: string; principalId?: string }): BindableContext {
  const attributes: Record<string, string> = { team_id: teamId, channel_id: opts.channelId, trust_checked: "true" };
  if (opts.channelType) attributes.channel_type = opts.channelType;
  if (opts.channelType === "im") attributes.dm_partner_trust = "internal";
  return {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes, principalId: opts.principalId ?? "U1", principalType: "slack-user" } } },
  } as BindableContext;
}
const dmRowan = ctxFor({ channelId: "D-ROWAN", channelType: "im", principalId: "U-ROWAN" });
const dmStranger = ctxFor({ channelId: "D-NOPE", channelType: "im", principalId: "U-STRANGER" });
const channelRowan = ctxFor({ channelId: "C1", principalId: "U-ROWAN" });

{
  const bootstrap = await pendingDirectorySuggestionsFor(ORG, "slack", T1, "U-ROWAN");
  ok(bootstrap.length === 1 && bootstrap[0]!.principal === `slack/${T1}/U-ROWAN`, "F2(b): a bootstrap caller (own row merely suggested) sees ONLY their own account");
  ok(bootstrap[0]!.provider === "okta" && bootstrap[0]!.grade === "attested", "read: it carries the proposing provider and its grade");
  ok((await pendingDirectorySuggestionsFor(ORG, "slack", T1, "U-STRANGER")).length === 0, "🔴 read: a stranger's query finds NOTHING — somebody else's suggestions are structurally unavailable, not merely refused");

  await refuses(() => confirmLink.execute({ decision: "confirm" }, channelRowan), "DM-only", "confirm_link still refuses outside a DM on the directory path");
  await refuses(() => confirmLink.execute({ decision: "confirm" }, dmStranger), "nothing of yours", "🔴 a stranger cannot confirm somebody else's directory suggestions");
  await refuses(() => confirmLink.execute({ decision: "confirm", accounts: ["github/gh-rowan"] }, dmRowan), "none of those accounts", "🔴 F2(b): a bootstrap caller cannot confirm the set's OTHER accounts by naming them");
  ok((await resolveLinkSet(ORG, "github", "gh-rowan", "")) === null, "🔴 F2(b): …and gh-rowan was not linked");

  const denied = await confirmLink.execute({ decision: "deny" }, dmRowan);
  ok(denied.decided === "denied" && denied.accounts.join() === `slack/${T1}/U-ROWAN`, "deny works on the directory path (the bootstrap's own account)");
  ok((await resolveLinkSet(ORG, "slack", "U-ROWAN", T1)) === null, "🔴 …and a deny writes NOTHING — the account still has no standing");
  ok(denied.note.includes("unlink_identity"), "…and names the verb that actually removes an account, so \"I said no\" and \"make it go away\" stay distinct acts");

  const boot = await confirmLink.execute({ decision: "confirm" }, dmRowan);
  ok(boot.decided === "confirmed" && boot.accounts.join() === `slack/${T1}/U-ROWAN`, "F2(b): the bootstrap one-tap confirms ONLY the caller's own account");
  ok((await resolveLinkSet(ORG, "slack", "U-ROWAN", T1))?.id === setId, "…and it now resolves to their link-set");

  const standing = await pendingDirectorySuggestionsFor(ORG, "slack", T1, "U-ROWAN");
  ok(standing.map((s) => s.principal).sort().join() === "github/gh-rowan,linear/lin-rowan", "F2(a): once CONFIRMED, standing exposes the set's other attested suggestions");

  let blanket = "";
  try {
    await confirmLink.execute({ decision: "confirm" }, dmRowan);
  } catch (e) {
    blanket = e instanceof Error ? e.message : String(e);
  }
  ok(blanket.includes("2 accounts are waiting"), `🔴 OPE-291: a blanket yes over SEVERAL pending suggestions is refused, not batched (got: ${blanket || "no error"})`);
  ok(
    blanket.includes("github/gh-rowan") && blanket.includes("linear/lin-rowan"),
    "🔴 OPE-291: …and the refusal NAMES every account waiting, so the person can answer about ones they were shown",
  );
  ok((await resolveLinkSet(ORG, "github", "gh-rowan", "")) === null, "🔴 OPE-291: …and the refusal is a REFUSAL — nothing was linked");
  ok((await expandLinkSet(ORG, setId)).length === 1, "🔴 OPE-291: …the set still holds only the bootstrap account");

  const denyMany = await confirmLink.execute({ decision: "deny" }, dmRowan);
  ok(
    denyMany.decided === "denied" && denyMany.accounts.sort().join() === "github/gh-rowan,linear/lin-rowan",
    "OPE-291: a bare DENY over several pending suggestions still works in one tap — the fence is on `confirm` only",
  );
  ok((await expandLinkSet(ORG, setId)).length === 1, "…and denying wrote nothing");

  const rest = await confirmLink.execute({ decision: "confirm", accounts: ["github/gh-rowan", "linear/lin-rowan"] }, dmRowan);
  ok(rest.accounts.sort().join() === "github/gh-rowan,linear/lin-rowan", "…and NAMING the remaining attested suggestions confirms them all in the one call");
  ok((await expandLinkSet(ORG, setId)).length === 3, "…so all three accounts are now confirmed members of the set");

  const row = (await listLinkSetsWithIds(ORG)).find((r) => r.set.id === setId)!.ids.find((r) => r.platform === "github")!;
  ok(
    row.establishedBy === `challenge:dm-confirm:slack/${T1}/U-ROWAN`,
    "🔴 the DM tap is recorded as the degenerate CHALLENGE it is, naming the account that answered — the trust anchor stays uniform",
  );

  await refuses(() => confirmLink.execute({ decision: "confirm" }, dmRowan), "nothing of yours", "with everything confirmed, there is nothing left to decide");
  await refuses(() => confirmLink.execute({ decision: "confirm", accounts: ["github/gh-rowan"] }, dmRowan), "nothing of yours", "…and an already-confirmed account is not re-offered");
}

{
  const evilSet = "dir-evil";
  await pg.putLinkSet(ORG, { org: ORG, id: evilSet, handle: "evil", status: "active", createdAt: "2026-01-10T12:20:00Z", updatedAt: "2026-01-10T12:20:00Z" });
  await suggestLinkedId({ org: ORG, linkSetId: evilSet, account: { platform: "slack", tenant: T1, nativeId: "ATTACKER" }, evidence: { kind: "directory-sync", provider: "okta", grade: "attested" } });
  await suggestLinkedId({ org: ORG, linkSetId: evilSet, account: { platform: "github", tenant: "", nativeId: "VICTIM_GH" }, evidence: { kind: "directory-sync", provider: "okta", grade: "email-match" } });
  const dmAttacker = ctxFor({ channelId: "D-EVIL", channelType: "im", principalId: "ATTACKER" });

  const attackerPending = await pendingDirectorySuggestionsFor(ORG, "slack", T1, "ATTACKER");
  ok(attackerPending.length === 1 && attackerPending[0]!.principal === `slack/${T1}/ATTACKER`, "🔴 F2: the attacker (bootstrap) sees ONLY their own account — the victim's is invisible");
  await refuses(() => confirmLink.execute({ decision: "confirm", accounts: ["github/VICTIM_GH"] }, dmAttacker), "none of those accounts", "🔴 F2: the attacker cannot confirm the victim's github account");
  ok((await resolveLinkSet(ORG, "github", "VICTIM_GH", "")) === null, "🔴 F2: the victim's account was NOT linked into the attacker's set");

  await confirmLink.execute({ decision: "confirm" }, dmAttacker);
  const afterStanding = await pendingDirectorySuggestionsFor(ORG, "slack", T1, "ATTACKER");
  ok(!afterStanding.some((s) => s.principal === "github/VICTIM_GH"), "🔴 F2(c): a confirmed member still cannot see an EMAIL-MATCH account that isn't theirs");
  await refuses(() => confirmLink.execute({ decision: "confirm", accounts: ["github/VICTIM_GH"] }, dmAttacker), "nothing of yours", "🔴 F2(c): …and naming it explicitly still refuses");
  ok((await resolveLinkSet(ORG, "github", "VICTIM_GH", "")) === null, "🔴 F2(c): the victim's account is still unlinked");

  ok((await pendingDirectorySuggestionsFor(ORG, "github", "", "VICTIM_GH")).some((s) => s.principal === "github/VICTIM_GH"), "F2(c): the account ITSELF sees its own email-match suggestion to ratify from its own DM");
}

{
  const dmAda = ctxFor({ channelId: "D-ADA", channelType: "im", principalId: "U-ADA" });
  const issued = await linkIdentity.execute({}, dmAda);
  ok(!/link [A-Z0-9]{8}/u.test(String(issued.instructions)), "challenge path: the model-visible result contains no live link code");
  await observeLinkClaim({
    org: ORG,
    platform: "github",
    authorId: "gh-ada",
    addressed: true,
    text: `link ${privateLinkCode("D-ADA")}`,
    trust: "peer",
  });
  const adaPeek = (await confirmLink.execute({ decision: "confirm" }, dmAda)) as { challengeId?: string };
  const ratified = await confirmLink.execute({ decision: "confirm", acknowledge: true, challengeId: adaPeek.challengeId }, dmAda);
  ok(ratified.decided === "confirmed", "challenge path: a second person links slack/U-ADA ↔ github/gh-ada by proof of control");
  const adaSet = ratified.linkSetId as string;

  const people: readonly DirectoryPerson[] = [
    rowan({ accounts: [...rowan().accounts, { platform: "linear", nativeId: "lin-rowan", grade: "attested" }] }),
    {
      externalId: "00u-ada",
      displayName: "Ada L.",
      accounts: [
        { platform: "github", nativeId: "gh-ada", grade: "attested" },
        { platform: "linear", nativeId: "lin-ada", grade: "email-match" },
      ],
      groups: ["Engineering", "Admins"],
      deprovisioned: false,
    },
  ];
  registerDirectoryProvider(fakeDirectory(() => people));

  const before = (await listLinkSetsWithIds(ORG)).find((r) => r.set.id === adaSet)!.ids.find((r) => r.platform === "github")!;
  const run = (await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!;
  const after = (await listLinkSetsWithIds(ORG)).find((r) => r.set.id === adaSet)!.ids.find((r) => r.platform === "github")!;
  ok(after.establishedBy === before.establishedBy && after.establishedBy.startsWith("challenge:"), "🔴 a challenge-established `confirmed` row is NEVER re-evidenced by a sync");
  ok(
    stepsFor(run.plan, "noop").some((s) => {
      const noop = s as { nativeId?: string; why: string };
      return noop.nativeId === "gh-ada" && noop.why === "already confirmed";
    }),
    "…and the plan says so out loud: already confirmed ⇒ no-op",
  );
  ok(
    run.plan.steps.some((s) => s.kind === "suggest" && s.nativeId === "lin-ada" && s.linkSetId === adaSet),
    "the directory's NEW account for Ada is suggested into her EXISTING challenge-built set, anchored through gh-ada",
  );

  const shrunk: readonly DirectoryPerson[] = [
    people[0]!,
    { ...people[1]!, accounts: [{ platform: "linear", nativeId: "lin-ada", grade: "email-match" }] },
  ];
  registerDirectoryProvider(fakeDirectory(() => shrunk));
  const run2 = (await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!;
  ok(!run2.plan.steps.some((s) => s.kind !== "noop" && "nativeId" in s && s.nativeId === "gh-ada"), "🔴 an account the directory STOPPED mentioning is not touched");
  ok((await resolveLinkSet(ORG, "github", "gh-ada", ""))?.id === adaSet, "🔴 …it still resolves — absence from the IdP is not evidence of non-ownership");
  ok((await expandLinkSet(ORG, adaSet)).some((a) => a.platform === "github"), "🔴 …and it is still a member of her set");
  ok(!run2.plan.steps.some((s) => (s.kind as string) === "unlink" || (s.kind as string) === "revoke"), "the plan has no unlink/revoke step KIND at all — the guarantee is structural");
}

{
  const carol: DirectoryPerson = {
    externalId: "00u-carol",
    displayName: "Carol",
    accounts: [
      { platform: "slack", nativeId: "U-CAROL", grade: "attested" },
      { platform: "linear", nativeId: "lin-carol", grade: "email-match" },
    ],
    groups: [],
    deprovisioned: false,
  };
  const carolSet = directoryLinkSetId("okta", "00u-carol");

  const off = planDirectorySync({ resolveTenant: RESOLVE_TENANT, provider: "okta", people: [carol], current: [], autoConfirm: "off" });
  ok(off.counts.suggest === 2 && off.counts.confirm === 0, "planner (off): both accounts suggested, neither confirmed");
  ok(off.steps.every((s) => s.kind !== "suggest" || !s.autoConfirm), "planner (off): no suggestion is marked auto-confirmable");

  const armed = planDirectorySync({ resolveTenant: RESOLVE_TENANT, provider: "okta", people: [carol], current: [], autoConfirm: "attested" });
  const armedSuggests = armed.steps.filter((s): s is Extract<typeof s, { kind: "suggest" }> => s.kind === "suggest");
  ok(armedSuggests.find((s) => s.nativeId === "U-CAROL")!.autoConfirm === true, "planner (attested): an ATTESTED mapping may skip the DM tap");
  ok(armedSuggests.find((s) => s.nativeId === "lin-carol")!.autoConfirm === false, "🔴 planner (attested): an EMAIL-MATCH mapping never may — the escape is narrowed to provisioning facts");

  registerDirectoryProvider(fakeDirectory(() => [carol]));
  const run = (await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!;
  ok(run.applied.suggested === 2 && run.applied.confirmed === 1, "runner (attested): both rows written, exactly one confirmed");
  ok((await resolveLinkSet(ORG, "slack", "U-CAROL", T1))?.id === carolSet, "runner (attested): the attested account resolves immediately");
  ok((await resolveLinkSet(ORG, "linear", "lin-carol", "")) === null, "🔴 runner (attested): the email-match account still waits for Carol");
  const confirmedRow = (await listLinkSetsWithIds(ORG)).find((r) => r.set.id === carolSet)!.ids.find((r) => r.platform === "slack")!;
  ok(
    confirmedRow.establishedBy === "directory-sync:okta" && JSON.parse(confirmedRow.evidenceJson ?? "{}").grade === "attested",
    "runner (attested): the evidence recorded is the ATTESTATION — the thing that actually convinced the system",
  );
  ok(planIsNoop((await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!.plan), "runner (attested): still idempotent on the second pass");

  const dmCarol = ctxFor({ channelId: "D-CAROL", channelType: "im", principalId: "U-CAROL" });
  await refuses(() => confirmLink.execute({ decision: "confirm" }, dmCarol), "nothing of yours", "🔴 F2(c): an email-match suggestion is NOT confirmable from another of the person's accounts (proof of control must come from that account itself)");
  ok((await pendingDirectorySuggestionsFor(ORG, "linear", "", "lin-carol")).some((s) => s.principal === "linear/lin-carol"), "F2(c): …the account ITSELF sees its own email-match suggestion, to ratify from its own DM");
}

{
  const gone: DirectoryPerson = {
    externalId: "00u-carol",
    displayName: "Carol",
    accounts: [{ platform: "slack", nativeId: "U-CAROL", grade: "attested" }],
    groups: [],
    deprovisioned: true,
  };
  const carolSet = directoryLinkSetId("okta", "00u-carol");
  registerDirectoryProvider(fakeDirectory(() => [gone]));

  const run = (await syncDirectoryOrg({ org: ORG, autoConfirm: "off" }))!;
  ok(run.applied.suspended === 1, "🔴 deprovision applies EAGERLY at the most conservative policy — narrowing is safe to automate");
  ok((await listLinkSetsWithIds(ORG)).find((r) => r.set.id === carolSet)!.set.status === "suspended", "…the link-set is suspended");
  ok((await resolveLinkSet(ORG, "slack", "U-CAROL", T1)) === null, "…so attribution degrades to per-surface identity immediately");
  ok((await listLinkSetsWithIds(ORG)).find((r) => r.set.id === carolSet)!.ids.every((r) => r.status !== "revoked"), "🔴 …and NOTHING was revoked — terminal decisions stay human");

  const run2 = (await syncDirectoryOrg({ org: ORG, autoConfirm: "off" }))!;
  ok(planIsNoop(run2.plan) && run2.applied.suspended === 0, "deprovision is IDEMPOTENT — a suspended set is a no-op, not a repeated suspend");
  ok(stepsFor(run2.plan, "noop").some((s) => (s as { why: string }).why.includes("already suspended")), "…and says why");

  registerDirectoryProvider(fakeDirectory(() => [{ ...gone, deprovisioned: false, accounts: [...gone.accounts, { platform: "github" as const, nativeId: "gh-carol", grade: "attested" as const }] }]));
  const run3 = (await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!;
  ok(planIsNoop(run3.plan), "🔴 a re-activated person does NOT get new suggestions while their set is on an admin's hold");
  ok(stepsFor(run3.plan, "noop").every((s) => (s as { why: string }).why.includes("suspended")), "…and the plan names the hold as the reason");

  await setLinkSetHold({ org: ORG, linkSetId: carolSet, hold: "active", actor: "test-admin" });
  const run4 = (await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!;
  ok(run4.applied.suggested === 1 && run4.applied.confirmed === 1, "…and once reactivated, the sync widens again");
}

{
  const challengeState: DirectoryLinkState = [
    {
      set: { org: ORG, id: "ls-challenge", handle: "real-person", status: "active", createdAt: "z", updatedAt: "z" },
      ids: [
        { org: ORG, linkSetId: "ls-challenge", platform: "slack", tenant: T1, nativeId: "U-MIXED", status: "confirmed", establishedBy: "directory-sync:okta", createdAt: "z", updatedAt: "z" },
        { org: ORG, linkSetId: "ls-challenge", platform: "github", tenant: "", nativeId: "gh-proven", status: "confirmed", establishedBy: "challenge:c-real", createdAt: "z", updatedAt: "z" },
      ],
    },
  ];
  const anchor: DirectoryPerson = { externalId: "00u-mixed", displayName: "Mixed", accounts: [{ platform: "slack", nativeId: "U-MIXED", grade: "attested" }], groups: [], deprovisioned: true };
  const plan = planDirectorySync({ resolveTenant: RESOLVE_TENANT, provider: "okta", people: [anchor], current: challengeState, autoConfirm: "off" });
  ok(!plan.steps.some((s) => s.kind === "suspend"), "🔴 F5: a deprovision does NOT suspend a set that holds challenge-proven members");
  ok(stepsFor(plan, "noop").some((s) => (s as { why: string }).why.includes("challenge-proven")), "F5: …it is a no-op naming the reason");
  ok(plan.warnings.some((w) => w.includes("ls-challenge") && w.toLowerCase().includes("challenge")), "F5: …and a LOUD warning points the admin at the manual suspend/revoke lever");

  const dirOnlyState: DirectoryLinkState = [
    {
      set: { org: ORG, id: "ls-dironly", handle: "dir-person", status: "active", createdAt: "z", updatedAt: "z" },
      ids: [{ org: ORG, linkSetId: "ls-dironly", platform: "slack", tenant: T1, nativeId: "U-DIRONLY", status: "confirmed", establishedBy: "directory-sync:okta", createdAt: "z", updatedAt: "z" }],
    },
  ];
  const dirAnchor: DirectoryPerson = { externalId: "00u-dir", displayName: "Dir", accounts: [{ platform: "slack", nativeId: "U-DIRONLY", grade: "attested" }], groups: [], deprovisioned: true };
  const plan2 = planDirectorySync({ resolveTenant: RESOLVE_TENANT, provider: "okta", people: [dirAnchor], current: dirOnlyState, autoConfirm: "off" });
  ok(plan2.steps.some((s) => s.kind === "suspend" && s.linkSetId === "ls-dironly"), "F5: a genuinely directory-built set STILL suspends on deprovision");
}

{
  const carolSet = directoryLinkSetId("okta", "00u-carol");
  await revokeLinkSet({ org: ORG, linkSetId: carolSet, actor: "test-admin" });
  const run = (await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!;
  ok(planIsNoop(run.plan), "🔴 an offboarded (revoked) person is a permanent no-op — a sync cannot quietly reverse an offboarding");
  ok(!(await listLinkSetsWithIds(ORG)).some((r) => r.set.id !== carolSet && r.ids.some((i) => i.nativeId === "U-CAROL")), "…and no NEW set is minted for them either");
  ok((await listLinkSetsWithIds(ORG)).find((r) => r.set.id === carolSet)!.set.status === "revoked", "…the revoked set stays revoked (read-then-create never upserts over a status)");
}

{
  const state = await listLinkSetsWithIds(ORG);
  const rowanSet = state.find((r) => r.set.id === setId)!;
  const adaSet = state.find((r) => r.ids.some((i) => i.nativeId === "gh-ada"))!;
  const greedy: DirectoryPerson = {
    externalId: "00u-greedy",
    displayName: "Greedy Record",
    accounts: [
      { platform: "slack", nativeId: "U-ROWAN", grade: "attested" },
      { platform: "github", nativeId: "gh-ada", grade: "attested" },
      { platform: "linear", nativeId: "lin-brand-new", grade: "attested" },
    ],
    groups: [],
    deprovisioned: false,
  };
  const plan = planDirectorySync({ resolveTenant: RESOLVE_TENANT, provider: "okta", people: [greedy], current: state, autoConfirm: "attested" });
  ok(planIsNoop(plan), "🔴 conflict: a directory person spanning TWO link-sets is a whole-person NO-OP — the merge is refused, not guessed at");
  ok(plan.warnings.some((w) => w.includes(rowanSet.set.id) && w.includes(adaSet.set.id)), "…and the warning NAMES both sets so an admin can decide");
  ok(plan.warnings.some((w) => w.includes("An account is exactly one person")), "…and states the invariant it is protecting");
  ok(!plan.steps.some((s) => s.kind === "suggest"), "…and the brand-new third account is NOT quietly linked on the way past");

  registerDirectoryProvider(fakeDirectory(() => [greedy]));
  const run = (await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!;
  ok(run.applied.suggested === 0 && run.applied.confirmed === 0, "…and the runner writes nothing at all");
  ok((await lastDirectorySync(ORG))!.detail.warnings !== undefined, "…while the summary row carries the warnings for directory_sync_status to surface");

  const twin = planDirectorySync({
    resolveTenant: RESOLVE_TENANT,
    provider: "okta",
    people: [
      { externalId: "00u-a", displayName: "A", accounts: [{ platform: "slack", nativeId: "U-SHARED", grade: "attested" }], groups: [], deprovisioned: false },
      { externalId: "00u-b", displayName: "B", accounts: [{ platform: "slack", nativeId: "U-SHARED", grade: "attested" }], groups: [], deprovisioned: false },
    ],
    current: [],
    autoConfirm: "attested",
  });
  ok(planIsNoop(twin), "🔴 conflict: one account claimed by TWO directory records links to neither");
  ok(twin.warnings.filter((w) => w.includes(`slack/${T1}/U-SHARED`)).length === 2, "…warned for both records, so the duplicate is visible from either end");
  ok(twin.warnings.some((w) => w.includes("Fix the duplicate in the IdP")), "…and the warning says where the fix belongs");
}

{
  const none = planDirectorySync({
    resolveTenant: RESOLVE_TENANT,
    provider: "okta",
    people: [{ externalId: "00u-empty", displayName: "No Apps", accounts: [], groups: ["Everyone"], deprovisioned: false }],
    current: [],
    autoConfirm: "attested",
  });
  ok(planIsNoop(none), "a person the directory maps no accounts for is a no-op — no empty set is minted for them");

  const goneUnknown = planDirectorySync({
    resolveTenant: RESOLVE_TENANT,
    provider: "okta",
    people: [{ externalId: "00u-ghost", displayName: "Ghost", accounts: [{ platform: "slack", nativeId: "U-GHOST", grade: "attested" }], groups: [], deprovisioned: true }],
    current: [],
    autoConfirm: "attested",
  });
  ok(planIsNoop(goneUnknown), "🔴 a DEPROVISIONED person we hold no link-set for gets NO set created — a sync never onboards somebody the IdP already deactivated");

  const dup = planDirectorySync({
    resolveTenant: RESOLVE_TENANT,
    provider: "okta",
    people: [
      {
        externalId: "00u-dup",
        displayName: "Dup",
        accounts: [
          { platform: "slack", nativeId: "U-DUP", grade: "email-match" },
          { platform: "slack", nativeId: "U-DUP", grade: "attested" },
        ],
        groups: [],
        deprovisioned: false,
      },
    ],
    current: [],
    autoConfirm: "attested",
  });
  const dupSuggests = dup.steps.filter((s): s is Extract<typeof s, { kind: "suggest" }> => s.kind === "suggest");
  ok(dupSuggests.length === 1, "the same account from two mapped apps is deduped to one suggestion");
  ok(dupSuggests[0]!.autoConfirm === true, "…keeping the STRONGER grade, so a weaker duplicate cannot demote a provisioning fact");

  ok(directoryLinkSetId("okta", "00u-x") === directoryLinkSetId("okta", "00u-x"), "the derived set id is deterministic (what makes concurrent runs converge)");
  ok(directoryLinkSetId("okta", "00u-x") !== directoryLinkSetId("entra", "00u-x"), "…and per-provider, so two IdPs never collide");
  ok(!directoryLinkSetId("okta", "00u-x").includes("00u-x"), "…and a digest, so a set id never prints somebody's IdP record key");
}

{
  const dan: DirectoryPerson = {
    externalId: "00u-dan",
    displayName: "Dan",
    accounts: [
      { platform: "slack", nativeId: "U-DAN", grade: "attested" },
      { platform: "linear", nativeId: "lin-dan", grade: "attested" },
    ],
    groups: [],
    deprovisioned: false,
  };
  const danSet = directoryLinkSetId("okta", "00u-dan");
  registerDirectoryProvider(fakeDirectory(() => [dan]));
  await syncDirectoryOrg({ org: ORG, autoConfirm: "off" });
  ok((await listLinkSetsWithIds(ORG)).find((r) => r.set.id === danSet)!.ids.filter((i) => i.status === "suggested").length === 2, "setup: Dan has two SUGGESTED directory rows in his directory-derived set");

  const dmDan = ctxFor({ channelId: "D-DAN", channelType: "im", principalId: "U-DAN" });
  const issued = await linkIdentity.execute({}, dmDan);
  ok(!/link [A-Z0-9]{8}/u.test(String(issued.instructions)), "precedence path: the model-visible result contains no live link code");
  await observeLinkClaim({ org: ORG, platform: "github", authorId: "gh-dan", addressed: true, text: `link ${privateLinkCode("D-DAN")}`, trust: "peer" });

  const peeked = await confirmLink.execute({ decision: "confirm" }, dmDan);
  ok(peeked.decided === "awaiting_acknowledgement" && peeked.claimant === "github/gh-dan" && peeked.accounts === undefined, "OPE-618: the PEEK also takes the challenge path over the standing directory suggestions");
  const danPeek = (await confirmLink.execute({ decision: "confirm" }, dmDan)) as { challengeId?: string };
  const decided = await confirmLink.execute({ decision: "confirm", acknowledge: true, challengeId: danPeek.challengeId }, dmDan);
  ok(
    decided.claimant === "github/gh-dan",
    "🔴 with BOTH a claimed code and directory suggestions waiting, the CHALLENGE wins — a time-boxed claim must never be shadowed by a standing proposal",
  );
  ok(decided.accounts === undefined, "…and the directory batch was not swept up in the same call");

  ok(decided.linkSetId !== danSet, "🔴 F3: the challenge builds a FRESH set — it does NOT adopt the set the initiator was only suggested into");
  const freshSet = decided.linkSetId!;
  const fresh = (await expandLinkSet(ORG, freshSet)).map((a) => (a.tenant ? `${a.platform}/${a.tenant}/${a.nativeId}` : `${a.platform}/${a.nativeId}`)).sort();
  assert.deepEqual(fresh, ["github/gh-dan", `slack/${T1}/U-DAN`], "F3: the initiator and the challenge-proven account are linked TOGETHER in the fresh set");
  n++;
  ok((await pendingDirectorySuggestionsFor(ORG, "slack", T1, "U-DAN")).length === 0, "F3: from slack/U-DAN (now confirmed in the fresh set) there is nothing left to confirm there");

  const next = (await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!;
  ok(next.applied.confirmed === 0, "F3: the next sync confirms nothing — Dan's accounts now span two sets");
  ok(next.plan.warnings.some((w) => w.includes(danSet) && w.includes(freshSet)), "🔴 F3: …and it warns LOUDLY, naming both sets, so an admin decides (never a silent merge)");
}

{
  const erin: DirectoryPerson = {
    externalId: "00u-erin",
    displayName: "Erin",
    accounts: [{ platform: "slack", nativeId: "U-ERIN", grade: "attested" }],
    groups: [],
    deprovisioned: false,
  };
  const erinSet = directoryLinkSetId("okta", "00u-erin");
  registerDirectoryProvider(fakeDirectory(() => [erin]));

  resetSettingsForTest();
  ok(directoryLinkSetVaultArmed() === true, "🔴 vault reader: nothing registered ⇒ ARMED (the shipped default since OPE-2414)");
  registerSettings({ connectors: { linkSetVault: false } });
  ok(directoryLinkSetVaultArmed() === false, "vault reader: an explicit false is not armed");
  registerSettings({ connectors: { linkSetVault: true } });
  ok(directoryLinkSetVaultArmed() === true, "vault reader: armed");
  resetSettingsForTest();

  registerSettings({ connectors: { linkSetVault: true } });
  const armedRun = (await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!;
  ok(armedRun.applied.suggested === 1 && armedRun.applied.confirmed === 0, "🔴 runner (vault armed): the attested mapping lands as a SUGGESTION and nothing is confirmed");
  ok((await resolveLinkSet(ORG, "slack", "U-ERIN", T1)) === null, "🔴 …so the new account is in no set yet — it cannot reach the set's shared OAuth token");
  ok(
    armedRun.plan.warnings.some((w) => w.includes("connectors.linkSetVault") && w.includes("SUPPRESSED")),
    "…and the run says LOUDLY why an operator's armed auto-confirm stopped confirming",
  );
  ok(
    !armedRun.plan.warnings.some((w) => w.includes(erinSet)),
    "…without naming the set: the reason is the deployment's flag, not anything about Erin's set (which no config mentions)",
  );

  registerSettings({ connectors: { linkSetVault: false } });
  const offRun = (await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!;
  ok(offRun.applied.confirmed === 1, "🔴 runner (vault OFF): the SAME fixture auto-confirms exactly as before C.3 — the guard adds nothing when the vault is not armed");
  ok((await resolveLinkSet(ORG, "slack", "U-ERIN", T1))?.id === erinSet, "…the account resolves to its directory-derived set");
  ok(offRun.plan.warnings.length === 0, "…and no suppression warning is emitted");
}

{
  const dupe = (a: "attested" | "asserted" | "email-match", b: "attested" | "asserted" | "email-match"): string => {
    const person: DirectoryPerson = {
      externalId: "00u-dupe",
      displayName: "Dupe",
      accounts: [
        { platform: "slack", nativeId: "U-DUPE", grade: a },
        { platform: "slack", nativeId: "U-DUPE", grade: b },
      ],
      groups: [],
      deprovisioned: false,
    };
    const plan = planDirectorySync({ resolveTenant: RESOLVE_TENANT, provider: "okta", people: [person], current: [], autoConfirm: "off" });
    const step = plan.steps.find((s): s is Extract<typeof s, { kind: "suggest" }> => s.kind === "suggest")!;
    return step.grade;
  };
  ok(dupe("attested", "asserted") === "attested" && dupe("asserted", "attested") === "attested", "grade order: attested BEATS asserted (a provisioning fact beats an IdP statement), whichever arrives first");
  ok(dupe("asserted", "email-match") === "asserted" && dupe("email-match", "asserted") === "asserted", "grade order: asserted BEATS email-match (a statement about THIS platform beats an inference over a shared attribute), whichever arrives first");
  ok(dupe("attested", "email-match") === "attested" && dupe("email-match", "attested") === "attested", "grade order: attested still beats email-match — the pre-existing pair is unchanged");
  ok(dupe("asserted", "asserted") === "asserted", "grade order: a grade compared with itself is itself");

  const dave: DirectoryPerson = {
    externalId: "00u-dave",
    displayName: "Dave",
    accounts: [{ platform: "slack", nativeId: "U-DAVE", grade: "attested" }],
    groups: [],
    deprovisioned: false,
  };
  const daveSet = directoryLinkSetId("okta", "00u-dave");
  let daveNow: DirectoryPerson = dave;
  registerDirectoryProvider(fakeDirectory(() => [daveNow]));

  overrideSettingsForTest({ directory: { autoConfirm: "attested" } });
  ok(directoryAutoConfirm() === "attested", "asserted: the escape really is armed for this block (read from the registered settings, not passed in)");

  const daveRun1 = (await syncDirectoryOrg({ org: ORG }))!;
  ok(daveRun1.applied.confirmed === 1 && (await resolveLinkSet(ORG, "slack", "U-DAVE", T1))?.id === daveSet, "asserted: (setup) Dave's ATTESTED slack account auto-confirms under the armed escape, making him a confirmed member");

  daveNow = {
    ...dave,
    accounts: [
      ...dave.accounts,
      { platform: "github", nativeId: "gh-dave", grade: "asserted" },
      { platform: "linear", nativeId: "lin-dave", grade: "attested" },
    ],
  };
  const daveRun2 = (await syncDirectoryOrg({ org: ORG }))!;
  const assertedSuggest = daveRun2.plan.steps.find((s): s is Extract<typeof s, { kind: "suggest" }> => s.kind === "suggest" && s.nativeId === "gh-dave")!;
  ok(assertedSuggest.grade === "asserted" && assertedSuggest.autoConfirm === false, "🔴 asserted: an ASSERTED mapping is NOT marked auto-confirmable even with directory.autoConfirm \"attested\" — the escape is narrowed to downstream-confirmed facts");
  ok(daveRun2.plan.steps.find((s): s is Extract<typeof s, { kind: "suggest" }> => s.kind === "suggest" && s.nativeId === "lin-dave")!.autoConfirm === true, "asserted: …while the sibling ATTESTED mapping in the very same run still confirms — the narrowing is per-grade, not a blanket off-switch");
  ok((await resolveLinkSet(ORG, "github", "gh-dave", "")) === null, "🔴 asserted: end-to-end, the asserted account resolves to NOTHING — it is waiting for a human");
  ok((await resolveLinkSet(ORG, "linear", "lin-dave", ""))?.id === daveSet, "asserted: …and the attested one resolved immediately");

  const daveRun3 = (await syncDirectoryOrg({ org: ORG }))!;
  const why = daveRun3.plan.steps.find((s) => s.kind === "noop" && s.nativeId === "gh-dave") as Extract<DirectorySyncPlan["steps"][number], { kind: "noop" }>;
  ok(why.why.includes("asserted") && why.why.includes("platform never confirmed"), "asserted: the noop `why` names the grade AND the reason (grade-keyed, not the old binary attested/email-match ternary)");

  const daveStanding = await pendingDirectorySuggestionsFor(ORG, "slack", T1, "U-DAVE");
  ok(!daveStanding.some((s) => s.principal === "github/gh-dave"), "🔴 asserted: a CONFIRMED member of the set cannot ratify somebody's asserted account — an editable IdP field is not proof of control");
  const ownStanding = await pendingDirectorySuggestionsFor(ORG, "github", "", "gh-dave");
  ok(ownStanding.some((s) => s.principal === "github/gh-dave" && s.grade === "asserted"), "asserted: …the account ITSELF sees its own asserted suggestion, to ratify from its own DM (never returned to anyone else)");
  const dmDave = ctxFor({ channelId: "D-DAVE", channelType: "im", principalId: "U-DAVE" });
  await refuses(() => confirmLink.execute({ decision: "confirm", accounts: ["github/gh-dave"] }, dmDave), "nothing of yours", "🔴 asserted: …and confirm_link refuses it by name from Dave's own DM — the read's narrowness is what the tool enforces");
  ok((await resolveLinkSet(ORG, "github", "gh-dave", "")) === null, "🔴 asserted: …and nothing was linked by the attempt");

  overrideSettingsForTest({ directory: { autoConfirm: "off" } });
}

{
  const T2 = "T2";
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadDomains: () => [defineDomain({ name: "eng", reach: [`slack/${T1}/C_ENG`, `slack/${T2}/C_ENG2`] })],
  });

  overrideSettingsForTest({ directory: { autoConfirm: "off" } });

  const twin: DirectoryPerson = {
    externalId: "00u-twin",
    displayName: "Twin Worker",
    accounts: [
      { platform: "slack", tenant: T1, nativeId: "U-TWIN", grade: "attested" },
      { platform: "slack", tenant: T2, nativeId: "U-TWIN", grade: "attested" },
    ],
    groups: [],
    deprovisioned: false,
  };
  registerDirectoryProvider(fakeDirectory(() => [twin]));
  const twinRun = (await syncDirectoryOrg({ org: ORG }))!;
  const suggests = twinRun.plan.steps.filter((s): s is Extract<typeof s, { kind: "suggest" }> => s.kind === "suggest");
  ok(suggests.length === 2, "🔴 OPE-350(a): ONE human with the SAME native id in TWO workspaces produces TWO suggestions — the second is no longer swallowed");
  ok(
    suggests.map((s) => `${s.platform}/${s.tenant}/${s.nativeId}`).sort().join() === `slack/${T1}/U-TWIN,slack/${T2}/U-TWIN`,
    "🔴 OPE-350(a): …and each carries ITS OWN workspace, so the two rows compose two distinct principal keys",
  );
  const twinSet = suggests[0]!.linkSetId;
  ok(suggests.every((s) => s.linkSetId === twinSet), "OPE-350(a): both land in the SAME link-set — it is one human, two accounts, which is the whole point");

  const foreign: DirectoryPerson = {
    externalId: "00u-foreign",
    displayName: "Foreign Worker",
    accounts: [{ platform: "slack", tenant: "T_NEVER_DECLARED", nativeId: "U-FOREIGN", grade: "attested" }],
    groups: [],
    deprovisioned: false,
  };
  registerDirectoryProvider(fakeDirectory(() => [foreign]));
  const foreignRun = (await syncDirectoryOrg({ org: ORG }))!;
  ok(
    foreignRun.plan.steps.every((s) => s.kind === "noop") && foreignRun.applied.suggested === 0,
    "🔴 OPE-350(b): an account claiming an UNADMITTED workspace writes NOTHING — a claim is admission-checked, never believed on the adapter's say-so",
  );
  ok(
    foreignRun.plan.warnings.some((w) => w.includes("cannot name the slack tenant")),
    "🔴 OPE-350(b): …and it is skipped LOUDLY, with the standard unresolvable-workspace sentence an operator can act on",
  );

  const dmTwinT1 = ctxFor({ channelId: "D-TWIN", channelType: "im", principalId: "U-TWIN" });
  const pendingT1 = await pendingDirectorySuggestionsFor(ORG, "slack", T1, "U-TWIN");
  ok(
    pendingT1.length === 1 && pendingT1[0]!.principal === `slack/${T1}/U-TWIN`,
    "🔴 OPE-350(c): the T1 caller's pending set holds ONLY the T1 account — the T2 account is a different account, not a sibling to ratify",
  );
  const confirmedT1 = await confirmLink.execute({ decision: "confirm" }, dmTwinT1);
  ok(confirmedT1.accounts.join() === `slack/${T1}/U-TWIN`, "🔴 OPE-350(c): the tap confirms the T1 account…");
  ok((await resolveLinkSet(ORG, "slack", "U-TWIN", T1))?.id === twinSet, "🔴 OPE-350(c): …which now resolves in T1…");
  ok((await resolveLinkSet(ORG, "slack", "U-TWIN", T2)) === null, "🔴🔴 OPE-350(c): …and the T2 account is STILL UNPROVEN — one challenge proves ONE account, never the platform");
  ok((await expandLinkSet(ORG, twinSet)).length === 1, "🔴 OPE-350(c): …so the set holds exactly one confirmed member, not both");

  const bothPending = await pendingDirectorySuggestionsFor(ORG, "slack", T2, "U-TWIN");
  ok(
    bothPending.length === 1 && bothPending[0]!.principal === `slack/${T2}/U-TWIN`,
    "OPE-350(c): the T2 caller sees the T2 account (its own), and the already-confirmed T1 one is not re-offered",
  );
  const dmTwinT2 = ctxForTenant(T2, { channelId: "D-TWIN2", channelType: "im", principalId: "U-TWIN" });
  const confirmedT2 = await confirmLink.execute({ decision: "confirm" }, dmTwinT2);
  ok(confirmedT2.accounts.join() === `slack/${T2}/U-TWIN`, "🔴 OPE-350(c): the SECOND account needs its own tap, from its own workspace's DM");
  ok((await expandLinkSet(ORG, twinSet)).length === 2, "🔴 OPE-350(c): …and only now does one human hold two same-platform accounts — two proofs, two accounts");

  const pair: DirectoryPerson = {
    externalId: "00u-pair",
    displayName: "Pair Worker",
    accounts: [
      { platform: "slack", tenant: T1, nativeId: "U-PAIR", grade: "attested" },
      { platform: "slack", tenant: T2, nativeId: "U-PAIR", grade: "attested" },
      { platform: "github", nativeId: "gh-pair", grade: "attested" },
    ],
    groups: [],
    deprovisioned: false,
  };
  registerDirectoryProvider(fakeDirectory(() => [pair]));
  const pairRun = (await syncDirectoryOrg({ org: ORG }))!;
  const pairSet = pairRun.plan.steps.find((s): s is Extract<typeof s, { kind: "suggest" }> => s.kind === "suggest")!.linkSetId;
  const dmPairT1 = ctxFor({ channelId: "D-PAIR", channelType: "im", principalId: "U-PAIR" });
  await confirmLink.execute({ decision: "confirm" }, dmPairT1);
  const pairStanding = await pendingDirectorySuggestionsFor(ORG, "slack", T1, "U-PAIR");
  ok(
    pairStanding.map((s) => s.principal).sort().join() === `github/gh-pair,slack/${T2}/U-PAIR`,
    "OPE-350(c): a CONFIRMED T1 member's standing exposes the set's other attested suggestions — including the SAME-PLATFORM T2 one",
  );
  let blanketTwin = "";
  try {
    await confirmLink.execute({ decision: "confirm" }, dmPairT1);
  } catch (e) {
    blanketTwin = e instanceof Error ? e.message : String(e);
  }
  ok(
    blanketTwin.includes("2 accounts are waiting") && blanketTwin.includes(`slack/${T2}/U-PAIR`),
    `🔴 OPE-350(c)/OPE-291: with a SAME-PLATFORM account pending, a bare confirm is still REFUSED and still names it (got: ${blanketTwin || "no error"})`,
  );
  ok((await resolveLinkSet(ORG, "slack", "U-PAIR", T2)) === null, "🔴 OPE-350(c)/OPE-291: …and the refusal is a REFUSAL — the second workspace's account was not batch-confirmed");
  ok((await expandLinkSet(ORG, pairSet)).length === 1, "🔴 OPE-350(c)/OPE-291: …the set still holds only the bootstrap account");
  const namedBoth = await confirmLink.execute({ decision: "confirm", accounts: [`slack/${T2}/U-PAIR`, "github/gh-pair"] }, dmPairT1);
  ok(namedBoth.accounts.length === 2, "OPE-350(c): NAMING both accounts confirms both — the fence is on the blanket yes, not on the count");
  ok((await resolveLinkSet(ORG, "slack", "U-PAIR", T2))?.id === pairSet, "OPE-350(c): …and the T2 account is keyed by ITS OWN workspace, not the confirmer's");

  overrideSettingsForTest({ directory: { autoConfirm: "off" } });
}

{
  const { runDirectorySync } = await import("../agent/identity/directory-sync.js");
  const HEARTBEAT_ORG = "heartbeatco";

  resetDirectoryProvider();
  ok(directoryProvider() === undefined, "heartbeat: starting unarmed — no provider registered");
  ok((await readAudit({ org: HEARTBEAT_ORG, action: DIRECTORY_SYNC_ACTION })).length === 0, "heartbeat: no row yet for this org");

  await runDirectorySync({ orgs: [HEARTBEAT_ORG] });
  const noopRows = await readAudit({ org: HEARTBEAT_ORG, action: DIRECTORY_SYNC_ACTION });
  ok(noopRows.length === 1, "🔴 OPE-635: an UNARMED runDirectorySync() still writes exactly one row — the cron's silence is now a row, not nothing");
  ok(noopRows[0]!.detail?.["outcome"] === "no-op: no provider configured", "🔴 OPE-635: …and the row names the outcome exactly, so a reader never has to infer 'never armed' from an absent row");

  const noopStatus = await lastDirectorySync(HEARTBEAT_ORG);
  ok(noopStatus?.detail["outcome"] === "no-op: no provider configured", "heartbeat: lastDirectorySync (the same read directory_sync_status and a future census use) sees the no-op outcome");

  const armedPeople: readonly DirectoryPerson[] = [rowan({ externalId: "00u-heartbeat", accounts: [{ platform: "slack", nativeId: "U-HEARTBEAT", grade: "attested" }] })];
  registerDirectoryProvider(fakeDirectory(() => armedPeople));
  await runDirectorySync({ orgs: [HEARTBEAT_ORG] });
  const armedRows = await readAudit({ org: HEARTBEAT_ORG, action: DIRECTORY_SYNC_ACTION });
  ok(armedRows.length === 2, "heartbeat: arming and re-running adds a SECOND row (one per run) rather than replacing the first");
  ok(armedRows[0]!.detail?.["outcome"] === "synced", "🔴 OPE-635: an ARMED run's row carries outcome:\"synced\" — the positive control for the no-op assertion above");

  registerDirectoryProvider(
    fakeDirectory(() => {
      throw new Error("okta unreachable");
    }),
  );
  await runDirectorySync({ orgs: [HEARTBEAT_ORG] });
  const failedRows = await readAudit({ org: HEARTBEAT_ORG, action: DIRECTORY_SYNC_ACTION });
  ok(failedRows.length === 3, "heartbeat: a throwing provider still leaves a row behind");
  ok(
    typeof failedRows[0]!.detail?.["outcome"] === "string" && (failedRows[0]!.detail!["outcome"] as string).startsWith("failed:") && (failedRows[0]!.detail!["outcome"] as string).includes("okta unreachable"),
    "🔴 OPE-635: a per-org sync failure is named in the row (\"failed: …\"), not swallowed into a log line only",
  );

  resetDirectoryProvider();
}

{
  const { runDirectorySync } = await import("../agent/identity/directory-sync.js");
  resetDirectoryProvider();
  overrideSettingsForTest({ schedules: { sweepOrgs: ["sweep-org-a", "sweep-org-b"] } });
  process.env.OE_TIDY_ORGS = "sweep-org-env";
  await runDirectorySync();
  delete process.env.OE_TIDY_ORGS;
  ok((await readAudit({ org: "sweep-org-a", action: DIRECTORY_SYNC_ACTION })).length === 1, "sweep orgs: the sync covers the FIRST declared org");
  ok((await readAudit({ org: "sweep-org-b", action: DIRECTORY_SYNC_ACTION })).length === 1, "sweep orgs: …and the SECOND");
  ok((await readAudit({ org: "sweep-org-env", action: DIRECTORY_SYNC_ACTION })).length === 0, "🔴 sweep orgs: the retired OE_TIDY_ORGS adds no org");
  overrideSettingsForTest({ schedules: { sweepOrgs: ["default"] } });

  const { tidyOrgs } = await import("../agent/schedules/tidy.js");
  overrideSettingsForTest({ schedules: { sweepOrgs: ["acme", "globex"] } });
  ok(JSON.stringify(tidyOrgs()) === JSON.stringify(["acme", "globex"]), "sweep orgs: the tidy sweep reads the SAME setting — one answer to 'which orgs'");
  overrideSettingsForTest({ schedules: { sweepOrgs: ["default"] } });
  ok(JSON.stringify(tidyOrgs()) === JSON.stringify(["default"]), "sweep orgs: …and the shipped answer is the single-operator org");
}

resetDirectoryProvider();
console.log(`✓ directory-sync-test: ${n} assertions passed`);

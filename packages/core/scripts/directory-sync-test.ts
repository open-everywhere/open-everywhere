process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "postgres";

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { registerOperationalStore, resetOperationalStore } from "../agent/operational/provider.js";
import {
  DIRECTORY_SYNC_ACTION,
  OE_DIRECTORY_AUTOCONFIRM_ENV,
  directoryAutoConfirm,
  directoryLinkSetId,
  lastDirectorySync,
  pendingDirectorySuggestionsFor,
  planDirectorySync,
  planIsNoop,
  syncDirectoryOrg,
  type DirectorySyncPlan,
} from "../agent/identity/directory-sync.js";
import { directoryProvider, registerDirectoryProvider, resetDirectoryProvider, type DirectoryPerson, type DirectoryProvider } from "../agent/identity/directory.js";
import {
  confirmedLinkSetPrincipals,
  expandLinkSet,
  listLinkSetsWithIds,
  resolveLinkSet,
  revokeLinkSet,
  setLinkSetHold,
} from "../agent/identity/link-store.js";
import { readAudit } from "../agent/audit/audit.js";
import type { BindableContext } from "../agent/identity/binding.js";
import confirmLinkTool from "../agent/tools/confirm_link.js";
import linkIdentityTool from "../agent/tools/link_identity.js";
import { observeLinkClaim } from "../agent/hooks/link-claim.js";
import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";

registerSlackFixtureMapper();

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
  ok(directoryAutoConfirm({}) === "off", "policy: unset ⇒ off — every suggestion waits for its human");
  ok(directoryAutoConfirm({ [OE_DIRECTORY_AUTOCONFIRM_ENV]: "" }) === "off", "policy: empty ⇒ off");
  ok(directoryAutoConfirm({ [OE_DIRECTORY_AUTOCONFIRM_ENV]: " ATTESTED " }) === "attested", "policy: trimmed + case-insensitive \"attested\" arms the single escape");
  ok(directoryAutoConfirm({ [OE_DIRECTORY_AUTOCONFIRM_ENV]: "off" }) === "off", "policy: explicit \"off\" is off");
  let threw = "";
  try {
    directoryAutoConfirm({ [OE_DIRECTORY_AUTOCONFIRM_ENV]: "atested" });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  ok(threw.includes("is not a policy"), "policy: FAIL-LOUD on a typo — a security knob that silently resolves safe is still a deployment lying to its operator");
  ok(threw.includes("attested") && threw.includes("off"), "policy: …and the throw names both valid values");
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

  ok((await resolveLinkSet(ORG, "github", "gh-rowan")) === null, "🔴 a suggestion resolves to NOTHING — the IdP has not linked anybody");
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
  const attributes: Record<string, string> = { team_id: "T1", channel_id: opts.channelId, trust_checked: "true" };
  if (opts.channelType) attributes.channel_type = opts.channelType;
  return {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes, principalId: opts.principalId ?? "U1", principalType: "slack-user" } } },
  } as BindableContext;
}
const dmRowan = ctxFor({ channelId: "D-ROWAN", channelType: "im", principalId: "U-ROWAN" });
const dmStranger = ctxFor({ channelId: "D-NOPE", channelType: "im", principalId: "U-STRANGER" });
const channelRowan = ctxFor({ channelId: "C1", principalId: "U-ROWAN" });

{
  const mine = await pendingDirectorySuggestionsFor(ORG, "slack", "U-ROWAN");
  ok(mine.length === 3, "read: the person's OWN suggestions are visible from the account the IdP put in their set");
  ok(mine.every((s) => s.provider === "okta" && s.grade === "attested"), "read: each carries the proposing provider and its grade");
  ok((await pendingDirectorySuggestionsFor(ORG, "slack", "U-STRANGER")).length === 0, "🔴 read: a stranger's query finds NOTHING — somebody else's suggestions are structurally unavailable, not merely refused");

  await refuses(() => confirmLink.execute({ decision: "confirm" }, channelRowan), "DM-only", "confirm_link still refuses outside a DM on the directory path");
  await refuses(() => confirmLink.execute({ decision: "confirm" }, dmStranger), "nothing of yours", "🔴 a stranger cannot confirm somebody else's directory suggestions");

  const denied = await confirmLink.execute({ decision: "deny" }, dmRowan);
  ok(denied.decided === "denied", "deny works on the directory path");
  ok((await resolveLinkSet(ORG, "github", "gh-rowan")) === null, "🔴 …and a deny writes NOTHING — the account still has no standing");
  ok(denied.note.includes("unlink_identity"), "…and names the verb that actually removes an account, so \"I said no\" and \"make it go away\" stay distinct acts");

  const partial = await confirmLink.execute({ decision: "confirm", accounts: ["github/gh-rowan"] }, dmRowan);
  ok(partial.decided === "confirmed" && partial.accounts.join() === "github/gh-rowan", "a person may confirm ONE named suggestion rather than the whole batch");
  ok((await resolveLinkSet(ORG, "github", "gh-rowan"))?.id === setId, "…and that account now resolves to their link-set");
  ok((await resolveLinkSet(ORG, "linear", "lin-rowan")) === null, "…while the un-named one still does not");

  const rest = await confirmLink.execute({ decision: "confirm" }, dmRowan);
  ok(rest.accounts.sort().join() === "linear/lin-rowan,slack/U-ROWAN", "omitting `accounts` confirms every remaining suggestion — the one-tap case");
  ok((await expandLinkSet(ORG, setId)).length === 3, "…so all three accounts are now confirmed members of the set");

  const row = (await listLinkSetsWithIds(ORG)).find((r) => r.set.id === setId)!.ids.find((r) => r.platform === "github")!;
  ok(
    row.establishedBy === "challenge:dm-confirm:slack/U-ROWAN",
    "🔴 the DM tap is recorded as the degenerate CHALLENGE it is, naming the account that answered — the trust anchor stays uniform",
  );

  await refuses(() => confirmLink.execute({ decision: "confirm" }, dmRowan), "nothing of yours", "with everything confirmed, there is nothing left to decide");
  await refuses(() => confirmLink.execute({ decision: "confirm", accounts: ["github/gh-rowan"] }, dmRowan), "nothing of yours", "…and an already-confirmed account is not re-offered");
}

{
  const dmAda = ctxFor({ channelId: "D-ADA", channelType: "im", principalId: "U-ADA" });
  const issued = await linkIdentity.execute({}, dmAda);
  await observeLinkClaim({
    org: ORG,
    platform: "github",
    authorId: "gh-ada",
    text: `link ${/link ([A-Z0-9]{8})/u.exec(String(issued.instructions))![1]}`,
  });
  const ratified = await confirmLink.execute({ decision: "confirm" }, dmAda);
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
  ok((await resolveLinkSet(ORG, "github", "gh-ada"))?.id === adaSet, "🔴 …it still resolves — absence from the IdP is not evidence of non-ownership");
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

  const off = planDirectorySync({ provider: "okta", people: [carol], current: [], autoConfirm: "off" });
  ok(off.counts.suggest === 2 && off.counts.confirm === 0, "planner (off): both accounts suggested, neither confirmed");
  ok(off.steps.every((s) => s.kind !== "suggest" || !s.autoConfirm), "planner (off): no suggestion is marked auto-confirmable");

  const armed = planDirectorySync({ provider: "okta", people: [carol], current: [], autoConfirm: "attested" });
  const armedSuggests = armed.steps.filter((s): s is Extract<typeof s, { kind: "suggest" }> => s.kind === "suggest");
  ok(armedSuggests.find((s) => s.nativeId === "U-CAROL")!.autoConfirm === true, "planner (attested): an ATTESTED mapping may skip the DM tap");
  ok(armedSuggests.find((s) => s.nativeId === "lin-carol")!.autoConfirm === false, "🔴 planner (attested): an EMAIL-MATCH mapping never may — the escape is narrowed to provisioning facts");

  registerDirectoryProvider(fakeDirectory(() => [carol]));
  const run = (await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!;
  ok(run.applied.suggested === 2 && run.applied.confirmed === 1, "runner (attested): both rows written, exactly one confirmed");
  ok((await resolveLinkSet(ORG, "slack", "U-CAROL"))?.id === carolSet, "runner (attested): the attested account resolves immediately");
  ok((await resolveLinkSet(ORG, "linear", "lin-carol")) === null, "🔴 runner (attested): the email-match account still waits for Carol");
  const confirmedRow = (await listLinkSetsWithIds(ORG)).find((r) => r.set.id === carolSet)!.ids.find((r) => r.platform === "slack")!;
  ok(
    confirmedRow.establishedBy === "directory-sync:okta" && JSON.parse(confirmedRow.evidenceJson ?? "{}").grade === "attested",
    "runner (attested): the evidence recorded is the ATTESTATION — the thing that actually convinced the system",
  );
  ok(planIsNoop((await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!.plan), "runner (attested): still idempotent on the second pass");

  const dmCarol = ctxFor({ channelId: "D-CAROL", channelType: "im", principalId: "U-CAROL" });
  const res = await confirmLink.execute({ decision: "confirm" }, dmCarol);
  ok(res.accounts.join() === "linear/lin-carol", "the email-match suggestion is confirmable the ordinary way — by its person, in their DM");
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
  ok((await resolveLinkSet(ORG, "slack", "U-CAROL")) === null, "…so attribution degrades to per-surface identity immediately");
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
  const plan = planDirectorySync({ provider: "okta", people: [greedy], current: state, autoConfirm: "attested" });
  ok(planIsNoop(plan), "🔴 conflict: a directory person spanning TWO link-sets is a whole-person NO-OP — the merge is refused, not guessed at");
  ok(plan.warnings.some((w) => w.includes(rowanSet.set.id) && w.includes(adaSet.set.id)), "…and the warning NAMES both sets so an admin can decide");
  ok(plan.warnings.some((w) => w.includes("An account is exactly one person")), "…and states the invariant it is protecting");
  ok(!plan.steps.some((s) => s.kind === "suggest"), "…and the brand-new third account is NOT quietly linked on the way past");

  registerDirectoryProvider(fakeDirectory(() => [greedy]));
  const run = (await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!;
  ok(run.applied.suggested === 0 && run.applied.confirmed === 0, "…and the runner writes nothing at all");
  ok((await lastDirectorySync(ORG))!.detail.warnings !== undefined, "…while the summary row carries the warnings for directory_sync_status to surface");

  const twin = planDirectorySync({
    provider: "okta",
    people: [
      { externalId: "00u-a", displayName: "A", accounts: [{ platform: "slack", nativeId: "U-SHARED", grade: "attested" }], groups: [], deprovisioned: false },
      { externalId: "00u-b", displayName: "B", accounts: [{ platform: "slack", nativeId: "U-SHARED", grade: "attested" }], groups: [], deprovisioned: false },
    ],
    current: [],
    autoConfirm: "attested",
  });
  ok(planIsNoop(twin), "🔴 conflict: one account claimed by TWO directory records links to neither");
  ok(twin.warnings.filter((w) => w.includes("slack/U-SHARED")).length === 2, "…warned for both records, so the duplicate is visible from either end");
  ok(twin.warnings.some((w) => w.includes("Fix the duplicate in the IdP")), "…and the warning says where the fix belongs");
}

{
  const none = planDirectorySync({
    provider: "okta",
    people: [{ externalId: "00u-empty", displayName: "No Apps", accounts: [], groups: ["Everyone"], deprovisioned: false }],
    current: [],
    autoConfirm: "attested",
  });
  ok(planIsNoop(none), "a person the directory maps no accounts for is a no-op — no empty set is minted for them");

  const goneUnknown = planDirectorySync({
    provider: "okta",
    people: [{ externalId: "00u-ghost", displayName: "Ghost", accounts: [{ platform: "slack", nativeId: "U-GHOST", grade: "attested" }], groups: [], deprovisioned: true }],
    current: [],
    autoConfirm: "attested",
  });
  ok(planIsNoop(goneUnknown), "🔴 a DEPROVISIONED person we hold no link-set for gets NO set created — a sync never onboards somebody the IdP already deactivated");

  const dup = planDirectorySync({
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
  registerDirectoryProvider(fakeDirectory(() => [dan]));
  await syncDirectoryOrg({ org: ORG, autoConfirm: "off" });
  ok((await pendingDirectorySuggestionsFor(ORG, "slack", "U-DAN")).length === 2, "setup: Dan has two directory suggestions waiting");

  const dmDan = ctxFor({ channelId: "D-DAN", channelType: "im", principalId: "U-DAN" });
  const issued = await linkIdentity.execute({}, dmDan);
  await observeLinkClaim({ org: ORG, platform: "github", authorId: "gh-dan", text: `link ${/link ([A-Z0-9]{8})/u.exec(String(issued.instructions))![1]}` });

  const decided = await confirmLink.execute({ decision: "confirm" }, dmDan);
  ok(
    decided.claimant === "github/gh-dan",
    "🔴 with BOTH a claimed code and directory suggestions waiting, the CHALLENGE wins — a time-boxed claim must never be shadowed by a standing proposal",
  );
  ok(decided.accounts === undefined, "…and the directory batch was not swept up in the same call");

  const danSet = directoryLinkSetId("okta", "00u-dan");
  ok(decided.linkSetId === danSet, "the challenge lands in the SAME set the directory built — one human, one set, whichever mechanism got there first");
  ok((await resolveLinkSet(ORG, "github", "gh-dan"))?.id === danSet, "…and the challenge-proven account resolves there");
  const stillPending = await pendingDirectorySuggestionsFor(ORG, "slack", "U-DAN");
  ok(stillPending.length === 1 && stillPending[0]!.principal === "linear/lin-dan", "…while the directory suggestion he did NOT decide is still waiting, untouched");

  const next = (await syncDirectoryOrg({ org: ORG, autoConfirm: "attested" }))!;
  ok(next.plan.warnings.length === 0, "…and the next sync sees no ambiguity at all");
  ok(next.applied.confirmed === 1 && (await resolveLinkSet(ORG, "linear", "lin-dan"))?.id === danSet, "…it simply finishes the attested mapping under policy");
  ok(
    next.plan.steps.some((s) => s.kind === "noop" && s.nativeId === "U-DAN" && (s as { why: string }).why === "already confirmed"),
    "…and leaves the challenge-established row alone (rule 3), even though the directory names that account too",
  );
}

resetDirectoryProvider();
console.log(`✓ directory-sync-test: ${n} assertions passed`);

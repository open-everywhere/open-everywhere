process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "postgres";

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { registerOperationalStore, resetOperationalStore } from "../agent/operational/provider.js";
import {
  confirmLinkedId,
  ensureLinkSet,
  revokeLinkSet,
  setLinkSetHold,
  suggestLinkedId,
} from "../agent/identity/link-store.js";
import { callerLinkSets } from "../agent/access/group-request.js";
import { roleForBinding, adminControlRoles } from "../agent/access/roles.js";
import { wakeAuthorIsAdmin } from "../agent/identity/wake-trust.js";
import { resolveAccess, type ResolveRequest } from "../agent/access/resolver.js";
import { assertBindingsValid, type Binding, type Bundle } from "../agent/access/bundle.js";
import { assertDomainsValid, defineDomain, type Domain } from "../agent/memory/domain.js";
import { assertGroupsValid, type Group } from "../agent/identity/groups.js";
import { groupsForPrincipal } from "../agent/identity/groups.js";
import { principalKey } from "../agent/identity/principal-key.js";
import {
  isLinkSetRef,
  isValidLinkSetRef,
  parseLinkSetRef,
  rosterHasLinkSet,
} from "../agent/identity/link-set-ref.js";
import { accessReferencedLinkSets } from "../agent/access/access-referenced-link-sets.js";
import { directoryLinkSetId, planDirectorySync } from "../agent/identity/directory-sync.js";
import type { DirectoryPerson } from "../agent/identity/directory.js";
import type { SurfaceBinding } from "../agent/identity/binding.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throwsWith(fn: () => void, fragment: string, label: string): void {
  try {
    fn();
  } catch (err) {
    ok(String(err).includes(fragment), `${label} (got: ${String(err).slice(0, 200)})`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

{
  ok(isLinkSetRef("linkSet:abc") && !isLinkSetRef("slack/U1"), "isLinkSetRef tests the prefix; a principal key is not a ref");
  ok(parseLinkSetRef("linkSet:9f3c") === "9f3c", "parseLinkSetRef returns the id");
  ok(parseLinkSetRef("linkSet:") === undefined, "an empty id is not a well-formed ref");
  ok(parseLinkSetRef("linkSet:a/b") === undefined, "🔴 a '/' in the id is refused — that is what keeps a ref disjoint from a principal key");
  ok(parseLinkSetRef("slack/U1") === undefined && parseLinkSetRef("linkset:x") === undefined, "a principal key and a wrong-case prefix are not refs");
  ok(isValidLinkSetRef("linkSet:set-a") && !isValidLinkSetRef("nope"), "isValidLinkSetRef is the config-load test");
  ok(rosterHasLinkSet(["slack/U1", "linkSet:set-a"], ["set-a"]), "rosterHasLinkSet: a matching entry admits");
  ok(!rosterHasLinkSet(["slack/U1", "linkSet:set-a"], []), "rosterHasLinkSet: no caller sets → no match (fail-closed)");
  ok(!rosterHasLinkSet(["slack/U1"], ["set-a"]), "rosterHasLinkSet: a principal-key-only roster never matches a link-set");
}

{
  assertDomainsValid([defineDomain({ name: "org", match: "org", admins: ["slack/U1", "linkSet:set-a"] })]);
  ok(true, "assertDomainsValid accepts a link-set admin entry alongside a principal key");
  throwsWith(() => assertDomainsValid([defineDomain({ name: "org", match: "org", admins: ["U1"] })]), "link-set reference", "a BARE admin entry (neither key nor ref) throws loud");
  throwsWith(() => assertDomainsValid([defineDomain({ name: "org", match: "org", admins: ["linkSet:"] })]), "link-set reference", "an EMPTY link-set ref admin entry throws loud (malformed shape)");
  throwsWith(() => assertDomainsValid([defineDomain({ name: "org", match: "org", admins: ["linkset:x"] })]), "link-set reference", "a wrong-case prefix is not a ref and throws");

  const bundles: Bundle[] = [{ name: "b", repos: ["acme/x"] }];
  assertBindingsValid([{ bundle: "b", scope: { level: "principal", principal: "linkSet:set-a" } }], bundles);
  ok(true, "assertBindingsValid accepts a link-set principal binding");
  throwsWith(() => assertBindingsValid([{ bundle: "b", scope: { level: "principal", principal: "U1" } }], bundles), "link-set reference", "a BARE principal binding throws loud");
  throwsWith(() => assertBindingsValid([{ bundle: "b", scope: { level: "principal", principal: "linkSet:" } }], bundles), "link-set reference", "an empty link-set ref principal binding throws loud");
}

{
  const domains: Domain[] = [defineDomain({ name: "org", match: "org", admins: ["slack/U1", "linkSet:set-admin"] })];
  const bindings: Binding[] = [
    { bundle: "b", scope: { level: "principal", principal: "linkSet:set-binding" } },
    { bundle: "b", scope: { level: "principal", principal: "slack/U1" } },
  ];
  const groups: Group[] = [{ name: "g", members: ["slack/U1", { linkSet: "set-group" }] }];
  const refd = accessReferencedLinkSets({ domains, bindings, groups });
  assert.deepEqual([...refd].sort(), ["set-admin", "set-binding", "set-group"]);
  passed++;
  ok(!refd.has("slack/U1"), "an exact principal binding / principal-key group member is NOT an access-referenced link-set (only link-set ids are the widening vector)");
}

const ORG = "default";
const db = new PGlite();
const client: PgClient = { query: (text, params) => db.query(text, params ? [...params] : undefined) };
await initOperationalSchema(client);
registerOperationalStore(makeOperationalPostgresStore(client));

const evidence = { kind: "directory-sync", provider: "okta", grade: "attested" } as const;
const bind = (over: Partial<SurfaceBinding> = {}): SurfaceBinding => ({
  org: ORG,
  platform: "slack",
  workspace: "T1",
  surface: "C1",
  mode: "channel",
  visibility: "public",
  trust: "internal",
  ...over,
});

await ensureLinkSet({ org: ORG, linkSetId: "set-admin", handle: "rowan" });
for (const acct of [{ platform: "slack", nativeId: "U1" }, { platform: "discord", nativeId: "D1" }]) {
  await suggestLinkedId({ org: ORG, linkSetId: "set-admin", account: acct, evidence });
  await confirmLinkedId({ org: ORG, account: acct, evidence });
}
await suggestLinkedId({ org: ORG, linkSetId: "set-admin", account: { platform: "teams", nativeId: "T1" }, evidence });

const ADMIN_DOMAINS: Domain[] = [
  defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["linkSet:set-admin"] }),
];
{
  const u1Sets = await callerLinkSets(ORG, "slack", "U1");
  ok(u1Sets.length === 1 && u1Sets[0] === "set-admin", "callerLinkSets resolves a confirmed member to their active set");
  ok(roleForBinding(bind({ principalId: "U1" }), ADMIN_DOMAINS, u1Sets).isOrgAdmin, "a CONFIRMED member of the referenced link-set is an admin (roleForBinding)");
  ok(adminControlRoles("U1", ADMIN_DOMAINS, "slack", u1Sets).join(",") === "admin", "…and the cross-domain scan (adminControlRoles) agrees");
  ok(wakeAuthorIsAdmin("U1", "slack/T1/C_ANY", ADMIN_DOMAINS, u1Sets), "…and the wake pipeline matcher agrees");

  const d1Sets = await callerLinkSets(ORG, "discord", "D1");
  ok(roleForBinding(bind({ platform: "discord", principalId: "D1" }), ADMIN_DOMAINS, d1Sets).isOrgAdmin, "a link-set admin entry covers the human on EVERY confirmed account (discord too)");

  const t1Sets = await callerLinkSets(ORG, "teams", "T1");
  ok(t1Sets.length === 0, "🔴 a SUGGESTED account resolves to no set — a directory proposal is not membership");
  ok(!roleForBinding(bind({ platform: "teams", principalId: "T1" }), ADMIN_DOMAINS, t1Sets).isOrgAdmin, "a suggested member is NOT an admin (threat (a))");

  const strangerSets = await callerLinkSets(ORG, "slack", "U-stranger");
  ok(!roleForBinding(bind({ principalId: "U-stranger" }), ADMIN_DOMAINS, strangerSets).isOrgAdmin, "a non-member is not an admin");

  await setLinkSetHold({ org: ORG, linkSetId: "set-admin", hold: "suspended", actor: "test" });
  ok((await callerLinkSets(ORG, "slack", "U1")).length === 0, "a SUSPENDED set resolves to no membership — admin standing drops eagerly");
  ok(!roleForBinding(bind({ principalId: "U1" }), ADMIN_DOMAINS, await callerLinkSets(ORG, "slack", "U1")).isOrgAdmin, "…so a member of a suspended set is not an admin");
  await setLinkSetHold({ org: ORG, linkSetId: "set-admin", hold: "active", actor: "test" });
  ok(roleForBinding(bind({ principalId: "U1" }), ADMIN_DOMAINS, await callerLinkSets(ORG, "slack", "U1")).isOrgAdmin, "reactivating restores standing");
}

{
  const bundles: Bundle[] = [{ name: "personal", repos: ["acme/personal"] }];
  const bindings: Binding[] = [{ bundle: "personal", scope: { level: "principal", principal: "linkSet:set-admin" } }];
  const dm = async (platform: string, id: string): Promise<ResolveRequest> => ({
    mode: "dm",
    platform,
    workspace: "W",
    channel: "D",
    principalId: id,
    principalLinkSets: await callerLinkSets(ORG, platform, id),
  });
  ok(resolveAccess(await dm("slack", "U1"), bundles, bindings).repos.includes("acme/personal"), "a link-set principal binding grants in a confirmed member's DM");
  ok(resolveAccess(await dm("discord", "D1"), bundles, bindings).repos.includes("acme/personal"), "…in EVERY confirmed account's DM");
  ok(resolveAccess(await dm("teams", "T1"), bundles, bindings).repos.length === 0, "…but NOT in a suggested-only account's DM (threat (a))");
  ok(resolveAccess(await dm("slack", "U-stranger"), bundles, bindings).repos.length === 0, "…and not for a non-member");
  ok(resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel: "C1", principalId: "U1", principalLinkSets: ["set-admin"] }, bundles, bindings).repos.length === 0, "a link-set principal binding contributes NOTHING in a channel (two universes)");
}

{
  const groups: Group[] = [{ name: "payments", members: [{ linkSet: "set-admin" }] }];
  assertGroupsValid(groups);
  const bundles: Bundle[] = [{ name: "team", repos: ["acme/team"] }];
  const bindings: Binding[] = [{ bundle: "team", scope: { level: "group", group: "payments" } }];
  const dmGroups = async (platform: string, id: string): Promise<ResolveRequest> => {
    const sets = await callerLinkSets(ORG, platform, id);
    return { mode: "dm", platform, workspace: "W", channel: "D", principalId: id, groups: groupsForPrincipal(groups, principalKey(platform, id), sets) };
  };
  ok(resolveAccess(await dmGroups("slack", "U1"), bundles, bindings).repos.includes("acme/team"), "a { linkSet } group member RECEIVES the group bundle in their DM (F4 live — the assertion that was impossible before)");
  ok(resolveAccess(await dmGroups("teams", "T1"), bundles, bindings).repos.length === 0, "a suggested member gets nothing from the group (confirmed-only)");
}

{
  const throwingStore = new Proxy({ id: "postgres" } as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "id") return "postgres";
      return () => {
        throw new Error("simulated operational store outage");
      };
    },
  }) as unknown as ReturnType<typeof makeOperationalPostgresStore>;
  registerOperationalStore(throwingStore);
  resetOperationalStore();
  const sets = await callerLinkSets(ORG, "slack", "U1");
  ok(sets.length === 0, "🔴 a store outage yields [] — callerLinkSets is try/caught, never throws up the turn");
  ok(!roleForBinding(bind({ principalId: "U1" }), ADMIN_DOMAINS, sets).isOrgAdmin, "…and [] reads as NOT an admin (never fail-open to 'is admin')");
  registerOperationalStore(makeOperationalPostgresStore(client));
  resetOperationalStore();
}

resetOperationalStore();
await db.close();

{
  const PROVIDER = "okta";
  const carolSet = directoryLinkSetId(PROVIDER, "carol");
  const carol: DirectoryPerson = {
    externalId: "carol",
    displayName: "Carol",
    accounts: [{ platform: "slack", nativeId: "U-CAROL", grade: "attested" }],
    groups: [],
    deprovisioned: false,
  };

  const open = planDirectorySync({ provider: PROVIDER, people: [carol], current: [], autoConfirm: "attested" });
  ok(open.steps.some((s) => s.kind === "suggest" && s.autoConfirm === true), "planner (attested, unreferenced): the attested mapping is auto-confirmable");

  const guarded = planDirectorySync({ provider: PROVIDER, people: [carol], current: [], autoConfirm: "attested", accessReferencedSets: new Set([carolSet]) });
  ok(guarded.steps.every((s) => s.kind !== "suggest" || s.autoConfirm === false), "🔴 an attested auto-confirm into an ACCESS-REFERENCED set is SUPPRESSED — it lands as a plain suggestion awaiting the person's DM tap");
  ok(guarded.steps.every((s) => s.kind !== "confirm"), "…and no confirm step is emitted for the referenced set");
  ok(guarded.warnings.some((w) => w.includes("SUPPRESSED") && w.includes(carolSet)), "…with a loud warning naming the set and why (C2.4)");

  ok(accessReferencedLinkSets({ domains: [defineDomain({ name: "org", match: "org", admins: [`linkSet:${carolSet}`] })] }).has(carolSet), "the admin roster naming the derived set is what the guard reads — a directory addition cannot widen it without proof-of-control");
}

console.log(`✓ c2-linkset-access: ${passed} assertions passed`);

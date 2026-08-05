process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "postgres";

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { registerOperationalStore, resetOperationalStore } from "../agent/operational/provider.js";
import {
  DIRECTORY_GROUP_PREFIX,
  assertGroupsValid,
  assertReservedGroupNamespace,
  defineGroup,
  directoryGroupName,
  groupLinkSets,
  groupPrincipalKeys,
  groupsForPrincipal,
  isDirectoryGroupName,
  isLinkSetMember,
  type Group,
} from "../agent/identity/groups.js";
import { assertBindingsValid, type Binding, type Bundle } from "../agent/access/bundle.js";
import { resolveAccess, type ResolveRequest } from "../agent/access/resolver.js";
import { GROUP_BROAD_MEMBERS, lintBroadGrants } from "../agent/access/lint.js";
import {
  GroupsCodemodError,
  directoryGroupsOf,
  emitGroupsModule,
  emptyGroupsFile,
  parseGroupsFile,
  parseGroupsModule,
  renormalizeGroupsModule,
  stringifyGroups,
  type GroupsFile,
} from "../agent/identity/groups-codemod.js";
import { groupPlanIsNoop, planDirectoryGroups, planOverlayContent, renderGroupPlan } from "../agent/identity/group-sync.js";
import { directoryLinkSetId } from "../agent/identity/directory-sync.js";
import type { DirectoryPerson } from "../agent/identity/directory.js";
import { callerLinkSets, withLinkSetGroups } from "../agent/access/group-request.js";
import { confirmLinkedId, ensureLinkSet, expandLinkSet, setLinkSetHold, suggestLinkedId } from "../agent/identity/link-store.js";
import { principalKey } from "../agent/identity/principal-key.js";

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
  const good: Group[] = [
    defineGroup({ name: "payments", title: "Payments", members: ["slack/U1", { linkSet: "set-a" }] }),
    defineGroup({ name: "platform", members: ["slack/U1", "discord/2222"] }),
  ];
  assertGroupsValid(good);
  ok(true, "a valid group registry passes assertGroupsValid");
  ok(groupLinkSets(good[0]!).length === 1 && groupPrincipalKeys(good[0]!).length === 1, "the two member kinds are separable");
  ok(isLinkSetMember({ linkSet: "x" }) && !isLinkSetMember("slack/U1"), "isLinkSetMember discriminates on shape");
  ok(true, "the SAME principal may be in two groups — overlapping membership is not an error");

  throwsWith(
    () => assertGroupsValid([{ name: "g", members: ["U0EXOWNER"] }]),
    "PLATFORM-QUALIFIED",
    "a BARE, unqualified string member throws",
  );
  throwsWith(() => assertGroupsValid([{ name: "g", members: [] }]), "no members", "an empty group throws");
  throwsWith(() => assertGroupsValid([{ name: "", members: ["slack/U1"] }]), "empty name", "an empty group name throws");
  throwsWith(
    () => assertGroupsValid([{ name: "g", members: ["slack/U1"] }, { name: "g", members: ["slack/U2"] }]),
    "more than once",
    "a duplicate group name throws",
  );
  throwsWith(
    () => assertGroupsValid([{ name: "g", members: ["slack/U1", "slack/U1"] }]),
    "more than once",
    "a duplicate principal-key member is flagged",
  );
  throwsWith(
    () => assertGroupsValid([{ name: "g", members: [{ linkSet: "a" }, { linkSet: "a" }] }]),
    "more than once",
    "a duplicate link-set member is flagged",
  );
  throwsWith(
    () => assertGroupsValid([{ name: "g", members: [{ linkSet: "  " }] }]),
    "empty `linkSet`",
    "an empty link-set id throws",
  );
  try {
    assertGroupsValid([{ name: "g", members: ["nope"] }, { name: "h", members: [] }]);
    ok(false, "multi-problem registry should throw");
  } catch (err) {
    ok(String(err).includes("nope") && String(err).includes("no members"), "assertGroupsValid lists EVERY problem, not just the first");
  }
}

{
  ok(directoryGroupName("Engineering Team") === `${DIRECTORY_GROUP_PREFIX}Engineering Team`, "the IdP group name rides through verbatim (spaces included)");
  ok(isDirectoryGroupName("directory:x") && !isDirectoryGroupName("payments"), "isDirectoryGroupName tests the reserved prefix");
  assertReservedGroupNamespace([{ name: "payments", members: ["slack/U1"] }]);
  ok(true, "a hand-written group outside the namespace is fine");
  throwsWith(
    () => assertReservedGroupNamespace([{ name: "directory:Engineering", members: ["slack/U1"] }]),
    "reserved",
    "a HAND-WRITTEN group in the directory: namespace throws — synced names can never collide with hand-written ones",
  );
}

{
  const groups: Group[] = [
    { name: "a", members: ["slack/U1"] },
    { name: "b", members: [{ linkSet: "set-1" }] },
    { name: "c", members: ["discord/9"] },
  ];
  assert.deepEqual(groupsForPrincipal(groups, "slack/U1"), ["a"]);
  assert.deepEqual(groupsForPrincipal(groups, "slack/U1", ["set-1"]), ["a", "b"]);
  assert.deepEqual(groupsForPrincipal(groups, undefined, ["set-1"]), []);
  passed += 3;
  ok(true, "no caller key ⇒ NO groups (fail-closed), never every group");
}

{
  const bundles: Bundle[] = [{ name: "basket", repos: ["acme/web"] }];
  const groups: Group[] = [{ name: "payments", members: ["slack/U1"] }];
  assertBindingsValid([{ bundle: "basket", scope: { level: "group", group: "payments" } }], bundles, groups);
  ok(true, "a group binding naming a declared group passes merged validation");
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "group", group: "ghost" } }], bundles, groups),
    "not a declared person-group",
    "a binding naming an UNKNOWN group throws at merged load",
  );
  assertBindingsValid([{ bundle: "basket", scope: { level: "group", group: "ghost" } }], bundles);
  ok(true, "without the registry the existence check is skipped (the pre-G 2-arg call keeps its exact meaning)");
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "group" } }], bundles, groups),
    "needs scope.group",
    "a group binding with no scope.group throws (the level's one address field)",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "group", group: "payments", principal: "slack/U1" } }], bundles, groups),
    "also sets scope.principal",
    "a group binding carrying a second address field throws",
  );
  throwsWith(
    () => assertBindingsValid([{ bundle: "basket", scope: { level: "group", group: "  " } }], bundles, groups),
    "scope.group is empty",
    "a whitespace group address throws",
  );
}

const dm = (principalId: string | undefined, groups?: readonly string[]): ResolveRequest => ({
  mode: "dm",
  platform: "slack",
  workspace: "T1",
  channel: "D1",
  ...(principalId === undefined ? {} : { principalId }),
  ...(groups === undefined ? {} : { groups }),
});
{
  const bundles: Bundle[] = [
    { name: "team", repos: ["acme/team"], connections: [{ id: "shared", credentialType: "bearer", secretRef: "TEAM_KEY", allowedWebsites: ["api.example.com"], methods: ["GET"] }] },
    { name: "mine", repos: ["acme/mine"], connections: [{ id: "shared", credentialType: "bearer", secretRef: "MY_OWN_KEY", allowedWebsites: ["api.example.com"], methods: ["GET"] }] },
  ];
  const groupOnly: Binding[] = [{ bundle: "team", scope: { level: "group", group: "payments" } }];

  ok(resolveAccess(dm("U1", ["payments"]), bundles, groupOnly).repos.includes("acme/team"), "a group binding grants in a MEMBER's DM");
  ok(resolveAccess(dm("U2", []), bundles, groupOnly).repos.length === 0, "a NON-member's DM gets nothing from a group binding");
  ok(resolveAccess(dm("U1"), bundles, groupOnly).repos.length === 0, "no groups on the request ⇒ nothing (absent is not a wildcard)");
  ok(
    resolveAccess({ mode: "dm", platform: "slack", workspace: "T1", channel: "D1", groups: ["payments"] }, bundles, groupOnly).repos.length === 0,
    "groups with NO principal id grant nothing — membership is about a person",
  );

  ok(
    resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel: "C1", groups: ["payments"], principalId: "U1" }, bundles, groupOnly).repos.length === 0,
    "a group binding contributes NOTHING in channel mode",
  );
  ok(
    resolveAccess({ mode: "mpim", platform: "slack", workspace: "T1", channel: "G1", groups: ["payments"], principalId: "U1" }, bundles, groupOnly).repos.length === 0,
    "a group binding contributes NOTHING in mpim mode",
  );
  ok(
    !resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel: "C1", groups: ["payments"], principalId: "U1" }, bundles, groupOnly).warnings.some((w) =>
      w.startsWith("broad grant"),
    ),
    "the resolver's broad-grant warn loop does not fire on a group scope (that verdict is access-lint's)",
  );

  const both: Binding[] = [
    { bundle: "team", scope: { level: "group", group: "payments" } },
    { bundle: "mine", scope: { level: "principal", principal: "slack/U1" } },
  ];
  const a = resolveAccess(dm("U1", ["payments"]), bundles, both);
  ok(a.connections.length === 1 && a.connections[0]!.secretRef === "MY_OWN_KEY", "narrowest-wins: a PRINCIPAL binding beats a GROUP one for the same connection id");
  ok(a.repos.includes("acme/team") && a.repos.includes("acme/mine"), "…while additive fields (repos) UNION across group + principal");

  const instr: Bundle[] = [
    { name: "gi", instructions: "team rule" },
    { name: "pi", instructions: "my rule" },
  ];
  const stack = resolveAccess(dm("U1", ["payments"]), instr, [
    { bundle: "pi", scope: { level: "principal", principal: "slack/U1" } },
    { bundle: "gi", scope: { level: "group", group: "payments" } },
  ]).instructionStack;
  ok(
    stack.length === 2 && stack[0]!.source === "group:payments" && stack[1]!.source === "principal:slack/U1",
    "instructions concatenate group → principal (later layers outrank earlier)",
  );
}

{
  const credentialed: Bundle[] = [{ name: "creds", connections: [{ id: "c", credentialType: "bearer", secretRef: "K", allowedWebsites: ["api.example.com"], methods: ["GET"] }] }];
  const credentialless: Bundle[] = [{ name: "plain", domains: ["raw.githubusercontent.com"], instructions: "hi" }];
  const small: Group = { name: "duo", members: ["slack/U1", "slack/U2"] };
  const withSet: Group = { name: "team", members: ["slack/U1", { linkSet: "set-a" }] };
  const big: Group = { name: "dept", members: Array.from({ length: GROUP_BROAD_MEMBERS }, (_, i) => `slack/U${i}`) };
  const bind = (group: string, allowBroad?: string): Binding[] => [{ bundle: "creds", scope: { level: "group", group }, ...(allowBroad === undefined ? {} : { allowBroad }) }];

  ok(lintBroadGrants(credentialed, bind("duo"), [], [small]).length === 0, "a SMALL, fully-enumerated group is the curated case — no acknowledgement needed");
  ok(lintBroadGrants(credentialed, bind("team"), [], [withSet]).length === 1, "a credentialed group binding with a LINK-SET member needs allowBroad");
  ok(lintBroadGrants(credentialed, bind("dept"), [], [big]).length === 1, `a credentialed group binding at ${GROUP_BROAD_MEMBERS}+ members needs allowBroad`);
  ok(lintBroadGrants(credentialed, bind("team", "the payments on-call rota shares this key deliberately"), [], [withSet]).length === 0, "…and an acknowledged one passes");
  ok(lintBroadGrants(credentialed, bind("team", ""), [], [withSet])[0]!.includes("EMPTY allowBroad"), "an EMPTY allowBroad is refused — the escape must name a reason");
  ok(lintBroadGrants(credentialless, [{ bundle: "plain", scope: { level: "group", group: "team" } }], [], [withSet]).length === 0, "a credential-LESS group grant is never flagged");
  ok(
    lintBroadGrants(credentialed, bind("duo", "why"), [], [small])[0]!.includes("isn't a broad scope"),
    "a spurious allowBroad on a narrow group binding is flagged, and the message says what would make it broad",
  );
  ok(lintBroadGrants(credentialed, bind("ghost"), [], [small]).length === 0, "an unknown group is assertBindingsValid's problem, not this lint's");
}

{
  const file: GroupsFile = {
    groups: [
      { name: "directory:Zeta", title: "Zeta", members: [{ linkSet: "b" }, { linkSet: "a" }] },
      { name: "directory:Alpha", title: "Alpha", members: [{ linkSet: "c" }] },
    ],
  };
  const text = emitGroupsModule(file);
  ok(text === emitGroupsModule(file), "emit is deterministic (same input ⇒ identical bytes)");
  ok(text.indexOf("directory:Alpha") < text.indexOf("directory:Zeta"), "groups are emitted in canonical name order");
  ok(stringifyGroups(file).includes('"linkSet": "a"'), "members serialise as link-set refs");
  ok(stringifyGroups(file).indexOf('"a"') < stringifyGroups(file).indexOf('"b"'), "members are sorted by link-set id");
  const round = parseGroupsModule(text);
  ok(emitGroupsModule(round) === text, "BYTE ROUND TRIP: parse(emit(x)) re-emits identical bytes");
  ok(emitGroupsModule(emptyGroupsFile()).endsWith("satisfies GroupsFile;\n"), "the empty overlay carries the pinned module grammar");
  ok(renormalizeGroupsModule(text) === text, "renormalising a canonical file is a no-op");

  throwsWith(
    () => parseGroupsModule(text.replace('"name": "directory:Alpha",\n      "title": "Alpha",', '"title": "Alpha",\n      "name": "directory:Alpha",')),
    "canonical form",
    "a hand-edited (non-canonical) overlay refuses the strict read",
  );
  throwsWith(() => parseGroupsModule(text + "\nconsole.log(1);\n"), "does not end with", "an overlay with an added statement refuses the strict read");

  throwsWith(() => parseGroupsFile({ groups: [{ name: "payments", members: [{ linkSet: "a" }] }] }), "prefixed name", "an UN-namespaced overlay group is refused");
  throwsWith(() => parseGroupsFile({ groups: [{ name: "directory:x", members: ["slack/U1"] }] }), "linkSet", "a bare principal key in the overlay is refused (the overlay never writes accounts)");
  throwsWith(() => parseGroupsFile({ groups: [{ name: "directory:x", members: [], extra: 1 }] }), 'field "extra"', "an unknown Group field in the overlay is refused");
  throwsWith(() => parseGroupsFile({ groups: [], bindings: [] }), "unknown top-level key", "an unknown top-level key is refused");
  ok(parseGroupsFile({ groups: [] }).groups.length === 0, "an empty overlay parses");

  const merged: Group[] = [{ name: "payments", members: ["slack/U1"] }, ...file.groups];
  ok(directoryGroupsOf(merged).groups.length === 2, "directoryGroupsOf recovers exactly the overlay's groups from a merged registry");
}

const PROVIDER = "okta";
const person = (externalId: string, groups: string[], deprovisioned = false): DirectoryPerson => ({
  externalId,
  displayName: externalId,
  accounts: [{ platform: "slack", nativeId: `U-${externalId}`, grade: "attested" }],
  groups,
  deprovisioned,
});
const setOf = (externalId: string): string => directoryLinkSetId(PROVIDER, externalId);
{
  const p1 = planDirectoryGroups({ provider: PROVIDER, people: [person("alice", ["Payments"])], current: emptyGroupsFile() });
  ok(p1.counts.addGroup === 1 && p1.next.groups[0]!.name === "directory:Payments", "a new IdP group appears as add-group with the namespaced name");
  ok(p1.next.groups[0]!.title === "Payments", "the verbatim IdP name is kept as the title");
  ok(groupLinkSets(p1.next.groups[0]!)[0] === setOf("alice"), "the member is the link-set id directory-sync derives for that person");

  const p2 = planDirectoryGroups({ provider: PROVIDER, people: [person("alice", ["Payments"])], current: p1.next });
  ok(groupPlanIsNoop(p2) && emitGroupsModule(p2.next) === emitGroupsModule(p1.next), "re-planning an unchanged directory is a NO-OP and re-emits identical bytes");

  const p3 = planDirectoryGroups({ provider: PROVIDER, people: [person("alice", ["Payments"]), person("bob", ["Payments"])], current: p1.next });
  ok(p3.counts.addMember === 1 && p3.steps.some((s) => s.kind === "add-member" && s.linkSet === setOf("bob")), "a joiner appears as add-member");

  const p4 = planDirectoryGroups({ provider: PROVIDER, people: [person("alice", ["Payments"]), person("bob", [])], current: p3.next });
  ok(p4.counts.removeMember === 1 && p4.steps.some((s) => s.kind === "remove-member" && s.linkSet === setOf("bob")), "a leaver appears as remove-member — narrowing goes through the SAME review path");

  const p5 = planDirectoryGroups({ provider: PROVIDER, people: [person("alice", ["Payments"]), person("bob", ["Payments"], true)], current: p3.next });
  ok(p5.steps.some((s) => s.kind === "remove-member" && s.linkSet === setOf("bob")), "a DEPROVISIONED person is dropped from every group in the plan");

  const p6 = planDirectoryGroups({ provider: PROVIDER, people: [person("alice", [])], current: p1.next });
  ok(p6.counts.dropGroup === 1 && p6.next.groups.length === 0, "a group nobody is in any more is DROPPED, never emitted empty (an empty group would fail assertGroupsValid)");

  const content = planOverlayContent(p3);
  const reparsed = parseGroupsModule(content);
  assertGroupsValid([{ name: "payments", members: ["slack/U1"] }, ...reparsed.groups]);
  ok(true, "the planned overlay parses AND passes assertGroupsValid merged with a hand-written group");
  ok(renderGroupPlan(p4).some((l) => l.startsWith("- ")), "renderGroupPlan renders a removal as a minus line");

  const p7 = planDirectoryGroups({ provider: PROVIDER, people: [person("alice", ["  "])], current: emptyGroupsFile() });
  ok(p7.warnings.length === 1 && p7.next.groups.length === 0, "a blank IdP group name is skipped with a warning");
}

const ORG = "default";
const db = new PGlite();
const client: PgClient = { query: (text, params) => db.query(text, params ? [...params] : undefined) };
await initOperationalSchema(client);
registerOperationalStore(makeOperationalPostgresStore(client));

{
  const evidence = { kind: "directory-sync", provider: "okta", grade: "attested" } as const;
  await ensureLinkSet({ org: ORG, linkSetId: "set-rowan", handle: "rowan" });
  for (const acct of [{ platform: "slack", nativeId: "U1" }, { platform: "discord", nativeId: "D1" }]) {
    await suggestLinkedId({ org: ORG, linkSetId: "set-rowan", account: acct, evidence });
    await confirmLinkedId({ org: ORG, account: acct, evidence });
  }
  await suggestLinkedId({ org: ORG, linkSetId: "set-rowan", account: { platform: "telegram", nativeId: "T1" }, evidence });

  const expanded = await expandLinkSet(ORG, "set-rowan");
  ok(expanded.length === 2, "expandLinkSet returns the CONFIRMED accounts only — the suggested one is invisible");

  const groups: Group[] = [{ name: "payments", members: [{ linkSet: "set-rowan" }] }];
  const bundles: Bundle[] = [{ name: "team", repos: ["acme/team"] }];
  const bindings: Binding[] = [{ bundle: "team", scope: { level: "group", group: "payments" } }];

  for (const acct of expanded) {
    const req = await withLinkSetGroups({ mode: "dm", platform: acct.platform, workspace: "W", channel: "D", principalId: acct.nativeId }, ORG, groups);
    ok(resolveAccess(req, bundles, bindings).repos.includes("acme/team"), `a link-set member's ${acct.platform} DM gets the group's bundle`);
  }
  {
    const req = await withLinkSetGroups({ mode: "dm", platform: "telegram", workspace: "W", channel: "D", principalId: "T1" }, ORG, groups);
    ok((req.groups ?? []).length === 0 && resolveAccess(req, bundles, bindings).repos.length === 0, "a SUGGESTED-only account gets NOTHING — a directory proposal never widens access");
  }
  {
    const req = await withLinkSetGroups({ mode: "dm", platform: "slack", workspace: "W", channel: "D", principalId: "U-stranger" }, ORG, groups);
    ok(resolveAccess(req, bundles, bindings).repos.length === 0, "an account on no link-set gets nothing");
  }

  {
    const viaExpand: string[] = [];
    for (const g of groups) {
      for (const ls of groupLinkSets(g)) {
        const members = await expandLinkSet(ORG, ls);
        if (members.some((m) => principalKey(m.platform, m.nativeId) === "slack/U1")) viaExpand.push(g.name);
      }
    }
    const viaResolve = groupsForPrincipal(groups, "slack/U1", await callerLinkSets(ORG, "slack", "U1"));
    assert.deepEqual([...new Set(viaExpand)].sort(), [...viaResolve]);
    passed++;
    ok(true, "resolveLinkSet-at-the-edge is EQUIVALENT to expandLinkSet-per-group (the account→set map is a function, by the store's PK)");
  }

  await setLinkSetHold({ org: ORG, linkSetId: "set-rowan", hold: "suspended", actor: "test" });
  {
    const req = await withLinkSetGroups({ mode: "dm", platform: "slack", workspace: "W", channel: "D", principalId: "U1" }, ORG, groups);
    ok(resolveAccess(req, bundles, bindings).repos.length === 0, "a SUSPENDED link-set contributes no group membership — narrowing lands without waiting for a config merge");
  }
  await setLinkSetHold({ org: ORG, linkSetId: "set-rowan", hold: "active", actor: "test" });

  {
    const direct: Group[] = [{ name: "floor", members: ["slack/U9"] }];
    const req: ResolveRequest = { mode: "dm", platform: "slack", workspace: "W", channel: "D", principalId: "U9", groups: groupsForPrincipal(direct, "slack/U9") };
    ok(resolveAccess(req, bundles, [{ bundle: "team", scope: { level: "group", group: "floor" } }]).repos.includes("acme/team"), "the NO-DB floor: a principal-key member resolves with no store read at all");
  }

  {
    const bare: ResolveRequest = { mode: "dm", platform: "slack", workspace: "W", channel: "D" };
    ok((await withLinkSetGroups(bare, ORG, groups)) === bare, "a request with no principalId is returned unchanged — an unattested turn inherits no group");
  }
}

resetOperationalStore();
await db.close();

ok(new GroupsCodemodError("x") instanceof Error, "GroupsCodemodError is an Error subclass (refused-by-design stays distinguishable)");

console.log(`✓ groups: ${passed} assertions passed`);

import assert from "node:assert/strict";

import {
  declaredAuthorTrust,
  authorRefutedByRegister,
  registerAuthorTrust,
  defineAuthorTrust,
  armedAuthorTrustTenants,
  _resetAuthorTrustForTest,
} from "../agent/identity/author-trust.js";
import { declareProviderSelection, clearProviderSelection } from "../agent/access/provider-selection.js";
import type { Group } from "../agent/identity/groups.js";

let passed = 0;
function ok(cond: boolean, msg: string): void {
  assert.ok(cond, msg);
  passed += 1;
  console.log(`  ✓ ${msg}`);
}
function eq<T>(actual: T, expected: T, msg: string): void {
  assert.deepStrictEqual(actual, expected, msg);
  passed += 1;
  console.log(`  ✓ ${msg}`);
}
function throws(fn: () => void, needle: string, msg: string): void {
  let raised: unknown;
  try {
    fn();
  } catch (e) {
    raised = e;
  }
  assert.ok(raised instanceof Error, `${msg} — expected a throw, got none`);
  assert.ok(
    (raised as Error).message.includes(needle),
    `${msg} — message should mention ${JSON.stringify(needle)}, got: ${(raised as Error).message}`,
  );
  passed += 1;
  console.log(`  ✓ ${msg}`);
}

const GUILD = "discord/1300000000000000100";
const ALICE = "discord/100000000000000001";
const BOB = "discord/100000000000000002";

console.log("1. an unarmed tenant:");

_resetAuthorTrustForTest();

eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "100000000000000001" }),
  undefined,
  "🔴 with NOTHING registered, a Discord author resolves `undefined` — not `external`",
);
ok(
  authorRefutedByRegister({ tenantKey: GUILD, authorId: "100000000000000001" }) === false,
  "🔴 negative control: the boolean the taint leg consumes is === false on an unregistered tenant",
);
eq(armedAuthorTrustTenants(), [], "nothing is armed");

registerAuthorTrust([defineAuthorTrust({ tenant: GUILD, internal: [ALICE] })]);

eq(
  declaredAuthorTrust({ tenantKey: "discord/999999999999999999", authorId: "100000000000000001" }),
  undefined,
  "🔴 arming ONE guild does not arm another — a DIFFERENT guild still resolves `undefined`",
);
ok(
  authorRefutedByRegister({ tenantKey: "discord/999999999999999999", authorId: "100000000000000001" }) === false,
  "negative control: the unarmed sibling guild refutes nobody (=== false)",
);
eq(
  declaredAuthorTrust({ tenantKey: "notion/ws-1", authorId: "100000000000000001" }),
  undefined,
  "arming a Discord guild does not arm a Notion workspace",
);

console.log("2. an armed tenant:");

eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "100000000000000001" }),
  "internal",
  "a DECLARED author resolves `internal`",
);
ok(
  authorRefutedByRegister({ tenantKey: GUILD, authorId: "100000000000000001" }) === false,
  "negative control: a declared author is NOT refuted (=== false)",
);
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "100000000000000002" }),
  "external",
  "🔴 an UNDECLARED author in an ARMED tenant resolves `external` — the fail-closed conclusion",
);
ok(
  authorRefutedByRegister({ tenantKey: GUILD, authorId: "100000000000000002" }) === true,
  "an undeclared author IS refuted (=== true) — this is what reaches the taint leg",
);
eq(
  declaredAuthorTrust({ tenantKey: GUILD }),
  "external",
  "🔴 an author with NO readable id in an armed tenant is `external` — nobody unnameable was declared",
);
eq(armedAuthorTrustTenants(), [GUILD], "the diagnostic names the one armed tenant");

registerAuthorTrust([
  defineAuthorTrust({ tenant: GUILD, internal: [ALICE] }),
  defineAuthorTrust({ tenant: "notion/ws-1", internal: ["notion/user-aaa"] }),
]);
eq(
  declaredAuthorTrust({ tenantKey: "notion/ws-1", authorId: "100000000000000001" }),
  "external",
  "🔴 the SAME id declared on discord is external on notion — the platform comes from the tenant key",
);
eq(declaredAuthorTrust({ tenantKey: "notion/ws-1", authorId: "user-aaa" }), "internal", "the notion author matches its own tenant");

console.log("3. membership patterns (the wildcard shape):");

const ROLE_STAFF = `${GUILD}/role:222222222222222222`;
const ROLE_OTHER = `${GUILD}/role:333333333333333333`;

_resetAuthorTrustForTest();
registerAuthorTrust([defineAuthorTrust({ tenant: GUILD, internal: [{ membership: ROLE_STAFF }] })]);

eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "100000000000000009", memberships: [ROLE_STAFF] }),
  "internal",
  "an author HOLDING the declared role is internal — nobody had to list them by id",
);
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "100000000000000009", memberships: [ROLE_OTHER] }),
  "external",
  "🔴 negative control: an author holding a DIFFERENT role is external",
);
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "100000000000000009", memberships: [] }),
  "external",
  "negative control: an author holding NO role is external",
);
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "100000000000000009", memberships: [`discord/999999999999999999/role:222222222222222222`] }),
  "external",
  "🔴 negative control: the SAME role id in ANOTHER guild does not match — a pattern never crosses tenants",
);
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "1", memberships: [ROLE_OTHER, ROLE_STAFF] }),
  "internal",
  "holding several roles matches when ANY of them is declared",
);

_resetAuthorTrustForTest();
registerAuthorTrust([defineAuthorTrust({ tenant: GUILD, internal: [{ membership: `${GUILD}/role:*` }] })]);
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "1", memberships: [ROLE_OTHER] }),
  "internal",
  "`role:*` admits an author holding ANY role",
);
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "1", memberships: [] }),
  "external",
  "🔴 negative control: `role:*` still refuses an author with NO roles — the glob is not `everyone`",
);
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "1", memberships: [`discord/999999999999999999/role:1`] }),
  "external",
  "negative control: `role:*` does not reach into another guild",
);

_resetAuthorTrustForTest();
registerAuthorTrust([defineAuthorTrust({ tenant: GUILD, internal: [{ membership: `${GUILD}/role:22*` }] })]);
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "1", memberships: [ROLE_STAFF] }),
  "internal",
  "a prefix glob `role:22*` admits a role id starting with that prefix",
);
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "1", memberships: [ROLE_OTHER] }),
  "external",
  "negative control: `role:22*` refuses a role id outside the prefix",
);

console.log("4. person-group members:");

const GROUPS: readonly Group[] = [
  { name: "payments-team", members: [ALICE, "slack/T0AB1CD2E/U0000AAAA"] },
  { name: "directory:Engineering", members: [BOB, { linkSet: "set-1" }] },
  { name: "linkset-only", members: [{ linkSet: "set-2" }] },
  { name: "slack-only", members: ["slack/T0AB1CD2E/U0000BBBB"] },
];

_resetAuthorTrustForTest();
registerAuthorTrust([defineAuthorTrust({ tenant: GUILD, internal: [{ group: "payments-team" }, { group: "directory:Engineering" }] })], GROUPS);

eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "100000000000000001" }),
  "internal",
  "a group's discord member is internal — the group expanded at register time",
);
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "100000000000000002" }),
  "internal",
  "an IdP-synced `directory:` group works exactly like a hand-written one — the pluggable source seam",
);
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "U0000AAAA" }),
  "external",
  "🔴 negative control: the group's SLACK member does not become a discord author — cross-platform ids do not leak",
);
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "100000000000000003" }),
  "external",
  "negative control: someone in no group is external",
);

throws(
  () => registerAuthorTrust([defineAuthorTrust({ tenant: GUILD, internal: [{ group: "linkset-only" }] })], GROUPS),
  "Link-set members do NOT count",
  "🔴 a group whose only members are link-sets is refused LOUDLY, not accepted and silently inert",
);
throws(
  () => registerAuthorTrust([defineAuthorTrust({ tenant: GUILD, internal: [{ group: "slack-only" }] })], GROUPS),
  "NO discord principal-key member",
  "a group with no member on THIS platform is refused — it is dead config",
);
throws(
  () => registerAuthorTrust([defineAuthorTrust({ tenant: GUILD, internal: [{ group: "nope" }] })], GROUPS),
  "not defined",
  "a reference to a group that does not exist is refused",
);

console.log("5. config validation (fail-loud at boot):");

throws(
  () => registerAuthorTrust([{ tenant: `${GUILD}/C123`, internal: [ALICE] }]),
  "must be exactly",
  "a SURFACE key as the arming tenant is refused — the register arms one tenant at a time",
);
throws(() => registerAuthorTrust([{ tenant: "discord", internal: [ALICE] }]), "must be exactly", "a bare platform is refused as an arming key");
throws(() => registerAuthorTrust([{ tenant: GUILD, internal: [] }]), "empty `internal` list", "an empty member list is refused — it would arm and then refute everybody");
throws(
  () => registerAuthorTrust([{ tenant: GUILD, internal: [ALICE] }, { tenant: GUILD, internal: [BOB] }]),
  "declared more than once",
  "the same tenant declared twice is refused — a reader must see one declaration",
);
throws(() => registerAuthorTrust([{ tenant: GUILD, internal: ["100000000000000001"] }]), "not a qualified principal key", "a bare unqualified id is refused");
throws(
  () => registerAuthorTrust([{ tenant: GUILD, internal: ["slack/T0AB1CD2E/U0000AAAA"] }]),
  "DIFFERENT platform",
  "🔴 a member on another platform is refused — it looks fine and can NEVER match",
);
throws(
  () => registerAuthorTrust([{ tenant: GUILD, internal: [{ membership: `discord/999999999999999999/role:1` }] }]),
  "not the",
  "🔴 a membership naming another tenant is refused — same dead-config class",
);
throws(
  () => registerAuthorTrust([{ tenant: GUILD, internal: [{ membership: `${GUILD}/C123` }] }]),
  "not a group-rung key",
  "a membership without the `<marker>:<id>` rung is refused",
);
throws(() => registerAuthorTrust([{ tenant: GUILD, internal: [ALICE, ALICE] }]), "more than once", "a duplicate member is refused");
throws(
  () => registerAuthorTrust([{ tenant: GUILD, internal: [{ nonsense: "x" } as unknown as string] }]),
  "neither a principal key",
  "a member of an unknown shape is refused",
);

_resetAuthorTrustForTest();
registerAuthorTrust([defineAuthorTrust({ tenant: GUILD, internal: [ALICE] })]);
try {
  registerAuthorTrust([{ tenant: "nonsense", internal: [ALICE] }]);
} catch {
}
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "100000000000000001" }),
  "internal",
  "🔴 a THROWN register leaves the previous register intact — a boot error never silently disarms the plane",
);

console.log("5b. the provider-selection gate:");

_resetAuthorTrustForTest();
try {
  declareProviderSelection(["discord"]);
  registerAuthorTrust([
    defineAuthorTrust({ tenant: GUILD, internal: [ALICE] }),
    defineAuthorTrust({ tenant: "notion/ws-1", internal: ["notion/user-aaa"] }),
  ]);
  eq(armedAuthorTrustTenants(), [GUILD], "🔴 with only `discord` selected, the NOTION entry is dropped — no live row for an unselected provider");
  eq(
    declaredAuthorTrust({ tenantKey: "notion/ws-1", authorId: "user-aaa" }),
    undefined,
    "…so the dropped tenant is UNARMED, exactly as if it had never been declared",
  );
  eq(declaredAuthorTrust({ tenantKey: GUILD, authorId: "100000000000000001" }), "internal", "negative control: the SELECTED provider's entry still registers");
} finally {
  clearProviderSelection();
}

console.log("6. the register is not mutable through its reads:");

const armed = armedAuthorTrustTenants() as string[];
armed.push("discord/injected");
eq(armedAuthorTrustTenants(), [GUILD], "mutating the diagnostic's return value does not change the register");
declaredAuthorTrust({ tenantKey: GUILD, authorId: "100000000000000002" });
eq(
  declaredAuthorTrust({ tenantKey: GUILD, authorId: "100000000000000002" }),
  "external",
  "the resolver is pure — asking twice gives the same answer and writes nothing",
);

_resetAuthorTrustForTest();
console.log(`\n✓ author-trust: ${passed} assertions passed`);

// proves: AP-MOD-core-identity-author-trust

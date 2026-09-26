// proves: AP-MOD-core-access-member-grant

import assert from "node:assert/strict";
import {
  memberGrantCredential,
  memberGrantKey,
  memberPlaneGrants,
  MEMBER_ROLES,
} from "../agent/access/member-grant.js";
import { domainCredentialId } from "../agent/access/domain-credentials.js";
import type { Domain } from "../agent/memory/domain.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const NOTION = "notion";
const MEMBER_ROLE = "user-oauth";
const CHAT_ROLE = "channel-key";
const WORK_ROLE = "team-key";

const plain: Domain = { name: "support", reach: ["slack/T1/C1"] };

const chatOnly: Domain = {
  name: "billing",
  reach: ["slack/T1/C2"],
  credentials: [{ connector: NOTION, credential: CHAT_ROLE, use: "billing-chat-key" }],
};

const workOnly: Domain = {
  name: "platform",
  reach: ["slack/T1/C3"],
  credentials: [{ connector: NOTION, credential: WORK_ROLE, use: "platform-team-key" }],
};

const memberGranted: Domain = {
  name: "product",
  reach: ["slack/T1/C4"],
  credentials: [{ connector: NOTION, credential: MEMBER_ROLE, use: "product-personal" }],
};

const otherConnector: Domain = {
  name: "growth",
  reach: ["slack/T1/C5"],
  credentials: [{ connector: "linear", credential: MEMBER_ROLE, use: "growth-personal" }],
};

ok(memberGrantCredential(memberGranted, NOTION, MEMBER_ROLE) === "product-personal", "a declared member role resolves the credential it names");

ok(memberGrantCredential(plain, NOTION, MEMBER_ROLE) === undefined, "🔴 a domain that declares NOTHING holds no member grant — undefined, never the org default");

ok(memberGrantCredential(chatOnly, NOTION, MEMBER_ROLE) === undefined, "🔴 a CHAT-role declaration is not a member grant");

ok(memberGrantCredential(workOnly, NOTION, MEMBER_ROLE) === undefined, "🔴 a WORK-role declaration is not a member grant — the two roles are separate declarations on one field");

ok(memberGrantCredential(otherConnector, NOTION, MEMBER_ROLE) === undefined, "🔴 a member grant on ANOTHER connector grants nothing on this one");

ok(memberGrantCredential(undefined, NOTION, MEMBER_ROLE) === undefined, "an unresolved domain holds no member grant — the fail-closed arm");

ok(domainCredentialId(plain, NOTION, CHAT_ROLE) === CHAT_ROLE, "🔴 the contrast: domainCredentialId is TOTAL and falls back to the org default for an undeclared domain…");
ok(memberGrantCredential(plain, NOTION, CHAT_ROLE) === undefined, "…while memberGrantCredential over the same domain and role refuses. One field, two rules.");

ok(memberGrantKey("notion", "product-personal") === "notion/product-personal", "the grant key is `<connector>/<credentialId>` — ONE spelling");

ok(MEMBER_ROLES.some((m) => m.connector === NOTION && m.role === MEMBER_ROLE), "notion/user-oauth is a reviewed member role");

const grantedSet = memberPlaneGrants([memberGranted]);
ok(grantedSet.length === 1 && grantedSet[0] === "notion/product-personal", "memberPlaneGrants names the DECLARED credential, not the role");

ok(memberPlaneGrants([plain]).length === 0, "🔴 a domain declaring nothing contributes NO grant key (length === 0)");
ok(memberPlaneGrants([workOnly, chatOnly]).length === 0, "🔴 work and chat declarations contribute NO grant key (negative control)");
ok(memberPlaneGrants([undefined]).length === 0, "an unresolved domain contributes no grant key");
ok(memberPlaneGrants([]).length === 0, "no domains ⇒ no grants");

const twoDomains: Domain = {
  name: "second",
  reach: ["slack/T1/C6"],
  credentials: [{ connector: NOTION, credential: MEMBER_ROLE, use: "second-personal" }],
};
const union = memberPlaneGrants([memberGranted, twoDomains]);
ok(union.length === 2 && union[0] === "notion/product-personal" && union[1] === "notion/second-personal", "two domains union their grants, sorted");

ok(memberPlaneGrants([otherConnector]).length === 0, "🔴 a declaration for a connector MEMBER_ROLES does not name contributes nothing — the list is the enumeration");

assert.equal(typeof passed, "number");
console.log(`✓ member-grant: ${passed} assertions passed`);

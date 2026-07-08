import assert from "node:assert/strict";
import {
  decide,
  hostKeyMatches,
  normalizeHost,
  normalizeSourceIp,
  PolicyStore,
  validatePolicy,
  type EgressPolicy,
} from "./acl.ts";
import { handlePolicyPush, handleAcl } from "./handlers.ts";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  ok(normalizeHost("GitHub.com.") === "github.com", "lowercase + trailing dot stripped");
  ok(normalizeHost("github.com:443") === "github.com", "trailing :port stripped");
  ok(normalizeHost("[::1]:443") === "::1", "ipv6 brackets + port stripped");
  ok(normalizeSourceIp("::ffff:172.20.0.3") === "172.20.0.3", "ipv4-mapped-ipv6 prefix stripped");

  ok(hostKeyMatches("github.com", "github.com"), "exact host matches");
  ok(!hostKeyMatches("github.com", "evil.com"), "different host does not match");
  ok(hostKeyMatches("*.npmjs.org", "registry.npmjs.org"), "wildcard matches a subdomain");
  ok(!hostKeyMatches("*.npmjs.org", "npmjs.org"), "wildcard does NOT match the bare apex");
  ok(!hostKeyMatches("*.npmjs.org", "registry.npmjs.org.evil.com"), "wildcard suffix is anchored to the end");
  ok(hostKeyMatches("*", "anything.example"), "bare * matches everything");
}

{
  ok(!decide(undefined, { host: "github.com" }).allow, "no policy for source → deny (fail-closed)");
  ok(!decide("deny-all", { host: "github.com" }).allow, "deny-all denies");
  ok(decide("allow-all", { host: "github.com" }).allow, "allow-all allows");
  ok(!decide({ allow: {} }, { host: "github.com" }).allow, "empty allow map → deny");
  ok(!decide({}, { host: "github.com" }).allow, "no allow field → deny (fail-closed)");
}

{
  const bare: EgressPolicy = { allow: { "api.acme.test": [] } };
  ok(decide(bare, { host: "api.acme.test" }).allow, "bare host rule (empty array) allows");
  ok(!decide(bare, { host: "other.test" }).allow, "host not in the map is denied");

  const list: EgressPolicy = { allow: ["github.com", "*.npmjs.org"] };
  ok(decide(list, { host: "github.com" }).allow, "string-list allow matches");
  ok(decide(list, { host: "registry.npmjs.org" }).allow, "string-list wildcard matches");
  ok(!decide(list, { host: "evil.test" }).allow, "string-list denies the rest");
}

{
  const narrowed: EgressPolicy = {
    allow: {
      "api.acme.test": [{ match: { method: ["GET"], path: { startsWith: "/v1/" } } }],
    },
  };
  ok(decide(narrowed, { host: "api.acme.test" }).allow, "Tier A (no method/path) allows a listed host regardless of narrowing");
  ok(decide(narrowed, { host: "api.acme.test", method: "GET", path: "/v1/x" }).allow, "Tier B: matching method+path allowed");
  ok(!decide(narrowed, { host: "api.acme.test", method: "POST", path: "/v1/x" }).allow, "Tier B: wrong method denied");
  ok(!decide(narrowed, { host: "api.acme.test", method: "GET", path: "/v2/x" }).allow, "Tier B: wrong path denied");
}

{
  const brokered: EgressPolicy = {
    allow: {
      "github.com": [
        { match: { path: { startsWith: "/acme/" } }, transform: [{ headers: { Authorization: "Basic zzz" } }] },
      ],
    },
  };
  const d = decide(brokered, { host: "github.com", method: "GET", path: "/acme/repo/info/refs" });
  ok(d.allow, "brokered git host allowed on the owner path");
  ok(d.headers?.Authorization === "Basic zzz", "the injection header rides back for the helper to stamp");
  ok(!decide(brokered, { host: "github.com", method: "GET", path: "/other-owner/repo" }).allow, "a different owner path is denied");
}

{
  const store = new PolicyStore();
  store.set("172.20.0.3", { allow: { "github.com": [] } });
  ok(store.decide("172.20.0.3", { host: "github.com" }).allow, "stored policy is applied to its source");
  ok(store.decide("::ffff:172.20.0.3", { host: "github.com" }).allow, "ipv4-mapped source key matches the stored ipv4");
  ok(!store.decide("172.20.0.9", { host: "github.com" }).allow, "an unknown source is denied (fail-closed)");
  ok(store.delete("172.20.0.3") && store.size() === 0, "delete removes the policy");
  ok(!store.decide("172.20.0.3", { host: "github.com" }).allow, "after delete the source is denied again");
}

{
  ok(validatePolicy("deny-all") === "deny-all", "deny-all validates");
  ok(validatePolicy("allow-all") === "allow-all", "allow-all validates");
  ok(typeof validatePolicy({ allow: { "x": [] } }) === "object", "record form validates");
  let threw = false;
  try {
    validatePolicy("garbage");
  } catch {
    threw = true;
  }
  ok(threw, "a garbage policy string is rejected");
  let threw2 = false;
  try {
    validatePolicy({ allow: "not-a-list" });
  } catch {
    threw2 = true;
  }
  ok(threw2, "a non-list/map allow is rejected");
}

{
  const store = new PolicyStore();
  ok(handlePolicyPush(store, { body: { policy: "deny-all" }, remoteAddr: "10.0.0.1", authOk: false }).status === 401, "push without auth → 401");
  const r1 = handlePolicyPush(store, { body: { policy: { allow: { "github.com": [] } }, sourceIp: "172.20.0.5" }, remoteAddr: "10.0.0.1", authOk: true });
  ok(r1.status === 200 && r1.keyed === "172.20.0.5", "explicit body.sourceIp is the key");
  ok(store.decide("172.20.0.5", { host: "github.com" }).allow, "pushed policy is queryable by its explicit key");
  const r2 = handlePolicyPush(store, { body: { policy: "deny-all" }, remoteAddr: "10.0.0.7", authOk: true });
  ok(r2.status === 200 && r2.keyed === "10.0.0.7", "no explicit sourceIp → keyed by remote addr");
  ok(handlePolicyPush(store, { body: { policy: "nonsense" }, remoteAddr: "10.0.0.1", authOk: true }).status === 400, "invalid policy → 400");
  ok(handlePolicyPush(store, { body: null, remoteAddr: "10.0.0.1", authOk: true }).status === 400, "non-object body → 400");
}

{
  const store = new PolicyStore();
  store.set("172.20.0.3", { allow: { "github.com": [] } });
  const allow = handleAcl(store, { src: "172.20.0.3", host: "github.com", method: "CONNECT", path: "-" });
  ok(allow.evaluated && allow.decision.allow, "well-formed ACL query for an allowed host → allow");
  const deny = handleAcl(store, { src: "172.20.0.3", host: "evil.test" });
  ok(deny.evaluated && !deny.decision.allow, "unlisted host → deny");
  const malformed = handleAcl(store, { src: "-", host: "github.com" });
  ok(!malformed.evaluated && !malformed.decision.allow, "missing src ('-') → fail-closed deny, not evaluated");
  const malformed2 = handleAcl(store, { src: "172.20.0.3", host: undefined });
  ok(!malformed2.evaluated && !malformed2.decision.allow, "missing host → fail-closed deny");
}

console.log(`\n✓ egress-proxy control: ${n} assertions passed (ACL match + wildcard + Tier A/B narrowing + store fail-closed + push/acl handlers)\n`);

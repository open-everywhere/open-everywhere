import assert from "node:assert/strict";
import {
  assertDomainCredentialsResolvable,
  credentialOverrideFor,
  domainCredentialId,
  domainCredentialProblems,
  connectorIntegrations,
} from "../agent/access/domain-credentials.js";
import { assertDomainsValid, type Domain } from "../agent/memory/domain.js";
import type { ConnectorCredentials } from "../agent/access/connector-credentials.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const unbound: Domain = { name: "support", reach: ["notion/WS/aaa"] };
const bound: Domain = {
  name: "payments",
  reach: ["notion/WS/bbb"],
  credentials: [{ connector: "notion", credential: "channel-key", use: "payments-channel-key", inboundSecret: "NOTION_WEBHOOK_SECRET_PAYMENTS" }],
};
const boundNoInbound: Domain = {
  name: "legal",
  reach: ["notion/WS/ccc"],
  credentials: [{ connector: "notion", credential: "channel-key", use: "legal-channel-key" }],
};

{
  ok(domainCredentialId(bound, "notion", "channel-key") === "payments-channel-key", "a bound domain resolves ITS OWN credential");
  ok(domainCredentialId(unbound, "notion", "channel-key") === "channel-key", "an UNBOUND domain resolves the ORG DEFAULT (fallback, never a refusal)");
  ok(domainCredentialId(undefined, "notion", "channel-key") === "channel-key", "NO domain at all resolves the org default too");

  ok(credentialOverrideFor(bound, "linear", "channel-key") === undefined, "an override does NOT match a different connector");
  ok(domainCredentialId(bound, "linear", "channel-key") === "channel-key", "…so a different connector still resolves the org default");
  ok(credentialOverrideFor(bound, "notion", "team-key") === undefined, "an override does NOT match a different credential ROLE on the same connector");
  ok(domainCredentialId(bound, "notion", "team-key") === "team-key", "…so the other role still resolves the org default");
  ok(credentialOverrideFor(unbound, "notion", "channel-key") === undefined, "an unbound domain reports NO override (the fallback signal callers branch on)");
}

{
  const list = connectorIntegrations([unbound, bound, boundNoInbound], "notion", "channel-key", "NOTION_WEBHOOK_SECRET");
  ok(list.length === 3, "one entry for the org default + one per BOUND domain (an unbound domain adds none)");
  ok(list[0]!.credentialId === "channel-key" && list[0]!.inboundSecret === "NOTION_WEBHOOK_SECRET", "the ORG DEFAULT is present and FIRST");
  ok(list[0]!.domain === undefined, "the org-default entry names no domain");
  ok(list[1]!.credentialId === "payments-channel-key" && list[1]!.domain === "payments", "the bound domain contributes its own credential");
  ok(list[1]!.inboundSecret === "NOTION_WEBHOOK_SECRET_PAYMENTS", "a domain that runs its own subscription names its own inbound secret");
  ok(list[2]!.credentialId === "legal-channel-key" && list[2]!.inboundSecret === "NOTION_WEBHOOK_SECRET", "a bound domain with NO inboundSecret shares the deployment default");

  const solo = connectorIntegrations([unbound], "notion", "channel-key", "NOTION_WEBHOOK_SECRET");
  ok(solo.length === 1 && solo[0]!.credentialId === "channel-key", "an all-unbound deployment yields the single org integration");

  const twin: Domain = { name: "payments-eu", reach: ["notion/WS/ddd"], credentials: [{ ...bound.credentials![0]! }] };
  const deduped = connectorIntegrations([bound, twin], "notion", "channel-key", "NOTION_WEBHOOK_SECRET");
  ok(deduped.length === 2, "two domains sharing one integration contribute ONE entry, not two");
}

{
  ok(domainCredentialProblems(unbound).length === 0, "a domain with no overrides has no shape problems");
  ok(domainCredentialProblems(bound).length === 0, "a well-formed override has no shape problems");

  const selfRef: Domain = { name: "x", reach: ["notion/WS/e"], credentials: [{ connector: "notion", credential: "channel-key", use: "channel-key" }] };
  ok(domainCredentialProblems(selfRef).some((p) => p.includes("does nothing")), "an override whose `use` IS the replaced credential is refused as dead config");

  const dupe: Domain = {
    name: "y",
    reach: ["notion/WS/f"],
    credentials: [
      { connector: "notion", credential: "channel-key", use: "a" },
      { connector: "notion", credential: "channel-key", use: "b" },
    ],
  };
  ok(domainCredentialProblems(dupe).some((p) => p.includes("more than once")), "two overrides of the SAME (connector, credential) are a contradiction, not a precedence question");

  const blank = { name: "z", reach: ["notion/WS/g"], credentials: [{ connector: "notion", credential: "", use: "a" }] } as Domain;
  ok(domainCredentialProblems(blank).some((p) => p.includes("`credential` must be a non-empty string")), "an empty field is refused");

  const badInbound = { name: "w", reach: ["notion/WS/h"], credentials: [{ connector: "notion", credential: "channel-key", use: "a", inboundSecret: "  " }] } as Domain;
  ok(domainCredentialProblems(badInbound).some((p) => p.includes("inboundSecret")), "a blank inboundSecret is refused (omit it to share the default)");

  assert.doesNotThrow(() => assertDomainsValid([bound]), "a valid override passes assertDomainsValid");
  assert.throws(() => assertDomainsValid([selfRef]), /does nothing/, "assertDomainsValid REFUSES a dead override");
}

{
  const catalogues: readonly ConnectorCredentials[] = [
    {
      connector: "notion",
      allows: ["api-key"],
      credentials: [
        { id: "channel-key", type: "api-key", secretRef: "db:notion:channel-key", broker: "db" },
        { id: "payments-channel-key", type: "api-key", secretRef: "db:notion:payments-channel-key", broker: "db" },
      ],
    },
  ];

  assert.doesNotThrow(() => assertDomainCredentialsResolvable([unbound, bound], catalogues), "a binding naming a DECLARED credential passes the boot check");

  assert.throws(
    () => assertDomainCredentialsResolvable([boundNoInbound], catalogues),
    /legal-channel-key/,
    "🔴 a binding naming an UNDECLARED credential is REFUSED at boot — it must never quietly fall back to the org key",
  );

  assert.throws(
    () => assertDomainCredentialsResolvable([{ name: "q", reach: ["notion/WS/i"], credentials: [{ connector: "ghost", credential: "channel-key", use: "x" }] }], catalogues),
    /has no credential catalogue/,
    "a binding naming an unknown CONNECTOR is refused at boot",
  );

  assert.throws(
    () => assertDomainCredentialsResolvable([{ name: "r", reach: ["notion/WS/j"], credentials: [{ connector: "notion", credential: "no-such-role", use: "payments-channel-key" }] }], catalogues),
    /declares no such credential/,
    "a binding replacing a credential the connector does not declare is refused at boot",
  );

  assert.doesNotThrow(() => assertDomainCredentialsResolvable([unbound], []), "an UNBOUND domain passes even with NO catalogues configured at all");
}

console.log(`✓ domain-credentials: ${passed} assertions passed`);

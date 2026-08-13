import assert from "node:assert/strict";
import {
  assertDomainCredentialsResolvable,
  credentialOverrideFor,
  domainCredentialId,
  domainCredentialProblems,
  providerIntegrations,
} from "../agent/access/domain-credentials.js";
import { assertDomainsValid, type Domain } from "../agent/memory/domain.js";
import type { Provider } from "../agent/access/providers.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const unbound: Domain = { name: "support", channels: ["notion/WS/aaa"] };
const bound: Domain = {
  name: "payments",
  channels: ["notion/WS/bbb"],
  credentials: [{ provider: "notion", credential: "channel-key", use: "payments-channel-key", inboundSecret: "NOTION_WEBHOOK_SECRET_PAYMENTS" }],
};
const boundNoInbound: Domain = {
  name: "legal",
  channels: ["notion/WS/ccc"],
  credentials: [{ provider: "notion", credential: "channel-key", use: "legal-channel-key" }],
};

{
  ok(domainCredentialId(bound, "notion", "channel-key") === "payments-channel-key", "a bound domain resolves ITS OWN credential");
  ok(domainCredentialId(unbound, "notion", "channel-key") === "channel-key", "an UNBOUND domain resolves the ORG DEFAULT (fallback, never a refusal)");
  ok(domainCredentialId(undefined, "notion", "channel-key") === "channel-key", "NO domain at all resolves the org default too");

  ok(credentialOverrideFor(bound, "linear", "channel-key") === undefined, "an override does NOT match a different provider");
  ok(domainCredentialId(bound, "linear", "channel-key") === "channel-key", "…so a different provider still resolves the org default");
  ok(credentialOverrideFor(bound, "notion", "team-key") === undefined, "an override does NOT match a different credential ROLE on the same provider");
  ok(domainCredentialId(bound, "notion", "team-key") === "team-key", "…so the other role still resolves the org default");
  ok(credentialOverrideFor(unbound, "notion", "channel-key") === undefined, "an unbound domain reports NO override (the fallback signal callers branch on)");
}

{
  const list = providerIntegrations([unbound, bound, boundNoInbound], "notion", "channel-key", "NOTION_WEBHOOK_SECRET");
  ok(list.length === 3, "one entry for the org default + one per BOUND domain (an unbound domain adds none)");
  ok(list[0]!.credentialId === "channel-key" && list[0]!.inboundSecret === "NOTION_WEBHOOK_SECRET", "the ORG DEFAULT is present and FIRST");
  ok(list[0]!.domain === undefined, "the org-default entry names no domain");
  ok(list[1]!.credentialId === "payments-channel-key" && list[1]!.domain === "payments", "the bound domain contributes its own credential");
  ok(list[1]!.inboundSecret === "NOTION_WEBHOOK_SECRET_PAYMENTS", "a domain that runs its own subscription names its own inbound secret");
  ok(list[2]!.credentialId === "legal-channel-key" && list[2]!.inboundSecret === "NOTION_WEBHOOK_SECRET", "a bound domain with NO inboundSecret shares the deployment default");

  const solo = providerIntegrations([unbound], "notion", "channel-key", "NOTION_WEBHOOK_SECRET");
  ok(solo.length === 1 && solo[0]!.credentialId === "channel-key", "an all-unbound deployment yields the single org integration");

  const twin: Domain = { name: "payments-eu", channels: ["notion/WS/ddd"], credentials: [{ ...bound.credentials![0]! }] };
  const deduped = providerIntegrations([bound, twin], "notion", "channel-key", "NOTION_WEBHOOK_SECRET");
  ok(deduped.length === 2, "two domains sharing one integration contribute ONE entry, not two");
}

{
  ok(domainCredentialProblems(unbound).length === 0, "a domain with no overrides has no shape problems");
  ok(domainCredentialProblems(bound).length === 0, "a well-formed override has no shape problems");

  const selfRef: Domain = { name: "x", channels: ["notion/WS/e"], credentials: [{ provider: "notion", credential: "channel-key", use: "channel-key" }] };
  ok(domainCredentialProblems(selfRef).some((p) => p.includes("does nothing")), "an override whose `use` IS the replaced credential is refused as dead config");

  const dupe: Domain = {
    name: "y",
    channels: ["notion/WS/f"],
    credentials: [
      { provider: "notion", credential: "channel-key", use: "a" },
      { provider: "notion", credential: "channel-key", use: "b" },
    ],
  };
  ok(domainCredentialProblems(dupe).some((p) => p.includes("more than once")), "two overrides of the SAME (provider, credential) are a contradiction, not a precedence question");

  const blank = { name: "z", channels: ["notion/WS/g"], credentials: [{ provider: "notion", credential: "", use: "a" }] } as Domain;
  ok(domainCredentialProblems(blank).some((p) => p.includes("`credential` must be a non-empty string")), "an empty field is refused");

  const badInbound = { name: "w", channels: ["notion/WS/h"], credentials: [{ provider: "notion", credential: "channel-key", use: "a", inboundSecret: "  " }] } as Domain;
  ok(domainCredentialProblems(badInbound).some((p) => p.includes("inboundSecret")), "a blank inboundSecret is refused (omit it to share the default)");

  assert.doesNotThrow(() => assertDomainsValid([bound]), "a valid override passes assertDomainsValid");
  assert.throws(() => assertDomainsValid([selfRef]), /does nothing/, "assertDomainsValid REFUSES a dead override");
}

{
  const providers: readonly Provider[] = [
    {
      name: "notion",
      connection: "notion",
      allows: ["api-key"],
      credentials: [
        { id: "channel-key", type: "api-key", secretRef: "db:notion:channel-key", broker: "db" },
        { id: "payments-channel-key", type: "api-key", secretRef: "db:notion:payments-channel-key", broker: "db" },
      ],
    },
  ];

  assert.doesNotThrow(() => assertDomainCredentialsResolvable([unbound, bound], providers), "a binding naming a DECLARED credential passes the boot check");

  assert.throws(
    () => assertDomainCredentialsResolvable([boundNoInbound], providers),
    /legal-channel-key/,
    "🔴 a binding naming an UNDECLARED credential is REFUSED at boot — it must never quietly fall back to the org key",
  );

  assert.throws(
    () => assertDomainCredentialsResolvable([{ name: "q", channels: ["notion/WS/i"], credentials: [{ provider: "ghost", credential: "channel-key", use: "x" }] }], providers),
    /not a configured provider/,
    "a binding naming an unknown PROVIDER is refused at boot",
  );

  assert.throws(
    () => assertDomainCredentialsResolvable([{ name: "r", channels: ["notion/WS/j"], credentials: [{ provider: "notion", credential: "no-such-role", use: "payments-channel-key" }] }], providers),
    /declares no such credential/,
    "a binding replacing a credential the provider does not declare is refused at boot",
  );

  assert.doesNotThrow(() => assertDomainCredentialsResolvable([unbound], []), "an UNBOUND domain passes even with NO providers configured at all");
}

console.log(`✓ domain-credentials: ${passed} assertions passed`);

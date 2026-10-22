import {
  assertConnectorCredentialsValid,
  defineConnectorCredentials,
  expandConnectorGrant,
  grantFamilyOf,
  humanActingSupport,
  isHumanActing,
  principalOf,
  principalOfCredential,
  oauthConnectorHome,
  type ConnectorCredentials,
  type ConnectorCredential,
  type ConnectorCredentialType,
} from "../agent/access/connector-credentials.js";
import { offerableCredential, resolveConnectorOptions } from "../agent/connections/connector-offer.js";
import { resolveAccess, type ResolveRequest } from "../agent/access/resolver.js";
import type { Binding, Bundle } from "../agent/access/bundle.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throwsWith(fn: () => void, label: string): string {
  try {
    fn();
  } catch (err) {
    passed++;
    return err instanceof Error ? err.message : String(err);
  }
  console.error(`✗ ${label} (did not throw)`);
  process.exit(1);
}

const capable: ConnectorCredentials = defineConnectorCredentials({
  connector: "acme",
  allows: ["api-key", "service-oauth", "user-oauth"],
  humanActing: { supported: true, credentialTypes: ["api-key"] },
  credentials: [
    { id: "install-key", type: "api-key", secretRef: "ACME_INSTALL", broker: "env", lifecycle: { refresh: "manual-rotation" } },
    {
      id: "as-me",
      type: "api-key",
      secretRef: "ACME_PERSONAL",
      broker: "env",
      grantFamily: "human-acting",
      lifecycle: { refresh: "manual-rotation", ttlSeconds: 365 * 24 * 60 * 60 },
    },
  ],
});

const incapable: ConnectorCredentials = defineConnectorCredentials({
  connector: "nohuman",
  allows: ["api-key"],
  humanActing: {
    supported: false,
    reason: "no scope combination lets the app post chat as a human — the app identity is the only posting principal",
  },
  credentials: [{ id: "install-key", type: "api-key", secretRef: "NOHUMAN_INSTALL", broker: "env" }],
});

const undeclared: ConnectorCredentials = defineConnectorCredentials({
  connector: "unknown",
  allows: ["api-key"],
  credentials: [{ id: "install-key", type: "api-key", secretRef: "UNKNOWN_INSTALL", broker: "env" }],
});

assertConnectorCredentialsValid([capable, incapable, undeclared]);
passed++;

ok(humanActingSupport(capable) === "supported", "declared-capable catalogue reports supported");
ok(humanActingSupport(incapable) === "vendor-incapable", "declared-incapable catalogue reports vendor-incapable");
ok(humanActingSupport(undeclared) === "undeclared", "undeclared catalogue reports undeclared (NOT vendor-incapable)");
ok(
  humanActingSupport(incapable) !== humanActingSupport(undeclared),
  "vendor-incapable and undeclared are different states — 'we haven't set it up' never collapses into 'the vendor cannot'",
);

const ALL_TYPES: readonly ConnectorCredentialType[] = ["api-key", "service-oauth", "user-oauth"];
for (const type of ALL_TYPES) {
  const bare: ConnectorCredential = { id: "legacy", type, secretRef: "X", broker: "env" };
  ok(grantFamilyOf(bare) === "install", `no grantFamily ⇒ "install" (${type})`);
  ok(!isHumanActing(bare), `no grantFamily ⇒ not human-acting (${type})`);
  ok(
    principalOfCredential(bare) === principalOf(type),
    `principalOfCredential agrees with principalOf for an install ${type} — no behaviour change to any existing path`,
  );
}
ok(isHumanActing({ grantFamily: "human-acting" }), "an explicit human-acting stamp is detected");

{
  const forged: ConnectorCredentials = {
    ...incapable,
    credentials: [...incapable.credentials, { id: "as-me", type: "api-key", secretRef: "X", broker: "env", grantFamily: "human-acting" }],
  };
  const msg = throwsWith(() => assertConnectorCredentialsValid([forged]), "human-acting on a vendor-incapable connector throws");
  ok(msg.includes("STRUCTURALLY INCAPABLE"), "the incapable refusal names the structural vendor limitation");
  ok(msg.includes("VENDOR limitation, not a configuration gap"), "the incapable refusal says configuration cannot fix it");
  ok(msg.includes("no scope combination"), "the incapable refusal quotes the declared vendor reason");
}
{
  const forged: ConnectorCredentials = {
    ...undeclared,
    credentials: [...undeclared.credentials, { id: "as-me", type: "api-key", secretRef: "X", broker: "env", grantFamily: "human-acting" }],
  };
  const msg = throwsWith(() => assertConnectorCredentialsValid([forged]), "human-acting on an UNDECLARED connector throws (fail closed)");
  ok(msg.includes("undeclared"), "the undeclared refusal says undeclared");
  ok(!msg.includes("STRUCTURALLY INCAPABLE"), "the undeclared refusal is a DIFFERENT error from the incapable one");
}
{
  const forged: ConnectorCredentials = {
    ...capable,
    credentials: [
      ...capable.credentials,
      { id: "as-me-oauth", type: "user-oauth", home: oauthConnectorHome("oauth/acme-user"), grantFamily: "human-acting" },
    ],
  };
  const msg = throwsWith(() => assertConnectorCredentialsValid([forged]), "human-acting on a type the vendor didn't declare throws");
  ok(msg.includes("distinct mint"), "the wrong-type refusal names the distinct-mint finding");
}

throwsWith(
  () => assertConnectorCredentialsValid([{ connector: "x", allows: ["api-key"], humanActing: { supported: true }, credentials: [] }]),
  "supported:true without credentialTypes throws",
);
throwsWith(
  () => assertConnectorCredentialsValid([{ connector: "x", allows: ["api-key"], humanActing: { supported: true, credentialTypes: ["user-oauth"] }, credentials: [] }]),
  "credentialTypes outside the allowlist throws",
);
throwsWith(
  () => assertConnectorCredentialsValid([{ connector: "x", allows: ["api-key"], humanActing: { supported: false }, credentials: [] }]),
  "supported:false without a recorded reason throws (the vendor fact must be captured, not just the verdict)",
);
throwsWith(
  () =>
    assertConnectorCredentialsValid([
      { connector: "x", allows: ["api-key"], humanActing: { supported: false, reason: "r", credentialTypes: ["api-key"] }, credentials: [] },
    ]),
  "supported:false listing credentialTypes throws (incapable means of ANY type)",
);

throwsWith(
  () =>
    assertConnectorCredentialsValid([
      { connector: "x", allows: ["api-key"], credentials: [{ id: "k", type: "api-key", secretRef: "K", broker: "env", lifecycle: { refresh: "sometimes" as never } }] },
    ]),
  "an unknown refresh posture throws",
);
throwsWith(
  () =>
    assertConnectorCredentialsValid([
      { connector: "x", allows: ["api-key"], credentials: [{ id: "k", type: "api-key", secretRef: "K", broker: "env", lifecycle: { refresh: "re-mint", ttlSeconds: 0 } }] },
    ]),
  "a non-positive ttlSeconds throws",
);
{
  const twoRhythms: ConnectorCredentials = {
    ...capable,
    credentials: [
      { id: "install-key", type: "api-key", secretRef: "A", broker: "env", lifecycle: { refresh: "re-mint", ttlSeconds: 30 * 24 * 60 * 60 } },
      { id: "as-me", type: "api-key", secretRef: "B", broker: "env", grantFamily: "human-acting", lifecycle: { refresh: "refresh-token", ttlSeconds: 24 * 60 * 60 } },
    ],
  };
  assertConnectorCredentialsValid([twoRhythms]);
  passed++;
  const install = twoRhythms.credentials.find((c) => c.id === "install-key")!;
  const human = twoRhythms.credentials.find((c) => c.id === "as-me")!;
  ok(
    install.lifecycle?.refresh === "re-mint" && human.lifecycle?.refresh === "refresh-token",
    "the two families carry independent refresh postures on the same connector (they are separate token families, not one with a flag)",
  );
}

{
  const install = expandConnectorGrant({ name: "acme", credential: "install-key" }, capable, { dm: false });
  ok(install.resolved?.secretRef === "ACME_INSTALL", "install grant resolves its OWN secret");
  ok(install.resolved?.grantFamily === "install", "install grant is stamped install-family");
  ok(install.resolved?.principal === "app", "install grant stays app-principal (channels + domains) — unchanged");

  const human = expandConnectorGrant({ name: "acme", credential: "as-me" }, capable, { dm: true });
  ok(human.resolved?.secretRef === "ACME_PERSONAL", "human-acting grant resolves its OWN, DIFFERENT secret");
  ok(human.resolved?.grantFamily === "human-acting", "human-acting grant is stamped human-acting-family");
  ok(
    install.resolved?.secretRef !== human.resolved?.secretRef,
    "the two families never share a secret ref — a second credential family, not a flag on the first",
  );
}

{
  const cred = capable.credentials.find((c) => c.id === "as-me")!;
  ok(principalOf(cred.type) === "app", "the TYPE axis alone would have called this static human-acting key APP-principal");
  ok(principalOfCredential(cred) === "user", "the GRANT FAMILY makes it USER-principal — the hole this axis closes");

  const onChannel = expandConnectorGrant({ name: "acme", credential: "as-me" }, capable, { dm: false });
  ok(onChannel.resolved === null, "a human-acting api-key is REFUSED on a channel/domain binding");
  ok(
    onChannel.warnings.some((w) => w.includes("personal credentials resolve only in DMs")),
    "the refusal is the existing DM-only universe gate (one rule, not a parallel one)",
  );
  ok(
    onChannel.warnings.some((w) => w.includes("human-acting")),
    "the warning names the human-acting grant, so an operator can see WHY an api-key was treated as personal",
  );

  const bundles: Bundle[] = [{ name: "b", connectors: [{ name: "acme", credential: "as-me", contentOrigin: "external" }] }];
  const bindings: Binding[] = [{ bundle: "b", scope: { level: "org" } }];
  const req: ResolveRequest = { mode: "channel", platform: "slack", workspace: "T1", channel: "C" };
  const eff = resolveAccess(req, bundles, bindings, {}, [capable]);
  ok(eff.connectorCredentials["acme"] === undefined, "resolveAccess binds NO credential for a human-acting grant on a channel");
}
{
  ok(offerableCredential(capable, "api-key")?.id === "install-key", "offerableCredential skips the human-acting credential and returns the INSTALL one");

  const humanFirst: ConnectorCredentials = { ...capable, credentials: [...capable.credentials].reverse() };
  ok(offerableCredential(humanFirst, "api-key")?.id === "install-key", "…and still returns the install one when the human-acting credential comes first");

  for (const mode of ["dm", "channel"] as const) {
    for (const isAdmin of [true, false]) {
      const opts = resolveConnectorOptions({ catalogue: capable, platform: "slack", mode, isAdmin, isOrgAdmin: isAdmin, hostWriteBroker: true });
      ok(
        opts.every((o) => o.credentialId !== "as-me"),
        `the connector card never offers the human-acting credential (mode=${mode}, admin=${isAdmin})`,
      );
    }
  }
}

console.log(`✓ human-acting: ${passed} assertions passed (grant families, vendor-incapable vs undeclared, lifecycle, DM-only non-circumvention)`);

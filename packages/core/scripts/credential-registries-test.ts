// proves: AP-MOD-core-credentials-ref

import assert from "node:assert/strict";

const {
  parseCredentialRef,
  registerRefCodec,
  resetRefCodecs,
  dbCredentialRef,
  DB_HOME,
} = await import("../agent/credentials/ref.js");
const {
  credentialHome,
  registeredCredentialHomes,
  resetCredentialHomes,
  hostWriteHomeAvailable,
} = await import("../agent/credentials/home.js");
type CredentialHome = import("../agent/credentials/home.js").CredentialHome;
const { assertConnectorCredentialsValid, registerExclusiveCredentialHome, resetExclusiveCredentialHomes } = await import(
  "../agent/access/connector-credentials.js"
);

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  const db = parseCredentialRef(dbCredentialRef("notion", "team-key"));
  ok(db?.home === DB_HOME && db.connector === "notion" && db.credentialId === "team-key", "parseCredentialRef: a db ref → { home:'db', connector, credentialId }");

  ok(parseCredentialRef("NOTION_API_KEY") === null, "parseCredentialRef: a bare env-var-name ref → null (home is the broker:'env' stamp)");
  ok(parseCredentialRef("") === null, "parseCredentialRef: empty string → null");
  ok(parseCredentialRef("toolhive:acme:widget") === null, "parseCredentialRef: an unregistered vendor prefix → null (fail-safe skip)");

  registerRefCodec({
    home: "toolhive",
    parse: (ref) => {
      if (!ref.startsWith("toolhive:")) return null;
      const [server, tool] = ref.slice("toolhive:".length).split(":");
      return server && tool ? { server, tool } : null;
    },
  });
  const th = parseCredentialRef("toolhive:acme:widget");
  ok(th?.home === "toolhive" && th.server === "acme" && th.tool === "widget", "parseCredentialRef: a registered vendor codec routes automatically → { home:'toolhive', ... }");

  resetRefCodecs();
  ok(parseCredentialRef("toolhive:acme:widget") === null, "resetRefCodecs: forgets the vendor codec (restores only the core db codec)");
  ok(parseCredentialRef(dbCredentialRef("p", "c"))?.home === DB_HOME, "resetRefCodecs: the core db codec is restored");
}

{
  await import("../agent/credentials/db-broker.js");
  ok(credentialHome(DB_HOME) !== undefined, "credentialHome: the db home self-registered at module load");
  ok(credentialHome("nope") === undefined, "credentialHome: an unregistered home is undefined (caller fails closed — no silent fallback)");

  const fake = (name: string, hw: boolean): CredentialHome => ({ name, hostWriteAvailable: () => hw, store: async () => {} });
  ok(hostWriteHomeAvailable([fake("a", false), fake("b", false)]) === false, "hostWriteHomeAvailable: all homes non-host-write ⇒ false");
  ok(hostWriteHomeAvailable([fake("a", false), fake("b", true)]) === true, "hostWriteHomeAvailable: any host-write home ⇒ true");
  ok(hostWriteHomeAvailable([]) === false, "hostWriteHomeAvailable: empty ⇒ false (fail closed)");

  ok(registeredCredentialHomes().some((h) => h.name === DB_HOME), "registeredCredentialHomes: includes the db home");

  resetCredentialHomes();
  ok(registeredCredentialHomes().length === 0, "resetCredentialHomes: clears the registry");
}

{
  const provider = (cred: Record<string, unknown>) => [
    { connector: "acme", allows: ["api-key"] as const, credentials: [cred as never] },
  ];

  registerExclusiveCredentialHome({
    name: "vaultx",
    validFor: ["api-key"],
    validateConfig: (config, where) => {
      if (typeof (config as { server?: unknown }).server !== "string" || !(config as { server?: string }).server) {
        throw new Error(`${where}: vaultx home needs a server`);
      }
    },
  });

  assertConnectorCredentialsValid(provider({ id: "k", type: "api-key", home: { kind: "vaultx", config: { server: "acme" } } }) as never);
  ok(true, "exclusive-home registry: a vaultx-homed api-key (no stamps) validates — ZERO edits to ConnectorCredential's type or assertConnectorCredentialsValid");

  assert.throws(
    () => assertConnectorCredentialsValid(provider({ id: "k", type: "api-key", home: { kind: "vaultx", config: { server: "acme" } }, broker: "db" }) as never),
    /must NOT carry a broker/,
    "exclusive-home registry: vaultx + broker is rejected (mutual exclusivity)",
  );
  n++;

  assert.throws(
    () => assertConnectorCredentialsValid(provider({ id: "k", type: "api-key", home: { kind: "vaultx", config: { server: "" } } }) as never),
    /vaultx home needs a server/,
    "exclusive-home registry: a malformed vaultx home is rejected by its validateConfig",
  );
  n++;

  assert.throws(
    () => assertConnectorCredentialsValid([{ connector: "acme", allows: ["user-oauth"], credentials: [{ id: "k", type: "user-oauth", home: { kind: "vaultx", config: { server: "acme" } } }] }] as never),
    /cannot be homed at "vaultx"/,
    "exclusive-home registry: a vaultx home on a disallowed type is rejected (validFor)",
  );
  n++;

  resetExclusiveCredentialHomes();
  assert.throws(
    () => assertConnectorCredentialsValid(provider({ id: "k", type: "api-key", home: { kind: "vaultx", config: { server: "acme" } } }) as never),
    /unknown credential home kind "vaultx"/,
    "resetExclusiveCredentialHomes: the vendor home is forgotten (the core oauth home remains)",
  );
  n++;
}

console.log(`credential-registries-test: ${n} checks passed`);

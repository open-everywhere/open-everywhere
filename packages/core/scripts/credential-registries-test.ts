import assert from "node:assert/strict";

const {
  parseCredentialRef,
  registerRefCodec,
  resetRefCodecs,
  dbCredentialRef,
  executorCredentialRef,
  DB_HOME,
  EXECUTOR_HOME,
} = await import("../agent/credentials/ref.js");
const {
  credentialHome,
  registeredCredentialHomes,
  resetCredentialHomes,
  hostWriteHomeAvailable,
} = await import("../agent/credentials/home.js");
type CredentialHome = import("../agent/credentials/home.js").CredentialHome;
const execStore = await import("../agent/credentials/executor-store.js");
const { assertProvidersValid, registerExclusiveCredentialHome, resetExclusiveCredentialHomes } = await import(
  "../agent/access/providers.js"
);

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  const db = parseCredentialRef(dbCredentialRef("notion", "team-key"));
  ok(db?.home === DB_HOME && db.provider === "notion" && db.credentialId === "team-key", "parseCredentialRef: a db ref → { home:'db', provider, credentialId }");

  const ex = parseCredentialRef(executorCredentialRef("notion-mcp", "org", "oe-team"));
  ok(ex?.home === EXECUTOR_HOME && ex.integration === "notion-mcp" && ex.owner === "org" && ex.connection === "oe-team", "parseCredentialRef: an executor ref → { home:'executor', integration, owner, connection }");

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
  ok(parseCredentialRef("toolhive:acme:widget") === null, "resetRefCodecs: forgets the vendor codec (restores only the core db + executor pair)");
  ok(parseCredentialRef(dbCredentialRef("p", "c"))?.home === DB_HOME, "resetRefCodecs: the core db codec is restored");
}

{
  await import("../agent/credentials/db-broker.js");
  ok(credentialHome(DB_HOME) !== undefined, "credentialHome: the db home self-registered at module load");
  ok(credentialHome(EXECUTOR_HOME) !== undefined, "credentialHome: the executor home self-registered at module load");
  ok(credentialHome("nope") === undefined, "credentialHome: an unregistered home is undefined (caller fails closed — no silent fallback)");

  const fake = (name: string, hw: boolean): CredentialHome => ({ name, hostWriteAvailable: () => hw, store: async () => {} });
  ok(hostWriteHomeAvailable([fake("a", false), fake("b", false)]) === false, "hostWriteHomeAvailable: all homes non-host-write ⇒ false");
  ok(hostWriteHomeAvailable([fake("a", false), fake("b", true)]) === true, "hostWriteHomeAvailable: any host-write home ⇒ true");
  ok(hostWriteHomeAvailable([]) === false, "hostWriteHomeAvailable: empty ⇒ false (fail closed)");

  execStore.resetExecutorConnectionStore();
  await assert.rejects(
    () => credentialHome(EXECUTOR_HOME)!.store({ org: "o", ref: "executor:notion-mcp:org:oe-x", plaintext: "v", createdBy: "u", parsed: { integration: "notion-mcp", owner: "org", connection: "oe-x" } }),
    /no Executor connection store is registered/,
    "executor home: store() with no store registered/injected throws (fail closed, never db)",
  );

  const creates: unknown[] = [];
  await credentialHome(EXECUTOR_HOME)!.store({
    org: "o",
    ref: "executor:notion-mcp:org:oe-x",
    plaintext: "v",
    createdBy: "u",
    parsed: { integration: "notion-mcp", owner: "org", connection: "oe-x" },
    deps: { executorStore: { createConnection: async (p: unknown) => void creates.push(p) } },
  });
  ok(creates.length === 1, "executor home: a per-call deps.executorStore override drives createConnection (the intake seam)");

  ok(registeredCredentialHomes().some((h) => h.name === EXECUTOR_HOME), "registeredCredentialHomes: includes the executor home");

  resetCredentialHomes();
  ok(registeredCredentialHomes().length === 0, "resetCredentialHomes: clears the registry");
}

{
  const provider = (cred: Record<string, unknown>) => [
    { name: "acme", connection: "acme", allows: ["api-key"] as const, credentials: [cred as never] },
  ];

  registerExclusiveCredentialHome({
    name: "toolhive",
    declares: (c) => (c as { toolhive?: unknown }).toolhive !== undefined,
    validateShape: (c, where) => {
      const t = (c as { toolhive?: { server?: string } }).toolhive;
      if (!t?.server) throw new Error(`${where}: toolhive home needs a server`);
    },
  });

  assertProvidersValid(provider({ id: "k", type: "api-key", toolhive: { server: "acme" } }) as never);
  ok(true, "exclusive-home registry: a toolhive-homed api-key (no stamps) validates — no edit to assertProvidersValid");

  assert.throws(
    () => assertProvidersValid(provider({ id: "k", type: "api-key", toolhive: { server: "acme" }, broker: "db" }) as never),
    /must NOT carry a broker/,
    "exclusive-home registry: toolhive + broker is rejected (mutual exclusivity)",
  );
  n++;

  assert.throws(
    () => assertProvidersValid(provider({ id: "k", type: "api-key", toolhive: { server: "" } }) as never),
    /toolhive home needs a server/,
    "exclusive-home registry: a malformed toolhive home is rejected by its validateShape",
  );
  n++;

  resetExclusiveCredentialHomes();
  assert.throws(
    () => assertProvidersValid(provider({ id: "k", type: "api-key", toolhive: { server: "acme" } }) as never),
    /api-key needs a secretRef/,
    "resetExclusiveCredentialHomes: the vendor home is forgotten (the core executor home remains)",
  );
  n++;
}

console.log(`credential-registries-test: ${n} checks passed`);

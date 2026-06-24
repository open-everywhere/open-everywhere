import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(root, rel)).href;
const container = await import(abs("dist/src/context/container.js"));
const keys = await import(abs("dist/src/context/keys.js"));
const runtimeKeys = await import(abs("dist/src/runtime/sessions/runtime-context-keys.js"));

ok(typeof container.ContextContainer === "function", "eve still exports ContextContainer (ALS scope builder)");
ok(typeof container.contextStorage?.run === "function", "eve still exports contextStorage with .run()");
ok(keys.AuthKey !== undefined && keys.InitiatorAuthKey !== undefined, "eve still exports AuthKey + InitiatorAuthKey");
ok(runtimeKeys.ChannelKey !== undefined, "eve still exports ChannelKey");

const slackAuth = {
  principalType: "service",
  principalId: "U_caller",
  authenticator: "slack",
  attributes: {
    team_id: "T_TEAM",
    channel_id: "C_GRANTED",
    channel_type: "channel",
    is_private: "false",
    user_id: "U_caller",
  },
};

const scope = await import("../agent/access/connector-scope.js");

function withScope<T>(auth: unknown, channelKind: string | undefined, fn: () => Promise<T>): Promise<T> {
  const store = new container.ContextContainer();
  store.set(keys.AuthKey, auth);
  store.set(keys.InitiatorAuthKey, auth);
  if (channelKind !== undefined) store.set(runtimeKeys.ChannelKey, { kind: channelKind });
  return container.contextStorage.run(store, fn);
}

ok((await scope.grantedConnectors()) === null, "no eve session scope -> grantedConnectors() is null (fail closed)");
{
  let threw = false;
  try {
    await scope.assertConnectorGranted("notion");
  } catch (e) {
    threw = e instanceof scope.ConnectorScopeError;
  }
  ok(threw, "no scope -> assertConnectorGranted throws ConnectorScopeError");
}

const resolved = await withScope(slackAuth, "slack", () => scope.grantedConnectors());
ok(resolved !== null, "inside an eve scope with AuthKey+ChannelKey, the surface resolves (NOT null) — the internal plumbing works");
ok(Array.isArray(resolved), "grantedConnectors returns the resolver's connector array for the resolved surface");

{
  const empty = await container.contextStorage.run(new container.ContextContainer(), () => scope.grantedConnectors());
  ok(empty === null, "scope with no AuthKey -> null (fail closed on unauthenticated session)");
}

{
  let threw = false;
  let msg = "";
  try {
    await withScope(slackAuth, "slack", () => scope.assertConnectorGranted("notion"));
  } catch (e) {
    threw = e instanceof scope.ConnectorScopeError;
    msg = (e as Error).message;
  }
  ok(threw, "a surface without a notion grant -> assertConnectorGranted throws");
  ok(msg.includes("not granted"), "denial message explains the surface lacks the grant");
}

console.log(`✓ connector-scope: ${passed} assertions passed`);

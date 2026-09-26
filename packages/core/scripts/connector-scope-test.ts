// proves: AP-MOD-core-access-connector-scope

import "./_register-test-config.js";
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
const runtimeKeys = await import(abs("dist/src/runtime/sessions/runtime-context-keys.js"));

ok(typeof container.ContextContainer === "function", "eve still exports ContextContainer (ALS scope builder)");
ok(typeof container.contextStorage?.run === "function", "eve still exports contextStorage with .run()");
ok(runtimeKeys.ChannelKey !== undefined, "eve still exports ChannelKey");

const scope = await import("../agent/access/connector-scope.js");

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

function withChannelScope<T>(channelKind: string | undefined, fn: () => Promise<T>): Promise<T> {
  const store = new container.ContextContainer();
  if (channelKind !== undefined) store.set(runtimeKeys.ChannelKey, { kind: channelKind });
  return container.contextStorage.run(store, fn);
}

const noAuth = { current: null, initiator: null };
ok((await scope.grantedConnectors(noAuth)) === null, "no auth identity on the ctx -> grantedConnectors() is null (fail closed)");
{
  let threw = false;
  try {
    await scope.assertConnectorGranted("notion", noAuth);
  } catch (e) {
    threw = e instanceof scope.ConnectorScopeError;
  }
  ok(threw, "no auth identity -> assertConnectorGranted throws ConnectorScopeError");
}

{
  const authOnly = { current: slackAuth, initiator: slackAuth };
  const resolved = await scope.grantedConnectors(authOnly);
  ok(resolved !== null, "auth passed directly with NO ALS scope -> the surface still resolves (NOT null)");
  ok(Array.isArray(resolved), "grantedConnectors returns the resolver's connector array for the resolved surface");
}

{
  const authOnly = { current: slackAuth, initiator: slackAuth };
  const resolved = await withChannelScope("slack", () => scope.grantedConnectors(authOnly));
  ok(resolved !== null, "auth passed directly + a ChannelKey ALS scope -> still resolves");
}

{
  const currentOnly = { current: slackAuth, initiator: null };
  const resolved = await scope.grantedConnectors(currentOnly);
  ok(resolved !== null, "initiator omitted (null) -> falls back to current, still resolves");
}

{
  let threw = false;
  let msg = "";
  try {
    await scope.assertConnectorGranted("notion", { current: slackAuth, initiator: slackAuth });
  } catch (e) {
    threw = e instanceof scope.ConnectorScopeError;
    msg = (e as Error).message;
  }
  ok(threw, "a surface without a notion grant -> assertConnectorGranted throws");
  ok(msg.includes("not granted"), "denial message explains the surface lacks the grant");
}

console.log(`✓ connector-scope: ${passed} assertions passed`);

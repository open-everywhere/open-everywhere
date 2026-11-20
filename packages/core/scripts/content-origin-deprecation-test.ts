import assert from "node:assert/strict";
import {
  connectionSearchRows,
  declaredContentOriginForConnection,
  declaredContentOriginForConnectionSearch,
  declaredContentOriginForExecuteTarget,
  declaredContentOriginForToolName,
  setConnectorContentOrigin,
  type ConnectorContentOriginMap,
} from "../agent/access/connector-content-origin-state.js";
import { TAINTED_CONNECTOR_ORIGIN_ADVICE, unattendedConnectorRefusalMessage } from "../agent/connections/connector-auth.js";
import { _resetContentOriginNoticeForTest, assertBundlesValid, type Bundle, type ConnectorContentOriginSpec } from "../agent/access/bundle.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const stamp: ConnectorContentOriginMap = { notion: "internal", helpdesk: { default: "internal", except: { search: "external" } } };
setConnectorContentOrigin(stamp);
ok(declaredContentOriginForConnection("notion") === undefined, "1. a stamped connection answers undefined — the shim stores nothing");
ok(declaredContentOriginForToolName("notion__search") === undefined, "1. the by-name lookup answers undefined");
ok(declaredContentOriginForExecuteTarget({ connection: "notion", tool: "search" } as never) === undefined, "1. the execute-target lookup answers undefined");
ok(
  declaredContentOriginForConnectionSearch({ tools: [{ connection: "notion", tool: "search", description: "d", signature: "s" }], total: 1 }) === undefined,
  "1. the search lookup answers undefined",
);

ok(connectionSearchRows({ tools: [{ connection: "notion", tool: "x" }], total: 1 })?.length === 1, "2. …and it still decomposes an eve 0.71 result");
ok(connectionSearchRows({ tools: [], total: 0, extra: 1 }) === undefined, "2. …and still fails closed on an unknown key");

ok(typeof TAINTED_CONNECTOR_ORIGIN_ADVICE === "string" && TAINTED_CONNECTOR_ORIGIN_ADVICE.length > 0, "3. TAINTED_CONNECTOR_ORIGIN_ADVICE still resolves for a consumer import");
for (const refusal of [unattendedConnectorRefusalMessage("notion", "notion__create_page", "write"), unattendedConnectorRefusalMessage("notion", "notion__create_page", "write", true)]) {
  ok(!refusal.includes(TAINTED_CONNECTOR_ORIGIN_ADVICE) && !refusal.includes("contentOrigin"), "3. 🔴 no unattended refusal advises declaring contentOrigin (the taint argument is ignored since OPE-2718)");
  ok(refusal.includes("The op did not run."), "3. …and the refusal itself is unchanged in shape");
}

const spellings: ConnectorContentOriginSpec[] = ["internal", "external", { default: "internal", except: { search_tickets: "external" } }];
const consumer: Bundle[] = spellings.map((contentOrigin, i) => ({ name: `consumer-${i}`, connectors: [{ name: `c${i}`, credential: "k", contentOrigin }] }));
const realWarn = console.warn;
const warned: string[] = [];
console.warn = (line: unknown) => void warned.push(String(line));
try {
  _resetContentOriginNoticeForTest();
  assertBundlesValid(consumer);
} finally {
  console.warn = realWarn;
  _resetContentOriginNoticeForTest();
}
ok(true, "4. a consumer bundle with contentOrigin on every grant type-checks against the public Bundle type and validates");
ok(warned.length === 1 && warned[0]!.includes("consumer-0/c0") && warned[0]!.includes("consumer-2/c2"), "4. …with ONE deprecation notice that names every grant");

console.log(`✓ content-origin-deprecation: ${n} assertions passed`);

// proves: AP-MOD-core-access-connector-content-origin-state

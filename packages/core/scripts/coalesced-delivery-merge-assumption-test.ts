import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  mintWakeId,
  stampUnifiedWindowAuth,
  OE_DELIVERY_ID_ATTR,
  OE_WAKE_ID_ATTR,
} from "../agent/channels/unified-window.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const RETURN_NOTE =
  " 🔴 IF THIS FAILED: eve can now batch OE deliveries — the coalesced-turn live leg S-APPROVAL-COALESCED" +
  " (retired at OPE-2041; `git log -S S-APPROVAL-COALESCED` finds the commit that removed it) and" +
  " ambient-eval S7 (`coalesced_turn_correctness`, refused by `parseSeries` for this same reason)" +
  " must RETURN. Read the eve CHANGELOG entry for the bump and the stamps in" +
  " `agent/channels/unified-window.ts` before changing anything here.";

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const EVE_VERSION = (require("eve/package.json") as { version: string }).version;
const { jsonValuesEqual } = (await import(
  pathToFileURL(join(eveRoot, "dist/src/shared/json.js")).href
)) as { jsonValuesEqual: (a: unknown, b: unknown) => boolean };

ok(typeof jsonValuesEqual === "function", `eve ${EVE_VERSION}'s jsonValuesEqual is reachable in the installed dist.${RETURN_NOTE}`);

interface WireAuth {
  readonly principalType: string;
  readonly principalId: string;
  readonly authenticator: string;
  readonly subject: string;
  readonly attributes: Record<string, unknown>;
}

const PROVIDER_AUTH: WireAuth = {
  principalType: "user",
  principalId: "U_ASKER",
  authenticator: "slack",
  subject: "U_ASKER",
  attributes: { slack_team: "T_ACME" },
};

const WINDOW_TOKEN = "sess_unified_window_token";
const REPLY_ANCHOR = "1700159720.000100";

const deliveryAuth = (wakeId: string, deliveryId: string) =>
  stampUnifiedWindowAuth(PROVIDER_AUTH, "slack", wakeId, "direct-mention", ["slack"], WINDOW_TOKEN, REPLY_ANCHOR, deliveryId);

const askWakeId = mintWakeId();
const asideWakeId = mintWakeId();
const first = deliveryAuth(askWakeId, mintWakeId());
const second = deliveryAuth(asideWakeId, mintWakeId());

ok(askWakeId !== asideWakeId, `two ingresses mint two different wake ids.${RETURN_NOTE}`);

const differingAttributeKeys = (a: Record<string, unknown>, b: Record<string, unknown>): string[] => {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => !jsonValuesEqual(a[k], b[k]));
};

const differing = differingAttributeKeys(first.attributes, second.attributes);

ok(
  jsonValuesEqual(first, second) === false,
  `eve ${EVE_VERSION}'s OWN jsonValuesEqual answers FALSE for two deliveries on one unified window, so the batch rule refuses them (they differ in [${differing.join(", ")}]).${RETURN_NOTE}`,
);

ok(
  differing.join(",") === [OE_DELIVERY_ID_ATTR, OE_WAKE_ID_ATTR].sort().join(","),
  `the two deliveries' auth attributes differ in EXACTLY ${OE_WAKE_ID_ATTR} and ${OE_DELIVERY_ID_ATTR} — got [${differing.join(", ")}].${RETURN_NOTE}`,
);

const candidateIsAuthenticated = first != null && first.principalType !== "anonymous";
ok(candidateIsAuthenticated, `the first delivery is the AUTHENTICATED case, which is the arm eve's batch rule is about.${RETURN_NOTE}`);
ok(
  (!candidateIsAuthenticated || !jsonValuesEqual(first, second)) === true,
  `eve's own merge loop BREAKS on the second delivery, so the two run as two turns.${RETURN_NOTE}`,
);

ok(jsonValuesEqual(first, first) === true, "🔴 NEGATIVE CONTROL: eve's predicate answers TRUE for one bag against itself, so it is capable of saying yes");

const withoutPerDeliveryStamps = (auth: typeof first) => {
  const attributes = { ...auth.attributes };
  delete attributes[OE_WAKE_ID_ATTR];
  delete attributes[OE_DELIVERY_ID_ATTR];
  return { ...auth, attributes };
};
ok(
  jsonValuesEqual(withoutPerDeliveryStamps(first), withoutPerDeliveryStamps(second)) === true,
  "🔴 NEGATIVE CONTROL: strip ONLY the two per-delivery stamps and the same two deliveries compare EQUAL — so it is those stamps that refuse the merge, not some other field of the bag",
);

const sameWakeDifferentDelivery = deliveryAuth(askWakeId, mintWakeId());
ok(
  jsonValuesEqual(first, sameWakeDifferentDelivery) === false,
  `🔴 two deliveries sharing ONE wake id still refuse to batch, because ${OE_DELIVERY_ID_ATTR} is minted per delivery.${RETURN_NOTE}`,
);

console.log(
  `✓ coalesced-delivery merge assumption: ${n} assertions passed — eve ${EVE_VERSION} cannot batch two OE deliveries ` +
    `on one unified window (OE's real stampUnifiedWindowAuth vs eve's real jsonValuesEqual; they differ in ${differing.join(", ")})`,
);

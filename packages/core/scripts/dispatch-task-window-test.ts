import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-dispatch-task-window-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { unifiedSupervisorToken } from "../agent/channels/unified-supervisor.js";
import {
  mintWakeId,
  unifiedThreadRef,
  OE_GRAIN_ATTR,
  OE_PLATFORM_ATTR,
  OE_TASK_LABEL_ATTR,
  type UnifiedWakeOrigin,
} from "../agent/channels/unified-window.js";
import { divertToUnifiedWindow, dispatchTaskWindow, OE_SPAWN_TAINTED_ATTR, type UnifiedReceiveTarget } from "../agent/channels/unified.js";
import { truncateTaskLabel } from "../agent/channels/turn-delivery.js";
import { parseWindowToken, isTaskWindowToken, taskWindowId, formatWindowToken } from "../agent/channels/window-key.js";
import type { RouteHandlerArgs } from "eve/channels";

import { registerSlackFixtureMapper, registerSlackFixtureCodec } from "./_slack-test-stubs.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
registerSlackFixtureMapper();
registerSlackFixtureCodec();


let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const SLACK_KEY = "slack/T_SPN/C_SPNA";
const GH_KEY = "github/acme/payments-api";
const spawnDomain = defineDomain({
  name: "payments",
  channels: [SLACK_KEY, GH_KEY],
  ambientSupervisor: true,
  mode: "unified",
});
const orgBoth = defineDomain({ name: "org", match: "org" });
overrideSettingsForTest({ window: { topology: true } });
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [spawnDomain, orgBoth],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (["C_SPNA", "payments-api"].includes(surface) ? ["payments"] : []),
});

console.log("1. unifiedThreadRef derivation:");
eq(unifiedThreadRef({ platform: "slack", channelId: "C1", threadTs: "170.5" }), { channelKey: "slack/C1", threadKey: "170.5" }, "slack: threaded ⇒ threadKey is the threadTs");
eq(unifiedThreadRef({ platform: "slack", channelId: "C1" }), { channelKey: "slack/C1", threadKey: "C1" }, "slack: top-level ⇒ threadKey falls back to the channel id");

const ref = unifiedThreadRef({ platform: "slack", channelId: "C_SPNA", threadTs: "1720000000.001" });
const taskToken = formatWindowToken({ domain: "payments", windowId: taskWindowId(ref.channelKey, ref.threadKey), generation: 6 });
ok(isTaskWindowToken(taskToken), "the minted token classifies as a task window token");
eq(parseWindowToken(taskToken)?.domain, "payments", "the minted task token still anchors its domain");
eq(parseWindowToken(taskToken)?.generation, 6, "the minted task token carries the parent generation");

console.log("2. dispatchTaskWindow (async delivery + taint-forward):");
interface Received {
  message: string;
  target: UnifiedReceiveTarget;
  auth: { attributes?: Record<string, unknown> };
}
const received: Received[] = [];
const captureReceive = ((_ch: unknown, target: unknown) => ({
  async send(message: string, options: { auth: unknown }) {
    received.push({ message, target: target as UnifiedReceiveTarget, auth: options.auth as Received["auth"] });
    return {} as never;
  },
})) as unknown as RouteHandlerArgs["to"];

const slackOrigin: UnifiedWakeOrigin = { platform: "slack", channelId: "C_SPNA", threadTs: "1720000000.001" };

await divertToUnifiedWindow(captureReceive, {
  message: "prime",
  token: unifiedSupervisorToken("payments", 1),
  window: { wakeId: mintWakeId(), origin: slackOrigin },
  surfaceKey: SLACK_KEY,
  auth: { attributes: {} },
});
ok(received.length === 1, "priming divert landed one wake");
received.length = 0;

await dispatchTaskWindow({
  token: taskToken,
  message: "do the thing",
  wakeId: mintWakeId(),
  domain: "payments",
  origin: slackOrigin,
  parentAuthAttributes: { [OE_PLATFORM_ATTR]: "slack", some: "carried" },
  tainted: true,
});
ok(received.length === 1, "dispatchTaskWindow dispatched exactly once (non-blocking, returns after handing off)");
eq(received[0].target.token, taskToken, "dispatched on the TASK window token");
ok(received[0].auth.attributes?.[OE_SPAWN_TAINTED_ATTR] === "true", "tainted parent ⇒ child auth carries the oe_spawn_tainted stamp");
ok(received[0].auth.attributes?.some === "carried", "parent auth attributes are forwarded verbatim (egress/capability inheritance)");
ok(received[0].target.origin.platform === "slack", "the child owns the SAME origin thread the parent was handling");

received.length = 0;
await dispatchTaskWindow({
  token: taskToken,
  message: "do the thing",
  wakeId: mintWakeId(),
  domain: "payments",
  origin: slackOrigin,
  parentAuthAttributes: {},
  tainted: false,
});
ok(received[0].auth.attributes?.[OE_SPAWN_TAINTED_ATTR] === undefined, "untainted parent ⇒ NO taint stamp on the child auth");

console.log("2b. dispatchTaskWindow taskLabel stamp (OPE-508):");
received.length = 0;
await dispatchTaskWindow({
  token: taskToken,
  message: "do the thing",
  wakeId: mintWakeId(),
  domain: "payments",
  origin: slackOrigin,
  parentAuthAttributes: {},
  tainted: false,
  taskLabel: "Investigate the deploy failure",
});
eq(received[0].auth.attributes?.[OE_TASK_LABEL_ATTR], "Investigate the deploy failure", "a supplied taskLabel is stamped verbatim onto the child's opening auth");

received.length = 0;
await dispatchTaskWindow({
  token: taskToken,
  message: "do the thing",
  wakeId: mintWakeId(),
  domain: "payments",
  origin: slackOrigin,
  parentAuthAttributes: {},
  tainted: false,
});
ok(!("oe_task_label" in (received[0].auth.attributes ?? {})), "omitting taskLabel leaves the oe_task_label key genuinely ABSENT from the child's auth (not stamped blank)");

{
  const longBrief = "Investigate why the nightly deploy pipeline\nkeeps failing on the payments-api canary stage and fix the root cause, not just the symptom.";
  const label = truncateTaskLabel(longBrief);
  ok(!label.includes("\n"), "truncateTaskLabel collapses a multi-line brief to one line");
  ok(label.length <= 60, "truncateTaskLabel caps at the default 60 chars");
  ok(label.endsWith("…"), "an over-length brief's label ends with the ellipsis marker");
  eq(truncateTaskLabel("short"), "short", "a brief already under the cap passes through unchanged");
}

console.log("2c. dispatchTaskWindow who-asked stamp (OPE-675):");
{
  const { OE_REQUESTER_ATTR, REQUESTER_UNVERIFIED } = await import("../agent/access/requester-identity.js");

  received.length = 0;
  await dispatchTaskWindow({
    token: taskToken,
    message: "do the thing",
    wakeId: mintWakeId(),
    domain: "payments",
    origin: slackOrigin,
    parentAuthAttributes: {},
    tainted: false,
  });
  eq(
    received[0].auth.attributes?.[OE_REQUESTER_ATTR],
    REQUESTER_UNVERIFIED,
    "🔴 a dispatch from a turn with no verified asker still STAMPS `oe/unverified` — an absent stamp is what would let the worker parse its own brief",
  );

  received.length = 0;
  await dispatchTaskWindow({
    token: taskToken,
    message: "do the thing",
    wakeId: mintWakeId(),
    domain: "payments",
    origin: slackOrigin,
    parentAuthAttributes: { [OE_REQUESTER_ATTR]: "U_PREVIOUS_ASKER" },
    tainted: false,
  });
  ok(
    received[0].auth.attributes?.[OE_REQUESTER_ATTR] !== "U_PREVIOUS_ASKER",
    "🔴 a stale asker forwarded in the parent's bag does NOT survive the dispatch — the stamp is re-derived, never inherited",
  );
  eq(received[0].auth.attributes?.[OE_REQUESTER_ATTR], REQUESTER_UNVERIFIED, "…and what replaces it is the honest `oe/unverified`, not a blank");

  ok(received[0].auth.attributes?.[OE_GRAIN_ATTR] === "task", "negative control: the fixture does carry a stamped attribute through, so the overwrite assertions are not vacuous");
}

console.log("2d. dispatchTaskWindow candidate-set stamp (OPE-683):");
{
  const { OE_REQUESTER_ATTR, OE_REQUESTER_CANDIDATES_ATTR, REQUESTER_UNVERIFIED } = await import("../agent/access/requester-identity.js");

  received.length = 0;
  await dispatchTaskWindow({
    token: taskToken,
    message: "do the thing",
    wakeId: mintWakeId(),
    domain: "payments",
    origin: slackOrigin,
    parentAuthAttributes: { [OE_REQUESTER_CANDIDATES_ATTR]: JSON.stringify(["U_ORG_A", "U_ORG_B"]) },
    tainted: false,
  });
  ok(
    received[0].auth.attributes?.[OE_REQUESTER_CANDIDATES_ATTR] === undefined,
    "🔴 a stale candidate list forwarded in the parent's bag is DELETED, never forwarded — the all-candidates rule must not read another turn's askers",
  );
  eq(
    received[0].auth.attributes?.[OE_REQUESTER_ATTR],
    REQUESTER_UNVERIFIED,
    "…while the who-asked stamp beside it is still written, so the worker refuses rather than reading its own brief",
  );

  received.length = 0;
  await dispatchTaskWindow({
    token: taskToken,
    message: "do the thing",
    wakeId: mintWakeId(),
    domain: "payments",
    origin: slackOrigin,
    parentAuthAttributes: { [OE_REQUESTER_CANDIDATES_ATTR]: JSON.stringify(["U_ORG_A", "U_ORG_B"]), oe_unrelated_probe: "kept" },
    tainted: false,
  });
  ok(
    received[0].auth.attributes?.["oe_unrelated_probe"] === "kept",
    "negative control: an unrelated forwarded attribute DOES survive the dispatch, so the delete above is targeted rather than vacuous",
  );
  ok(
    received[0].auth.attributes?.[OE_REQUESTER_CANDIDATES_ATTR] === undefined,
    "…and the candidate list is still gone in the same delivery — the delete is specific to the permissive key",
  );
}

console.log(`dispatch-task-window-test: ${n} assertions passed`);

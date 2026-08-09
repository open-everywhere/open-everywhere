import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-spawn-task-")), "ops.sqlite3");
delete process.env.OE_ORG;

import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { unifiedSupervisorToken } from "../agent/channels/unified-supervisor.js";
import {
  mintWakeId,
  unifiedThreadRef,
  OE_PLATFORM_ATTR,
  type UnifiedWakeOrigin,
} from "../agent/channels/unified-window.js";
import { divertToUnifiedWindow, dispatchTaskWindow, OE_SPAWN_TAINTED_ATTR, type UnifiedReceiveTarget } from "../agent/channels/unified.js";
import { parseWindowToken, isTaskWindowToken, taskWindowId, formatWindowToken, dmAnchorDomain, dmWindowKey } from "../agent/channels/window-key.js";
import spawnTask from "../agent/tools/spawn_task.js";
import { resolveWindowGated } from "../agent/access/window-gated.js";
import type { RouteHandlerArgs } from "eve/channels";

import { registerSlackFixtureMapper, registerSlackFixtureCodec } from "./_slack-test-stubs.js";
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
process.env.OE_WINDOW_TOPOLOGY = "1";
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

console.log("3. spawn_task structural guards:");
const standingCtx = { channel: { kind: "unified", continuationToken: unifiedSupervisorToken("payments", 1) }, session: { auth: { current: { attributes: {} } } } };
const tool = (await resolveWindowGated(spawnTask, standingCtx as never)) as { execute: (input: { brief: string; thread?: string }, ctx: unknown) => Promise<unknown> };

eq(await resolveWindowGated(spawnTask, { channel: { kind: "unified", continuationToken: `unified:${taskToken}` }, session: { auth: { current: { attributes: { oe_grain: "task" } } } } } as never), null, "a task-grain session resolves NO spawn_task (structurally absent)");

await assert.rejects(
  () => tool.execute({ brief: "x" }, { channel: { kind: "unified", continuationToken: `unified:${taskToken}` }, session: {} }),
  /not available on a task session/,
  "a task worker (task token) is refused at execute — the grain backstop",
);
n++;
await assert.rejects(
  () => tool.execute({ brief: "x" }, { channel: { kind: "unified", continuationToken: `unified:${taskToken}` }, session: { auth: { current: { attributes: { oe_grain: "standing" } } } } }),
  /cannot spawn further tasks/,
  "a standing-stamped task token is still refused by the Stage-A recursion guard (defence-in-depth)",
);
n++;
await assert.rejects(
  () => tool.execute({ brief: "x" }, { channel: { kind: "slack", continuationToken: "C_SPNA:oe-sup:g1" }, session: {} }),
  /standing window seat/,
  "a non-window (per-container/native) session is refused — spawning is a standing-window-seat verb",
);
n++;

{
  const dmWindowTok = formatWindowToken(dmWindowKey("slack/T1/D999", 3));
  await assert.rejects(
    () => tool.execute({ brief: "x" }, { channel: { kind: "unified", continuationToken: `unified:${dmWindowTok}` }, session: { auth: { current: { attributes: { oe_grain: "standing" } } } } }),
    /DM seat can't spawn a thread-owning worker/,
    "a DM SEAT WINDOW is refused at execute — and by its OWN reason, not by the generic no-window one",
  );
  n++;
  eq(
    await resolveWindowGated(spawnTask, { channel: { kind: "unified", continuationToken: `unified:${dmWindowTok}` }, session: { auth: { current: { attributes: { oe_grain: "standing" } } } } } as never),
    null,
    "spawn_task is ABSENT on a DM seat window — the mount predicate excludes it positively, matching the wall",
  );
  const dmWorkerTok = formatWindowToken({ domain: dmAnchorDomain("slack/T1/D999"), windowId: taskWindowId("slack/T1/D999", "D999", "n1"), generation: 0 });
  await assert.rejects(
    () => tool.execute({ brief: "x" }, { channel: { kind: "unified", continuationToken: `unified:${dmWorkerTok}` }, session: { auth: { current: { attributes: { oe_grain: "standing" } } } } }),
    /cannot spawn further tasks/,
    "a DM-ANCHORED WORKER is still refused by the RECURSION guard, not the new DM fence — the fence is standing-grain-only (behaviour-neutral for OPE-306)",
  );
  n++;
  ok((await resolveWindowGated(spawnTask, standingCtx as never)) !== null, "spawn_task is still mounted on a NAMED-domain standing window seat (the fence must not over-remove)");
}

console.log("4. spawn_task on a RESUMED standing seat (OPE-121):");
const resumedWindowToken = unifiedSupervisorToken("payments", 1);
ok(
  (await resolveWindowGated(spawnTask, {
    channel: { kind: "unified", continuationToken: "" },
    session: { auth: { current: { attributes: { oe_grain: "standing", oe_window_token: resumedWindowToken } } } },
  } as never)) !== null,
  "a resumed standing seat (blank continuation token + oe_window_token stamp) still MOUNTS spawn_task",
);
n++;
await assert.rejects(
  () =>
    tool.execute(
      { brief: "grep memory for the office move date" },
      {
        channel: { kind: "unified", continuationToken: "" },
        session: { auth: { current: { attributes: { oe_grain: "standing", oe_window_token: resumedWindowToken, oe_wake_id: "wk-not-registered" } } } },
      },
    ),
  /couldn't resolve the thread that woke you/,
  "a resumed standing seat gets PAST the window wall on the oe_window_token stamp (it is no longer told it has no window)",
);
n++;
await assert.rejects(
  () =>
    tool.execute(
      { brief: "x" },
      { channel: { kind: "unified", continuationToken: "" }, session: { auth: { current: { attributes: { oe_grain: "standing", oe_window_token: taskToken } } } } },
    ),
  /cannot spawn further tasks/,
  "a task worker identified ONLY by its oe_window_token stamp is still refused by the recursion guard (the fallback narrows, never widens)",
);
n++;

console.log(`spawn-task-test: ${n} assertions passed`);

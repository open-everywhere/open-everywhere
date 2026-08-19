
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-provider-selection-")), "ops.sqlite3");
delete process.env.OE_ORG;
delete process.env.OE_PLATFORM;

import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import {
  declareProviderSelection,
  providerSelection,
  refusedProviderRegistrations,
  capabilitiesForPlatform,
  readAudit,
} from "@open-everywhere/core/agent/adapter-api.js";
import { postArm, registeredPostArmPlatforms } from "@open-everywhere/core/agent/channels/post-arms.js";
import { wakeOriginCodec } from "@open-everywhere/core/agent/channels/wake-origin-codec.js";
import { divertToUnifiedWindow } from "@open-everywhere/core/agent/channels/unified.js";
import { mintWakeId, type UnifiedWakeOrigin } from "@open-everywhere/core/agent/channels/unified-window.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const declared = declareProviderSelection(["notion"]);
assert.deepEqual(declared, ["notion"], "the declaration normalises to the selected set");
n++;
const realWarn = console.warn;
const warnings: string[] = [];
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(" "));
};
try {
  registerNotionProvider();
  registerSlackProvider();
} finally {
  console.warn = realWarn;
}

ok(capabilitiesForPlatform("notion").midTurnPost === true, "selected notion: its capability manifest row took");
ok(postArm("notion") !== undefined, "selected notion: its post arm took");
ok(wakeOriginCodec("notion") !== undefined, "selected notion: its wake-origin codec took");

ok(capabilitiesForPlatform("slack").midTurnPost === false, "de-selected slack: no manifest row ⇒ the all-false fail-closed default");
ok(capabilitiesForPlatform("slack").reactions === false, "de-selected slack: reactions unsupported too");
ok(postArm("slack") === undefined, "de-selected slack: no post arm ⇒ the reply spine refuses, never a mis-routed post");
ok(registeredPostArmPlatforms().includes("slack") === false, "de-selected slack: ABSENT from the post-arm registry, not present-and-inert");
ok(wakeOriginCodec("slack") === undefined, "de-selected slack: no wake-origin codec ⇒ a stored slack origin is invalid on read");
const refused = refusedProviderRegistrations();
ok(refused.length > 0 && refused.every((r) => r.provider === "slack"), `every refusal is slack's (got ${JSON.stringify(refused)})`);
ok(
  warnings.some((w) => w.includes("REFUSED") && w.includes('"slack"')),
  "the refusals were LOUD — an operator can see a mis-wired boot in the logs",
);

const received: string[] = [];
const captureReceive = ((channel: unknown, target: unknown) => ({
  send: async (message: unknown, options: unknown) => {
    received.push(JSON.stringify({ payload: { target, message, options } }));
  },
})) as never;

const slackOrigin: UnifiedWakeOrigin = { platform: "slack", channelId: "C_GONE" };
const notionOrigin: UnifiedWakeOrigin = { platform: "notion", pageId: "page-1", discussionId: "disc-1" } as UnifiedWakeOrigin;

await divertToUnifiedWindow(captureReceive, {
  message: "hello from a surface this deployment does not carry",
  token: "oe-dom:ops:oe-sup:g1",
  window: { wakeId: mintWakeId(), origin: slackOrigin },
  surfaceKey: "slack/T_GONE/C_GONE",
  auth: { attributes: {} },
});
ok(received.length === 0, "inbound refusal: NOTHING was delivered into the window");

await divertToUnifiedWindow(captureReceive, {
  message: "hello from a selected surface",
  token: "oe-dom:ops:oe-sup:g1",
  window: { wakeId: mintWakeId(), origin: notionOrigin },
  surfaceKey: "notion/ws/page-1",
  auth: { attributes: {} },
});
ok(received.length === 1, "the SELECTED surface's wake goes through unchanged");

const rows = await readAudit({ org: "default", limit: 50 });
const refusal = rows.find((r) => r.action === "provider.unselected_wake_refused");
ok(refusal !== undefined, "inbound refusal: an audit row was written (observable, not a silent drop)");
ok(refusal?.platform === "slack", "inbound refusal: the row names the refused platform");
assert.deepEqual((refusal?.detail as { selected?: string[] } | undefined)?.selected, ["notion"], "inbound refusal: the row records the selection it was measured against");
n++;
assert.deepEqual(providerSelection(), ["notion"], "the declared selection is still readable for diagnostics");
n++;

console.log(`✓ provider-selection-integration: ${n} assertions (a de-selected real bundle is absent from every registry, and its inbound wake is refused + audited)`);

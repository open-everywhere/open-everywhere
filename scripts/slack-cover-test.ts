// proves: cover.wake

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-slack-cover-")), "ops.sqlite3");

import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { resolvePartition } from "@open-everywhere/core/agent/memory/partition.js";
import { turnCoverOff, turnCoverOn } from "@open-everywhere/core/agent/cover/state.js";
import { coveredOnWake } from "@open-everywhere/core/agent/cover/wake.js";
import {
  bindableFor,
  parseMessageEvent,
  routeSupervisorEvent,
  slackMentionedUserIds,
  type SupervisorRouteDeps,
} from "@open-everywhere/provider-slack/agent/channels/slack-events.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  n++;
}

registerSlackProvider();

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "launch", reach: ["slack/T_COV/C_LAUNCH"], ambientSupervisor: true })],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === "C_LAUNCH" ? ["launch"] : []),
});

const TEAM = "T_COV";
const ev = (ts: string, text: string) =>
  parseMessageEvent({ type: "event_callback", team_id: TEAM, event: { type: "message", channel: "C_LAUNCH", ts, user: "UBO", channel_type: "channel", text } })!;

interface Captured {
  readonly message: string;
  readonly auth: { attributes?: Record<string, unknown> };
  readonly wakeId?: string;
}
const wakes: Captured[] = [];
const deps = (singleWindow: boolean): SupervisorRouteDeps => ({
  confirmInternalWithMeta: async () => ({ internal: true, memberCount: 9 }),
  getOrCreateSession: async () => ({ token: "oe-sup:C_LAUNCH:g1", generation: 1, freshGeneration: false, tail: [] }),
  touchSession: async () => {},
  wake: async (input) => {
    wakes.push({ message: input.message, auth: input.auth as Captured["auth"], ...(input.window ? { wakeId: input.window.wakeId } : {}) });
  },
  unifiedMeta: () => ({ unified: true, singleWindow }),
  now: () => "2026-10-14T10:00:00.000Z",
});

const org = resolvePartition(bindableFor(ev("1.1", "x"))).org;
const where = { org, platform: "slack", workspace: TEAM, surface: "D_ANA", principalKey: `slack/${TEAM}/UANA` };

ok(JSON.stringify(slackMentionedUserIds("hi <@UANA> and <@W0BO|bo>, not @UCY")) === JSON.stringify(["UANA", "W0BO"]), "the Slack mention parser reads both mention spellings and nothing else");

await routeSupervisorEvent(ev("100.1", "<@UANA> is the launch still on Friday?"), deps(true));
const baseline = wakes.at(-1)!;
ok(!baseline.message.includes("Out-of-office cover"), "with cover off, a mention of the person carries no cover note");

await turnCoverOn(where, { via: "command", name: "Ana" }, "2026-10-14T09:00:00.000Z");
const out = await routeSupervisorEvent(ev("100.2", "<@UANA> is the launch still on Friday?"), deps(true));
const covered = wakes.at(-1)!;
ok(out.woke === true, "the room's seat wakes");
ok(/<system-note>Out-of-office cover: this message mentions person UANA, and they are away with cover on\./.test(covered.message), "🔴 the wake carries OE's cover note as a trusted system note");
ok(!/<system-note>[^<]*Ana/.test(covered.message), "the trusted note names the person by id, never by their chosen display name");
const pointer = await coveredOnWake(org, covered.wakeId);
ok(pointer !== undefined && pointer.length === 1 && pointer[0]!.principalKey === `slack/${TEAM}/UANA`, "the pointer the reply choke point reads names the covered person under this wake's id");

const strip = (a: Captured["auth"]) => {
  const { oe_wake_id: _w, ...rest } = a.attributes ?? {};
  return JSON.stringify(rest);
};
ok(strip(covered.auth) === strip(baseline.auth), "🔴 the cover wake's auth bag is byte-identical to the same wake with cover off: the turn runs as the room");
ok(!JSON.stringify(covered.auth).includes("UANA"), "🔴 the auth bag names nothing of the absent person — they are never the principal");

await routeSupervisorEvent(ev("100.3", "<@UANA> any news?"), deps(false));
ok(!wakes.at(-1)!.message.includes("Out-of-office cover"), "a wake with no window (no wake id) carries no cover note");

await routeSupervisorEvent(ev("100.4", "<@UCY> any news?"), deps(true));
ok(!wakes.at(-1)!.message.includes("Out-of-office cover"), "a mention of somebody without cover carries no note");

await turnCoverOff(where, "command");
await routeSupervisorEvent(ev("100.5", "<@UANA> still there?"), deps(true));
ok(!wakes.at(-1)!.message.includes("Out-of-office cover"), "🔴 after `/oe cover off`, a mention of the person carries no note");

console.log(`✓ slack-cover: ${n} assertions`);

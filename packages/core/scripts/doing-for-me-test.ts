// proves: TOOL-doing_for_me

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingActionRow } from "../agent/approvals/types.js";
import type { Routine } from "../agent/routines/routine.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-doing-for-me-")), "ops.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "org", match: "org" })],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

await import("../agent/approvals/flow.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { doingForPerson, renderDoingMessage, doingRef, DOING_PAUSED_REASON, DOING_WATCH_KEY } = await import("../agent/status/doing-for-me.js");
const { buildHomeView, runHomeAction } = await import("../agent/home/home-view.js");
const { DOING_HOME_ACTIONS, DOING_HOME_ITEMS_MAX, doingPersonOf } = await import("../agent/home/doing-home.js");
const { enrollPersonalWatch, readPersonalWatch, setPersonalWatchDial } = await import("../agent/personal-watch/state.js");
const { registerSlackFixtureManifest, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const { FakeEveContext, inEveContext } = await import("./_eve-context-stub.js");
const { bindFrom } = await import("../agent/identity/binding.js");
const { resolvePartition } = await import("../agent/memory/partition.js");
const doingTool = (await import("../agent/tools/doing_for_me.js")).default as { execute(i: unknown, c: unknown): Promise<unknown> };
type BindableContext = import("../agent/identity/binding.js").BindableContext;
type HomeViewer = import("../agent/home/home-view.js").HomeViewer;
type HomeBlock = import("../agent/home/home-view.js").HomeBlock;

registerSlackFixtureManifest();
registerSlackFixtureMapper();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const store = getOperationalStore();

const ctx = (userId: string, opts: { channel?: boolean; attested?: boolean } = {}): BindableContext =>
  ({
    channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:dm" },
    session: {
      auth: {
        current: {
          attributes: {
            channel_id: opts.channel === true ? "C-ROOM" : `D-${userId}`,
            channel_type: opts.channel === true ? "channel" : "im",
            oe_grain: "standing",
            oe_platform: "slack",
            team_id: "T1",
            trust_checked: "true",
            ...(opts.attested === true ? { oe_fire_unattended: "true" } : {}),
          },
          principalId: userId,
          principalType: "slack-user",
        },
      },
      id: `dm-${userId}`,
    },
  }) as unknown as BindableContext;

const ORG = resolvePartition(ctx("U_ME")).org;
const MY_DM = resolvePartition(ctx("U_ME"));
const THEIR_DM = resolvePartition(ctx("U_OTHER"));
ok(MY_DM.surfaceKey === "slack/T1/D-U_ME" && bindFrom(ctx("U_ME")).mode === "dm", "fixture: the DM ctx binds as the person's own DM");

const routine = (over: Partial<Routine> & Pick<Routine, "id" | "surfaceKey">): Routine => ({
  org: ORG,
  trigger: { kind: "cron", expr: "0 9 * * 1-5" },
  prompt: "Summarise the open pull requests for me",
  createdAt: "2026-10-10T09:00:00Z",
  createdBy: "U_ME",
  status: "active",
  consecutiveFailures: 0,
  nextRunAt: "2026-10-15T09:00:00Z",
  ...over,
});

await store.addRoutine(routine({ id: "r-mine-dm", surfaceKey: MY_DM.surfaceKey }));
await store.addRoutine(routine({ id: "r-mine-room", surfaceKey: "slack/T1/C-ROOM", trigger: { kind: "watch", everyMinutes: 30 }, prompt: "Watch the status page" }));
await store.addRoutine(routine({ id: "r-theirs-dm", surfaceKey: THEIR_DM.surfaceKey, createdBy: "U_OTHER", prompt: "Their secret routine" }));
await store.addRoutine(routine({ id: "r-theirs-room", surfaceKey: "slack/T1/C-ROOM", createdBy: "U_OTHER", prompt: "Their room routine" }));
await store.addRoutine(routine({ id: "r-mine-once", surfaceKey: MY_DM.surfaceKey, trigger: { kind: "once", at: "2026-12-01T15:00:00Z" }, prompt: "Remind me to send the invoice", createdAt: "2026-10-09T09:00:00Z" }));
await store.addRoutine(routine({ id: "r-mine-fired", surfaceKey: MY_DM.surfaceKey, trigger: { kind: "once", at: "2026-10-01T15:00:00Z" }, prompt: "Remind me about the dentist", status: "disabled", disabledReason: "once: fired and ok at 2026-10-01T15:00:00.000Z", createdAt: "2026-09-30T09:00:00Z" }));
await store.addRoutine(routine({ id: "r-mine-declined", surfaceKey: MY_DM.surfaceKey, trigger: { kind: "once", at: "2026-10-02T15:00:00Z" }, prompt: "Remind me to call the bank", status: "disabled", disabledReason: "once: declined (over budget) at 2026-10-02T15:00:00.000Z", createdAt: "2026-09-30T08:00:00Z" }));
await store.addRoutine(routine({ id: "r-other-org", org: "other-org", surfaceKey: MY_DM.surfaceKey, prompt: "Another tenant" }));

const grant = (id: string, owner: string) => ({
  askId: `ask-${id}`,
  connector: "notion",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
  frozenArgs: { id: "page" },
  id,
  mcpTool: "notion-fetch",
  mode: "standing" as const,
  ownerPrincipalId: owner,
  ownerSlug: "me",
  purpose: "read the launch page",
  requesterPrincipalId: "U_REQ",
  resource: "Launch page",
  scopeKey: "slack/T1/C-ROOM",
  status: "active" as const,
  tier: "read" as const,
  toolName: "grant__me_notion__notion_fetch",
  verb: "notion_fetch",
});
await store.addCredentialGrant(ORG, grant("g-mine", "slack/T1/U_ME"));
await store.addCredentialGrant(ORG, grant("g-theirs", "slack/T1/U_OTHER"));

const dmRule = (surfaceKey: string, ownerId: string, ruleId: string) => ({
  org: ORG,
  surfaceKey,
  ruleId,
  ownerId,
  rule: "In this DM, post messages in #general with chat_post when the person asked for it in this turn, with matching arguments. Never in an unattended run.",
  subjectJson: "{}",
  sourceActionId: "card-1",
  createdAt: "2026-10-10T09:00:00Z",
  updatedAt: "2026-10-10T09:00:00Z",
});
await store.upsertDmRule(dmRule(MY_DM.surfaceKey, "U_ME", "dm.chat-post.post"));
await store.upsertDmRule(dmRule(THEIR_DM.surfaceKey, "U_OTHER", "dm.chat-post.theirs"));

const pending = (over: Partial<PendingActionRow>): PendingActionRow => ({
  id: "q",
  org: ORG,
  kind: "chat.post",
  argsJson: JSON.stringify({ platform: "slack", container: "C7", text: "hello", grant: "g", requestedBy: "U_ME" }),
  scopeKey: "slack/T1/C7",
  domain: null,
  requestedBy: "U_ME",
  channelId: "C7",
  threadTs: null,
  messageTs: "700.1",
  postedTo: "slack/T1/C7",
  status: "pending",
  createdAt: "2026-10-11T08:00:00Z",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  decidedBy: null,
  decidedAt: null,
  ...over,
});
await store.addPendingAction(pending({ id: "q-mine" }));
await store.addPendingAction(pending({ id: "q-theirs", requestedBy: "U_OTHER" }));

const permalink = async (_platform: string, ref: { channelId: string; messageId: string }) => `https://example.slack.com/archives/${ref.channelId}/p${ref.messageId.replace(".", "")}`;
const me = { org: ORG, platform: "slack", workspace: "T1", personId: "U_ME", dmSurfaceKey: MY_DM.surfaceKey, trust: "internal" as const };

{
  await enrollPersonalWatch(ORG, "slack/T1/U_ME");
  const list = await doingForPerson(me, { permalink });
  const kinds = list.items.map((i) => i.kind);
  ok(list.unread.length === 0, "every part of the list was read");
  ok(kinds.filter((k) => k === "routine").length === 5, "all five of my routines are listed: four in my DM and one in a shared room");
  const declined = list.items.find((i) => i.text.includes("Remind me to call the bank"));
  ok(declined !== undefined && declined.actions.join(",") === "remove" && declined.text.includes("it did not run") && !declined.text.includes("it already ran") && !declined.text.includes("turn it back on"), "🔴 a one-shot that never ran says so, never claims it ran, and offers no turn-on");
  const fired = list.items.find((i) => i.text.includes("Remind me about the dentist"));
  ok(fired !== undefined && fired.actions.join(",") === "remove" && !fired.text.includes("turn it back on") && fired.text.includes("it already ran"), "🔴 a fired one-shot offers Remove only and never says it can be turned back on");
  const once = list.items.find((i) => i.text.includes("Remind me to send the invoice"));
  ok(once !== undefined && once.actions.join(",") === "remove", "🔴 a one-shot gets Remove only: enable_routine cannot bring a paused one-shot back");
  ok(kinds.includes("watch") && kinds.includes("grant") && kinds.includes("rule") && kinds.includes("waiting"), "the watch, my grant, my rule and the card waiting on me are listed");
  const all = JSON.stringify(list.items);
  ok(!all.includes("Their secret routine") && !all.includes("Their room routine"), "🔴 another person's routines never show — not from their DM, not from a room we share");
  ok(!all.includes("Another tenant"), "🔴 my own native id in another org lists nothing — the tenant wall holds");
  ok(list.items.filter((i) => i.kind === "grant").length === 1 && list.items.filter((i) => i.kind === "rule").length === 1, "🔴 only MY grant and MY rule: another person's grant and rule never show");
  ok(list.items.filter((i) => i.kind === "waiting").length === 1, "🔴 only the card waiting on ME, not the one raised by another person");
  const dm = list.items.find((i) => i.kind === "routine" && i.ref !== undefined && i.text.includes("Summarise"));
  const room = list.items.find((i) => i.kind === "routine" && i.ref === undefined);
  ok(dm !== undefined && dm.actions.join(",") === "pause,remove" && dm.text.includes("Summarise the open pull requests"), "the DM routine has Pause and Remove, and its line says what it does");
  ok(room !== undefined && room.actions.length === 0 && room.roomKey === "slack/T1/C-ROOM" && room.label === "Watch", "🔴 the shared-room routine has NO button, names its room and reads as a Watch");
  ok(room !== undefined && !room.text.includes("Watch the status page"), "🔴 a shared-room line shows no prompt: another member can rewrite it, and I may have left the room");
  ok(!/r-mine|r-theirs|U_ME|U_OTHER|slack\/T1/u.test(list.items.map((i) => i.text).join("\n")), "no line carries a routine id, a person id or a scope key");
  const waiting = list.items.find((i) => i.kind === "waiting");
  ok(waiting?.link === "https://example.slack.com/archives/C7/p7001", "a waiting card carries its link");
  const msg = renderDoingMessage(list);
  ok(msg.startsWith(`Here is everything I do for you (${list.items.length}):`) && msg.includes("In <#C-ROOM>; ask there to stop it.") && msg.includes("Home tab"), "the DM message numbers every item, names a shared room by its mention, and says how to stop one");
  ok(!/r-mine|U_ME|slack\/T1/u.test(msg), "the DM message carries no raw id");
}

{
  const empty = await doingForPerson({ ...me, personId: "U_NOBODY", dmSurfaceKey: "slack/T1/D-U_NOBODY" }, { permalink });
  ok(empty.items.length === 0 && renderDoingMessage(empty).startsWith("I do nothing for you on my own"), "a person with nothing set up reads one plain line");
  const failed = await doingForPerson(me, { permalink, routines: async () => { throw new Error("db down"); } });
  ok(failed.unread.includes("your routines") && renderDoingMessage(failed).includes("I could not read your routines"), "🔴 an unreadable part is named, never shown as empty");
}

{
  const noDm = await doingForPerson({ ...me, dmSurfaceKey: undefined }, { permalink });
  ok(noDm.unread.includes("your routines") && noDm.unread.includes("your rules") && noDm.items.every((i) => i.roomKey === undefined), "🔴 with no DM room, routines and rules are named unread, and no DM routine reads as a shared room's");
  const unnamed = await doingForPerson({ ...me, workspace: "dev" }, { permalink });
  ok(unnamed.unread.includes("what you lend") && unnamed.unread.includes("your watch"), "🔴 with no nameable workspace, grants and the watch are named unread, never \"you lend nothing\"");
  for (let i = 0; i < 27; i++) await store.addPendingAction(pending({ id: `q-many-${i}`, requestedBy: "U_MANY", argsJson: JSON.stringify({ platform: "slack", container: "C7", text: `hello ${i}`, grant: "g", requestedBy: "U_MANY" }) }));
  const many = await doingForPerson({ ...me, personId: "U_MANY", dmSurfaceKey: "slack/T1/D-U_MANY" }, { permalink });
  ok(many.waitingOmitted === 2 && renderDoingMessage(many).includes("…and 2 more waiting on you, not shown."), "the waiting queue's own cap is counted, not dropped");
  const manyHome = (await buildHomeView({ org: ORG, platform: "slack", workspace: "T1", principalId: "U_MANY", personal: resolvePartition(ctx("U_MANY")), trust: "external", domains: [] })).find((s) => s.id === "doing-for-you")?.blocks ?? [];
  ok(manyHome.some((b) => b.kind === "note" && b.text.startsWith("2 more things are waiting on you")), "…and the Home section counts them too");
  await store.addPendingAction(pending({ id: "q-admin-tier", kind: "spend.set", argsJson: JSON.stringify({ org: ORG, scopeKey: "slack/T1/C8", level: "surface", monthlyUsd: 75, currentCap: null, scopeLabel: "#ops" }), requestedBy: "U_OTHER", channelId: "C8", messageTs: "800.1", postedTo: "slack/T1/C8" }));
  let seenEnterprise: string | undefined;
  const probe = await doingForPerson({ ...me, personId: "U_NOBODY2", dmSurfaceKey: "slack/T1/D-U_NOBODY2", enterprise: "E1" }, { permalink, mayDecide: (_row, person) => ((seenEnterprise = person.enterprise), false) });
  ok(probe.unread.length === 0 && seenEnterprise === "E1", "the enterprise rung reaches the queue's decider check");
}

const viewer: HomeViewer = { org: ORG, platform: "slack", workspace: "T1", principalId: "U_ME", personal: MY_DM, trust: "internal", domains: [] };
const section = async (v: HomeViewer): Promise<readonly HomeBlock[]> => (await buildHomeView(v)).find((s) => s.id === "doing-for-you")?.blocks ?? [];
{
  ok(doingPersonOf({ ...viewer, enterprise: "E1" }).enterprise === "E1" && doingPersonOf(viewer).enterprise === undefined, "the Home viewer's enterprise rung reaches the list's person");
  const page = await buildHomeView(viewer);
  ok(page[0]?.id === "doing-for-you", "the list is the first section of the Home page");
  const blocks = await section(viewer);
  const items = blocks.filter((b): b is Extract<HomeBlock, { kind: "item" }> => b.kind === "item");
  ok(!items.some((b) => b.label === "Rule") && blocks.some((b) => b.kind === "note" && b.text.includes("one rule") && b.text.includes("Your rules")), "the rules stay in their own section; this one points to it");
  ok(blocks.some((b) => b.kind === "room" && b.room.nativeId === "C-ROOM"), "the shared-room routine renders its room as the room's own mention");
  ok(items.some((b) => b.label === "Waiting on you" && b.actions.length === 0 && b.ref === undefined), "the waiting card is on the page, with no button");

  const routineRef = doingRef("routine", `${MY_DM.surfaceKey}#r-mine-dm`);
  const roomRef = doingRef("routine", "slack/T1/C-ROOM#r-mine-room");
  const theirRef = doingRef("routine", `${THEIR_DM.surfaceKey}#r-theirs-dm`);
  ok((await runHomeAction(viewer, DOING_HOME_ACTIONS.pause, roomRef)).notice.startsWith("That is not on your list"), "🔴 a forged ref naming my SHARED-room routine pauses nothing");
  ok((await store.getRoutine(ORG, "slack/T1/C-ROOM", "r-mine-room"))?.status === "active", "…and the room routine still runs");
  ok((await runHomeAction(viewer, DOING_HOME_ACTIONS.remove, theirRef)).notice.startsWith("That is not on your list"), "🔴 a forged ref naming ANOTHER person's routine removes nothing");
  ok((await store.getRoutine(ORG, THEIR_DM.surfaceKey, "r-theirs-dm")) !== null, "…and their routine is still there");
  const other: HomeViewer = { ...viewer, principalId: "U_OTHER", personal: THEIR_DM };
  ok((await runHomeAction(other, DOING_HOME_ACTIONS.pause, routineRef)).notice.startsWith("That is not on your list"), "🔴 another viewer clicking MY routine's ref pauses nothing");

  const paused = await runHomeAction(viewer, DOING_HOME_ACTIONS.pause, routineRef);
  const row = await store.getRoutine(ORG, MY_DM.surfaceKey, "r-mine-dm");
  ok(paused.notice.startsWith("Paused.") && row?.status === "disabled" && row.disabledReason === DOING_PAUSED_REASON, "Pause stops my DM routine and records why");
  const pauseRow = (await readAudit({ org: ORG, action: "routine.paused" } as never))[0];
  ok(pauseRow?.principalId === "U_ME" && (pauseRow.detail as { via?: string }).via === "slack-app-home", "Pause writes routine.paused, by me, from the Home tab");
  const after = (await doingForPerson(me, { permalink })).items.find((i) => i.ref === routineRef);
  ok(after?.state === "paused" && after.actions.join(",") === "remove" && after.text.includes("paused by you"), "a paused routine reads as paused, offers only Remove, and says how to turn it back on");
  ok((await runHomeAction(viewer, DOING_HOME_ACTIONS.pause, routineRef)).notice.startsWith("That is not on your list"), "a second Pause changes nothing");

  const removed = await runHomeAction(viewer, DOING_HOME_ACTIONS.remove, routineRef);
  ok(removed.notice.startsWith("Removed.") && (await store.getRoutine(ORG, MY_DM.surfaceKey, "r-mine-dm")) === null, "Remove deletes my DM routine");
  ok((await readAudit({ org: ORG, action: "routine.cancel" } as never)).some((r) => (r.detail as { id?: string; via?: string }).id === "r-mine-dm" && (r.detail as { via?: string }).via === "slack-app-home"), "Remove writes routine.cancel from the Home tab");

  const watchRef = doingRef("watch", DOING_WATCH_KEY);
  ok((await runHomeAction(viewer, DOING_HOME_ACTIONS.pause, watchRef)).notice.startsWith("Paused."), "Pause on the watch turns it off");
  ok((await readPersonalWatch(ORG, "slack/T1/U_ME")).state?.dial === "none", "…the dial reads None");
  const offWatch = (await doingForPerson(me, { permalink })).items.find((i) => i.kind === "watch");
  ok(offWatch?.state === "paused" && offWatch.actions.length === 0, "a watch that is off reads as paused, with no button");
  ok((await doingForPerson({ ...me, trust: "external" }, { permalink })).items.every((i) => i.kind !== "watch"), "an external person with the watch off sees no watch line");
  await setPersonalWatchDial({ org: ORG, platform: "slack", workspace: "T1", surface: "D-U_ME", principalKey: "slack/T1/U_ME" }, "less", "command");

  const theirGrant = doingRef("grant", "g-theirs");
  ok((await runHomeAction(viewer, DOING_HOME_ACTIONS.remove, theirGrant)).notice.startsWith("That is not on your list"), "🔴 a forged ref naming another person's grant ends nothing");
  ok((await store.getCredentialGrant(ORG, "g-theirs"))?.status === "active", "…their grant is still live");
  const ended = await runHomeAction(viewer, DOING_HOME_ACTIONS.remove, doingRef("grant", "g-mine"));
  ok(ended.notice.startsWith("Ended.") && (await store.getCredentialGrant(ORG, "g-mine"))?.status !== "active", "Remove ends the grant I lend");
  const revokedRow = (await readAudit({ org: ORG, action: "grant.revoked" } as never)).find((r) => (r.detail as { grantId?: string }).grantId === "g-mine");
  ok((revokedRow?.detail as { route?: string } | undefined)?.route === "home", "the revoke is audited with route home, the door the person used");
}

{
  const BUSY_DM = resolvePartition(ctx("U_BUSY"));
  for (let i = 0; i < 20; i++) await store.addRoutine(routine({ id: `r-busy-${i}`, surfaceKey: BUSY_DM.surfaceKey, createdBy: "U_BUSY", prompt: `Task ${i}` }));
  const busy: HomeViewer = { ...viewer, principalId: "U_BUSY", personal: BUSY_DM, trust: "external" };
  const blocks = await section(busy);
  const items = blocks.filter((b) => b.kind === "item");
  ok(items.length === DOING_HOME_ITEMS_MAX && blocks.some((b) => b.kind === "note" && b.text.startsWith("…and 5 more.")), `a 20-routine list shows ${DOING_HOME_ITEMS_MAX} items and says how many more`);
  const full = await doingForPerson({ ...me, personId: "U_BUSY", dmSurfaceKey: BUSY_DM.surfaceKey }, { permalink });
  ok(full.items.length === 20, "…while the DM list carries all of them");
  ok(!renderDoingMessage(full, "teams").includes("Home tab") && renderDoingMessage(full, "teams").includes("ask me to stop it"), "on a surface with no Home tab the closing line does not name one");
}

{
  const call = (c: BindableContext) => inEveContext(new FakeEveContext(), async () => (await doingTool.execute({}, c)) as { count: number; message: string; items: { kind: string }[] });
  const refusal = async (c: BindableContext): Promise<string> => {
    try {
      await call(c);
      return "(no refusal)";
    } catch (err) {
      return String(err);
    }
  };
  ok((await refusal(ctx("U_ME", { channel: true }))).includes("DM-only"), "🔴 a CHANNEL seat is refused — the DM wall");
  ok((await refusal(ctx("U_ME", { attested: true }))).includes("needs the person to be here"), "🔴 an unattended fire is refused — no acting person, no list");
  const answer = await call(ctx("U_ME"));
  ok(answer.count === answer.items.length && answer.items.some((i) => i.kind === "routine") && answer.items.some((i) => i.kind === "rule"), "in my own DM it answers with my list");
  ok(!answer.message.includes("Their secret routine") && !answer.message.includes("Their room routine"), "🔴 …and never another person's routine");
  const theirs = await call(ctx("U_OTHER"));
  ok(theirs.message.includes("Their secret routine") && !theirs.message.includes("Watch the status page"), "the other person's DM answers with THEIR list, not mine");
}

console.log(`doing-for-me-test: ${n} assertions passed`);

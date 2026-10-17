import { appendAudit } from "../audit/audit.js";
import { ownerLiveGrants, revokeOwnerGrants } from "../access/credential-grant-revoke.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { enrollPersonalWatch, setPersonalWatchDial } from "../personal-watch/state.js";
import { listAllRoutines, removeRoutine, updateRoutine } from "../routines/store.js";
import type { Routine } from "../routines/routine.js";
import { DOING_PAUSED_REASON, DOING_WATCH_KEY, doingForPerson, doingRef, routineIsTheirs, type DoingItem, type DoingPerson } from "../status/doing-for-me.js";
import { registerHomeAction, registerHomeSection, type HomeBlock, type HomeItemAction, type HomeViewer } from "./home-view.js";

export const DOING_HOME_ACTIONS = { pause: "doing.pause", remove: "doing.remove" } as const;

const ACTIONS: Readonly<Record<"pause" | "remove", HomeItemAction>> = {
  pause: { id: DOING_HOME_ACTIONS.pause, label: "Pause", kind: "confirm", confirm: { title: "Pause this?", yes: "Pause it", note: "I stop at once. Ask me in our DM to start it again." } },
  remove: { id: DOING_HOME_ACTIONS.remove, label: "Remove", kind: "confirm", confirm: { title: "Remove this?", yes: "Remove it", note: "I remove it at once. You cannot undo it. To have it back, ask me to set it up again." } },
};

export const DOING_HOME_ITEMS_MAX = 15;

const SCOPE_NOTE = "Everything I do for you on my own: the routines and watches you set up, the watch over your calendar, what you lend, and what waits on you. Only you see this list.";

export function doingPersonOf(viewer: HomeViewer): DoingPerson {
  return {
    org: viewer.org,
    platform: viewer.platform,
    workspace: viewer.workspace,
    personId: viewer.principalId,
    trust: viewer.trust,
    ...(viewer.enterprise ? { enterprise: viewer.enterprise } : {}),
    ...(viewer.personal ? { dmSurfaceKey: viewer.personal.surfaceKey } : {}),
  };
}

function itemBlocks(item: DoingItem): HomeBlock[] {
  const actions = item.ref === undefined ? [] : item.actions.map((a) => ACTIONS[a]);
  const blocks: HomeBlock[] = [
    { kind: "item", text: item.text, label: item.state === "paused" ? `${item.label} (paused)` : item.label, ...(item.ref ? { ref: item.ref } : {}), actions, ...(item.link ? { link: item.link } : {}) },
  ];
  if (item.roomKey !== undefined) {
    const nativeId = item.roomKey.split("/").slice(2).join("/");
    blocks.push({ kind: "room", text: "It belongs to this room, so ask there to stop it:", room: { surfaceKey: item.roomKey, nativeId } });
  }
  return blocks;
}

async function doingBlocks(viewer: HomeViewer): Promise<readonly HomeBlock[]> {
  const blocks: HomeBlock[] = [{ kind: "heading", text: "What I do for you" }, { kind: "note", text: SCOPE_NOTE }];
  const key = tryPrincipalKey(viewer.platform, viewer.workspace, viewer.principalId);
  if (viewer.trust === "internal" && key !== undefined) await enrollPersonalWatch(viewer.org, key);
  const list = await doingForPerson(doingPersonOf(viewer));
  const shown = list.items.filter((i) => i.kind !== "rule");
  if (shown.length === 0) blocks.push({ kind: "text", text: "Nothing yet. Ask me in our DM to remind you, watch something, or report on a schedule, and it shows here." });
  for (const item of shown.slice(0, DOING_HOME_ITEMS_MAX)) blocks.push(...itemBlocks(item));
  if (shown.length > DOING_HOME_ITEMS_MAX) blocks.push({ kind: "note", text: `…and ${shown.length - DOING_HOME_ITEMS_MAX} more. Ask me in our DM "what are you doing for me?" for the whole list.` });
  if (list.waitingOmitted > 0) blocks.push({ kind: "note", text: `${list.waitingOmitted} more ${list.waitingOmitted === 1 ? "thing is" : "things are"} waiting on you and not shown here.` });
  const rules = list.items.length - shown.length;
  if (rules > 0) blocks.push({ kind: "note", text: `You also have ${rules === 1 ? "one rule" : `${rules} rules`} that let me act without asking. See Your rules below.` });
  for (const what of list.unread) blocks.push({ kind: "note", text: `I could not read ${what} just now, so this list may be missing some. It is not empty. Try Refresh.` });
  return blocks;
}

registerHomeSection({ id: "doing-for-you", order: 5, build: doingBlocks });

async function ownItem(viewer: HomeViewer, ref: string | undefined): Promise<DoingItem | undefined> {
  if (ref === undefined) return undefined;
  const list = await doingForPerson(doingPersonOf(viewer));
  return list.items.find((i) => i.ref === ref);
}

async function ownDmRoutine(viewer: HomeViewer, ref: string): Promise<Routine | undefined> {
  const dm = viewer.personal?.surfaceKey;
  if (dm === undefined) return undefined;
  const person = doingPersonOf(viewer);
  return (await listAllRoutines()).find((r) => routineIsTheirs(r, person) && r.surfaceKey === dm && doingRef("routine", `${r.surfaceKey}#${r.id}`) === ref);
}

function routineAudit(viewer: HomeViewer, r: Routine) {
  return {
    org: viewer.org,
    platform: viewer.platform,
    workspace: viewer.workspace,
    surface: viewer.personal?.surface ?? "home",
    principalId: viewer.principalId,
    detail: { id: r.id, via: `${viewer.platform}-app-home`, confirmedBy: viewer.principalId },
  };
}

registerHomeAction(DOING_HOME_ACTIONS.pause, async (viewer, ref) => {
  const item = await ownItem(viewer, ref);
  if (item === undefined || !item.actions.includes("pause")) return { notice: "That is not on your list any more, so I changed nothing." };
  if (item.kind === "watch" && ref === doingRef("watch", DOING_WATCH_KEY)) {
    const key = tryPrincipalKey(viewer.platform, viewer.workspace, viewer.principalId);
    if (key === undefined) return { notice: "I could not tell who you are, so I changed nothing." };
    const r = await setPersonalWatchDial({ org: viewer.org, platform: viewer.platform, workspace: viewer.workspace, surface: viewer.personal?.surface ?? "home", principalKey: key }, "none", "app-home", undefined, { existingOnly: true });
    return { notice: r.written ? "Paused. I no longer watch your calendar. Set it to More or Less in Your watch to start again." : "You have no watch, so there was nothing to pause." };
  }
  if (item.kind === "routine" && ref !== undefined) {
    const routine = await ownDmRoutine(viewer, ref);
    if (routine === undefined || routine.status !== "active") return { notice: "That is not running any more, so I changed nothing." };
    const updated = await updateRoutine(routine.org, routine.surfaceKey, routine.id, { status: "disabled", disabledReason: DOING_PAUSED_REASON });
    if (updated === null) return { notice: "That is not on your list any more, so I changed nothing." };
    await appendAudit({ ...routineAudit(viewer, routine), action: "routine.paused" }).catch(() => undefined);
    return { notice: "Paused. It does not run until you ask me in our DM to turn it back on." };
  }
  return { notice: "That cannot be paused from here, so I changed nothing." };
});

registerHomeAction(DOING_HOME_ACTIONS.remove, async (viewer, ref) => {
  const item = await ownItem(viewer, ref);
  if (item === undefined || ref === undefined || !item.actions.includes("remove")) return { notice: "That is not on your list any more, so there was nothing to remove." };
  if (item.kind === "routine") {
    const routine = await ownDmRoutine(viewer, ref);
    if (routine === undefined || viewer.personal === undefined || !(await removeRoutine(viewer.personal, routine.id))) {
      return { notice: "That is not on your list any more, so there was nothing to remove." };
    }
    await appendAudit({ ...routineAudit(viewer, routine), action: "routine.cancel" }).catch(() => undefined);
    return { notice: "Removed. It does not run again." };
  }
  if (item.kind === "grant") {
    const ownerKey = tryPrincipalKey(viewer.platform, viewer.workspace, viewer.principalId);
    if (ownerKey === undefined) return { notice: "I could not tell who you are, so I changed nothing." };
    const stamps = { org: viewer.org, platform: viewer.platform, workspace: viewer.workspace, surface: viewer.personal?.surface ?? "home" };
    const holding = (await ownerLiveGrants(viewer.org, ownerKey, Date.now())).find((h) => doingRef("grant", h.grant.id) === ref);
    if (holding === undefined) return { notice: "You no longer lend that, so there was nothing to end." };
    const outcome = await revokeOwnerGrants(stamps, ownerKey, [holding.grant.id], Date.now(), "home");
    if (outcome.ended.length === 0) return { notice: "You no longer lend that, so there was nothing to end." };
    return { notice: outcome.notices[0] === "sent" ? "Ended. I told the conversation that used it." : "Ended. I could not tell the conversation that used it." };
  }
  return { notice: "That cannot be removed from here, so I changed nothing." };
});

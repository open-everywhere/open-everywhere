import { tryPrincipalKey } from "../identity/principal-key.js";
import { DEFAULT_WATCH_DIAL, type WatchDial } from "../personal-watch/dial.js";
import { enrollPersonalWatch, readPersonalWatch, recordPersonalWatchResponse, setPersonalWatchDial, type PersonalWatchWhere } from "../personal-watch/state.js";
import { personalWatchArmed } from "../personal-watch/watch.js";
import { registerHomeAction, registerHomeSection, type HomeBlock, type HomeItemAction, type HomeViewer } from "./home-view.js";

export const WATCH_HOME_ACTIONS = {
  more: "watch.more",
  less: "watch.less",
  none: "watch.none",
  useful: "watch.useful",
  dismiss: "watch.dismiss",
} as const;

const SCOPE_NOTE =
  "I watch your calendar and message you here when something needs you, such as two meetings that overlap. More, Less and None set how often I may interrupt. Less is where everyone starts. I stay quiet between 20:00 and 07:00 UTC. Mark a message Not useful and I hold back more; mark one Useful and I hold back less.";

const DIAL_WORDS: Readonly<Record<WatchDial, string>> = {
  more: "More: I tell you about conflicts up to three days ahead, at most six times a day.",
  less: "Less: I tell you only about conflicts within a day, at most twice a day.",
  none: "None: I do not look, and I do not message you.",
};

const ITEM_ACTIONS: readonly HomeItemAction[] = [
  { id: WATCH_HOME_ACTIONS.useful, label: "Useful", kind: "confirm", confirm: { title: "Was this useful?", yes: "Yes, useful", note: "I hold back a little less from now on." } },
  { id: WATCH_HOME_ACTIONS.dismiss, label: "Not useful", kind: "confirm", confirm: { title: "Not useful?", yes: "Not useful", note: "I hold back more from now on. On Less, two of these and I stop; on More, three. Mark one Useful or change the setting to start again." } },
];

function whereOf(viewer: HomeViewer): PersonalWatchWhere | undefined {
  const principalKey = tryPrincipalKey(viewer.platform, viewer.workspace, viewer.principalId);
  if (!principalKey) return undefined;
  return { org: viewer.org, platform: viewer.platform, workspace: viewer.workspace, surface: viewer.personal?.surface ?? "home", principalKey };
}

async function watchBlocks(viewer: HomeViewer): Promise<readonly HomeBlock[]> {
  const blocks: HomeBlock[] = [{ kind: "divider" }, { kind: "heading", text: "Your watch" }, { kind: "note", text: SCOPE_NOTE }];
  const where = whereOf(viewer);
  if (!where) {
    blocks.push({ kind: "note", text: "I could not tell who you are on this page, so I cannot show your watch." });
    return blocks;
  }
  if (viewer.trust !== "internal") {
    blocks.push({ kind: "note", text: "The watch is for members of this organisation." });
    const existing = await readPersonalWatch(where.org, where.principalKey);
    if (existing.state !== undefined && existing.state.dial !== "none") {
      blocks.push({ kind: "text", text: DIAL_WORDS[existing.state.dial] });
      blocks.push({ kind: "buttons", buttons: [{ id: WATCH_HOME_ACTIONS.none, label: "None" }] });
    }
    return blocks;
  }
  if (!personalWatchArmed()) blocks.push({ kind: "note", text: "This deployment has not connected a calendar for the watch yet, so I do not look. Your setting is kept for when it does." });
  await enrollPersonalWatch(where.org, where.principalKey);
  const read = await readPersonalWatch(where.org, where.principalKey);
  if (!read.readable) {
    blocks.push({ kind: "note", text: "I could not read your setting just now. Until I can, I do not message you. Try Refresh." });
    return blocks;
  }
  const dial = read.state?.dial ?? DEFAULT_WATCH_DIAL;
  const chosen = read.state?.dialSource === "default" || read.state === undefined ? " (the start setting)" : "";
  blocks.push({ kind: "text", text: `${DIAL_WORDS[dial]}${chosen}` });
  const dampening = read.state?.dampening ?? 0;
  if (dampening > 0) blocks.push({ kind: "note", text: `You marked ${dampening === 1 ? "a message" : "messages"} not useful, so I hold back ${dampening} step${dampening === 1 ? "" : "s"} more than this setting says.` });
  blocks.push({
    kind: "buttons",
    buttons: [
      { id: WATCH_HOME_ACTIONS.more, label: "More" },
      { id: WATCH_HOME_ACTIONS.less, label: "Less" },
      { id: WATCH_HOME_ACTIONS.none, label: "None" },
    ],
  });
  const recent = (read.state?.nudges ?? []).slice(-5).reverse();
  for (const n of recent) {
    const answered = n.response === "useful" ? "you marked it useful" : n.response === "dismissed" ? "you marked it not useful" : undefined;
    blocks.push({ kind: "item", text: `${n.at.slice(0, 16).replace("T", " ")} UTC: ${n.summary}${answered ? ` (${answered})` : ""}`, label: n.kind, ref: n.fingerprint, actions: ITEM_ACTIONS });
  }
  return blocks;
}

registerHomeSection({ id: "personal-watch", order: 50, build: watchBlocks });

function dialAction(dial: WatchDial) {
  return async (viewer: HomeViewer) => {
    const where = whereOf(viewer);
    if (!where) return { notice: "I could not tell who you are, so I changed nothing." };
    if (viewer.trust !== "internal" && dial !== "none") return { notice: "The watch is for members of this organisation, so I changed nothing." };
    try {
      const r = await setPersonalWatchDial(where, dial, "app-home", undefined, { existingOnly: viewer.trust !== "internal" });
      if (!r.written) return { notice: "You have no watch: it is for members of this organisation." };
      return { notice: r.changed ? `Done. ${DIAL_WORDS[dial]}` : `It was already set. ${DIAL_WORDS[dial]}` };
    } catch (err) {
      console.warn(`[open-everywhere:watch-home] dial ${dial} failed: ${String(err)}`);
      return { notice: "I could not change your setting just now. Nothing changed. Try again in a moment." };
    }
  };
}

registerHomeAction(WATCH_HOME_ACTIONS.more, dialAction("more"));
registerHomeAction(WATCH_HOME_ACTIONS.less, dialAction("less"));
registerHomeAction(WATCH_HOME_ACTIONS.none, dialAction("none"));

function responseAction(response: "useful" | "dismissed") {
  return async (viewer: HomeViewer, ref: string | undefined) => {
    const where = whereOf(viewer);
    if (!where || !ref) return { notice: "I could not find that message, so I changed nothing." };
    try {
      const r = await recordPersonalWatchResponse(where, ref, response, "app-home");
      if (r.outcome === "unknown") return { notice: "I could not find that message any more, so I changed nothing." };
      if (r.outcome === "unchanged") return { notice: "You already told me that." };
      return { notice: response === "useful" ? "Thanks. I hold back a little less from now on." : "Thanks. I hold back more from now on." };
    } catch (err) {
      console.warn(`[open-everywhere:watch-home] ${response} failed: ${String(err)}`);
      return { notice: "I could not save that just now. Nothing changed. Try again in a moment." };
    }
  };
}

registerHomeAction(WATCH_HOME_ACTIONS.useful, responseAction("useful"));
registerHomeAction(WATCH_HOME_ACTIONS.dismiss, responseAction("dismissed"));

import { createHash } from "node:crypto";

import { tryPrincipalKey } from "../identity/principal-key.js";
import { getOperationalStore } from "../operational/provider.js";
import { listAllRoutines } from "../routines/store.js";
import { describeTrigger, type Routine } from "../routines/routine.js";
import { routineWords } from "../routines/schedule-words.js";
import { plainValue } from "../approvals/plain-text.js";
import { placeWords } from "../channels/friendly-ids.js";
import { ownerLiveGrants } from "../access/credential-grant-revoke.js";
import { watchWords } from "../routines/ask-watch.js";
import { readPersonalWatch } from "../personal-watch/state.js";
import { personalWatchArmed, personalWatchDecl } from "../personal-watch/watch.js";
import { discoveryOn } from "../personal-watch/discovery.js";
import type { WatchDial } from "../personal-watch/dial.js";
import { waitingOnPerson, type WaitingDeps } from "./waiting-on-me.js";

export type DoingAction = "pause" | "remove";

export type DoingKind = "routine" | "watch" | "grant" | "rule" | "waiting";

export interface DoingItem {
  readonly kind: DoingKind;
  readonly text: string;
  readonly label: string;
  readonly state: "on" | "paused";
  readonly ref?: string;
  readonly actions: readonly DoingAction[];
  readonly roomKey?: string;
  readonly link?: string;
}

export interface DoingPerson {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly personId: string;
  readonly enterprise?: string;
  readonly dmSurfaceKey?: string;
  readonly trust: "internal" | "external";
}

export interface DoingList {
  readonly items: readonly DoingItem[];
  readonly unread: readonly string[];
  readonly waitingOmitted: number;
}

export interface DoingDeps extends WaitingDeps {
  readonly routines?: () => Promise<readonly Routine[]>;
}

export const DOING_PAUSED_REASON = "you paused it from your list of what I do for you";

export function doingRef(kind: DoingKind, key: string): string {
  return createHash("sha256").update(`doing:${kind}:${key}`).digest("hex");
}

export const DOING_WATCH_KEY = "chief-of-staff";

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function capital(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function routineLabel(r: Routine): string {
  if (r.sessionMode === "job") return "Job";
  if (r.trigger.kind === "watch" || r.trigger.kind === "event") return "Watch";
  return "Routine";
}

export function routineIsTheirs(r: Routine, person: Pick<DoingPerson, "org" | "platform" | "workspace" | "personId">): boolean {
  return r.org === person.org && r.createdBy === person.personId && r.surfaceKey.startsWith(`${person.platform}/${person.workspace}/`) && r.status !== "done";
}

function routineItem(r: Routine, person: DoingPerson & { readonly dmSurfaceKey: string }): DoingItem {
  const inDm = r.surfaceKey === person.dmSurfaceKey;
  const paused = r.status !== "active";
  const watch = watchWords(r.trigger, r.watchFor);
  const trigger = capital(watch ?? routineWords(describeTrigger(r.trigger, r.report)));
  const what = inDm && watch === undefined ? `${trigger}: ${plainValue(r.prompt, 90)}` : trigger;
  const ran = r.disabledReason?.startsWith("once: fired and ") === true;
  const stopped = !paused
    ? ""
    : r.trigger.kind === "once"
      ? ran
        ? " (it already ran, so nothing is left to do; Remove clears it)"
        : " (it did not run; ask me why. Remove clears it)"
      : r.disabledReason === DOING_PAUSED_REASON
        ? " (paused by you; ask me in our DM to turn it back on)"
        : " (stopped; ask me why, or to turn it back on)";
  const actions: readonly DoingAction[] = paused || r.trigger.kind === "once" ? ["remove"] : ["pause", "remove"];
  return {
    kind: "routine",
    label: routineLabel(r),
    text: clip(`${what}${stopped}`, 300),
    state: paused ? "paused" : "on",
    ...(inDm ? { ref: doingRef("routine", `${r.surfaceKey}#${r.id}`), actions } : { actions: [], roomKey: r.surfaceKey }),
  };
}

async function routineItems(person: DoingPerson, deps: DoingDeps): Promise<DoingItem[]> {
  const dmSurfaceKey = person.dmSurfaceKey;
  if (dmSurfaceKey === undefined) throw new Error("no DM room");
  const all = await (deps.routines ?? listAllRoutines)();
  const theirs = all.filter((r) => routineIsTheirs(r, person));
  theirs.sort((a, b) => (a.status === "active") === (b.status === "active") ? (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) : a.status === "active" ? -1 : 1);
  return theirs.map((r) => routineItem(r, { ...person, dmSurfaceKey }));
}

function watchSourceWords(): string {
  const detectors = new Set(personalWatchDecl().sources.map((s) => s.detect));
  return detectors.has("calendar-conflicts") ? "your calendar, for meetings that overlap" : "your sources";
}

const DIAL_SHORT: Readonly<Record<WatchDial, string>> = {
  more: "More (up to three days ahead)",
  less: "Less (within a day)",
  none: "None",
};

async function watchItem(person: DoingPerson): Promise<DoingItem | undefined> {
  const principalKey = tryPrincipalKey(person.platform, person.workspace, person.personId);
  if (principalKey === undefined) throw new Error("no principal key");
  const read = await readPersonalWatch(person.org, principalKey);
  if (!read.readable) throw new Error("watch unreadable");
  const state = read.state;
  if (state === undefined) return undefined;
  if (person.trust !== "internal" && state.dial === "none") return undefined;
  const armed = personalWatchArmed();
  const paused = state.dial === "none";
  const text = paused
    ? "My watch over your calendar is off. Turn it back on with /oe watch less."
    : `I watch ${watchSourceWords()}, and message you here when something needs you. Setting: ${DIAL_SHORT[state.dial]}.${armed ? "" : discoveryOn() ? " No calendar is connected yet. I still look for work you repeat each week." : " No calendar is connected yet, so I do not look."}`;
  return { kind: "watch", label: "Watch", text, state: paused ? "paused" : "on", ...(paused ? { actions: [] } : { ref: doingRef("watch", DOING_WATCH_KEY), actions: ["pause"] as const }) };
}

async function grantItems(person: DoingPerson): Promise<DoingItem[]> {
  const ownerKey = tryPrincipalKey(person.platform, person.workspace, person.personId);
  if (ownerKey === undefined) throw new Error("no principal key");
  const holdings = await ownerLiveGrants(person.org, ownerKey, Date.now());
  return holdings.map((h) => ({
    kind: "grant" as const,
    label: "Lending",
    text: clip(capital(h.phrase), 300),
    state: "on" as const,
    ref: doingRef("grant", h.grant.id),
    actions: ["remove"] as const,
  }));
}

async function ruleItems(person: DoingPerson): Promise<DoingItem[]> {
  if (person.dmSurfaceKey === undefined) throw new Error("no DM room");
  const rules = await getOperationalStore().listDmRules(person.org, person.dmSurfaceKey);
  return rules
    .filter((r) => r.ownerId === person.personId)
    .map((r) => ({ kind: "rule" as const, label: "Rule", text: clip(r.rule, 300), state: "on" as const, ref: doingRef("rule", r.ruleId), actions: ["remove"] as const }));
}

async function waitingItems(person: DoingPerson, deps: DoingDeps): Promise<{ items: DoingItem[]; unread: readonly string[]; omitted: number }> {
  const queue = await waitingOnPerson(
    { org: person.org, platform: person.platform, workspace: person.workspace, personId: person.personId, ...(person.enterprise ? { enterprise: person.enterprise } : {}) },
    deps,
  );
  return {
    unread: queue.unread,
    omitted: queue.omitted,
    items: queue.items.map((w) => ({
      kind: "waiting" as const,
      label: "Waiting on you",
      text: clip(`${w.sentence} (${w.status})`, 300),
      state: "on" as const,
      actions: [],
      ...(w.link ? { link: w.link } : {}),
    })),
  };
}

export async function doingForPerson(person: DoingPerson, deps: DoingDeps = {}): Promise<DoingList> {
  const unread: string[] = [];
  const part = async <T>(what: string, read: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await read();
    } catch {
      unread.push(what);
      return empty;
    }
  };
  const routines = await part("your routines", () => routineItems(person, deps), [] as DoingItem[]);
  const watch = await part("your watch", () => watchItem(person), undefined);
  const grants = await part("what you lend", () => grantItems(person), [] as DoingItem[]);
  const rules = await part("your rules", () => ruleItems(person), [] as DoingItem[]);
  const waiting = await part("what is waiting on you", () => waitingItems(person, deps), { items: [] as DoingItem[], unread: [] as readonly string[], omitted: 0 });
  unread.push(...waiting.unread);
  return { items: [...routines, ...(watch ? [watch] : []), ...grants, ...rules, ...waiting.items], unread, waitingOmitted: waiting.omitted };
}

export function renderDoingMessage(list: DoingList, platform = "slack"): string {
  const lines: string[] = [];
  if (list.items.length === 0) lines.push("I do nothing for you on my own right now: no routines, no watch, nothing you lend, no rules, and nothing waiting on you.");
  else lines.push(`Here is everything I do for you (${list.items.length}):`);
  list.items.forEach((item, i) => {
    const where = item.roomKey ? ` In ${placeWords({ key: item.roomKey })}; ask there to stop it.` : "";
    const link = item.link ? ` ${item.link}` : "";
    lines.push(`${i + 1}. ${item.label}: ${item.text}${where}${link}`);
  });
  if (list.waitingOmitted > 0) lines.push(`…and ${list.waitingOmitted} more waiting on you, not shown.`);
  for (const what of list.unread) lines.push(`(I could not read ${what} just now, so this list may be missing some.)`);
  if (list.items.some((i) => i.actions.length > 0)) lines.push(platform === "slack" ? "To pause or remove one, use the buttons on my Home tab, or ask me to stop it." : "To pause or remove one, ask me to stop it.");
  return lines.join("\n");
}

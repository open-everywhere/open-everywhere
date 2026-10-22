import { getSettings } from "../settings/settings.js";
import { appendAudit } from "../audit/audit.js";
import type { SurfaceBinding } from "../identity/binding.js";
import { actingPrincipalId, unattendedFrom } from "../identity/binding.js";
import { parsePrincipalKey, tryPrincipalKey } from "../identity/principal-key.js";
import type { Partition } from "../memory/partition.js";
import type { RoutineCreateArgs } from "../approvals/routine-create.js";
import { readPersonalWatch, updatePersonalWatch, type PersonalWatchState, type WatchProposalRecord } from "../personal-watch/state.js";
import { WATCH_EMPTY_STATE } from "../routines/watch.js";
import { firstConversationDays } from "./first-routine.js";

export const FIRST_DAY_BRIEF_FINGERPRINT = "first-day-brief";

export const FIRST_DAY_BRIEF_SUMMARY = "a morning brief and check-ins";

export const BRIEF_CRON = "0 9 * * 1-5";

export const NEEDS_YOU_CRON = "0 11,14,17 * * 1-5";

export const WHAT_NEEDS_THEM =
  "messages and threads that wait on their answer, reviews and approvals they owe, meetings that need something from them, and work that is due";

export const BRIEF_PROMPT =
  `This is the morning brief for the person who set it up. Look across the apps they have connected for what needs them today: ${WHAT_NEEDS_THEM}. ` +
  "Post a short brief: at most six lines, most urgent first, each with what it is, where it is and why it needs them. " +
  "If nothing needs them, say so in one line. Use friendly names, never an id. Ask before you change anything. " +
  'On the first run only, end with one line: they can tell you here to change the time, the topics or how often you check, or to stop.';

export const NEEDS_YOU_PROMPT =
  `This checks what needs the person who set it up. Look across the apps they have connected for what needs them now: ${WHAT_NEEDS_THEM}. ` +
  "Record the state as one line per item, with a stable name for each item and no times or counts that change on every look. " +
  `If nothing needs them, record exactly \`${WATCH_EMPTY_STATE}\`. ` +
  "When the state changed, post the items that need them now, at most three lines, with friendly names and never an id. " +
  "Ask before you change anything.";

export interface FirstDayBriefArgs {
  readonly scope: "first-day";
  readonly org: string;
  readonly principalKey: string;
  readonly personId: string;
  readonly fingerprint: string;
  readonly brief: RoutineCreateArgs;
  readonly needsYou: RoutineCreateArgs;
}

export function firstDayBriefArgs(input: {
  readonly org: string;
  readonly principalKey: string;
  readonly personId: string;
  readonly surfaceKey: string;
  readonly target: unknown;
}): FirstDayBriefArgs {
  const [platform = "", workspace = "", ...rest] = input.surfaceKey.split("/");
  const surface = rest.join("/");
  const partition: Partition = { org: input.org, platform, workspace, surface, workspaceKey: `${platform}/${workspace}`, surfaceKey: input.surfaceKey, domainKey: input.surfaceKey, key: input.surfaceKey };
  const base = { org: input.org, partition, surfaceKey: input.surfaceKey, target: input.target, createdBy: input.personId } as const;
  return {
    scope: "first-day",
    org: input.org,
    principalKey: input.principalKey,
    personId: input.personId,
    fingerprint: FIRST_DAY_BRIEF_FINGERPRINT,
    brief: { ...base, trigger: { kind: "cron", expr: BRIEF_CRON }, prompt: BRIEF_PROMPT, firstRunNow: true },
    needsYou: { ...base, trigger: { kind: "watch", expr: NEEDS_YOU_CRON }, prompt: NEEDS_YOU_PROMPT, quietWhenEmpty: true },
  };
}

export type ProposeFirstDayBrief = (input: { readonly org: string; readonly principalKey: string }) => Promise<{ readonly ok: true; readonly cardId: string } | { readonly ok: false; readonly reason: string }>;

export interface FirstDayBriefDeps {
  readonly propose: ProposeFirstDayBrief;
  readonly dmStopped: (org: string, principalKey: string) => Promise<boolean>;
  readonly readWatch?: typeof readPersonalWatch;
  readonly updateWatch?: (org: string, principalKey: string, mutate: (cur: PersonalWatchState, existed: boolean) => PersonalWatchState | undefined) => Promise<PersonalWatchState | undefined>;
}

export type FirstDayBriefOutcome =
  | { readonly offered: true; readonly cardId: string }
  | { readonly offered: false; readonly skipped: "off" | "not-own-dm" | "settled" | "no-row" | "not-first-dm" | "already-offered" | "watch-none" | "dm-stopped" | "lost-race" | "refused" | "failed" };

const SETTLED = new Map<string, number>();
export const FIRST_DAY_SETTLED_RECHECK_MS = 60_000;

export function resetFirstDayBriefMemo(): void {
  SETTLED.clear();
}

export function firstDayWindowOpen(state: Pick<PersonalWatchState, "firstConversation">, surfaceKey: string, nowIso: string, days: number): boolean {
  const fc = state.firstConversation;
  if (!fc || fc.surfaceKey !== surfaceKey || fc.outcome === "declined" || days <= 0) return false;
  const since = Date.parse(fc.since);
  const now = Date.parse(nowIso);
  return Number.isFinite(since) && Number.isFinite(now) && now >= since && now - since < days * 86_400_000;
}

export async function offerFirstDayBrief(binding: SurfaceBinding, surfaceKey: string, deps: FirstDayBriefDeps, nowIso = new Date().toISOString()): Promise<FirstDayBriefOutcome> {
  try {
    const days = firstConversationDays();
    if (!getSettings().routines.firstDayBrief || days <= 0) return { offered: false, skipped: "off" };
    if (binding.mode !== "dm" || binding.trust !== "internal" || unattendedFrom(binding)) return { offered: false, skipped: "not-own-dm" };
    const acting = actingPrincipalId(binding);
    const principalKey = acting ? tryPrincipalKey(binding.platform, binding.workspace, acting) : undefined;
    if (!principalKey || !parsePrincipalKey(principalKey)) return { offered: false, skipped: "not-own-dm" };
    const memo = `${binding.org}|${principalKey}`;
    const nowMs = Date.parse(nowIso);
    if ((SETTLED.get(memo) ?? 0) > nowMs) return { offered: false, skipped: "settled" };
    const settle = (): void => void SETTLED.set(memo, nowMs + FIRST_DAY_SETTLED_RECHECK_MS);
    const read = await (deps.readWatch ?? readPersonalWatch)(binding.org, principalKey);
    if (!read.readable || read.state === undefined) return { offered: false, skipped: "no-row" };
    const state = read.state;
    if (state.proposals.some((p) => p.fingerprint === FIRST_DAY_BRIEF_FINGERPRINT)) {
      settle();
      return { offered: false, skipped: "already-offered" };
    }
    if (!firstDayWindowOpen(state, surfaceKey, nowIso, days)) {
      if (!state.firstConversation || state.firstConversation.surfaceKey === surfaceKey) settle();
      return { offered: false, skipped: "not-first-dm" };
    }
    if (state.dial === "none") return { offered: false, skipped: "watch-none" };
    if (await deps.dmStopped(binding.org, principalKey).catch(() => true)) return { offered: false, skipped: "dm-stopped" };
    const update = deps.updateWatch ?? ((o, k, m) => updatePersonalWatch(o, k, m, nowIso));
    const record: WatchProposalRecord = { fingerprint: FIRST_DAY_BRIEF_FINGERPRINT, summary: FIRST_DAY_BRIEF_SUMMARY, at: nowIso };
    const reserved = await update(binding.org, principalKey, (cur, existed) => (!existed || cur.proposals.some((p) => p.fingerprint === FIRST_DAY_BRIEF_FINGERPRINT) ? undefined : { ...cur, proposals: [...cur.proposals, record] }));
    if (!reserved) return { offered: false, skipped: "lost-race" };
    settle();
    const posted = await deps.propose({ org: binding.org, principalKey }).catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }));
    if (!posted.ok) {
      await update(binding.org, principalKey, (cur) => ({ ...cur, proposals: cur.proposals.filter((p) => !(p.fingerprint === record.fingerprint && p.at === record.at)) })).catch(() => undefined);
      console.warn(`[open-everywhere:first-day-brief] the card for ${principalKey} did not post: ${posted.reason}`);
      return { offered: false, skipped: "refused" };
    }
    const person = parsePrincipalKey(principalKey)!;
    await appendAudit({
      org: binding.org,
      platform: person.platform,
      workspace: person.tenant ?? "",
      surface: "home",
      principalId: principalKey,
      action: "personal_watch.proposal",
      detail: { fingerprint: FIRST_DAY_BRIEF_FINGERPRINT, kind: "first-day-brief", dial: reserved.dial },
    }).catch(() => undefined);
    return { offered: true, cardId: posted.cardId };
  } catch (err) {
    console.warn(`[open-everywhere:first-day-brief] the offer failed: ${String(err)}`);
    return { offered: false, skipped: "failed" };
  }
}

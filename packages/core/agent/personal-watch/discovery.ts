import { appendAudit } from "../audit/audit.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { getOperationalStore } from "../operational/provider.js";
import type { PersonConnectorCallRow } from "../operational/store.js";
import type { Partition } from "../memory/partition.js";
import type { RoutineCreateArgs } from "../approvals/routine-create.js";
import { toolWords, cronWords } from "../routines/schedule-words.js";
import { getSettings } from "../settings/settings.js";
import { WATCH_DIAL_POLICY, type WatchDial } from "./dial.js";
import { judgeFinding, type WatchSilenceReason } from "./judge.js";
import type { PersonalWatchState, WatchProposalRecord } from "./state.js";

export const ROUTINE_SUGGEST_KIND = "routine.suggest";

export const DISCOVERY_WINDOW_DAYS = 35;
export const DISCOVERY_RECENT_DAYS = 14;
export const DISCOVERY_WEEKDAY_SHARE = 0.6;
export const DISCOVERY_SCAN_EVERY_HOURS = 24;
export const DISCOVERY_READ_LIMIT = 2000;
export const PROPOSAL_GAP_DAYS: Readonly<Record<WatchDial, number | undefined>> = { more: 7, less: 14, none: undefined };

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MONDAY_EPOCH_MS = 4 * DAY_MS;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function discoveryMinWeeks(): number {
  return getSettings().routines.discoveryMinWeeks;
}

export function discoveryOn(): boolean {
  return discoveryMinWeeks() > 0;
}

export interface RepeatedWork {
  readonly fingerprint: string;
  readonly connector: string;
  readonly tool: string;
  readonly weekday: number;
  readonly hour: number;
  readonly weeks: number;
}

export function findRepeatedWork(calls: readonly PersonConnectorCallRow[], now: Date, minWeeks: number): RepeatedWork[] {
  if (minWeeks <= 0) return [];
  const from = now.getTime() - DISCOVERY_WINDOW_DAYS * DAY_MS;
  const firstWeek = Math.floor((now.getTime() - MONDAY_EPOCH_MS) / WEEK_MS) - 4;
  const recent = now.getTime() - DISCOVERY_RECENT_DAYS * DAY_MS;
  const ops = new Map<string, { connector: string; tool: string; dates: Set<string>; days: Map<number, { weeks: Set<number>; dates: Set<string>; hours: number[]; last: number }> }>();
  for (const c of calls) {
    const ms = Date.parse(c.ts);
    if (!Number.isFinite(ms) || ms < from || ms > now.getTime() || c.connector.length === 0) continue;
    const week = Math.floor((ms - MONDAY_EPOCH_MS) / WEEK_MS);
    if (week < firstWeek) continue;
    const key = `${c.connector}/${c.tool}`;
    let op = ops.get(key);
    if (!op) {
      op = { connector: c.connector, tool: c.tool, dates: new Set(), days: new Map() };
      ops.set(key, op);
    }
    const d = new Date(ms);
    const date = d.toISOString().slice(0, 10);
    op.dates.add(date);
    const weekday = d.getUTCDay();
    let day = op.days.get(weekday);
    if (!day) {
      day = { weeks: new Set(), dates: new Set(), hours: [], last: 0 };
      op.days.set(weekday, day);
    }
    day.weeks.add(week);
    day.dates.add(date);
    day.hours.push(d.getUTCHours());
    day.last = Math.max(day.last, ms);
  }
  const found: RepeatedWork[] = [];
  for (const [key, op] of ops) {
    for (const [weekday, day] of op.days) {
      if (day.weeks.size < minWeeks || day.last < recent) continue;
      if (day.dates.size / op.dates.size < DISCOVERY_WEEKDAY_SHARE) continue;
      const hours = [...day.hours].sort((a, b) => a - b);
      found.push({ fingerprint: `weekly:${key}:${weekday}`, connector: op.connector, tool: op.tool, weekday, hour: hours[Math.floor((hours.length - 1) / 2)]!, weeks: day.weeks.size });
    }
  }
  return found.sort((a, b) => b.weeks - a.weeks || a.fingerprint.localeCompare(b.fingerprint));
}

export function proposalCron(w: Pick<RepeatedWork, "weekday" | "hour">): string {
  return `0 ${w.hour} * * ${w.weekday}`;
}

export function repeatedWorkWords(w: Pick<RepeatedWork, "connector" | "tool">): string {
  return toolWords(`${w.connector}__${w.tool}`);
}

export function repeatedWorkSummary(w: RepeatedWork): string {
  return `${repeatedWorkWords(w)} on ${DAY_NAMES[w.weekday]}s, in ${w.weeks} of the last 5 weeks`;
}

export function proposalPrompt(w: Pick<RepeatedWork, "connector" | "tool" | "weekday">): string {
  return (
    `It is ${DAY_NAMES[w.weekday]}. The person who set this up asks me to ${repeatedWorkWords(w)} most ${DAY_NAMES[w.weekday]}s. ` +
    `Do it for them now with the ${w.connector} connection, the way they usually ask, and post what you found here. Ask before you change anything.`
  );
}

export interface RoutineSuggestArgs {
  readonly org: string;
  readonly principalKey: string;
  readonly personId: string;
  readonly fingerprint: string;
  readonly summary: string;
  readonly work: string;
  readonly weeks: number;
  readonly create: RoutineCreateArgs;
}

export function routineSuggestArgs(input: {
  readonly org: string;
  readonly principalKey: string;
  readonly personId: string;
  readonly surfaceKey: string;
  readonly target: unknown;
  readonly work: RepeatedWork;
}): RoutineSuggestArgs {
  const [platform = "", workspace = "", ...rest] = input.surfaceKey.split("/");
  const surface = rest.join("/");
  const workspaceKey = `${platform}/${workspace}`;
  const partition: Partition = { org: input.org, platform, workspace, surface, workspaceKey, surfaceKey: input.surfaceKey, domainKey: input.surfaceKey, key: input.surfaceKey };
  return {
    org: input.org,
    principalKey: input.principalKey,
    personId: input.personId,
    fingerprint: input.work.fingerprint,
    summary: repeatedWorkSummary(input.work),
    work: repeatedWorkWords(input.work),
    weeks: input.work.weeks,
    create: {
      org: input.org,
      partition,
      surfaceKey: input.surfaceKey,
      target: input.target,
      trigger: { kind: "cron", expr: proposalCron(input.work) },
      prompt: proposalPrompt(input.work),
      createdBy: input.personId,
    },
  };
}

export function proposalWhen(args: Pick<RoutineSuggestArgs, "create">): string {
  const t = args.create.trigger;
  return t.kind === "cron" ? cronWords(t.expr) : "on its own";
}

export type ProposeRoutine = (input: { readonly org: string; readonly principalKey: string; readonly work: RepeatedWork }) => Promise<{ readonly ok: true; readonly cardId: string } | { readonly ok: false; readonly reason: string }>;

export interface DiscoveryDeps {
  readonly propose: ProposeRoutine;
  readonly dmStopped: (org: string, principalKey: string) => Promise<boolean>;
  readonly readCalls?: (org: string, principalId: string, surfacePrefix: string, since: string, limit: number) => Promise<PersonConnectorCallRow[]>;
}

export function discoveryScanDue(state: Pick<PersonalWatchState, "lastDiscoveryAt">, now: Date): boolean {
  if (state.lastDiscoveryAt === undefined) return true;
  const last = Date.parse(state.lastDiscoveryAt);
  return !Number.isFinite(last) || now.getTime() - last >= DISCOVERY_SCAN_EVERY_HOURS * 3_600_000;
}

export function judgeProposal(state: Pick<PersonalWatchState, "dial" | "dampening" | "nudges" | "proposals">, now: Date): { readonly propose: true } | { readonly propose: false; readonly reason: WatchSilenceReason } {
  const sent = [...state.nudges.map((n) => n.at), ...state.proposals.map((p) => p.at)].sort();
  const verdict = judgeFinding({ urgency: "soon" }, { dial: state.dial, dampening: state.dampening, nudgedAt: sent }, now);
  if (!verdict.interrupt) return { propose: false, reason: verdict.reason };
  const gap = PROPOSAL_GAP_DAYS[state.dial];
  if (gap === undefined) return { propose: false, reason: "dial-none" };
  const last = state.proposals.reduce((m, p) => Math.max(m, Date.parse(p.at) || 0), 0);
  if (last > 0 && now.getTime() - last < gap * DAY_MS) return { propose: false, reason: "proposal-gap" };
  return { propose: true };
}

export interface DiscoveryOutcome {
  readonly proposed: boolean;
  readonly held?: { readonly work: RepeatedWork; readonly reason: WatchSilenceReason };
}

export async function discoverForPerson(
  org: string,
  principalKey: string,
  state: PersonalWatchState,
  deps: DiscoveryDeps,
  now: Date,
  update: (mutate: (cur: PersonalWatchState, existed: boolean) => PersonalWatchState | undefined) => Promise<PersonalWatchState | undefined>,
): Promise<DiscoveryOutcome> {
  const none: DiscoveryOutcome = { proposed: false };
  if (!discoveryOn() || WATCH_DIAL_POLICY[state.dial].checkEveryMinutes === undefined || !discoveryScanDue(state, now)) return none;
  const person = parsePrincipalKey(principalKey);
  if (!person) return none;
  try {
    const claimed = await update((cur, existed) => (existed && discoveryScanDue(cur, now) ? { ...cur, lastDiscoveryAt: now.toISOString() } : undefined));
    if (!claimed) return none;
    const prefix = person.tenant !== undefined ? `${person.platform}/${person.tenant}/` : `${person.platform}/`;
    const since = new Date(now.getTime() - DISCOVERY_WINDOW_DAYS * DAY_MS).toISOString();
    const read = deps.readCalls ?? ((o, p, s, f, l) => getOperationalStore().listPersonConnectorCalls(o, p, s, f, l));
    const calls = await read(org, person.id, prefix, since, DISCOVERY_READ_LIMIT);
    const offered = new Set(claimed.proposals.map((p) => p.fingerprint));
    const work = findRepeatedWork(calls, now, discoveryMinWeeks()).find((w) => !offered.has(w.fingerprint));
    if (!work) return none;
    const verdict = judgeProposal(claimed, now);
    if (!verdict.propose) return { proposed: false, held: { work, reason: verdict.reason } };
    if (await deps.dmStopped(org, principalKey).catch(() => true)) return { proposed: false, held: { work, reason: "dm-stopped" } };
    const record: WatchProposalRecord = { fingerprint: work.fingerprint, summary: repeatedWorkSummary(work), at: now.toISOString() };
    let late: WatchSilenceReason | undefined;
    const reserved = await update((cur, existed) => {
      if (!existed || cur.proposals.some((p) => p.fingerprint === work.fingerprint)) return undefined;
      const again = judgeProposal(cur, now);
      if (!again.propose) {
        late = again.reason;
        return undefined;
      }
      return { ...cur, proposals: [...cur.proposals, record] };
    });
    if (!reserved) return late !== undefined ? { proposed: false, held: { work, reason: late } } : none;
    const posted = await deps.propose({ org, principalKey, work }).catch((err: unknown) => ({ ok: false as const, reason: String(err) }));
    if (!posted.ok) {
      await update((cur) => ({ ...cur, proposals: cur.proposals.filter((p) => !(p.fingerprint === record.fingerprint && p.at === record.at)) })).catch(() => undefined);
      console.warn(`[open-everywhere:personal-watch] a routine proposal for ${principalKey} did not post: ${posted.reason}`);
      return { proposed: false, held: { work, reason: "delivery-refused" } };
    }
    await appendAudit({
      org,
      platform: person.platform,
      workspace: person.tenant ?? "",
      surface: "home",
      principalId: principalKey,
      action: "personal_watch.proposal",
      detail: { fingerprint: work.fingerprint, connector: work.connector, tool: work.tool, weekday: work.weekday, hour: work.hour, weeks: work.weeks, dial: reserved.dial },
    }).catch(() => undefined);
    return { proposed: true };
  } catch (err) {
    console.warn(`[open-everywhere:personal-watch] workflow discovery failed for ${principalKey}: ${String(err)}`);
    return none;
  }
}

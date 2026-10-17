import { auditErrorDetail } from "../audit/tool-action.js";
import { appendAudit, noteAuditDrop } from "../audit/audit.js";
import { personAddress, readDmAudience } from "../channels/dm-audience.js";
import { deploymentOrg } from "../identity/binding.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { getOperationalStore } from "../operational/provider.js";
import { connectorToolPermissionKind } from "../approvals/session-grant.js";
import { MAX_ROUTINE_COLLECTORS, collectRoutineInputs, resolveRoutineCollector, type CollectedInput } from "../routines/collector.js";
import { findCalendarConflicts, readCalendarBody, type CalendarConflict } from "./calendar.js";
import { WATCH_DIAL_POLICY, WATCH_URGENCIES, calibrationDue } from "./dial.js";
import { judgeFinding, type WatchFinding, type WatchSilenceReason } from "./judge.js";
import { parseWatchState, updatePersonalWatch, type PersonalWatchState } from "./state.js";
import type { WatchDelivery, WatchDeliveryResult } from "./deliver.js";
import { discoverForPerson, discoveryOn, repeatedWorkSummary, type ProposeRoutine } from "./discovery.js";
import type { PersonConnectorCallRow } from "../operational/store.js";

export type PersonalWatchDetectorName = "calendar-conflicts";

export const PERSONAL_WATCH_DETECTORS: readonly PersonalWatchDetectorName[] = ["calendar-conflicts"];

export interface PersonalWatchSourceDecl {
  readonly collector: string;
  readonly detect: PersonalWatchDetectorName;
}

export interface PersonalWatchDecl {
  readonly sources: readonly PersonalWatchSourceDecl[];
}

let DECL: PersonalWatchDecl = { sources: [] };

export function registerPersonalWatch(decl: PersonalWatchDecl): void {
  const seen = new Set<string>();
  if (decl.sources.length > MAX_ROUTINE_COLLECTORS) {
    throw new Error(`personal watch: ${decl.sources.length} sources declared, and a watch reads at most ${MAX_ROUTINE_COLLECTORS}`);
  }
  for (const s of decl.sources) {
    if (!(PERSONAL_WATCH_DETECTORS as readonly string[]).includes(s.detect)) {
      throw new Error(`personal watch: unknown detector "${s.detect}" (core ships: ${PERSONAL_WATCH_DETECTORS.join(", ")})`);
    }
    if (resolveRoutineCollector(s.collector) === undefined) {
      throw new Error(`personal watch: source "${s.collector}" names no collector in agent/routines/collectors.ts — declare the collector first`);
    }
    if (resolveRoutineCollector(s.collector)?.personal !== true) {
      throw new Error(
        `personal watch: source "${s.collector}" is a shared read — declare it \`personal: true\` in agent/routines/collectors.ts, and register a reader that reads as one person (registerRoutineCollectorReader(reader, { personal: true }))`,
      );
    }
    if (seen.has(s.collector)) throw new Error(`personal watch: source "${s.collector}" is declared twice`);
    seen.add(s.collector);
  }
  DECL = { sources: [...decl.sources] };
}

export function personalWatchDecl(): PersonalWatchDecl {
  return DECL;
}

export function personalWatchArmed(): boolean {
  return DECL.sources.length > 0;
}

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

function dayOf(ms: number): string {
  return new Date(ms).toUTCString().slice(0, 11);
}

export function calendarConflictFinding(c: CalendarConflict, now: Date): WatchFinding {
  const hours = Math.max(0, Math.round((c.a.startMs - now.getTime()) / 3_600_000));
  const overlapStart = Math.max(c.a.startMs, c.b.startMs);
  return {
    kind: "calendar-conflict",
    fingerprint: c.fingerprint,
    urgency: c.urgency,
    summary: `two of the person's events overlap on ${dayOf(overlapStart)} from ${hhmm(overlapStart)} UTC (the first starts in about ${hours} hour${hours === 1 ? "" : "s"})`,
    facts: [`• ${hhmm(c.a.startMs)}–${hhmm(c.a.endMs)} UTC: ${c.a.title}`, `• ${hhmm(c.b.startMs)}–${hhmm(c.b.endMs)} UTC: ${c.b.title}`].join("\n"),
  };
}

type SourceOutcome = { readonly findings: readonly WatchFinding[] } | { readonly silence: WatchSilenceReason; readonly key: string; readonly summary: string };

function detect(source: PersonalWatchSourceDecl, collected: CollectedInput | undefined, now: Date): SourceOutcome {
  if (!collected || !collected.ok) {
    return { silence: "read-failed", key: `read:${source.collector}`, summary: `the read "${source.collector}" failed: ${collected && !collected.ok ? collected.failure : "it did not run"}` };
  }
  switch (source.detect) {
    case "calendar-conflicts": {
      const read = readCalendarBody(collected.body);
      if (!read.ok) return { silence: "unreadable", key: `unreadable:${source.collector}`, summary: `the read "${source.collector}" answered in a shape the calendar detector does not read` };
      return { findings: findCalendarConflicts(read.events, now).map((c) => calendarConflictFinding(c, now)) };
    }
  }
}

export interface PersonalWatchTickDeps {
  readonly deliver: (d: WatchDelivery) => Promise<WatchDeliveryResult>;
  readonly org?: string;
  readonly now?: Date;
  readonly collect?: typeof collectRoutineInputs;
  readonly dmStopped?: (org: string, principalKey: string) => Promise<boolean>;
  readonly budgetMs?: number;
  readonly propose?: ProposeRoutine;
  readonly readCalls?: (org: string, principalId: string, surfacePrefix: string, since: string, limit: number) => Promise<PersonConnectorCallRow[]>;
}

export interface PersonalWatchTickReport {
  readonly checked: number;
  readonly nudged: number;
  readonly proposed: number;
  readonly silenced: number;
  readonly deferred: number;
}

export const PERSONAL_WATCH_TICK_BUDGET_MS = 5 * 60_000;

async function liveDmStopped(org: string, principalKey: string): Promise<boolean> {
  const p = parsePrincipalKey(principalKey);
  if (!p) return true;
  return (await readDmAudience(org, personAddress(p.platform, p.id))).stopped;
}

async function fileSilence(org: string, principalKey: string, reason: WatchSilenceReason, detail: Readonly<Record<string, unknown>>): Promise<boolean> {
  const p = parsePrincipalKey(principalKey);
  const platform = p?.platform ?? "unknown";
  const ts = new Date().toISOString();
  const attempt = (): Promise<boolean> =>
    getOperationalStore()
      .appendAudit({ ts, org, platform, workspace: p?.tenant ?? "", surface: "home", principalId: principalKey, action: "personal_watch.silence", detail: { ...detail, reason } })
      .then(
        () => true,
        () => false,
      );
  const landed = (await attempt()) || (await attempt());
  if (!landed) noteAuditDrop("personal_watch.silence", platform);
  return landed;
}

interface CheckResult {
  readonly nudged: boolean;
  readonly silences: Readonly<Record<string, WatchSilenceReason>>;
  readonly cleared: readonly string[];
}

function rank(f: WatchFinding): number {
  return WATCH_URGENCIES.indexOf(f.urgency);
}

function nextCheckAfter(state: PersonalWatchState, now: Date): string | undefined {
  const every = WATCH_DIAL_POLICY[state.dial].checkEveryMinutes;
  return every === undefined ? undefined : new Date(now.getTime() + every * 60_000).toISOString();
}

export async function checkPerson(org: string, principalKey: string, state: PersonalWatchState, deps: PersonalWatchTickDeps, now: Date): Promise<CheckResult & { silencedRows: number; proposed: boolean }> {
  const silences: Record<string, WatchSilenceReason> = {};
  const lost: string[] = [];
  let silencedRows = 0;
  const silence = async (key: string, reason: WatchSilenceReason, detail: Readonly<Record<string, unknown>>, force = false): Promise<void> => {
    if (!force && state.silenced[key] === reason) {
      silences[key] = reason;
      return;
    }
    if (await fileSilence(org, principalKey, reason, { ...detail, dial: state.dial, dampening: state.dampening, fingerprint: key })) {
      silences[key] = reason;
      silencedRows++;
    } else if (force) {
      lost.push(key);
      console.warn(`[open-everywhere:personal-watch] a ${reason} row for ${principalKey} did not land, and the finding stays told after a failed release — this row is lost and is NOT filed again`);
    } else {
      lost.push(key);
      console.warn(`[open-everywhere:personal-watch] a ${reason} row for ${principalKey} did not land — the next check that holds this finding back files a row`);
    }
  };

  const sources = DECL.sources;
  const collected =
    sources.length === 0
      ? []
      : await (deps.collect ?? collectRoutineInputs)({
          org,
          routineId: `personal-watch:${principalKey}`,
          names: sources.map((s) => s.collector),
          heldKinds: sources.map((s) => connectorToolPermissionKind(resolveRoutineCollector(s.collector)?.tool ?? "")),
          forPrincipal: principalKey,
        });
  const findings: WatchFinding[] = [];
  const cleared: string[] = [];
  for (const source of sources) {
    const outcome = detect(source, collected.find((c) => c.name === source.collector), now);
    if ("silence" in outcome) await silence(outcome.key, outcome.silence, { kind: "source", summary: outcome.summary });
    else {
      cleared.push(`read:${source.collector}`, `unreadable:${source.collector}`);
      findings.push(...outcome.findings);
    }
  }

  const told = new Set(state.told);
  const fresh = findings.filter((f) => !told.has(f.fingerprint)).sort((x, y) => rank(y) - rank(x) || x.fingerprint.localeCompare(y.fingerprint));
  let nudged = false;
  for (const f of fresh) {
    const base = { kind: f.kind, urgency: f.urgency, summary: f.summary };
    if (nudged) {
      await silence(f.fingerprint, "min-gap", base);
      continue;
    }
    const verdict = judgeFinding(f, { dial: state.dial, dampening: state.dampening, nudgedAt: state.nudges.map((n) => n.at) }, now);
    if (!verdict.interrupt) {
      await silence(f.fingerprint, verdict.reason, base);
      continue;
    }
    if (await (deps.dmStopped ?? liveDmStopped)(org, principalKey).catch(() => true)) {
      await silence(f.fingerprint, "dm-stopped", base);
      continue;
    }
    const record = { fingerprint: f.fingerprint, kind: f.kind, summary: f.summary, at: now.toISOString() };
    let late: WatchSilenceReason | "told" | undefined;
    let current: PersonalWatchState | undefined;
    let calibrationAsk = false;
    const reserved = await updatePersonalWatch(
      org,
      principalKey,
      (cur, existed) => {
        if (!existed) return undefined;
        if (cur.told.includes(f.fingerprint)) {
          late = "told";
          return undefined;
        }
        const again = judgeFinding(f, { dial: cur.dial, dampening: cur.dampening, nudgedAt: cur.nudges.map((n) => n.at) }, now);
        if (!again.interrupt) {
          late = again.reason;
          return undefined;
        }
        current = cur;
        calibrationAsk = calibrationDue({ nudgesSinceAsk: cur.nudgesSinceAsk, lastAskedAt: cur.lastAskedAt, now });
        return {
          ...cur,
          told: [...cur.told, f.fingerprint],
          nudges: [...cur.nudges, record],
          ...(calibrationAsk ? { lastAskedAt: record.at, nudgesSinceAsk: 0 } : { nudgesSinceAsk: cur.nudgesSinceAsk + 1 }),
        };
      },
      now.toISOString(),
    );
    if (!reserved || !current) {
      if (late !== undefined && late !== "told") await silence(f.fingerprint, late, base);
      continue;
    }
    const live: PersonalWatchState = current;
    const result = await deps.deliver({ org, principalKey, finding: f, calibrationAsk, now }).catch((err: unknown): WatchDeliveryResult => ({ ok: false, reason: auditErrorDetail(err).error }));
    if (!result.ok) {
      const released = await updatePersonalWatch(
        org,
        principalKey,
        (cur) => {
          const { lastAskedAt: _a, ...rest } = cur;
          return {
            ...rest,
            told: cur.told.filter((t) => t !== f.fingerprint),
            nudges: cur.nudges.filter((n) => !(n.fingerprint === record.fingerprint && n.at === record.at)),
            nudgesSinceAsk: live.nudgesSinceAsk,
            ...(live.lastAskedAt !== undefined ? { lastAskedAt: live.lastAskedAt } : {}),
          };
        },
        now.toISOString(),
      ).then(
        () => true,
        (err: unknown) => {
          console.warn(`[open-everywhere:personal-watch] could not release a refused finding for ${principalKey}: ${String(err)}`);
          return false;
        },
      );
      await silence(f.fingerprint, "delivery-refused", { ...base, refusal: result.reason.slice(0, 300), ...(released ? {} : { release: "failed" }) }, !released);
      continue;
    }
    nudged = true;
    const p = parsePrincipalKey(principalKey);
    await appendAudit({
      org,
      platform: p?.platform ?? "unknown",
      workspace: p?.tenant ?? "",
      surface: result.surfaceKey.split("/").slice(2).join("/") || "home",
      principalId: principalKey,
      action: "personal_watch.nudge",
      detail: { kind: f.kind, urgency: f.urgency, dial: live.dial, dampening: live.dampening, calibrationAsk, fingerprint: f.fingerprint },
    }).catch(() => undefined);
  }
  let proposed = false;
  if (!nudged && deps.propose) {
    const outcome = await discoverForPerson(org, principalKey, state, { propose: deps.propose, dmStopped: deps.dmStopped ?? liveDmStopped, ...(deps.readCalls ? { readCalls: deps.readCalls } : {}) }, now, (mutate) =>
      updatePersonalWatch(org, principalKey, mutate, now.toISOString()),
    );
    proposed = outcome.proposed;
    if (outcome.held) await silence(outcome.held.work.fingerprint, outcome.held.reason, { kind: "repeated-work", urgency: "soon", summary: repeatedWorkSummary(outcome.held.work) });
  }
  return { nudged, silences, cleared: [...cleared, ...lost], silencedRows, proposed };
}

export function applyCheck(current: PersonalWatchState, result: Pick<CheckResult, "silences" | "cleared">, now: Date): PersonalWatchState {
  const silenced = { ...current.silenced };
  for (const k of result.cleared) delete silenced[k];
  for (const [k, v] of Object.entries(result.silences)) {
    delete silenced[k];
    silenced[k] = v;
  }
  return { ...current, lastCheckAt: now.toISOString(), silenced };
}

export function checkDue(state: PersonalWatchState, now: Date): boolean {
  if (WATCH_DIAL_POLICY[state.dial].checkEveryMinutes === undefined) return false;
  if (state.nextCheckAt === undefined) return true;
  const at = Date.parse(state.nextCheckAt);
  return !Number.isFinite(at) || at <= now.getTime();
}

export async function personalWatchTick(deps: PersonalWatchTickDeps): Promise<PersonalWatchTickReport> {
  const report = { checked: 0, nudged: 0, proposed: 0, silenced: 0, deferred: 0 };
  if (!personalWatchArmed() && !(discoveryOn() && deps.propose)) return report;
  const org = deps.org ?? deploymentOrg();
  const now = deps.now ?? new Date();
  const started = Date.now();
  const budget = deps.budgetMs ?? PERSONAL_WATCH_TICK_BUDGET_MS;
  let rows;
  try {
    rows = await getOperationalStore().listPersonalWatches(org);
  } catch (err) {
    console.warn(`[open-everywhere:personal-watch] could not list the watched people: ${String(err)}`);
    return report;
  }
  for (const row of rows) {
    let listed: PersonalWatchState;
    try {
      listed = parseWatchState(row.stateJson);
    } catch {
      console.warn(`[open-everywhere:personal-watch] the row for ${row.principalKey} does not parse — the watch stays silent for this person`);
      continue;
    }
    if (!checkDue(listed, now)) continue;
    if (Date.now() - started > budget) {
      report.deferred++;
      continue;
    }
    try {
      const claimed = await updatePersonalWatch(
        org,
        row.principalKey,
        (cur, existed) => {
          if (!existed || !checkDue(cur, now)) return undefined;
          const { nextCheckAt: _drop, ...rest } = cur;
          const next = nextCheckAfter(cur, now);
          return { ...rest, ...(next ? { nextCheckAt: next } : {}) };
        },
        now.toISOString(),
      );
      if (!claimed) continue;
      const result = await checkPerson(org, row.principalKey, claimed, deps, now);
      report.checked++;
      report.silenced += result.silencedRows;
      if (result.nudged) report.nudged++;
      if (result.proposed) report.proposed++;
      await updatePersonalWatch(org, row.principalKey, (current) => applyCheck(current, result, now), now.toISOString());
    } catch (err) {
      console.warn(`[open-everywhere:personal-watch] the check for ${row.principalKey} failed: ${String(err)}`);
    }
  }
  return report;
}

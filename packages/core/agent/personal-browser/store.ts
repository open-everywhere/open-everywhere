import { getOperationalStore } from "../operational/provider.js";
import type { Partition } from "../memory/partition.js";

export interface BrowserBox {
  readonly name: string;
  readonly backend: string;
  readonly metered: boolean;
  readonly url: string;
  readonly key: string;
  readonly createdAt: number;
  readonly maxMinutes: number;
  readonly memoryMb: number;
  readonly egressEnforced: boolean;
}

export type LockHolder = "agent" | "person";

export type TaughtStep =
  | { readonly kind: "go"; readonly url: string }
  | { readonly kind: "arrive"; readonly url: string }
  | { readonly kind: "click"; readonly role: string; readonly name: string }
  | { readonly kind: "type"; readonly role: string; readonly name: string; readonly secret?: true }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "back" };

export interface TeachingSession {
  readonly name: string;
  readonly goal: string;
  readonly box: string;
  readonly startedAt: number;
  readonly until: number;
}

export interface TaughtDraft {
  readonly name: string;
  readonly goal: string;
  readonly createdAt: number;
  readonly steps: readonly TaughtStep[];
  readonly capped: boolean;
  readonly seconds: number;
  readonly rehearsal?: { readonly at: number; readonly found: number; readonly missing: number; readonly unchecked: number };
  readonly proposal?: { readonly at: number; readonly url?: string; readonly number?: number; readonly dryRun?: boolean };
}

export interface PersonalBrowserState {
  readonly v: 1;
  readonly org: string;
  readonly person: string;
  readonly principalId: string;
  readonly platform: string;
  readonly dm: { readonly channelId: string };
  readonly partition: Partition;
  readonly persistKey: string;
  readonly box?: BrowserBox;
  readonly opening?: number;
  readonly lastUsedAt?: number;
  readonly lock: { readonly holder: LockHolder; readonly since: number; readonly until?: number };
  readonly acts: Readonly<Record<string, number>>;
  readonly links: Readonly<Record<string, number>>;
  readonly sessions: Readonly<Record<string, number>>;
  readonly teach?: TeachingSession;
  readonly drafts?: readonly TaughtDraft[];
}

export interface StoredBrowserState {
  readonly state: PersonalBrowserState;
  readonly version: number;
}

function parse(json: string, org: string, person: string): PersonalBrowserState | undefined {
  try {
    const s = JSON.parse(json) as PersonalBrowserState;
    return s.v === 1 && s.org === org && s.person === person ? s : undefined;
  } catch {
    return undefined;
  }
}

export async function getPersonalBrowserState(org: string, person: string): Promise<StoredBrowserState | undefined> {
  const row = await getOperationalStore().getPersonalBrowser(org, person);
  if (row === null) return undefined;
  const state = parse(row.stateJson, org, person);
  return state === undefined ? undefined : { state, version: row.version };
}

export async function listPersonalBrowserStates(org: string): Promise<StoredBrowserState[]> {
  const out: StoredBrowserState[] = [];
  for (const row of await getOperationalStore().listPersonalBrowsers(org)) {
    const state = parse(row.stateJson, org, row.principalKey);
    if (state !== undefined) out.push({ state, version: row.version });
  }
  return out;
}

export function pruneExpired(s: PersonalBrowserState, now: number): PersonalBrowserState {
  const keep = (m: Readonly<Record<string, number>>): Record<string, number> => Object.fromEntries(Object.entries(m).filter(([, exp]) => exp > now));
  return { ...s, acts: keep(s.acts), links: keep(s.links), sessions: keep(s.sessions) };
}

export async function updatePersonalBrowser<T>(
  org: string,
  person: string,
  change: (current: PersonalBrowserState | undefined) => { readonly next: PersonalBrowserState | undefined; readonly result: T },
  now: number = Date.now(),
): Promise<T> {
  const store = getOperationalStore();
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await getPersonalBrowserState(org, person);
    const { next, result } = change(current === undefined ? undefined : pruneExpired(current.state, now));
    if (next === undefined) return result;
    const won = await store.casPersonalBrowser(org, person, JSON.stringify(next), new Date(now).toISOString(), current?.version ?? null);
    if (won !== null) return result;
  }
  throw new Error("your browser's record kept changing under me, so I stopped — try again");
}

export async function deletePersonalBrowserState(org: string, person: string): Promise<boolean> {
  return await getOperationalStore().deletePersonalBrowser(org, person);
}

import { createHash, randomBytes } from "node:crypto";
import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { appendUsageEvent } from "../spend/usage-events.js";
import { recordSpend } from "../spend/store.js";
import { periodOf } from "../spend/spend.js";
import { sandboxGiBHourUsd } from "../spend/sandbox-pricing.js";
import { domainKeyOf, type Partition } from "../memory/partition.js";
import { resolveHalt, haltScopeFor } from "../access/halt.js";
import { getSettings } from "../settings/settings.js";
import {
  boxIsLive,
  boxSeconds,
  clampBoxMinutes,
  registeredLongLivedBoxBackend,
  resolveLongLivedBoxBackend,
  type BoxSpec,
  type LongLivedBoxBackend,
} from "../sandbox/long-lived-box.js";
import { personalBrowserPolicy, type PersonalBrowserPolicy } from "./policy.js";
import { BOX_CAPABILITY_REFUSAL, boxRefusesPaymentSubmit, browserNeverHostMatch, browserNeverRefusalMessage } from "./never-tier.js";
import { BoxCallError, callBox, mintBoxKey } from "./box-client.js";
import { finishTeaching } from "./teach.js";
import {
  deletePersonalBrowserState,
  getPersonalBrowserState,
  listPersonalBrowserStates,
  updatePersonalBrowser,
  type BrowserBox,
  type PersonalBrowserState,
} from "./store.js";
import type { SandboxNetworkPolicy } from "eve/sandbox";

export const BROWSER_BOX_PORT = 8080;
export const DOCKER_PROFILE_MOUNT = "/profile";
const DAY_MS = 24 * 60 * 60_000;
const OPENING_STALE_MS = 5 * 60_000;
const HEALTH_WAIT_MS = 90_000;

export interface BrowserOwner {
  readonly org: string;
  readonly person: string;
  readonly principalId: string;
  readonly platform: string;
  readonly dmChannelId: string;
  readonly partition: Partition;
}

export function persistKeyFor(org: string, person: string): string {
  return `oe-pb-${createHash("sha256").update(`${org}\n${person}`).digest("hex").slice(0, 24)}`;
}

export function browserHosts(policy: SandboxNetworkPolicy): readonly string[] | "all" {
  if (policy === "allow-all") return "all";
  if (policy === "deny-all") return [];
  const allow = (policy as { allow?: unknown }).allow;
  const hosts = Array.isArray(allow) ? allow.filter((h): h is string => typeof h === "string") : allow !== null && typeof allow === "object" ? Object.keys(allow) : [];
  const normal = [...new Set(hosts.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0))].sort();
  return normal.includes("*") ? "all" : normal;
}

export function browserBoxSpec(
  owner: Pick<BrowserOwner, "org" | "person">,
  policy: PersonalBrowserPolicy,
  hosts: readonly string[] | "all",
  key: string,
  enforce: boolean,
): BoxSpec {
  const persistKey = persistKeyFor(owner.org, owner.person);
  return {
    purpose: "browser",
    ref: persistKey,
    image: policy.box.image,
    command: ["node", "/opt/oe-personal-browser/box.mjs"],
    vcpus: policy.box.vcpus,
    memoryMb: policy.box.memoryMb,
    shmMb: 1024,
    user: "pwuser",
    maxMinutes: policy.sessionMinutes,
    egress: hosts === "all" || !enforce ? "open" : { allow: [...hosts] },
    persist: { key: persistKey, keepDays: policy.keepLoginsDays, mount: DOCKER_PROFILE_MOUNT },
    port: BROWSER_BOX_PORT,
    ...(policy.box.dockerNetwork !== undefined ? { network: policy.box.dockerNetwork } : {}),
    env: {
      OE_PB_KEY: key,
      OE_PB_PORT: String(BROWSER_BOX_PORT),
      OE_PB_ALLOW: JSON.stringify(hosts === "all" ? ["*"] : hosts),
      OE_PB_IDLE_MINUTES: String(policy.idleMinutes),
      OE_PB_PROFILE_DIR: `${DOCKER_PROFILE_MOUNT}/chromium`,
    },
  };
}

function auditWhere(p: Partition): { org: string; platform: string; workspace: string; surface: string } {
  return { org: p.org, platform: p.platform, workspace: p.workspace, surface: p.surface };
}

function freshState(owner: BrowserOwner, now: number): PersonalBrowserState {
  return {
    v: 1,
    org: owner.org,
    person: owner.person,
    principalId: owner.principalId,
    platform: owner.platform,
    dm: { channelId: owner.dmChannelId },
    partition: owner.partition,
    persistKey: persistKeyFor(owner.org, owner.person),
    lock: { holder: "agent", since: now },
    acts: {},
    links: {},
    sessions: {},
  };
}

export async function browserHalted(s: Pick<PersonalBrowserState, "org" | "partition" | "principalId">): Promise<boolean> {
  try {
    return (await resolveHalt(haltScopeFor({ org: s.org, scopeKey: s.partition.surfaceKey, principalId: s.principalId }))).halted;
  } catch {
    return true;
  }
}

export function browserBoxUsd(seconds: number, memoryMb: number, metered: boolean): number {
  if (!metered) return 0;
  return (Math.max(0, seconds) / 3600) * (memoryMb / 1024) * sandboxGiBHourUsd();
}

async function billBox(s: PersonalBrowserState, box: BrowserBox, endedAt: number): Promise<{ readonly seconds: number; readonly usd: number }> {
  const seconds = Math.min(boxSeconds(box.createdAt, endedAt), box.maxMinutes * 60 + 300);
  const usd = browserBoxUsd(seconds, box.memoryMb, box.metered);
  const p = s.partition;
  try {
    await recordSpend(p, { period: periodOf(new Date(endedAt).toISOString()), usage: {}, principalId: s.principalId, model: "", usdMicros: Math.round(usd * 1_000_000) });
  } catch (err) {
    console.warn(`[open-everywhere:personal-browser] spend-ledger row failed for ${box.name}: ${String(err)}`);
  }
  try {
    await appendUsageEvent({
      org: p.org,
      surfaceKey: domainKeyOf(p),
      sessionId: `browser:${box.name}:${box.createdAt}`,
      kind: "browser",
      principalId: s.principalId,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      detail: { browserSeconds: seconds, browserHours: Math.round((seconds / 3600) * 1000) / 1000, box: box.name, backend: box.backend, metered: box.metered },
    });
  } catch (err) {
    console.warn(`[open-everywhere:personal-browser] usage event failed for ${box.name}: ${String(err)}`);
  }
  return { seconds, usd };
}

export interface LifecycleDeps {
  readonly backend?: LongLivedBoxBackend;
  readonly policy?: PersonalBrowserPolicy;
  readonly now?: () => number;
  readonly halted?: (s: PersonalBrowserState) => Promise<boolean>;
  readonly healthWaitMs?: number;
}

export async function closeBrowser(
  org: string,
  person: string,
  reason: "closed" | "idle" | "cap" | "halted" | "unreachable" | "forget" | "superseded",
  deps: LifecycleDeps = {},
  by?: string,
  expect?: (cur: PersonalBrowserState & { readonly box: BrowserBox }) => boolean,
): Promise<{ readonly closed: boolean; readonly seconds?: number }> {
  const now = (deps.now ?? Date.now)();
  if (reason === "closed" && (await getPersonalBrowserState(org, person))?.state.teach !== undefined) {
    await finishTeaching(org, person, deps.now !== undefined ? { now: deps.now } : {});
  }
  const taken = await updatePersonalBrowser<{ state: PersonalBrowserState; box: BrowserBox } | undefined>(
    org,
    person,
    (cur) => {
      if (cur?.box === undefined) return { next: undefined, result: undefined };
      if (expect !== undefined && !expect({ ...cur, box: cur.box })) return { next: undefined, result: undefined };
      const { box, teach: _teach, ...rest } = cur;
      return { next: { ...rest, lock: { holder: "agent", since: now } }, result: { state: cur, box } };
    },
    now,
  );
  if (taken === undefined) return { closed: false };
  const { state, box } = taken;
  if (reason !== "unreachable" && reason !== "cap") {
    try {
      await callBox(box, "POST", "/shutdown", {}, 15_000);
    } catch {
    }
  }
  const backend = deps.backend ?? registeredLongLivedBoxBackend();
  try {
    await backend?.stop(box.name);
  } catch (err) {
    console.warn(`[open-everywhere:personal-browser] box stop failed for ${box.name} (its cap still stops it): ${String(err)}`);
  }
  if (state.teach !== undefined) {
    await appendAudit({ ...auditWhere(state.partition), principalId: state.principalId, action: "browser.personal.teach", detail: { phase: "lost", box: box.name } });
  }
  const bill = await billBox(state, box, now);
  await appendAudit({
    ...auditWhere(state.partition),
    principalId: state.principalId,
    action: "browser.personal.closed",
    detail: { box: box.name, reason, seconds: bill.seconds, usdMicros: Math.round(bill.usd * 1_000_000), ...(by !== undefined ? { by } : {}) },
  });
  return { closed: true, seconds: bill.seconds };
}

async function pushLock(box: BrowserBox, lock: PersonalBrowserState["lock"]): Promise<void> {
  try {
    await callBox(box, "POST", "/lock", { holder: lock.holder, ...(lock.until !== undefined ? { until: lock.until } : {}) }, 10_000);
  } catch {
  }
}

async function boxHealthy(box: BrowserBox): Promise<boolean> {
  try {
    const res = await callBox(box, "GET", "/health", undefined, 10_000);
    return res.json?.["ok"] === true;
  } catch {
    return false;
  }
}

async function waitForHealth(box: BrowserBox, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await boxHealthy(box)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, Math.min(2_000, Math.max(50, waitMs / 20))));
  }
}

export interface OpenResult {
  readonly state: PersonalBrowserState & { readonly box: BrowserBox };
  readonly started: boolean;
}

export async function ensureBrowserOpen(owner: BrowserOwner, hosts: readonly string[] | "all", deps: LifecycleDeps = {}): Promise<OpenResult> {
  const policy = deps.policy ?? personalBrowserPolicy();
  if (!policy.enabled) throw new Error("the personal browser was turned off on this deployment");
  const now = deps.now ?? Date.now;
  const live = (await getPersonalBrowserState(owner.org, owner.person))?.state;
  if (live?.box !== undefined) {
    if (await boxHealthy(live.box)) {
      const touched = await updatePersonalBrowser(owner.org, owner.person, (cur) => (cur === undefined ? { next: undefined, result: undefined } : { next: { ...cur, lastUsedAt: now() }, result: cur }), now());
      if (touched?.box !== undefined) return { state: { ...touched, box: touched.box }, started: false };
    }
    await closeBrowser(owner.org, owner.person, "unreachable", deps, undefined, (cur) => cur.box.name === live.box!.name);
  }
  if (hosts !== "all" && hosts.length === 0) {
    throw new Error("the egress declaration for your DM admits no host, so your browser could reach nothing — an admin declares the sites in agent/access (bundles or network access)");
  }
  const backend = deps.backend ?? resolveLongLivedBoxBackend();
  const enforce = backend.enforcesHostAllowList === true;
  if (!enforce && !getSettings().egress.allowUnenforced) {
    throw new Error(
      `this deployment's sandbox backend (${backend.backend}) cannot enforce a host list on a box, and \`egress.allowUnenforced\` is off — so I won't open a browser that could reach every host. Run on Vercel Sandbox, or declare the unenforced dev posture in agent/settings/settings.ts`,
    );
  }
  const myClaim = now();
  const claimed = await updatePersonalBrowser<"ok" | "busy">(
    owner.org,
    owner.person,
    (cur) => {
      const base = cur ?? freshState(owner, now());
      if (base.box !== undefined || (base.opening !== undefined && now() - base.opening < OPENING_STALE_MS)) return { next: undefined, result: "busy" };
      return { next: { ...base, dm: { channelId: owner.dmChannelId }, partition: owner.partition, opening: myClaim }, result: "ok" };
    },
    now(),
  );
  if (claimed === "busy") {
    const deadline = now() + (deps.healthWaitMs ?? HEALTH_WAIT_MS) + 60_000;
    while (now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const cur = (await getPersonalBrowserState(owner.org, owner.person))?.state;
      if (cur?.box !== undefined) return { state: { ...cur, box: cur.box }, started: false };
      if (cur?.opening === undefined || now() - cur.opening >= OPENING_STALE_MS) break;
    }
    throw new Error("your browser is still starting (another job is opening it) — try again in a moment");
  }
  const key = mintBoxKey();
  const spec = browserBoxSpec(owner, policy, hosts, key, enforce);
  const release = async (): Promise<void> => {
    await updatePersonalBrowser(owner.org, owner.person, (cur) => {
      if (cur === undefined || cur.opening !== myClaim) return { next: undefined, result: undefined };
      const { opening: _drop, ...rest } = cur;
      return { next: rest, result: undefined };
    });
  };
  let opened;
  try {
    opened = await backend.open(spec);
  } catch (err) {
    await release();
    throw err;
  }
  if (opened.url === undefined) {
    await backend.stop(opened.name).catch(() => undefined);
    await release();
    throw new Error(`the ${backend.backend} box backend gave no address for the browser box, so I stopped it`);
  }
  const box: BrowserBox = {
    name: opened.name,
    backend: opened.backend,
    metered: backend.metered,
    url: opened.url,
    key,
    createdAt: opened.createdAt,
    maxMinutes: clampBoxMinutes(opened.maxMinutes, backend.maxMinutesCeiling),
    memoryMb: policy.box.memoryMb,
    egressEnforced: enforce && hosts !== "all",
  };
  const othersOwn = (cur: PersonalBrowserState | undefined): boolean =>
    cur?.box?.name === box.name || (box.name === spec.persist?.key && cur?.opening !== undefined && cur.opening !== myClaim);
  if (!(await waitForHealth(box, deps.healthWaitMs ?? HEALTH_WAIT_MS))) {
    const owned = othersOwn((await getPersonalBrowserState(owner.org, owner.person))?.state);
    if (!owned) await backend.stop(box.name).catch(() => undefined);
    await release();
    throw new Error(
      owned
        ? "another job is opening your browser at the same time and now owns its box, so I left that box running — try again in a moment"
        : "your browser box started but its browser never answered, so I stopped it — try again, and tell an admin if it keeps happening",
    );
  }
  const recorded = await updatePersonalBrowser<{ readonly state: PersonalBrowserState; readonly mine: boolean }>(owner.org, owner.person, (cur) => {
    if (cur === undefined || cur.opening !== myClaim || cur.box !== undefined) return { next: undefined, result: { state: cur ?? freshState(owner, now()), mine: false } };
    const { opening: _drop, ...rest } = cur;
    const next: PersonalBrowserState = { ...rest, box, lastUsedAt: now() };
    return { next, result: { state: next, mine: true } };
  });
  if (!recorded.mine) {
    const owned = othersOwn(recorded.state);
    if (!owned) {
      await callBox(box, "POST", "/shutdown", {}, 15_000).catch(() => undefined);
      await backend.stop(box.name).catch(() => undefined);
    }
    if (recorded.state.box !== undefined) return { state: { ...recorded.state, box: recorded.state.box }, started: false };
    throw new Error(
      owned
        ? "another job took over opening your browser while this one was slow, and its box shares mine, so I left it running — try again in a moment"
        : "another job took over opening your browser while this one was slow, so I stopped mine — try again",
    );
  }
  const state = recorded.state;
  if (personHolds(state, now())) await pushLock(box, state.lock);
  await appendAudit({
    ...auditWhere(owner.partition),
    principalId: owner.principalId,
    action: "browser.personal.open",
    detail: {
      box: box.name,
      backend: box.backend,
      egressEnforced: box.egressEnforced,
      hosts: hosts === "all" ? "all" : hosts.length,
      maxMinutes: box.maxMinutes,
    },
  });
  return { state: { ...state, box }, started: true };
}

export const BROWSER_READ_OPS = ["go", "look", "scroll", "back", "sites", "find"] as const;
export const BROWSER_WRITE_OPS = ["click", "type", "select", "key"] as const;
export type BrowserReadOp = (typeof BROWSER_READ_OPS)[number];
export type BrowserWriteOp = (typeof BROWSER_WRITE_OPS)[number];
export type BrowserOp = BrowserReadOp | BrowserWriteOp;

export function isWriteOp(op: string): op is BrowserWriteOp {
  return (BROWSER_WRITE_OPS as readonly string[]).includes(op);
}

export function personHolds(s: Pick<PersonalBrowserState, "lock">, now: number): boolean {
  return s.lock.holder === "person" && (s.lock.until === undefined || s.lock.until > now);
}

export function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export type ActOutcome =
  | { readonly kind: "done"; readonly page: Record<string, unknown> }
  | { readonly kind: "needs-approval"; readonly host: string }
  | { readonly kind: "refused"; readonly message: string; readonly neverTier?: true };

export interface JudgedStep {
  readonly host: string;
  readonly pendingId: string;
}

export async function actOnBrowser(
  state: PersonalBrowserState & { readonly box: BrowserBox },
  op: BrowserOp,
  args: Record<string, unknown>,
  deps: LifecycleDeps = {},
  judged?: JudgedStep,
): Promise<ActOutcome> {
  const now = (deps.now ?? Date.now)();
  if (personHolds(state, now)) {
    return { kind: "refused", message: "you have the controls of your browser right now, so I'm not touching it. Hand them back (the card in our DM, or Hand back on the page) and I'll carry on" };
  }
  let host: string | undefined;
  let health: Awaited<ReturnType<typeof callBox>> | undefined;
  if (op === "go") {
    host = hostOf(typeof args["url"] === "string" ? args["url"] : undefined);
    if (host === undefined) return { kind: "refused", message: "give a full http(s) address to go to" };
  } else {
    try {
      health = await callBox(state.box, "GET", "/health", undefined, 10_000);
    } catch (err) {
      if (err instanceof BoxCallError && err.unreachable) await closeBrowser(state.org, state.person, "unreachable", deps, undefined, (cur) => cur.box.name === state.box.name);
      return { kind: "refused", message: "your browser stopped answering, so I closed it — ask me again and I'll open it fresh (your logins stay)" };
    }
    host = hostOf(typeof health.json?.["url"] === "string" ? (health.json["url"] as string) : undefined);
  }
  if (isWriteOp(op)) {
    if (host === undefined) return { kind: "refused", message: "the page has no web address yet, so there is nothing to act on — go to a site first" };
    const never = browserNeverHostMatch(host, deps.policy ?? personalBrowserPolicy());
    if (never !== undefined) {
      await appendAudit({
        ...auditWhere(state.partition),
        principalId: state.principalId,
        action: "browser.personal.action",
        detail: { op, host, box: state.box.name, ok: false, refused: "never_tier", rule: never.rule, source: never.source },
      });
      return { kind: "refused", message: browserNeverRefusalMessage(host, never), neverTier: true };
    }
    const windowLive = (state.acts[host] ?? 0) > now;
    if (!windowLive && judged?.host !== host) return { kind: "needs-approval", host };
    if (!windowLive && !boxRefusesPaymentSubmit(health?.json)) {
      await appendAudit({
        ...auditWhere(state.partition),
        principalId: state.principalId,
        action: "browser.personal.action",
        detail: { op, host, box: state.box.name, ok: false, refused: "box_capability", ...(judged !== undefined ? { pendingId: judged.pendingId } : {}) },
      });
      return { kind: "refused", message: BOX_CAPABILITY_REFUSAL };
    }
  }
  const fresh = (await getPersonalBrowserState(state.org, state.person))?.state;
  if (fresh === undefined || fresh.box?.name !== state.box.name) return { kind: "refused", message: "your browser changed while I was working (it closed or restarted), so I did not act — ask me again" };
  if (personHolds(fresh, (deps.now ?? Date.now)())) {
    return { kind: "refused", message: "you have the controls of your browser right now, so I'm not touching it. Hand them back (the card in our DM, or Hand back on the page) and I'll carry on" };
  }
  let res;
  try {
    res = await callBox(state.box, "POST", "/cmd", { op, ...args, ...(isWriteOp(op) && host !== undefined ? { expectHost: host } : {}) });
  } catch (err) {
    if (err instanceof BoxCallError && err.unreachable) await closeBrowser(state.org, state.person, "unreachable", deps, undefined, (cur) => cur.box.name === state.box.name);
    return { kind: "refused", message: "your browser stopped answering, so I closed it — ask me again and I'll open it fresh (your logins stay)" };
  }
  await updatePersonalBrowser(state.org, state.person, (cur) => (cur === undefined ? { next: undefined, result: undefined } : { next: { ...cur, lastUsedAt: now }, result: undefined }), now);
  await appendAudit({
    ...auditWhere(state.partition),
    principalId: state.principalId,
    action: "browser.personal.action",
    detail: {
      op,
      host: host ?? "",
      box: state.box.name,
      ok: res.json?.["ok"] === true,
      ...(typeof res.json?.["code"] === "string" ? { code: res.json["code"] } : {}),
      ...(isWriteOp(op) && judged !== undefined && !((state.acts[host ?? ""] ?? 0) > now) ? { decidedBy: "chain:judge", pendingId: judged.pendingId } : {}),
    },
  });
  return { kind: "done", page: res.json ?? {} };
}

export async function takeOver(org: string, person: string, by: "agent" | "page", deps: LifecycleDeps = {}, reason?: string): Promise<{ readonly until: number } | undefined> {
  const policy = deps.policy ?? personalBrowserPolicy();
  const now = (deps.now ?? Date.now)();
  const until = now + policy.takeoverMinutes * 60_000;
  const s = await updatePersonalBrowser(org, person, (cur) => {
    if (cur?.box === undefined) return { next: undefined, result: undefined };
    const next: PersonalBrowserState = { ...cur, lock: { holder: "person", since: now, until }, lastUsedAt: now };
    return { next, result: next };
  }, now);
  if (s === undefined) return undefined;
  if (s.box !== undefined) await pushLock(s.box, s.lock);
  await appendAudit({
    ...auditWhere(s.partition),
    principalId: s.principalId,
    action: "browser.personal.takeover",
    detail: { by, until: new Date(until).toISOString(), box: s.box?.name ?? "", ...(reason !== undefined ? { reason: reason.slice(0, 120) } : {}) },
  });
  return { until };
}

export async function handBack(org: string, person: string, by: "card" | "page" | "expired", deps: LifecycleDeps = {}): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  const s = await updatePersonalBrowser(org, person, (cur) => {
    if (cur === undefined || cur.lock.holder === "agent") return { next: undefined, result: undefined };
    const next: PersonalBrowserState = { ...cur, lock: { holder: "agent", since: now }, lastUsedAt: now };
    return { next, result: next };
  }, now);
  if (s === undefined) return false;
  if (s.box !== undefined) await pushLock(s.box, s.lock);
  await appendAudit({ ...auditWhere(s.partition), principalId: s.principalId, action: "browser.personal.handback", detail: { by, box: s.box?.name ?? "" } });
  if (s.teach !== undefined) await finishTeaching(org, person, deps.now !== undefined ? { now: deps.now } : {});
  return true;
}

export async function grantAct(org: string, person: string, host: string, minutes: number, decidedBy: string, deps: LifecycleDeps = {}): Promise<number> {
  const never = browserNeverHostMatch(host, deps.policy ?? personalBrowserPolicy());
  if (never !== undefined) throw new Error(browserNeverRefusalMessage(host, never));
  const now = (deps.now ?? Date.now)();
  const until = now + minutes * 60_000;
  const s = await updatePersonalBrowser(org, person, (cur) => {
    if (cur === undefined) return { next: undefined, result: undefined };
    const next: PersonalBrowserState = { ...cur, acts: { ...cur.acts, [host]: until } };
    return { next, result: next };
  }, now);
  if (s === undefined) throw new Error("this browser no longer exists (it was forgotten), so there is nothing to approve");
  await appendAudit({ ...auditWhere(s.partition), principalId: decidedBy, action: "browser.personal.act_granted", detail: { host, minutes, until: new Date(until).toISOString() } });
  return until;
}

export async function forgetBrowser(org: string, person: string, deps: LifecycleDeps = {}, by?: string): Promise<{ readonly existed: boolean }> {
  const found = await getPersonalBrowserState(org, person);
  const backend = deps.backend ?? registeredLongLivedBoxBackend();
  if (backend === undefined && (found !== undefined || (await getOperationalStore().getPersonalBrowser(org, person)) != null)) {
    throw new Error("no box backend is registered in this process, so the saved browser profile cannot be deleted — the record stays; run this where the box backend is reachable");
  }
  await closeBrowser(org, person, "forget", deps, by);
  const persistKey = found?.state.persistKey ?? persistKeyFor(org, person);
  try {
    await backend?.forget?.(persistKey);
  } catch (err) {
    throw new Error(`I couldn't delete your browser's saved profile on the ${backend?.backend ?? "sandbox"} backend (${String(err).slice(0, 200)}) — your logins may still be there; try again`);
  }
  const existed = await deletePersonalBrowserState(org, person);
  if (found !== undefined) {
    await appendAudit({ ...auditWhere(found.state.partition), principalId: found.state.principalId, action: "browser.personal.forget", detail: { persistKey, ...(by !== undefined ? { by } : {}) } });
  }
  return { existed: existed || found !== undefined };
}

export function mintViewId(): string {
  return randomBytes(16).toString("hex");
}

const SWEEP_GRACE_MINUTES = 10;

export async function sweepPersonalBrowsers(org: string, deps: LifecycleDeps = {}): Promise<{ readonly closed: string[]; readonly returned: string[]; readonly stopped: string[] }> {
  const policy = deps.policy ?? personalBrowserPolicy();
  const now = (deps.now ?? Date.now)();
  const backend = deps.backend ?? registeredLongLivedBoxBackend();
  const closed: string[] = [];
  const returned: string[] = [];
  const stopped: string[] = [];
  const known = new Set<string>();
  const knownKeys = new Set<string>();
  const rows = await listPersonalBrowserStates(org);
  for (const { state } of rows) {
    if (state.opening !== undefined && now - state.opening < OPENING_STALE_MS) knownKeys.add(state.persistKey);
    const box = state.box;
    if (box === undefined) continue;
    known.add(box.name);
    knownKeys.add(state.persistKey);
    const withDeps: LifecycleDeps = { ...deps, ...(backend !== undefined ? { backend } : {}), now: () => now };
    if (await (deps.halted ?? browserHalted)(state)) {
      const r = await closeBrowser(org, state.person, "halted", withDeps, undefined, (cur) => cur.box.name === box.name);
      if (r.closed) closed.push(box.name);
      continue;
    }
    if (now - box.createdAt > (box.maxMinutes + SWEEP_GRACE_MINUTES) * 60_000) {
      const r = await closeBrowser(org, state.person, "cap", withDeps, undefined, (cur) => cur.box.name === box.name);
      if (r.closed) closed.push(box.name);
      continue;
    }
    if (state.lock.holder === "person" && state.lock.until !== undefined && state.lock.until <= now) {
      if (await handBack(org, state.person, "expired", withDeps)) returned.push(box.name);
    }
    const idleFor = now - (state.lastUsedAt ?? box.createdAt);
    if (!personHolds(state, now) && idleFor > policy.idleMinutes * 60_000) {
      const r = await closeBrowser(org, state.person, "idle", withDeps, undefined, (cur) => cur.box.name === box.name && !personHolds(cur, now) && now - (cur.lastUsedAt ?? cur.box.createdAt) > policy.idleMinutes * 60_000);
      if (r.closed) closed.push(box.name);
    }
  }
  if (backend !== undefined && backend.unavailable === undefined && (policy.enabled || known.size > 0)) {
    try {
      for (const b of await backend.list("browser")) {
        if (!boxIsLive(b.status) || known.has(b.name) || knownKeys.has(b.name) || (b.ref !== undefined && knownKeys.has(b.ref))) continue;
        await backend.stop(b.name);
        stopped.push(b.name);
      }
    } catch (err) {
      console.warn(`[open-everywhere:personal-browser] the orphan-box listing failed (each box still stops at its cap): ${String(err)}`);
    }
  }
  return { closed, returned, stopped };
}

export function keepLoginsMs(policy: PersonalBrowserPolicy): number {
  return policy.keepLoginsDays * DAY_MS;
}

import { createHash } from "node:crypto";
import { connectorToolPermissionKind } from "../approvals/session-grant.js";
import { linkSafeLine } from "../approvals/plain-text.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { collectRoutineInputs, resolveRoutineCollector, type CollectedInput } from "../routines/collector.js";
import { WATCH_URGENCIES, type WatchUrgency } from "./dial.js";
import { updatePersonalWatch, type PersonalTriageRecord, type PersonalTriageShown } from "./state.js";

export type PersonalTriageReaderName = "slack-messages" | "github-review-requests" | "github-assigned" | "linear-issues" | "notion-comments";

export const PERSONAL_TRIAGE_READERS: readonly PersonalTriageReaderName[] = ["slack-messages", "github-review-requests", "github-assigned", "linear-issues", "notion-comments"];

export interface PersonalTriageSourceDecl {
  readonly collector: string;
  readonly read: PersonalTriageReaderName;
}

export interface PersonalTriageDecl {
  readonly sources: readonly PersonalTriageSourceDecl[];
}

export const PERSONAL_TRIAGE_MAX_SOURCES = 6;

export const TRIAGE_ITEMS_MAX = 7;

export const TRIAGE_BODY_MAX_CHARS = 256_000;

let DECL: PersonalTriageDecl = { sources: [] };

export function registerPersonalTriage(decl: PersonalTriageDecl): void {
  if (decl.sources.length > PERSONAL_TRIAGE_MAX_SOURCES) {
    throw new Error(`personal triage: ${decl.sources.length} sources declared, and a pass reads at most ${PERSONAL_TRIAGE_MAX_SOURCES}`);
  }
  const seen = new Set<string>();
  for (const s of decl.sources) {
    if (!(PERSONAL_TRIAGE_READERS as readonly string[]).includes(s.read)) {
      throw new Error(`personal triage: unknown reader "${s.read}" (core ships: ${PERSONAL_TRIAGE_READERS.join(", ")})`);
    }
    const def = resolveRoutineCollector(s.collector);
    if (def === undefined) {
      throw new Error(`personal triage: source "${s.collector}" names no collector in agent/routines/collectors.ts — declare the collector first`);
    }
    if (def.personal !== true) {
      throw new Error(
        `personal triage: source "${s.collector}" is a shared read — declare it \`personal: true\` in agent/routines/collectors.ts, and register a reader that reads as one person (registerRoutineCollectorReader(reader, { personal: true }))`,
      );
    }
    if (seen.has(s.collector)) throw new Error(`personal triage: source "${s.collector}" is declared twice`);
    seen.add(s.collector);
  }
  DECL = { sources: [...decl.sources] };
}

export function personalTriageDecl(): PersonalTriageDecl {
  return DECL;
}

export function personalTriageArmed(): boolean {
  return DECL.sources.length > 0;
}

export type TriageReason = "marked-urgent" | "overdue" | "due-soon" | "review-requested" | "direct-message" | "assigned" | "mentioned" | "comment";

const REASON_ORDER: readonly TriageReason[] = ["marked-urgent", "overdue", "due-soon", "review-requested", "direct-message", "assigned", "mentioned", "comment"];

export type TriageApp = "Slack" | "GitHub" | "Linear" | "Notion";

export const READER_APP: Readonly<Record<PersonalTriageReaderName, TriageApp>> = {
  "slack-messages": "Slack",
  "github-review-requests": "GitHub",
  "github-assigned": "GitHub",
  "linear-issues": "Linear",
  "notion-comments": "Notion",
};

export interface TriageItem {
  readonly source: string;
  readonly app: TriageApp;
  readonly what: string;
  readonly reason: TriageReason;
  readonly urgency: WatchUrgency;
  readonly why: string;
  readonly link?: string;
  readonly fingerprint: string;
  readonly version: string;
  readonly sinceMs: number;
  readonly dueMs?: number;
  readonly title: string;
}

export type TriageRead = { readonly ok: true; readonly items: readonly TriageItem[] } | { readonly ok: false };

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function timeMs(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

function hash(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

const LINK_HOSTS: Readonly<Record<TriageApp, RegExp>> = {
  Slack: /^(?:[a-z0-9-]+\.)*slack\.com$/u,
  GitHub: /^github\.com$/u,
  Linear: /^linear\.app$/u,
  Notion: /^(?:www\.)?notion\.so$|^(?:[a-z0-9-]+\.)?notion\.site$/u,
};

export function safeTriageLink(app: TriageApp, raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || !LINK_HOSTS[app].test(u.hostname)) return undefined;
  switch (app) {
    case "GitHub": {
      const m = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/(pull|issues)\/(\d{1,10})(?:\/|$)/u.exec(u.pathname);
      return m ? `https://github.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}` : undefined;
    }
    case "Linear": {
      const m = /^\/([A-Za-z0-9-]{1,64})\/issue\/([A-Za-z0-9]{1,10}-\d{1,9})(?:\/|$)/u.exec(u.pathname);
      return m ? `https://linear.app/${m[1]}/issue/${m[2]}` : undefined;
    }
    case "Slack": {
      const m = /^\/archives\/([A-Z0-9]{2,20})\/(p\d{10,20})$/u.exec(u.pathname);
      if (!m) return undefined;
      const thread = u.searchParams.get("thread_ts");
      const cid = u.searchParams.get("cid");
      const q = [thread && /^\d{1,12}\.\d{1,9}$/u.test(thread) ? `thread_ts=${thread}` : "", cid && /^[A-Z0-9]{2,20}$/u.test(cid) ? `cid=${cid}` : ""].filter((x) => x.length > 0).join("&");
      return `https://${u.hostname}/archives/${m[1]}/${m[2]}${q ? `?${q}` : ""}`;
    }
    case "Notion": {
      const m = /^\/([0-9a-f]{32})$/u.exec(u.pathname);
      return m && u.hostname === "www.notion.so" ? `https://www.notion.so/${m[1]}` : undefined;
    }
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function waited(ms: number): string {
  if (ms < DAY_MS) {
    const h = Math.max(1, Math.floor(ms / HOUR_MS));
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.floor(ms / DAY_MS);
  return `${d} day${d === 1 ? "" : "s"}`;
}

function makeItem(input: Omit<TriageItem, "fingerprint" | "version" | "title"> & { readonly vendorId: string; readonly updated: string; readonly title: string | undefined }): TriageItem {
  const { vendorId, updated, title, ...rest } = input;
  return {
    ...rest,
    fingerprint: hash(input.app, vendorId),
    version: hash(input.urgency, input.reason, updated),
    title: linkSafeLine(title ?? "", 200) || "(untitled)",
  };
}

const URGENT_LABEL = /^(?:p0|p-0|priority[: /-]?(?:0|critical|urgent)|sev[- ]?[01]|urgent|blocker|critical|security|incident)$/iu;

function readSlack(source: string, body: unknown, now: number, selfIds: readonly string[]): TriageRead {
  const o = asObject(body);
  const matches = asObject(o?.["messages"])?.["matches"] ?? o?.["matches"];
  if (!Array.isArray(matches)) return { ok: false };
  const items: TriageItem[] = [];
  for (const raw of matches) {
    const m = asObject(raw);
    const ts = str(m?.["ts"]);
    if (!m || !ts) continue;
    const user = str(m["user"]);
    if (user !== undefined && selfIds.includes(user)) continue;
    const sinceMs = Number.parseFloat(ts) * 1000;
    if (!Number.isFinite(sinceMs)) continue;
    const channel = asObject(m["channel"]);
    const dm = channel?.["is_im"] === true;
    const channelId = str(channel?.["id"]) ?? "";
    items.push(
      makeItem({
        source,
        app: "Slack",
        what: dm ? "a Slack direct message" : "a Slack message that mentions you",
        reason: dm ? "direct-message" : "mentioned",
        urgency: dm ? "soon" : "later",
        why: dm ? `sent to you ${waited(now - sinceMs)} ago` : `you were mentioned ${waited(now - sinceMs)} ago`,
        ...(safeTriageLink("Slack", m["permalink"]) ? { link: safeTriageLink("Slack", m["permalink"])! } : {}),
        sinceMs,
        vendorId: `${channelId}:${ts}`,
        updated: ts,
        title: str(m["text"]),
      }),
    );
  }
  return { ok: true, items };
}

function readGithub(source: string, body: unknown, now: number, review: boolean): TriageRead {
  const o = asObject(body);
  const list = Array.isArray(body) ? body : o?.["items"];
  if (!Array.isArray(list)) return { ok: false };
  const items: TriageItem[] = [];
  for (const raw of list) {
    const g = asObject(raw);
    if (!g) continue;
    if (g["state"] !== undefined && g["state"] !== "open") continue;
    const id = g["id"] !== undefined ? String(g["id"]) : str(g["html_url"]);
    if (id === undefined) continue;
    const pr = g["pull_request"] !== undefined && g["pull_request"] !== null;
    const labels = (Array.isArray(g["labels"]) ? g["labels"] : []).map((l) => (typeof l === "string" ? l : str(asObject(l)?.["name"]))).filter((l): l is string => l !== undefined);
    const marked = labels.some((l) => URGENT_LABEL.test(l.trim()));
    const updated = str(g["updated_at"]) ?? "";
    const sinceMs = (review ? timeMs(g["updated_at"]) : timeMs(g["created_at"])) ?? now;
    const what = pr ? "a GitHub pull request" : "a GitHub issue";
    const reason: TriageReason = marked ? "marked-urgent" : review ? "review-requested" : "assigned";
    const urgency: WatchUrgency = marked ? "urgent" : review ? "soon" : "later";
    const why = marked
      ? `it carries an urgent label, and ${review ? "your review is asked for" : "it is assigned to you"}`
      : review
        ? `your review is asked for, and it has waited at least ${waited(now - sinceMs)}`
        : `it is assigned to you, open for ${waited(now - sinceMs)}`;
    items.push(
      makeItem({ source, app: "GitHub", what, reason, urgency, why, ...(safeTriageLink("GitHub", g["html_url"]) ? { link: safeTriageLink("GitHub", g["html_url"])! } : {}), sinceMs, vendorId: id, updated, title: str(g["title"]) }),
    );
  }
  return { ok: true, items };
}

function dueEndMs(v: unknown): number | undefined {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(v)) return undefined;
  const ms = Date.parse(`${v}T23:59:59Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

function readLinear(source: string, body: unknown, now: number): TriageRead {
  const o = asObject(body);
  const data = asObject(o?.["data"]);
  const viewer = asObject(data?.["viewer"]);
  const conn = asObject(viewer?.["assignedIssues"]) ?? asObject(data?.["issues"]) ?? o;
  const nodes = Array.isArray(body) ? body : conn?.["nodes"];
  if (!Array.isArray(nodes)) return { ok: false };
  const items: TriageItem[] = [];
  for (const raw of nodes) {
    const n = asObject(raw);
    const id = str(n?.["id"]);
    if (!n || !id) continue;
    const stateType = str(asObject(n["state"])?.["type"]);
    if (stateType === "completed" || stateType === "canceled") continue;
    const priority = typeof n["priority"] === "number" ? n["priority"] : 0;
    const dueMs = dueEndMs(n["dueDate"]);
    const left = dueMs === undefined ? undefined : dueMs - now;
    let reason: TriageReason;
    let urgency: WatchUrgency;
    let why: string;
    if (left !== undefined && left < 0) {
      reason = "overdue";
      urgency = "urgent";
      why = `it was due ${waited(-left)} ago`;
    } else if (priority === 1) {
      reason = "marked-urgent";
      urgency = "urgent";
      why = left !== undefined ? `it is marked urgent, and due in ${waited(left)}` : "it is marked urgent";
    } else if (left !== undefined && left <= DAY_MS) {
      reason = "due-soon";
      urgency = "urgent";
      why = `it is due in ${waited(left)}`;
    } else if (left !== undefined && left <= 3 * DAY_MS) {
      reason = "due-soon";
      urgency = "soon";
      why = `it is due in ${waited(left)}`;
    } else {
      reason = "assigned";
      urgency = priority === 2 ? "soon" : "later";
      why = priority === 2 ? "it is assigned to you at high priority" : "it is assigned to you";
    }
    const updated = str(n["updatedAt"]) ?? "";
    items.push(
      makeItem({
        source,
        app: "Linear",
        what: "a Linear issue",
        reason,
        urgency,
        why,
        ...(safeTriageLink("Linear", n["url"]) ? { link: safeTriageLink("Linear", n["url"])! } : {}),
        sinceMs: timeMs(n["createdAt"]) ?? timeMs(n["updatedAt"]) ?? now,
        ...(dueMs !== undefined ? { dueMs } : {}),
        vendorId: id,
        updated,
        title: str(n["title"]),
      }),
    );
  }
  return { ok: true, items };
}

function readNotion(source: string, body: unknown, now: number): TriageRead {
  const o = asObject(body);
  const results = o?.["results"];
  if (!Array.isArray(results)) return { ok: false };
  const items: TriageItem[] = [];
  for (const raw of results) {
    const c = asObject(raw);
    const id = str(c?.["id"]);
    if (!c || !id) continue;
    const pageId = str(asObject(c["parent"])?.["page_id"]);
    const compact = pageId?.replace(/-/gu, "");
    const link = compact && /^[0-9a-f]{32}$/iu.test(compact) ? `https://www.notion.so/${compact.toLowerCase()}` : undefined;
    const sinceMs = timeMs(c["created_time"]) ?? now;
    const text = (Array.isArray(c["rich_text"]) ? c["rich_text"] : []).map((t) => str(asObject(t)?.["plain_text"]) ?? "").join("");
    items.push(
      makeItem({
        source,
        app: "Notion",
        what: "a Notion comment",
        reason: "comment",
        urgency: "later",
        why: `left ${waited(now - sinceMs)} ago on a Notion page`,
        ...(safeTriageLink("Notion", link) ? { link: safeTriageLink("Notion", link)! } : {}),
        sinceMs,
        vendorId: id,
        updated: str(c["last_edited_time"]) ?? str(c["created_time"]) ?? "",
        title: text,
      }),
    );
  }
  return { ok: true, items };
}

export function readTriageBody(source: PersonalTriageSourceDecl, body: string, now: Date, selfIds: readonly string[] = []): TriageRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false };
  }
  const t = now.getTime();
  switch (source.read) {
    case "slack-messages":
      return readSlack(source.collector, parsed, t, selfIds);
    case "github-review-requests":
      return readGithub(source.collector, parsed, t, true);
    case "github-assigned":
      return readGithub(source.collector, parsed, t, false);
    case "linear-issues":
      return readLinear(source.collector, parsed, t);
    case "notion-comments":
      return readNotion(source.collector, parsed, t);
  }
}

export function rankTriage(items: readonly TriageItem[]): TriageItem[] {
  const sorted = [...items].sort(
    (a, b) =>
      WATCH_URGENCIES.indexOf(b.urgency) - WATCH_URGENCIES.indexOf(a.urgency) ||
      REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason) ||
      (a.dueMs ?? Number.POSITIVE_INFINITY) - (b.dueMs ?? Number.POSITIVE_INFINITY) ||
      a.sinceMs - b.sinceMs ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
  const seen = new Set<string>();
  return sorted.filter((i) => {
    if (seen.has(i.fingerprint)) return false;
    seen.add(i.fingerprint);
    return true;
  });
}

export function triageLine(item: TriageItem): string {
  const what = item.what.charAt(0).toUpperCase() + item.what.slice(1);
  return `${what}: ${item.why} — ${item.link ?? "no link"}`;
}

function appsOf(sources: readonly PersonalTriageSourceDecl[]): TriageApp[] {
  return [...new Set(sources.map((s) => READER_APP[s.read]))];
}

function listWords(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function renderTriageMessage(pass: { readonly mode: TriageMode; readonly items: readonly TriageItem[]; readonly omitted: number; readonly newlyMissing: readonly PersonalTriageSourceDecl[] }): string {
  const lines: string[] = [];
  if (pass.items.length > 0) {
    lines.push(pass.mode === "changes" ? `New in your apps since I last looked:` : `From your connected apps, ${pass.items.length === 1 ? "this needs" : "these need"} you, most pressing first:`);
    pass.items.forEach((item, n) => lines.push(`${n + 1}. ${triageLine(item)}`));
    if (pass.omitted > 0) lines.push(`…and ${pass.omitted} more, less pressing.`);
  } else if (pass.mode === "full") {
    lines.push("Nothing in your connected apps needs you right now.");
  }
  const missing = appsOf(pass.newlyMissing);
  if (missing.length > 0) lines.push(`I could not check ${listWords(missing)}, so ${missing.length === 1 ? "it is" : "they are"} not in this list. Connect ${missing.length === 1 ? "it" : "them"} to me if you want ${missing.length === 1 ? "it" : "them"} included.`);
  return lines.join("\n");
}

export function renderTriageFacts(items: readonly TriageItem[]): string {
  return items.map((i, n) => `${n + 1}. ${i.app}: ${i.title}`).join("\n");
}

export type TriageMode = "full" | "changes";

export interface TriagePass {
  readonly mode: TriageMode;
  readonly items: readonly TriageItem[];
  readonly omitted: number;
  readonly newlyMissing: readonly PersonalTriageSourceDecl[];
  readonly unreadSources: readonly PersonalTriageSourceDecl[];
  readonly message: string;
  readonly facts: string;
  readonly quiet: boolean;
  readonly recorded: boolean;
}

export interface TriagePassDeps {
  readonly now?: Date;
  readonly passId?: string;
  readonly collect?: typeof collectRoutineInputs;
}

function selfIdsOf(principalKey: string): string[] {
  const p = parsePrincipalKey(principalKey);
  return p ? [p.id] : [];
}

export function foldTriageRecord(
  current: PersonalTriageRecord | undefined,
  pass: {
    readonly shownNow: readonly TriageItem[];
    readonly readClean: readonly string[];
    readonly unread: readonly string[];
    readonly live: ReadonlySet<string>;
    readonly passId?: string;
    readonly omitted?: number;
    readonly named?: readonly string[];
  },
  now: Date,
): PersonalTriageRecord {
  const unread = new Set(pass.unread);
  const kept = (current?.shown ?? []).filter((s) => unread.has(s.s) || pass.live.has(s.f));
  const byF = new Map<string, PersonalTriageShown>(kept.map((s) => [s.f, s]));
  for (const i of pass.shownNow) byF.set(i.fingerprint, { f: i.fingerprint, v: i.version, s: i.source });
  const missing = new Set(current?.missing ?? []);
  for (const c of pass.readClean) missing.delete(c);
  for (const c of pass.unread) missing.add(c);
  const lastPass = pass.passId !== undefined ? { id: pass.passId, items: pass.shownNow.map((i) => i.fingerprint), omitted: pass.omitted ?? 0, named: [...(pass.named ?? [])] } : current?.lastPass;
  return { lastPassAt: now.toISOString(), shown: [...byF.values()], missing: [...missing], ...(lastPass ? { lastPass } : {}) };
}

export async function personalTriagePass(org: string, principalKey: string, mode: TriageMode, deps: TriagePassDeps = {}): Promise<TriagePass> {
  const now = deps.now ?? new Date();
  const sources = DECL.sources;
  const empty: TriagePass = { mode, items: [], omitted: 0, newlyMissing: [], unreadSources: [], message: "", facts: "", quiet: true, recorded: true };
  if (sources.length === 0) return empty;
  let collected: readonly CollectedInput[];
  try {
    collected = await (deps.collect ?? collectRoutineInputs)({
      org,
      routineId: `personal-triage:${principalKey}`,
      names: sources.map((s) => s.collector),
      heldKinds: sources.map((s) => connectorToolPermissionKind(resolveRoutineCollector(s.collector)?.tool ?? "")),
      forPrincipal: principalKey,
      bodyMaxChars: TRIAGE_BODY_MAX_CHARS,
    });
  } catch {
    collected = [];
  }
  const selfIds = selfIdsOf(principalKey);
  const all: TriageItem[] = [];
  const readClean: string[] = [];
  const unread: string[] = [];
  for (const source of sources) {
    const c = collected.find((x) => x.name === source.collector);
    const read = c && c.ok && !c.truncated ? readTriageBody(source, c.body, now, selfIds) : ({ ok: false } as const);
    if (!read.ok) {
      unread.push(source.collector);
      continue;
    }
    readClean.push(source.collector);
    all.push(...read.items);
  }
  const ranked = rankTriage(all);
  const live = new Set(ranked.map((i) => i.fingerprint));

  let recorded = true;
  let result: { items: TriageItem[]; omitted: number; newlyMissing: PersonalTriageSourceDecl[] } = { items: [], omitted: 0, newlyMissing: [] };
  const choose = (record: PersonalTriageRecord | undefined) => {
    const replay = deps.passId !== undefined && record?.lastPass?.id === deps.passId ? record.lastPass : undefined;
    if (replay) {
      const chosen = new Set(replay.items);
      const named = new Set(replay.named);
      return { items: ranked.filter((i) => chosen.has(i.fingerprint)), omitted: replay.omitted, newlyMissing: sources.filter((s) => named.has(s.collector)) };
    }
    const shownBefore = new Map((record?.shown ?? []).map((s) => [s.f, s.v] as const));
    const candidates = mode === "changes" ? ranked.filter((i) => shownBefore.get(i.fingerprint) !== i.version) : ranked;
    const items = candidates.slice(0, TRIAGE_ITEMS_MAX);
    const named = new Set(record?.missing ?? []);
    const newlyMissing = sources.filter((s) => unread.includes(s.collector) && !named.has(s.collector));
    return { items, omitted: candidates.length - items.length, newlyMissing };
  };
  try {
    const written = await updatePersonalWatch(
      org,
      principalKey,
      (current, existed) => {
        result = choose(existed ? current.triage : undefined);
        if (!existed) return undefined;
        const named = result.newlyMissing.map((s) => s.collector);
        const fold = { shownNow: result.items, readClean, unread, live, omitted: result.omitted, named, ...(deps.passId !== undefined ? { passId: deps.passId } : {}) };
        return { ...current, triage: foldTriageRecord(current.triage, fold, now) };
      },
      now.toISOString(),
    );
    recorded = written !== undefined;
  } catch (err) {
    console.warn(`[open-everywhere:personal-triage] the triage record for ${principalKey} did not read or write: ${String(err)}`);
    result = mode === "full" ? choose(undefined) : { items: [], omitted: 0, newlyMissing: [] };
    recorded = false;
  }
  const message = renderTriageMessage({ mode, ...result });
  return {
    mode,
    items: result.items,
    omitted: result.omitted,
    newlyMissing: result.newlyMissing,
    unreadSources: sources.filter((s) => unread.includes(s.collector)),
    message,
    facts: renderTriageFacts(result.items),
    quiet: result.items.length === 0 && result.newlyMissing.length === 0,
    recorded,
  };
}

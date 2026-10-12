import { rawIdLeaks, renderFriendlyText, resolvableIds, type FriendlyName } from "./friendly-ids.js";
import { processRegistryMap } from "../lib/process-registry.js";
import { admitProviderRegistration } from "../access/provider-selection.js";

export type FriendlyNameResolver = (id: string) => Promise<FriendlyName | undefined>;

const RESOLVERS = processRegistryMap<FriendlyNameResolver>("friendly-name-resolvers.v1");

export function registerFriendlyNameResolver(platform: string, resolver: FriendlyNameResolver): void {
  if (!admitProviderRegistration(platform, "friendly-name-resolver")) return;
  RESOLVERS.set(platform, resolver);
  for (const key of [...NAME_CACHE.keys()]) if (key.startsWith(`${platform}:`)) NAME_CACHE.delete(key);
}

export const NAME_CACHE_TTL_MS = 30 * 60_000;
export const NAME_CACHE_MAX = 2000;

interface CachedName {
  readonly platform: string;
  readonly id: string;
  readonly name: FriendlyName;
  readonly at: number;
}

const NAME_CACHE = processRegistryMap<CachedName>("friendly-name-cache.v1");

function cacheGet(platform: string, id: string, now: number): FriendlyName | undefined {
  const hit = NAME_CACHE.get(`${platform}:${id}`);
  if (hit === undefined) return undefined;
  if (now - hit.at > NAME_CACHE_TTL_MS) {
    NAME_CACHE.delete(`${platform}:${id}`);
    return undefined;
  }
  return hit.name;
}

function cachePut(platform: string, id: string, name: FriendlyName, now: number): void {
  const key = `${platform}:${id}`;
  NAME_CACHE.delete(key);
  NAME_CACHE.set(key, { platform, id, name, at: now });
  while (NAME_CACHE.size > NAME_CACHE_MAX) {
    const oldest = NAME_CACHE.keys().next().value;
    if (oldest === undefined) break;
    NAME_CACHE.delete(oldest);
  }
}

export function _clearFriendlyNameCacheForTest(): void {
  NAME_CACHE.clear();
}

export interface KnownName {
  readonly platform: string;
  readonly id: string;
  readonly name: FriendlyName;
}

export function searchKnownNames(
  query: string,
  opts: {
    readonly kind?: FriendlyName["kind"];
    readonly platform?: string;
    readonly cap?: number;
    readonly within?: ReadonlySet<string>;
  } = {},
): KnownName[] {
  const norm = (v: string): string => v.trim().replace(/^[#@]/, "").replace(/\s+/g, " ").toLowerCase();
  const q = norm(query);
  if (q.length === 0) return [];
  const now = Date.now();
  const scored: Array<{ hit: KnownName; score: number }> = [];
  for (const entry of NAME_CACHE.values()) {
    if (now - entry.at > NAME_CACHE_TTL_MS) continue;
    if (opts.kind !== undefined && entry.name.kind !== opts.kind) continue;
    if (opts.platform !== undefined && entry.platform !== opts.platform) continue;
    if (opts.within !== undefined && !opts.within.has(`${entry.platform}:${entry.id}`)) continue;
    const label = norm(entry.name.label);
    const score = label === q ? 2 : label.startsWith(q) ? 1 : label.includes(q) ? 0 : -1;
    if (score >= 0) scored.push({ hit: { platform: entry.platform, id: entry.id, name: entry.name }, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.cap ?? 8).map((s) => s.hit);
}

export async function prewarmFriendlyNames(refs: ReadonlyArray<{ readonly platform: string; readonly id: string }>): Promise<void> {
  await resolveFriendlyIds(refs.slice(0, MAX_PREWARM_IDS), MAX_PREWARM_IDS);
}

export const MAX_PREWARM_IDS = 50;

export const MAX_RESOLVED_IDS = 12;
export const NAME_BUDGET_MS = 1500;

export function friendlyNameResolverPlatforms(): readonly string[] {
  return [...RESOLVERS.keys()];
}

export async function resolveFriendlyNames(texts: readonly string[], platform?: string): Promise<Map<string, FriendlyName>> {
  const wanted = new Map<string, { platform: string; id: string }>();
  for (const text of texts) for (const ref of resolvableIds(text, platform)) wanted.set(`${ref.platform}:${ref.id}`, ref);
  return resolveFriendlyIds([...wanted.values()]);
}

export async function resolveFriendlyIds(refs: ReadonlyArray<{ readonly platform: string; readonly id: string }>, max: number = MAX_RESOLVED_IDS): Promise<Map<string, FriendlyName>> {
  const names = new Map<string, FriendlyName>();
  const seen = new Set<string>();
  const now = Date.now();
  const misses: Array<{ readonly platform: string; readonly id: string }> = [];
  for (const ref of refs) {
    const key = `${ref.platform}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cached = cacheGet(ref.platform, ref.id, now);
    if (cached !== undefined) names.set(ref.id, cached);
    else if (RESOLVERS.has(ref.platform)) misses.push(ref);
  }
  const jobs = misses
    .slice(0, max)
    .map(async (ref) => {
      try {
        const hit = await RESOLVERS.get(ref.platform)!(ref.id);
        if (hit !== undefined && hit.label.trim().length > 0) {
          names.set(ref.id, hit);
          cachePut(ref.platform, ref.id, hit, Date.now());
        }
      } catch {
      }
    });
  if (jobs.length === 0) return names;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(jobs), new Promise<void>((resolve) => (timer = setTimeout(resolve, NAME_BUDGET_MS)))]);
  if (timer !== undefined) clearTimeout(timer);
  return new Map(names);
}

export async function friendlyOutboundText(text: string, platform: string): Promise<string> {
  if (resolvableIds(text, platform).length === 0) return renderFriendlyText(text, { platform });
  return renderFriendlyText(text, { platform, names: await resolveFriendlyNames([text], platform) });
}

interface Slot {
  readonly get: () => string;
  readonly set: (value: string) => void;
  readonly platform: string;
}

async function renderSlots(slots: readonly Slot[], surface: string, opts: { readonly lookup?: boolean } = {}): Promise<void> {
  if (slots.length === 0) return;
  const texts = slots.map((s) => s.get());
  const lookup = opts.lookup !== false && texts.some((t) => resolvableIds(t, surface).length > 0);
  const names = lookup ? await resolveFriendlyNames(texts, surface) : undefined;
  slots.forEach((slot, i) => slot.set(renderFriendlyText(texts[i]!, { platform: slot.platform, surface, ...(names !== undefined ? { names } : {}) })));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function field(obj: Record<string, unknown>, key: string, platform: string, into: Slot[]): void {
  if (typeof obj[key] === "string") into.push({ get: () => obj[key] as string, set: (v) => (obj[key] = v), platform });
}

function slackTextObjects(value: unknown, into: Slot[], depth = 0): void {
  if (depth > 12) return;
  if (Array.isArray(value)) {
    for (const v of value) slackTextObjects(v, into, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if ((value.type === "mrkdwn" || value.type === "plain_text") && typeof value.text === "string") {
    field(value, "text", value.type === "mrkdwn" ? "slack" : "plain", into);
    return;
  }
  for (const [k, v] of Object.entries(value)) if (k !== "value" && k !== "action_id" && k !== "block_id" && k !== "url") slackTextObjects(v, into, depth + 1);
}

export const SLACK_MESSAGE_METHODS: ReadonlySet<string> = new Set(["chat.postMessage", "chat.postEphemeral", "chat.update", "chat.scheduleMessage"]);

export async function friendlySlackBody<T>(method: string, body: T): Promise<T> {
  if (!SLACK_MESSAGE_METHODS.has(method) || !isRecord(body)) return body;
  const out: Record<string, unknown> = { ...body };
  const slots: Slot[] = [];
  const reencode: Array<() => void> = [];
  field(out, "text", "slack", slots);
  for (const key of ["blocks", "attachments"] as const) {
    const raw = out[key];
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const copy = structuredClone(parsed) as unknown[];
    slackTextObjects(copy, slots);
    if (key === "attachments") for (const a of copy) if (isRecord(a)) for (const f of ["text", "pretext", "title", "fallback"]) field(a, f, f === "text" || f === "pretext" ? "slack" : "plain", slots);
    reencode.push(() => (out[key] = typeof raw === "string" ? JSON.stringify(copy) : copy));
  }
  await renderSlots(slots, "slack");
  for (const f of reencode) f();
  return out as T;
}

function discordMessageSlots(msg: Record<string, unknown>, into: Slot[]): void {
  field(msg, "content", "discord", into);
  if (Array.isArray(msg.embeds)) {
    for (const e of msg.embeds) {
      if (!isRecord(e)) continue;
      field(e, "title", "plain", into);
      field(e, "description", "discord", into);
      if (isRecord(e.footer)) field(e.footer, "text", "plain", into);
      if (isRecord(e.author)) field(e.author, "name", "plain", into);
      if (Array.isArray(e.fields)) for (const f of e.fields) if (isRecord(f)) (field(f, "name", "plain", into), field(f, "value", "discord", into));
    }
  }
  const walkComponents = (list: unknown, depth: number): void => {
    if (!Array.isArray(list) || depth > 4) return;
    for (const c of list) {
      if (!isRecord(c)) continue;
      field(c, "label", "plain", into);
      field(c, "placeholder", "plain", into);
      if (Array.isArray(c.options)) for (const o of c.options) if (isRecord(o)) (field(o, "label", "plain", into), field(o, "description", "plain", into));
      walkComponents(c.components, depth + 1);
    }
  };
  walkComponents(msg.components, 0);
}

export async function friendlyDiscordBody<T>(body: T, opts: { readonly lookup?: boolean } = {}): Promise<T> {
  if (!isRecord(body)) return body;
  const out = structuredClone(body) as Record<string, unknown>;
  const slots: Slot[] = [];
  discordMessageSlots(out, slots);
  if (isRecord(out.data)) discordMessageSlots(out.data, slots);
  await renderSlots(slots, "discord", opts);
  return out as T;
}

function adaptiveCardSlots(value: unknown, into: Slot[], depth = 0): void {
  if (depth > 16) return;
  if (Array.isArray(value)) {
    for (const v of value) adaptiveCardSlots(v, into, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === "TextBlock" || value.type === "TextRun") field(value, "text", "teams", into);
  if (typeof value.type === "string" && value.type.startsWith("Action.")) field(value, "title", "plain", into);
  if (value.type === "FactSet" && Array.isArray(value.facts)) for (const f of value.facts) if (isRecord(f)) (field(f, "title", "plain", into), field(f, "value", "teams", into));
  for (const [k, v] of Object.entries(value)) if (k !== "data" && k !== "id" && k !== "url" && k !== "facts") adaptiveCardSlots(v, into, depth + 1);
}

export async function friendlyTeamsActivity<T>(body: T): Promise<T> {
  if (!isRecord(body) || (body.type !== undefined && body.type !== "message")) return body;
  const out = structuredClone(body) as Record<string, unknown>;
  const slots: Slot[] = [];
  field(out, "text", "teams", slots);
  field(out, "summary", "plain", slots);
  if (Array.isArray(out.attachments)) for (const a of out.attachments) if (isRecord(a) && isRecord(a.content)) adaptiveCardSlots(a.content, slots);
  if (isRecord(out.activity)) {
    const inner = out.activity;
    field(inner, "text", "teams", slots);
    if (Array.isArray(inner.attachments)) for (const a of inner.attachments) if (isRecord(a) && isRecord(a.content)) adaptiveCardSlots(a.content, slots);
  }
  await renderSlots(slots, "teams");
  return out as T;
}

export async function friendlyGitHubComment<T>(body: T): Promise<T> {
  if (!isRecord(body) || typeof body.body !== "string") return body;
  return { ...body, body: await friendlyOutboundText(body.body, "github") } as T;
}

export const FRIENDLY_GUARDED = Symbol.for("open-everywhere.friendly-guarded");

export const FRIENDLY_SOURCE = Symbol.for("open-everywhere.friendly-source");

export function friendlyGuardSource<T>(arm: T): T {
  return isRecord(arm) && (arm as Record<symbol, unknown>)[FRIENDLY_SOURCE] !== undefined ? ((arm as Record<symbol, unknown>)[FRIENDLY_SOURCE] as T) : arm;
}

export function isFriendlyGuarded(arm: unknown): boolean {
  return isRecord(arm) && (arm as Record<symbol, unknown>)[FRIENDLY_GUARDED] === true;
}

export function guardMessageOps<O extends { readonly platform: string }>(ops: O): O {
  if (isFriendlyGuarded(ops)) return ops;
  const source = ops as unknown as Record<string, unknown>;
  const guarded: Record<string | symbol, unknown> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    guarded[key] = typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(ops) : value;
  }
  const p = ops.platform;
  const call = (key: string, args: unknown[]): unknown => (source[key] as (...a: unknown[]) => unknown).apply(ops, args);
  if (typeof source.postText === "function") {
    guarded.postText = async (channelId: string, text: string, opts?: unknown) => call("postText", [channelId, await friendlyOutboundText(text, p), opts]);
  }
  if (typeof source.editMessage === "function") {
    guarded.editMessage = async (channelId: string, messageId: string, text: string) => call("editMessage", [channelId, messageId, await friendlyOutboundText(text, p)]);
  }
  if (typeof source.postFiles === "function") {
    guarded.postFiles = async (channelId: string, files: ReadonlyArray<{ readonly caption?: string }>, comment: string | undefined) => {
      const rendered = await Promise.all(files.map(async (f) => (typeof f.caption === "string" ? { ...f, caption: await friendlyOutboundText(f.caption, p) } : f)));
      return call("postFiles", [channelId, rendered, comment === undefined ? undefined : await friendlyOutboundText(comment, p)]);
    };
  }
  guarded[FRIENDLY_GUARDED] = true;
  guarded[FRIENDLY_SOURCE] = ops;
  return guarded as unknown as O;
}

export function guardEmailTransport<T extends { readonly id: string; reply(req: { readonly text: string }): Promise<unknown> }>(transport: T): T {
  if (isFriendlyGuarded(transport)) return transport;
  const source = transport as unknown as Record<string, unknown>;
  const guarded: Record<string | symbol, unknown> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    guarded[key] = typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(transport) : value;
  }
  guarded.reply = async (req: { readonly text: string }) => transport.reply({ ...req, text: await friendlyOutboundText(req.text, "email") });
  guarded[FRIENDLY_GUARDED] = true;
  guarded[FRIENDLY_SOURCE] = transport;
  return guarded as unknown as T;
}

export async function nameBesideId(value: string): Promise<string> {
  const refs = resolvableIds(value, "discord");
  if (refs.length === 0) return value;
  const names = await resolveFriendlyIds(refs.slice(-1));
  const hit = names.get(refs[refs.length - 1]!.id);
  if (hit === undefined) return value;
  const label = hit.label.replace(/[[\]()<>\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return label.length > 0 && rawIdLeaks(label).length === 0 ? `${label} (${value})` : value;
}

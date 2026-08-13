import { canonicalNotionId } from "./notion-scope.js";

export type NotionParentLink =
  | { readonly kind: "page"; readonly pageId: string }
  | { readonly kind: "block"; readonly blockId: string }
  | { readonly kind: "database"; readonly databaseId: string }
  | { readonly kind: "workspace" }
  | { readonly kind: "unresolvable" };

export type NotionAncestryReason =
  | "self"
  | "ancestor"
  | "workspace-root"
  | "database-boundary"
  | "hop-limit"
  | "cycle"
  | "unresolvable"
  | "no-roots";

export interface NotionAncestryVerdict {
  readonly trusted: boolean;
  readonly reason: NotionAncestryReason;
  readonly matchedRoot?: string;
  readonly hops: number;
}

export const NOTION_ANCESTRY_MAX_HOPS = 8;

export const NOTION_ANCESTRY_TTL_MS = 60_000;

export interface NotionTrustRoots {
  readonly byWorkspace: ReadonlyMap<string, ReadonlySet<string>>;
}

const NOTION_ID = /^[0-9a-f]{32}$/;

export class NotionTrustConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionTrustConfigError";
  }
}

export function prepareNotionTrustRoots(entries: Iterable<string>): NotionTrustRoots {
  const byWorkspace = new Map<string, Set<string>>();
  for (const raw of entries) {
    const entry = typeof raw === "string" ? raw.trim() : "";
    const segs = entry.split("/");
    if (segs[0] !== "notion") {
      throw new NotionTrustConfigError(
        `notion trust root ${JSON.stringify(entry)} is not a Notion surface key — expected "notion/<workspaceId>/<pageId>".`,
      );
    }
    if (segs.length === 2) {
      throw new NotionTrustConfigError(
        `notion trust root ${JSON.stringify(entry)} names a WHOLE WORKSPACE, which is not a trust root — a workspace needs no ancestor walk, so vouch the workspace key directly in the surface register instead of paying an API call per level to reach the same answer.`,
      );
    }
    if (segs.length < 3) {
      throw new NotionTrustConfigError(
        `notion trust root ${JSON.stringify(entry)} is not a Notion surface key — expected "notion/<workspaceId>/<pageId>".`,
      );
    }
    if (segs.length > 3) {
      throw new NotionTrustConfigError(
        `notion trust root ${JSON.stringify(entry)} is DEEPER than a page, which is refused BY NAME: the only thing under a Notion page that a deeper path could name is a DATABASE ROW, and a row is a separate page holding commonly customer-submitted content. A declaration on a database page reaches the DATABASE PAGE ITSELF and never its rows. Declare "notion/<workspaceId>/<pageId>" for the page, and list any row you genuinely trust as its own entry.`,
      );
    }
    const page = segs[2] ?? "";
    if (/^teamspace/i.test(page) || /^ts:/i.test(page)) {
      throw new NotionTrustConfigError(
        `notion trust root ${JSON.stringify(entry)} names a TEAMSPACE, which is refused BY NAME: no teamspace field exists anywhere on the Notion webhook surface, so a teamspace root could never be resolved at ingestion. Declare the top PAGE of the teamspace instead — every page underneath it is reached by the ancestor walk.`,
      );
    }
    if (page.includes("*")) {
      throw new NotionTrustConfigError(
        `notion trust root ${JSON.stringify(entry)} uses a GLOB, which cannot match anything: a Notion page id is an opaque 32-hex uuid, so a prefix carries no meaning. Name the top page; the ancestor walk is what reaches the pages under it.`,
      );
    }
    const workspace = segs[1] ?? "";
    if (!workspace) {
      throw new NotionTrustConfigError(
        `notion trust root ${JSON.stringify(entry)} has an EMPTY workspace segment — expected "notion/<workspaceId>/<pageId>".`,
      );
    }
    const canonical = canonicalNotionId(page);
    if (!NOTION_ID.test(canonical)) {
      throw new NotionTrustConfigError(
        `notion trust root ${JSON.stringify(entry)} does not name a page — the last segment must be a Notion page id (32 hex digits, hyphenated or bare), not a title or a label.`,
      );
    }
    const set = byWorkspace.get(workspace) ?? new Set<string>();
    set.add(canonical);
    byWorkspace.set(workspace, set);
  }
  return { byWorkspace };
}

interface CacheEntry {
  readonly link: NotionParentLink;
  readonly expiresAt: number;
}

export interface NotionAncestryCache {
  readonly entries: Map<string, CacheEntry>;
}

export const notionAncestryCache: NotionAncestryCache = { entries: new Map() };

export function clearNotionAncestryCache(cache: NotionAncestryCache = notionAncestryCache): void {
  cache.entries.clear();
}

export interface NotionAncestryDeps {
  readonly parentOf: (id: string) => Promise<NotionParentLink>;
  readonly cache?: NotionAncestryCache;
  readonly now?: () => number;
  readonly maxHops?: number;
  readonly ttlMs?: number;
}

async function cachedParentOf(id: string, deps: NotionAncestryDeps): Promise<NotionParentLink> {
  const cache = deps.cache ?? notionAncestryCache;
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? NOTION_ANCESTRY_TTL_MS;
  const key = canonicalNotionId(id);
  const hit = cache.entries.get(key);
  if (hit) {
    if (hit.expiresAt > now()) return hit.link;
    cache.entries.delete(key);
  }
  let link: NotionParentLink;
  try {
    link = await deps.parentOf(id);
  } catch {
    return { kind: "unresolvable" };
  }
  if (!link || link.kind === "unresolvable") return { kind: "unresolvable" };
  cache.entries.set(key, { link, expiresAt: now() + ttl });
  return link;
}

export async function resolveNotionAncestorTrust(
  pageId: string,
  workspaceId: string,
  roots: NotionTrustRoots,
  deps: NotionAncestryDeps,
): Promise<NotionAncestryVerdict> {
  const declared = roots.byWorkspace.get(workspaceId);
  if (!declared || declared.size === 0) return { trusted: false, reason: "no-roots", hops: 0 };

  const start = canonicalNotionId(pageId);
  if (declared.has(start)) return { trusted: true, reason: "self", matchedRoot: start, hops: 0 };

  const maxHops = deps.maxHops ?? NOTION_ANCESTRY_MAX_HOPS;
  const seen = new Set<string>([start]);
  let current = pageId;
  for (let hop = 1; hop <= maxHops; hop++) {
    const link = await cachedParentOf(current, deps);
    if (link.kind === "unresolvable") return { trusted: false, reason: "unresolvable", hops: hop };
    if (link.kind === "workspace") return { trusted: false, reason: "workspace-root", hops: hop };
    if (link.kind === "database") return { trusted: false, reason: "database-boundary", hops: hop };
    const next = link.kind === "page" ? link.pageId : link.blockId;
    const canonical = canonicalNotionId(next);
    if (!canonical) return { trusted: false, reason: "unresolvable", hops: hop };
    if (seen.has(canonical)) return { trusted: false, reason: "cycle", hops: hop };
    seen.add(canonical);
    if (link.kind === "page" && declared.has(canonical)) {
      return { trusted: true, reason: "ancestor", matchedRoot: canonical, hops: hop };
    }
    current = next;
  }
  return { trusted: false, reason: "hop-limit", hops: maxHops };
}

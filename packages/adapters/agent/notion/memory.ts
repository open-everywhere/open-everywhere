import type { MemoryProvider } from "@open-everywhere/core/agent/memory/provider.js";
import { registerProvider } from "@open-everywhere/core/agent/memory/provider.js";
import { safeName } from "@open-everywhere/core/agent/memory/layout.js";
import type { Partition } from "@open-everywhere/core/agent/memory/partition.js";
import type { MemorySilo } from "@open-everywhere/core/agent/memory/silo.js";
import { makeSelector, normalizeSelection, type Selector } from "@open-everywhere/core/agent/memory/selection.js";
import type { Tier, MemoryFiles } from "@open-everywhere/core/agent/memory/store.js";
import { posix } from "node:path";
import { renderBlocks, pageTitle, PAGE_BLOCK_TYPES, type BlockNode, type LinkResolver, type LinkTarget } from "./blocks.js";

const API = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";

const MAX_PAGES = Number(process.env.OE_NOTION_MAX_PAGES) || 200;
const MAX_PAGE_DEPTH = Number(process.env.OE_NOTION_MAX_DEPTH) || 6;
const MAX_BLOCK_DEPTH = 4;
const TTL_MS = Number(process.env.OE_NOTION_TTL_MS) || 5 * 60_000;

export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

interface ChildrenResponse {
  results: BlockNode[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export class NotionClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: HttpFetch = globalThis.fetch as unknown as HttpFetch,
    private readonly apiBase: string = API,
  ) {}

  async children(blockId: string): Promise<BlockNode[]> {
    const out: BlockNode[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
      const res = await this.fetchFn(`${this.apiBase}/v1/blocks/${blockId}/children?${qs}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_VERSION,
          accept: "application/json",
        },
      });
      if (!res.ok) throw new Error(`notion children ${blockId}: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as ChildrenResponse;
      out.push(...(body.results ?? []));
      cursor = body.has_more && body.next_cursor ? body.next_cursor : undefined;
    } while (cursor);
    return out;
  }
}

interface PullStats {
  pages: number;
  capped: boolean;
}

async function loadBlockTree(client: NotionClient, blockId: string, depth: number): Promise<BlockNode[]> {
  const blocks = await client.children(blockId);
  if (depth >= MAX_BLOCK_DEPTH) return blocks;
  for (const b of blocks) {
    if (b.has_children && b.id && !PAGE_BLOCK_TYPES.has(b.type)) {
      (b as { children?: readonly BlockNode[] }).children = await loadBlockTree(client, b.id, depth + 1);
    }
  }
  return blocks;
}

interface CollectedPage {
  readonly key: string;
  readonly id: string;
  readonly title: string;
  readonly blocks: BlockNode[];
}

async function collect(
  client: NotionClient,
  pageId: string,
  title: string,
  segs: string[],
  stats: PullStats,
  out: CollectedPage[],
  selector: Selector,
): Promise<void> {
  if (stats.pages >= MAX_PAGES || segs.length > MAX_PAGE_DEPTH) {
    stats.capped = true;
    return;
  }
  stats.pages++;
  const blocks = await loadBlockTree(client, pageId, 0);
  if (selector.includes(segs, pageId)) {
    const key = segs.length === 0 ? "MEMORY.md" : `${segs.join("/")}.md`;
    out.push({ key, id: pageId, title, blocks });
  }
  if (!selector.descends(segs, pageId)) return;
  for (const b of blocks) {
    if (PAGE_BLOCK_TYPES.has(b.type) && b.id) {
      await collect(client, b.id, pageTitle(b), [...segs, safeName(pageTitle(b))], stats, out, selector);
    }
  }
}

function renderCollected(pages: readonly CollectedPage[]): MemoryFiles {
  const byId = new Map<string, LinkTarget>();
  for (const pg of pages) byId.set(pg.id, { path: pg.key, title: pg.title });

  const files: MemoryFiles = {};
  for (const pg of pages) {
    const fromDir = posix.dirname(pg.key);
    const resolve: LinkResolver = (id) => {
      const t = byId.get(id);
      if (!t) return undefined;
      const rel = posix.relative(fromDir, t.path);
      return { path: rel.length > 0 ? rel : t.path, title: t.title };
    };
    files[pg.key] = renderBlocks(pg.blocks, resolve);
  }
  return files;
}

export interface NotionMemoryDeps {
  client(silo: MemorySilo): NotionClient;
}

interface CacheEntry {
  files: MemoryFiles;
  atMs: number;
}

export function makeNotionProvider(deps: NotionMemoryDeps): MemoryProvider {
  const cache = new Map<string, CacheEntry>();

  async function read(_p: Partition, _tier: Tier, silo?: MemorySilo): Promise<MemoryFiles> {
    if (!silo?.container) {
      throw new Error("notion memory backing needs a silo with container = the root page id (memory/silo.ts).");
    }
    const root = silo.container;
    const hit = cache.get(root);
    if (hit && Date.now() - hit.atMs < TTL_MS) return hit.files;

    const pages: CollectedPage[] = [];
    const stats: PullStats = { pages: 0, capped: false };
    const selector = makeSelector(normalizeSelection(silo));
    await collect(deps.client(silo), root, "index", [], stats, pages, selector);
    if (stats.capped) {
      console.warn(`[open-everywhere:notion] page "${root}" pull hit the cap (${MAX_PAGES} pages / depth ${MAX_PAGE_DEPTH}); some pages omitted.`);
    }
    const files = renderCollected(pages);
    cache.set(root, { files, atMs: Date.now() });
    return files;
  }

  return {
    id: "notion",
    readTier: read,
    ensureTier: read,
    writeTier: async () => null,
    deleteTier: async () => {
    },
  };
}

export function registerNotionMemory(token = process.env.NOTION_TOKEN): boolean {
  if (!token) return false;
  registerProvider(makeNotionProvider({ client: () => new NotionClient(token) }));
  return true;
}

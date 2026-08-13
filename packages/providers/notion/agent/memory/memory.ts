import {
  type MemoryProvider,
  type MemoryAccess,
  registerProvider,
  registerConnectorMemory,
  domainCredentialId,
  findProviderCredential,
  getSecretVia,
  safeName,
  type Partition,
  type MemorySilo,
  makeSelector,
  normalizeSelection,
  type Selector,
  type Tier,
  type MemoryFiles,
} from "@open-everywhere/core/agent/adapter-api.js";
import { posix } from "node:path";
import { renderBlocks, pageTitle, PAGE_BLOCK_TYPES, type BlockNode, type LinkResolver, type LinkTarget } from "./blocks.js";
import { NOTION_PROVIDER } from "../channels/notion-credentials.js";

const API = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";

export const NOTION_MEMORY_CREDENTIAL = "memory";

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
  credentialFor?(access?: MemoryAccess): string;
  client(silo: MemorySilo, credentialId: string): NotionClient | Promise<NotionClient>;
}

interface CacheEntry {
  files: MemoryFiles;
  atMs: number;
}

export function makeNotionProvider(deps: NotionMemoryDeps): MemoryProvider {
  const cache = new Map<string, CacheEntry>();

  async function read(_p: Partition, _tier: Tier, silo?: MemorySilo, access?: MemoryAccess): Promise<MemoryFiles> {
    if (!silo?.container) {
      throw new Error("notion memory backing needs a silo with container = the root page id (memory/silo.ts).");
    }
    const root = silo.container;
    const credentialId = deps.credentialFor?.(access) ?? NOTION_MEMORY_CREDENTIAL;
    const cacheKey = `${credentialId} ${root}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.atMs < TTL_MS) return hit.files;

    const pages: CollectedPage[] = [];
    const stats: PullStats = { pages: 0, capped: false };
    const selector = makeSelector(normalizeSelection(silo));
    await collect(await deps.client(silo, credentialId), root, "index", [], stats, pages, selector);
    if (stats.capped) {
      console.warn(`[open-everywhere:notion] page "${root}" pull hit the cap (${MAX_PAGES} pages / depth ${MAX_PAGE_DEPTH}); some pages omitted.`);
    }
    const files = renderCollected(pages);
    cache.set(cacheKey, { files, atMs: Date.now() });
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

export async function resolveNotionMemoryToken(credentialId: string, broker: string, secretRef: string): Promise<string> {
  if (credentialId === NOTION_MEMORY_CREDENTIAL) return getSecretVia(broker, secretRef);
  const cred = findProviderCredential(NOTION_PROVIDER, credentialId);
  if (!cred?.secretRef) {
    throw new Error(
      `notion memory backing: domain credential "${credentialId}" is not a declared notion credential with a secretRef ` +
        `(agent/access/providers.ts). A bound domain never falls back to the org default "${NOTION_MEMORY_CREDENTIAL}" key.`,
    );
  }
  return getSecretVia(cred.broker, cred.secretRef);
}

export function notionMemoryDeps(secretRef: string, broker: string, fetchFn?: HttpFetch): NotionMemoryDeps {
  return {
    credentialFor: (access) => domainCredentialId(access?.domain, NOTION_PROVIDER, NOTION_MEMORY_CREDENTIAL),
    client: async (_silo, credentialId) => new NotionClient(await resolveNotionMemoryToken(credentialId, broker, secretRef), fetchFn),
  };
}

export function registerNotionMemory(
  secretRef = process.env.OE_NOTION_SECRET_REF ?? "db:notion:memory",
  broker = process.env.OE_NOTION_SECRET_BROKER ?? "db",
): void {
  registerProvider(makeNotionProvider(notionMemoryDeps(secretRef, broker)));
  registerConnectorMemory({
    provider: "notion",
    connector: "notion",
    mode: "materialise",
    subject: "app-principal",
    containerLabel: "the root page id",
  });
}

import {
  type MemoryProvider,
  type MemoryAccess,
  registerProvider,
  registerConnectorMemory,
  domainCredentialId,
  findConnectorCredential,
  getSecretVia,
  safeName,
  type Partition,
  type MemorySilo,
  makeSelector,
  normalizeSelection,
  type Selector,
  type Tier,
  type MemoryFiles,
  assertCredentialEndpointAllowed,
  type CredentialEndpointRules,
  withRetryAfterLoose,
  type RetryPolicy,
} from "@open-everywhere/core/agent/adapter-api.js";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  renderBlocks,
  pageTitle,
  contentLines,
  blocksFromMarkdown,
  PAGE_BLOCK_TYPES,
  type BlockNode,
  type LinkResolver,
  type LinkTarget,
} from "./blocks.js";
import { NOTION_PROVIDER } from "../channels/notion-credentials.js";

const API = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";

export const NOTION_MEMORY_CREDENTIAL = "memory";

const MAX_PAGES = 200;
const MAX_PAGE_DEPTH = 6;
const MAX_BLOCK_DEPTH = 4;
const TTL_MS = 5 * 60_000;

export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

const MAX_APPEND_CHILDREN = 100;

interface ChildrenResponse {
  results: BlockNode[];
  has_more?: boolean;
  next_cursor?: string | null;
}

function guardHttpFetch(endpoints: CredentialEndpointRules | undefined, base: HttpFetch): HttpFetch {
  if (endpoints === undefined) return base;
  return async (url, init) => {
    assertCredentialEndpointAllowed(endpoints, url, init.method, "notion memory credential");
    return base(url, init);
  };
}

export class NotionClient {
  private readonly fetchFn: HttpFetch;

  constructor(
    private readonly token: string,
    fetchFn: HttpFetch = globalThis.fetch as unknown as HttpFetch,
    private readonly apiBase: string = API,
    endpoints?: CredentialEndpointRules,
    private readonly retry?: RetryPolicy,
  ) {
    this.fetchFn = guardHttpFetch(endpoints, fetchFn);
  }

  async children(blockId: string): Promise<BlockNode[]> {
    const out: BlockNode[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
      const res = await withRetryAfterLoose(
        () =>
          this.fetchFn(`${this.apiBase}/v1/blocks/${blockId}/children?${qs}`, {
            method: "GET",
            headers: {
              authorization: `Bearer ${this.token}`,
              "Notion-Version": NOTION_VERSION,
              accept: "application/json",
            },
          }),
        { ...this.retry, surface: "notion", operation: "blocks.children.list" },
      );
      if (!res.ok) throw new Error(`notion children ${blockId}: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as ChildrenResponse;
      out.push(...(body.results ?? []));
      cursor = body.has_more && body.next_cursor ? body.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  async appendChildren(blockId: string, children: readonly BlockNode[]): Promise<void> {
    for (let i = 0; i < children.length; i += MAX_APPEND_CHILDREN) {
      const batch = children.slice(i, i + MAX_APPEND_CHILDREN);
      const res = await withRetryAfterLoose(
        () =>
          this.fetchFn(`${this.apiBase}/v1/blocks/${blockId}/children`, {
            method: "PATCH",
            headers: {
              authorization: `Bearer ${this.token}`,
              "Notion-Version": NOTION_VERSION,
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify({ children: batch }),
          }),
        { ...this.retry, surface: "notion", operation: "blocks.children.append" },
      );
      if (!res.ok) throw new Error(`notion append ${blockId}: ${res.status} ${await res.text()}`);
    }
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

interface Pull {
  readonly files: MemoryFiles;
  readonly pageIds: ReadonlyMap<string, string>;
}

interface CacheEntry {
  pull: Pull;
  atMs: number;
}

export function makeNotionProvider(deps: NotionMemoryDeps): MemoryProvider {
  const cache = new Map<string, CacheEntry>();

  function cacheKeyFor(silo: MemorySilo, credentialId: string): string {
    return `${credentialId} ${silo.container} ${JSON.stringify(normalizeSelection(silo))}`;
  }

  function requireContainer(silo?: MemorySilo): MemorySilo {
    if (!silo?.container) {
      throw new Error("notion memory backing needs a silo with container = the root page id (memory/silo.ts).");
    }
    return silo;
  }

  async function pull(silo: MemorySilo, access: MemoryAccess | undefined, fresh: boolean): Promise<Pull> {
    const root = silo.container!;
    const credentialId = deps.credentialFor?.(access) ?? NOTION_MEMORY_CREDENTIAL;
    const cacheKey = cacheKeyFor(silo, credentialId);
    const hit = cache.get(cacheKey);
    if (!fresh && hit && Date.now() - hit.atMs < TTL_MS) return hit.pull;

    const pages: CollectedPage[] = [];
    const stats: PullStats = { pages: 0, capped: false };
    const selector = makeSelector(normalizeSelection(silo));
    await collect(await deps.client(silo, credentialId), root, "index", [], stats, pages, selector);
    if (stats.capped) {
      console.warn(`[open-everywhere:notion] page "${root}" pull hit the cap (${MAX_PAGES} pages / depth ${MAX_PAGE_DEPTH}); some pages omitted.`);
    }
    const result: Pull = { files: renderCollected(pages), pageIds: new Map(pages.map((pg) => [pg.key, pg.id])) };
    cache.set(cacheKey, { pull: result, atMs: Date.now() });
    return result;
  }

  async function read(_p: Partition, _tier: Tier, silo?: MemorySilo, access?: MemoryAccess): Promise<MemoryFiles> {
    return (await pull(requireContainer(silo), access, false)).files;
  }

  async function write(
    _p: Partition,
    _tier: Tier,
    files: MemoryFiles,
    _message: string,
    siloArg?: MemorySilo,
    access?: MemoryAccess,
  ): Promise<string | null> {
    const silo = requireContainer(siloArg);
    if (silo.readOnly === true) {
      const via = silo.skill ? `the \`${silo.skill}\` skill` : "the Notion tools";
      throw new Error(
        `notion memory: silo "${silo.name}" is READ-ONLY (memory/silo.ts \`readOnly\`), so this write of ` +
          `${Object.keys(files).length} file(s) was REFUSED and NOTHING was saved. Update the Notion source with ` +
          `${via} and the projection refreshes from it, or declare the silo writable to let memory append to its pages.`,
      );
    }

    const credentialId = deps.credentialFor?.(access) ?? NOTION_MEMORY_CREDENTIAL;
    const current = await pull(silo, access, true);
    const appends: { pageId: string; key: string; lines: string[] }[] = [];
    for (const [key, content] of Object.entries(files)) {
      const pageId = current.pageIds.get(key);
      if (pageId === undefined) {
        throw new Error(
          `notion memory: silo "${silo.name}" has no Notion page for "${key}", and this backing appends to ` +
            `EXISTING pages only — it does not create them. NOTHING was saved, including the other file(s) in ` +
            `this write: the whole tier is refused together so no half-written state reaches Notion. Add the ` +
            `page under root page "${silo.container}" in Notion (it becomes writable on the next pull), or move ` +
            `this silo to a backing that owns its files (github/postgres/sqlite). 🔴 THREE FILE SHAPES ARE ` +
            `HOST-MINTED and can never map to a page: "RECURRING.md" (the dream cycle's enrichment), ` +
            `"<file>.conflict-<session>.md" (a concurrent write parked by the merge) and ` +
            `"<file>.rejected-<session>.md" (a destructive overwrite parked by the write guard). A deployment ` +
            `that runs any of those must not hold its writable memory on this backing.`,
        );
      }
      const cur = contentLines(current.files[key] ?? "");
      const next = contentLines(content);
      const diverges = cur.findIndex((line, i) => line !== next[i]);
      if (diverges !== -1) {
        throw new Error(
          `notion memory: "${key}" in silo "${silo.name}" changed at line ${diverges + 1}, and this backing is ` +
            `APPEND-ONLY — it adds blocks to the end of a page and cannot edit or remove one. Nothing was saved. ` +
            `Change that content in Notion itself, or move this silo to a backing that owns its files ` +
            `(github/postgres/sqlite).`,
        );
      }
      const added = next.slice(cur.length);
      if (added.length > 0) appends.push({ pageId, key, lines: added });
    }
    if (appends.length === 0) return null;

    const batches = appends.map((a) => ({ ...a, blocks: blocksFromMarkdown(a.lines) }));
    const client = await deps.client(silo, credentialId);
    cache.delete(cacheKeyFor(silo, credentialId));
    const version = createHash("sha256");
    for (const batch of batches) {
      try {
        await client.appendChildren(batch.pageId, batch.blocks);
      } catch (err) {
        throw new Error(
          `notion memory: appending to silo "${silo.name}" failed for "${batch.key}" — ${String(err)}. ` +
            `Nothing further was written. If this is an endpoint refusal, the notion "memory" credential ` +
            `must admit PATCH on /v1/blocks/ (agent/access/connector-credentials.ts): write-back is a ` +
            `deliberate capability expansion, so a deployment opts into it in that file, not here.`,
          { cause: err },
        );
      }
      version.update(`${batch.key}\n${batch.lines.join("\n")}\n`);
    }
    return version.digest("hex");
  }

  return {
    id: "notion",
    readTier: read,
    ensureTier: read,
    writeTier: write,
    deleteTier: async (_p, _tier, silo) => {
      if (silo?.readOnly === true) return;
      throw new Error(
        `notion memory: silo "${silo?.name ?? "(unnamed)"}" is writable, and this backing cannot erase a tier — ` +
          `it appends blocks and never deletes them. NOTHING was erased. Remove the content in Notion itself, or ` +
          `hold erasable memory in a backing with real deletion (postgres/sqlite).`,
      );
    },
  };
}

export interface ResolvedNotionMemoryCredential {
  readonly token: string;
  readonly endpoints?: CredentialEndpointRules;
}

export async function resolveNotionMemoryCredential(
  credentialId: string,
  broker: string,
  secretRef: string,
): Promise<ResolvedNotionMemoryCredential> {
  if (credentialId === NOTION_MEMORY_CREDENTIAL) {
    const token = await getSecretVia(broker, secretRef);
    return { token, endpoints: findConnectorCredential(NOTION_PROVIDER, NOTION_MEMORY_CREDENTIAL)?.endpoints };
  }
  const cred = findConnectorCredential(NOTION_PROVIDER, credentialId);
  if (!cred?.secretRef) {
    throw new Error(
      `notion memory backing: domain credential "${credentialId}" is not a declared notion credential with a secretRef ` +
        `(agent/access/providers.ts). A bound domain never falls back to the org default "${NOTION_MEMORY_CREDENTIAL}" key.`,
    );
  }
  const token = await getSecretVia(cred.broker, cred.secretRef);
  return { token, endpoints: cred.endpoints };
}

export function notionMemoryDeps(secretRef: string, broker: string, fetchFn?: HttpFetch): NotionMemoryDeps {
  return {
    credentialFor: (access) => domainCredentialId(access?.domain, NOTION_PROVIDER, NOTION_MEMORY_CREDENTIAL),
    client: async (_silo, credentialId) => {
      const { token, endpoints } = await resolveNotionMemoryCredential(credentialId, broker, secretRef);
      return new NotionClient(token, fetchFn, API, endpoints);
    },
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

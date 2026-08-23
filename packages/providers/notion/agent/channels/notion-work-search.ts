import {
  registerWorkSearchAdapter,
  type WorkSearchAdapter,
  type WorkSearchHit,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";
import { resolveNotionCredential, searchNotion } from "./notion-api.js";
import { notionWorkGrant } from "./notion-work.js";
import { canonicalNotionId } from "./notion-scope.js";

export function domainOwnPageIds(domain: Domain): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const key of domain.channels ?? []) {
    const parts = key.split("/");
    if (parts.length === 3 && parts[0] === "notion" && parts[2].length > 0) ids.add(canonicalNotionId(parts[2]));
  }
  return ids;
}

export const notionWorkSearchAdapter: WorkSearchAdapter = {
  connector: "notion",
  async search(ctx: BindableContext, domain: Domain, query: string, opts: { limit: number; insideDomain: boolean }): Promise<readonly WorkSearchHit[]> {
    const grant = notionWorkGrant(ctx, [domain]);
    if (!grant) throw new Error("this domain holds no Notion work grant.");
    const cred = await resolveNotionCredential(grant.credential);
    if (!cred) throw new Error(`no value stored for this domain's Notion work credential "${grant.credential}".`);
    const hits = await searchNotion(query, { ...cred, pageSize: Math.min(Math.max(opts.limit, 1), 100) });
    const ownIds = opts.insideDomain ? domainOwnPageIds(domain) : undefined;
    const scoped = ownIds ? hits.filter((h) => ownIds.has(canonicalNotionId(h.id))) : hits;
    return scoped.slice(0, opts.limit).map((h) => ({
      connector: "notion",
      id: h.id,
      title: h.title || "(untitled)",
      ...(h.url ? { url: h.url } : {}),
    }));
  },
};

export function registerNotionWorkSearch(): void {
  registerWorkSearchAdapter(notionWorkSearchAdapter);
}

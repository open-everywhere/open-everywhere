import {
  NOTION_ANCESTRY_TTL_MS,
  NotionTrustConfigError,
  _resetNotionTrustRootProbesForTest,
  _resetNotionTrustRootsForTest,
  clearNotionAncestryCache,
  notionTrustRoots,
  prepareNotionTrustRoots,
  probeUnreachableNotionTrustRoots,
  registerNotionTrustRoots,
  resolveNotionAncestorTrust,
  resolveNotionDeliveryTrust,
  type NotionAncestryCache,
  type NotionParentLink,
} from "../agent/channels/notion-ancestry-trust.js";
import { notionParentLink, toNotionParentLink } from "../agent/channels/notion-api.js";
import {
  defineSurface,
  registerSurfaces,
  registerSubtreePlatform,
  applySubtreeSurfaceClaims,
  _resetSurfacesForTest,
  _resetSubtreePlatformsForTest,
} from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const WS = "ws-1";
const ROOT = "11111111-1111-4111-8111-111111111111";
const MID = "22222222-2222-4222-8222-222222222222";
const LEAF = "33333333-3333-4333-8333-333333333333";
const OUTSIDE = "44444444-4444-4444-8444-444444444444";
const DB = "55555555-5555-4555-8555-555555555555";
const ROW = "66666666-6666-4666-8666-666666666666";
const BLOCK = "77777777-7777-4777-8777-777777777777";
const TEAMSPACE = "88888888-8888-4888-8888-888888888888";

const ROOTS = prepareNotionTrustRoots([`notion/${WS}/${ROOT}`]);

function treeParentOf(tree: Record<string, NotionParentLink>): {
  parentOf: (id: string) => Promise<NotionParentLink>;
  calls: () => number;
} {
  let calls = 0;
  const bare = (id: string): string => id.replace(/-/g, "");
  const index = new Map<string, NotionParentLink>(Object.entries(tree).map(([k, v]) => [bare(k), v]));
  return {
    parentOf: async (id: string) => {
      calls++;
      return index.get(bare(id)) ?? { kind: "unresolvable" };
    },
    calls: () => calls,
  };
}

const TREE: Record<string, NotionParentLink> = {
  [MID]: { kind: "page", pageId: ROOT },
  [LEAF]: { kind: "page", pageId: MID },
  [ROOT]: { kind: "workspace" },
  [OUTSIDE]: { kind: "workspace" },
  [DB]: { kind: "page", pageId: ROOT },
  [ROW]: { kind: "database", databaseId: DB },
  [BLOCK]: { kind: "page", pageId: ROOT },
};

function freshCache(): NotionAncestryCache {
  const cache: NotionAncestryCache = { entries: new Map() };
  clearNotionAncestryCache(cache);
  return cache;
}

{
  const refused = (entry: string, mustSay: string, label: string): void => {
    let err: unknown;
    try {
      prepareNotionTrustRoots([entry]);
    } catch (e) {
      err = e;
    }
    ok(err instanceof NotionTrustConfigError, `${label} throws NotionTrustConfigError`);
    ok(
      err instanceof Error && err.message.includes(mustSay),
      `${label} names the refusal in the message (${JSON.stringify(mustSay)})`,
    );
  };

  refused(`notion/${WS}/${DB}/rows`, "DATABASE ROW", "a row-grain key");
  refused(`notion/${WS}/${DB}/${ROW}`, "DATABASE ROW", "a four-segment key");
  refused(`notion/${WS}/teamspace:engineering`, "does not name a page", "a teamspace label");
  refused(`notion/${WS}`, "WHOLE WORKSPACE", "a workspace key");
  refused(`notion/${WS}/1111*`, "GLOB", "a globbed page segment");
  refused(`slack/${WS}/${ROOT}`, "not a Notion surface key", "a non-Notion key");
  refused(`notion/${WS}/engineering-handbook`, "does not name a page", "a title instead of a page id");
  refused(`notion//${ROOT}`, "EMPTY workspace", "an empty workspace segment");
  refused("notion", "expected", "a bare platform key");
  {
    let message = "";
    try {
      prepareNotionTrustRoots(["notion"]);
    } catch (e) {
      message = e instanceof Error ? e.message : "";
    }
    ok(!message.includes("DEEPER"), "a bare platform key is NOT reported as a database-row key");
  }

  const good = prepareNotionTrustRoots([`notion/${WS}/${ROOT}`, `notion/ws-2/${MID}`]);
  ok(good.byWorkspace.get(WS)?.has(ROOT.replace(/-/g, "")) === true, "a well-formed key is accepted and canonicalised");
  ok(good.byWorkspace.get("ws-2")?.size === 1, "roots are grouped per workspace");
  ok(good.byWorkspace.get(WS)?.size === 1, "a workspace holds only its own roots");

  const teamspaceShaped = prepareNotionTrustRoots([`notion/${WS}/${TEAMSPACE}`]);
  ok(
    teamspaceShaped.byWorkspace.get(WS)?.has(TEAMSPACE.replace(/-/g, "")) === true,
    "🔴 a TEAMSPACE-shaped uuid is ACCEPTED at config time — no string test can tell it from a page id",
  );
}

{
  const t = treeParentOf(TREE);
  const self = await resolveNotionAncestorTrust(ROOT, WS, ROOTS, { parentOf: t.parentOf, cache: freshCache() });
  ok(self.trusted === true && self.reason === "self", "the declared root itself is trusted");
  ok(self.hops === 0 && t.calls() === 0, "the root needs NO parent lookup at all (the cheap path first)");
}
{
  const t = treeParentOf(TREE);
  const one = await resolveNotionAncestorTrust(MID, WS, ROOTS, { parentOf: t.parentOf, cache: freshCache() });
  ok(one.trusted === true && one.reason === "ancestor", "a direct child of the root is trusted");
  ok(one.matchedRoot === ROOT.replace(/-/g, ""), "the verdict names the root that matched");
  ok(one.hops === 1, "a direct child costs ONE hop");

  const two = await resolveNotionAncestorTrust(LEAF, WS, ROOTS, { parentOf: t.parentOf, cache: freshCache() });
  ok(two.trusted === true && two.reason === "ancestor" && two.hops === 2, "a grandchild is trusted at two hops");
}
{
  const t = treeParentOf({ ...TREE, [LEAF]: { kind: "block", blockId: BLOCK } });
  const v = await resolveNotionAncestorTrust(LEAF, WS, ROOTS, { parentOf: t.parentOf, cache: freshCache() });
  ok(v.trusted === true && v.reason === "ancestor", "a page nested inside a block still reaches its root page");
}
{
  const bare = (id: string): string => id.replace(/-/g, "");
  const t = treeParentOf({ [bare(MID)]: { kind: "page", pageId: bare(ROOT) } });
  const v = await resolveNotionAncestorTrust(bare(MID), WS, ROOTS, { parentOf: t.parentOf, cache: freshCache() });
  ok(v.trusted === true, "a bare-form chain matches a hyphenated declared root");
}

{
  const t = treeParentOf(TREE);
  const row = await resolveNotionAncestorTrust(ROW, WS, ROOTS, { parentOf: t.parentOf, cache: freshCache() });
  ok(row.trusted === false, "a DATABASE ROW is NOT trusted, even though the database sits under the declared root");
  ok(row.reason === "database-boundary", "the row's refusal names the database boundary");

  const dbPage = await resolveNotionAncestorTrust(DB, WS, ROOTS, { parentOf: t.parentOf, cache: freshCache() });
  ok(dbPage.trusted === true && dbPage.reason === "ancestor", "the database PAGE under the root IS trusted");
}

{
  const t = treeParentOf(TREE);
  const out = await resolveNotionAncestorTrust(OUTSIDE, WS, ROOTS, { parentOf: t.parentOf, cache: freshCache() });
  ok(out.trusted === false && out.reason === "workspace-root", "a page at the workspace root is NOT trusted");

  const otherWs = await resolveNotionAncestorTrust(MID, "ws-elsewhere", ROOTS, { parentOf: t.parentOf, cache: freshCache() });
  ok(otherWs.trusted === false && otherWs.reason === "no-roots", "a workspace with no declared root trusts nothing");
  ok(otherWs.hops === 0, "a workspace with no declared root spends NO API call");

  const empty = await resolveNotionAncestorTrust(MID, WS, prepareNotionTrustRoots([]), {
    parentOf: t.parentOf,
    cache: freshCache(),
  });
  ok(empty.trusted === false && empty.reason === "no-roots", "an EMPTY root list trusts nothing (fail-closed default)");
}
{
  const thrower = {
    parentOf: async (): Promise<NotionParentLink> => {
      throw new Error("notion is down");
    },
  };
  const v = await resolveNotionAncestorTrust(MID, WS, ROOTS, { ...thrower, cache: freshCache() });
  ok(v.trusted === false && v.reason === "unresolvable", "a THROWING parent lookup is untrusted, not an exception");
}
{
  const v = await resolveNotionAncestorTrust(MID, WS, ROOTS, {
    parentOf: async () => ({ kind: "unresolvable" }),
    cache: freshCache(),
  });
  ok(v.trusted === false && v.reason === "unresolvable", "an unresolvable parent link is untrusted");
}
{
  const deep: Record<string, NotionParentLink> = { [`p0`]: { kind: "page", pageId: ROOT } };
  for (let i = 1; i <= 10; i++) deep[`p${i}`] = { kind: "page", pageId: `p${i - 1}` };
  const t = treeParentOf(deep);
  const bounded = await resolveNotionAncestorTrust("p10", WS, ROOTS, { parentOf: t.parentOf, cache: freshCache(), maxHops: 3 });
  ok(bounded.trusted === false && bounded.reason === "hop-limit", "a chain longer than the hop limit is untrusted");
  ok(bounded.hops === 3, "the walk stops exactly at the hop limit");

  const unbounded = await resolveNotionAncestorTrust("p10", WS, ROOTS, { parentOf: t.parentOf, cache: freshCache(), maxHops: 20 });
  ok(unbounded.trusted === true, "the SAME chain IS trusted when the hop limit allows it (the bound is what refused)");
}
{
  const t = treeParentOf({ [MID]: { kind: "page", pageId: LEAF }, [LEAF]: { kind: "page", pageId: MID } });
  const v = await resolveNotionAncestorTrust(MID, WS, ROOTS, { parentOf: t.parentOf, cache: freshCache() });
  ok(v.trusted === false && v.reason === "cycle", "a looping chain is untrusted");
}
{
  const v = await resolveNotionAncestorTrust(MID, WS, ROOTS, {
    parentOf: async () => ({ kind: "page", pageId: "" }),
    cache: freshCache(),
  });
  ok(v.trusted === false, "an EMPTY parent id is untrusted");
  ok(v.reason === "unresolvable", "an EMPTY parent id reports unresolvable, NOT cycle");
}

{
  const cache = freshCache();
  let clock = 1_000_000;
  const now = (): number => clock;
  let calls = 0;
  let moved = false;
  const parentOf = async (): Promise<NotionParentLink> => {
    calls++;
    return moved ? { kind: "workspace" } : { kind: "page", pageId: ROOT };
  };

  const first = await resolveNotionAncestorTrust(MID, WS, ROOTS, { parentOf, cache, now });
  ok(first.trusted === true && calls === 1, "the first walk resolves and costs one lookup");

  moved = true;
  clock += NOTION_ANCESTRY_TTL_MS - 1;
  const stale = await resolveNotionAncestorTrust(MID, WS, ROOTS, { parentOf, cache, now });
  ok(stale.trusted === true, "INSIDE the TTL the moved page keeps its stale trust (the accepted cost)");
  ok(calls === 1, "INSIDE the TTL no second lookup happens — the cache served it");

  clock += 2;
  const fresh = await resolveNotionAncestorTrust(MID, WS, ROOTS, { parentOf, cache, now });
  ok(fresh.trusted === false && fresh.reason === "workspace-root", "PAST the TTL the moved page loses trust");
  ok(calls === 2, "PAST the TTL the edge is fetched again");
}
{
  const cache = freshCache();
  let clock = 5_000_000;
  const now = (): number => clock;
  let moved = false;
  const parentOf = async (): Promise<NotionParentLink> => (moved ? { kind: "page", pageId: ROOT } : { kind: "workspace" });

  const before = await resolveNotionAncestorTrust(MID, WS, ROOTS, { parentOf, cache, now, ttlMs: 10_000 });
  ok(before.trusted === false, "a page outside the tree starts untrusted");

  moved = true;
  const inside = await resolveNotionAncestorTrust(MID, WS, ROOTS, { parentOf, cache, now, ttlMs: 10_000 });
  ok(inside.trusted === false, "INSIDE the TTL a page moved INTO the tree is still untrusted (staleness cuts both ways)");

  clock += 10_001;
  const after = await resolveNotionAncestorTrust(MID, WS, ROOTS, { parentOf, cache, now, ttlMs: 10_000 });
  ok(after.trusted === true, "PAST the TTL the page moved into the tree becomes trusted");
}
{
  const cache = freshCache();
  const clock = 9_000_000;
  let fail = true;
  const parentOf = async (): Promise<NotionParentLink> => {
    if (fail) throw new Error("transient");
    return { kind: "page", pageId: ROOT };
  };

  const failed = await resolveNotionAncestorTrust(MID, WS, ROOTS, { parentOf, cache, now: () => clock });
  ok(failed.trusted === false, "the failing lookup is untrusted");
  ok(cache.entries.size === 0, "the failure wrote NOTHING to the cache");

  fail = false;
  const recovered = await resolveNotionAncestorTrust(MID, WS, ROOTS, { parentOf, cache, now: () => clock });
  ok(recovered.trusted === true, "the very next walk resolves — a transient failure is not sticky");
}
{
  const cache = freshCache();
  const clock = 11_000_000;
  let blind = true;
  const parentOf = async (): Promise<NotionParentLink> => (blind ? { kind: "unresolvable" } : { kind: "page", pageId: ROOT });

  const unknown = await resolveNotionAncestorTrust(MID, WS, ROOTS, { parentOf, cache, now: () => clock });
  ok(unknown.trusted === false && unknown.reason === "unresolvable", "a RETURNED unresolvable link is untrusted");
  ok(cache.entries.size === 0, "a RETURNED unresolvable link writes NOTHING to the cache");

  blind = false;
  const recovered = await resolveNotionAncestorTrust(MID, WS, ROOTS, { parentOf, cache, now: () => clock });
  ok(recovered.trusted === true, "the next walk resolves — a returned unresolvable is not sticky either");
}
{
  const cache = freshCache();
  const clock = 3_000_000;
  let calls = 0;
  const parentOf = async (): Promise<NotionParentLink> => {
    calls++;
    return { kind: "page", pageId: ROOT };
  };
  await resolveNotionAncestorTrust(MID, WS, ROOTS, { parentOf, cache, now: () => clock });
  ok(cache.entries.size === 1, "a resolved edge IS cached");
  clearNotionAncestryCache(cache);
  ok(cache.entries.size === 0, "clearNotionAncestryCache empties the cache");
  await resolveNotionAncestorTrust(MID, WS, ROOTS, { parentOf, cache, now: () => clock });
  ok(calls === 2, "after a clear the edge is fetched again");
}

{
  ok(toNotionParentLink(undefined).kind === "unresolvable", "a missing parent maps to unresolvable");
  ok(toNotionParentLink({ type: "workspace", workspace: true }).kind === "workspace", "a workspace parent maps to workspace");
  const page = toNotionParentLink({ type: "page_id", page_id: ROOT });
  ok(page.kind === "page" && page.pageId === ROOT, "a page parent carries the page id");
  const block = toNotionParentLink({ type: "block_id", block_id: BLOCK });
  ok(block.kind === "block" && block.blockId === BLOCK, "a block parent carries the block id");
  const db = toNotionParentLink({ type: "database_id", database_id: DB });
  ok(db.kind === "database" && db.databaseId === DB, "a database parent maps to database");
  const ds = toNotionParentLink({ type: "data_source_id", data_source_id: DB });
  ok(ds.kind === "database", "the 2025-09-03 data_source_id spelling ALSO maps to database");
  ok(toNotionParentLink({ type: "something_new" }).kind === "unresolvable", "an unknown parent type is unresolvable, NOT workspace");
}
{
  const dead = async (): Promise<Response> => new Response("nope", { status: 404 });
  const v = await notionParentLink(ROW, { apiKey: "k", fetch: dead });
  ok(v.kind === "unresolvable", "notionParentLink returns unresolvable when Notion serves neither a page nor a block");

  const blockOnly = async (url: string): Promise<Response> =>
    url.includes("/v1/blocks/")
      ? new Response(JSON.stringify({ parent: { type: "page_id", page_id: ROOT } }), { status: 200 })
      : new Response("nope", { status: 404 });
  const viaBlock = await notionParentLink(LEAF, { apiKey: "k", fetch: blockOnly });
  ok(viaBlock.kind === "page" && viaBlock.pageId === ROOT, "notionParentLink falls back to the block endpoint");

  const pageOk = async (): Promise<Response> =>
    new Response(JSON.stringify({ parent: { type: "database_id", database_id: DB } }), { status: 200 });
  const row = await notionParentLink(ROW, { apiKey: "k", fetch: pageOk });
  ok(row.kind === "database", "notionParentLink reads a row's database parent from the page endpoint");
}

{
  _resetNotionTrustRootsForTest();
  ok(notionTrustRoots().byWorkspace.size === 0, "before registration NOTHING is a trust root (fail-closed)");

  registerNotionTrustRoots([`notion/${WS}/${ROOT}`]);
  ok(notionTrustRoots().byWorkspace.get(WS)?.has(ROOT.replace(/-/g, "")) === true, "the register holds what the operator declared");

  registerNotionTrustRoots([`notion/ws-2/${MID}`]);
  ok(notionTrustRoots().byWorkspace.has(WS) === false, "a second register REPLACES the first (it does not accumulate)");

  let threw = false;
  try {
    registerNotionTrustRoots([`notion/${WS}`]);
  } catch (e) {
    threw = e instanceof NotionTrustConfigError;
  }
  ok(threw, "registerNotionTrustRoots THROWS on a malformed entry (a boot error, not a silent drop)");

  _resetNotionTrustRootsForTest();
  ok(notionTrustRoots().byWorkspace.size === 0, "the test reset really empties the register");
}

{
  _resetNotionTrustRootsForTest();
  _resetSurfacesForTest();
  _resetSubtreePlatformsForTest();

  registerSubtreePlatform("notion", registerNotionTrustRoots);

  registerSurfaces([defineSurface({ key: `notion/${WS}/${ROOT}`, trust: "internal" })]);
  applySubtreeSurfaceClaims();
  ok(notionTrustRoots().byWorkspace.size === 0, "🔴 a plain `defineSurface` Notion entry is NOT a trust root (it vouches that ONE page)");
  {
    const t = treeParentOf(TREE);
    const v = await resolveNotionAncestorTrust(MID, WS, notionTrustRoots(), { parentOf: t.parentOf, cache: freshCache() });
    ok(v.trusted === false && v.reason === "no-roots", "…so a page under it resolves no-roots, with no walk at all");
    ok(t.calls() === 0, "…and costs ZERO API calls");
  }

  registerSurfaces([defineSurface({ key: `notion/${WS}/${ROOT}`, trust: "internal", subtree: true })]);
  applySubtreeSurfaceClaims();
  ok(
    notionTrustRoots().byWorkspace.get(WS)?.has(ROOT.replace(/-/g, "")) === true,
    "a `subtree: true` entry IS a trust root, canonicalised into the register",
  );
  {
    const t = treeParentOf(TREE);
    const self = await resolveNotionAncestorTrust(ROOT, WS, notionTrustRoots(), { parentOf: t.parentOf, cache: freshCache() });
    ok(self.trusted === true && self.reason === "self", "the declared page itself is trusted, with no I/O");
    const child = await resolveNotionAncestorTrust(LEAF, WS, notionTrustRoots(), { parentOf: t.parentOf, cache: freshCache() });
    ok(child.trusted === true && child.reason === "ancestor", "🔴 a page two levels under it is trusted through the walk — the OPE-492 behaviour, fed from the new source");
    ok(child.matchedRoot === ROOT.replace(/-/g, ""), "…and the matched root rides out for the auth stamp");
    const outside = await resolveNotionAncestorTrust(OUTSIDE, WS, notionTrustRoots(), { parentOf: t.parentOf, cache: freshCache() });
    ok(outside.trusted === false, "NEGATIVE CONTROL: a page under nothing declared is still untrusted");
  }

  registerSurfaces([]);
  ok(notionTrustRoots().byWorkspace.size === 0, "removing the entry removes the root (one declaration, one source)");

  let refused = false;
  registerSurfaces([defineSurface({ key: "slack/T0ACME/C0BOARD", trust: "internal", subtree: true })]);
  try {
    applySubtreeSurfaceClaims();
  } catch (e) {
    refused = e instanceof Error && e.message.includes("slack");
  }
  ok(refused, "🔴 `subtree: true` on a platform no bundle honours is a BOOT ERROR that NAMES the platform");

  let vendorRefused = false;
  try {
    registerSurfaces([defineSurface({ key: `notion/${WS}/not-a-page-id`, trust: "internal", subtree: true })]);
    applySubtreeSurfaceClaims();
  } catch (e) {
    vendorRefused = e instanceof NotionTrustConfigError;
  }
  ok(vendorRefused, "a subtree key whose last segment is not a PAGE ID throws NotionTrustConfigError at boot");

  _resetSurfacesForTest();
  _resetSubtreePlatformsForTest();
  _resetNotionTrustRootsForTest();
}

{
  _resetNotionTrustRootProbesForTest();
  const t = treeParentOf(TREE);
  const none = await resolveNotionDeliveryTrust(MID, WS, undefined, { parentOf: t.parentOf, cache: freshCache() });
  ok(none.trusted === false && none.reason === "no-roots", "no declared roots ⇒ no-roots");
  ok(t.calls() === 0, "🔴 no declared roots ⇒ ZERO API calls (the walk AND the probe are skipped)");
  ok(none.unreachableRoots === undefined, "no declared roots ⇒ nothing to report");
}
{
  _resetNotionTrustRootProbesForTest();
  const t = treeParentOf(TREE);
  const v = await resolveNotionDeliveryTrust(MID, WS, ROOTS, { parentOf: t.parentOf, cache: freshCache() });
  ok(v.trusted === true && v.reason === "ancestor", "a page under the declared root is trusted through the seam");
  ok(v.matchedRoot === ROOT.replace(/-/g, ""), "the seam carries the matched root out (this is the auth stamp)");
  ok(v.unreachableRoots === undefined, "a TRUSTED verdict runs no probe");
  ok(t.calls() === 1, "a trusted verdict costs the walk only — one hop, no probe call");
}
{
  _resetNotionTrustRootProbesForTest();
  const roots = prepareNotionTrustRoots([`notion/${WS}/${TEAMSPACE}`]);
  const t = treeParentOf(TREE);
  const v = await resolveNotionDeliveryTrust(MID, WS, roots, { parentOf: t.parentOf, cache: freshCache() });
  ok(v.trusted === false, "a teamspace root grants nothing (the walk never sees a teamspace parent)");
  ok(v.reason === "workspace-root", "…and the walk ends at the workspace, so the reason says so");
  ok(v.unreachableRoots?.length === 1, "🔴 the probe REPORTS the dead root — the finding is loud, not silent");
  ok(v.unreachableRoots?.[0] === TEAMSPACE.replace(/-/g, ""), "the report NAMES the root that cannot match");

  const firstCost = t.calls();
  const again = await resolveNotionDeliveryTrust(MID, WS, roots, { parentOf: t.parentOf, cache: freshCache() });
  const secondCost = t.calls() - firstCost;
  ok(again.unreachableRoots === undefined, "the SECOND delivery does not re-report the same root");
  ok(again.reason === "workspace-root", "…and it still walks — only the probe is skipped");
  ok(secondCost === firstCost - 1, "the second delivery pays the walk only — the probe is memoised per process");
}
{
  _resetNotionTrustRootProbesForTest();
  const t = treeParentOf(TREE);
  const v = await resolveNotionDeliveryTrust(OUTSIDE, WS, ROOTS, { parentOf: t.parentOf, cache: freshCache() });
  ok(v.trusted === false && v.reason === "workspace-root", "a page outside the declared tree is untrusted");
  ok(v.unreachableRoots === undefined, "🔴 a REAL page root is NOT reported — only a root Notion will not serve is");
}
{
  _resetNotionTrustRootProbesForTest();
  const t = treeParentOf({ [MID]: { kind: "page", pageId: ROOT } });
  const v = await resolveNotionDeliveryTrust(MID, WS, ROOTS, { parentOf: t.parentOf, cache: freshCache() });
  ok(v.trusted === true && v.reason === "ancestor", "🔴 an UNREADABLE declared root still matches at one hop");
  const found = await probeUnreachableNotionTrustRoots(WS, ROOTS, { parentOf: t.parentOf, cache: freshCache() });
  ok(found.length === 1 && found[0] === ROOT.replace(/-/g, ""), "the same root probes as unreachable — the report is a WARNING, not a withdrawal");
}
{
  _resetNotionTrustRootProbesForTest();
  let call = 0;
  const parentOf = async (): Promise<NotionParentLink> => {
    call++;
    if (call === 1) return { kind: "workspace" };
    throw new Error("notion is down");
  };
  const v = await resolveNotionDeliveryTrust(MID, WS, ROOTS, { parentOf, cache: freshCache() });
  ok(v.trusted === false && v.reason === "workspace-root", "a throwing probe leaves the walk's verdict intact");
  ok(v.unreachableRoots?.length === 1, "a throwing probe reports the root once — it never throws at the caller");
}

console.log(`✓ ${passed} notion ancestry-trust assertions passed`);

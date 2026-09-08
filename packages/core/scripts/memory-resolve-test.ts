
import { resolveMemoryPlan, surfaceProvider, type MemoryResolveConfig } from "../agent/memory/resolve.js";
import { getProvider, providerById, registerProvider, resetProvider, type MemoryProvider } from "../agent/memory/provider.js";
import {
  defineDomain,
  domainForChannel,
  criteriaDomain,
  assertChannelExclusivity,
  assertDomainsValid,
} from "../agent/memory/domain.js";
import { defineMemorySilo, assertSilosValid, type MemorySilo } from "../agent/memory/silo.js";
import { renderMemoryIndex } from "../agent/memory/listing.js";
import { siloTier } from "../agent/memory/store.js";
import type { SurfaceBinding, Trust } from "../agent/identity/binding.js";
import type { SessionMode } from "../agent/access/resolver.js";
import type { Partition } from "../agent/memory/partition.js";

delete process.env.OE_MEMORY_PROVIDER;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throws(fn: () => unknown, label: string): void {
  try {
    fn();
    console.error(`✗ ${label} (expected throw)`);
    process.exit(1);
  } catch {
    passed++;
  }
}

function binding(mode: SessionMode, trust: Trust): SurfaceBinding {
  return { org: "default", platform: "slack", workspace: "T", surface: "C", mode, visibility: "public", trust };
}
function partition(surface: string): Partition {
  const workspaceKey = "slack/T";
  const surfaceKey = `${workspaceKey}/${surface}`;
  return { org: "default", platform: "slack", workspace: "T", surface, workspaceKey, surfaceKey, key: surfaceKey };
}
const names = (rs: readonly { silo: MemorySilo }[]): string[] => rs.map((r) => r.silo.name).sort();

const txnSilo: MemorySilo = defineMemorySilo({ name: "txn", provider: "sqlite" });
const baselineSilo: MemorySilo = defineMemorySilo({ name: "baseline", provider: "sqlite", readOnly: true });
const notionRoSilo: MemorySilo = defineMemorySilo({ name: "nkb", description: "the team handbook", provider: "notion", container: "root", readOnly: true, skill: "notion" });
const orgBase: MemorySilo = defineMemorySilo({ name: "org-base", provider: "sqlite", readOnly: true });
const orgRw: MemorySilo = defineMemorySilo({ name: "org-rw", provider: "sqlite" });
const pubFaq: MemorySilo = defineMemorySilo({ name: "pub-faq", provider: "sqlite", readOnly: true });

const cfg: MemoryResolveConfig = {
  domains: [
    defineDomain({ name: "transactions", channels: ["slack/T/C_TXN"], memory: "txn" }),
    defineDomain({ name: "watercooler", channels: ["slack/T/C_CHAT"] }),
    defineDomain({ name: "readonly-dom", channels: ["slack/T/C_RO"], memory: "baseline" }),
    defineDomain({ name: "multi", channels: ["slack/T/C_MULTI"], memory: ["txn", "baseline"] }),
    defineDomain({ name: "multi2", channels: ["slack/T/C_MULTI2"], memory: ["baseline"] }),
    defineDomain({ name: "nkb-dom", channels: ["slack/T/C_NKB"], memory: "nkb" }),
    defineDomain({ name: "inc-ro", channels: ["slack/T/C_INC"], memory: "txn", includeOrg: "readonly" }),
    defineDomain({ name: "inc-inherit", channels: ["slack/T/C_INH"], includeOrg: "inherit" }),
    defineDomain({ name: "inc-dedup", channels: ["slack/T/C_DUP"], memory: ["org-rw"], includeOrg: "readonly" }),
    defineDomain({ name: "org", match: "org", memory: ["org-base", "org-rw"] }),
    defineDomain({ name: "public", match: "public", memory: "pub-faq" }),
    defineDomain({ name: "dm", match: "dm", includeOrg: "readonly" }),
  ],
  silos: [txnSilo, baselineSilo, notionRoSilo, orgBase, orgRw, pubFaq],
};

const mpim = resolveMemoryPlan(binding("mpim", "internal"), partition("C_TXN"), cfg);
ok(mpim.reads.length === 0 && mpim.writes.length === 0, "mpim → no memory");

const dmInt = resolveMemoryPlan(binding("dm", "internal"), partition("Duser"), cfg);
ok(dmInt.reads[0].silo.name === "@personal" && dmInt.reads[0].silo.provider === "sqlite", "dm → per-user personal silo pinned to DB");
ok(dmInt.writes.length === 1 && dmInt.writes[0].silo.name === "@personal" && dmInt.writes[0].readOnly === false, "dm → writes ONLY the personal silo (writable)");
ok(names(dmInt.reads).join(",") === ["@personal", "org-base", "org-rw"].join(","), "dm internal partner → personal + dm-shared org silos");
ok(dmInt.reads.filter((r) => r.silo.name.startsWith("org-")).every((r) => r.readOnly), "dm shared reads are forced read-only (incl. the natively-writable org-rw)");

const dmExt = resolveMemoryPlan(binding("dm", "external"), partition("Dstranger"), cfg);
ok(names(dmExt.reads).join(",") === ["@personal", "pub-faq"].join(","), "dm EXTERNAL partner → personal + PUBLIC reads (not org/dm-shared)");
ok(dmExt.writes.length === 1 && dmExt.writes[0].silo.name === "@personal", "dm external partner still writes only its own personal silo");

const dmBare = resolveMemoryPlan(binding("dm", "internal"), partition("Duser"), { domains: [], silos: [] });
ok(dmBare.reads.length === 1 && dmBare.reads[0].silo.name === "@personal", "dm with no dm/public pseudo-domain → personal only");

const ext = resolveMemoryPlan(binding("channel", "external"), partition("C_TXN"), cfg);
ok(names(ext.reads).join(",") === "pub-faq" && ext.writes.length === 0, "external channel in a domain → PUBLIC (read-only), NOT its internal domain");
ok(ext.reads[0].readOnly === true, "external → public reads are read-only (external never writes shared)");
ok(ext.reason.includes("public"), "external → reason names the public route");
const extNoPub: MemoryResolveConfig = { domains: cfg.domains.filter((d) => d.match !== "public"), silos: cfg.silos };
const extBare = resolveMemoryPlan(binding("channel", "external"), partition("C_TXN"), extNoPub);
ok(extBare.reads.length === 0 && extBare.writes.length === 0, "external + no public domain → NO memory");
ok(extBare.reason.includes("trust gate"), "external + no public → reason names the trust gate");

const txn = resolveMemoryPlan(binding("channel", "internal"), partition("C_TXN"), cfg);
ok(txn.reads.length === 1 && txn.writes.length === 1, "domain channel → reads + writes its silo");
ok(txn.reads[0].tier.kind === "silo" && txn.reads[0].tier.name === "txn", "silo tier keyed by SILO name (not domain)");
ok(names(txn.reads).join(",") === "txn", "domain channel ignores org unless includeOrg (single hop)");

const multi = resolveMemoryPlan(binding("channel", "internal"), partition("C_MULTI"), cfg);
ok(multi.reads.length === 2 && multi.writes.length === 1 && multi.writes[0].silo.name === "txn", "multi-source → reads both, writes only the writable");
const multi2 = resolveMemoryPlan(binding("channel", "internal"), partition("C_MULTI2"), cfg);
const baseTierA = multi.reads.find((r) => r.silo.name === "baseline")!.tier;
const baseTierB = multi2.reads[0].tier;
ok(baseTierA.kind === "silo" && baseTierB.kind === "silo" && baseTierA.name === baseTierB.name, "shared silo → SAME bucket across domains (one brain)");

const ro = resolveMemoryPlan(binding("channel", "internal"), partition("C_RO"), cfg);
ok(ro.reads.length === 1 && ro.writes.length === 0 && ro.reads[0].readOnly, "read-only silo → reads, never writes");

const group = resolveMemoryPlan(binding("channel", "internal"), partition("C_CHAT"), cfg);
ok(group.reads.length === 0 && group.writes.length === 0, "domain w/o silo → no memory (grouping only, no org fall-through)");

const incRo = resolveMemoryPlan(binding("channel", "internal"), partition("C_INC"), cfg);
ok(names(incRo.reads).join(",") === ["org-base", "org-rw", "txn"].join(","), "includeOrg readonly → own silo + org set");
ok(incRo.writes.length === 1 && incRo.writes[0].silo.name === "txn", "includeOrg readonly → org slice is read-only, only own silo writable");
const incInherit = resolveMemoryPlan(binding("channel", "internal"), partition("C_INH"), cfg);
ok(names(incInherit.reads).join(",") === ["org-base", "org-rw"].join(","), "includeOrg inherit → the org set, no own silo");
ok(incInherit.writes.length === 1 && incInherit.writes[0].silo.name === "org-rw", "includeOrg inherit → natively-writable org silo stays writable");
const incDup = resolveMemoryPlan(binding("channel", "internal"), partition("C_DUP"), cfg);
ok(incDup.reads.filter((r) => r.silo.name === "org-rw").length === 1, "includeOrg dedup → org-rw appears exactly once");
ok(incDup.writes.some((r) => r.silo.name === "org-rw"), "includeOrg dedup → the EXPLICIT (writable) entry wins over the readonly includeOrg copy");

const org = resolveMemoryPlan(binding("channel", "internal"), partition("C_RANDOM"), cfg);
ok(names(org.reads).join(",") === ["org-base", "org-rw"].join(","), "unassigned internal → org pseudo-domain silos");
ok(org.reads.find((r) => r.silo.name === "org-base")!.readOnly && !org.reads.find((r) => r.silo.name === "org-rw")!.readOnly, "org fallback respects each silo's own readOnly (not forced)");
ok(org.writes.length === 1 && org.writes[0].silo.name === "org-rw", "org fallback → writes the natively-writable silo");
const noOrg: MemoryResolveConfig = { domains: cfg.domains.filter((d) => d.match !== "org" && !d.includeOrg), silos: cfg.silos };
const orgless = resolveMemoryPlan(binding("channel", "internal"), partition("C_RANDOM"), noOrg);
ok(orgless.reads.length === 0 && orgless.writes.length === 0, "unassigned + no org domain → no memory");

{
  const threadPartition: Partition = {
    org: "default", platform: "discord", workspace: "G", surface: "T_THREAD",
    workspaceKey: "discord/G", surfaceKey: "discord/G/T_THREAD",
    domainKey: "slack/T/C_TXN",
    key: "discord/G/T_THREAD",
  };
  const viaParent = resolveMemoryPlan(binding("channel", "internal"), threadPartition, cfg);
  ok(viaParent.reads.length === 1 && viaParent.reads[0].tier.kind === "silo" && viaParent.reads[0].tier.name === "txn", "thread grain: domainKey (parent channel) resolves the parent's domain silo");
  const noParent = resolveMemoryPlan(binding("channel", "internal"), { ...threadPartition, domainKey: undefined }, cfg);
  ok(names(noParent.reads).join(",") === ["org-base", "org-rw"].join(","), "thread grain: no domainKey → falls back to surfaceKey (unassigned → org), today's behaviour");
}

throws(
  () => resolveMemoryPlan(binding("channel", "internal"), partition("C_TXN"), { domains: cfg.domains, silos: [] }),
  "referencing an undefined silo throws",
);

ok(domainForChannel("slack/T/C_TXN", cfg.domains)?.name === "transactions", "domainForChannel finds the explicit owner");
ok(domainForChannel("slack/T/C_NOPE", cfg.domains) === undefined, "domainForChannel → undefined when none (criteria domains never match a channel key)");
ok(criteriaDomain("org", cfg.domains)?.name === "org" && criteriaDomain("public", cfg.domains)?.name === "public", "criteriaDomain selects the right pseudo-domain");
ok(criteriaDomain("dm", [])  === undefined, "criteriaDomain → undefined when absent");

assertChannelExclusivity(cfg.domains);
ok(true, "exclusivity: disjoint domains pass (criteria domains skipped)");
throws(
  () => assertChannelExclusivity([defineDomain({ name: "a", channels: ["slack/T/C1"] }), defineDomain({ name: "b", channels: ["slack/T/C1"] })]),
  "exclusivity: a channel in two domains throws",
);

assertDomainsValid(cfg.domains);
ok(true, "validation: a valid domain set passes");
throws(() => assertDomainsValid([{ name: "both", channels: [], match: "org" } as never]), "validation: channels AND match → throws");
throws(() => assertDomainsValid([{ name: "neither" } as never]), "validation: neither channels nor match → throws");
throws(
  () => assertDomainsValid([defineDomain({ name: "o1", match: "org" }), defineDomain({ name: "o2", match: "org" })]),
  "validation: two domains with the same match → throws",
);
throws(
  () => assertDomainsValid([defineDomain({ name: "d", channels: ["slack/T/C"], includeOrg: "readonly" })]),
  "validation: includeOrg with no org domain → throws",
);
throws(
  () => assertDomainsValid([defineDomain({ name: "org", match: "org" }), defineDomain({ name: "public", match: "public", includeOrg: "readonly" })]),
  "validation: includeOrg on the public pseudo-domain → throws",
);
throws(
  () => assertDomainsValid([defineDomain({ name: "org", match: "org", includeOrg: "readonly" })]),
  "validation: includeOrg on the org pseudo-domain (self-ref) → throws",
);

assertDomainsValid([defineDomain({ name: "org", match: "org", admins: ["slack/T/U_ADMIN", "discord/300000000000000104"] })]);
ok(true, "validation: qualified admin keys on one roster (two platforms, one human) pass");
throws(
  () => assertDomainsValid([defineDomain({ name: "org", match: "org", admins: ["U_ADMIN"] })]),
  "validation: a BARE admin id → throws at config load (it can never match, so it must never load quietly)",
);
throws(
  () => assertDomainsValid([defineDomain({ name: "org", match: "org", admins: ["300000000000000104"] })]),
  "validation: a bare DIGIT-STRING admin id → throws (the exact shape a cross-platform digit-id collision needs)",
);
assertDomainsValid([defineDomain({ name: "eng", channels: ["slack/T/C"], admins: ["slack/T/U_ADMIN"] })]);
ok(true, "validation: a three-segment admin key on a TENANT-SCOPED platform validates (OPE-309 — it is the person, not a surface)");
throws(
  () => assertDomainsValid([defineDomain({ name: "eng", channels: ["slack/T/C"], admins: ["slack/U_ADMIN"] })]),
  "validation: a PRE-RUNG two-segment slack admin key → throws (it names no workspace, so it can never match)",
);

const multiIndex = renderMemoryIndex(multi.reads);
ok(multiIndex.includes("# Memory index") && multiIndex.includes("not** in your context"), "index: header + not-in-context note");
ok(multiIndex.includes("memory/txn/") && multiIndex.includes("`remember`"), "index: writable silo listed with its dir + remember hint");
ok(renderMemoryIndex([]).includes("No memory is configured"), "index: empty plan → 'no memory' note");
const nkb = resolveMemoryPlan(binding("channel", "internal"), partition("C_NKB"), cfg);
const nkbIndex = renderMemoryIndex(nkb.reads);
ok(nkbIndex.includes("source: Notion") && nkbIndex.includes("read-only cache") && nkbIndex.includes("the `notion` skill"), "index: read-only Notion silo → on-disk + update route via its skill");

{
  const notionSilo = { name: "notion-brain", provider: "notion", container: "root" };
  const writableNotion = renderMemoryIndex([{ silo: notionSilo, tier: siloTier(notionSilo.name), readOnly: false }]);
  ok(writableNotion.includes("APPEND-ONLY"), "index: writable Notion silo → named APPEND-ONLY, not plain writable");
  ok(writableNotion.includes("REFUSED and does NOT save"), "index: …and says an edit to an existing line does not save");
  const gh = { name: "repo-brain", provider: "github", container: "acme/brain" };
  const writableGit = renderMemoryIndex([{ silo: gh, tier: siloTier(gh.name), readOnly: false }]);
  ok(!writableGit.includes("APPEND-ONLY"), "index negative control: a writable github silo is NOT marked append-only");
}

const partialIndex = renderMemoryIndex(multi.reads, ["notion-kb"]);
ok(partialIndex.includes("Unavailable this session") && partialIndex.includes("**notion-kb** failed to load"), "index: failed silo → named under an unavailable section");
ok(partialIndex.includes("MISSING from disk right now, not empty"), "index: failed silo → the missing-vs-empty distinction is spelled out");
ok(partialIndex.includes("memory/txn/"), "index: surviving silos still listed alongside the failure note");
const allFailedIndex = renderMemoryIndex([], ["org-brain"]);
ok(allFailedIndex.includes("Unavailable this session") && !allFailedIndex.includes("No memory is configured"), "index: every silo failed → unavailable note, NOT the no-memory-configured lie");
ok(!renderMemoryIndex(multi.reads).includes("Unavailable"), "index: no failures → no unavailable section (default unchanged)");

ok(renderMemoryIndex(multi.reads, [], "file-tools") === multiIndex, "recall: the default IS 'file-tools' — the on-disk copy is byte-identical");
ok(multiIndex.includes("Read the relevant silo with your tools") && multiIndex.includes("read with file tools"), "recall/file-tools: the pre-OPE-121 wording is preserved verbatim");
const delegIndex = renderMemoryIndex(multi.reads, [], "agent");
ok(!delegIndex.includes("Read the relevant silo with your tools"), "recall/agent: a seat with no file tools is NOT told to use file tools");
ok(delegIndex.includes("NO file tools") && delegIndex.includes("`agent`") && delegIndex.includes("mode: \"sync\""), "recall/agent: names the delegation verb + the mode, at the point of need");
ok(delegIndex.includes("memory/txn/") && delegIndex.includes("delegating a lookup"), "recall/agent: still lists every silo path — they are what goes in the brief");
const noneIndex = renderMemoryIndex(multi.reads, [], "none");
ok(noneIndex.includes("CANNOT read these files") && noneIndex.includes("can't check memory"), "recall/none: a seat with neither file tools nor delegation is told to SAY SO, not to bluff");
ok(!noneIndex.includes("`agent`"), "recall/none: names no delegation verb it doesn't hold");

assertSilosValid(cfg.silos);
ok(true, "validation: a valid silo set passes");
throws(() => assertSilosValid([{ name: "empty" } as MemorySilo]), "validation: a silo with no provider throws");

{
  const fakeDb: MemoryProvider = { id: "sqlite", async readTier() { return {}; }, async ensureTier() { return {}; }, async writeTier() { return null; }, async deleteTier() {} };
  registerProvider(fakeDb);
  resetProvider();
  ok(surfaceProvider(binding("dm", "internal")).id === "sqlite", "surfaceProvider: a DM resolves the DB-pinned provider (dbProviderId), not the env-selected one");
  ok(surfaceProvider(binding("dm", "internal")).id === providerById("sqlite").id, "…the SAME provider personalSilo()'s pin would resolve for this DM's own memory");
  ok(surfaceProvider(binding("channel", "internal")).id === getProvider().id, "surfaceProvider: a channel keeps the env-selected singleton (no plan pin exists for it)");
  ok(surfaceProvider(binding("mpim", "internal")).id === getProvider().id, "…and so does mpim");
  ok(surfaceProvider(binding("channel", "internal")).id !== "sqlite", "…which is NOT the DB provider (the negative control for the DM assertion above)");
}

console.log(`✓ memory-resolve: ${passed} assertions passed`);

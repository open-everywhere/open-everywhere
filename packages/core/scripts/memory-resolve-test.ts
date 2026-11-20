// proves: MEM-01, MEM-03, MEM-05, MEM-06, MEM-09, MEM-21

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveMemoryPlan, surfaceProvider, type MemoryResolveConfig } from "../agent/memory/resolve.js";
import { MEMORY_PROVIDER_FLOOR, resolveMemoryProviderId } from "../agent/memory/backing-selection.js";
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
import { overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";

delete process.env.DATABASE_URL;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throwsWith(fn: () => unknown, fragment: string, label: string): void {
  let threw = false;
  let error: unknown;
  try {
    fn();
  } catch (err) {
    threw = true;
    error = err;
  }
  if (!threw) {
    console.error(`✗ ${label} (expected a throw, got none)`);
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(fragment)) {
    console.error(`✗ ${label} (threw, but not the refusal under test — expected "${fragment}", got: ${message})`);
    process.exit(1);
  }
  passed++;
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
    defineDomain({ name: "transactions", reach: ["slack/T/C_TXN"], memory: "txn" }),
    defineDomain({ name: "watercooler", reach: ["slack/T/C_CHAT"] }),
    defineDomain({ name: "readonly-dom", reach: ["slack/T/C_RO"], memory: "baseline" }),
    defineDomain({ name: "multi", reach: ["slack/T/C_MULTI"], memory: ["txn", "baseline"] }),
    defineDomain({ name: "multi2", reach: ["slack/T/C_MULTI2"], memory: ["baseline"] }),
    defineDomain({ name: "nkb-dom", reach: ["slack/T/C_NKB"], memory: "nkb" }),
    defineDomain({ name: "inc-ro", reach: ["slack/T/C_INC"], memory: "txn", includeOrg: "readonly" }),
    defineDomain({ name: "inc-inherit", reach: ["slack/T/C_INH"], includeOrg: "inherit" }),
    defineDomain({ name: "inc-dedup", reach: ["slack/T/C_DUP"], memory: ["org-rw"], includeOrg: "readonly" }),
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

throwsWith(
  () => resolveMemoryPlan(binding("channel", "internal"), partition("C_TXN"), { domains: cfg.domains, silos: [] }),
  'memory silo "txn" referenced by domain "transactions" is not defined',
  "referencing an undefined silo throws",
);

ok(domainForChannel("slack/T/C_TXN", cfg.domains)?.name === "transactions", "domainForChannel finds the explicit owner");
ok(domainForChannel("slack/T/C_NOPE", cfg.domains) === undefined, "domainForChannel → undefined when none (criteria domains never match a channel key)");
ok(criteriaDomain("org", cfg.domains)?.name === "org" && criteriaDomain("public", cfg.domains)?.name === "public", "criteriaDomain selects the right pseudo-domain");
ok(criteriaDomain("dm", [])  === undefined, "criteriaDomain → undefined when absent");

assertChannelExclusivity(cfg.domains);
ok(true, "exclusivity: disjoint domains pass (criteria domains skipped)");
throwsWith(
  () => assertChannelExclusivity([defineDomain({ name: "a", reach: ["slack/T/C1"] }), defineDomain({ name: "b", reach: ["slack/T/C1"] })]),
  '"slack/T/C1" is in the reach of both "a" and "b"',
  "exclusivity: a channel in two domains throws",
);

assertDomainsValid(cfg.domains);
ok(true, "validation: a valid domain set passes");
throwsWith(() => assertDomainsValid([{ name: "both", reach: [], match: "org" } as never]), '"both" must have EITHER a reach list OR match (criteria), not both', "validation: reach AND match → throws");
throwsWith(() => assertDomainsValid([{ name: "neither" } as never]), '"neither" must have EITHER a reach list OR match (criteria), not neither', "validation: neither channels nor match → throws");
throwsWith(
  () => assertDomainsValid([defineDomain({ name: "o1", match: "org" }), defineDomain({ name: "o2", match: "org" })]),
  'match "org" is claimed by both "o1" and "o2"',
  "validation: two domains with the same match → throws",
);
throwsWith(
  () => assertDomainsValid([defineDomain({ name: "d", reach: ["slack/T/C"], includeOrg: "readonly" })]),
  '"d" sets includeOrg but no { match: "org" } domain is defined',
  "validation: includeOrg with no org domain → throws",
);
throwsWith(
  () => assertDomainsValid([defineDomain({ name: "org", match: "org" }), defineDomain({ name: "public", match: "public", includeOrg: "readonly" })]),
  '"public" (match "public") must not set includeOrg',
  "validation: includeOrg on the public pseudo-domain → throws",
);
throwsWith(
  () => assertDomainsValid([defineDomain({ name: "org", match: "org", includeOrg: "readonly" })]),
  '"org" (match "org") must not set includeOrg (self-reference)',
  "validation: includeOrg on the org pseudo-domain (self-ref) → throws",
);

assertDomainsValid([defineDomain({ name: "org", match: "org", admins: ["slack/T/U_ADMIN", "discord/300000000000000104"] })]);
ok(true, "validation: qualified admin keys on one roster (two platforms, one human) pass");
throwsWith(
  () => assertDomainsValid([defineDomain({ name: "org", match: "org", admins: ["U_ADMIN"] })]),
  'lists admin "U_ADMIN", which is not a well-formed principal key',
  "validation: a BARE admin id → throws at config load (it can never match, so it must never load quietly)",
);
throwsWith(
  () => assertDomainsValid([defineDomain({ name: "org", match: "org", admins: ["300000000000000104"] })]),
  'lists admin "300000000000000104", which is not a well-formed principal key',
  "validation: a bare DIGIT-STRING admin id → throws (the exact shape a cross-platform digit-id collision needs)",
);
assertDomainsValid([defineDomain({ name: "eng", reach: ["slack/T/C"], admins: ["slack/T/U_ADMIN"] })]);
ok(true, "validation: a three-segment admin key on a TENANT-SCOPED platform validates (OPE-309 — it is the person, not a surface)");
throwsWith(
  () => assertDomainsValid([defineDomain({ name: "eng", reach: ["slack/T/C"], admins: ["slack/U_ADMIN"] })]),
  'lists admin "slack/U_ADMIN", which is not a well-formed principal key',
  "validation: a PRE-RUNG two-segment slack admin key → throws (it names no workspace, so it can never match)",
);

const multiIndex = renderMemoryIndex(multi.reads);
ok(multiIndex.includes("# Memory index") && multiIndex.includes("not** in your context"), "index: header + not-in-context note");
ok(multiIndex.includes("memory/txn/") && multiIndex.includes("EDITING"), "index: writable silo listed with its dir + the edit-is-the-save hint");

for (const route of ["file-tools", "agent", "work", "none"] as const) {
  const idx = renderMemoryIndex(multi.reads, [], route);
  ok(!idx.includes("remember"), `🔴 index/${route}: names NO \`remember\` tool — the verb was deleted, and a dead verb is how a save becomes prose`);
}
const writeFileToolsIndex = renderMemoryIndex(multi.reads, [], "file-tools");
ok(
  writeFileToolsIndex.includes("EDITING") && writeFileToolsIndex.includes("the host persists it when the turn ends"),
  "🔴 index/file-tools: the write path is the FILE EDIT, and the index says who persists it",
);
ok(writeFileToolsIndex.includes("Nothing is saved by saying it is"), "🔴 index/file-tools: …and says outright that prose saves nothing — the J2 false-save-claim in one sentence");
const writeAgentIndex = renderMemoryIndex(multi.reads, [], "agent");
ok(
  writeAgentIndex.includes("Open memory/txn/MEMORY.md with your file tools") && writeAgentIndex.includes("Reply with the exact line you wrote"),
  "🔴 index/agent: the delegation BRIEF names the file edit and the path, and asks the worker back for the line it wrote",
);
ok(
  writeAgentIndex.includes("Only after the worker reports the line it WROTE"),
  "🔴 index/agent: …and the seat's own ack waits on that report, not on the dispatch",
);
const writeNoneIndex = renderMemoryIndex(multi.reads, [], "none");
ok(
  writeNoneIndex.includes("CANNOT write these files") && writeNoneIndex.includes("never that you saved it"),
  "🔴 index/none: a seat with no file tools and no delegation is told to say it cannot save — it used to read the file-tools wording",
);
ok(!writeNoneIndex.includes("Start with"), "🔴 index/none: the entry line does NOT say 'Start with' — that instructs an open this seat cannot perform");
ok(writeNoneIndex.includes("The index entry is `memory/txn/MEMORY.md`"), "🔴 index/none: …but the path is still NAMED, so the seat can say which file it cannot reach");
ok(writeFileToolsIndex.includes("Start with `memory/txn/MEMORY.md`"), "🔴 index/file-tools/CONTROL: a seat that CAN open the file still reads 'Start with' — the fix is narrowed to the route that cannot");
ok(writeAgentIndex.includes("Start with `memory/txn/MEMORY.md`"), "🔴 index/agent/CONTROL: so does a delegating seat — it names the path in the brief");
ok(
  writeFileToolsIndex.includes("the one with the LATER date is the current value") && writeFileToolsIndex.includes("do not report the pair as a conflict"),
  "🔴 index/file-tools: the recall lead states that the newest statement of a fact is the current one",
);
for (const [route, idx] of [["file-tools", writeFileToolsIndex], ["agent", writeAgentIndex]] as const) {
  ok(
    idx.includes("SAME date, or either is undated") && idx.includes("say the files disagree rather than choosing one"),
    `🔴 index/${route}: …and a pair nothing orders is reported as a disagreement, never resolved by picking`,
  );
}
ok(
  writeAgentIndex.includes("the one with the LATER date is the current value"),
  "🔴 index/agent: a delegating seat reads the same rule — it resolves what the lookup brings back",
);
ok(
  writeFileToolsIndex.includes("CHANGE that line to the new value rather than adding a second one"),
  "🔴 index/file-tools: …and the save clause says to REWRITE the existing line, so the pair never forms",
);
ok(
  writeAgentIndex.includes("CHANGE that line to the new value instead of adding a second one"),
  "🔴 index/agent: the delegation BRIEF carries the same rewrite instruction — the worker does the writing",
);
ok(
  !writeNoneIndex.includes("LATER date"),
  "🔴 index/none: the newest-wins rule is ABSENT — a seat that cannot read has nothing to resolve",
);

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

  ok(!writableNotion.includes("CHANGE that line"), "🔴 index: an APPEND-ONLY silo is NOT told to rewrite an existing line — that edit is refused at persist");
  ok(writableGit.includes("CHANGE that line to the new value"), "🔴 index CONTROL: a backing that owns its files IS told to rewrite — the backing is what decided, not the route");
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
const HELD_LINE = "A fact this conversation already holds is not a lookup: something a person said earlier here, or your own earlier reply. Answer from it directly.";
const delegIndex = renderMemoryIndex(multi.reads, [], "agent");
ok(!delegIndex.includes("Read the relevant silo with your tools"), "recall/agent: a seat with no file tools is NOT told to use file tools");
ok(delegIndex.includes("NO file tools") && delegIndex.includes("`agent`") && delegIndex.includes("mode: \"sync\""), "recall/agent: names the delegation verb + the mode, at the point of need");
ok(delegIndex.includes("memory/txn/") && delegIndex.includes("delegating a lookup"), "recall/agent: still lists every silo path — they are what goes in the brief");
{
  const workIndex = renderMemoryIndex(multi.reads, [], "work");
  ok(!workIndex.includes("`agent`") && !workIndex.includes("mode: \"sync\""), "🔴 recall/work: a forwarding seat is never told to call `agent`, which its per-wake verdict refuses (OPE-2795)");
  ok(workIndex.includes("hand off a lookup: `work` with a `message`") && workIndex.includes(HELD_LINE), "🔴 recall/work: the lookup names `work`, after the held-in-conversation carve-out (OPE-2795)");
  ok(workIndex.includes("hand it off THIS turn — `work` with a `message` of exactly this shape") && workIndex.includes("Open memory/txn/MEMORY.md with your file tools"), "🔴 recall/work: the save names `work` and carries the same brief a worker writes from (OPE-2795)");
  ok(workIndex.includes("Only after the worker reports the line it WROTE") && workIndex.includes("arrives as the job's result on a later message"), "🔴 recall/work: …and the seat says Saved only after the job's result, which `work` returns on a later message");
  ok(workIndex.includes("CHANGE that line to the new value instead of adding a second one") && workIndex.includes("the one with the LATER date is the current value"), "recall/work: the rewrite and newest-wins rules ride the `work` route as they ride `agent`");
  ok(delegIndex.includes("`agent` with `mode: \"sync\"`"), "recall/agent/CONTROL: the work session's own route still names `agent`, which its verdict admits");
}
const noneIndex = renderMemoryIndex(multi.reads, [], "none");
ok(noneIndex.includes("CANNOT read these files") && noneIndex.includes("can't check memory"), "recall/none: a seat with neither file tools nor delegation is told to SAY SO, not to bluff");
ok(!noneIndex.includes("`agent`"), "recall/none: names no delegation verb it doesn't hold");

const HELD = "A fact this conversation already holds is not a lookup: something a person said earlier here, or your own earlier reply. Answer from it directly.";
ok(delegIndex.includes(HELD), "🔴 recall/agent: a fact said earlier in this conversation is answered directly, not looked up (OPE-2601)");
ok(!/To recall anything from memory, delegate/u.test(delegIndex) && delegIndex.includes("To recall anything else from memory, delegate a lookup"), "🔴 recall/agent: the delegated lookup is scoped to what the conversation does NOT hold (OPE-2601)");
ok(delegIndex.indexOf(HELD) < delegIndex.indexOf("delegate a lookup"), "recall/agent: the carve-out is read BEFORE the lookup instruction it limits");
ok(noneIndex.includes(HELD) && noneIndex.includes("in the files and nowhere else"), "🔴 recall/none: a seat that cannot read the files still answers what the conversation holds, and refuses only a files-only question (OPE-2601)");
ok(!multiIndex.includes(HELD), "recall/file-tools: the carve-out does not ride the file-tools lead (its bytes are the on-disk copy)");

for (const rel of ["agent/instructions.md", "packages/create/template/agent/instructions.md"]) {
  const md = readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");
  const memory = md.slice(md.indexOf("\n## Memory\n"), md.indexOf("\n## ", md.indexOf("\n## Memory\n") + 1));
  const rule = memory.indexOf("lookup first: search your memory, THEN reply");
  const carve = memory.indexOf("**A fact this conversation already holds is not a lookup.**");
  ok(rule >= 0 && carve > rule, `🔴 ${rel}: § Memory limits "memory lookup first" with the held-in-conversation carve-out, after the rule (OPE-2607)`);
  ok(/answer from that directly, in this\s+turn/u.test(memory) && /the save does not make the\s+conversation a less reliable source/u.test(memory), `🔴 ${rel}: the carve-out holds for a fact this seat also saved (OPE-2607)`);
}

assertSilosValid(cfg.silos);
ok(true, "validation: a valid silo set passes");
throwsWith(() => assertSilosValid([{ name: "empty" } as MemorySilo]), '"empty" has no provider', "validation: a silo with no provider throws");

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

{
  const r = (env: NodeJS.ProcessEnv, selected?: string) => resolveMemoryProviderId(env, selected);
  ok(r({}) === MEMORY_PROVIDER_FLOOR, "backing: nothing set ⇒ the git floor");
  ok(r({ DATABASE_URL: "postgres://x/y" }) === "postgres", "backing: a bare DATABASE_URL ⇒ postgres, with no selector set");
  ok(r({ DATABASE_URL: "  " }) === MEMORY_PROVIDER_FLOOR, "backing: a blank DATABASE_URL is not a database");
  ok(r({ DATABASE_URL: "postgres://x/y" }, "git") === "git", "backing: the selector WINS over the derived default");
  ok(r({}, "postgres") === "postgres", "backing: an explicit postgres selector needs no DATABASE_URL to be the answer");
  ok(r({}, " postgres ") === "postgres", "backing: the selector is trimmed");
  overrideSettingsForTest({ memory: { provider: "sqlite" } });
  ok(r({ DATABASE_URL: "postgres://x/y" }) === "sqlite", "backing: the registered memory.provider is the default selector");
  resetSettingsForTest();
  ok(r({ OE_MEMORY_PROVIDER: "sqlite" }) === MEMORY_PROVIDER_FLOOR, "🔴 backing: a stale OE_MEMORY_PROVIDER in the env is not read (OPE-2650)");
}

{
  const prior = { url: process.env.DATABASE_URL };
  try {
    resetSettingsForTest();
    process.env.DATABASE_URL = "postgres://u:p@h/db";
    resetProvider();
    let message = "";
    try {
      getProvider();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    ok(message.includes("DATABASE_URL"), "derived backing + no client: the throw names DATABASE_URL as the cause");
    ok(!message.includes("memory.provider"), "…and NOT a selector the operator never set");
    overrideSettingsForTest({ memory: { provider: "postgres" } });
    resetProvider();
    let explicitMessage = "";
    try {
      getProvider();
    } catch (err) {
      explicitMessage = err instanceof Error ? err.message : String(err);
    }
    ok(explicitMessage.includes('memory.provider is "postgres"'), "an EXPLICIT selector + no client: the throw names the selector");
  } finally {
    if (prior.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prior.url;
    resetSettingsForTest();
    resetProvider();
  }
}

console.log(`✓ memory-resolve: ${passed} assertions passed`);

// proves: SET-098

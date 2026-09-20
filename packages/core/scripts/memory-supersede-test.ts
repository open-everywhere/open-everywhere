import { supersedeUnderSection, sectionBullets } from "../agent/memory/markdown.js";
import { enrichmentSignatureOf } from "../agent/memory/dream/learn.js";
import { seedFor } from "../agent/memory/layout.js";
import { siloTier, WORKSPACE, SURFACE, type Tier } from "../agent/memory/store.js";
import type { Partition } from "../agent/memory/partition.js";

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  n++;
}

const SEED = "# Recurring workflows (auto-learned)\n\n## Recurring\n(none yet)\n";
const bySignature = (bullet: string) => (existing: string): boolean => {
  const key = enrichmentSignatureOf(bullet);
  return key !== null && enrichmentSignatureOf(existing) === key;
};
function save(content: string, bullet: string): { content: string; superseded: string | null } {
  return supersedeUnderSection(content, "Recurring", bullet, bySignature(bullet));
}

const DEPLOY_3 = "- 2026-09-18: recurring workflow — deploy site staging (seen 3×) [[MEMORY]]";
const DEPLOY_7 = "- 2026-09-19: recurring workflow — deploy site staging (seen 7×) [[MEMORY]]";

{
  const first = save(SEED, DEPLOY_3);
  ok(first.superseded === null, "first save of a signature supersedes nothing");

  const second = save(first.content, DEPLOY_7);
  ok(second.superseded === DEPLOY_3, "🔴 the second save reports the exact line it replaced");

  const bullets = sectionBullets(second.content, "Recurring");
  ok(bullets.length === 1, `🔴 a second save of the same subject leaves ONE line (found ${bullets.length})`);
  ok(bullets[0] === DEPLOY_7, "🔴 …and that one line carries the NEW value");
  ok(!second.content.includes("seen 3×"), "🔴 …with the superseded value gone from the file entirely");

  const third = save(second.content, "- 2026-09-20: recurring workflow — deploy site staging (seen 9×) [[MEMORY]]");
  ok(sectionBullets(third.content, "Recurring").length === 1, "🔴 a third save still leaves ONE line — the stack never starts");
  ok(third.superseded === DEPLOY_7, "…and it replaced the second value, not the first");
}

{
  const withDeploy = save(SEED, DEPLOY_3).content;
  const other = save(withDeploy, "- 2026-09-19: recurring workflow — rotate signing keys (seen 3×) [[MEMORY]]");
  ok(other.superseded === null, "🔴 a different subject supersedes nothing");

  const bullets = sectionBullets(other.content, "Recurring");
  ok(bullets.length === 2, `🔴 a different subject still APPENDS (found ${bullets.length} bullets, want 2)`);
  ok(bullets[0] === DEPLOY_3 && bullets[1].includes("rotate signing keys"), "…in append order, oldest first");
}

{
  const pairs: readonly (readonly [string, string])[] = [
    ["- 2026-01-01: recurring workflow — deploy site staging (seen 3×) [[MEMORY]]", "- 2026-02-01: recurring workflow — deploy production site (seen 3×) [[MEMORY]]"],
    ["- 2026-01-01: recurring workflow — rotate keys (seen 3×) [[MEMORY]]", "- 2026-02-01: recurring workflow — rotate certs (seen 3×) [[MEMORY]]"],
    ["- 2026-01-01: recurring workflow — invoices report weekly (seen 3×) [[MEMORY]]", "- 2026-02-01: recurring workflow — refunds report weekly (seen 3×) [[MEMORY]]"],
  ];
  for (const [a, b] of pairs) {
    const both = save(save(SEED, a).content, b);
    ok(both.superseded === null, `🔴 near-miss workflows are NOT one subject: "${enrichmentSignatureOf(a)}" vs "${enrichmentSignatureOf(b)}"`);
    ok(sectionBullets(both.content, "Recurring").length === 2, "🔴 …so BOTH durable notes survive — a word-overlap match would have deleted the first");
  }
}

{
  const fact = "- 2026-09-18: the team deploys on Tuesday [[deploy]]";
  const fact2 = "- 2026-09-19: the team deploys with argocd [[deploy]]";
  ok(enrichmentSignatureOf(fact) === null, "🔴 a distilled fact bullet has NO signature key");
  ok(enrichmentSignatureOf(DEPLOY_3) === "deploy site staging", "CONTROL: a counter-style bullet DOES yield its signature");
  const next = save(save(SEED, fact).content, fact2);
  ok(next.superseded === null, "🔴 two distilled facts never supersede each other — the host cannot tell they are one fact");
  ok(sectionBullets(next.content, "Recurring").length === 2, "…so both stand, and the newest-wins rule in the index resolves them");
}

{
  const always = (): boolean => true;
  const onPlaceholder = supersedeUnderSection(SEED, "Recurring", "- new", always);
  ok(onPlaceholder.superseded === null, "🔴 the `(none yet)` placeholder is not a bullet and is never overwritten");
  ok(!onPlaceholder.content.includes("(none yet)\n- new"), "…it is replaced by the append path, as upsertUnderSection does");

  const withPointer = "# Memory\n\n## Notes\n- a: one\n- b: two\n- c: three\n_Full history: [[notes]]_\n";
  const mid = supersedeUnderSection(withPointer, "Notes", "- b: TWO", (l) => l.startsWith("- b:"));
  ok(mid.superseded === "- b: two", "the primitive replaces the matched bullet");
  ok(sectionBullets(mid.content, "Notes").join("|") === "- a: one|- b: TWO|- c: three", "🔴 …IN PLACE — the replacement keeps the line's position, it is not moved to the end");
  ok(mid.content.includes("_Full history: [[notes]]_"), "🔴 the full-history pointer is not a bullet and survives untouched");

  const other = "# Memory\n\n## Notes\n- a: one\n\n## Decisions\n- d: kept\n";
  ok(supersedeUnderSection(other, "Notes", "- a: ONE", always).content.includes("## Decisions\n- d: kept"), "a later, unrelated section is byte-identical");
  ok(supersedeUnderSection(other, "Notes", "- x", () => false).superseded === null, "a predicate that matches nothing falls through to the append path");
  ok(supersedeUnderSection(other, "Missing section", "- x", always).superseded === null, "an absent section appends a new one rather than matching");

  const twoSections = "# Memory\n\n## Notes\n- a: one\n\n## Decisions\n- a: one\n";
  const scopedHit = supersedeUnderSection(twoSections, "Decisions", "- a: TWO", always);
  ok(sectionBullets(scopedHit.content, "Notes").join("") === "- a: one", "🔴 the Notes copy is untouched — the primitive never reaches outside its own section");
  ok(sectionBullets(scopedHit.content, "Decisions").join("") === "- a: TWO", "…and the Decisions copy was the one rewritten");
}

{
  const p: Partition = { org: "acme", platform: "slack", workspace: "T1", surface: "C1", workspaceKey: "slack/T1", surfaceKey: "slack/T1/C1", key: "slack/T1/C1" };
  const tiers: readonly Tier[] = [siloTier("brain"), WORKSPACE, SURFACE];
  for (const tier of tiers) {
    const body = seedFor(p, tier)["MEMORY.md"];
    ok(body.includes("State each fact ONCE"), `🔴 seed/${tier.kind}: the seeded MEMORY.md tells a freehand writer to state a fact once`);
    ok(body.includes("EDIT that line"), `🔴 seed/${tier.kind}: …and to rewrite the existing line rather than add a second`);
    ok(body.includes("the one with the LATER date is the current one"), `🔴 seed/${tier.kind}: …and which line wins when two already state one fact`);
    ok(body.includes("say the files disagree rather than choosing one"), `🔴 seed/${tier.kind}: …and to say so when NOTHING orders the pair — a same-date or undated pair has no newest`);
  }
}

console.log(`\n✓ memory supersede (no update-stacking): ${n} assertions passed\n`);

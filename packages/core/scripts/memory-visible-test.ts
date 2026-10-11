import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-memory-visible-"));
process.env.OE_SQLITE_PATH = join(tmp, "mem.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
const { providerById } = await import("../agent/memory/provider.js");
const { SURFACE, siloTier } = await import("../agent/memory/store.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { bulletSha256, removeBulletLinesBySha } = await import("../agent/memory/purge-redaction.js");
const { memoryItemsOf, editRefusal, replaceBulletLine, isLineDigest } = await import("../agent/memory/visible.js");
const { buildHomeView, runHomeAction, homeDomainsFor } = await import("../agent/home/home-view.js");
const { MEMORY_HOME_ACTIONS } = await import("../agent/home/memory-home.js");
const { writeMemoryTier, registerMemoryWriteObserver, _resetMemoryWriteObservers, _setMemoryWriteObserverBudgetMsForTest } = await import("../agent/memory/write-road.js");
type HomeViewer = import("../agent/home/home-view.js").HomeViewer;
type Partition = import("../agent/memory/partition.js").Partition;
type Domain = import("../agent/memory/domain.js").Domain;

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    removeTempDir(tmp);
    process.exit(1);
  }
  n++;
}

const PLATFORM_DOMAIN: Domain = { name: "platform", title: "Platform team", reach: ["slack/T1/CPLAT"], memory: "platform-brain" };
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [PLATFORM_DOMAIN],
  loadSilos: () => [{ name: "platform-brain", provider: "sqlite", description: "how the platform team works" }],
  domainsForSurface: () => [],
});

function dmPartition(surface: string): Partition {
  return {
    org: "default",
    platform: "slack",
    workspace: "T1",
    surface,
    workspaceKey: "slack/T1",
    surfaceKey: `slack/T1/${surface}`,
    domainKey: `slack/T1/${surface}`,
    key: `slack/T1/${surface}`,
  };
}

const ALICE = dmPartition("DALICE");
const BOB = dmPartition("DBOB");
const sqlite = providerById("sqlite");

const FACT_TEA = "- Alice drinks green tea, never coffee";
const FACT_LEEDS = "- Alice lives in Leeds";
const FACT_NESTED = "  - Alice's manager is Priya";
const BOB_SECRET = "- Bob is on leave until March";

await sqlite.writeTier(
  ALICE,
  SURFACE,
  {
    "MEMORY.md": `# Personal memory\n\n## People / ownership\n${FACT_TEA}\n${FACT_LEEDS}\n${FACT_NESTED}\n\n## Decisions\n- (none yet)\n\nAlice prefers short answers, written as prose.\n`,
    "people.md": `# People\n\n${FACT_TEA}\n`,
  },
  "seed",
);
await sqlite.writeTier(BOB, SURFACE, { "MEMORY.md": `# Personal memory\n\n## Notes\n${BOB_SECRET}\n` }, "seed");
await sqlite.writeTier(
  dmPartition("ignored"),
  siloTier("platform-brain"),
  { "MEMORY.md": "# Memory silo\n\n## Decisions\n- Deploys freeze on Fridays\n- The on-call rota lives in PagerDuty\n" },
  "seed",
);

function viewer(personal: Partition | undefined, trust: "internal" | "external", domains = [{ domain: PLATFORM_DOMAIN, rooms: [{ surfaceKey: "slack/T1/CPLAT", nativeId: "CPLAT" }] }]): HomeViewer {
  return {
    org: "default",
    platform: "slack",
    workspace: "T1",
    principalId: personal === BOB ? "slack/T1/UBOB" : "slack/T1/UALICE",
    ...(personal ? { personal } : {}),
    trust,
    domains: homeDomainsFor(trust, domains),
  };
}

async function aliceFiles(): Promise<Record<string, string>> {
  return sqlite.readTier(ALICE, SURFACE);
}

console.log("§1 the item model");
{
  const items = memoryItemsOf(await aliceFiles());
  ok(items.length === 3, `three distinct facts, not four lines and not the placeholder (got ${items.length})`);
  const tea = items.find((i) => i.text.includes("green tea"))!;
  ok(tea.files.length === 2 && tea.files[0] === "MEMORY.md" && tea.files[1] === "people.md", "a fact in the index AND its topic file is ONE item naming both files");
  ok(tea.section === "People / ownership", "the item carries the heading it sits under");
  ok(!items.some((i) => i.text === "(none yet)"), "the seeded placeholder is not a fact");
  const nested = items.find((i) => i.text.includes("Priya"))!;
  ok(nested.sha256 === bulletSha256(FACT_NESTED), "an INDENTED line's digest keeps its indentation — the form the remover compares");
  ok(removeBulletLinesBySha(`x\n${FACT_NESTED}\ny`, [nested.sha256]).removed === 1, "…so the remover finds it by that digest");
  ok(isLineDigest(tea.sha256) && !isLineDigest("ABC") && !isLineDigest(tea.sha256.toUpperCase()), "a ref is accepted only as a lowercase 64-hex digest");
  ok(editRefusal("") !== undefined && editRefusal("a\nb") !== undefined && editRefusal("x".repeat(1001)) !== undefined && editRefusal("fine") === undefined, "an edit must be one non-blank line within the cap");
  const r = replaceBulletLine(`${FACT_NESTED}\n`, nested.sha256, "Alice's manager is Sam");
  ok(r.replaced === 1 && r.content === "  - Alice's manager is Sam\n", "a replacement keeps the line's marker and indentation");
}

console.log("§2 forget from the page");
{
  const tea = memoryItemsOf(await aliceFiles()).find((i) => i.text.includes("green tea"))!;
  const before = (await readAudit({ org: "default", action: "memory.purge" })).length;
  const res = await runHomeAction(viewer(ALICE, "internal"), MEMORY_HOME_ACTIONS.forget, tea.sha256);
  ok(res.notice.startsWith("Forgotten"), `the person is told it is gone (got "${res.notice}")`);
  const files = await aliceFiles();
  ok(!files["MEMORY.md"]!.includes("green tea") && !files["people.md"]!.includes("green tea"), "the line is gone from the index AND the topic file");
  ok(files["MEMORY.md"]!.includes("Leeds"), "the other lines stay");
  const purges = await readAudit({ org: "default", action: "memory.purge" });
  ok(purges.length === before + 1, "exactly one memory.purge row");
  const row = purges[purges.length - 1]!;
  ok(row.detail?.via === "slack-app-home", "the row names the self-service door");
  ok(row.principalId === "slack/T1/UALICE", "the row names the person who forgot");
  ok(JSON.stringify(row.detail?.bullets) === JSON.stringify([{ sha256: tea.sha256, chars: tea.chars }]), "the row carries the digest and length");
  const writes = await readAudit({ org: "default", action: "memory.write" });
  ok(writes.some((w) => w.detail?.road === "purge" && w.surface === "DALICE"), "the one road wrote its memory.write row beside it");

  const again = await runHomeAction(viewer(ALICE, "internal"), MEMORY_HOME_ACTIONS.forget, tea.sha256);
  ok(again.notice.includes("nothing to forget"), "a second click finds nothing");
  ok((await readAudit({ org: "default", action: "memory.purge" })).length === before + 1, "…and writes no second purge row");
}

console.log("§3 edit from the page");
{
  const leeds = memoryItemsOf(await aliceFiles()).find((i) => i.text.includes("Leeds"))!;
  const refused = await runHomeAction(viewer(ALICE, "internal"), MEMORY_HOME_ACTIONS.edit, leeds.sha256, "two\nlines");
  ok(refused.notice.includes("one line"), "a multi-line edit is refused with the reason");
  ok((await aliceFiles())["MEMORY.md"]!.includes("Alice lives in Leeds"), "…and nothing changed");

  const res = await runHomeAction(viewer(ALICE, "internal"), MEMORY_HOME_ACTIONS.edit, leeds.sha256, "Alice lives in York");
  ok(res.notice.startsWith("Saved"), `the person is told it saved (got "${res.notice}")`);
  const files = await aliceFiles();
  ok(files["MEMORY.md"]!.includes("- Alice lives in York") && !files["MEMORY.md"]!.includes("Leeds"), "the line now says the new words");
  const writes = await readAudit({ org: "default", action: "memory.write" });
  const row = writes.filter((w) => w.detail?.road === "self-edit").pop();
  ok(row !== undefined, "the edit wrote a memory.write row on road self-edit");
  const edited = row?.detail?.edited as { from?: { sha256?: string }; to?: { sha256?: string } } | undefined;
  ok(edited?.from?.sha256 === leeds.sha256 && edited?.to?.sha256 === bulletSha256("- Alice lives in York"), "…carrying the before and after digests");
  ok(row?.detail?.via === "slack-app-home" && row?.principalId === "slack/T1/UALICE", "…the door and the person");

  const same = await runHomeAction(viewer(ALICE, "internal"), MEMORY_HOME_ACTIONS.edit, bulletSha256("- Alice lives in York"), "Alice lives in York");
  ok(same.notice.startsWith("Nothing changed"), "saving the same words changes nothing");
}

console.log("§4 a forged digest reaches only the viewer's own memory");
{
  const bobSha = bulletSha256(BOB_SECRET);
  const forget = await runHomeAction(viewer(ALICE, "internal"), MEMORY_HOME_ACTIONS.forget, bobSha);
  const edit = await runHomeAction(viewer(ALICE, "internal"), MEMORY_HOME_ACTIONS.edit, bobSha, "Bob quit");
  ok(forget.notice.includes("nothing to forget") && edit.notice.includes("nothing to edit"), "Alice's page cannot name a line of Bob's");
  ok((await sqlite.readTier(BOB, SURFACE))["MEMORY.md"]!.includes(BOB_SECRET.slice(2)), "Bob's memory is untouched");
  const notDigest = await runHomeAction(viewer(ALICE, "internal"), MEMORY_HOME_ACTIONS.forget, "../../etc");
  ok(notDigest.notice.includes("nothing to forget"), "a ref that is not a digest is refused");
}

console.log("§5 export");
{
  const res = await runHomeAction(viewer(ALICE, "internal"), MEMORY_HOME_ACTIONS.exportAll);
  ok(res.file !== undefined && res.file.filename.endsWith(".md"), "export hands over a Markdown file");
  ok(res.file!.content.includes("Alice lives in York") && res.file!.content.includes("Priya"), "…holding every line");
  ok(res.file!.content.includes("Alice prefers short answers, written as prose."), "…and the PROSE outside any bullet — the export is every file, verbatim");
  ok(!res.file!.content.includes("Bob"), "…and nothing of anyone else's");
  const rows = await readAudit({ org: "default", action: "memory.export" });
  ok(rows.length === 1 && rows[0]!.detail?.items === 2 && typeof rows[0]!.detail?.sha256 === "string", "one memory.export row with the count and a digest");
}

console.log("§6 the page and the trust gate");
{
  const flat = (v: Awaited<ReturnType<typeof buildHomeView>>) => v.flatMap((s) => s.blocks);
  const member = flat(await buildHomeView(viewer(ALICE, "internal")));
  const personalItems = member.filter((b) => b.kind === "item" && b.ref !== undefined);
  ok(personalItems.length === 2, "the member sees their two remaining lines, each with a ref");
  ok(personalItems.every((b) => b.kind === "item" && b.actions.map((a) => a.id).join(",") === "memory.edit,memory.forget"), "…each offering Edit and Forget");
  ok(member.some((b) => b.kind === "item" && b.text === "Deploys freeze on Fridays" && b.actions.length === 0), "the member sees their domain's lines, read-only");
  ok(member.some((b) => b.kind === "room" && b.room.nativeId === "CPLAT"), "…and the channel to ask in");
  const ordered = member.map((b) => (b.kind === "heading" ? b.text : "")).filter(Boolean);
  ok(ordered.indexOf("What I remember about you") < ordered.indexOf("What your domains know"), "personal memory renders before the domain section");

  const guest = flat(await buildHomeView(viewer(ALICE, "external")));
  ok(!guest.some((b) => b.kind === "item" && b.text.includes("Deploys")), "a GUEST sees no domain line, though the surface handed over a membership");
  ok(guest.some((b) => b.kind === "note" && b.text.includes("full members")), "…and is told why");
  ok(homeDomainsFor("external", [{ domain: PLATFORM_DOMAIN, rooms: [{ surfaceKey: "slack/T1/CPLAT", nativeId: "CPLAT" }] }]).length === 0, "the gate drops every membership for an external viewer");
  ok(homeDomainsFor("internal", [{ domain: { name: "bare", reach: ["slack/T1/CX"] }, rooms: [{ surfaceKey: "slack/T1/CX", nativeId: "CX" }] }]).length === 0, "a domain with no memory is not listed");

  const lost = flat(await buildHomeView(viewer(undefined, "internal")));
  ok(lost.some((b) => b.kind === "note" && b.text.includes("could not open")), "a viewer whose DM could not be resolved is told so — not shown an empty memory");
}

console.log("§7 the write road notifies observers of silo writes only");
{
  const seen: string[] = [];
  registerMemoryWriteObserver("test", async (e) => {
    seen.push(`${e.org}:${e.silo}`);
  });
  registerMemoryWriteObserver("thrower", async () => {
    throw new Error("vendor down");
  });
  const silo = { name: "platform-brain", provider: "sqlite" };
  const r1 = await writeMemoryTier({ provider: sqlite, partition: dmPartition("ignored"), tier: siloTier("platform-brain"), files: { "MEMORY.md": "# x\n- one more\n" }, message: "t", silo, road: "session-persist" });
  ok(r1.changed, "a throwing observer does not fail the write");
  ok(seen.join() === "default:platform-brain", "a silo content write notifies with the org and silo — and nothing else");
  await writeMemoryTier({ provider: sqlite, partition: ALICE, tier: SURFACE, files: { "MEMORY.md": "# p\n- personal\n" }, message: "t", road: "session-persist" });
  await writeMemoryTier({ provider: sqlite, partition: dmPartition("ignored"), tier: siloTier("platform-brain"), files: { "STATUS.md": "board" }, message: "t", silo, road: "status-board", kind: "operational" });
  ok(seen.length === 1, "a personal write and an operational write notify nobody");
  await writeMemoryTier({ provider: sqlite, partition: dmPartition("ignored"), tier: siloTier("platform-brain"), files: { "MEMORY.md": "# x\n- one more\n" }, message: "t", silo, road: "session-persist" });
  ok(seen.length === 1, "a no-op write notifies nobody");

  registerMemoryWriteObserver("hung", () => new Promise<void>(() => {}));
  _setMemoryWriteObserverBudgetMsForTest(200);
  const started = Date.now();
  let guard: ReturnType<typeof setTimeout> | undefined;
  const bounded = await Promise.race([
    writeMemoryTier({ provider: sqlite, partition: dmPartition("ignored"), tier: siloTier("platform-brain"), files: { "MEMORY.md": "# x\n- one more\n- and another\n" }, message: "t", silo, road: "session-persist" }),
    new Promise<"held">((resolve) => {
      guard = setTimeout(() => resolve("held"), 5_000);
    }),
  ]);
  clearTimeout(guard);
  ok(bounded !== "held" && bounded.changed, "a never-settling observer cannot hold the write past its budget");
  ok(Date.now() - started < 2_000, `…the write returned within the budget plus a margin (${Date.now() - started} ms)`);
  _setMemoryWriteObserverBudgetMsForTest();
  _resetMemoryWriteObservers();
}

console.log("§8 no audit row holds a remembered line");
{
  const all = JSON.stringify(await readAudit({ org: "default" }));
  for (const needle of ["green tea", "Leeds", "York", "Priya", "on leave"]) ok(!all.includes(needle), `no audit row carries "${needle}"`);
}

removeTempDir(tmp);
console.log(`\n✓ memory-visible: ${n} assertions passed`);

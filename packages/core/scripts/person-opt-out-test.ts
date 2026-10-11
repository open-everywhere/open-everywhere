import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-person-opt-out-"));
process.env.OE_SQLITE_PATH = join(tmp, "opt.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
const { providerById } = await import("../agent/memory/provider.js");
const { SURFACE, siloTier } = await import("../agent/memory/store.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { getOperationalStore, registerOperationalStore, resetOperationalStore } = await import("../agent/operational/provider.js");
const { writeMemoryTier } = await import("../agent/memory/write-road.js");
const { readPersonOptOut, OPT_OUT_MEMORY_ROADS } = await import("../agent/identity/person-opt-out.js");
const { parseOeCommandTokens, runOeCommand, renderHelp } = await import("../agent/commands/core.js");
const { buildHomeView, runHomeAction } = await import("../agent/home/home-view.js");
const { OPT_OUT_HOME_ACTIONS } = await import("../agent/home/opt-out-home.js");
type Partition = import("../agent/memory/partition.js").Partition;
type SurfaceBinding = import("../agent/identity/binding.js").SurfaceBinding;
type HomeViewer = import("../agent/home/home-view.js").HomeViewer;
type MemoryWriteRoad = import("../agent/memory/write-road.js").MemoryWriteRoad;

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    removeTempDir(tmp);
    process.exit(1);
  }
  n++;
}

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [{ name: "team-brain", provider: "sqlite", description: "a team's memory" }],
  domainsForSurface: () => [],
});

function dm(surface: string): Partition {
  return { org: "default", platform: "slack", workspace: "T1", surface, workspaceKey: "slack/T1", surfaceKey: `slack/T1/${surface}`, domainKey: `slack/T1/${surface}`, key: `slack/T1/${surface}` };
}
const ALICE_DM = dm("DALICE");
const BOB_DM = dm("DBOB");
const sqlite = providerById("sqlite");
const store = getOperationalStore();

async function refusals(principalId: string): Promise<number> {
  return (await readAudit({ org: "default", action: "person.opt_out.refused", principalId })).length;
}
async function personal(p: Partition): Promise<string> {
  return (await sqlite.readTier(p, SURFACE))["MEMORY.md"] ?? "";
}
function write(p: Partition, principalId: string, road: MemoryWriteRoad, line: string, kind?: "operational") {
  return writeMemoryTier({
    provider: sqlite,
    partition: p,
    tier: SURFACE,
    files: { "MEMORY.md": `# Personal memory\n\n${line}\n` },
    message: `test ${road}`,
    road,
    principalId,
    ...(kind ? { kind } : {}),
  });
}

console.log("§1 the store");
{
  ok((await store.getPersonOptOut("default", "UALICE")) === null, "no row before the person opts out");
  ok((await store.setPersonOptOut("default", "UALICE", "2026-10-01T00:00:00.000Z")) === true, "the first set draws the boundary");
  ok((await store.setPersonOptOut("default", "UALICE", "2026-10-05T00:00:00.000Z")) === false, "a repeat is not new");
  ok((await store.getPersonOptOut("default", "UALICE"))?.optedOutAt === "2026-10-01T00:00:00.000Z", "…and keeps the FIRST date");
  ok((await store.getPersonOptOut("other-org", "UALICE")) === null, "the row is org-scoped");
  ok((await store.clearPersonOptOut("default", "UALICE")) === true, "clear lifts it");
  ok((await store.clearPersonOptOut("default", "UALICE")) === false, "a second clear lifts nothing and says so");
  const row = await store.getPersonOptOut("default", "UALICE");
  ok(row !== null && row.optedOutAt === undefined, "the cleared row stays, with no date");
  ok((await store.setPersonOptOut("default", "UALICE", "2026-10-09T00:00:00.000Z")) === true, "drawing it again on a cleared row is new");
  ok((await readPersonOptOut("default", "UALICE")).optedOut === true, "readPersonOptOut reads the row");
}

console.log("§2 the memory road");
{
  const before = await refusals("UALICE");
  const r = await write(ALICE_DM, "UALICE", "session-persist", "- Alice drinks green tea");
  ok(r.changed === false && r.refused === "person-opt-out", "a session persist attributed to the opted-out person is refused");
  ok(!(await personal(ALICE_DM)).includes("green tea"), "…and nothing reached her memory");
  ok((await refusals("UALICE")) === before + 1, "…and exactly one refusal row names her");
  const row = (await readAudit({ org: "default", action: "person.opt_out.refused", principalId: "UALICE", limit: 1 }))[0];
  ok(row?.detail?.act === "memory-write" && row.detail.road === "session-persist", "the row names the leg and the road");
  ok(!JSON.stringify(row?.detail ?? {}).includes("green tea"), "the row never carries the refused content");

  const silo = await writeMemoryTier({
    provider: sqlite,
    partition: ALICE_DM,
    tier: siloTier("team-brain"),
    files: { "MEMORY.md": "# Memory silo\n\n- Alice owns billing\n" },
    message: "test silo",
    silo: { name: "team-brain", provider: "sqlite" },
    road: "session-persist",
    principalId: "UALICE",
  });
  ok(silo.refused === "person-opt-out", "a session persist of her turn to a SHARED silo is refused too — the leg is the person, not the tier");

  const bob = await write(BOB_DM, "UBOB", "session-persist", "- Bob likes tea");
  ok(bob.changed === true && bob.refused === undefined && (await personal(BOB_DM)).includes("Bob likes tea"), "the same write for a person who did not opt out lands");

  for (const road of ["self-edit", "purge", "control-edit"] as const) {
    const w = await write(ALICE_DM, "UALICE", road, `- written by ${road}`);
    ok(w.refused === undefined && (await personal(ALICE_DM)).includes(`written by ${road}`), `the ${road} road — a person acting on memory — still lands`);
  }
  const op = await write(ALICE_DM, "UALICE", "status-board", "- status line", "operational");
  ok(op.refused === undefined, "an operational write is never refused");
  const nobody = await writeMemoryTier({ provider: sqlite, partition: ALICE_DM, tier: SURFACE, files: { "MEMORY.md": "# x\n\n- no principal\n" }, message: "t", road: "session-persist" });
  ok(nobody.refused === undefined, "a write with no attributed person is not refused");
}

console.log("§3 fail-closed");
{
  const real = getOperationalStore();
  const down = new Proxy(real, {
    get(target, key, receiver) {
      if (key === "getPersonOptOut") return async () => Promise.reject(new Error("store down"));
      return Reflect.get(target, key, receiver);
    },
  });
  registerOperationalStore(down);
  resetOperationalStore();
  const state = await readPersonOptOut("default", "UBOB");
  ok(state.optedOut === true && state.readable === false, "an unreadable store reads as opted out, and says it is a guess");
  const w = await write(BOB_DM, "UBOB", "session-persist", "- Bob moved to Leeds");
  ok(w.refused === "person-opt-out" && !(await personal(BOB_DM)).includes("Leeds"), "…so the agent write is refused");
  const row = (await readAudit({ org: "default", action: "person.opt_out.refused", principalId: "UBOB", limit: 1 }))[0];
  ok(row?.detail?.storeReadable === false, "…and the refusal row records that the store did not answer");
  registerOperationalStore(real);
  resetOperationalStore();
}

console.log("§4 the command");
{
  ok(JSON.stringify(parseOeCommandTokens(["optout"])) === JSON.stringify({ kind: "optout", action: "status" }), "`optout` alone reads the state");
  ok(JSON.stringify(parseOeCommandTokens(["optout", "on"])) === JSON.stringify({ kind: "optout", action: "on" }), "`optout on` parses");
  ok(parseOeCommandTokens(["optout", "maybe"]).kind === "error", "an unknown action is an error, never a change");
  ok(renderHelp().includes("optout on|off"), "`/oe help` names the command");

  const carol: SurfaceBinding = { org: "default", platform: "slack", workspace: "T1", surface: "DCAROL", mode: "dm", visibility: "private", trust: "internal", principalId: "UCAROL" } as SurfaceBinding;
  const setRows = async () => (await readAudit({ org: "default", action: "person.opt_out.set", principalId: "UCAROL" })).length;
  const clearRows = async () => (await readAudit({ org: "default", action: "person.opt_out.cleared", principalId: "UCAROL" })).length;
  ok((await runOeCommand({ kind: "optout", action: "status" }, carol)).startsWith("Your opt-out is off"), "status before: off");
  ok((await runOeCommand({ kind: "optout", action: "on" }, carol)).startsWith("Your opt-out is now on"), "on: set");
  ok((await setRows()) === 1, "…with one `person.opt_out.set` row naming her");
  ok((await runOeCommand({ kind: "optout", action: "on" }, carol)).startsWith("Your opt-out was already on"), "a repeat says so");
  ok((await setRows()) === 1, "…and writes no second row");
  ok((await runOeCommand({ kind: "optout", action: "status" }, carol)).startsWith("Your opt-out is on (since "), "status after: on, with its date");
  ok((await runOeCommand({ kind: "optout", action: "off" }, carol)).startsWith("Your opt-out is now off"), "off: cleared");
  ok((await clearRows()) === 1, "…with one `person.opt_out.cleared` row");
  const attested = { ...carol, principalAttested: true as const };
  ok((await runOeCommand({ kind: "optout", action: "on" }, attested)).startsWith("I could not tell who you are"), "an ATTESTED principal (a routine fire's creator) cannot be opted in");
  ok((await setRows()) === 1, "…and no row is written for it");
}

console.log("§5 the home section");
{
  const viewer: HomeViewer = { org: "default", platform: "slack", workspace: "T1", principalId: "UDAN", personal: dm("DDAN"), trust: "internal", domains: [] };
  const section = async () => (await buildHomeView(viewer)).find((s) => s.id === "privacy.opt-out");
  const off = await section();
  ok(off !== undefined, "the page carries the opt-out section");
  ok(off!.blocks.some((b) => b.kind === "buttons" && b.buttons.length === 1 && b.buttons[0]!.id === OPT_OUT_HOME_ACTIONS.on), "off: the one button turns it on");
  ok((await runHomeAction(viewer, OPT_OUT_HOME_ACTIONS.on)).notice.startsWith("Done."), "the on action sets it");
  ok((await readPersonOptOut("default", "UDAN")).optedOut === true, "…in the store");
  const on = await section();
  ok(on!.blocks.some((b) => b.kind === "text" && b.text.startsWith("On since ")), "on: the state line says since when");
  ok(on!.blocks.some((b) => b.kind === "buttons" && b.buttons[0]!.id === OPT_OUT_HOME_ACTIONS.off), "on: the one button turns it off");
  const viaRow = (await readAudit({ org: "default", action: "person.opt_out.set", principalId: "UDAN", limit: 1 }))[0];
  ok(viaRow?.detail?.via === "app-home" && viaRow.surface === "DDAN", "the row names the door and the person's own DM");
  ok((await runHomeAction(viewer, OPT_OUT_HOME_ACTIONS.off)).notice.startsWith("Done."), "the off action clears it");
  ok((await readPersonOptOut("default", "UDAN")).optedOut === false, "…in the store");
}

console.log("§6 the road table");
{
  const allowed = Object.entries(OPT_OUT_MEMORY_ROADS).filter(([, v]) => v === "allow").map(([k]) => k).sort();
  ok(JSON.stringify(allowed) === JSON.stringify(["control-edit", "onboarding-marker", "purge", "self-edit", "status-board"]), `only person, admin and operational roads are allowed (got ${allowed.join(", ")})`);
  ok(OPT_OUT_MEMORY_ROADS["session-persist"] === "refuse" && OPT_OUT_MEMORY_ROADS["dream-learn"] === "refuse", "the agent's own roads refuse");
}

removeTempDir(tmp);
console.log(`✓ person-opt-out: ${n} assertions`);

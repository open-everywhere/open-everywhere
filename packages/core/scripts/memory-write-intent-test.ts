import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import type { MemoryProvider } from "../agent/memory/provider.js";
import type { MemoryFiles, Tier } from "../agent/memory/store.js";
import type { Partition } from "../agent/memory/partition.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-write-intent-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();

const { isRememberAsk, noteWriteIntent, writeIntentArmed, consumeWriteIntent, REMEMBER_ASK_PATTERNS, MAX_UNSERVED_POSTS } = await import("../agent/memory/write-intent.js");
const { flushWriteIntentMemory } = await import("../agent/hooks/memory.js");
const { noteTaskDispatched } = await import("../agent/hooks/settlement-flush.js");
const { FakeEveContext, inEveContext } = await import("./_eve-context-stub.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { registerProvider } = await import("../agent/memory/provider.js");
const { siloTier, tierId } = await import("../agent/memory/store.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { deploymentOrg } = await import("../agent/identity/binding.js");
const { formatWindowToken, workWindowId } = await import("../agent/channels/window-key.js");
const { MEMORY_WRITE_ACTION } = await import("../agent/memory/write-road.js");
const { factStoredThisTurn } = await import("../agent/memory/write-evidence.js");
const { applyMemoryClaimGuard } = await import("../agent/channels/memory-claim-guard.js");

ok(REMEMBER_ASK_PATTERNS.length > 0, "the pattern list is not empty — an empty list would pass §1's negatives vacuously");

const ASKS = [
  "remember this: the OPE121 canary code is obsidian-30653",
  "Please remember that the on-call handle is ONCALL-6225",
  "Remember the door code is 4417",
  "save this to memory",
  "store that in your notes",
  "add it to the team memory",
  "note this down",
  "write that down",
  "make a note of the handle",
  "keep this in mind",
  "don't forget the door code",
  "dont forget the door code",
  "Can you remember this for me?",
  "Could you please remember the door code",
  "would you remember that the handle is ONCALL-6225",
];
for (const text of ASKS) ok(isRememberAsk(text), `an explicit remember-ask is recognised: "${text}"`);

const NOT_ASKS = [
  "I remember that we discussed this last week.",
  "Do you remember the release date?",
  "she remembers it well",
  "Nobody remembers the old code.",
  "What did we save to the repo?",
  "Can you summarise the thread?",
  "The notes are already in the silo.",
  "",
];
for (const text of NOT_ASKS) ok(!isRememberAsk(text), `an ordinary message is NOT a write intent: "${text}"`);
ok(!isRememberAsk(undefined), "an absent message is not a write intent");

{
  await inEveContext(new FakeEveContext(), async () => {
    ok(!writeIntentArmed(), "a fresh session holds no write intent");
    noteWriteIntent("what is the release date?");
    ok(!writeIntentArmed(), "an ordinary message does not arm the persist");
    noteWriteIntent("remember this: the canary is obsidian-30653");
    ok(writeIntentArmed(), "an explicit remember-ask ARMS the in-turn persist");
    noteWriteIntent("thanks!");
    ok(writeIntentArmed(), "a following ordinary message leaves an unserved intent ARMED");
    consumeWriteIntent();
    ok(!writeIntentArmed(), "a served intent is cleared");
  });
}

noteWriteIntent("remember this");
ok(!writeIntentArmed(), "outside an eve context the arm no-ops and the read answers 'not armed'");

class FakeSandbox {
  readonly files = new Map<string, string>();
  readonly locked = new Set<string>();

  private isLocked(path: string): boolean {
    for (const l of this.locked) if (path === l || path.startsWith(`${l}/`)) return true;
    return false;
  }
  async writeTextFile({ path, content }: { path: string; content: string }): Promise<void> {
    if (this.isLocked(path)) throw new Error(`EACCES: '${path}' is read-only`);
    this.files.set(path, content);
  }
  async readTextFile({ path }: { path: string }): Promise<string | null> {
    return this.files.has(path) ? (this.files.get(path) as string) : null;
  }
  async run({ command }: { command: string }): Promise<{ stdout: string }> {
    const lock = command.match(/^chmod -R a-w '(.+)'$/);
    if (lock) {
      this.locked.add(lock[1]!);
      return { stdout: "" };
    }
    const unlock = command.match(/^chmod -R u\+w '(.+)'$/);
    if (unlock) {
      this.locked.delete(unlock[1]!);
      return { stdout: "" };
    }
    const list = command.match(/^cd (\S+) 2>\/dev\/null && find \. -type f/);
    if (list) {
      const dir = list[1]!;
      const rels = [...this.files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1));
      return { stdout: rels.join("\n") };
    }
    if (command.startsWith("rm -rf ") || command.startsWith("rm -f ")) {
      for (const m of command.matchAll(/'([^']+)'/g)) {
        const target = m[1]!;
        for (const k of [...this.files.keys()]) if (k === target || k.startsWith(`${target}/`)) this.files.delete(k);
        this.locked.delete(target);
      }
      return { stdout: "" };
    }
    return { stdout: "" };
  }
  seatEdit(rel: string, content: string): void {
    this.files.set(`memory/${SILO}/${rel}`, content);
  }
}

const SILO = "intent-silo";
const BRAIN: Tier = siloTier(SILO);
const tiers = new Map<string, { files: MemoryFiles; version: number }>();

const brainProvider: MemoryProvider = {
  id: "fake-brain-intent",
  async readTier(_p: Partition, tier: Tier) {
    return { ...(tiers.get(tierId(tier))?.files ?? {}) };
  },
  async ensureTier(_p: Partition, tier: Tier) {
    const t = tiers.get(tierId(tier));
    if (t && Object.keys(t.files).length > 0) return { ...t.files };
    const seed: MemoryFiles = { "MEMORY.md": `# ${tierId(tier)}\n` };
    tiers.set(tierId(tier), { files: seed, version: (t?.version ?? 0) + 1 });
    return { ...seed };
  },
  async writeTier(_p: Partition, tier: Tier, files: MemoryFiles) {
    const t = tiers.get(tierId(tier)) ?? { files: {}, version: 0 };
    if (!Object.entries(files).some(([rel, c]) => t.files[rel] !== c)) return null;
    t.files = { ...t.files, ...files };
    t.version += 1;
    tiers.set(tierId(tier), t);
    return String(t.version);
  },
  async deleteTier() {},
  async tierVersion(_p: Partition, tier: Tier) {
    const t = tiers.get(tierId(tier));
    return t ? String(t.version) : null;
  },
};
registerProvider(brainProvider);

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "payments", reach: ["slack/T1/C1"], memory: [SILO], ambientSupervisor: true, mode: "unified" })],
  loadSilos: () => [{ name: SILO, provider: "fake-brain-intent" }],
  domainsForSurface: () => ["payments"],
} as Parameters<typeof registerConfig>[0]);

tiers.set(tierId(BRAIN), { files: { "MEMORY.md": `# ${SILO}\n` }, version: 1 });

const ORG = deploymentOrg();
const WINDOW = formatWindowToken({ domain: "payments", windowId: workWindowId("slack_T1_C1"), generation: 3 });
const SLACK_ATTRS: Record<string, string> = {
  team_id: "T1",
  channel_id: "C1",
  channel_type: "channel",
  is_private: "false",
  is_ext_shared: "false",
  trust_checked: "true",
  user_id: "U7",
};

function makeSeat(sessionId: string, turnId: string): { sandbox: FakeSandbox; ctx: never } {
  const sandbox = new FakeSandbox();
  const ctx = {
    agent: { name: "test" },
    channel: { kind: "slack", continuationToken: `unified:${WINDOW}` },
    getSandbox: async () => sandbox,
    session: {
      id: sessionId,
      turn: { id: turnId, sequence: 1 },
      auth: { current: { principalId: "U7", principalType: "slack-user", attributes: { ...SLACK_ATTRS, oe_grain: "standing", oe_window_token: WINDOW } } },
    },
  } as never;
  return { sandbox, ctx };
}

async function memoryWriteRows(): Promise<{ road: string; turnId: string | undefined }[]> {
  const rows = await readAudit({ org: ORG, action: MEMORY_WRITE_ACTION });
  return rows.map((r) => ({ road: String(r.detail?.["road"] ?? ""), turnId: r.detail?.["turnId"] as string | undefined }));
}

{
  const seat = makeSeat("sess-unarmed", "turn_unarmed");
  seat.sandbox.seatEdit("notes.md", "- the canary is obsidian-30653\n");
  await inEveContext(new FakeEveContext(), async () => {
    ok((await flushWriteIntentMemory(seat.ctx)) === null, "a turn nobody asked to remember anything runs NO persist");
  });
  ok((await memoryWriteRows()).length === 0, "and writes NO memory.write row — the negative control for the row assertion below");
}

{
  const seat = makeSeat("sess-armed", "turn_armed");
  seat.sandbox.seatEdit("notes.md", "- the OPE121 canary code is obsidian-30653\n");
  const CLAIM = "It's now in durable notes and the curated memory index.";
  await inEveContext(new FakeEveContext(), async () => {
    ok(!factStoredThisTurn("turn_armed"), "before the flush the turn holds NO write evidence");
    ok(applyMemoryClaimGuard(CLAIM, factStoredThisTurn("turn_armed")).withheld.length === 1, "so the guard strikes the save — this is a live run's reply");

    noteWriteIntent("remember this: the OPE121 canary code is obsidian-30653");
    const flush = await flushWriteIntentMemory(seat.ctx);
    ok(flush !== null && flush.changed === 1, `the in-turn persist CHANGED the store (${JSON.stringify(flush)})`);
    ok(!writeIntentArmed(), "and the intent is spent once a durable write LANDED for the turn");

    ok(factStoredThisTurn("turn_armed"), "AFTER the flush the turn holds write evidence — the row the reply guard reads");
    ok(!factStoredThisTurn("turn_other"), "and it backs THIS turn only — yesterday's write can never back today's ack");
    const guarded = applyMemoryClaimGuard(CLAIM, factStoredThisTurn("turn_armed"));
    ok(guarded.body === CLAIM && guarded.withheld.length === 0, "so the reply can truthfully confirm the save, and the guard leaves it alone");
  });
  const rows = await memoryWriteRows();
  ok(rows.length === 1, `exactly one memory.write row exists at reply time (got ${rows.length})`);
  ok(rows[0]!.road === "session-persist", `the row names the EXISTING road, not a new one (got ${rows[0]!.road})`);
  ok(tiers.get(tierId(BRAIN))!.files["notes.md"]?.includes("obsidian-30653") === true, "and the bytes really reached the store");
}

{
  const seat = makeSeat("sess-fanout", "turn_fanout");
  seat.sandbox.seatEdit("notes.md", "- a second fact\n");
  await inEveContext(new FakeEveContext(), async () => {
    noteWriteIntent("remember this: a second fact");
    noteTaskDispatched("task-live-1");
    ok((await flushWriteIntentMemory(seat.ctx)) === null, "a live delegated task HOLDS the in-turn persist closed");
    ok(writeIntentArmed(), "and the intent STAYS ARMED, so the next reply re-offers it");
  });
}

{
  const seat = makeSeat("sess-nothing", "turn_nothing");
  const before = (await memoryWriteRows()).length;
  await inEveContext(new FakeEveContext(), async () => {
    noteWriteIntent("remember this: the release decision is shipit-6125");
    const flush = await flushWriteIntentMemory(seat.ctx);
    ok(flush !== null, "the persist RAN — nothing held it, so this is not the fan-out skip above");
    ok(flush !== null && flush.changed === 0 && flush.failed === 0, `and it landed NOTHING (${JSON.stringify(flush)})`);
    ok(!factStoredThisTurn("turn_nothing"), "so the turn holds NO write evidence — the fact the rule below keys on");
    ok(writeIntentArmed(), "the intent SURVIVES a post that persisted nothing, so the next post of the same ask re-offers the write");
  });
  ok((await memoryWriteRows()).length === before, "and no memory.write row was written — the negative control for the assertion above");
}

{
  const seat = makeSeat("sess-bounded", "turn_bounded");
  await inEveContext(new FakeEveContext(), async () => {
    noteWriteIntent("remember this: an ask nothing is ever written for");
    for (let i = 1; i < MAX_UNSERVED_POSTS; i++) {
      await flushWriteIntentMemory(seat.ctx);
      ok(writeIntentArmed(), `the intent is still armed after ${i} post(s) that landed nothing`);
    }
    await flushWriteIntentMemory(seat.ctx);
    ok(!writeIntentArmed(), `and it RETIRES on the ${MAX_UNSERVED_POSTS}th, so the persist stops being paid for on every post`);
    noteWriteIntent("remember this: a second, later ask");
    ok(writeIntentArmed(), "a fresh remember-ask RE-ARMS after a retirement");
    await flushWriteIntentMemory(seat.ctx);
    ok(writeIntentArmed(), "…with its own full budget, not the exhausted one");
  });
}

const agentDir = join(fileURLToPath(new URL("..", import.meta.url)), "agent");
const replySrc = readFileSync(join(agentDir, "tools", "reply.ts"), "utf-8");
const hookSrc = readFileSync(join(agentDir, "hooks", "memory.ts"), "utf-8");

ok(hookSrc.includes("noteWriteIntent("), "the memory hook ARMS the intent — without this call nothing ever sets the flag");
const received = hookSrc.indexOf('"message.received"');
ok(received > -1 && hookSrc.indexOf("noteWriteIntent(", received) > -1, "the arm sits in the `message.received` handler, so every inbound message reaches it");

const postDoors = ["await postUnifiedReply(", "await postReply("];
const postAts = postDoors.map((p) => replySrc.indexOf(p));
for (const [i, at] of postAts.entries()) ok(at > -1, `the scan sees the post call ${postDoors[i]} — a scan that missed it would pass vacuously`);
ok(postAts[0]! < postAts[1]!, "the two doors are in the order this pairing assumes");
const flushAts = [...replySrc.matchAll(/flushWriteIntentMemory\(/g)].map((m) => m.index);
ok(flushAts.length === postDoors.length, `BOTH reply doors call the flush (found ${flushAts.length} call(s) for ${postDoors.length} door(s))`);
for (const [i, at] of postAts.entries()) {
  const flushAt = flushAts[i]!;
  ok(flushAt < at, `the in-turn persist runs BEFORE ${postDoors[i]} — otherwise the guard reads an empty ledger and denies the save`);
  ok(i === 0 || flushAt > postAts[i - 1]!, `the call before ${postDoors[i]} is its OWN, not the previous door's`);
}

const unifiedSrc = readFileSync(join(agentDir, "channels", "unified.ts"), "utf-8");
ok(unifiedSrc.length > 1000, "the scan read channels/unified.ts — an empty read would pass vacuously");
ok(!unifiedSrc.includes("shouldBridgeAddressedProse("), "the addressed-mention prose bridge is deleted (OPE-1982)");
ok(!unifiedSrc.includes("flushWriteIntentMemory("), "…so unified.ts runs no in-turn persist of its own: the reply tool's doors are the only ones left");

const flushAt = hookSrc.indexOf("export async function flushWriteIntentMemory");
ok(flushAt > -1, "the flush is exported from the module that owns the persist road");
const flushBody = hookSrc.slice(flushAt, flushAt + 2000);
ok(flushBody.includes('persistMemoryNow(ctx, "write-intent")'), "the flush runs the EXISTING session-persist road, not a road of its own");
ok(!flushBody.includes("writeMemoryTier("), "and it never reaches the write road directly — one road, one row");

const chanDir = join(agentDir, "channels");
const namingAdapters = readdirSync(chanDir)
  .filter((n) => n.endsWith(".ts"))
  .filter((n) => readFileSync(join(chanDir, n), "utf-8").includes("write-intent.js"));
ok(readdirSync(chanDir).length > 10, "the channel scan sees the adapter directory — an empty scan would pass vacuously");
ok(namingAdapters.length === 0, `PARITY: no channel adapter names the write-intent road — naming it: ${namingAdapters.join(", ")}`);

const flushingAdapters = readdirSync(chanDir)
  .filter((n) => n.endsWith(".ts"))
  .filter((n) => readFileSync(join(chanDir, n), "utf-8").includes("flushWriteIntentMemory("));
ok(
  flushingAdapters.length === 0,
  `PARITY: the in-turn persist reaches NO channel file — the reply tool is its only door. Naming it: ${flushingAdapters.join(", ")}`,
);

const providersDir = join(fileURLToPath(new URL("../../", import.meta.url)), "providers");
const bundles = readdirSync(providersDir).filter((b) => {
  try {
    return readdirSync(join(providersDir, b, "agent")).length > 0;
  } catch {
    return false;
  }
});
ok(bundles.length >= 5, `the provider scan sees the bundles (${bundles.length}) — an empty scan would pass vacuously`);
const providerNamers = bundles.filter((b) => {
  const dir = join(providersDir, b, "agent");
  return readdirSync(dir).some((n) => n.endsWith(".ts") && readFileSync(join(dir, n), "utf-8").includes("write-intent.js"));
});
ok(providerNamers.length === 0, `PARITY: no provider bundle names it either — naming it: ${providerNamers.join(", ")}`);

{
  const { noteDurableMemoryWrite, factWritesThisTurn, adoptCarriedWrites, OE_WORK_RESULT_WRITES_ATTR } = await import("../agent/memory/write-evidence.js");
  const { workResultAttributes } = await import("../agent/channels/unified.js");
  const CLAIM = "It's now in durable notes and the curated memory index.";
  let carried: unknown;
  await inEveContext(new FakeEveContext(), async () => {
    noteDurableMemoryWrite("turn_w", { kind: "memory", road: "session-persist", silo: "it-memory-brain", version: "v-1" });
    noteDurableMemoryWrite("turn_w", { kind: "operational", road: "status-board", version: "v-2" });
    const facts = factWritesThisTurn("turn_w");
    ok(facts.length === 1 && facts[0]!.silo === "it-memory-brain", "OPE-2343: the work session reads its own FACT writes, and only those");
    carried = workResultAttributes({ requestId: "q-w", requester: { kind: "unverified", reason: "t" }, nonMemberWake: false, memoryWrites: facts })[OE_WORK_RESULT_WRITES_ATTR];
    ok(typeof carried === "string", "OPE-2343: the result wake carries them");
    ok(!(OE_WORK_RESULT_WRITES_ATTR in workResultAttributes({ requestId: "q-w", requester: { kind: "unverified", reason: "t" }, nonMemberWake: false })), "OPE-2343: a result wake with no writes carries no attribute");
  });
  await inEveContext(new FakeEveContext(), async () => {
    ok(applyMemoryClaimGuard(CLAIM, factStoredThisTurn("turn_seat")).withheld.length === 1, "OPE-2343 NEGATIVE CONTROL: before adoption the seat's guard strikes the claim — the measured defect");
    ok(adoptCarriedWrites("turn_seat", carried) === 1, "OPE-2343: the seat's turn adopts the one carried write");
    ok(factStoredThisTurn("turn_seat"), "OPE-2343: 🔴 the seat's turn now holds the work session's write as evidence");
    ok(applyMemoryClaimGuard(CLAIM, factStoredThisTurn("turn_seat")).withheld.length === 0, "OPE-2343: 🔴 so the guard keeps the seat's true claim");
    ok(!factStoredThisTurn("turn_other"), "OPE-2343: and it backs THAT turn only");
    ok(adoptCarriedWrites("turn_bad", "not json") === 0 && adoptCarriedWrites("turn_bad", JSON.stringify([{ road: "x" }])) === 0 && !factStoredThisTurn("turn_bad"), "OPE-2343: a malformed carriage records nothing (fail closed)");
  });
}

await removeTempDir(tmp);
console.log(`memory write intent: ${passed} assertions passed`);

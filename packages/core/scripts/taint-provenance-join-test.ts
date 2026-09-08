import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-taint-provenance-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import memoryHook from "../agent/hooks/memory.js";
import spawnTaintHook from "../agent/hooks/spawn-taint.js";
import { OE_DISPATCH_TURN_ATTR, OE_PARENT_TURN_TAINTED_ATTR } from "../agent/hooks/spawn-taint.js";
import { markUntrustedIngestedThisTurn, taintKindsThisTurn, untrustedIngestedThisTurn } from "../agent/access/taint-signal.js";
import { EXTERNAL_PROVENANCE_PREFIX } from "../agent/memory/provenance-mark.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { registerProvider, type MemoryProvider } from "../agent/memory/provider.js";
import { siloTier, tierId, type MemoryFiles, type Tier } from "../agent/memory/store.js";
import { type Partition } from "../agent/memory/partition.js";
import { resolvePartition } from "../agent/memory/partition.js";
import { formatWindowToken } from "../agent/channels/window-key.js";
import type { HookContext } from "eve/hooks";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
registerSlackFixtureMapper();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

class FakeEveContext {
  private readonly store = new Map<string, unknown>();
  get<T>(key: { name: string }): T | undefined {
    return this.store.get(key.name) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.store.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`missing ${key.name}`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
    const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
    this.store.set(key.name, next);
    return next;
  }
  ensure<T>(key: { name: string }, create: () => T): T {
    return this.has(key) ? this.require(key) : this.set(key, create());
  }
  clearVirtualContext(): void {}
  setVirtualContext(): void {}
  *entries(): Generator<readonly [unknown, unknown]> {}
}

function eveContextStorage(): AsyncLocalStorage<unknown> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return g[key] as AsyncLocalStorage<unknown>;
}

class FakeSandbox {
  readonly files = new Map<string, string>();
  tierListings = 0;

  async writeTextFile({ path, content }: { path: string; content: string }): Promise<void> {
    this.files.set(path, content);
  }
  async readTextFile({ path }: { path: string }): Promise<string | null> {
    return this.files.has(path) ? (this.files.get(path) as string) : null;
  }
  async run({ command }: { command: string }): Promise<{ stdout: string }> {
    const list = command.match(/^cd (\S+) 2>\/dev\/null && find \. -type f/);
    if (list) {
      this.tierListings++;
      const dir = list[1] as string;
      const rels = [...this.files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1));
      return { stdout: rels.join("\n") };
    }
    return { stdout: "" };
  }
  put(rel: string, content: string): void {
    this.files.set(`memory/${SILO}/${rel}`, content);
  }
  read(rel: string): string | undefined {
    return this.files.get(`memory/${SILO}/${rel}`);
  }
}

const SILO = "join-silo";
const BRAIN: Tier = siloTier(SILO);
const tiers = new Map<string, { files: MemoryFiles; version: number }>();

const brainProvider: MemoryProvider = {
  id: "fake-brain-join",
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
  loadDomains: () => [defineDomain({ name: "payments", channels: ["slack/T1/C1"], memory: [SILO], mode: "unified" })],
  loadSilos: () => [{ name: SILO, provider: "fake-brain-join" }],
  domainsForSurface: () => ["payments"],
} as Parameters<typeof registerConfig>[0]);

const SEEDED = "# payments brain\n- pricing is reviewed quarterly\n";
tiers.set(tierId(BRAIN), { files: { "MEMORY.md": SEEDED }, version: 1 });

const memory = memoryHook as unknown as { events: Record<string, (event: unknown, ctx: HookContext) => void | Promise<void>> };
const taint = spawnTaintHook as unknown as { events: Record<string, (event: unknown, ctx: HookContext) => void | Promise<void>> };

const WINDOW = formatWindowToken({ domain: "payments", windowId: "payments", generation: 3 });
const SLACK_ATTRS: Record<string, string> = {
  team_id: "T1",
  channel_id: "C1",
  channel_type: "channel",
  is_private: "false",
  is_ext_shared: "false",
  trust_checked: "true",
  user_id: "U7",
};

interface Session {
  readonly id: string;
  readonly sandbox: FakeSandbox;
  readonly als: FakeEveContext;
  readonly bag: Record<string, unknown>;
  ctx: HookContext;
}

function makeSeat(id: string, grain: string, sandbox = new FakeSandbox()): Session {
  const bag: Record<string, unknown> = { ...SLACK_ATTRS, oe_platform: "slack", oe_grain: grain, oe_window_token: WINDOW };
  const s: Session = {
    id,
    sandbox,
    als: new FakeEveContext(),
    bag,
    ctx: {} as HookContext,
  };
  s.ctx = seatCtx(s, 0);
  return s;
}

function seatCtx(s: Session, sequence: number): HookContext {
  return {
    agent: { name: "test" },
    channel: { kind: "slack", continuationToken: `unified:${WINDOW}` },
    getSandbox: async () => s.sandbox,
    session: {
      id: s.id,
      turn: { id: `${s.id}-turn-${sequence}`, sequence },
      auth: { current: { principalId: "U7", principalType: "slack-user", attributes: s.bag } },
    },
  } as unknown as HookContext;
}

function makeChild(parent: Session, childId: string, sequence: number, pinnedTurn: string, callId: string): Session {
  const bag: Record<string, unknown> = { ...parent.bag };
  const s: Session = { id: childId, sandbox: parent.sandbox, als: new FakeEveContext(), bag, ctx: {} as HookContext };
  s.ctx = childCtx(s, parent, sequence, pinnedTurn, callId);
  return s;
}

function childCtx(s: Session, parent: Session, sequence: number, pinnedTurn: string, callId: string): HookContext {
  return {
    agent: { name: "test" },
    channel: { kind: "subagent", continuationToken: `subagent:${parent.id}:${callId}` },
    getSandbox: async () => s.sandbox,
    session: {
      id: s.id,
      parent: { sessionId: parent.id, callId, rootSessionId: parent.id, turn: { id: pinnedTurn, sequence: 0 } },
      turn: { id: `${s.id}-turn-${sequence}`, sequence },
      auth: { current: { principalId: "U7", principalType: "slack-user", attributes: s.bag } },
    },
  } as unknown as HookContext;
}

const SUP_TOKEN = "C1:oe-sup:g1";

function supervisorCtx(s: Session, sequence: number): HookContext {
  return {
    agent: { name: "test" },
    channel: { kind: "slack", continuationToken: SUP_TOKEN },
    getSandbox: async () => s.sandbox,
    session: {
      id: s.id,
      turn: { id: `${s.id}-turn-${sequence}`, sequence },
      auth: { current: { principalId: "U7", principalType: "slack-user", attributes: s.bag } },
    },
  } as unknown as HookContext;
}

function partitionOf(s: Session): Partition {
  return resolvePartition(s.ctx as never);
}

async function inSession<T>(s: Session, fn: () => Promise<T> | T): Promise<T> {
  return await eveContextStorage().run(s.als, async () => await fn());
}

async function taintedParentTurn(parent: Session, sequence: number, kinds: readonly string[]): Promise<void> {
  parent.ctx = seatCtx(parent, sequence);
  await inSession(parent, async () => {
    await taint.events["turn.started"]!({}, parent.ctx);
    for (const k of kinds) markUntrustedIngestedThisTurn(k as never);
    ok(untrustedIngestedThisTurn(), `precondition: the parent turn ${sequence} is tainted`);
  });
}

async function cleanParentTurn(parent: Session, sequence: number): Promise<void> {
  parent.ctx = seatCtx(parent, sequence);
  await inSession(parent, async () => {
    await taint.events["turn.started"]!({}, parent.ctx);
  });
}

async function turnThatWrites(s: Session, write: () => void): Promise<void> {
  await inSession(s, async () => {
    await taint.events["turn.started"]!({}, s.ctx);
    await memory.events["turn.started"]!({}, s.ctx);
    write();
    await memory.events["turn.completed"]!({}, s.ctx);
  });
}

const MARKED = (line: string): boolean => line.includes(EXTERNAL_PROVENANCE_PREFIX);
function memoryLines(s: Session): string[] {
  return (s.sandbox.read("MEMORY.md") ?? "").split("\n");
}
function lineWith(s: Session, needle: string): string {
  return memoryLines(s).find((l) => l.includes(needle)) ?? "";
}

console.log("A — parent taint → child adoption → a MARKED bullet, naming what the parent read:");
{
  const parent = makeSeat("join-parent", "standing");
  parent.sandbox.put("MEMORY.md", SEEDED);

  await taintedParentTurn(parent, 1, ["web", "github"]);
  eq(
    parent.bag[OE_PARENT_TURN_TAINTED_ATTR],
    "join-parent|join-parent-turn-1|web,github",
    "[A] 🔴 THE STAMP CARRIES THE KINDS (OPE-1215 item 2) — the pair alone left the child unable to name what was read",
  );

  const child = makeChild(parent, "join-child", 0, "join-parent-turn-1", "call_a1");
  await turnThatWrites(child, () => {
    parent.sandbox.put("MEMORY.md", `${SEEDED}- 2026-08-27: Ada owns billing\n`);
  });

  const bullet = lineWith(child, "Ada owns billing");
  ok(MARKED(bullet), "[A] 🔴 THE JOIN: a bullet the CHILD of a tainted parent turn added comes out MARKED");
  ok(
    bullet.includes(`${EXTERNAL_PROVENANCE_PREFIX} added on a turn that ingested web, github]`),
    "[A] 🔴 …and the mark NAMES the parent's kinds — the unqualified 'external content' wording is what the lost-kinds hole produced",
  );
  ok(bullet.includes("[unverified claim; the turn ingested web, github]"), "[A] the in-sentence attribution names the same kinds");

  ok(!MARKED(lineWith(child, "pricing is reviewed quarterly")), "[A] 🔴 the pre-existing bullet is NOT marked — the diff is against the baseline, not the file");
}
{
  const parent = makeSeat("join-parent-clean", "standing");
  parent.sandbox.put("MEMORY.md", SEEDED);
  await cleanParentTurn(parent, 1);
  eq(parent.bag[OE_PARENT_TURN_TAINTED_ATTR], undefined, "[A] a clean parent turn writes no stamp at all");

  const child = makeChild(parent, "join-child-clean", 0, "join-parent-clean-turn-1", "call_a2");
  await inSession(child, async () => {
    await taint.events["turn.started"]!({}, child.ctx);
    eq(untrustedIngestedThisTurn(), false, "[A] 🔴 NEGATIVE CONTROL: a child of a CLEAN parent starts clean — asserted `=== false`, not merely falsy");
  });
  await turnThatWrites(child, () => {
    parent.sandbox.put("MEMORY.md", `${SEEDED}- 2026-08-27: Bo signs the payouts\n`);
  });
  ok(!MARKED(lineWith(child, "Bo signs the payouts")), "[A] 🔴 NEGATIVE CONTROL: a bullet added on a CLEAN turn takes no mark");
}

console.log("B — a CONTINUATION of the same child, from the parent's SECOND tainted turn:");
{
  const parent = makeSeat("cont-parent", "standing");
  parent.sandbox.put("MEMORY.md", SEEDED);

  await taintedParentTurn(parent, 1, ["web"]);
  const child = makeChild(parent, "cont-child", 0, "cont-parent-turn-1", "call_b1");
  await inSession(child, async () => {
    await taint.events["turn.started"]!({}, child.ctx);
    eq(untrustedIngestedThisTurn(), true, "[B] precondition: the child's FIRST turn adopts, as it always did");
  });

  await taintedParentTurn(parent, 2, ["notion"]);
  eq(
    parent.bag[OE_PARENT_TURN_TAINTED_ATTR],
    "cont-parent|cont-parent-turn-2|notion",
    "[B] the parent's SECOND tainted turn re-stamps its bag with its OWN turn id — which the pinned `session.parent.turn` no longer equals",
  );

  Object.assign(child.bag, parent.bag);
  child.ctx = childCtx(child, parent, 1, "cont-parent-turn-1", "call_b2");
  await turnThatWrites(child, () => {
    parent.sandbox.put("MEMORY.md", `${SEEDED}- 2026-08-27: Cy approves refunds\n`);
  });

  const bullet = lineWith(child, "Cy approves refunds");
  ok(
    MARKED(bullet),
    "[B] 🔴 THE CONTINUATION GAP IS CLOSED: the child's SECOND turn, from a still-tainted parent, adopts and its bullet is MARKED (RED before: `turn.sequence > 0` refused it, and the pinned parent turn never matched the new stamp)",
  );
  ok(bullet.includes("ingested notion]"), "[B] …and it names the SECOND turn's kind, not the first's — the stamp, not the pin, is what was read");
}
{
  const parent = makeSeat("stale-parent", "standing");
  parent.sandbox.put("MEMORY.md", SEEDED);
  await taintedParentTurn(parent, 1, ["web"]);

  const child = makeChild(parent, "stale-child", 0, "stale-parent-turn-1", "call_b3");
  await inSession(child, async () => {
    await taint.events["turn.started"]!({}, child.ctx);
    eq(untrustedIngestedThisTurn(), true, "[B] precondition: the first turn adopts the stamp");
  });

  child.bag[OE_PARENT_TURN_TAINTED_ATTR] = "stale-parent|stale-parent-turn-1|web";
  child.ctx = childCtx(child, parent, 1, "stale-parent-turn-1", "call_b4");
  await turnThatWrites(child, () => {
    parent.sandbox.put("MEMORY.md", `${SEEDED}- 2026-08-27: Dee runs the ledger\n`);
  });
  ok(
    !MARKED(lineWith(child, "Dee runs the ledger")),
    "[B] 🔴 NEGATIVE CONTROL: a stamp this child ALREADY adopted cannot re-taint a later turn — the memo keeps the one property the sequence gate carried",
  );
}

console.log("C — the kinds cross the hop, and only kinds the ingestion table names:");
{
  const parent = makeSeat("kind-parent", "standing");
  await taintedParentTurn(parent, 1, ["web", "github", "linear"]);
  const child = makeChild(parent, "kind-child", 0, "kind-parent-turn-1", "call_c1");
  await inSession(child, async () => {
    await taint.events["turn.started"]!({}, child.ctx);
    eq([...taintKindsThisTurn()], ["web", "github", "linear"], "[C] 🔴 every kind crosses the hop, in the parent's first-seen order");
  });
}
{
  const parent = makeSeat("forge-parent", "standing");
  const child = makeChild(parent, "forge-child", 0, "forge-parent-turn-1", "call_c2");
  child.bag[OE_DISPATCH_TURN_ATTR] = "forge-parent|forge-parent-turn-1";
  child.bag[OE_PARENT_TURN_TAINTED_ATTR] = "forge-parent|forge-parent-turn-1|web,not-a-real-kind";
  await inSession(child, async () => {
    await taint.events["turn.started"]!({}, child.ctx);
    eq(untrustedIngestedThisTurn(), true, "[C] the stamp still taints the child");
    eq([...taintKindsThisTurn()], ["web"], "[C] 🔴 a kind the ingestion table does not name is DROPPED — nothing off an auth bag names itself in a memory bullet");
  });
}
{
  const parent = makeSeat("bare-parent", "standing");
  const child = makeChild(parent, "bare-child", 0, "bare-parent-turn-1", "call_c3");
  child.bag[OE_DISPATCH_TURN_ATTR] = "bare-parent|bare-parent-turn-1";
  child.bag[OE_PARENT_TURN_TAINTED_ATTR] = "bare-parent|bare-parent-turn-1";
  await inSession(child, async () => {
    await taint.events["turn.started"]!({}, child.ctx);
    eq(untrustedIngestedThisTurn(), true, "[C] 🔴 a stamp with NO kind tail — the pre-OPE-1215 bytes — still taints; the tail is disclosure, never the signal");
    eq([...taintKindsThisTurn()], [], "[C] …and leaves the breakdown empty, which renders the unqualified wording");
  });
}

console.log("D — a non-`task` seat with a writable tier marks its own added bullets:");
for (const grain of ["standing", "native"]) {
  const seat = makeSeat(`arm-seat-${grain}`, grain);
  seat.sandbox.put("MEMORY.md", SEEDED);
  await turnThatWrites(seat, () => {
    markUntrustedIngestedThisTurn("web" as never);
    seat.sandbox.put("MEMORY.md", `${SEEDED}- 2026-08-27: Eve chairs the risk review\n`);
  });
  ok(
    MARKED(lineWith(seat, "Eve chairs the risk review")),
    `[D] 🔴 a ${grain}-grain seat's added bullet is MARKED (RED before: \`provenanceArmed\` required grain \`task\`, so this seat marked nothing by any mechanism)`,
  );
  ok(!MARKED(lineWith(seat, "pricing is reviewed quarterly")), `[D] …and the ${grain} seat's pre-existing bullet still takes no mark`);
}
{
  const seat = makeSeat("arm-seat-clean", "standing");
  seat.sandbox.put("MEMORY.md", SEEDED);
  await turnThatWrites(seat, () => {
    seat.sandbox.put("MEMORY.md", `${SEEDED}- 2026-08-27: Fay owns the runbook\n`);
  });
  ok(!MARKED(lineWith(seat, "Fay owns the runbook")), "[D] 🔴 NEGATIVE CONTROL: the same seat on a CLEAN turn marks nothing");
}

console.log("E — the cost of arming a seat, counted rather than asserted:");
{
  const seat = makeSeat("cost-seat", "standing");
  seat.sandbox.put("MEMORY.md", SEEDED);

  seat.sandbox.tierListings = 0;
  await inSession(seat, async () => {
    await taint.events["turn.started"]!({}, seat.ctx);
    await memory.events["turn.started"]!({}, seat.ctx);
  });
  eq(seat.sandbox.tierListings, 1, "[E] the session's FIRST turn boundary reads each writable tier exactly ONCE (one tier here) — the baseline capture");

  seat.sandbox.tierListings = 0;
  await inSession(seat, async () => {
    await memory.events["turn.completed"]!({}, seat.ctx);
  });
  eq(seat.sandbox.tierListings, 1, "[E] a turn END reads each writable tier exactly ONCE — the diff, with no amplification");

  seat.ctx = seatCtx(seat, 1);
  seat.sandbox.tierListings = 0;
  await inSession(seat, async () => {
    await taint.events["turn.started"]!({}, seat.ctx);
    await memory.events["turn.started"]!({}, seat.ctx);
  });
  eq(seat.sandbox.tierListings, 0, "[E] 🔴 a LATER turn boundary reads nothing — the baseline capture is once per session, so a long-lived seat pays the turn-end diff and nothing more");
}
{
  const seat = makeSeat("no-write-seat", "standing");
  seat.bag.channel_type = "mpim";
  seat.ctx = seatCtx(seat, 0);
  seat.sandbox.tierListings = 0;
  await inSession(seat, async () => {
    await memory.events["turn.started"]!({}, seat.ctx);
    await memory.events["turn.completed"]!({}, seat.ctx);
  });
  eq(seat.sandbox.tierListings, 0, "[E] 🔴 a session with an EMPTY write plan takes no sandbox read at all — the arm is the plan, and an empty plan costs nothing");
}

console.log("G — a mid-session re-sync's foreign bullets are NOT marked as this turn's:");
{
  const { overrideSettingsForTest } = await import("../agent/settings/settings.js");
  overrideSettingsForTest({ window: { topology: true } });
  try {
    const seat = makeSeat("resync-seat", "standing");
    seat.ctx = supervisorCtx(seat, 0);

    await inSession(seat, async () => {
      await memory.events["session.started"]!({}, seat.ctx);
      await taint.events["turn.started"]!({}, seat.ctx);
      await memory.events["turn.started"]!({}, seat.ctx);
      await memory.events["turn.completed"]!({}, seat.ctx);
    });
    ok((seat.sandbox.read("MEMORY.md") ?? "").includes("pricing is reviewed quarterly"), "[G] precondition: the silo materialised into the seat's sandbox");

    const FOREIGN = "- 2026-08-27: Gus signed the vendor contract";
    await brainProvider.writeTier(partitionOf(seat), BRAIN, { "MEMORY.md": `${SEEDED}${FOREIGN}\n` }, "concurrent", { name: SILO, provider: "fake-brain-join" } as never);

    seat.ctx = supervisorCtx(seat, 1);
    await inSession(seat, async () => {
      await taint.events["turn.started"]!({}, seat.ctx);
      await memory.events["turn.started"]!({}, seat.ctx);
      ok((seat.sandbox.read("MEMORY.md") ?? "").includes("Gus signed the vendor contract"), "[G] precondition: the REAL re-sync pulled the concurrent session's bullet into the sandbox — without this the section proves nothing");
      markUntrustedIngestedThisTurn("web" as never);
      seat.sandbox.put("MEMORY.md", `${seat.sandbox.read("MEMORY.md")}- 2026-08-27: Hal owns the vendor renewal\n`);
      await memory.events["turn.completed"]!({}, seat.ctx);
    });

    ok(
      !MARKED(lineWith(seat, "Gus signed the vendor contract")),
      "[G] 🔴 a bullet the mid-session re-sync pulled in from ANOTHER session is NOT marked as this turn's claim — the baseline is re-based over a re-materialised tier before the turn runs",
    );
    ok(
      MARKED(lineWith(seat, "Hal owns the vendor renewal")),
      "[G] 🔴 …and the bullet THIS turn really added IS marked — the re-base advances the baseline, it does not disarm the pass. Without this row the one above passes on a build that simply stopped marking",
    );
  } finally {
    overrideSettingsForTest({ window: { topology: false } });
  }
}

console.log("F — a real `tidyTick` over a silo holding a marked bullet:");
{
  const tidySchedule = await import("../agent/schedules/tidy.js");
  const MARK = `${EXTERNAL_PROVENANCE_PREFIX} added on a turn that ingested web]`;
  const MARKED_BULLET = `- Ada owns [[People]] billing  ${MARK}`;
  tiers.set(tierId(BRAIN), {
    files: {
      "MEMORY.md": ["## Notes", "- fact one", "- fact one", MARKED_BULLET, ""].join("\n"),
      "people.md": "# people\n",
    },
    version: 1,
  });

  const report = await tidySchedule.tidyTick({ now: new Date("2026-08-27T00:00:00Z"), orgs: ["default"] });
  ok(report.changed === 1, "[F] precondition: the tidy really changed the silo — without a write there is no fence to reach");

  const after = tiers.get(tierId(BRAIN))?.files ?? {};
  const lines = (after["MEMORY.md"] ?? "").split("\n");
  eq(lines.filter((l) => l === "- fact one").length, 1, "[F] precondition: the safe dedup landed, so the fence ADMITTED this rewrite rather than reverting the file");
  const survivor = lines.find((l) => l.includes("Ada owns")) ?? "";
  ok(MARKED(survivor), "[F] 🔴 THE PIN: a real `dream:tidy` leaves an existing external-provenance mark standing");
  ok(survivor.includes("[[people]]"), "[F] …even on a line the tidy REWROTE — link-repair canonicalised the wikilink inside the marked bullet and the mark rode through");
}

console.log(`\ntaint-provenance-join: ${n} assertions passed`);

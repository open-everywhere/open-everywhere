process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readAudit } from "../agent/audit/audit.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import type { OperationalStore } from "../agent/operational/store.js";
import {
  GENERATION_RETIRED_AUDIT_ACTION,
  GENERATION_RETIREMENT_PRINCIPAL,
  GENERATION_RETIREMENT_REASON,
  GENERATION_RETIRE_SKIPPED_AUDIT_ACTION,
  GENERATION_DELEGATION_TTL_MS,
  MAX_GENERATION_DELEGATIONS,
  MAX_PENDING,
  RESET_STATUS_RETIRED,
  clearGenerationDelegation,
  drainGenerationRetirements,
  generationOwedDelegation,
  noteGenerationDelegation,
  noteGenerationForRetirement,
  retirementVerdict,
  takeGenerationsForRetirement,
  __pendingGenerationRetirementsForTest,
  __resetGenerationRetirementsForTest,
  type RetirementFrom,
} from "../agent/channels/generation-retirement.js";
import { getOrCreateDmSeat, dmSeatThresholds } from "../agent/channels/dm-seat.js";
import { dmWindowRegistryKey, unifiedSupervisorToken } from "../agent/channels/unified-supervisor.js";
import { WAKE_TARGET_TTL_MS } from "../agent/channels/unified-window.js";

const REPO_ROOT = join(import.meta.dirname, "../../..");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const ORG = "acme";
const OUTGOING = unifiedSupervisorToken("payments", 1);
const INCOMING = unifiedSupervisorToken("payments", 2);
const REG = "oe-domain::payments";
const PER_CONTAINER = "C0EXCHAN013:oe-sup:g3";

const labelsFor = (token: string): { workspace: string; surface: string | undefined } => ({ workspace: "payments", surface: `oe-domain::${token.slice(0, 4)}` });

function recordingFrom(status: string = RESET_STATUS_RETIRED): { from: RetirementFrom; reset: { address: string; reason: string | undefined }[] } {
  const reset: { address: string; reason: string | undefined }[] = [];
  return {
    reset,
    from: (address: string) => ({
      async reset(options?: { readonly reason?: string }): Promise<{ readonly status?: string }> {
        reset.push({ address, reason: options?.reason });
        return { status };
      },
    }),
  };
}

const throwingFrom: RetirementFrom = () => ({
  async reset(): Promise<{ readonly status?: string }> {
    throw new Error("no such continuation address");
  },
});

function storeStub(input: {
  readonly row?: { readonly token: string } | null;
  readonly anchor?: unknown;
  readonly owed?: readonly string[];
  readonly throwOn?: "registry" | "turn" | "delegation";
}): Pick<OperationalStore, "getChannelSession" | "getTurnAnchorByWindow" | "getTaskResult"> {
  return {
    async getChannelSession() {
      if (input.throwOn === "registry") throw new Error("store blip");
      return (input.row ?? null) as never;
    },
    async getTurnAnchorByWindow() {
      if (input.throwOn === "turn") throw new Error("store blip");
      return (input.anchor ?? null) as never;
    },
    async getTaskResult() {
      if (input.throwOn === "delegation") throw new Error("store blip");
      return input.owed === undefined ? null : JSON.stringify({ tasks: input.owed });
    },
  } as Pick<OperationalStore, "getChannelSession" | "getTurnAnchorByWindow" | "getTaskResult">;
}

async function rowsFor(action: string): Promise<readonly { detail?: Record<string, unknown>; principalId?: string; platform?: string; workspace?: string; surface?: string }[]> {
  return await readAudit({ org: ORG, action });
}

{
  __resetGenerationRetirementsForTest();
  noteGenerationForRetirement({ org: ORG, registryKey: REG, token: OUTGOING });
  eq(__pendingGenerationRetirementsForTest().length, 1, "a window token's generation is noted for retirement");
  eq(__pendingGenerationRetirementsForTest()[0]?.token, OUTGOING, "…under its own bare token");

  noteGenerationForRetirement({ org: ORG, registryKey: "slack/T1/C1", token: PER_CONTAINER });
  eq(__pendingGenerationRetirementsForTest().length, 1, "🔴 a PER-CONTAINER token is REFUSED — only `unified` seats are ever retired");

  noteGenerationForRetirement({ org: ORG, registryKey: REG, token: OUTGOING });
  eq(__pendingGenerationRetirementsForTest().length, 1, "the note is idempotent per (org, token) — a rotate leg reached twice notes once");

  noteGenerationForRetirement({ org: "other", registryKey: REG, token: OUTGOING });
  eq(__pendingGenerationRetirementsForTest().length, 2, "…but the SAME token in another org is a different generation");
  eq(takeGenerationsForRetirement("other").length, 1, "a take is org-scoped…");
  eq(__pendingGenerationRetirementsForTest().length, 1, "…and removes only that org's entries");
  eq(takeGenerationsForRetirement(ORG).length, 1, "a take drains what is left");
  eq(takeGenerationsForRetirement(ORG).length, 0, "🔴 a taken entry is NEVER re-queued — a skipped generation waits for the seat's next rotation, not for a retry");

  __resetGenerationRetirementsForTest();
  for (let i = 0; i < MAX_PENDING + 10; i++) noteGenerationForRetirement({ org: ORG, registryKey: REG, token: unifiedSupervisorToken("payments", i + 100) });
  eq(__pendingGenerationRetirementsForTest().length, MAX_PENDING, `the list is capped at ${String(MAX_PENDING)}`);
  eq(
    __pendingGenerationRetirementsForTest()[MAX_PENDING - 1]?.token,
    unifiedSupervisorToken("payments", MAX_PENDING + 109),
    "…and it is the NEWEST notes that survive",
  );
  __resetGenerationRetirementsForTest();
}

{
  const base = { token: OUTGOING, incomingToken: INCOMING, registry: "rotated" as const, turn: "none" as const, delegation: "none" as const };
  eq(retirementVerdict(base), "retire", "a rotated generation with no live turn and no owed worker is RETIRED");
  eq(retirementVerdict({ ...base, incomingToken: OUTGOING }), "skip-incoming", "🔴 the token this wake is being delivered to is never retired");
  eq(retirementVerdict({ ...base, registry: "still-live" }), "skip-still-live", "🔴 a registry row still pointing at the token means the rotation did not complete");
  eq(retirementVerdict({ ...base, turn: "live" }), "skip-live-turn", "🔴 a live turn is not cancelled to reap a worker");
  eq(retirementVerdict({ ...base, delegation: "owed" }), "skip-owed-delegation", "🔴 OPE-1620: a generation that still owes a worker its answer is not retired — eve's reaper does not spare a `working` task");
  eq(retirementVerdict({ ...base, registry: "unreadable" }), "skip-unreadable", "an unreadable registry refuses — a read that proves nothing is not permission");
  eq(retirementVerdict({ ...base, turn: "unreadable" }), "skip-unreadable", "…and so does an unreadable anchor");
  eq(retirementVerdict({ ...base, delegation: "unreadable" }), "skip-unreadable", "🔴 …and so does an unreadable owed-delegation row — the third read fails in the same direction as the other two");
  eq(
    retirementVerdict({ token: OUTGOING, incomingToken: OUTGOING, registry: "unreadable", turn: "live", delegation: "owed" }),
    "skip-incoming",
    "the incoming guard is decided first, so it names the real reason even when every read also refuses",
  );
  eq(
    retirementVerdict({ ...base, turn: "live", delegation: "owed" }),
    "skip-live-turn",
    "a generation with BOTH a live turn and an owed worker is audited as the live turn — the fact that would cost a human's turn a \"Stood down\" note",
  );
}

{
  __resetGenerationRetirementsForTest();
  noteGenerationForRetirement({ org: ORG, registryKey: REG, token: OUTGOING });
  const { from, reset } = recordingFrom();
  await drainGenerationRetirements(from, { org: ORG, incomingToken: INCOMING }, { store: storeStub({ row: { token: INCOMING } }), labelsFor });
  eq(reset.length, 1, "🔴 exactly one reset is issued for one rotated generation");
  eq(reset[0]?.address, OUTGOING, "🔴 …addressed to the OUTGOING token, which is what runs eve's child reaper over that generation's parked workers");
  eq(reset[0]?.reason, GENERATION_RETIREMENT_REASON, "…carrying the documented reason");

  const rows = await rowsFor(GENERATION_RETIRED_AUDIT_ACTION);
  eq(rows.length, 1, "one audit row per retirement");
  eq(rows[0]?.detail?.token, OUTGOING, "…naming the retired generation's token");
  eq(rows[0]?.detail?.registryKey, REG, "…and the registry row it was rotated out of");
  eq(rows[0]?.principalId, GENERATION_RETIREMENT_PRINCIPAL, "…stamped with the synthetic service principal (no human acted)");
  eq(rows[0]?.platform, "unified", "…partitioned like every other row the unified channel writes");
  eq(rows[0]?.workspace, "payments", "…with the workspace label the channel's own derivation supplies");
  eq(__pendingGenerationRetirementsForTest().length, 0, "the drain leaves nothing behind");
}

{
  __resetGenerationRetirementsForTest();
  noteGenerationForRetirement({ org: ORG, registryKey: REG, token: OUTGOING });
  const before = (await rowsFor(GENERATION_RETIRED_AUDIT_ACTION)).length;
  const { from, reset } = recordingFrom("no_active_session");
  await drainGenerationRetirements(from, { org: ORG, incomingToken: INCOMING }, { store: storeStub({ row: { token: INCOMING } }), labelsFor });
  eq(reset.length, 1, "the reset was still ISSUED — this arm is about what eve answered, not about refusing to ask");
  eq((await rowsFor(GENERATION_RETIRED_AUDIT_ACTION)).length, before, "🔴 …and NO retirement row was written for a session eve never opened");
  const rows = (await rowsFor(GENERATION_RETIRE_SKIPPED_AUDIT_ACTION)).filter((r) => r.detail?.skipped === "no-active-session");
  eq(rows.length, 1, "🔴 it is audited as a skip instead, so the reap census stays honest");
  eq(rows[0]?.detail?.status, "no_active_session", "…carrying eve's own status verbatim");
}

{
  __resetGenerationRetirementsForTest();
  noteGenerationForRetirement({ org: ORG, registryKey: REG, token: OUTGOING });
  const { from, reset } = recordingFrom();
  await drainGenerationRetirements(
    from,
    { org: ORG, incomingToken: INCOMING },
    { store: storeStub({ row: { token: INCOMING }, anchor: { org: ORG, windowKey: OUTGOING } }), labelsFor },
  );
  eq(reset.length, 0, "🔴 NO reset is issued while the outgoing generation has a live turn");
  const rows = (await rowsFor(GENERATION_RETIRE_SKIPPED_AUDIT_ACTION)).filter((r) => r.detail?.skipped === "skip-live-turn");
  eq(rows.length, 1, "🔴 …and the skip is AUDITED, never silent — a generation whose workers were not reaped stays visible");
  eq(rows[0]?.detail?.token, OUTGOING, "…naming the generation that was left alone");
}

{
  __resetGenerationRetirementsForTest();
  noteGenerationForRetirement({ org: ORG, registryKey: REG, token: OUTGOING });
  const { from, reset } = recordingFrom();
  await drainGenerationRetirements(from, { org: ORG, incomingToken: INCOMING }, { store: storeStub({ row: { token: OUTGOING } }), labelsFor });
  eq(reset.length, 0, "🔴 NO reset while the registry row still points at the token — the seat is still using it");
  const rows = (await rowsFor(GENERATION_RETIRE_SKIPPED_AUDIT_ACTION)).filter((r) => r.detail?.skipped === "skip-still-live");
  eq(rows.length, 1, "…and that skip is audited too");
}

{
  __resetGenerationRetirementsForTest();
  noteGenerationForRetirement({ org: ORG, registryKey: REG, token: INCOMING });
  const { from, reset } = recordingFrom();
  await drainGenerationRetirements(from, { org: ORG, incomingToken: INCOMING }, { store: storeStub({ row: { token: INCOMING } }), labelsFor });
  eq(reset.length, 0, "🔴 the FRESH generation this wake is being delivered to is never retired");
  const rows = (await rowsFor(GENERATION_RETIRE_SKIPPED_AUDIT_ACTION)).filter((r) => r.detail?.skipped === "skip-incoming");
  eq(rows.length, 1, "…and the refusal is audited, so a caller that keeps producing it is findable");
}

{
  for (const throwOn of ["registry", "turn"] as const) {
    __resetGenerationRetirementsForTest();
    noteGenerationForRetirement({ org: ORG, registryKey: REG, token: OUTGOING });
    const { from, reset } = recordingFrom();
    await drainGenerationRetirements(from, { org: ORG, incomingToken: INCOMING }, { store: storeStub({ throwOn }), labelsFor });
    eq(reset.length, 0, `🔴 a thrown ${throwOn} read refuses the retirement — the opposite direction to the tail read's fail-soft, because a reset cannot be undone`);
  }
  const rows = (await rowsFor(GENERATION_RETIRE_SKIPPED_AUDIT_ACTION)).filter((r) => r.detail?.skipped === "skip-unreadable");
  eq(rows.length, 2, "…both refusals are audited");
}

{
  __resetGenerationRetirementsForTest();
  noteGenerationForRetirement({ org: ORG, registryKey: REG, token: OUTGOING });
  await drainGenerationRetirements(throwingFrom, { org: ORG, incomingToken: INCOMING }, { store: storeStub({ row: { token: INCOMING } }), labelsFor });
  n++;
  const rows = (await rowsFor(GENERATION_RETIRE_SKIPPED_AUDIT_ACTION)).filter((r) => r.detail?.skipped === "reset-failed");
  eq(rows.length, 1, "🔴 a reset eve refuses is audited as a failed retirement, and the wake it rode is unaffected");
  ok(typeof rows[0]?.detail?.error === "string" && (rows[0].detail.error as string).includes("continuation address"), "…with eve's own refusal text on the row");
}

{
  __resetGenerationRetirementsForTest();
  noteGenerationForRetirement({ org: ORG, registryKey: REG, token: OUTGOING });
  const neverResolves: RetirementFrom = () => ({ reset: async () => await new Promise<{ readonly status?: string }>(() => undefined) });
  const startedAt = Date.now();
  await drainGenerationRetirements(
    neverResolves,
    { org: ORG, incomingToken: INCOMING },
    { store: storeStub({ row: { token: INCOMING } }), labelsFor, confirmTimeoutMs: 50 },
  );
  ok(Date.now() - startedAt < 2_000, "🔴 the drain returns on its own bound rather than waiting on eve forever");
  const rows = (await rowsFor(GENERATION_RETIRE_SKIPPED_AUDIT_ACTION)).filter((r) => r.detail?.skipped === "reset-unconfirmed");
  eq(rows.length, 1, "…and the unconfirmed retirement is audited as such, never as a completed one");
  eq((await rowsFor(GENERATION_RETIRED_AUDIT_ACTION)).filter((r) => r.detail?.token === OUTGOING).length, 1, "NEGATIVE CONTROL: only §3's real retirement claims the retired action");
}

{
  __resetGenerationRetirementsForTest();
  const before = (await rowsFor(GENERATION_RETIRED_AUDIT_ACTION)).length + (await rowsFor(GENERATION_RETIRE_SKIPPED_AUDIT_ACTION)).length;
  const { from, reset } = recordingFrom();
  await drainGenerationRetirements(from, { org: ORG, incomingToken: INCOMING }, { store: storeStub({ row: { token: INCOMING } }), labelsFor });
  eq(reset.length, 0, "🔴 a NON-ROTATING window's wake retires nothing");
  const after = (await rowsFor(GENERATION_RETIRED_AUDIT_ACTION)).length + (await rowsFor(GENERATION_RETIRE_SKIPPED_AUDIT_ACTION)).length;
  eq(after, before, "🔴 …and writes no audit row at all — the feature is silent on the path it does not own");
}

{
  __resetGenerationRetirementsForTest();
  const store = getOperationalStore();
  const dm = { surfaceKey: "slack/T1/D9RETIRE" };
  const key = dmWindowRegistryKey(dm.surfaceKey);
  const minted = await getOrCreateDmSeat(ORG, dm, "2026-01-01T00:00:00.000Z", { store });
  eq(__pendingGenerationRetirementsForTest().length, 0, "the ADOPT arm notes nothing — there is no outgoing generation to retire");

  const rotated = await getOrCreateDmSeat(ORG, dm, "2026-03-01T00:00:00.000Z", { store, thresholds: { ...dmSeatThresholds(), expiryMs: 1_000 } });
  ok(rotated.generation > minted.generation, "the seat really rotated (generation advanced)");
  const noted = __pendingGenerationRetirementsForTest();
  eq(noted.length, 1, "🔴 THE WIRING: a real rotation notes exactly one outgoing generation, with no help from this test");
  eq(noted[0]?.token, minted.token, "🔴 …and it is the OUTGOING generation's token, not the fresh one's");
  eq(noted[0]?.registryKey, key, "…filed under the seat's own registry key");

  const { from, reset } = recordingFrom();
  await drainGenerationRetirements(from, { org: ORG, incomingToken: rotated.token }, { store, labelsFor });
  eq(reset.length, 1, "🔴 END TO END: the rotation's outgoing generation is retired on the next unified wake");
  eq(reset[0]?.address, minted.token, "…addressed to the generation that was rotated away");
  const live = await store.getChannelSession(ORG, key);
  eq(live?.token, rotated.token, "NEGATIVE CONTROL: the registry still points at the FRESH generation — the retirement did not touch the live seat");
}

{
  const tail = readFileSync(join(REPO_ROOT, "packages/core/agent/channels/session-tail-record.ts"), "utf8");
  ok(
    /noteGenerationForRetirement\(\{ org, registryKey, token: outgoingToken \}\);/.test(tail),
    "🔴 `carryTailForward` — the one seam every standing seat's rotate leg calls — still notes the outgoing generation",
  );
  ok(
    tail.indexOf("noteGenerationForRetirement(") < tail.indexOf("await store.readSessionTail("),
    "…BEFORE the tail read, so a store failure that loses the tail does not also lose the retirement",
  );

  const work = readFileSync(join(REPO_ROOT, "packages/core/agent/channels/work-generation.ts"), "utf8");
  ok(
    /noteGenerationForRetirement\(\{ org: input\.org, registryKey, token: existing\.token \}\);/.test(work),
    "🔴 the work session's rotation — the rotate leg a fire meets since OPE-2350 — notes the outgoing generation too",
  );

  const unified = readFileSync(join(REPO_ROOT, "packages/core/agent/channels/unified.ts"), "utf8");
  ok(
    /await drainGenerationRetirements\(from, \{ org, incomingToken: t\.token \}, \{ labelsFor: auditLabels \}\);/.test(unified),
    "🔴 the unified `receive` drains the retirements, passing the CHANNEL'S OWN audit labels — one derivation, no drift",
  );
  ok(
    unified.indexOf("await drainGenerationRetirements(") < unified.indexOf("if (t.answer) {"),
    "…before both delivery branches, so the answer leg's early return cannot skip it",
  );
}

async function rawOwedRow(store: Pick<OperationalStore, "getTaskResult">, token: string): Promise<readonly string[]> {
  const raw = await store.getTaskResult(ORG, `oe-gen-owes:${token}`);
  return raw === null ? [] : ((JSON.parse(raw) as { tasks: string[] }).tasks ?? []);
}

{
  const store = getOperationalStore();
  const GEN_A = unifiedSupervisorToken("payments", 900);
  const GEN_B = unifiedSupervisorToken("payments", 901);

  eq(GENERATION_DELEGATION_TTL_MS, WAKE_TARGET_TTL_MS, "🔴 the ledger TTL IS the wake-target TTL — past it the task's own wake row has expired, so its report could not be delivered anyway");

  await noteGenerationDelegation(ORG, GEN_A, "task-1", store);
  eq(await generationOwedDelegation(ORG, GEN_A, store), "owed", "🔴 §12a: a dispatch under generation A is recorded as owed BY GENERATION A");
  eq(await generationOwedDelegation(ORG, GEN_B, store), "none", "🔴 §12a NEGATIVE CONTROL: …and generation B owes nothing — the row is keyed on the token, not on the deployment");

  await noteGenerationDelegation(ORG, GEN_A, "task-1", store);
  eq((await rawOwedRow(store, GEN_A)).length, 1, "§12b: re-recording one task id does not double it");
  await noteGenerationDelegation(ORG, GEN_A, "task-2", store);
  eq((await rawOwedRow(store, GEN_A)).length, 2, "§12b: …and a second dispatch is a second owed task");

  await clearGenerationDelegation(ORG, "task-1", store);
  eq(await rawOwedRow(store, GEN_A), ["task-2"], "🔴 §12c: a settlement clears the task from the generation that DISPATCHED it, not from the seat's current one — and leaves its other owed task alone");
  eq(await generationOwedDelegation(ORG, GEN_A, store), "owed", "§12c: …so the generation still owes, and is still not retirable");
  await clearGenerationDelegation(ORG, "task-2", store);
  eq(await store.getTaskResult(ORG, `oe-gen-owes:${GEN_A}`), null, "🔴 §12c: the LAST settlement DELETES the row — an absent row and a row owing nothing are the same answer, and the keyspace does not grow per generation ever rotated");

  await clearGenerationDelegation(ORG, "task-never-dispatched", store);
  n++;

  await noteGenerationDelegation(ORG, PER_CONTAINER, "task-per-container", store);
  eq(await store.getTaskResult(ORG, `oe-gen-owes:${PER_CONTAINER}`), null, "🔴 §12e: a PER-CONTAINER token records nothing — the same refusal the note side makes");
  await noteGenerationDelegation(ORG, undefined, "task-no-token", store);
  n++;

  const CAPPED = unifiedSupervisorToken("payments", 902);
  for (let i = 0; i < MAX_GENERATION_DELEGATIONS + 5; i++) await noteGenerationDelegation(ORG, CAPPED, `cap-task-${String(i)}`, store);
  eq((await rawOwedRow(store, CAPPED)).length, MAX_GENERATION_DELEGATIONS, `§12f: the owed list is capped at ${String(MAX_GENERATION_DELEGATIONS)}`);

  const JUNK = unifiedSupervisorToken("payments", 903);
  for (const junk of ["not json at all", "null", '{"tasks":"nope"}', '{"tasks":[1,2,{}]}', "{}"]) {
    await store.putTaskResult(ORG, `oe-gen-owes:${JUNK}`, junk, new Date().toISOString(), GENERATION_DELEGATION_TTL_MS);
    eq(await generationOwedDelegation(ORG, JUNK, store), "none", `🔴 §12g: a stored value of ${JSON.stringify(junk)} reads as "owes nothing" rather than holding the generation un-reapable forever`);
  }

  const throwingStore = {
    async getTaskResult() {
      throw new Error("store blip");
    },
    async putTaskResult() {
      throw new Error("store blip");
    },
    async deleteTaskResult() {
      throw new Error("store blip");
    },
  } as unknown as Pick<OperationalStore, "getTaskResult" | "putTaskResult" | "deleteTaskResult">;
  await noteGenerationDelegation(ORG, GEN_A, "task-blip", throwingStore);
  await clearGenerationDelegation(ORG, "task-blip", throwingStore);
  n += 2;
  eq(await generationOwedDelegation(ORG, GEN_A, throwingStore), "unreadable", "🔴 §12h: …but a THROWN read answers `unreadable`, which the verdict turns into a refusal — the write fails soft and the read fails closed");
}

{
  __resetGenerationRetirementsForTest();
  noteGenerationForRetirement({ org: ORG, registryKey: REG, token: OUTGOING });
  const { from, reset } = recordingFrom();
  await drainGenerationRetirements(
    from,
    { org: ORG, incomingToken: INCOMING },
    { store: storeStub({ row: { token: INCOMING }, owed: ["task-still-working"] }), labelsFor },
  );
  eq(reset.length, 0, "🔴 §13: NO reset is issued while the outgoing generation still owes a worker its answer");
  const rows = (await rowsFor(GENERATION_RETIRE_SKIPPED_AUDIT_ACTION)).filter((r) => r.detail?.skipped === "skip-owed-delegation");
  eq(rows.length, 1, "🔴 §13: …and the skip is AUDITED, never silent — a generation whose workers were not reaped stays visible");
  eq(rows[0]?.detail?.token, OUTGOING, "§13: …naming the generation that was left alone");
  eq(
    __pendingGenerationRetirementsForTest().length,
    0,
    "🔴 §13: the entry is NOT re-queued, and the skip is therefore FINAL — this generation is never retired by this module, whatever the worker does next (the cost §THE OWED-DELEGATION GUARD'S ONE COST states)",
  );

  __resetGenerationRetirementsForTest();
  noteGenerationForRetirement({ org: ORG, registryKey: REG, token: OUTGOING });
  const clear = recordingFrom();
  await drainGenerationRetirements(clear.from, { org: ORG, incomingToken: INCOMING }, { store: storeStub({ row: { token: INCOMING }, owed: [] }), labelsFor });
  eq(clear.reset.length, 1, "🔴 §13 NEGATIVE CONTROL: a generation whose ledger row is EMPTY is retired normally");

  __resetGenerationRetirementsForTest();
  noteGenerationForRetirement({ org: ORG, registryKey: REG, token: OUTGOING });
  const blind = recordingFrom();
  await drainGenerationRetirements(blind.from, { org: ORG, incomingToken: INCOMING }, { store: storeStub({ row: { token: INCOMING }, throwOn: "delegation" }), labelsFor });
  eq(blind.reset.length, 0, "🔴 §13: a THROWN owed-delegation read refuses the retirement — a read that proves nothing is not permission");

  const taint = readFileSync(join(REPO_ROOT, "packages/core/agent/hooks/spawn-taint.ts"), "utf8");
  ok(
    /await noteGenerationDelegation\(deploymentOrg\(\), ownWindowToken, started\.taskId\);/.test(taint),
    "🔴 §13: the DISPATCH edge (the `task.started` handler at eve 0.70) records the owed delegation against the seat's own window token",
  );
  ok(
    /await clearGenerationDelegation\(deploymentOrg\(\), view\.taskId\);/.test(taint),
    "🔴 §13: …and the SETTLEMENT edge clears it, so a settled task stops blocking its generation's reap",
  );
  ok(
    taint.indexOf("await noteGenerationDelegation(") < taint.indexOf("noteTaskDispatched(started.taskId);"),
    "§13: the record is written on the dispatch edge, beside the session-local one it makes durable",
  );
}


console.log(`✓ generation-retirement: ${String(n)} assertions passed (OPE-627: rotation retires the outgoing generation, so eve's child reaper takes its parked workers; OPE-1620: and never while that generation still owes a live delegation)`);

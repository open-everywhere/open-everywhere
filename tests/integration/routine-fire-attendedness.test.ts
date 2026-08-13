import { afterEach, expect, test } from "vitest";
import {
  bootAgent,
  discordMentionWake,
  readAuditRows,
  registerScript,
  runRoutineDispatchTick,
  seedDueRoutine,
  waitFor,
  type AuditRow,
  type ScriptedHandle,
  type SeatScript,
} from "./harness";

const perTest: (() => void)[] = [];
afterEach(() => {
  for (const c of perTest.splice(0)) c();
});

function disposeLater(handle: ScriptedHandle): ScriptedHandle {
  perTest.push(() => handle.dispose());
  return handle;
}

const CREATOR = "U0FIRECREATOR";
const TEAM = "T0ITFIRE";
const CHANNEL = "C0ITFIRE";
const DISCORD_UNLISTED = "9000000000000000777";

function proposeSpendLimit(): SeatScript {
  return {
    parent: [
      { calls: [{ tool: "set_spend_limit", input: { monthlyUsd: 12.5, reason: "OPE-483 carriage probe" } }] },
      { say: "ok" },
    ],
  };
}

function spendLimitResult(handle: ScriptedHandle): { isError: boolean; output: unknown } | undefined {
  for (const req of handle.requests) {
    const hit = req.toolResults.find((t) => t.name === "set_spend_limit");
    if (hit) return { isError: hit.isError, output: hit.output };
  }
  return undefined;
}

function chainRowFor(rows: readonly AuditRow[], tool: string): AuditRow | undefined {
  return rows.find((r) => (r.detail as { tool?: string } | undefined)?.tool === tool);
}

test("a REAL routine fire arrives with NO acting sender — the presence fence refuses its proposal", async () => {
  await bootAgent({ sharedSqlite: true });
  const handle = disposeLater(registerScript(proposeSpendLimit()));
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  const routineId = await seedDueRoutine({
    surfaceKey: `slack/${TEAM}/${CHANNEL}`,
    channelId: CHANNEL,
    prompt: "check the spend cap and raise it if it is too low",
    createdBy: CREATOR,
  });
  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length).toBeGreaterThan(0);

  const result = await waitFor(() => spendLimitResult(handle), "the fire's set_spend_limit call to return", 150_000);

  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.output)).toContain("no acting sender");

  const requested = await readAuditRows({ actions: ["approval.requested"], sinceIso });
  expect(requested.find((r) => r.surface === CHANNEL)).toBeUndefined();

  expect(routineId).toMatch(/^r-it-/);
});

test("the fired session binds as its routine's ATTESTED creator", async () => {
  await bootAgent({ sharedSqlite: true });
  disposeLater(registerScript({ parent: [{ say: "nothing to report" }] }));
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  await seedDueRoutine({
    surfaceKey: `slack/${TEAM}/${CHANNEL}`,
    channelId: CHANNEL,
    prompt: "say nothing",
    createdBy: CREATOR,
  });
  expect((await runRoutineDispatchTick()).length).toBeGreaterThan(0);

  const started = await waitFor(
    async () => (await readAuditRows({ actions: ["egress.policy"], sinceIso })).find((r) => r.surface === CHANNEL),
    "a session.started egress.policy row for the fire",
    150_000,
  );
  expect(started.principalId).toBe(CREATOR);
  expect(started.principalId).not.toBe("eve:app");
});

test("NEGATIVE CONTROL — an ATTENDED wake proposing the same verb passes the fence and cards, unattended:false", async () => {
  await bootAgent({ sharedSqlite: true });
  disposeLater(registerScript(proposeSpendLimit()));
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  await discordMentionWake({ channelId: DISCORD_UNLISTED, text: `<@9000000000000000001> please raise the monthly cap` });

  const chain = await waitFor(
    async () => chainRowFor(await readAuditRows({ actions: ["approval.chain"], sinceIso }), "set_spend_limit"),
    "an approval.chain row for the human's set_spend_limit proposal",
    150_000,
  );
  const detail = chain.detail as { unattended?: unknown; verdict?: unknown; transforms?: readonly { reason?: string }[] };
  expect(detail.unattended).toBe(false);
  expect(detail.verdict).toBe("ask");
  expect((detail.transforms ?? []).map((t) => t.reason)).not.toContain("ask-unattended");
});

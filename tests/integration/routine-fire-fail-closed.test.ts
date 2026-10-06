import { expect, test } from "vitest";
import { auditCursor, disposeLater, bootAgent, registerScript, rowsSinceCursor, runRoutineDispatchTick, waitFor, type ScriptedHandle, type SeatScript } from "./harness";

const TEAM = "T0FCFIRE";
const CHANNEL = "C0FCFIRE";

async function seedCreatorlessDueRoutine(surfaceKey: string, channelId: string, prompt: string): Promise<string> {
  if (process.env.OE_OPERATIONAL_PROVIDER !== "sqlite") {
    throw new Error("this test needs bootAgent({ sharedSqlite: true }) — PGlite is single-writer.");
  }
  const { addRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const { randomBytes } = await import("node:crypto");
  const id = `r-it-fc-${randomBytes(4).toString("hex")}`;
  const [platform = "slack", workspace = "", surface = ""] = surfaceKey.split("/");
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  await addRoutine(
    {
      org: "default",
      platform,
      workspace,
      surface,
      workspaceKey: `${platform}/${workspace}`,
      surfaceKey,
      domainKey: surfaceKey,
      key: surfaceKey,
    },
    {
      id,
      org: "default",
      surfaceKey,
      target: { channelId },
      trigger: { kind: "once", at: dueAt },
      prompt,
      status: "active",
      nextRunAt: dueAt,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      promptGeneration: 1,
      consecutiveFailures: 0,
    },
  );
  return id;
}

function proposeSpendLimit(): SeatScript {
  return {
    parent: [{ say: "NO_REPLY" }],
    child: [
      { calls: [{ tool: "set_spend_limit", input: { monthlyUsd: 12.5, reason: "OPE-497 fail-closed probe" } }] },
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

test("a CREATOR-LESS routine fire, forwarded to the work session, still has no acting sender in its worker", async () => {
  await bootAgent({ sharedSqlite: true });
  const handle = disposeLater(registerScript(proposeSpendLimit()));
  const cursor = await auditCursor();

  const routineId = await seedCreatorlessDueRoutine(
    `slack/${TEAM}/${CHANNEL}`,
    CHANNEL,
    "check the spend cap and raise it if it is too low",
  );
  expect(routineId).toMatch(/^r-it-fc-/);

  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length).toBeGreaterThan(0);

  const forwarded = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["work.forwarded"])).find((r) => String(r.surface ?? "").endsWith(`/${CHANNEL}`)),
    "the creator-less fire's work.forwarded row",
    150_000,
  );
  expect(forwarded.action).toBe("work.forwarded");

  const result = await waitFor(() => spendLimitResult(handle), "the worker's set_spend_limit call to return", 150_000);

  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.output)).toContain("no acting sender");
});

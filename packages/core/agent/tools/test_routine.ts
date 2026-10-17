import { randomBytes } from "node:crypto";
import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { actingPrincipalIdOf } from "../access/request.js";
import { getRoutine, updateRoutine } from "../routines/store.js";
import { describeTrigger } from "../routines/routine.js";
import { routineWords } from "../routines/schedule-words.js";
import { ROUTINE_TEST_REQUESTED_ACTION, testRunRefusal } from "../routines/test-run.js";
import { DISPATCH_TICK_MINUTES } from "../routines/schedule.js";
import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";

const TEST_WINDOW_MS = DISPATCH_TICK_MINUTES * 60_000;

function testThrottleKey(routineId: string): string {
  return `routinetest:${routineId}`;
}

function newTestId(): string {
  return `t-${randomBytes(4).toString("hex")}`;
}

export default defineTool({
  description:
    "Run an existing routine ONCE as a TEST, without letting it change anything. Use it when someone wants to try a routine they just set up or edited ('test it', 'try it first', 'what would it post?'). " +
    "The test runs the routine's real reads and the real model, in a new thread in this room. It BLOCKS every write and every post outside that thread, and it ends with a list of the writes the routine would have made. " +
    "It does not run instantly: the scheduler starts it within a few minutes — say so in plain words. It does not touch the schedule, the run history or any counter. " +
    "Use run_routine_now instead only when the person wants a REAL run that posts and writes. Get the id from list_routines.",
  inputSchema: z.object({
    id: z.string().min(1).describe("The routine id, e.g. 'r-1a2b3c4d' (from list_routines)."),
  }),
  outputSchema: z.object({
    queued: z.boolean().describe("True when this call queued the test. False = refused (see message)."),
    withinMinutes: z.number().describe("Worst-case wait before the test starts, in minutes (the dispatcher tick cadence)."),
    message: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const p = resolvePartition(ctx);
    const id = input.id.trim();

    const requestedBy = actingPrincipalIdOf(ctx);
    if (!requestedBy) {
      throw new Error(
        "test_routine needs a verified sender — an unattended routine fire has no acting sender, and a routine may not start a test of itself or another routine. Ask a person in this conversation to test it.",
      );
    }

    const routine = await getRoutine(p.org, p.surfaceKey, id);
    if (!routine) {
      throw new Error(`No routine '${id}' on this surface — check the id with list_routines.`);
    }
    const name = routineWords(describeTrigger(routine.trigger, routine.report));
    const refusal = testRunRefusal(routine);
    if (refusal !== null) {
      return { queued: false, withinMinutes: DISPATCH_TICK_MINUTES, message: `I can't test ${name}: ${refusal}.` };
    }

    const nowIso = new Date().toISOString();
    let first = true;
    try {
      first = await getOperationalStore().markEventSeen(p.org, testThrottleKey(id), nowIso, TEST_WINDOW_MS);
    } catch {
      first = true;
    }
    if (!first) {
      return { queued: false, withinMinutes: DISPATCH_TICK_MINUTES, message: `A test of ${name} is already queued. It starts within ${DISPATCH_TICK_MINUTES} minutes.` };
    }

    const test = { id: newTestId(), requestedBy, requestedAt: nowIso };
    await updateRoutine(p.org, p.surfaceKey, id, { testRun: test });
    await appendAudit({
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      ...(p.surface === undefined ? {} : { surface: p.surface }),
      principalId: requestedBy,
      action: ROUTINE_TEST_REQUESTED_ACTION,
      detail: { id, test: test.id },
    });

    return {
      queued: true,
      withinMinutes: DISPATCH_TICK_MINUTES,
      message:
        `A test of ${name} starts within ${DISPATCH_TICK_MINUTES} minutes, in a new thread in this room. ` +
        "It runs the real reads and model, blocks every write, and ends with a list of what it would have changed.",
    };
  },
});

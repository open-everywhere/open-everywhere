import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { ingestUntrustedModelOutput } from "../access/untrusted.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import { resolvePartition } from "../memory/partition.js";
import type { BindableContext } from "../identity/binding.js";
import {
  TRANSCRIPT_RELAY_MAX_FIRE_DEPTH,
  fetchRoutineTranscript,
  transcriptRelayConfigured,
} from "../control/transcript-relay.js";

const entry = defineTool({
  description:
    "Read the transcript of a past routine run in THIS channel — what it was woken with, what it did, which tools it called and what they returned. Use when asked what a scheduled job/watch actually did, or why it stayed quiet. Take the routine id from list_routines; only this channel's routines are readable.",
  inputSchema: z.object({
    routineId: z.string().min(1).describe("The routine whose run to read, e.g. 'r-1a2b3c4d' (from list_routines)."),
    fireDepth: z
      .number()
      .int()
      .min(1)
      .max(TRANSCRIPT_RELAY_MAX_FIRE_DEPTH)
      .optional()
      .describe(`Which run: 1 = the most recent (default), 2 = the one before it, up to ${TRANSCRIPT_RELAY_MAX_FIRE_DEPTH}.`),
  }),
  outputSchema: z.object({
    routineId: z.string(),
    sessionId: z.string(),
    firedAt: z.string(),
    outcome: z.string().nullable(),
    silent: z.boolean(),
    firesAvailable: z.number(),
    eventCount: z.number(),
    complete: z.boolean(),
    transcript: z.string(),
  }),
  async execute(input, ctx) {
    const p = resolvePartition(ctx as unknown as BindableContext);
    const result = await fetchRoutineTranscript({
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      routineId: input.routineId,
      fireDepth: input.fireDepth ?? 1,
    });
    return {
      routineId: result.routineId,
      sessionId: result.sessionId,
      firedAt: result.firedAt,
      outcome: result.outcome,
      silent: result.silent,
      firesAvailable: result.firesAvailable,
      eventCount: result.eventCount,
      complete: result.complete,
      transcript: result.text,
    };
  },
  toModelOutput(output) {
    const header =
      `routine ${output.routineId} — run at ${output.firedAt} (outcome: ${output.outcome ?? "unrecorded"}` +
      `${output.silent ? ", silent by design" : ""}; session ${output.sessionId}; ` +
      `${output.firesAvailable} run(s) on record here; ${output.eventCount} events${output.complete ? "" : ", truncated"})`;
    return ingestUntrustedModelOutput(`${header}\n\n${output.transcript}`, {
      source: `routine ${output.routineId} run transcript`,
      ingestion: { kind: "routine-event", label: "read_routine_transcript" },
    });
  },
});
preRegisterDynamicEntry("read_routine_transcript", "_single", entry);

export default defineDynamic({
  events: {
    "session.started": () => (transcriptRelayConfigured() ? entry : null),
  },
});

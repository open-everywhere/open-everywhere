import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { resolveMode, principalIdOf } from "../access/request.js";
import { bindFrom } from "../identity/binding.js";
import { computeNextRun, parseCron } from "../routines/schedule.js";
import { assertReportConsistent, describeTrigger, type RoutineReport, type RoutineTrigger } from "../routines/routine.js";
import { renderFireMessage } from "../routines/fire-message.js";
import { CHECK_IN_DOCTRINE } from "../routines/check-in.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { requestApproval, postedToSurfaceKey } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

const trigger = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("scheduled"),
    cron: z
      .string()
      .optional()
      .describe('Standard 5-field UTC cron "min hour dom mon dow", e.g. "0 9 * * 1-5" = 9am weekdays. Exactly ONE of cron / everyMinutes / at.'),
    everyMinutes: z.number().int().min(1).optional().describe("Run every N minutes from now. Exactly ONE of cron / everyMinutes / at. Effective resolution is the dispatcher tick (~10 min): finer cadences fire on the first tick at/after they're due."),
    at: z
      .string()
      .optional()
      .describe(
        "ONE-SHOT: an ISO 8601 UTC instant to fire exactly ONCE, e.g. \"2027-03-01T09:00:00Z\" — must be in " +
          "the future. Exactly ONE of cron / everyMinutes / at. Effective resolution is the dispatcher tick " +
          "(~10 min): it fires on the first tick at/after this instant, then the routine disables itself " +
          "(kept for audit/list visibility, not deleted). Tag-style check-in: \"check back on the PR in an " +
          "hour\" -> create a `once` routine for now+1h; if nothing's changed when it fires, just create " +
          "another one-shot to check again later — there's no re-arm state to manage. `postPolicy` is " +
          "ignored when `at` is set (a single fire has no repeat to diff against). " +
          CHECK_IN_DOCTRINE,
      ),
    postPolicy: z
      .enum(["every-run", "only-on-change", "never"])
      .optional()
      .describe(
        "REQUIRED for cron/everyMinutes (ignored for `at`). Decide from the TASK'S SHAPE, never from the " +
          "user's phrasing: 'every-run' = the post IS the product (daily summary, digest, reminder — a " +
          "silent run would be a failure); 'only-on-change' = the post is an alert ('check X and tell me " +
          "when something is new/changed') — the fired turn records what it observed and a durable " +
          "host-side diff decides whether to post (reliable across fires, unlike anything remembered " +
          "in-session); 'never' = the work IS the product (updates a ticket, writes memory) — a post " +
          "would be noise, so it reports nothing at all, except a problem it can't resolve. " +
          "A cadence in the request ('hourly') only sets the schedule, never the policy. If " +
          "genuinely unclear, ask in plain words ('post every hour regardless, or only when something new lands?').",
      ),
  }),
  z.object({
    kind: z.literal("event"),
    source: z.string().describe('External event source, e.g. "github".'),
    match: z.record(z.string(), z.string()).optional().describe('Event filter, e.g. { "event": "pull_request", "action": "opened" }.'),
  }),
]);

export function storedTrigger(t: z.infer<typeof trigger>): RoutineTrigger {
  if (t.kind === "event") return { kind: "event", source: t.source, match: t.match };
  const present = [t.cron !== undefined, t.everyMinutes !== undefined, t.at !== undefined].filter(Boolean).length;
  if (present !== 1) {
    throw new Error("A scheduled routine needs exactly ONE of `cron`, `everyMinutes`, or `at`.");
  }
  if (t.at !== undefined) {
    const when = new Date(t.at);
    if (Number.isNaN(when.getTime())) {
      throw new Error(`\`at\` must be a valid ISO 8601 timestamp, got "${t.at}".`);
    }
    return { kind: "once", at: when.toISOString() };
  }
  if (t.postPolicy === undefined) {
    throw new Error("A cron/everyMinutes routine needs `postPolicy` (every-run, only-on-change, or never).");
  }
  if (t.postPolicy === "only-on-change") {
    return t.cron !== undefined ? { kind: "watch", expr: t.cron } : { kind: "watch", everyMinutes: t.everyMinutes! };
  }
  return t.cron !== undefined ? { kind: "cron", expr: t.cron } : { kind: "interval", everyMinutes: t.everyMinutes! };
}

export function storedReport(t: z.infer<typeof trigger>): RoutineReport | undefined {
  if (t.kind === "event" || t.at !== undefined) return undefined;
  return t.postPolicy === "never" ? { kind: "silent" } : undefined;
}

export default defineTool({
  description:
    "Create a durable ROUTINE so you act without being re-tagged: a scheduled job (cron/everyMinutes, with a required post policy — every run, only when something changed, or never, for work whose product is an action rather than a message), a ONE-SHOT (`at`, an ISO 8601 UTC instant — fires exactly once, then disables itself; e.g. 'check back on this in an hour' -> create a once routine for now+1h, and just create another one-shot to check again if nothing's changed — no re-arm state to manage), or an event subscription. Use this when the user asks for recurring, scheduled, one-time-later, or 'let me know when…' work. When talking to users, describe the policy in plain words ('I'll check every hour and only post when something changes', or 'I'll check back in an hour'), never internal jargon. Routines belong to this surface and survive their creator leaving; cancel with cancel_routine. The prompt can invoke skills by name (e.g. 'run the <skill> skill, then …') — a fired routine sees this surface's domain and granted skills just like a normal turn, so a whole workflow can be one skill cron'd via a one-line prompt.",
  inputSchema: z.object({
    prompt: z.string().min(1).describe("What you should DO each time it fires, written as a self-contained instruction (an ordinary fire has no prior thread context; a durable job — see `job` — DOES, and accumulates it)."),
    trigger,
    job: z
      .boolean()
      .optional()
      .describe(
        "DURABLE JOB: make this routine keep ONE persistent session across fires so multi-step work " +
          "('chase this PR until it merges', 'drive this migration to done') ACCUMULATES context instead " +
          "of starting cold each time — the fires all live in one thread, and the job runs until its own " +
          "session calls complete_job (not just until one request is answered). Use for open-ended, " +
          "multi-fire objectives; leave off for a plain recurring post (a daily summary). Slack-only, and " +
          "scheduled triggers only (not `event`).",
      ),
  }),
  outputSchema: z.object({
    created: z.boolean(),
    pending: z.boolean(),
    pendingId: z.string().optional(),
    trigger: z.string(),
    nextRunAt: z.string().nullable().describe("When it WOULD first fire once armed (ISO, UTC), or null for event subscriptions."),
    preview: z
      .string()
      .describe(
        "The EXACT message this routine's first fire will receive — the temporal preamble, any protocol " +
          "block (watch / durable job / silent), and your prompt. Rendered by the same code the dispatcher " +
          "uses, so it cannot drift. Read it before telling the user what you've set up: if the protocol " +
          "block contradicts what they asked for, the trigger or the post policy is wrong, not the prompt.",
      ),
    message: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "create_routine");
    const mode = resolveMode(ctx);
    if (mode === "mpim") {
      throw new Error("Group DMs are execution-only — create routines in a channel or DM instead.");
    }
    const p = resolvePartition(ctx);
    const t = storedTrigger(input.trigger as z.infer<typeof trigger>);
    const report = storedReport(input.trigger as z.infer<typeof trigger>);
    assertReportConsistent(t, report);

    const expr = t.kind === "cron" ? t.expr : t.kind === "watch" ? t.expr : undefined;
    if (expr !== undefined) {
      try {
        parseCron(expr);
      } catch (err) {
        throw new Error(`That cron expression is invalid: ${String(err instanceof Error ? err.message : err)}`);
      }
    }

    const now = new Date();
    const next = t.kind === "once" ? new Date(t.at) : computeNextRun(t, now);
    if ((t.kind === "cron" || t.kind === "interval" || t.kind === "watch") && next === null) {
      throw new Error("That schedule never fires — check the cron expression.");
    }
    if (t.kind === "once" && next!.getTime() <= now.getTime()) {
      throw new Error("`at` must be in the future — a one-shot routine can't fire in the past.");
    }

    const binding = bindFrom(ctx);
    if (!hasApprovalCardPath(binding.platform)) {
      throw new Error(`create_routine needs a surface with an approval-card path (Slack or Discord) — this is "${binding.platform}". A human must read and arm the routine before it can fire unattended.`);
    }
    if (input.job) {
      if (binding.platform !== "slack") {
        throw new Error(`Durable jobs are Slack-only for now — this is "${binding.platform}". Create a plain routine here, or a job from Slack.`);
      }
      if (t.kind === "event") {
        throw new Error("A durable job fires on a schedule (cron / everyMinutes / a one-shot), not on an external event — drop `job`, or use a scheduled trigger.");
      }
    }
    const createdBy = principalIdOf(ctx);
    if (!createdBy) {
      throw new Error("create_routine needs a verified sender to gate the write — no principal id resolved, so there's no requester to show on the approval card.");
    }
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("create_routine couldn't resolve this channel's id for the approval card — try again from a real channel.");
    }

    const target = binding.target;
    const tainted = untrustedIngestedThisTurn();
    const posted = await requestApproval(
      {
        org: p.org,
        kind: "routine.create",
        args: { org: p.org, partition: p, surfaceKey: p.surfaceKey, target, trigger: t, ...(report ? { report } : {}), prompt: input.prompt.trim(), ...(createdBy ? { createdBy } : {}), tainted, ...(input.job ? { sessionMode: "job" as const } : {}) },
        scopeKey: p.surfaceKey,
        domain: null,
        requestedBy: createdBy,
        channelId,
        threadTs: binding.threadTs ?? null,
        postedTo: postedToSurfaceKey(binding, channelId),
      },
      approvalPostDeps(binding.platform),
    );

    const preview = renderFireMessage({
      id: "(pending)",
      prompt: input.prompt.trim(),
      createdAt: now.toISOString(),
      trigger: t,
      ...(report ? { report } : {}),
      ...(input.job ? { sessionMode: "job" as const } : {}),
    });

    return {
      created: false,
      pending: true,
      pendingId: posted.id,
      trigger: describeTrigger(t, report),
      nextRunAt: next ? next.toISOString() : null,
      preview,
      message: `card posted — ${input.job ? "durable job" : "routine"} ${describeTrigger(t, report)}${tainted ? " ⚠ tainted" : ""} awaiting a human to arm it (pending ${posted.id}).`,
    };
  },
});

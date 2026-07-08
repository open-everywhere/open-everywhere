import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { resolveMode, principalIdOf, resolveAccessFor } from "../access/request.js";
import { bindFrom } from "../identity/binding.js";
import { addRoutine, newRoutineId } from "../routines/store.js";
import { auditToolAction } from "../audit/tool-action.js";
import { describeTrigger, type Routine } from "../routines/routine.js";
import { repoAllowed } from "../scm/provider.js";
import { fetchPullRequestStatus, describePrStatus, prIsSettled, resolveReadToken } from "../scm/pr-status.js";

export const DEFAULT_CHECK_INTERVAL_MINUTES = 15;
export const MIN_CHECK_INTERVAL_MINUTES = 5;
export const MAX_CHECK_INTERVAL_MINUTES = 1440;

export function subscribePrPrompt(opts: {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly baseline: string;
  readonly intervalMinutes: number;
}): string {
  return [
    `[pr-subscription] You're checking in on GitHub PR #${opts.number} in ${opts.repo} (${opts.url}) as part of ` +
      `a self-serve subscription someone set up — nobody re-tagged you, this fired on its own schedule.`,
    ``,
    `Last known status: ${opts.baseline}`,
    ``,
    `1. Call check_pr_status with repo="${opts.repo}" and number=${opts.number} to get the CURRENT status.`,
    `2. Compare it to the "Last known status" above. If it changed (state, merged, draft, or title), post a ` +
      `short update here saying what changed. If it's UNCHANGED, don't post anything — silence is fine, this ` +
      `is a background check, not a conversation.`,
    `3. If the PR is now MERGED or CLOSED, post the final outcome and STOP — do not create a new routine, the ` +
      `subscription is done.`,
    `4. Otherwise (still open), call create_routine with a "once" trigger (\`at\`: ${opts.intervalMinutes} ` +
      `minutes from now, ISO 8601 UTC) whose prompt repeats this exact same 4-step procedure for the SAME PR ` +
      `(repo="${opts.repo}", number=${opts.number}), with the status you just observed in step 1 as the new ` +
      `"Last known status" baseline — that's how the subscription keeps itself going, one check at a time.`,
  ].join("\n");
}

export default defineTool({
  description:
    "Subscribe this channel to updates on a GitHub pull request: checks its status on a recurring interval (default 15 min) and posts here when something changes, automatically re-checking until the PR is merged or closed. Self-serve — no webhook setup needed, unlike an `event` routine. Built on one-shot routines: each check re-arms the next one. Cancel early with cancel_routine.",
  inputSchema: z.object({
    repo: z.string().describe("Repository as 'owner/repo'."),
    number: z.number().int().positive().describe("PR number."),
    checkIntervalMinutes: z
      .number()
      .int()
      .min(MIN_CHECK_INTERVAL_MINUTES)
      .max(MAX_CHECK_INTERVAL_MINUTES)
      .optional()
      .describe(`How often to re-check, in minutes (default ${DEFAULT_CHECK_INTERVAL_MINUTES}, min ${MIN_CHECK_INTERVAL_MINUTES}, max ${MAX_CHECK_INTERVAL_MINUTES}).`),
  }),
  outputSchema: z.object({
    subscribed: z.boolean(),
    routineId: z.string().optional(),
    status: z.string(),
    nextCheckAt: z.string().optional(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const mode = resolveMode(ctx);
    if (mode === "mpim") {
      throw new Error("Group DMs are execution-only — subscribe from a channel or DM instead.");
    }

    const access = resolveAccessFor(ctx);
    if (!repoAllowed(input.repo, access.repos)) {
      throw new Error(
        `repo "${input.repo}" is not granted to this channel. Allowed: ${access.repos.length ? access.repos.join(", ") : "(none)"}. ` +
          `Grant it via a bundle's repos (see agent/access/bundles.ts).`,
      );
    }

    const token = await resolveReadToken(input.repo);
    const status = await fetchPullRequestStatus({ repo: input.repo, number: input.number, token });
    const summary = describePrStatus(status);

    if (prIsSettled(status)) {
      return { subscribed: false, status: `${summary} — already settled, nothing to subscribe to.` };
    }

    const interval = input.checkIntervalMinutes ?? DEFAULT_CHECK_INTERVAL_MINUTES;
    const p = resolvePartition(ctx);
    const now = new Date();
    const at = new Date(now.getTime() + interval * 60_000);
    const target = bindFrom(ctx).target;

    const routine: Routine = {
      id: newRoutineId(),
      org: p.org,
      surfaceKey: p.surfaceKey,
      target,
      trigger: { kind: "once", at: at.toISOString() },
      prompt: subscribePrPrompt({ repo: input.repo, number: input.number, url: status.url, baseline: summary, intervalMinutes: interval }),
      createdBy: principalIdOf(ctx),
      createdAt: now.toISOString(),
      status: "active",
      nextRunAt: at.toISOString(),
      consecutiveFailures: 0,
    };
    await addRoutine(p, routine);

    await auditToolAction(ctx, "routine.create", {
      id: routine.id,
      trigger: describeTrigger(routine.trigger),
      nextRunAt: routine.nextRunAt ?? null,
      prSubscription: `${input.repo}#${input.number}`,
    });

    return {
      subscribed: true,
      routineId: routine.id,
      status: summary,
      nextCheckAt: at.toISOString(),
    };
  },
});

import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { resolveMode, actingPrincipalIdOf, unattendedOf } from "../access/request.js";
import { bindFrom } from "../identity/binding.js";
import { computeNextRun, parseCron } from "../routines/schedule.js";
import { assertReportConsistent, describeTrigger, type RoutineReport, type RoutineTrigger } from "../routines/routine.js";
import { describeBoundPolicy } from "../routines/bound.js";
import { renderFireMessage } from "../routines/fire-message.js";
import { SCOPE_KINDS, eventNormalizer } from "../routines/event-model.js";
import { validateSubscription } from "../routines/event-match.js";
import { FILTER_MAX_LENGTH, probeFilter } from "../routines/jq-filter.js";
import { webhookScheme } from "../routines/scheme-name.js";
import { readGrantReach } from "../webhooks/achievability.js";
import { findWebhook } from "../webhooks/config.js";
import type { ReadableBy } from "../access/read-grant.js";
import type { Domain } from "../memory/domain.js";
import { getOperationalStore } from "../operational/provider.js";
import { CHECK_IN_DOCTRINE } from "../routines/check-in.js";
import { declaredPermissionKinds } from "../routines/declared-permissions.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, describeVenueRedirect } from "../approvals/card-venue.js";
import { canDispatchRoutinesOn, reportTargetForSurface } from "../schedules/routine-dispatch.js";
import { reportChannelFor, BINDING_TRUSTED_PLATFORMS } from "../memory/domain.js";
import { domainKeyOf } from "../memory/partition.js";
import { getConfig } from "../access/config.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

const SCOPE_KINDS_LIST = SCOPE_KINDS.join(" | ");

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
    source: z.string().describe("External event source. Must be one registered in this deployment — an unknown source is refused, naming the known set."),
    jq: z
      .string()
      .max(FILTER_MAX_LENGTH)
      .optional()
      .describe(
        "WHICH events, as a **jq expression** that must evaluate to exactly true or false, e.g. " +
          '`.scope.container == "acme/web" and (.fields.action | IN("opened","reopened"))`. ' +
          `The event is an object with .source, .event, .action, .fields.<name> (the source's matchable scalars) and .scope.<${SCOPE_KINDS_LIST}> (the container path; an absent level is null). ` +
          "Use `and` / `or` / `not` freely — OR is expressible here, so a disjunction does NOT need two routines. " +
          "An absent field is null, so `(.fields.x | IN(\"a\"))` is false when x is missing and `(.fields.x | IN(\"a\") | not)` is true. " +
          "REQUIRED to reference a scope (`.scope.<kind>` or a scope field) for any source that spans many containers — subscribing to a whole tenant has to be spelled out. " +
          "The expression is compiled and run once at creation, so a typo is refused here rather than arming a routine that silently never fires.",
      ),
  }),
]);

export function storedTrigger(t: z.infer<typeof trigger>, eventScheme?: string): RoutineTrigger {
  if (t.kind === "event") {
    validateSubscription(t.source, t.jq, eventScheme ?? t.source);
    return { kind: "event", source: t.source, ...(t.jq ? { jq: t.jq } : {}) };
  }
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
    "Create a durable ROUTINE so you act without being re-tagged: a scheduled job (cron/everyMinutes, with a required post policy — every run, only when something changed, or never, for work whose product is an action rather than a message), a ONE-SHOT (`at`, an ISO 8601 UTC instant — fires exactly once, then disables itself; e.g. 'check back on this in an hour' -> create a once routine for now+1h, and just create another one-shot to check again if nothing's changed — no re-arm state to manage), or an event subscription. Use this when the user asks for recurring, scheduled, one-time-later, or 'let me know when…' work. When talking to users, describe the policy in plain words ('I'll check every hour and only post when something changes', or 'I'll check back in an hour'), never internal jargon. Routines belong to this surface and survive their creator leaving; cancel with cancel_routine. If this surface can't host an approval card, the card goes to a card-capable channel in the same domain — the `message` field then names it, and you MUST relay that to the user, or the confirmation is somewhere they can't see. The prompt can invoke skills by name (e.g. 'run the <skill> skill, then …') — a fired routine sees this surface's domain and granted skills just like a normal turn, so a whole workflow can be one skill cron'd via a one-line prompt.",
  inputSchema: z.object({
    prompt: z.string().min(1).describe("What you should DO each time it fires, written as a self-contained instruction (an ordinary fire has no prior thread context; a durable job — see `job` — DOES, and accumulates it)."),
    trigger,
    job: z
      .boolean()
      .optional()
      .describe(
        "DURABLE JOB: ONE persistent session across fires, so multi-step work ACCUMULATES context " +
          "instead of starting cold each time — the fires all live in one thread. Set it ONLY when the " +
          "work has an END the job itself can recognise, because a job runs until its own session calls " +
          "complete_job: \"watch this PR until it's merged\" ends — job. \"Check the dashboard every " +
          "morning\" never ends — leave `job` off. Slack-only, and scheduled triggers only (not `event`).",
      ),
    permissions: z
      .array(z.string())
      .optional()
      .describe(
        "STANDING PERMISSIONS this routine may use without asking, declared here so the human arms the " +
          "routine AND its permissions in one read. Only two things are declarable: \"pr.open\" (open pull " +
          "requests) and \"tool:<connector tool>\" — ONE ROW PER TOOL, named exactly as you would call the " +
          "tool, e.g. \"tool:notion__share_page\". A row lifts THAT TOOL ONLY: a routine that writes with " +
          "three tools declares three rows, and a connector slug on its own (\"tool:notion\") names no tool " +
          "and is refused. INFER CONSERVATIVELY — declare only what the prompt CERTAINLY needs every single " +
          "fire ('read the queue and comment on each ticket' certainly needs the comment tool). " +
          "Under-declaring costs the routine one refused step, which the human fixes by re-creating it with " +
          "that row; over-declaring silently widens what runs unattended at 03:00. When in doubt, leave it " +
          "out. Deletes are never declarable and always ask. Omit entirely for a routine that only reads or " +
          "only posts here.",
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
    message: z.string().describe("Relay the substance of this to the user. When the approval card had to be posted in a DIFFERENT channel (this surface can't host one), it names that channel — say so explicitly, or they'll think nothing happened."),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "create_routine");
    const mode = resolveMode(ctx);
    if (mode === "mpim") {
      throw new Error("Group DMs are execution-only — create routines in a channel or DM instead.");
    }
    const binding = bindFrom(ctx);
    if (mode === "channel" && binding.trust === "external" && BINDING_TRUSTED_PLATFORMS.has(binding.platform)) {
      throw new Error(
        "I can't set up a routine in an externally-shared or guest-bearing channel — a routine fires unattended with standing authority, and this channel isn't confirmed all-in-org. Ask me in an internal channel.",
      );
    }
    const p = resolvePartition(ctx);
    const eventTrigger = input.trigger as z.infer<typeof trigger>;
    const declaredHooks = (() => {
      try {
        return getConfig().loadWebhooks?.() ?? [];
      } catch {
        return [];
      }
    })();
    const hookRow = eventTrigger.kind === "event" ? findWebhook(declaredHooks, eventTrigger.source) : undefined;
    const eventScheme = eventTrigger.kind === "event" ? webhookScheme(hookRow ? { source: hookRow.source } : { source: eventTrigger.source }) : undefined;
    const t = storedTrigger(eventTrigger, eventScheme);
    if (t.kind === "event" && t.jq !== undefined) {
      await probeFilter(t.jq, t.source, eventNormalizer(eventScheme ?? t.source)?.matchKeys ?? []);
    }

    if (t.kind === "event") {
      let grant: ReadableBy | undefined;
      let domains: readonly Domain[] | undefined;
      try {
        grant = hookRow?.readableBy ?? findWebhook(getConfig().loadWebhooks?.() ?? [], t.source)?.readableBy;
        domains = getConfig().loadDomains();
      } catch {
        grant = undefined;
        domains = undefined;
      }
      const reach = readGrantReach(p.surfaceKey, grant, domains);
      const blocked = [...reach.impossible, ...reach.unreachable];
      if (blocked.length > 0) {
        throw new Error(
          `A routine here can't read "${t.source}" events, so it would be armed and then never fire: ${blocked.join(" ")} ` +
            `Arm it from a channel that can read this source, or have an operator widen the hook's readableBy in a PR.`,
        );
      }
    }
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

    const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform));
    }
    const venue = venueResult.venue;

    const canPostHere = canDispatchRoutinesOn(binding.platform);
    let report = storedReport(input.trigger as z.infer<typeof trigger>);
    if (!canPostHere) {
      if (report?.kind === "silent") {
        throw new Error(
          `A "never"-posting routine still has to run somewhere, and "${binding.platform}" has no wired post-back at all, so there is nowhere to run it. Create it from a surface that can post (Slack, Discord, Teams).`,
        );
      }
      const configured = reportChannelFor(domainKeyOf(p), getConfig().loadDomains());
      if (!configured) {
        throw new Error(
          `A routine created here couldn't post anything — "${binding.platform}" has no wired post-back, so it would come due forever and never report. Set \`reportChannel\` on this channel's domain (agent/config/domains.ts) to one of that domain's own Slack/Discord channels, and I can run it from here and report there; or ask me in a channel that can post.`,
        );
      }
      const reportTarget = reportTargetForSurface(configured);
      if (!reportTarget) {
        throw new Error(
          `This domain's \`reportChannel\` is "${configured}", but that surface's post-back target can't be derived from its key alone (Teams needs a stored conversation reference), so a routine reporting there would never post. Point \`reportChannel\` at a Slack or Discord channel in the same domain (agent/config/domains.ts).`,
        );
      }
      report = { kind: "surface", surfaceKey: configured, target: reportTarget };
    }
    assertReportConsistent(t, report, input.job ? "job" : undefined);

    if (input.job) {
      if (binding.platform !== "slack") {
        throw new Error(`Durable jobs are Slack-only for now — this is "${binding.platform}". Create a plain routine here, or a job from Slack.`);
      }
      if (t.kind === "event") {
        throw new Error("A durable job fires on a schedule (cron / everyMinutes / a one-shot), not on an external event — drop `job`, or use a scheduled trigger.");
      }
    }
    const createdBy = actingPrincipalIdOf(ctx);
    if (!createdBy) {
      throw new Error("create_routine needs a verified sender to gate the write — no principal id resolved, so there's no requester to show on the approval card.");
    }
    const channelId = venue.channelId;

    const target = binding.target;
    const tainted = untrustedIngestedThisTurn();
    const permissions = (input.permissions ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
    declaredPermissionKinds(permissions);
    const posted = await requestApproval(
      {
        org: p.org,
        kind: "routine.create",
        args: { org: p.org, partition: p, surfaceKey: p.surfaceKey, target, trigger: t, ...(report ? { report } : {}), prompt: input.prompt.trim(), ...(createdBy ? { createdBy } : {}), tainted, ...(input.job ? { sessionMode: "job" as const, boundPolicy: describeBoundPolicy(t, new Date()) } : {}), ...(permissions.length ? { permissions } : {}) },
        scopeKey: p.surfaceKey,
        domain: null,
        requestedBy: createdBy,
        channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform),
    );

    const preview = renderFireMessage({
      id: "(pending)",
      prompt: input.prompt.trim(),
      createdAt: now.toISOString(),
      trigger: t,
      ...(report ? { report } : {}),
      ...(input.job ? { sessionMode: "job" as const } : {}),
    });

    if (posted.autoApproved) {
      return {
        created: true,
        pending: false,
        autoApproved: true,
        pendingId: posted.id,
        trigger: describeTrigger(t, report),
        nextRunAt: next ? next.toISOString() : null,
        preview,
        message: autoApprovedNote(
          `${input.job ? "durable job" : "routine"} ${describeTrigger(t, report)}${tainted ? " ⚠ tainted" : ""}`,
          posted.autoApproved,
        ),
      };
    }

    return {
      created: false,
      pending: true,
      pendingId: posted.id,
      trigger: describeTrigger(t, report),
      nextRunAt: next ? next.toISOString() : null,
      preview,
      message:
        `${cardPostedPrefix(venue)} — ${input.job ? "durable job" : "routine"} ${describeTrigger(t, report)}${tainted ? " ⚠ tainted" : ""} awaiting a human to arm it (pending ${posted.id}).` +
        describeVenueRedirect(venue, "arm it"),
    };
  },
});

import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { resolveMode, actingPrincipalIdOf, unattendedOf } from "../access/request.js";
import { bindFrom } from "../identity/binding.js";
import { computeNextRun, parseCron } from "../routines/schedule.js";
import { assertReportConsistent, describeTrigger, ROUTINE_MODEL_ROLES, type RoutineReport, type RoutineTrigger } from "../routines/routine.js";
import type { ModelRole } from "../memory/domain.js";
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
import { validateRoutineCollectors } from "../routines/collector.js";
import { validateRoutineGate } from "../routines/gate.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { endFirstRoutineOffer } from "../onboarding/first-routine.js";
import { cleanWatchFor } from "../routines/ask-watch.js";
import { testRunSurfaceSupported } from "../routines/test-run.js";
import { eventReach } from "../routines/event-reach.js";
import { sourceWords } from "../routines/schedule-words.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
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
    source: z
      .string()
      .describe(
        "External event source: a connected app's own key (e.g. \"github\") or a declared webhook's name. An app's own events need no declared webhook, so an app missing from list_webhooks' declared hooks can still be a source (see its `appSources`). An unknown source is refused, naming the known set.",
      ),
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
    watchFor: z
      .string()
      .optional()
      .describe(
        "A WATCH a person asked for ('tell me when …', 'let me know when …'): the condition in their words, one short line with friendly names and no ids, " +
          "e.g. \"a new issue is opened in acme/web\" or \"the contract comes back signed\". Set it for an event subscription, or for an only-on-change check on an app that sends no events here. " +
          "The card's headline and the person's list read it; the filter or the prompt still decides each post, so make them say the same thing. Leave it off every other routine.",
      ),
    quietWhenEmpty: z
      .boolean()
      .optional()
      .describe(
        "Only with `postPolicy: \"only-on-change\"`: a check that finds nothing posts NOTHING, even when the last check found something " +
          "and even on the first check. The check then records the state as exactly `nothing`. Set it for a 'tell me when something needs me' check, " +
          "including when you re-create such a check on a new schedule. It only removes posts, so it grants nothing.",
      ),
    job: z
      .boolean()
      .optional()
      .describe(
        "DURABLE JOB: ONE persistent session across fires, so multi-step work ACCUMULATES context " +
          "instead of starting cold each time — the fires all live in one thread. Set it ONLY when the " +
          "work has an END the job itself can recognise, because a job runs until its own session calls " +
          "complete_job: \"watch this PR until it's merged\" ends — job. \"Check the dashboard every " +
          "morning\" never ends — leave `job` off. Slack, Teams and Discord only, and scheduled triggers only (not `event`).",
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
    collectors: z
      .array(z.string())
      .optional()
      .describe(
        "PRE-RUN READS. Names of declared collectors the HOST runs BEFORE each fire, whose output is handed " +
          "to the run as data — so the run starts from current inputs instead of guessing. You cannot invent " +
          "one: the name, the tool it calls and the arguments it calls it with are all written in this " +
          "deployment's config, and a name it does not declare is refused here with the list of names it does. " +
          "Each collector needs its tool declared in `permissions` above, because a collector runs under the " +
          "routine's declared permission and nothing wider. Omit for a routine that needs nothing fetched " +
          "before it starts.",
      ),
    gate: z
      .string()
      .optional()
      .describe(
        "CONDITION GATE. The name of a declared predicate that decides whether this routine runs AT ALL, " +
          "checked host-side over the collectors above before any session starts — for work that must not " +
          "happen until something is verifiably true (\"do not tell them it is fixed until the fix is actually " +
          "serving\"). Like `collectors`, the predicate itself is written in this deployment's config and a " +
          "name it does not declare is refused here. It needs at least one `collector` — that is what it reads. " +
          "It FAILS CLOSED: while the condition is false the routine does not run and says so in its audit trail. " +
          "A one-shot routine is NOT retired by a gate saying no — it stays due and fires as soon as the condition " +
          "holds. Omit for a routine that should run every time it is due.",
      ),
    modelRole: z
      .enum(ROUTINE_MODEL_ROLES as readonly [ModelRole, ...ModelRole[]])
      .optional()
      .describe(
        "MODEL ROLE. Which role of this deployment's model stack this routine's fires run on. OMIT IT unless " +
          "you have a reason: omitting means the routine INHERITS the deployment's stack, which is what every " +
          "routine did before this field existed and what almost every routine should keep doing. `utility` is " +
          "the cheap summarising role and `supervisor` the cheap ambient one — pick one only for a routine whose " +
          "work is genuinely mechanical, because a cheaper role degrades the run's judgement and nothing will " +
          "tell you that it did. It names a ROLE and never a model id, so the routine follows the stack when the " +
          "stack changes. Where this deployment routes no such role the routine simply runs the default one: " +
          "naming a role is never an error and never a failure, it can just have no effect.",
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
    const proposeScopeKey = await proposalScopeKey(ctx, p);
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
    const watchFor = cleanWatchFor(input.watchFor);
    if (watchFor !== undefined && t.kind !== "event" && t.kind !== "watch") {
      throw new Error("`watchFor` names what a watch looks for, so it needs an event trigger or `postPolicy: \"only-on-change\"`. Drop it, or make this a watch.");
    }
    if (input.quietWhenEmpty === true && t.kind !== "watch") {
      throw new Error("`quietWhenEmpty` holds back an empty check of an only-on-change watch, so it needs `postPolicy: \"only-on-change\"`. Drop it, or make this a watch.");
    }
    if (t.kind === "event" && (await eventReach(t.source)) === "deaf") {
      const app = sourceWords(t.source);
      throw new Error(
        `${app}'s events don't reach this deployment, so a routine on them would never fire. ` +
          `Set it up as a check on a schedule instead (\`postPolicy: "only-on-change"\`), or ask an admin to set up ${app}'s webhook first.`,
      );
    }
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
          `A routine created here couldn't post anything — "${binding.platform}" has no wired post-back, so it would come due forever and never report. Set \`reportChannel\` on this channel's domain (agent/memory/config/domains/<name>.ts) to one of that domain's own Slack/Discord channels, and I can run it from here and report there; or ask me in a channel that can post.`,
        );
      }
      const reportTarget = reportTargetForSurface(configured);
      if (!reportTarget) {
        throw new Error(
          `This domain's \`reportChannel\` is "${configured}", but that surface's post-back target can't be derived from its key alone (Teams needs a stored conversation reference), so a routine reporting there would never post. Point \`reportChannel\` at a Slack or Discord channel in the same domain (agent/memory/config/domains/<name>.ts).`,
        );
      }
      report = { kind: "surface", surfaceKey: configured, target: reportTarget };
    }
    assertReportConsistent(t, report, input.job ? "job" : undefined);

    if (input.job) {
      if (!testRunSurfaceSupported(binding.platform)) {
        throw new Error(`Durable jobs are not available on "${binding.platform}" yet — there is no way to keep one session for the job here. Create a plain routine here, or a job from Slack, Teams or Discord.`);
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
    const collectors = validateRoutineCollectors(input.collectors ?? [], permissions);
    const gate = validateRoutineGate(input.gate, collectors);
    const posted = await requestApproval(
      {
        org: p.org,
        kind: "routine.create",
        args: { org: p.org, partition: p, surfaceKey: p.surfaceKey, target, trigger: t, ...(report ? { report } : {}), prompt: input.prompt.trim(), ...(watchFor ? { watchFor } : {}), ...(input.quietWhenEmpty === true ? { quietWhenEmpty: true as const } : {}), ...(createdBy ? { createdBy } : {}), tainted, ...(input.job ? { sessionMode: "job" as const, boundPolicy: describeBoundPolicy(t, new Date()) } : {}), ...(permissions.length ? { permissions } : {}), ...(collectors.length ? { collectors } : {}), ...(gate ? { gate } : {}), ...(input.modelRole === undefined ? {} : { modelRole: input.modelRole }), ...(binding.mode === "channel" ? { firstRoutineRoom: true as const } : {}) },
        scopeKey: proposeScopeKey,
        domain: null,
        requestedBy: createdBy,
        channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform, ctx),
    );

    const preview = renderFireMessage({
      id: "(pending)",
      prompt: input.prompt.trim(),
      createdAt: now.toISOString(),
      trigger: t,
      ...(report ? { report } : {}),
      ...(input.job ? { sessionMode: "job" as const } : {}),
    });

    if (!posted.autoApproved && createdBy) {
      await endFirstRoutineOffer({ partition: p, decidedBy: createdBy, outcome: "offered", room: binding.mode === "channel" });
    }

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
        cardPostedTail(venue, "arm it", posted),
    };
  },
});

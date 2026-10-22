import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { actingPrincipalIdOf } from "../access/request.js";
import { bindFrom, currentSessionId, currentTurnId, type BindableContext } from "../identity/binding.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { READER_APP, personalTriagePass, type TriagePass } from "../personal-watch/triage.js";
import { waitingOnPerson } from "../status/waiting-on-me.js";

export default defineTool({
  description:
    "List what is waiting on the person you are talking to: every open approval card they can decide or that their own work asked for, every job or thread that reported itself blocked on them or needing them, " +
    "and what in their own connected apps needs them (review requests, assigned issues, direct messages, mentions, comments), ranked most pressing first. " +
    "Each item comes with a plain sentence of what it is and why it needs them, and a link. DM only, and it only ever reads that person's own queue and apps, with their own sign-in. " +
    'Call it when they ask "what needs me", "what is waiting on me", "what do you need from me", or "anything to approve". Relay `message` as it comes back — it is written for the person to read.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    count: z.number().int(),
    omitted: z.number().int(),
    message: z.string(),
    items: z.array(
      z.object({
        kind: z.enum(["approval", "attention"]),
        sentence: z.string(),
        status: z.string(),
        where: z.string(),
        link: z.string().optional(),
        since: z.string(),
      }),
    ),
    triage: z.object({
      items: z.array(
        z.object({
          app: z.string(),
          what: z.string(),
          why: z.string(),
          urgency: z.enum(["later", "soon", "urgent"]),
          link: z.string().optional(),
        }),
      ),
      omitted: z.number().int(),
      unread: z.array(z.string()),
    }),
  }),
  approval: never(),
  async execute(_input, ctx) {
    const c = ctx as BindableContext;
    const binding = bindFrom(c);
    if (binding.mode !== "dm") {
      throw new Error(
        `waiting_on_me is DM-only (this conversation is "${binding.mode}") — what waits on somebody is theirs, and only in a 1:1 can this deployment be sure it is talking to them. Ask them to send me a direct message.`,
      );
    }
    // principal-gate: presence — a HUMAN must be here, acting. Their identity IS the query key, so an unattended fire (no acting principal) reads nothing.
    const personId = actingPrincipalIdOf(c);
    if (!personId) {
      throw new Error("waiting_on_me needs the person to be here: it reads their own queue, and this turn has no acting person.");
    }
    const queue = await waitingOnPerson({
      org: binding.org,
      platform: binding.platform,
      workspace: binding.workspace,
      personId,
      ...(binding.enterprise ? { enterprise: binding.enterprise } : {}),
    });
    const key = tryPrincipalKey(binding.platform, binding.workspace, personId);
    const turn = currentTurnId(c);
    const session = currentSessionId(c);
    const passId = turn !== undefined && session !== undefined ? `${session}:${turn}` : undefined;
    const triage: TriagePass | undefined = key === undefined ? undefined : await personalTriagePass(binding.org, key, "full", passId !== undefined ? { passId } : {}).catch(() => undefined);
    const message = triage && triage.message.length > 0 ? `${queue.message}\n\n${triage.message}` : queue.message;
    return {
      count: queue.items.length,
      omitted: queue.omitted,
      message,
      items: queue.items.map((i) => ({ ...i })),
      triage: {
        items: (triage?.items ?? []).map((i) => ({ app: i.app, what: i.what, why: i.why, urgency: i.urgency, ...(i.link ? { link: i.link } : {}) })),
        omitted: triage?.omitted ?? 0,
        unread: [...new Set((triage?.newlyMissing ?? []).map((s) => READER_APP[s.read]))],
      },
    };
  },
});

import { POST, type Channel, type HttpRouteDefinition, type RouteHandlerArgs } from "eve/channels";
import { SLACK_SIGNATURE_HEADER, SLACK_TIMESTAMP_HEADER, slackSignatureMatches } from "./slack-signature.js";
import { callSlackApi, slackContinuationToken } from "eve/channels/slack";
import {
  parseMessageEvent,
  routeMessageEvent,
  liveDeps,
  routeNameDropEvent,
  liveNameDropDeps,
  parseChannelJoinEvent,
  routeChannelJoinEvent,
  liveChannelJoinDeps,
  parseSlackReactionEvent,
  routeReactionEvent,
  liveReactionDeps,
  routeSupervisorEvent,
  liveSupervisorDeps,
  supervisorFifoKey,
  bindableFor,
  bindableForJoin,
  bindableForReaction,
  slackSingleWindowMentionPolicy,
  slackDomainUsesUnifiedWindow,
  type SlackEventEnvelope,
  type ParsedMessageEvent,
  type RouteOutcome,
} from "./slack-events.js";
import {
  EventDedupe,
  ThreadFifo,
  getOrCreateDmSeat as liveGetOrCreateDmSeat,
  touchDmSeat as liveTouchDmSeat,
  dmSeatRotationEnabled,
  dmSeatThresholds,
  generateHandoffNote,
  resolvePartition,
  isThreadEngaged,
  divertInboundToUnifiedWindow,
  ambientSupervisorEnabled,
  getConfig,
  getOperationalStore,
  OE_APPROVAL_PREFIX,
  handleApprovalPayload as liveHandleApprovalPayload,
  OE_SETKEY_ACTION_PREFIX,
  OE_SETKEY_MODAL_CALLBACK,
  handleSetKeyClick as liveHandleSetKeyClick,
  handleSetKeyViewSubmission as liveHandleSetKeyViewSubmission,
  OE_CONNECT_ACTION_PREFIX,
  handleConnectClick as liveHandleConnectClick,
  buildRecord,
  enqueue as enqueueLogRecord,
  flushLogShip,
  type SingleWindowMentionPolicy,
  type DmSeat,
  type ChannelSessionRow,
  type SetKeyViewResult,
} from "@open-everywhere/core/agent/adapter-api.js";
import { slackForm, transcriptFromHistory } from "./slack-events.js";
import { persistSlackAttachment } from "./slack-attachments.js";

type RouteHandler = (req: Request, args: RouteHandlerArgs) => Promise<Response>;

export const PUBLIC_SLACK_ROUTE = "/eve/v1/slack";
export const INTERNAL_SLACK_ROUTE = "/eve/v1/slack/mention";

export type FrontDecision =
  | { readonly kind: "forward"; readonly reason: string }
  | { readonly kind: "wake"; readonly reason: string; readonly env: SlackEventEnvelope }
  | { readonly kind: "join"; readonly reason: string; readonly env: SlackEventEnvelope }
  | { readonly kind: "reaction"; readonly reason: string; readonly env: SlackEventEnvelope }
  | { readonly kind: "approval-click"; readonly reason: string; readonly payload: unknown }
  | { readonly kind: "setkey-click"; readonly reason: string; readonly payload: unknown }
  | { readonly kind: "setkey-submit"; readonly reason: string; readonly payload: unknown }
  | { readonly kind: "connect-click"; readonly reason: string; readonly payload: unknown }
  | { readonly kind: "mention"; readonly reason: string; readonly env: SlackEventEnvelope };

function parseOeApprovalPayload(rawBody: string): unknown | undefined {
  const raw = new URLSearchParams(rawBody).get("payload");
  if (!raw) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (p.type !== "block_actions" || !Array.isArray(p.actions)) return undefined;
  const isOurs = (p.actions as unknown[]).some(
    (a) =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as Record<string, unknown>).action_id === "string" &&
      ((a as Record<string, unknown>).action_id as string).startsWith(OE_APPROVAL_PREFIX),
  );
  return isOurs ? payload : undefined;
}

function decodeInteractivityPayload(rawBody: string): Record<string, unknown> | undefined {
  const raw = new URLSearchParams(rawBody).get("payload");
  if (!raw) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : undefined;
}

function parseOeSetKeyClickPayload(rawBody: string): unknown | undefined {
  const p = decodeInteractivityPayload(rawBody);
  if (!p || p.type !== "block_actions" || !Array.isArray(p.actions)) return undefined;
  const isOurs = (p.actions as unknown[]).some(
    (a) =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as Record<string, unknown>).action_id === "string" &&
      ((a as Record<string, unknown>).action_id as string).startsWith(OE_SETKEY_ACTION_PREFIX),
  );
  return isOurs ? p : undefined;
}

function parseOeConnectClickPayload(rawBody: string): unknown | undefined {
  const p = decodeInteractivityPayload(rawBody);
  if (!p || p.type !== "block_actions" || !Array.isArray(p.actions)) return undefined;
  const isOurs = (p.actions as unknown[]).some(
    (a) =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as Record<string, unknown>).action_id === "string" &&
      ((a as Record<string, unknown>).action_id as string).startsWith(OE_CONNECT_ACTION_PREFIX),
  );
  return isOurs ? p : undefined;
}

function parseOeSetKeyViewSubmission(rawBody: string): unknown | undefined {
  const p = decodeInteractivityPayload(rawBody);
  if (!p || p.type !== "view_submission") return undefined;
  const view = p.view as Record<string, unknown> | undefined;
  return view?.callback_id === OE_SETKEY_MODAL_CALLBACK ? p : undefined;
}

export function classifyEnvelope(rawBody: string, contentType: string): FrontDecision {
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const approvalPayload = parseOeApprovalPayload(rawBody);
    if (approvalPayload !== undefined) {
      return { kind: "approval-click", reason: "block_actions oe_approval: click — ours, never forwarded", payload: approvalPayload };
    }
    const setKeyClick = parseOeSetKeyClickPayload(rawBody);
    if (setKeyClick !== undefined) {
      return { kind: "setkey-click", reason: "block_actions oe_setkey: click — ours, never forwarded", payload: setKeyClick };
    }
    const setKeySubmit = parseOeSetKeyViewSubmission(rawBody);
    if (setKeySubmit !== undefined) {
      return { kind: "setkey-submit", reason: "view_submission for our credential-intake modal — ours, never forwarded", payload: setKeySubmit };
    }
    const connectClick = parseOeConnectClickPayload(rawBody);
    if (connectClick !== undefined) {
      return { kind: "connect-click", reason: "block_actions oe_connect: click — ours, never forwarded", payload: connectClick };
    }
    return { kind: "forward", reason: "urlencoded interaction/slash — slackChannel owns it" };
  }
  let env: SlackEventEnvelope;
  try {
    env = JSON.parse(rawBody) as SlackEventEnvelope;
  } catch {
    return { kind: "forward", reason: "unparseable body — let slackChannel ack it" };
  }
  if (env?.type === "url_verification") {
    return { kind: "forward", reason: "url_verification challenge — slackChannel answers it" };
  }
  if (env?.type !== "event_callback") {
    return { kind: "forward", reason: `outer type "${String(env?.type)}" — not an event we wake on` };
  }
  const eventType = typeof env.event?.type === "string" ? env.event.type : undefined;
  if (eventType === "app_mention") {
    return { kind: "mention", reason: "app_mention — the mention path owns it unless single-window suppresses", env };
  }
  if (eventType === "member_joined_channel") {
    return { kind: "join", reason: "member_joined_channel — channel-join intro candidate", env };
  }
  if (eventType === "reaction_added" || eventType === "reaction_removed") {
    return { kind: "reaction", reason: `${eventType} — reaction ingestion candidate`, env };
  }
  if (eventType !== "message") {
    return { kind: "forward", reason: `event "${String(eventType)}" — not a message` };
  }
  const channelType = typeof (env.event as Record<string, unknown>).channel_type === "string"
    ? ((env.event as Record<string, unknown>).channel_type as string)
    : undefined;
  if (channelType === "im") {
    return { kind: "forward", reason: "message.im (DM) — slackChannel's onDirectMessage owns it" };
  }
  return { kind: "wake", reason: `message.${channelType ?? "?"} — engagement wake candidate`, env };
}

export function parseDmEnvelope(rawBody: string, contentType: string): ParsedMessageEvent | undefined {
  if (contentType.includes("application/x-www-form-urlencoded")) return undefined;
  let env: SlackEventEnvelope;
  try {
    env = JSON.parse(rawBody) as SlackEventEnvelope;
  } catch {
    return undefined;
  }
  if (env?.type !== "event_callback") return undefined;
  const e = env.event as Record<string, unknown> | undefined;
  if (!e || e.type !== "message" || e.channel_type !== "im") return undefined;
  const ev = parseMessageEvent(env);
  return ev && !ev.botId ? ev : undefined;
}

const SLACK_MAX_SKEW_SECONDS = 60 * 5;

export function verifySlackSignature(
  rawBody: string,
  headers: Headers,
  signingSecret: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  const timestamp = headers.get(SLACK_TIMESTAMP_HEADER);
  const signature = headers.get(SLACK_SIGNATURE_HEADER);
  if (!signingSecret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > SLACK_MAX_SKEW_SECONDS) return false;
  return slackSignatureMatches(signingSecret, timestamp, rawBody, signature);
}

export { EventDedupe, ThreadFifo };

let botIdentityPromise: Promise<{ readonly userId?: string; readonly botId?: string }> | undefined;

export function resolveBotIdentity(): Promise<{ readonly userId?: string; readonly botId?: string }> {
  if (!botIdentityPromise) {
    botIdentityPromise = (async () => {
      try {
        const json = (await callSlackApi({ botToken: undefined, operation: "auth.test", body: {} })) as {
          ok?: boolean;
          user_id?: string;
          bot_id?: string;
        };
        return json.ok ? { userId: json.user_id, botId: json.bot_id } : {};
      } catch {
        return {};
      }
    })();
  }
  return botIdentityPromise;
}

export function _resetBotIdentity(): void {
  botIdentityPromise = undefined;
}

export interface FrontOptions {
  readonly signingSecret?: string;
  readonly dedupe?: EventDedupe;
  readonly fifo?: ThreadFifo;
  readonly getBotIdentity?: () => Promise<{ readonly userId?: string; readonly botId?: string }>;
  readonly now?: () => number;
  readonly markEventSeen?: (org: string, key: string, atIso: string) => Promise<boolean>;
  readonly ambientEnabledFor?: (surfaceKey: string) => boolean;
  readonly handleApprovalPayload?: (payload: unknown) => Promise<boolean>;
  readonly handleSetKeyClick?: (payload: unknown) => Promise<boolean>;
  readonly handleSetKeyViewSubmission?: (payload: unknown) => Promise<SetKeyViewResult>;
  readonly handleConnectClick?: (payload: unknown) => Promise<boolean>;
  readonly mentionPolicyFor?: (channelId: string, surfaceKey: string) => Promise<SingleWindowMentionPolicy>;
  readonly dmSeatEnabled?: () => boolean;
  readonly resolveDmSeat?: (org: string, dmChannelId: string, atIso: string) => Promise<DmSeat>;
  readonly touchDmSeatFn?: (org: string, dmChannelId: string, atIso: string) => Promise<void>;
}

const OK = () => new Response("ok");

function wakeKey(env: SlackEventEnvelope, channelId: string, ts: string, botIdentity = "default"): string {
  const eventId = typeof env.event_id === "string" ? env.event_id : undefined;
  return `${botIdentity}:${eventId ?? `${channelId}:${ts}`}`;
}

const DEDUPE_TTL_MS = 10 * 60_000;
let warnedDedupeStore = false;
async function liveMarkEventSeen(org: string, key: string, atIso: string): Promise<boolean> {
  try {
    return await getOperationalStore().markEventSeen(org, key, atIso, DEDUPE_TTL_MS);
  } catch (err) {
    if (!warnedDedupeStore) {
      warnedDedupeStore = true;
      console.warn(`[open-everywhere:slack-front] durable dedupe unavailable — in-memory only: ${String(err)}`);
    }
    return true;
  }
}

const logOutcome =
  (path: string, channelId: string, ts: string) =>
  (outcome: RouteOutcome): void => {
    console.log(
      `[open-everywhere:slack-front] ${path} ${channelId}/${ts}: ${outcome.woke ? "woke" : "no wake"} — ${outcome.reason}`,
    );
  };

export function recordWakeFailure(key: string, err: unknown): void {
  const channelId = key.split(":")[0] ?? key;
  try {
    enqueueLogRecord(buildRecord("error", "wake", "supervisor/thread wake delivery failed", { fields: { fifoKey: key, channelId }, err }));
    void flushLogShip();
  } catch {
  }
  void (async () => {
    try {
      const p = resolvePartition({
        channel: { kind: "slack" },
        session: { auth: { current: { attributes: { team_id: "", channel_id: channelId }, principalId: "", principalType: "slack-user" } } },
      } as Parameters<typeof resolvePartition>[0]);
      await getOperationalStore().appendAudit({
        ts: new Date().toISOString(),
        org: p.org,
        platform: p.platform,
        workspace: p.workspace,
        surface: p.surface,
        action: "surface.wake_failed",
        detail: { fifoKey: key, message: String(err instanceof Error ? err.message : err).slice(0, 500) },
      });
    } catch {
    }
  })();
}

export function withSingleWindowDiversion(
  deps: ReturnType<typeof liveSupervisorDeps>,
  to: RouteHandlerArgs["to"],
  surfaceKey: string,
): ReturnType<typeof liveSupervisorDeps> {
  return {
    ...deps,
    async wake(input) {
      if (!input.window) return deps.wake(input);
      await divertInboundToUnifiedWindow(to, {
        message: input.message,
        token: input.token,
        window: input.window,
        surfaceKey,
        auth: input.auth as { attributes?: Record<string, unknown> },
      });
    },
  };
}

async function liveDmSeatHandoff(dmChannelId: string, outgoing: ChannelSessionRow): Promise<string | undefined> {
  try {
    const history = transcriptFromHistory(await slackForm("conversations.history", `channel=${encodeURIComponent(dmChannelId)}&limit=50`)) ?? "";
    const note = await generateHandoffNote(dmChannelId, outgoing.handoffNote ?? null, history);
    return note ?? undefined;
  } catch {
    return undefined;
  }
}

export function wrapDmSeatFrom(
  from: RouteHandlerArgs["from"],
  waitUntil: RouteHandlerArgs["waitUntil"],
  org: string,
  dmChannelId: string,
  resolveDmSeat: (org: string, dmChannelId: string, atIso: string) => Promise<DmSeat>,
  touchDmSeatFn: (org: string, dmChannelId: string, atIso: string) => Promise<void>,
): RouteHandlerArgs["from"] {
  return ((address: string) => {
    const native = from(address);
    if (!(typeof address === "string" && address.startsWith(`${dmChannelId}:`) && !address.includes(":oe-dm:g"))) {
      return native;
    }
    return {
      ...native,
      async send(message: unknown, sendOpts: unknown) {
        try {
          const atIso = new Date().toISOString();
          const seat = await resolveDmSeat(org, dmChannelId, atIso);
          let newOpts = sendOpts;
          if (seat.freshGeneration && seat.handoffNote && seat.handoffNote.length > 0) {
            const o = (sendOpts ?? {}) as { context?: readonly string[] };
            const handoff = `<handoff-from-previous-session>\n${seat.handoffNote}\n</handoff-from-previous-session>`;
            newOpts = { ...(sendOpts as Record<string, unknown>), context: [handoff, ...(o.context ?? [])] };
          }
          const res = await (from(seat.token) as unknown as { send: (m: unknown, o: unknown) => Promise<unknown> }).send(message, newOpts);
          waitUntil(touchDmSeatFn(org, dmChannelId, atIso).catch(() => {}));
          return res;
        } catch (err) {
          console.warn(`[open-everywhere:slack-front] dm-seat remap failed (${dmChannelId}) — native send: ${String(err)}`);
        }
        return (native as unknown as { send: (m: unknown, o: unknown) => Promise<unknown> }).send(message, sendOpts);
      },
    };
  }) as unknown as RouteHandlerArgs["from"];
}

export function buildFrontHandler(innerHandler: RouteHandler, opts: FrontOptions = {}): RouteHandler {
  const dedupe = opts.dedupe ?? new EventDedupe();
  const fifo = opts.fifo ?? new ThreadFifo(recordWakeFailure);
  const getBotIdentity = opts.getBotIdentity ?? resolveBotIdentity;
  const now = opts.now ?? (() => Date.now());
  const signingSecret = () => opts.signingSecret ?? process.env.SLACK_SIGNING_SECRET;
  const markEventSeen = opts.markEventSeen ?? liveMarkEventSeen;
  const handleApproval = opts.handleApprovalPayload ?? liveHandleApprovalPayload;
  const handleSetKeyClick = opts.handleSetKeyClick ?? liveHandleSetKeyClick;
  const handleSetKeyViewSubmission = opts.handleSetKeyViewSubmission ?? liveHandleSetKeyViewSubmission;
  const handleConnectClick = opts.handleConnectClick ?? liveHandleConnectClick;
  const ambientEnabledFor = opts.ambientEnabledFor ?? ((surfaceKey: string) => ambientSupervisorEnabled(surfaceKey, getConfig().loadDomains()));
  const mentionPolicyFor = opts.mentionPolicyFor ?? slackSingleWindowMentionPolicy;
  const dmSeatEnabled = opts.dmSeatEnabled ?? dmSeatRotationEnabled;
  const resolveDmSeat = opts.resolveDmSeat ?? ((org, dmChannelId, atIso) => liveGetOrCreateDmSeat(org, dmChannelId, atIso, { distillHandoff: liveDmSeatHandoff }));
  const touchDmSeatFn = opts.touchDmSeatFn ?? liveTouchDmSeat;

  const singleWindowOwnsMention = async (channelId: string, surfaceKey: string): Promise<boolean> => {
    if (!ambientEnabledFor(surfaceKey)) return false;
    return (await mentionPolicyFor(channelId, surfaceKey)).suppressNative;
  };

  return async (req: Request, args: RouteHandlerArgs): Promise<Response> => {
    const rawBody = await req.text();
    if (!verifySlackSignature(rawBody, req.headers, signingSecret(), now())) {
      return new Response("unauthorized", { status: 401 });
    }
    const decision = classifyEnvelope(rawBody, req.headers.get("content-type") ?? "");

    const send = ((input: { message: string; context?: readonly string[] }, opts: { auth: unknown; continuationToken: string; state?: unknown }) =>
      args.from(opts.continuationToken).send(input.message, {
        auth: opts.auth,
        ...(opts.state === undefined ? {} : { state: opts.state }),
        ...(input.context && input.context.length > 0 ? { context: input.context } : {}),
      } as never)) as unknown as Parameters<typeof liveDeps>[0];

    const notYetSeen = async (env: SlackEventEnvelope, ev: ParsedMessageEvent): Promise<boolean> => {
      const key = wakeKey(env, ev.channelId, ev.ts);
      if (dedupe.seen(key, now())) return false;
      dedupe.mark(key, now());
      try {
        const org = resolvePartition(bindableFor(ev)).org;
        if (!(await markEventSeen(org, key, new Date(now()).toISOString()))) return false;
      } catch {
      }
      return true;
    };

    const scheduleUnownedWake = (ev: ParsedMessageEvent, label: string, directMention = false): void => {
      let ambient = false;
      let surfaceKey: string | undefined;
      try {
        surfaceKey = resolvePartition(bindableFor(ev)).surfaceKey;
        ambient = ambientEnabledFor(surfaceKey);
      } catch {
        ambient = false;
      }
      if (directMention && !ambient) {
        console.warn(`[open-everywhere:slack-front] ${label} ${ev.channelId}/${ev.ts}: ambient off after mention was kept — dropped (no road to the unified window)`);
        return;
      }
      if (ambient) {
        const supKey = supervisorFifoKey(ev.channelId);
        args.waitUntil(
          fifo.enqueue(supKey, () =>
            routeSupervisorEvent(
              ev,
              withSingleWindowDiversion(liveSupervisorDeps(send), args.to, surfaceKey!),
              directMention ? { directMention: true } : undefined,
            ).then(logOutcome(`${label}-supervisor`, ev.channelId, ev.ts)),
          ),
        );
        return;
      }
      args.waitUntil(routeNameDropEvent(ev, liveNameDropDeps(send)).then(logOutcome(label, ev.channelId, ev.ts)));
    };

    const persistAttachments = (ev: ParsedMessageEvent): void => {
      const atts = ev.attachments;
      if (!atts || atts.length === 0) return;
      let org: string;
      try {
        org = resolvePartition(bindableFor(ev)).org;
      } catch {
        return;
      }
      for (const a of atts) {
        if (a.id && a.url) {
          args.waitUntil(persistSlackAttachment(a.id, { urlPrivate: a.url, mimeType: a.mimeType, name: a.name, teamId: ev.teamId }, org));
        }
      }
    };

    if (decision.kind === "forward") {
      let fwdArgs = args;
      if (dmSeatEnabled()) {
        const dmEv = parseDmEnvelope(rawBody, req.headers.get("content-type") ?? "");
        if (dmEv) {
          let org: string | undefined;
          try {
            org = resolvePartition(bindableFor(dmEv)).org;
          } catch {
            org = undefined;
          }
          if (org) {
            fwdArgs = { ...args, from: wrapDmSeatFrom(args.from, args.waitUntil, org, dmEv.channelId, resolveDmSeat, touchDmSeatFn) };
          }
        }
      }
      const forwarded = new Request(req.url, { method: "POST", headers: req.headers, body: rawBody });
      return innerHandler(forwarded, fwdArgs);
    }

    if (decision.kind === "mention") {
      const mev = parseMessageEvent(decision.env);
      if (mev) persistAttachments(mev);
      let owned = false;
      if (mev) {
        try {
          owned = await singleWindowOwnsMention(mev.channelId, resolvePartition(bindableFor(mev)).surfaceKey);
        } catch {
          owned = false;
        }
      }
      if (owned && mev) {
        if (!(await notYetSeen(decision.env, mev))) return OK();
        console.log(
          `[open-everywhere:slack-front] app_mention ${mev.channelId}/${mev.ts}: single-window — diverting to the unified supervisor (native forward suppressed)`,
        );
        scheduleUnownedWake(mev, "single-window-mention", true);
        return OK();
      }
      const forwarded = new Request(req.url, { method: "POST", headers: req.headers, body: rawBody });
      return innerHandler(forwarded, args);
    }

    if (decision.kind === "approval-click") {
      if (await handleApproval(decision.payload)) {
        return new Response(null, { status: 200 });
      }
      const forwarded = new Request(req.url, { method: "POST", headers: req.headers, body: rawBody });
      return innerHandler(forwarded, args);
    }

    if (decision.kind === "setkey-click") {
      if (await handleSetKeyClick(decision.payload)) {
        return new Response(null, { status: 200 });
      }
      const forwarded = new Request(req.url, { method: "POST", headers: req.headers, body: rawBody });
      return innerHandler(forwarded, args);
    }

    if (decision.kind === "connect-click") {
      if (await handleConnectClick(decision.payload)) {
        return new Response(null, { status: 200 });
      }
      const forwarded = new Request(req.url, { method: "POST", headers: req.headers, body: rawBody });
      return innerHandler(forwarded, args);
    }

    if (decision.kind === "setkey-submit") {
      const result = await handleSetKeyViewSubmission(decision.payload);
      if (result.handled) {
        return result.response
          ? new Response(JSON.stringify(result.response), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(null, { status: 200 });
      }
      const forwarded = new Request(req.url, { method: "POST", headers: req.headers, body: rawBody });
      return innerHandler(forwarded, args);
    }

    if (decision.kind === "join") {
      const jev = parseChannelJoinEvent(decision.env);
      if (!jev) return OK();
      const { userId: joinBotUserId } = await getBotIdentity();
      if (!joinBotUserId || jev.userId !== joinBotUserId) return OK();

      const joinKey = wakeKey(decision.env, jev.channelId, jev.ts);
      if (dedupe.seen(joinKey, now())) return OK();
      dedupe.mark(joinKey, now());
      try {
        const org = resolvePartition(bindableForJoin(jev)).org;
        if (!(await markEventSeen(org, joinKey, new Date(now()).toISOString()))) return OK();
      } catch {
      }

      const joinSend = send;
      args.waitUntil(
        routeChannelJoinEvent(jev, liveChannelJoinDeps(joinSend)).then(logOutcome("channel-join", jev.channelId, jev.ts)),
      );
      return OK();
    }

    if (decision.kind === "reaction") {
      const rev = parseSlackReactionEvent(decision.env);
      if (!rev) return OK();

      const rkey = wakeKey(decision.env, rev.channelId, rev.messageTs);
      if (dedupe.seen(rkey, now())) return OK();
      dedupe.mark(rkey, now());
      try {
        const org = resolvePartition(bindableForReaction(rev)).org;
        if (!(await markEventSeen(org, rkey, new Date(now()).toISOString()))) return OK();
      } catch {
      }

      const identity = await getBotIdentity();
      args.waitUntil(
        routeReactionEvent(rev, liveReactionDeps(identity)).then((o) =>
          console.log(`[open-everywhere:slack-front] reaction ${rev.channelId}/${rev.messageTs}: ${o.recorded ? "recorded" : "not recorded"} — ${o.reason}`),
        ),
      );
      return OK();
    }

    const ev = parseMessageEvent(decision.env);
    if (!ev) return OK();
    persistAttachments(ev);

    const { userId: botUserId } = await getBotIdentity();
    if (botUserId && ev.text.includes(`<@${botUserId}>`)) return OK();

    if (!(await notYetSeen(decision.env, ev))) return OK();

    if (!ev.threadTs) {
      scheduleUnownedWake(ev, "name-drop");
      return OK();
    }

    const p = resolvePartition(bindableFor(ev));
    if (slackDomainUsesUnifiedWindow(p.surfaceKey)) {
      scheduleUnownedWake(ev, "in-thread-window");
      return OK();
    }

    const engaged = await isThreadEngaged(p, ev.threadTs);
    if (!engaged) {
      scheduleUnownedWake(ev, "name-drop-thread");
      return OK();
    }

    const threadKey = slackContinuationToken(ev.channelId, ev.threadTs);
    args.waitUntil(
      fifo.enqueue(threadKey, () => routeMessageEvent(ev, liveDeps(send)).then(logOutcome("engaged-thread", ev.channelId, ev.threadTs!))),
    );
    return OK();
  };
}

export function frontSlackChannel<C extends Channel<any, any, any>>(inner: C, opts: FrontOptions = {}): C {
  const innerPost = inner.routes.find(
    (r): r is HttpRouteDefinition<any> => r.method === "POST" && r.path === INTERNAL_SLACK_ROUTE,
  );
  if (!innerPost) {
    throw new Error(
      `frontSlackChannel: wrapped slackChannel must be built with route: "${INTERNAL_SLACK_ROUTE}" ` +
        `(found paths: ${inner.routes.map((r) => r.path).join(", ")})`,
    );
  }
  const front = buildFrontHandler(innerPost.handler, opts);
  return { ...inner, routes: [POST(PUBLIC_SLACK_ROUTE, front), ...inner.routes] };
}

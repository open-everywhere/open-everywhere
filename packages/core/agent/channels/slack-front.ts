import { createHmac, timingSafeEqual } from "node:crypto";
import { POST, type Channel, type HttpRouteDefinition, type RouteHandlerArgs } from "eve/channels";
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
  type SlackEventEnvelope,
  type RouteOutcome,
} from "./slack-events.js";
import { resolvePartition } from "../memory/partition.js";
import { isThreadEngaged } from "./engagement.js";
import { divertToUnifiedWindow } from "./unified.js";
import { ambientSupervisorEnabled } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { getOperationalStore } from "../operational/provider.js";
import { OE_APPROVAL_PREFIX, handleApprovalPayload as liveHandleApprovalPayload } from "../approvals/flow.js";
import { buildRecord, enqueue as enqueueLogRecord, flushLogShip } from "../observability/ship.js";

type RouteHandler = (req: Request, args: RouteHandlerArgs) => Promise<Response>;

export const PUBLIC_SLACK_ROUTE = "/eve/v1/slack";
export const INTERNAL_SLACK_ROUTE = "/eve/v1/slack/mention";

export type FrontDecision =
  | { readonly kind: "forward"; readonly reason: string }
  | { readonly kind: "wake"; readonly reason: string; readonly env: SlackEventEnvelope }
  | { readonly kind: "join"; readonly reason: string; readonly env: SlackEventEnvelope }
  | { readonly kind: "reaction"; readonly reason: string; readonly env: SlackEventEnvelope }
  | { readonly kind: "approval-click"; readonly reason: string; readonly payload: unknown };

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

export function classifyEnvelope(rawBody: string, contentType: string): FrontDecision {
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const approvalPayload = parseOeApprovalPayload(rawBody);
    if (approvalPayload !== undefined) {
      return { kind: "approval-click", reason: "block_actions oe_approval: click — ours, never forwarded", payload: approvalPayload };
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
    return { kind: "forward", reason: "app_mention — the mention path owns it" };
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


const SLACK_MAX_SKEW_SECONDS = 60 * 5;

export function verifySlackSignature(
  rawBody: string,
  headers: Headers,
  signingSecret: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");
  if (!signingSecret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > SLACK_MAX_SKEW_SECONDS) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class EventDedupe {
  private readonly seenAt = new Map<string, number>();
  constructor(private readonly ttlMs = 10 * 60_000, private readonly max = 5_000) {}

  seen(key: string, nowMs: number = Date.now()): boolean {
    const at = this.seenAt.get(key);
    if (at === undefined) return false;
    if (nowMs - at > this.ttlMs) {
      this.seenAt.delete(key);
      return false;
    }
    return true;
  }

  mark(key: string, nowMs: number = Date.now()): void {
    this.seenAt.set(key, nowMs);
    if (this.seenAt.size > this.max) this.prune(nowMs);
  }

  private prune(nowMs: number): void {
    for (const [k, t] of this.seenAt) if (nowMs - t > this.ttlMs) this.seenAt.delete(k);
    if (this.seenAt.size > this.max) {
      const drop = this.seenAt.size - this.max;
      let i = 0;
      for (const k of this.seenAt.keys()) {
        if (i++ >= drop) break;
        this.seenAt.delete(k);
      }
    }
  }
}

export class ThreadFifo {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly onFailure?: (key: string, err: unknown) => void) {}

  enqueue(key: string, run: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => run())
      .catch((err) => {
        console.warn(`[open-everywhere:slack-front] wake delivery failed (${key}): ${String(err)}`);
        try {
          this.onFailure?.(key, err);
        } catch {
        }
      });
    this.tails.set(key, next);
    void next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }

  get activeThreads(): number {
    return this.tails.size;
  }
}

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
  receive: RouteHandlerArgs["receive"],
  surfaceKey: string,
): ReturnType<typeof liveSupervisorDeps> {
  return {
    ...deps,
    async wake(input) {
      if (!input.window) return deps.wake(input);
      await divertToUnifiedWindow(receive, {
        message: input.message,
        token: input.token,
        window: input.window,
        surfaceKey,
        auth: input.auth as { attributes?: Record<string, unknown> },
      });
    },
  };
}

export function buildFrontHandler(innerHandler: RouteHandler, opts: FrontOptions = {}): RouteHandler {
  const dedupe = opts.dedupe ?? new EventDedupe();
  const fifo = opts.fifo ?? new ThreadFifo(recordWakeFailure);
  const getBotIdentity = opts.getBotIdentity ?? resolveBotIdentity;
  const now = opts.now ?? (() => Date.now());
  const signingSecret = () => opts.signingSecret ?? process.env.SLACK_SIGNING_SECRET;
  const markEventSeen = opts.markEventSeen ?? liveMarkEventSeen;
  const handleApproval = opts.handleApprovalPayload ?? liveHandleApprovalPayload;
  const ambientEnabledFor = opts.ambientEnabledFor ?? ((surfaceKey: string) => ambientSupervisorEnabled(surfaceKey, getConfig().loadDomains()));

  return async (req: Request, args: RouteHandlerArgs): Promise<Response> => {
    const rawBody = await req.text();
    if (!verifySlackSignature(rawBody, req.headers, signingSecret(), now())) {
      return new Response("unauthorized", { status: 401 });
    }
    const decision = classifyEnvelope(rawBody, req.headers.get("content-type") ?? "");

    if (decision.kind === "forward") {
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

      const joinSend = args.send as unknown as Parameters<typeof liveDeps>[0];
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

    const { userId: botUserId } = await getBotIdentity();
    if (botUserId && ev.text.includes(`<@${botUserId}>`)) return OK();

    const key = wakeKey(decision.env, ev.channelId, ev.ts);
    if (dedupe.seen(key, now())) return OK();
    dedupe.mark(key, now());
    try {
      const org = resolvePartition(bindableFor(ev)).org;
      if (!(await markEventSeen(org, key, new Date(now()).toISOString()))) return OK();
    } catch {
    }

    const send = args.send as unknown as Parameters<typeof liveDeps>[0];

    const scheduleUnownedWake = (label: string): void => {
      let ambient = false;
      let surfaceKey: string | undefined;
      try {
        surfaceKey = resolvePartition(bindableFor(ev)).surfaceKey;
        ambient = ambientEnabledFor(surfaceKey);
      } catch {
        ambient = false;
      }
      if (ambient) {
        const supKey = supervisorFifoKey(ev.channelId);
        args.waitUntil(
          fifo.enqueue(supKey, () =>
            routeSupervisorEvent(ev, withSingleWindowDiversion(liveSupervisorDeps(send), args.receive, surfaceKey!)).then(
              logOutcome(`${label}-supervisor`, ev.channelId, ev.ts),
            ),
          ),
        );
        return;
      }
      args.waitUntil(routeNameDropEvent(ev, liveNameDropDeps(send)).then(logOutcome(label, ev.channelId, ev.ts)));
    };

    if (!ev.threadTs) {
      scheduleUnownedWake("name-drop");
      return OK();
    }

    const engaged = await isThreadEngaged(resolvePartition(bindableFor(ev)), ev.threadTs);
    if (!engaged) {
      scheduleUnownedWake("name-drop-thread");
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

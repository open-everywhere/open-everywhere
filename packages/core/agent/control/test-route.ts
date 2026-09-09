import type { RouteHandlerArgs } from "eve/channels";
import { routeAuth } from "eve/channels/auth";
import { injectTokenEntries, injectTokenAuth } from "./auth.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { getOperationalStore } from "../operational/provider.js";
import { supervisorGrainFor, grainUsesUnifiedWindow, type SupervisorGrain } from "../channels/unified-supervisor.js";
import { mintWakeId, isUnifiedWakeOrigin, type UnifiedWakeOrigin } from "../channels/unified-window.js";
import { renderWake, mkMessageTrigger, type NormalizedWake, type WakeAddressing } from "../channels/normalized-wake.js";
import type { WakeReason, WakeTrust, WakeParticipant, WakeMessageInput } from "../channels/wake-envelope.js";
import { divertToUnifiedWindow } from "../channels/unified.js";
import { parseWindowToken, formatWindowToken, taskWindowId } from "../channels/window-key.js";
import { OE_GRAIN_ATTR } from "../channels/unified-window.js";
import type { WindowGrain } from "../identity/binding.js";

export const CONTROL_TEST_WAKE_PATH = "/control/v1/test/wake";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function testWakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.OE_TEST_WAKE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export interface TestWakeRequest {
  readonly domain: string;
  readonly platform: UnifiedWakeOrigin["platform"];
  readonly surfaceKey: string;
  readonly addressing?: WakeAddressing;
  readonly reason?: WakeReason;
  readonly text?: string;
  readonly messages?: readonly { readonly text: string; readonly author?: string; readonly authorId?: string }[];
  readonly author?: string;
  readonly authorId?: string;
  readonly trust?: WakeTrust;
  readonly mention?: boolean;
  readonly origin: UnifiedWakeOrigin;
  readonly authAttributes?: Readonly<Record<string, string>>;
  readonly containerNoun?: string;
  readonly engagementTier?: "aggressive" | "neutral" | "reserved";
  readonly participants?: readonly WakeParticipant[];
  readonly channelType?: string;
  readonly threadTs?: string;
  readonly soloWindowId?: string;
  readonly taskThread?: string;
}

function attrsFromSurfaceKey(platform: string, surfaceKey: string): Record<string, string> {
  const parts = surfaceKey.split("/");
  const workspace = parts[1] ?? "";
  const surface = parts.slice(2).join("/");
  switch (platform) {
    case "slack":
      return { team_id: workspace, channel_id: surface, channel_type: "channel", is_private: "false" };
    case "discord":
      return { guild_id: workspace, channel_id: surface };
    case "github":
      return { owner: workspace, repo: surface };
    case "linear":
      return { organization_id: workspace, team_id: surface };
    case "notion":
      return { workspace_id: workspace, page_id: surface };
    case "teams":
      return { tenant_id: workspace, conversation_id: surface };
    default:
      return { workspace_id: workspace, surface_id: surface };
  }
}

function defaultReason(addressing: WakeAddressing): WakeReason {
  if (addressing === "direct" || addressing === "direct-mention") return "mention";
  if (addressing === "thread-follow") return "thread-activity";
  return "channel-activity";
}

const WAKE_ADDRESSINGS: readonly WakeAddressing[] = ["direct", "direct-mention", "thread-follow", "channel-watch", "name-drop"];

const ADDRESSED_ADDRESSINGS: readonly WakeAddressing[] = ["direct", "direct-mention"];

type InjectedAddressing =
  | { readonly ok: true; readonly addressing: WakeAddressing }
  | { readonly ok: false; readonly error: string };

function resolveInjectedAddressing(body: {
  readonly addressing?: unknown;
  readonly reason?: unknown;
  readonly mention?: unknown;
}): InjectedAddressing {
  if (body.addressing !== undefined && !WAKE_ADDRESSINGS.includes(body.addressing as WakeAddressing)) {
    return { ok: false, error: `invalid \`addressing\` "${String(body.addressing)}" (expected one of ${WAKE_ADDRESSINGS.join(", ")})` };
  }
  const stated = body.addressing as WakeAddressing | undefined;
  const addressedAttr =
    body.mention === true ? "mention: true" : body.reason === "mention" ? 'reason: "mention"' : body.reason === "dm" ? 'reason: "dm"' : undefined;
  if (addressedAttr === undefined) return { ok: true, addressing: stated ?? "channel-watch" };
  if (stated === undefined) return { ok: true, addressing: "direct-mention" };
  if (!ADDRESSED_ADDRESSINGS.includes(stated)) {
    return {
      ok: false,
      error:
        `\`${addressedAttr}\` contradicts \`addressing: "${stated}"\` — that addressing renders the ` +
        `ambient wake the standing prompt holds to its highest silence bar, which no addressed wake ` +
        `may claim. Use addressing "direct-mention" (judged envelope + wake-id) or "direct" (raw ` +
        `body), or drop the addressed attribute.`,
    };
  }
  return { ok: true, addressing: stated };
}

function defaultContainerNoun(platform: string): string | undefined {
  switch (platform) {
    case "notion": return "doc";
    case "linear": return "team";
    case "github": return "repo";
    default: return undefined;
  }
}

export async function handleTestWakeInjection(req: Request, to: RouteHandlerArgs["to"]): Promise<Response> {
  const entries = injectTokenEntries();
  if (!testWakeEnabled() || entries.length === 0) return new Response("not found", { status: 404 });

  const identity = await routeAuth(req, injectTokenAuth(entries));
  if (identity instanceof Response) return identity;

  let body: Partial<TestWakeRequest>;
  try {
    body = (await req.json()) as Partial<TestWakeRequest>;
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  const domain = typeof body.domain === "string" ? body.domain.trim() : "";
  const platform = body.platform;
  const surfaceKey = typeof body.surfaceKey === "string" ? body.surfaceKey.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";

  const MSG_CAP = 10;
  const MSG_MAX_CHARS = 4000;
  let coalesced: { text: string; author?: string; authorId?: string }[] | null = null;
  if (body.messages !== undefined) {
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return json(400, { error: "`messages` must be a non-empty array of { text, author?, authorId? }" });
    }
    if (body.messages.length > MSG_CAP) {
      return json(400, { error: `\`messages\` is capped at ${MSG_CAP} entries (got ${body.messages.length})` });
    }
    const out: { text: string; author?: string; authorId?: string }[] = [];
    for (let i = 0; i < body.messages.length; i++) {
      const m = body.messages[i] as { text?: unknown; author?: unknown; authorId?: unknown } | undefined;
      const mt = typeof m?.text === "string" ? m.text : "";
      if (mt.length === 0) return json(400, { error: `messages[${i}].text must be a non-empty string` });
      if (mt.length > MSG_MAX_CHARS) return json(400, { error: `messages[${i}].text exceeds ${MSG_MAX_CHARS} chars (got ${mt.length})` });
      out.push({
        text: mt,
        ...(typeof m?.author === "string" ? { author: m.author } : {}),
        ...(typeof m?.authorId === "string" ? { authorId: m.authorId } : {}),
      });
    }
    coalesced = out;
  }

  if (!domain || !platform || !surfaceKey || (coalesced === null && text.length === 0)) {
    return json(400, { error: "expected body: { domain, platform, surfaceKey, text|messages, origin, … }" });
  }
  if (!isUnifiedWakeOrigin(body.origin)) {
    return json(400, { error: "invalid or missing `origin` (must be a valid UnifiedWakeOrigin for the platform)" });
  }
  const origin = body.origin;
  if (origin.platform !== platform) {
    return json(400, { error: `origin.platform "${origin.platform}" != platform "${platform}"` });
  }

  const resolvedAddressing = resolveInjectedAddressing(body);
  if (!resolvedAddressing.ok) return json(400, { error: resolvedAddressing.error });
  const addressing: WakeAddressing = resolvedAddressing.addressing;

  let grain: SupervisorGrain | undefined;
  try {
    const domains = getConfig().loadDomains();
    const g = supervisorGrainFor(surfaceKey, domains);
    if (grainUsesUnifiedWindow(g)) grain = g;
  } catch {
    grain = undefined;
  }
  if (!grain) {
    return json(400, { error: `no standing window (mode solo / unified) is enabled for surfaceKey "${surfaceKey}" — refusing (fail-closed)` });
  }
  if (grain.domainName !== domain) {
    return json(400, { error: `surfaceKey "${surfaceKey}" resolves to domain "${grain.domainName}", not the requested "${domain}" — refusing (fail-closed)` });
  }

  const org = deploymentOrg();
  const store = getOperationalStore();
  const sessionRow = await store.getChannelSession(org, grain.registryKey).catch(() => null);
  const standingToken = sessionRow?.token;
  if (!standingToken) {
    return json(400, { error: `no unified session for window "${grain.registryKey}" (domain "${domain}") — rotate/seed the window first (channel_session row absent)` });
  }
  const wakeId = mintWakeId();

  const selectors = [body.soloWindowId, body.taskThread].filter((v) => v !== undefined).length;
  if (selectors > 1) {
    return json(400, { error: "at most ONE of soloWindowId / taskThread may be set (they re-mint the dispatched token for a single grain route)" });
  }
  let token = standingToken;
  let grainStamp: WindowGrain | undefined;
  if (body.soloWindowId !== undefined || body.taskThread !== undefined) {
    const key = parseWindowToken(standingToken);
    const noColon = (s: string): string => s.replace(/:/g, "_");
    if (!key) {
      return json(400, { error: `cannot re-mint a grain-route token: the live standing token "${standingToken}" is not a parseable window token` });
    } else if (body.taskThread !== undefined) {
      const chan = noColon(surfaceKey);
      const thread = noColon(body.taskThread);
      if (thread.length === 0) return json(400, { error: "`taskThread` must be a non-empty string" });
      token = formatWindowToken({ domain: key.domain, windowId: taskWindowId(chan, thread), generation: key.generation });
      grainStamp = "task";
    } else if (body.soloWindowId !== undefined) {
      const wid = noColon(body.soloWindowId);
      if (wid.length === 0 || wid === key.domain) {
        return json(400, { error: "`soloWindowId` must be a non-empty windowId distinct from the domain (else it degenerates to the standing token)" });
      }
      token = formatWindowToken({ domain: key.domain, windowId: wid, generation: key.generation });
      grainStamp = "standing";
    }
  }

  const reason: WakeReason = body.reason ?? defaultReason(addressing);
  const containerId = surfaceKey.split("/").slice(2).join("/") || surfaceKey;
  const containerNoun = body.containerNoun ?? defaultContainerNoun(platform);
  const trust = (body.trust ?? "peer") as WakeTrust;

  let trigger: ReturnType<typeof mkMessageTrigger>;
  let backscroll: WakeMessageInput[] | undefined;
  if (coalesced) {
    const base = Date.now();
    const n = coalesced.length;
    const authorIdOf = (a?: string): string | undefined => a ?? body.authorId;
    const mkBackscroll = (e: { text: string; author?: string; authorId?: string }, i: number): WakeMessageInput => ({
      from: "human",
      author: e.author ?? body.author ?? "tester",
      ...(authorIdOf(e.authorId) !== undefined ? { authorId: authorIdOf(e.authorId) } : {}),
      id: `test-${wakeId}-b${i}`,
      sentAt: new Date(base - (n - i) * 1000).toISOString(),
      trust,
      body: e.text,
    });
    backscroll = n > 1 ? coalesced.slice(0, n - 1).map((e, i) => mkBackscroll(e, i)) : undefined;
    const last = coalesced[n - 1];
    trigger = mkMessageTrigger({
      from: "human",
      author: last.author ?? body.author ?? "tester",
      ...(authorIdOf(last.authorId) !== undefined ? { authorId: authorIdOf(last.authorId) } : {}),
      id: `test-${wakeId}`,
      sentAt: new Date(base).toISOString(),
      trust,
      ...(body.mention !== undefined ? { mention: body.mention } : {}),
      body: last.text,
    });
  } else {
    trigger = mkMessageTrigger({
      from: "human",
      author: body.author ?? "tester",
      ...(body.authorId !== undefined ? { authorId: body.authorId } : {}),
      id: `test-${wakeId}`,
      sentAt: new Date().toISOString(),
      trust,
      ...(body.mention !== undefined ? { mention: body.mention } : {}),
      body: text,
    });
  }

  const nw: NormalizedWake = {
    platform,
    reason,
    addressing,
    wakeId,
    ...(containerNoun !== undefined ? { containerNoun } : {}),
    ...(body.engagementTier !== undefined ? { engagementTier: body.engagementTier } : {}),
    ...(body.participants !== undefined ? { participants: body.participants } : {}),
    ...(backscroll !== undefined ? { backscroll } : {}),
    locus: {
      channel: { id: containerId, ...(body.channelType !== undefined ? { type: body.channelType } : {}) },
      ...(body.threadTs !== undefined ? { thread: { ts: body.threadTs } } : {}),
    },
    trigger,
  };
  const rendered = renderWake(nw);

  const authAttributes = {
    ...attrsFromSurfaceKey(platform, surfaceKey),
    ...(grainStamp !== undefined ? { [OE_GRAIN_ATTR]: grainStamp } : {}),
    ...(body.authAttributes ?? {}),
  };

  await appendAudit({
    org,
    platform: "control",
    workspace: "control",
    principalId: identity.principalId,
    action: "control.service_call",
    detail: { service: identity.principalId, view: "test_wake", domain, injectedPlatform: platform, surfaceKey, addressing, wakeId, messageCount: coalesced ? coalesced.length : 1 },
  }).catch(() => undefined);

  try {
    await divertToUnifiedWindow(to, {
      message: rendered.message,
      ...(rendered.context && rendered.context.length > 0 ? { context: rendered.context } : {}),
      token,
      window: { wakeId, origin, ...(addressing === "direct-mention" ? { addressing: "direct-mention" } : {}) },
      surfaceKey,
      auth: { attributes: authAttributes },
    });
  } catch (err) {
    return json(500, { error: `injection failed: ${err instanceof Error ? err.message : String(err)}` });
  }

  return json(200, { ok: true, wakeId, token, domain, platform, surfaceKey, addressing, messageChars: rendered.message.length, messageCount: coalesced ? coalesced.length : 1 });
}

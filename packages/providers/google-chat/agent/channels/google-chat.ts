import { defineChannel, POST, type RouteHandlerArgs } from "eve/channels";
import {
  appendAudit,
  claimRuntimeRotation,
  carryTailForward,
  deploymentOrg,
  divertInboundToUnifiedWindow,
  divertToUnifiedWindow,
  dmWindowRegistryKey,
  getConfig,
  getOperationalStore,
  getOrCreateDmSeat,
  grainUsesUnifiedWindow,
  mintRotationToken,
  mintWakeId,
  receiptEventTime,
  recordWakeTail,
  resolveWakeTrustFromContext,
  shouldRotate,
  spreadVendorTs,
  stampMintedRuntime,
  supervisorGrainFor,
  tailAuthorGrain,
  touchDmSeat,
  withEndsTurnFinalChannel,
  type BindableContext,
  type UnifiedWindowWake,
  type WakeMessageInput,
} from "@open-everywhere/core/agent/adapter-api.js";
import { googleChatPolicy } from "../policy.js";
import { handleGoogleChatRequest, renderGoogleChatWake, type GoogleChatFrontDeps, type GoogleChatWakePlan } from "./google-chat-front.js";

const ROUTE = "/eve/v1/google-chat";
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

function log(msg: string): void {
  console.log(`[open-everywhere:google-chat] ${msg}`);
}

function authContext(auth: { attributes?: Readonly<Record<string, string>>; principalId?: string }): BindableContext {
  return { channel: { kind: "google-chat" }, session: { auth: { current: auth as never } } };
}

function tailRow(plan: GoogleChatWakePlan, atIso: string) {
  return {
    kind: "wake" as const,
    at: atIso,
    from: "human" as const,
    trust: plan.trigger.trust,
    ...tailAuthorGrain(plan.ingested[0] ?? { trust: plan.trigger.trust }),
    author: plan.trigger.author,
    authorId: plan.trigger.authorId ?? "",
    id: plan.trigger.id,
    platform: "google-chat",
    container: plan.surfaceKey,
    ...(plan.origin.thread !== undefined ? { threadRoot: plan.origin.thread } : {}),
    text: plan.trigger.body,
  };
}

async function liveDispatchRoom(plan: GoogleChatWakePlan, to: RouteHandlerArgs["to"]): Promise<void> {
  const org = deploymentOrg();
  const store = getOperationalStore();
  const grain = supervisorGrainFor(plan.surfaceKey, getConfig().loadDomains());
  const atIso = new Date().toISOString();
  const perContainer = (gen: number): string => `google-chat:${plan.surfaceKey}:oe-sup:g${gen}`;
  const runtimeChanged = await claimRuntimeRotation({ org, registryKey: grain.registryKey, surfaceKey: plan.surfaceKey, domainName: grain.domainName, atIso });
  const existing = await store.getChannelSession(org, grain.registryKey);
  let token: string;
  let tail: readonly WakeMessageInput[] = [];
  if (!existing) {
    const row = await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, 1, () => perContainer(1)), atIso);
    await stampMintedRuntime({ org, registryKey: grain.registryKey, surfaceKey: plan.surfaceKey, domainName: grain.domainName, atIso });
    token = row.token;
  } else if (shouldRotate(existing, atIso, { runtimeChanged })) {
    const gen = existing.generation + 1;
    tail = await carryTailForward(org, grain.registryKey, existing.token);
    token = (await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, gen, () => perContainer(gen)), atIso)).token;
  } else {
    token = existing.token;
  }
  const wakeId = mintWakeId();
  const rendered = renderGoogleChatWake(plan, wakeId, tail);
  const window: UnifiedWindowWake = { wakeId, origin: plan.origin, addressing: "direct-mention", ...spreadVendorTs(receiptEventTime(Date.now())) };
  await divertInboundToUnifiedWindow(to, {
    message: rendered.message,
    ...(rendered.context.length > 0 ? { context: rendered.context } : {}),
    token,
    window,
    surfaceKey: plan.surfaceKey,
    auth: plan.auth as unknown as { attributes?: Record<string, unknown> },
  });
  await store.touchChannelSession(org, grain.registryKey, atIso).catch(() => undefined);
  await recordWakeTail(org, grain.registryKey, token, tailRow(plan, atIso)).catch(() => undefined);
}

async function liveDispatchDm(plan: GoogleChatWakePlan, to: RouteHandlerArgs["to"]): Promise<void> {
  const org = deploymentOrg();
  const atIso = new Date().toISOString();
  const seat = await getOrCreateDmSeat(org, { surfaceKey: plan.surfaceKey }, atIso);
  const wakeId = mintWakeId();
  const rendered = renderGoogleChatWake(plan, wakeId, seat.freshGeneration ? seat.tail : undefined);
  await divertToUnifiedWindow(to, {
    message: rendered.message,
    ...(rendered.context.length > 0 ? { context: rendered.context } : {}),
    token: seat.token,
    window: { wakeId, origin: plan.origin, addressing: "direct-mention", ...spreadVendorTs(receiptEventTime(Date.now())) },
    surfaceKey: plan.surfaceKey,
    auth: plan.auth as unknown as { attributes?: Record<string, unknown> },
  });
  await touchDmSeat(org, plan.surfaceKey, atIso).catch(() => undefined);
  await recordWakeTail(org, dmWindowRegistryKey(plan.surfaceKey), seat.token, tailRow(plan, atIso)).catch(() => undefined);
}

function liveGoogleChatFrontDeps(to: RouteHandlerArgs["to"]): GoogleChatFrontDeps {
  return {
    policy: googleChatPolicy,
    markSeen: (key) => getOperationalStore().markEventSeen(deploymentOrg(), key, new Date().toISOString(), DEDUPE_TTL_MS),
    roomHasSeat: (surfaceKey) => {
      try {
        return grainUsesUnifiedWindow(supervisorGrainFor(surfaceKey, getConfig().loadDomains()));
      } catch {
        return false;
      }
    },
    wakeTrust: (auth, sender) => resolveWakeTrustFromContext(authContext(auth), { id: sender, isBot: false }, { principalFallback: true }),
    dispatchRoom: (plan) => liveDispatchRoom(plan, to),
    dispatchDm: (plan) => liveDispatchDm(plan, to),
    audit: (row) =>
      appendAudit({
        org: deploymentOrg(),
        platform: "google-chat",
        workspace: row.workspace,
        ...(row.surface ? { surface: row.surface } : {}),
        ...(row.principalId ? { principalId: row.principalId } : {}),
        action: row.action,
        detail: row.detail,
      }).catch(() => undefined),
  };
}

const channel = defineChannel({
  routes: [
    POST(ROUTE, (req, { to, waitUntil }) =>
      handleGoogleChatRequest(req, waitUntil, liveGoogleChatFrontDeps(to), {
        log,
        onFailure: (err, policy) =>
          appendAudit({
            org: deploymentOrg(),
            platform: "google-chat",
            workspace: policy.workspace,
            action: "google-chat.wake_failed",
            detail: { error: err instanceof Error ? err.name : "error" },
          })
            .then(() => undefined)
            .catch(() => undefined),
      }),
    ),
  ],
});

export default withEndsTurnFinalChannel(channel);

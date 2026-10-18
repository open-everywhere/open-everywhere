import { auditErrorDetail } from "@open-everywhere/core/agent/adapter-api.js";
import { defineChannel, POST, type RouteHandlerArgs } from "eve/channels";
import {
  appendAudit,
  claimRuntimeRotation,
  carryTailForward,
  deploymentOrg,
  divertInboundToUnifiedWindow,
  divertToUnifiedWindow,
  dmWindowRegistryKey,
  emailDomainOf,
  emailPolicy,
  emailTransport,
  getConfig,
  getOperationalStore,
  getOrCreateDmSeat,
  grainUsesUnifiedWindow,
  mintRotationToken,
  mintWakeId,
  readCappedBody,
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
  type EmailTransport,
  type Principal,
  type UnifiedWindowWake,
  type WakeMessageInput,
} from "@open-everywhere/core/agent/adapter-api.js";
import { EMAIL_DEDUPE_TTL_MS, processVerifiedEmail, renderEmailWake, verifyEmailDelivery, type EmailFrontDeps, type EmailWakePlan } from "./email-front.js";

const ROUTE = "/eve/v1/email";
const EMAIL_INGRESS_MAX_BODY_BYTES = 4 * 1024 * 1024;

function log(msg: string): void {
  console.log(`[open-everywhere:email] ${msg}`);
}

function lowercaseHeaders(headers: Headers): Record<string, string> {
  const flat: Record<string, string> = {};
  headers.forEach((v, k) => {
    flat[k.toLowerCase()] = v;
  });
  return flat;
}

function livePrincipals(): readonly Principal[] {
  try {
    return getConfig().loadPrincipals?.() ?? [];
  } catch {
    return [];
  }
}

function authContext(auth: { attributes?: Readonly<Record<string, string>>; principalId?: string }): BindableContext {
  return { channel: { kind: "email" }, session: { auth: { current: auth as never } } };
}

function tailRow(plan: EmailWakePlan, atIso: string) {
  return {
    kind: "wake" as const,
    at: atIso,
    from: "human" as const,
    trust: plan.trigger.trust,
    ...tailAuthorGrain(plan.ingested[0] ?? { trust: plan.trigger.trust }),
    author: plan.trigger.author,
    authorId: plan.trigger.authorId ?? "",
    id: plan.trigger.id,
    platform: "email",
    container: plan.surfaceKey,
    threadRoot: plan.origin.threadId,
    text: plan.trigger.body,
  };
}

async function liveDispatchRoom(plan: EmailWakePlan, to: RouteHandlerArgs["to"]): Promise<void> {
  const org = deploymentOrg();
  const store = getOperationalStore();
  const grain = supervisorGrainFor(plan.surfaceKey, getConfig().loadDomains());
  const atIso = new Date().toISOString();
  const perContainer = (gen: number): string => `email:${plan.surfaceKey}:oe-sup:g${gen}`;
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
  const rendered = renderEmailWake(plan, wakeId, tail);
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

async function liveDispatchDm(plan: EmailWakePlan, to: RouteHandlerArgs["to"]): Promise<void> {
  const org = deploymentOrg();
  const atIso = new Date().toISOString();
  const seat = await getOrCreateDmSeat(org, { surfaceKey: plan.surfaceKey }, atIso);
  const wakeId = mintWakeId();
  const rendered = renderEmailWake(plan, wakeId, seat.freshGeneration ? seat.tail : undefined);
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

function liveEmailFrontDeps(to: RouteHandlerArgs["to"]): EmailFrontDeps {
  return {
    policy: emailPolicy,
    transport: emailTransport,
    principals: livePrincipals,
    markSeen: (key) => getOperationalStore().markEventSeen(deploymentOrg(), key, new Date().toISOString(), EMAIL_DEDUPE_TTL_MS),
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
        platform: "email",
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
    POST(ROUTE, async (req, { to, waitUntil }) => {
      const read = await readCappedBody(req, EMAIL_INGRESS_MAX_BODY_BYTES);
      if ("tooLarge" in read) return new Response(`payload exceeds ${EMAIL_INGRESS_MAX_BODY_BYTES} bytes`, { status: 413 });
      const headers = lowercaseHeaders(req.headers);
      const deps = liveEmailFrontDeps(to);
      const verified = await verifyEmailDelivery(headers, read.body, deps);
      if (!verified.ok) {
        if (verified.outcome.kind === "unauthorized") {
          log(`delivery refused (401): ${verified.outcome.reason}`);
          return new Response("unauthorized", { status: 401 });
        }
        log("delivery refused (503): no email transport is registered for the policy — is the email surface enabled?");
        return new Response("email surface not configured", { status: 503 });
      }
      waitUntil(
        processVerifiedEmail(verified.transport, verified.policy, headers, read.body, deps)
          .then((outcome) => log(`delivery ${outcome.kind}${outcome.kind === "refused" ? ` (${outcome.reason})` : outcome.kind === "admitted" ? ` → ${outcome.route} ${outcome.surfaceKey}` : ""}`))
          .catch(async (err: unknown) => {
            let mail: ReturnType<EmailTransport["parse"]> = null;
            try {
              mail = verified.transport.parse(headers, read.body);
            } catch {
              mail = null;
            }
            log(`delivery FAILED after the ack: ${err instanceof Error ? err.name : "error"}${mail ? ` (inbox ${mail.inbox}, delivery ${mail.deliveryId})` : ""}`);
            await appendAudit({
              org: deploymentOrg(),
              platform: "email",
              workspace: mail ? emailDomainOf(mail.inbox) || "-" : "-",
              action: "email.wake_failed",
              detail: {
                error: auditErrorDetail(err instanceof Error ? err.name : "error").error,
                transport: verified.transport.id,
                ...(mail ? { inbox: mail.inbox, deliveryId: mail.deliveryId } : {}),
              },
            }).catch(() => undefined);
          }),
      );
      return new Response("ok", { status: 200 });
    }),
  ],
});

export default withEndsTurnFinalChannel(channel);

import { defineChannel, POST, type RouteHandlerArgs } from "eve/channels";
import {
  appendAudit,
  ingressSpendGate,
  auditAmbientSkip,
  deploymentOrg,
  resolveWakeTrustFromContext,
  finalMessageActionForTurn,
  completeSupervisorTurn,
  getConfig,
  getSettings,
  ambientSupervisorEnabled,
  engagementTierFor,
  resolveExternalPolicy,
  externalPolicyOverrideFor,
  liveMemoryDeltaDep,
  getOperationalStore,
  capabilitiesForPlatform,
  consumeSupervisorReplyMark,
  declaredTrustForKeys,
  supervisorGrainFor,
  mintRotationToken,
  claimRuntimeRotation,
  grainUsesUnifiedWindow,
  divertToUnifiedWindow,
  healPrunedDeploymentStrand,
  captureHandshakeSecret,
  admitTrigger,
  NOTION_HANDSHAKE_REF_NAMESPACE,
  getOperatorSecret,
  type Domain,
  type SupervisorGrain,
  type SurfaceTrust,
  carryTailForward,
  type WakeMessageInput,
  recordWakeTail,
  postHostNotice,
  detectBridgeableInputRequest,
  renderQuestionForSurface,
  QUESTION_ANSWERED_AUDIT_ACTION,
  QUESTION_ANSWER_DROPPED_AUDIT_ACTION,
} from "@open-everywhere/core/agent/adapter-api.js";
import {
  forgetNotionQuestion,
  rememberNotionQuestion,
  resolveNotionInboundAnswer,
  type NotionInboundAnswer,
} from "./notion-question-return.js";
import { notionChannelCredentialFor, notionIntegrations, resolveNotionInboundSecret, NOTION_CHANNEL_CREDENTIAL } from "./notion-credentials.js";
import { NOTION_EVENT_SOURCE, notionEventDeliveryId, notionTriggerScopeVerdict } from "./notion-event-normalizer.js";
import { createCommentReply, resolveNotionCredential, retrieveBotUser, NOTION_INGRESS_RETRY, type ResolvedNotionCredential } from "./notion-api.js";
import { notionWorkspaceKey } from "./notion-identity.js";
import { notionTrustRoots } from "./notion-ancestry-trust.js";
import { handleNotionDelivery, type NotionReplyTarget, type NotionSessionState } from "./notion-webhook.js";
import {
  handleNotionSupervisorDispatch,
  notionSupervisorToken,
  planNotionSingleWindow,
  shouldRotate,
  type NotionSupervisorDeps,
  type NotionUntieredSupervisorDispatch,
  type NotionUntieredWakeMessage,
} from "./notion-supervisor.js";
import { notionWakeAuditDetail } from "./notion-engagement.js";

const ROUTE = "/eve/v1/notion";

function log(msg: string): void {
  console.log(`[open-everywhere:notion] ${msg}`);
}

const botUserCache = new Map<string, Promise<{ id?: string; name?: string }>>();
function resolveBotUser(
  credentialId: string,
  credential: () => Promise<ResolvedNotionCredential | undefined>,
): () => Promise<{ id?: string; name?: string }> {
  return () => {
    const cached = botUserCache.get(credentialId);
    if (cached) return cached;
    const overrideId = process.env.NOTION_BOT_USER_ID;
    const overrideName = process.env.NOTION_BOT_NAME;
    const named = (u: { id?: string; name?: string }) => ({ id: u.id, name: overrideName && overrideName.length > 0 ? overrideName : u.name });
    const resolved =
      overrideId && overrideId.length > 0
        ? Promise.resolve(named({ id: overrideId }))
        : credential()
            .then((cred) => (cred ? retrieveBotUser({ ...cred, retry: NOTION_INGRESS_RETRY }).then(named) : {}))
            .catch((err) => {
              log(`could not resolve bot user for credential "${credentialId}" (GET /v1/users/me failed): ${String(err)}`);
              return {};
            });
    botUserCache.set(credentialId, resolved);
    return resolved;
  };
}

export function _resetNotionBotUserCache(): void {
  botUserCache.clear();
}

function notionDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

function notionCredentialForPage(workspaceId: string | undefined, pageId: string | undefined): string {
  return notionChannelCredentialFor(workspaceId, pageId, notionDomains()) ?? NOTION_CHANNEL_CREDENTIAL;
}

function notionInboundSecret(name: string): Promise<string | undefined> {
  return resolveNotionInboundSecret(name, getOperatorSecret, log);
}

function notionAmbientEnabled(surfaceKey: string): boolean {
  try {
    return ambientSupervisorEnabled(surfaceKey, getConfig().loadDomains());
  } catch {
    return false;
  }
}

function notionGrainFor(surfaceKey: string): SupervisorGrain {
  try {
    return supervisorGrainFor(surfaceKey, getConfig().loadDomains());
  } catch {
    return { unified: false, registryKey: surfaceKey };
  }
}

export function notionSingleWindowPrivacyOk(
  input: {
    readonly workspaceKey: string;
    readonly surfaceKey: string;
    readonly trust?: { readonly trusted: boolean };
  },
  deps: {
    readonly declared?: (workspaceKey: string, surfaceKey: string) => SurfaceTrust | undefined;
    readonly trustEnv?: string | undefined;
  } = {},
): boolean {
  const trustEnv = "trustEnv" in deps ? deps.trustEnv : process.env.OE_TRUST;
  if (trustEnv === "internal") return true;
  const declared = (deps.declared ?? declaredTrustForKeys)(input.workspaceKey, input.surfaceKey);
  if (declared === "public") return false;
  if (declared === "internal") return true;
  return input.trust?.trusted === true;
}

type NotionState = NotionSessionState;

export function liveNotionSupervisorDeps(
  send: SendFn,
  surfaceKey: string,
  to?: RouteHandlerArgs["to"],
  respond?: RespondFn,
): NotionSupervisorDeps {
  const org = deploymentOrg();
  const store = getOperationalStore();
  return {
    async getOrCreateSession(surfaceKey, pageId, atIso) {
      const grain = notionGrainFor(surfaceKey);
      const runtimeChanged = await claimRuntimeRotation({ org, registryKey: grain.registryKey, surfaceKey, atIso });
      const existing = await store.getChannelSession(org, grain.registryKey);
      if (!existing) {
        const row = await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, 1, () => notionSupervisorToken(pageId, 1)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, tail: [] as readonly WakeMessageInput[] };
      }
      if (shouldRotate(existing, atIso, { runtimeChanged })) {
        const gen = existing.generation + 1;
        const tail = await carryTailForward(org, grain.registryKey, existing.token);
        const row = await store.rotateChannelSession(org, grain.registryKey, mintRotationToken(grain, gen, () => notionSupervisorToken(pageId, gen)), atIso);
        return { token: row.token, generation: row.generation, freshGeneration: true, tail };
      }
      const fresh = existing.firstWakeAt == null;
      return { token: existing.token, generation: existing.generation, freshGeneration: fresh, tail: [] as readonly WakeMessageInput[], ...(fresh ? {} : { lastWakeAt: existing.lastWakeAt }) };
    },
    touchSession: (surfaceKey, atIso) => store.touchChannelSession(org, notionGrainFor(surfaceKey).registryKey, atIso),
    recordWake: (entry, token, surfaceKey) => recordWakeTail(org, notionGrainFor(surfaceKey).registryKey, token, entry),
    memoryDelta: liveMemoryDeltaDep(org, surfaceKey),
    now: () => new Date().toISOString(),
    async wake({ token, auth, message, context, state, window }) {
      if (window) {
        if (!to) throw new Error("notion single-window wake has no cross-channel dispatch — refusing (would post an unregistered wake-id)");
        await divertToUnifiedWindow(to, {
          message,
          context: [...context],
          token,
          window,
          surfaceKey,
          auth: auth as unknown as { attributes?: Record<string, unknown> },
        });
        return;
      }
      if (respond !== undefined) {
        const answer = await resolveNotionInboundAnswer({ org, bareToken: token, auth });
        if (answer && (await deliverNotionAnswer({ answerOrg: org, token, auth, message, context, answer, respond, surfaceKey }))) return;
      }
      try {
        await send({ message, context: [...context] }, { auth, continuationToken: token, state });
      } catch (err) {
        await healPrunedDeploymentStrand({
          token,
          registryKey: surfaceKey,
          surfaceKey,
          workspace: surfaceKey.split("/")[1] ?? "unknown",
          platform: "notion",
          atIso: new Date().toISOString(),
          err,
        });
        throw err;
      }
    },
  };
}

type SendFn = (
  payload: { message: string; context?: string[] },
  opts: { auth: unknown; continuationToken: string; state: NotionState },
) => Promise<void>;

function notionSendFrom(from: RouteHandlerArgs<NotionState>["from"]): SendFn {
  return async (payload, opts) => {
    await from(opts.continuationToken).send(payload.message, {
      auth: opts.auth,
      state: opts.state,
      ...(payload.context && payload.context.length > 0 ? { context: payload.context } : {}),
    } as never);
  };
}

type RespondFn = (input: { requestId: string; text: string }, opts: { auth: unknown; continuationToken: string; context?: readonly string[] }) => Promise<void>;

function notionRespondFrom(from: RouteHandlerArgs<NotionState>["from"]): RespondFn {
  return async (input, opts) => {
    await (from(opts.continuationToken) as unknown as { respond: (r: readonly { requestId: string; text: string }[], o: unknown) => Promise<unknown> }).respond(
      [{ requestId: input.requestId, text: input.text }],
      {
        auth: opts.auth,
        ...(opts.context && opts.context.length > 0 ? { context: [...opts.context] } : {}),
      },
    );
  };
}

async function deliverNotionAnswer(input: {
  readonly answerOrg: string;
  readonly token: string;
  readonly auth: unknown;
  readonly message: string;
  readonly context: readonly string[];
  readonly answer: NotionInboundAnswer;
  readonly respond: RespondFn;
  readonly surfaceKey: string;
}): Promise<boolean> {
  const detail = {
    requestId: input.answer.requestId,
    floor: input.answer.floor,
    chars: input.message.length,
    surfaceKey: input.surfaceKey,
    route: "native",
    ...(input.answer.taskId !== undefined ? { taskId: input.answer.taskId } : {}),
    ...(input.answer.wakeId !== undefined ? { wakeId: input.answer.wakeId } : {}),
  };
  const [, workspace = "unknown", surface = "unknown"] = input.surfaceKey.split("/");
  try {
    await input.respond(
      { requestId: input.answer.requestId, text: input.message },
      { auth: input.auth, continuationToken: input.token, context: input.context },
    );
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    log(`answer ${input.answer.requestId} could NOT be delivered (${error}) — falling back to an ordinary wake, the question stays open`);
    await appendAudit({
      org: input.answerOrg,
      platform: "notion",
      workspace,
      surface,
      action: QUESTION_ANSWER_DROPPED_AUDIT_ACTION,
      detail: { ...detail, error },
    }).catch(() => undefined);
    return false;
  }
  await forgetNotionQuestion(input.answerOrg, input.token);
  log(`answer ${input.answer.requestId} delivered to ${input.token} (floor ${input.answer.floor})`);
  await appendAudit({
    org: input.answerOrg,
    platform: "notion",
    workspace,
    surface,
    action: QUESTION_ANSWERED_AUDIT_ACTION,
    detail,
  }).catch(() => undefined);
  return true;
}

export default defineChannel<NotionState, { state: NotionState }>({
  kindHint: "notion",
  state: { discussionId: null, pageId: null, workspaceId: null },
  context(state) {
    return { state };
  },
  routes: [
    POST(ROUTE, async (req, { from, waitUntil, to, attachSession }) => {
      const send = notionSendFrom(from);
      const respond = notionRespondFrom(from);
      const rawBody = await req.text();
      const signature = req.headers.get("x-notion-signature");
      const integrations = notionIntegrations(notionDomains());
      const secrets = new Map<string, Promise<string | undefined>>();
      const inboundSecretFor = (name: string): Promise<string | undefined> => {
        const hit = secrets.get(name);
        if (hit) return hit;
        const resolved = notionInboundSecret(name);
        secrets.set(name, resolved);
        return resolved;
      };
      const signingKeys = await Promise.all(
        integrations.map(async (i) => ({ credentialId: i.credentialId, secret: await inboundSecretFor(i.inboundSecret) })),
      );
      const credentials = new Map<string, Promise<ResolvedNotionCredential | undefined>>();
      const credentialFor = (credentialId: string): Promise<ResolvedNotionCredential | undefined> => {
        const hit = credentials.get(credentialId);
        if (hit) return hit;
        const resolved = resolveNotionCredential(credentialId);
        credentials.set(credentialId, resolved);
        return resolved;
      };
      const botUserFor = (credentialId: string): Promise<{ id?: string; name?: string }> =>
        resolveBotUser(credentialId, () => credentialFor(credentialId))();

      const dispatch = async (d: NotionUntieredSupervisorDispatch): Promise<void> => {
        const grain = notionGrainFor(d.surfaceKey);
        const pageCredential = await credentialFor(d.credentialId);
        const usesWindow = grainUsesUnifiedWindow(grain);
        const privacyOk =
          usesWindow &&
          notionSingleWindowPrivacyOk({
            workspaceKey: notionWorkspaceKey(d.workspaceId ?? "unknown"),
            surfaceKey: d.surfaceKey,
            trust: d.trust,
          });
        const window = usesWindow
          ? planNotionSingleWindow(true, d.addressing === "direct", privacyOk, {
              discussionId: d.discussionId,
              pageId: d.pageId || undefined,
              workspaceId: d.workspaceId,
              credentialId: d.credentialId,
            })
          : undefined;
        const wakeCtx = { channel: { kind: "notion" }, session: { auth: { current: d.auth as unknown as { attributes?: Readonly<Record<string, string>> } } } };
        const trustOf = (m: NotionUntieredWakeMessage) =>
          m.from === "human" && m.authorId ? resolveWakeTrustFromContext(wakeCtx, { id: m.authorId, isBot: false }) : ("relay" as const);

        if ((await ingressSpendGate({
          bindable: wakeCtx,
          door: "mention",
          ...(d.auth.principalId ? { principalId: d.auth.principalId } : {}),
          post: async (text) => { await createCommentReply({ discussionId: d.discussionId, text, apiKey: pageCredential?.apiKey ?? "", endpoints: pageCredential?.endpoints }); },
        })) === "declined") {
          return;
        }

        await handleNotionSupervisorDispatch(
          {
            ...d,
            unified: grain.unified,
            window,
            ...(window?.addressing === "direct-mention" ? { directMention: true } : {}),
            trigger: { ...d.trigger, trust: trustOf(d.trigger) },
            threadComments: d.threadComments.map((m) => ({ ...m, trust: trustOf(m) })),
            externalPolicy: resolveExternalPolicy(externalPolicyOverrideFor(d.surfaceKey, getConfig().loadDomains())),
          },
          liveNotionSupervisorDeps(send, d.surfaceKey, to, respond),
        );
        if (d.trust?.unreachableRoots && d.trust.unreachableRoots.length > 0) {
          console.warn(
            `[open-everywhere:notion] declared trust root(s) ${d.trust.unreachableRoots.join(", ")} resolve as neither a page nor a block under integration "${d.credentialId}" — such a root can never match, so it grants nothing. If it is a TEAMSPACE id, declare the top PAGE of the teamspace instead.`,
          );
        }
        await appendAudit({
          org: deploymentOrg(),
          platform: "notion",
          workspace: d.workspaceId ?? "unknown",
          surface: d.pageId || d.discussionId || "unknown",
          principalId: d.auth.principalId || undefined,
          action: "notion.dispatched",
          detail: {
            ...notionWakeAuditDetail(d.addressing, d.engagedFollowUp, d.domainVia),
            discussionId: d.discussionId,
            ...(window ? { singleWindow: true } : {}),
            ...(d.trust
              ? {
                  trust: {
                    trusted: d.trust.trusted,
                    reason: d.trust.reason,
                    hops: d.trust.hops,
                    ...(d.trust.matchedRoot ? { matchedRoot: d.trust.matchedRoot } : {}),
                    ...(d.trust.unreachableRoots ? { unreachableRoots: d.trust.unreachableRoots } : {}),
                  },
                }
              : {}),
          },
        });
      };

      const outcome = await handleNotionDelivery(rawBody, signature, {
        signingKeys,
        allowUnverified: getSettings().webhooks.allowUnverifiedNotion,
        credentialFor,
        credentialForPage: (workspaceId, pageId) => notionChannelCredentialFor(workspaceId, pageId, notionDomains()),
        domains: notionDomains(),
        trustRoots: notionTrustRoots(),
        resolveBotUserId: async (credentialId) => (await botUserFor(credentialId)).id,
        resolveBotName: async (credentialId) => (await botUserFor(credentialId)).name,
        ambientEnabled: notionAmbientEnabled,
        engagementTier: (surfaceKey) => engagementTierFor(surfaceKey, getConfig().loadDomains()),
        dispatch,
        attachSession,
      });

      if (outcome.verified) {
        const fence = notionTriggerScopeVerdict(rawBody, outcome.signerCredentialId, notionDomains());
        if (!fence.ok) {
          log(`event plane: delivery refused — ${fence.reason}`);
        } else {
          const deliveryId = notionEventDeliveryId(rawBody);
          waitUntil(
            admitTrigger(
              {
                source: NOTION_EVENT_SOURCE,
                headers: {},
                body: rawBody,
                receivedAt: new Date().toISOString(),
                ...(deliveryId ? { deliveryId } : {}),
              },
              { to },
            ).then(
              (report) => {
                if (report.matched > 0) log(`event plane: ${report.matched} matched -> ${report.fired} fired, ${report.skipped} skipped`);
              },
              (err) => log(`event plane: admitTrigger threw (routing lost for this delivery): ${String(err)}`),
            ),
          );
        }
      }

      if (outcome.action === "handshake") {
        try {
          await captureHandshakeSecret(
            { refNamespace: NOTION_HANDSHAKE_REF_NAMESPACE, label: "Notion webhook (verification_token)", value: handshakeToken(rawBody) },
            { log },
          );
        } catch (err) {
          log(`handshake secret could NOT be captured (${err instanceof Error ? err.message : String(err)}) — the value is NOT logged; delete and recreate the Notion subscription once fixed.`);
        }
      } else if (outcome.action === "dispatched") {
        log(`comment.created → dispatched (${outcome.detail})`);
      } else if (outcome.action === "stopped") {
        log(`stop comment → ${outcome.detail}`);
      } else if (outcome.action === "ambient-disabled") {
        const surfaceKey = outcome.detail ?? "";
        waitUntil(
          auditAmbientSkip({
            platform: "notion",
            workspace: surfaceKey.split("/")[1] ?? "unknown",
            surfaceKey,
            log,
          }),
        );
      } else if (outcome.action === "scope-refused") {
        log(`delivery scope-refused: ${outcome.detail}`);
        waitUntil(
          appendAudit({
            org: deploymentOrg(),
            platform: "notion",
            workspace: "unknown",
            action: "notion.scope_refused",
            detail: { reason: outcome.detail ?? null, signer: outcome.signerCredentialId ?? null },
          }),
        );
      } else if (outcome.action === "rejected") {
        log(`delivery rejected (${outcome.status}): ${outcome.detail}`);
        waitUntil(
          appendAudit({
            org: deploymentOrg(),
            platform: "notion",
            workspace: "unknown",
            action: "notion.rejected",
            detail: { status: outcome.status, reason: outcome.detail },
          }),
        );
      } else {
        log(`delivery ${outcome.action}${outcome.detail ? ` (${outcome.detail})` : ""}`);
      }

      return new Response(outcome.body, { status: outcome.status });
    }),
  ],
  events: {
    "turn.started"(_data, channel, ctx) {
      const attrs = ctx?.session?.auth?.current?.attributes as Record<string, unknown> | undefined;
      const s = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
      const discussionId = s(attrs?.discussion_id);
      channel.state.oeReplyTarget = discussionId
        ? ({
            discussionId,
            pageId: s(attrs?.page_id),
            workspaceId: s(attrs?.workspace_id),
            credentialId: s(attrs?.credential_id),
          } satisfies NotionReplyTarget)
        : undefined;
    },
    async "input.requested"(data, channel) {
      const target = channel.state.oeReplyTarget;
      if (target === undefined) return;
      const question = detectBridgeableInputRequest((data as { requests?: unknown } | undefined)?.requests);
      if (!question) return;
      try {
        await postHostNotice({ platform: "notion", ...target }, renderQuestionForSurface(question));
      } catch (err) {
        log(`input-request could not be posted into discussion ${target.discussionId}: ${String(err)}`);
        return;
      }
      const remembered = await rememberNotionQuestion({
        org: deploymentOrg(),
        namespacedToken: channel.continuation?.token,
        requestId: question.requestId,
        discussionId: target.discussionId,
      });
      log(
        remembered
          ? `question bridge: posted ${question.toolName} (${question.kind}) into discussion ${target.discussionId} — answerable there (${question.requestId})`
          : `question bridge: posted ${question.toolName} (${question.kind}) into discussion ${target.discussionId} — NOT answerable (no outstanding-question row); a delegated worker's question will stay parked`,
      );
    },
    async "message.completed"(data, channel, ctx) {
      const sessionId = ctx?.session?.id;
      const action = finalMessageActionForTurn(data.finishReason, data.message);
      if (action.kind === "buffer-tool-status") return;
      const target = channel.state.oeReplyTarget;
      const discussionId = target?.discussionId;
      const repliedThisTurn = consumeSupervisorReplyMark(ctx);
      const org = deploymentOrg();
      const workspace = target?.workspaceId ?? channel.state.workspaceId ?? "unknown";
      await completeSupervisorTurn({
        action,
        ...(sessionId ? { sessionId } : {}),
        repliedViaTool: repliedThisTurn,
        midTurnPost: capabilitiesForPlatform("notion").midTurnPost,
        noReplyAction: "notion.no_reply",
        repliedAction: "notion.replied",
        contextRow: { org, platform: "notion", workspace, surface: target?.pageId ?? channel.state.pageId ?? discussionId ?? "unknown" },
        repliedRow: { org, platform: "notion", workspace, surface: target?.pageId ?? channel.state.pageId ?? discussionId },
        silentAnchor: { discussionId: discussionId ?? channel.state.discussionId },
        droppedAnchor: { discussionId: discussionId ?? null },
        repliedAnchor: { discussionId },
        log: (m) => log(m),
      });
    },
  },
});

function handshakeToken(rawBody: string): string {
  try {
    const t = (JSON.parse(rawBody) as { verification_token?: unknown }).verification_token;
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

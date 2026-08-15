export { CredentialError, registerBroker, getSecretVia, getSecretWithLifetimeVia, resetBrokers } from "./access/credentials.js";
export type { CredentialBroker, BrokeredSecret } from "./access/credentials.js";

export {
  guardCredentialFetch,
  assertCredentialEndpointAllowed,
  credentialEndpointVerdict,
  credentialEndpointProblems,
  CredentialEndpointError,
  CREDENTIAL_HTTP_METHODS,
} from "./access/credential-endpoints.js";
export type { CredentialEndpointRules, CredentialEndpointVerdict, GuardableFetch } from "./access/credential-endpoints.js";

export { warmCredential, DEFAULT_REFRESH_MARGIN_MS } from "./credentials/warm.js";
export type { WarmCredential, WarmCredentialSpec } from "./credentials/warm.js";

export { registerAwsIdentityProvider, resetAwsIdentityProvider, awsRoleSessionName } from "./connections/aws-identity.js";
export type { AwsIdentityProvider, AwsIdentityRequest, AwsCredentials, AwsIdentityKind } from "./connections/aws-identity.js";
export { registerAwsExecutor, resetAwsExecutor } from "./connections/aws-exec.js";
export type { AwsExecutor, AwsExecRequest, AwsExecResult } from "./connections/aws-exec.js";
export {
  registerAwsSsoLinkStore,
  resetAwsSsoLinkStore,
  awsSsoLinkStore,
  requireAwsSsoLinkStore,
} from "./connections/aws-sso-link.js";
export type { AwsSsoLinkStore } from "./connections/aws-sso-link.js";

export { registerDirectoryProvider, directoryProvider, resetDirectoryProvider } from "./identity/directory.js";
export type { DirectoryProvider, DirectoryPerson, DirectoryAccount, DirectoryGrade } from "./identity/directory.js";

export { registerRefCodec } from "./credentials/ref.js";
export type { RefCodec, CredentialRefDeriveInput, ParsedCredentialRef } from "./credentials/ref.js";

export { registerCredentialHome, hostWriteHomeAvailable } from "./credentials/home.js";
export type { CredentialHome, CredentialHomeStoreInput } from "./credentials/home.js";

export { findProviderCredential } from "./access/providers.js";
export type { ProviderCredential } from "./access/providers.js";
export {
  registerExclusiveCredentialHome,
  vercelConnectorHome,
  vercelConnectorOf,
} from "./access/providers.js";
export type { ExclusiveCredentialHome, CredentialHomeRef, ProviderCredentialType } from "./access/providers.js";
export { grantFamilyOf, isHumanActing, principalOfCredential, humanActingSupport } from "./access/providers.js";
export type { CredentialGrantFamily, CredentialLifecycle, CredentialRefreshPosture, HumanActingSupport } from "./access/providers.js";

export { registerDbCredentialBroker, CREDENTIAL_KEY_ENV } from "./credentials/db-broker.js";

export { registerConfigPrProvider } from "./credentials/config-pr.js";
export type { ConfigPrProvider, ConfigPrOutcome, ConfigFileContent, CommitIdentity } from "./credentials/config-pr.js";
export { registerGitHubConfigPrProvider, makeGitHubConfigPrProvider } from "./credentials/config-pr-github.js";

export { parsePrivateKey, signAppJwt, mintInstallationToken } from "./scm/mint.js";
export { loadGitHubAppConfig } from "./scm/config.js";
export {
  composeGitHubInstallations,
  recordGitHubInstallation,
  forgetGitHubInstallation,
  resolveGitHubInstallationId,
  hydrateGitHubInstallations,
} from "./scm/installations.js";
export { getGitHubApp } from "./scm/provider.js";
export { GitHubContents } from "./scm/contents.js";
export type { CommitId } from "./scm/contents.js";
export type { GitHubInstallationRow } from "./operational/store.js";

export { encryptedKvVault } from "./credentials/kv-vault.js";
export type { EncryptedKvVault, EncryptedKvVaultDeps } from "./credentials/kv-vault.js";

export { registerCredentialPurgeHook } from "./credentials/purge.js";
export type { CredentialPurgeHook, CredentialPurgeOutcome } from "./credentials/purge.js";

export { captureHandshakeSecret, secretFingerprint, HANDSHAKE_REVEAL_PRINCIPAL } from "./webhooks/handshake-capture.js";
export type { CaptureHandshakeSecretInput, CaptureHandshakeSecretDeps, CaptureHandshakeSecretOutcome } from "./webhooks/handshake-capture.js";
export { NOTION_HANDSHAKE_REF_NAMESPACE } from "./credentials/reserved-refs.js";

export { registerOeOauthCallbackCompleter, OE_OAUTH_CALLBACK_PATH } from "./connections/oe-oauth-callback.js";
export type { OeOauthCallbackArgs, OeOauthCallbackResult, OeOauthCallbackCompleter } from "./connections/oe-oauth-callback.js";

export { registerAwsSsoCallbackCompleter, OE_AWS_SSO_CALLBACK_PATH } from "./connections/aws-sso-callback.js";
export type { AwsSsoCallbackArgs, AwsSsoCallbackResult, AwsSsoCallbackCompleter } from "./connections/aws-sso-callback.js";

export type { Connection, CredentialAuthorizationDetail } from "./access/bundle.js";

export { registerUserAuthFlow } from "./connections/user-auth-flow.js";
export type { UserAuthFlowProvider, UserAuthSubject, UserTokenMintParams } from "./connections/user-auth-flow.js";

export { registerConnectorTransport } from "./connections/connector-transport.js";
export type {
  ConnectorTransport,
  ConnectorTransportSpec,
  ResolvedConnectorTransport,
} from "./connections/connector-transport.js";

export { registerActionKind } from "./approvals/actions.js";
export type { ActionKind, PendingActionRow } from "./approvals/types.js";

export { platformName, onVercel } from "./access/platform.js";

export { resolveSelfHostBackendKind } from "./sandbox/backend-select.js";
export type { SelfHostBackendKind } from "./sandbox/backend-select.js";

export { isSubagentChildContext, subagentParentSessionId } from "./identity/binding.js";

export { registerBrowserToolkit, registeredBrowserToolkit, resetBrowserToolkitForTest, resolveBrowserKit, BROWSER_TOOL_NAMES } from "./access/browser-toolkit.js";
export type { BrowserToolEntry } from "./access/browser-toolkit.js";

export { registerExtraEgressHosts, extraEgressHosts, resetExtraEgressHostsForTest } from "./access/extra-hosts.js";

export { registerAttachmentResolver, resolveAttachment, resolveGuardedAttachment, AttachmentOversizeError } from "./channels/attachments.js";
export type { AttachmentResolver, ResolvedAttachment, GuardedAttachment } from "./channels/attachments.js";

export { setBlobPutter } from "./blob/hosting.js";
export type { BlobPutter } from "./blob/hosting.js";

export { getConfig, registerConfig } from "./access/config.js";

export { SETTINGS, getSettings, defineSettings, registerSettings, resetSettingsForTest, overrideSettingsForTest, settingDocs, settingEnvNames } from "./settings/settings.js";
export type { AgentSettings, AgentSettingsOverrides, SettingSpec, SettingDoc, TaintTierMode, ApprovalJudgeMode } from "./settings/settings.js";

export { registerProvider, registerPostgres } from "./memory/provider.js";
export type { MemoryProvider, MemoryAccess } from "./memory/provider.js";
export { registerConnectorMemory, connectorMemoryFor, connectorMemoryCapabilities, assertConnectorMemoryGrants, resetConnectorMemoryForTest } from "./memory/connector-memory.js";
export type { ConnectorMemoryCapability, ConnectorMemoryMode, DomainMemoryGrants } from "./memory/connector-memory.js";
export { initPostgresSchema } from "./memory/postgres.js";
export type { PgClient } from "./memory/postgres.js";
export { registerOperationalPostgres, getOperationalStore, registerOperationalStore, resetOperationalStore } from "./operational/provider.js";
export { initOperationalSchema } from "./operational/postgres.js";
export { registerOperationalPglite, registerOperationalPgliteLazy, pgliteOperationalDataDir } from "./operational/pglite-client.js";

export { safeName, tierRelDir, seedFor } from "./memory/layout.js";
export { domainKeyOf, resolvePartition } from "./memory/partition.js";
export type { Partition } from "./memory/partition.js";
export type { MemorySilo } from "./memory/silo.js";
export { makeSelector, normalizeSelection } from "./memory/selection.js";
export type { Selector } from "./memory/selection.js";
export { resolveMemoryPlan } from "./memory/resolve.js";
export type { MemoryResolveConfig } from "./memory/resolve.js";
export { defineMemorySilo } from "./memory/silo.js";
export { siloTier } from "./memory/store.js";
export type { Tier, MemoryFiles } from "./memory/store.js";

export { modelRouteFor, memoryRefs, defineDomain } from "./memory/domain.js";
export type { ModelRoute } from "./memory/domain.js";
export { createRoutedCompactionModel, liveIdentity, resolvePrimaryModel } from "./model/routing.js";
export type { ModelBackend, RoutedCallOptions } from "./model/routing.js";
export { registerImageDescriber } from "./model/vision.js";
export type { ImageDescribeRequest, ImageDescribeResult, ImageDescribeUsage, ImageDescriber } from "./model/vision.js";
export { judgeFromCompletion, registerDreamJudge, dreamJudge } from "./memory/dream/judge.js";
export type { DreamCompletion, DreamJudge } from "./memory/dream/judge.js";
export { facetJudgeFromCompletion, registerFailureFacetJudge } from "./memory/dream/mode3.js";
export { registerHandoffCompletion } from "./model/rotation-handoff.js";
export { registerApprovalJudgeCompletion } from "./access/approval-judge.js";
export type { ApprovalJudgeCompletion, JudgePass } from "./access/approval-judge.js";
export { stampModelCall, readModelStamp, swapModelStamp, withModelStampScope } from "./model/model-stamp.js";
export type { BindableContext } from "./identity/binding.js";

export { installLogShipping } from "./observability/ship.js";
export { initTelemetry, emitTelemetry, registerSurfaceCredentialProbe } from "./observability/telemetry.js";

export { auditToolAction } from "./audit/tool-action.js";
export { registerAuditDropCounter, appendAudit } from "./audit/audit.js";
export type { AuditInput } from "./audit/audit.js";
export { bootVerifyAuditChainTail } from "./audit/chain.js";
export { bootBackfillLinkTenants } from "./identity/link-tenant-backfill.js";

export { registerGovernanceMemberSupplier, _resetGovernanceMemberSupplierForTest } from "./access/audience-floor.js";
export type { RoomRoster, GovernanceMemberSupplier } from "./access/audience-floor.js";

export {
  declareProviderSelection,
  providerSelection,
  providerSelectionDeclared,
  isProviderSelected,
  admitProviderRegistration,
  admitInboundSurface,
  refusedProviderRegistrations,
  clearProviderSelection,
} from "./access/provider-selection.js";
export type { ProviderRegistrationRefusal } from "./access/provider-selection.js";

export { registerDocs, registerProviderDocs, clearDocs, visibleDocs, docIndex, readDoc, normalizeDocPath } from "./docs/registry.js";
export type { DocEntry, RegisteredDoc, DocLookup } from "./docs/registry.js";

export { registerIdentityMapper, deploymentOrg, bindFrom, assertTurnSurface, currentTurnIssue } from "./identity/binding.js";
export type { IdentityMapper, RawIdentity, Visibility, SurfaceBinding } from "./identity/binding.js";
export type { SessionMode } from "./access/resolver.js";

export { registerSurfaces, defineSurface, _resetSurfacesForTest } from "./identity/trust.js";
export { registerSubtreePlatform, applySubtreeSurfaceClaims, subtreeSurfaceKeys, _resetSubtreePlatformsForTest } from "./identity/trust.js";
export type { Surface, SurfaceTrust, SubtreeSurfaceHandler } from "./identity/trust.js";

export { matchesAgentName, agentNameTokens, agentNameTokenPattern, configuredAgentName, DEFAULT_AGENT_SHORT_NAME, DEFAULT_AGENT_FULL_NAME, OE_ADDRESSED_ATTR, OE_BOT_NAME_ATTR } from "./identity/bot-name.js";

export { setRegisteredProviders, resetRegisteredProviders } from "./access/providers.js";

export { ingestUntrustedModelOutput, UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from "./access/untrusted.js";

export type { IngestionSource, IngestionKind, IngestionTier, IngestionVerdict } from "./access/taint-tiers.js";
export { classifyIngestion, INGESTION_KINDS } from "./access/taint-tiers.js";
export { noteIngestionVerdict } from "./access/taint-enforcement.js";
export { taintMarkLands } from "./access/taint-signal.js";

export { untrustedIngestedThisTurn, taintKindsThisTurn } from "./access/taint-signal.js";

export {
  nonMemberChatTrust,
  chatWakeIngestsNonMember,
  nonMemberChatAttrs,
  stampNonMemberChatAuth,
  OE_CHAT_NONMEMBER_ATTR,
} from "./access/taint-signal.js";
export type { IngestedChatMessage, ChatWakeRoom } from "./access/taint-signal.js";

export { sourceScopedMount } from "./access/source-scoped-mount.js";

export { preRegisterDynamicEntry, replayStepNames } from "./access/window-gated.js";
export type { ReplayableToolEntry } from "./access/window-gated.js";

export { markRepliedThisTurn } from "./channels/reply-signal.js";
export { markNoReplyThisTurn } from "./channels/no-reply-signal.js";

export { readAudit } from "./audit/audit.js";

export { registerCapabilityManifest, capabilitiesForPlatform } from "./identity/capabilities.js";
export type { CapabilityManifest } from "./identity/capabilities.js";

export { registerPostArm } from "./channels/post-arms.js";
export type { PostArm, TargetResolveBag, DirectMessageRequest, DirectMessageDelivery } from "./channels/post-arms.js";
export type { ReplyTarget } from "./channels/reply-post.js";
export type { UnifiedReplyDeps } from "./channels/unified-reply.js";

export { postTerminalProse } from "./channels/reply-post.js";
export type { ReplyAudit, ReplierLabel } from "./channels/reply-post.js";

export type { ChatAuditPartition } from "./channels/chat-turn-audit.js";

export { registerWakeOriginCodec, wakeOriginCodec } from "./channels/wake-origin-codec.js";
export type { WakeOriginCodec } from "./channels/wake-origin-codec.js";
export { registerUnifiedWakeTarget, mintWakeId, singleWindowMentionPolicy, rootDmGrainAttrs, OE_GRAIN_ATTR, OE_TASK_LABEL_ATTR } from "./channels/unified-window.js";
export type { UnifiedWakeOrigin, UnifiedWindowWake, SingleWindowMentionPolicy } from "./channels/unified-window.js";

export { windowGrainOf } from "./identity/binding.js";
export type { WindowGrain } from "./identity/binding.js";

export { registerReadAdapter, resolveReadAdapter, READ_ADAPTERS, SUPPORTED_READ_PLATFORMS, supportedReadPlatforms } from "./channels/channel-read.js";
export type { ReadAdapter } from "./channels/channel-read.js";
export { ChannelScopeError } from "./channels/read-scope-error.js";
export { EventDedupe, ThreadFifo } from "./channels/front-queue.js";

export { registerReactionSurface, isRegisteredReactionSurface } from "./channels/reaction-ingest.js";

export { renderWake, mkMessageTrigger } from "./channels/normalized-wake.js";
export type { NormalizedWake, WakeEngagementTier } from "./channels/normalized-wake.js";
export type { WakeMessageInput, WakeTrust, WakeReason } from "./channels/wake-envelope.js";

export { divertToUnifiedWindow } from "./channels/unified.js";

export { supervisorGrainFor, grainUsesUnifiedWindow, mintRotationToken } from "./channels/unified-supervisor.js";
export type { SupervisorGrain } from "./channels/unified-supervisor.js";

export { completeSupervisorTurn, auditSupervisorFailure } from "./channels/supervisor-complete.js";
export type { SupervisorCompletionSpec } from "./channels/supervisor-complete.js";

export {
  finalMessageAction,
  finalMessageActionForTurn,
  isBareStop,
  isNoReply,
  shouldRotate,
  supervisorTextDelivery,
  isSupervisorProseLeak,
  nameDropPattern,
  NO_REPLY_SENTINEL,
  replierLabelFor,
  replierLabelFromAuthAttributes,
  withReplierPrefix,
  truncateTaskLabel,
} from "./channels/turn-delivery.js";
export type { FinalMessageAction, SupervisorTextDelivery } from "./channels/turn-delivery.js";

export { silentRoutineThisTurn, markSilentRoutineTurn, SILENT_ROUTINE_DROP_REASON } from "./routines/report.js";

export { consumeRepliedThisTurn } from "./channels/reply-signal.js";

export { resolveWakeTrustFromContext } from "./identity/wake-trust.js";
export { isVouchedInternal, isVouchedSurface, declaredWorkspaceTrust, declaredSurfaceTrust, declaredTrustForKeys } from "./identity/trust.js";
export type { SurfaceTrustQuery } from "./identity/trust.js";
export { dmTrustTtlMs } from "./identity/trust.js";

export {
  declaredAuthorTrust,
  authorRefutedByRegister,
  registerAuthorTrust,
  defineAuthorTrust,
  armedAuthorTrustTenants,
  _resetAuthorTrustForTest,
} from "./identity/author-trust.js";
export type { AuthorTrust, AuthorTrustEntry, AuthorTrustQuery, AuthorMember } from "./identity/author-trust.js";

export {
  resolveExternalPolicy,
  shippedExternalPolicy,
  authorIsExcluded,
  withholdsBody,
  withholdWakeBodies,
  withheldWakeMessage,
  ingestedAfterWithholding,
  suppressesAddressedWake,
  suppressesAmbientWake,
  roomIsExternalClass,
  roomIsSilenced,
  silentRoomNotice,
  silentNoticeKey,
  WITHHELD_BODY_MARKER,
  EXTERNAL_SENDER_NOTICE,
  SILENT_NOTICE_KINDS,
} from "./access/external-policy.js";
export type {
  ExternalPolicy,
  ExternalPolicyOverride,
  ExternalAuthorGrain,
  ExternalRoomGrain,
  ExternalAuthorFacts,
  ExternalRoomFacts,
  SilentNoticeKind,
} from "./access/external-policy.js";
export { externalPolicyOverrideFor } from "./memory/domain.js";

export { ambientSupervisorEnabled, engagementTierFor, domainForChannel, resolveDomainForChannel, domainClaimVerdict, ambientSkipFor } from "./memory/domain.js";
export type { EngagementTier, Domain, DomainVia, DomainRouting, AmbientSkip } from "./memory/domain.js";
export { auditAmbientSkip, resetAmbientSkipSightings } from "./channels/ambient-skip.js";
export type { AmbientSkipRecord } from "./channels/ambient-skip.js";

export { credentialOverrideFor, domainCredentialId, providerIntegrations } from "./access/domain-credentials.js";
export type { DomainCredentialOverride, ProviderIntegration } from "./access/domain-credentials.js";
export { getOperatorSecret, OperatorSecretNotSetError } from "./credentials/operator-secrets.js";

export { windowTopologyEnabled } from "./access/capabilities.js";

export type { ContextLine } from "./channels/context-render.js";

export { postOnce, outboundKey } from "./operational/post-once.js";

export { liveMemoryDeltaDep } from "./memory/wake-delta.js";

export { registerSurfaceMessageOps, surfaceMessageOps, postSurfaceText, resolveMessagePermalink, setSurfaceReaction } from "./channels/surface-message-ops.js";
export type { SurfaceMessageOps, OutboundFile, MessageRef } from "./channels/surface-message-ops.js";

export { cancelAnchoredTurn, TURN_CANCEL_ACTION } from "./channels/turn-cancel.js";
export type { AttachSessionForCancel, CancelResult, CancelOutcome } from "./channels/turn-cancel.js";
export { turnAnchorKey, turnChannelKey, TURN_ANCHOR_TTL_MS } from "./channels/turn-registry.js";

export {
  registerCardPoster,
  cardPosterFor,
  resolveApprovalClick,
  deliverDecisionFeedback,
  discordDecisionWakeTarget,
  postDiscordDecisionNotice,
} from "./approvals/flow.js";
export type { CardPoster, ApprovalClickResolution, DecisionWakeDeps } from "./approvals/flow.js";
export { clickerFloorRefusalNotice } from "./approvals/clicker-floor.js";
export type { ClickerFloorRefusal } from "./approvals/clicker-floor.js";
export type { ApprovalOutcome } from "./approvals/decision-wake.js";

export { registerNativeAdminCheck, registerNativeMemberCheck } from "./access/native-admin.js";
export type { NativeAdminCheck, NativeMemberCheck } from "./access/native-admin.js";

export { registerScopeLabelResolver } from "./approvals/scope-label.js";
export type { ScopeLabelResolver } from "./approvals/scope-label.js";

export { OE_COMMAND_NAME, runOeCommand } from "./commands/core.js";
export type { OeCommand, OeCommandDeps } from "./commands/core.js";

export { verifyWebhookSignature, webhookMaxSkewSeconds } from "./webhooks/gate.js";

export {
  registerWebhookVerifier,
  webhookVerifier,
  registeredWebhookVerifierSources,
  registeredWebhookVerifiers,
  resetWebhookVerifiersForTest,
} from "./webhooks/verifier.js";
export type { WebhookVerifier, WebhookVerifyInput, WebhookVerdict, WebhookVerifyFailure, WebhookSenderGuidance } from "./webhooks/verifier.js";

export {
  registerEventNormalizer,
  eventNormalizer,
  registeredEventSources,
  resetEventNormalizersForTest,
  scopeIdOf,
} from "./routines/event-model.js";
export type { EventNormalizer, NormalizedEvent, TriggerDelivery, ScopeStep, ScopeKind, EntityPointer } from "./routines/event-model.js";
export {
  registerEventScopeGrant,
  eventScopeGrant,
  registeredEventGrantSources,
  resetEventScopeGrantsForTest,
} from "./routines/event-authz.js";
export type { EventScopeGrant } from "./routines/event-authz.js";
export { checkEventReadGrant } from "./routines/event-authz.js";
export { admitTrigger } from "./routines/ingress.js";
export { validateSubscription } from "./routines/event-match.js";
export { evaluateJqFilter, filterDocument } from "./routines/jq-filter.js";
export type { EventFilterDocument } from "./routines/jq-filter.js";
export type { SubscriptionFilter, FilterClause, ScopeSelector } from "./routines/event-model.js";

export { unifiedSupervisorToken } from "./channels/unified-supervisor.js";

export { nameDropWakeEnabled } from "./memory/domain.js";

export { renderContext, sinceLastAgentReply, WAKE_BACKSCROLL_MAX, contextLineIngestion } from "./channels/context-render.js";
export { clusterBackscroll } from "./channels/backscroll-cluster.js";
export type { NormalizedMessage, BackscrollTrustFor } from "./channels/backscroll-cluster.js";

export {
  bumpThreadSilentStreak,
  disengageThread,
  getThreadEngagement,
  isThreadEngaged,
  markThreadEngaged,
  WARM_SILENT_LIMIT,
} from "./channels/engagement.js";

export { scopeOverBudget } from "./spend/check.js";
export { capBypassFor } from "./spend/bypass.js";
export { ingressSpendGate, spendRefusalCopy, spendBypassWarnCopy, UNICODE_SPEND_BADGES, SLACK_SPEND_BADGES } from "./spend/ingress-gate.js";
export type { IngressSpendGateInput, SpendGateBadges, SpendGateDecision, SpendGateDoor, SpendGateAuditRow } from "./spend/ingress-gate.js";

export { classifyWakeMapping, unmappedWakeCopy, UNMAPPED_WAKE_DROP_REASON } from "./access/wake-mapping.js";
export type { WakeMappingDecision, WakeMappingInput } from "./access/wake-mapping.js";

export { classifyTenantAdmission, admittedTenants, admittedTenantsFromConfig, unadmittedTenantLog, multiTenantPrincipalsAllowed, UNADMITTED_TENANT_DROP_REASON, MULTI_TENANT_ENV } from "./access/tenant-admission.js";
export type { TenantAdmissionDecision, TenantAdmissionInput } from "./access/tenant-admission.js";

export { consumeCardPostedThisTurn, peekCardPostedThisTurn } from "./approvals/card-signal.js";

export { sessionGrantKind, connectorSessionKind, grantButtonLabel } from "./approvals/session-grant.js";

export { isAllowedDriver } from "./testing/driver-allowlist.js";

export { buildIngestedReaction, ingestReaction, liveReactionSink } from "./channels/reaction-ingest.js";
export type { ReactionSinkDeps, ReactionIngestOutcome, ReactionVerb } from "./channels/reaction-ingest.js";

export { assertSurfaceAllowed, chatReadIngestion, readChannelResult, readThreadResult } from "./channels/channel-read.js";
export type { RenderedLine } from "./channels/channel-read.js";

export { refutedReadAuthorIds, distinctReadAuthorIds } from "./channels/read-author-trust.js";
export type { ReadAuthorProbe } from "./channels/read-author-trust.js";

export { auditChannelReadRefusal } from "./channels/read-scope-audit.js";
export type { ReadScopeAuditDeps, ReadScopeReason, ReadScopeRefusal } from "./channels/read-scope-audit.js";

export type { Trust } from "./identity/binding.js";

export { registerSlackBridge, _resetSlackBridgeForTest, slackBridge } from "./channels/slack-bridge.js";
export type { SlackBridge, SlackFormFn, SlackReadCallFn } from "./channels/slack-bridge.js";

export { registerTeamsBridge, _resetTeamsBridgeForTest, teamsBridge } from "./channels/teams-bridge.js";
export type { TeamsBridge, TeamsRoomMembershipCheck, TeamsAccountActiveCheck } from "./channels/teams-bridge.js";

export { markThreadStopped, shouldDeliverReply, classifyParticipation } from "./channels/engagement.js";
export type { ReplyDecision, ParticipationSignals } from "./channels/engagement.js";

export { resolveWakeTrust, backscrollTrustResolver } from "./identity/wake-trust.js";

export { ingestUntrusted } from "./access/untrusted.js";
export { genericReadVerbsEnabled } from "./access/source-scoped-mount.js";

export { awarenessWakeEnabled, statusVerbsFor, DEFAULT_STATUS_VERBS } from "./memory/domain.js";

export type { EngagementRow, ChannelSessionRow, SlackAttachmentRow } from "./operational/store.js";

export {
  isSurfaceOnboarded,
  markSurfaceOnboarded,
  extractPinnedInstructions,
  introMessage,
  instructionBullet,
  ONBOARDED_MARKER,
} from "./onboarding/onboarding.js";

export { consumeNoReplyThisTurn } from "./channels/no-reply-signal.js";
export { consumeReactedThisTurn } from "./channels/react-signal.js";

export { MAX_MESSAGES } from "./channels/context-render.js";

export {
  generateHandoffNote,
  distillRotationHandoff,
  handoffPrompt,
  clampHandoffNote,
  HANDOFF_NOTE_MAX_CHARS,
  recordHandoffNoteLoss,
  missingHandoffHeadings,
  HANDOFF_NOTE_HEADINGS,
  HANDOFF_NOTE_LOSS_AUDIT_ACTION,
  HANDOFF_NOTE_DEGRADED_AUDIT_ACTION,
  type HandoffNoteLossReason,
} from "./model/rotation-handoff.js";

export type { WakeAttachment, WakeParticipant } from "./channels/wake-envelope.js";
export { PREFER_NO_REPLY_TOOL } from "./channels/normalized-wake.js";

export { registeredReactionSurfaces } from "./channels/reaction-ingest.js";
export type { IngestedReaction } from "./channels/reaction-ingest.js";

export { isAllowedSlackDriver, parseDriverAllowlist } from "./testing/driver-allowlist.js";

export { STATUS_REACTION, renderPinned, isPinnedStatusMessage, STOP_HAND_SLACK_NAME, STOP_HAND_UNICODE } from "./status/status.js";
export type { ReactionState } from "./status/status.js";

export { SURFACE, tierId } from "./memory/store.js";
export { getProvider, providerById } from "./memory/provider.js";
export { upsertUnderSection } from "./memory/markdown.js";
export { planFor } from "./memory/resolve.js";

export { getOrCreateDmSeat, touchDmSeat, dmSeatThresholds } from "./channels/dm-seat.js";
export type { DmSeat } from "./channels/dm-seat.js";

export { divertInboundToUnifiedWindow } from "./channels/unified.js";

export { OE_APPROVAL_PREFIX, handleApprovalPayload } from "./approvals/flow.js";
export {
  OE_SETKEY_ACTION_PREFIX,
  OE_SETKEY_MODAL_CALLBACK,
  handleSetKeyClick,
  handleSetKeyViewSubmission,
} from "./credentials/intake.js";
export type { SetKeyViewResult } from "./credentials/intake.js";
export { OE_CONNECT_ACTION_PREFIX, handleConnectClick } from "./connections/connector-card.js";

export { buildRecord, enqueue, flushLogShip } from "./observability/ship.js";

export { parseSlackCommandText } from "./commands/core.js";

export { assertSafeFetchUrl, setHostEgressLookup, type EgressDispatch } from "./access/host-egress.js";

export { REACTION_FEEDBACK_ACTION } from "./channels/reaction-ingest.js";

export { registeredProjectionNames } from "./access/untrusted-projection.js";
export { projectToolSet } from "./access/untrusted-projection.js";

export { registerQuickstartSurfaceGoal } from "./ops/quickstart.js";
export type { SurfaceGoalStep, PlanStep, Check } from "./ops/quickstart.js";
export { registerPreflightProbe } from "./ops/probes.js";
export type { PreflightProbe } from "./ops/probes.js";

export { _resetOperationalDbForTest } from "./operational/sqlite.js";

export { resolveAccessFor } from "./access/request.js";
export { resolveAccess } from "./access/resolver.js";
export type { EffectiveAccess } from "./access/resolver.js";
export { defineBundle, defineBinding } from "./access/bundle.js";

export {
  supervisorRotateQuietGapMs,
  supervisorRotateExpiryMs,
  supervisorRotateTurnBudget,
  supervisorRotateTokenBudget,
  rotationTrigger,
  rotationClockMsFromDays,
  type RotationTrigger,
  type RotationThresholds,
} from "./channels/turn-delivery.js";

export { bindBridged } from "./identity/binding.js";
export { bridgedContext } from "./identity/binding-bridge.js";

export { registerEntityActionAdapter } from "./channels/entity-actions.js";
export type { EntityActionAdapter, EntityRef, EntityVerb } from "./channels/entity-actions.js";

export { registerTicketCreateAdapter } from "./channels/ticket-create.js";
export type { TicketCreateAdapter, TicketCreateFn, TicketDestination, TicketDraft, CreatedTicket } from "./channels/ticket-create.js";

export { gateGithubDelivery, verifyGithubSignature } from "./routines/events.js";
export { fanOutGitHubDelivery } from "./routines/github-fanout.js";

export { registerRoutineDispatch } from "./schedules/routine-dispatch.js";
export type { RoutineDispatchProvider, DispatchTarget } from "./schedules/routine-dispatch.js";
export type { Routine } from "./routines/routine.js";

export { appendUsageEvent, usageForSession } from "./spend/usage-events.js";
export type { ModelPricing, PricingSource } from "./spend/pricing.js";
export { recordSpend, spendTotals } from "./spend/store.js";
export { periodOf } from "./spend/spend.js";
export { estimateSandboxCostUsd } from "./spend/sandbox-pricing.js";
export { routineIdOf } from "./hooks/spend.js";

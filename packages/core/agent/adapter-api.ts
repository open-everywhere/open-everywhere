export { CredentialError, registerBroker, getSecretVia, getSecretWithLifetimeVia, resetBrokers } from "./access/credentials.js";
export type { CredentialBroker, BrokeredSecret } from "./access/credentials.js";

export {
  guardCredentialFetch,
  assertCredentialEndpointAllowed,
  credentialEndpointVerdict,
  credentialEndpointProblems,
  assertCredentialEndpointHostAllowed,
  credentialEndpointHostVerdict,
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
export { offboardDeactivatedAccount, OFFBOARD_REFUSAL } from "./identity/offboarding.js";
export type { DeactivationReport, DeactivationConfirmation, OffboardOutcome } from "./identity/offboarding.js";

export { registerRefCodec } from "./credentials/ref.js";
export type { RefCodec, CredentialRefDeriveInput, ParsedCredentialRef } from "./credentials/ref.js";

export { registerCredentialHome, hostWriteHomeAvailable } from "./credentials/home.js";
export type { CredentialHome, CredentialHomeStoreInput } from "./credentials/home.js";

export { findConnectorCredential } from "./access/connector-credentials.js";
export type { ConnectorCredential } from "./access/connector-credentials.js";
export {
  registerExclusiveCredentialHome,
  vercelConnectorHome,
  vercelConnectorOf,
} from "./access/connector-credentials.js";
export type { ExclusiveCredentialHome, CredentialHomeRef, ConnectorCredentialType } from "./access/connector-credentials.js";
export { grantFamilyOf, isHumanActing, principalOfCredential, humanActingSupport } from "./access/connector-credentials.js";
export type { CredentialGrantFamily, CredentialLifecycle, CredentialRefreshPosture, HumanActingSupport } from "./access/connector-credentials.js";

export { registerDbCredentialBroker, CREDENTIAL_KEY_ENV, credentialKeyArmed } from "./credentials/db-broker.js";

export { registerConfigPrProvider } from "./credentials/config-pr.js";
export type { ConfigPrProvider, ConfigPrOutcome, ConfigFileContent, CommitIdentity } from "./credentials/config-pr.js";
export { registerGitHubConfigPrProvider, makeGitHubConfigPrProvider } from "./credentials/config-pr-github.js";

export { parsePrivateKey, signAppJwt, mintInstallationToken, MEMORY_WRITE_PERMISSIONS } from "./scm/mint.js";
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
export { resolveReadToken, resolveConversationReadToken, resolveSurfaceReadToken } from "./scm/pr-status.js";
export { githubAuthMode } from "./scm/credential.js";
export { CONVERSATION_WRITE_PERMISSIONS } from "./scm/mint.js";
export { prApiHeaders } from "./scm/pr.js";
export type { PrFetchFn } from "./scm/pr.js";
export type { GitHubInstallationRow } from "./operational/store.js";

export { encryptedKvVault } from "./credentials/kv-vault.js";
export type { EncryptedKvVault, EncryptedKvVaultDeps } from "./credentials/kv-vault.js";

export { registerCredentialPurgeHook } from "./credentials/purge.js";
export type { CredentialPurgeHook, CredentialPurgeOutcome, CredentialPurgeReport } from "./credentials/purge.js";

export { captureHandshakeSecret, secretFingerprint, HANDSHAKE_REVEAL_PRINCIPAL } from "./webhooks/handshake-capture.js";
export type { CaptureHandshakeSecretInput, CaptureHandshakeSecretDeps, CaptureHandshakeSecretOutcome } from "./webhooks/handshake-capture.js";
export { NOTION_HANDSHAKE_REF_NAMESPACE } from "./credentials/reserved-refs.js";
export { SLACK_APP_REF_NAMESPACE } from "./credentials/reserved-refs.js";

export { registerOeOauthCallbackCompleter, OE_OAUTH_CALLBACK_PATH } from "./connections/oe-oauth-callback.js";
export { declareConnectionSignIn, declaredConnectionSignIns, _resetConnectionSignInsForTest } from "./connections/connection-sign-in.js";
export type { ConnectionSignIn, DiscoverySignIn, StaticConfidentialSignIn, XaaSignIn } from "./connections/connection-sign-in.js";
export type { OeOauthCallbackArgs, OeOauthCallbackResult, OeOauthCallbackCompleter } from "./connections/oe-oauth-callback.js";

export { registerAwsSsoCallbackCompleter, OE_AWS_SSO_CALLBACK_PATH } from "./connections/aws-sso-callback.js";
export type { AwsSsoCallbackArgs, AwsSsoCallbackResult, AwsSsoCallbackCompleter } from "./connections/aws-sso-callback.js";

export { checkAwsSsoIdentityBinding } from "./connections/aws-sso-identity-binding.js";
export type { AwsSsoBindingVerdict } from "./connections/aws-sso-identity-binding.js";

export { checkXaaIdentityBinding, recordXaaRefusal, OKTA_LINK_PLATFORM, XAA_LINK_REFUSED_ACTION } from "./connections/xaa-identity-binding.js";
export type { XaaBindingStage, XaaBindingVerdict } from "./connections/xaa-identity-binding.js";
export { verifyOidcIdToken } from "./connections/oidc-id-token.js";
export type { VerifiedIdToken } from "./connections/oidc-id-token.js";

export type { Connection, CredentialAuthorizationDetail } from "./access/bundle.js";

export { registerUserAuthFlow, requireUserAuthFlow } from "./connections/user-auth-flow.js";
export type { UserAuthFlowProvider, UserAuthSubject, UserTokenMintParams } from "./connections/user-auth-flow.js";

export { registerConnectorTransport } from "./connections/connector-transport.js";
export type {
  ConnectorTransport,
  ConnectorTransportSpec,
  ResolvedConnectorTransport,
} from "./connections/connector-transport.js";

export { registerActionKind } from "./approvals/actions.js";
export type { ActionKind, PendingActionRow } from "./approvals/types.js";
export { plainSummaryForRow } from "./approvals/plain-summary.js";
export {
  pendingCardLayout,
  pendingCardLines,
  cardFooter,
  decidedCardLine,
  CLICK_NOTICE,
  footerRequester,
  judgeLiftHeadline,
  judgeLiftLines,
  judgeLiftOutcome,
  JUDGE_LIFT_BUTTON,
  optionsWithoutConfirm,
} from "./approvals/card-layout.js";
export type { PendingCardLayout, CardMeta, CardOption, CardOptionVerb, CardOptionTone, UnconfirmedCardOption } from "./approvals/card-layout.js";

export { platformName, onVercel } from "./access/platform.js";

export { resolveSandboxBackend, resolveSelfHostBackendKind, sandboxOnVercel } from "./sandbox/backend-select.js";
export type { SandboxBackendKind, SelfHostBackendKind } from "./sandbox/backend-select.js";

export { BOX_LABEL, BOX_REF_LABEL, boxLabels, clampBoxMinutes, registerLongLivedBoxBackend } from "./sandbox/long-lived-box.js";
export type { BoxListing, BoxPurpose, BoxSpec, LongLivedBoxBackend, OpenedBox } from "./sandbox/long-lived-box.js";

export { emailPolicy, findEmailInbox } from "./email/policy.js";
export type { EmailPolicy } from "./email/policy.js";
export { admitInboundEmail, planReplyRecipients, mayReceiveReply } from "./email/gate.js";
export type { EmailAdmission, EmailRefusalReason } from "./email/gate.js";
export { splitEmailBody, remainderTaints } from "./email/body.js";
export { emailSeatRoute } from "./email/route.js";
export { normalizeEmailAddress, parseMailbox, parseMailboxList, emailDomainOf } from "./email/address.js";
export type { Principal } from "./identity/principals.js";
export { registerEmailTransport, emailTransport } from "./email/transport.js";
export type { EmailTransport, InboundEmail, EmailDeliveryVerdict, EmailReplyRequest, EmailReplyResult, EmailThreadMessage } from "./email/transport.js";

export { registerMeetingCompletion, registerTranscriptionRoute } from "./meetings/transcription.js";
export type { MeetingCompletion, TranscriptionInput, TranscriptionOptions, TranscriptionResult, TranscriptionRoute, TranscriptSegment } from "./meetings/transcription.js";
export { parseVoiceSync, syncDiscordVoice } from "./meetings/discord-voice.js";
export type { VoiceSyncAnswer, VoiceSyncReport } from "./meetings/discord-voice.js";
export { nativeTranscriptSource, registerNativeTranscriptSource } from "./meetings/native.js";
export type { NativeMeetingRef, NativeReadContext, NativeRefusalReason, NativeTranscriptResult, NativeTranscriptSegment, NativeTranscriptSource } from "./meetings/native.js";
export type { NativeTranscriptPolicy } from "./meetings/policy.js";
export { parseWebVtt } from "./meetings/vtt.js";

export { isSubagentChildContext, subagentParentSessionId } from "./identity/binding.js";

export { registerBrowserToolkit, registeredBrowserToolkit, resetBrowserToolkitForTest, resolveBrowserKit, browserPlaneRefusal, openBrowserEgressHosts, BROWSER_TOOL_NAMES } from "./access/browser-toolkit.js";
export type { BrowserToolEntry } from "./access/browser-toolkit.js";

export { browserHostDeclarations, isLoopbackBrowseHost, _setBrowserHostsForTest, resetBrowserHostsForTest } from "./access/browser-hosts.js";
export type { BrowserHostDeclaration } from "./access/browser-hosts.js";

export { registerExtraEgressHosts, extraEgressHosts, resetExtraEgressHostsForTest } from "./access/extra-hosts.js";

export { registerAttachmentResolver, resolveAttachment, resolveGuardedAttachment, AttachmentOversizeError } from "./channels/attachments.js";
export type { AttachmentResolver, ResolvedAttachment, GuardedAttachment } from "./channels/attachments.js";
export { registerVoiceTranscriber, voiceTranscriber, hearVoiceClips, voiceClipBody, isVoiceClip, MAX_VOICE_CLIP_BYTES } from "./channels/voice-clips.js";
export type { VoiceTranscriber, VoiceClipAudio, VoiceClipTranscript, VoiceClipOutcome, VoiceClipLoader } from "./channels/voice-clips.js";

export { getConfig, registerConfig } from "./access/config.js";

export { SETTINGS, getSettings, defineSettings, registerSettings, resetSettingsForTest, overrideSettingsForTest, settingDocs } from "./settings/settings.js";
export type { AgentSettings, AgentSettingsOverrides, SettingSpec, SettingDoc, TaintTierMode, ApprovalJudgeMode, AdminRoleRule, OktaAppSetting, DirectoryAutoConfirm, SandboxBackendChoice, BlanketTrust } from "./settings/settings.js";
export { dataPolicyRows, dataPolicyActive, mergeDataPolicy } from "./model/data-policy.js";
export type { ModelDataPolicy, DataPolicyRegion } from "./model/data-policy.js";
export { DEFAULT_MODEL_VIA, assertRouteTargets, modelTargetFor, resolvableModels, validateModelTargets, viaProblem } from "./model/targets.js";
export type { ModelTarget, ModelTargets, ModelTargetProviders, ResolvableModel } from "./model/targets.js";
export { _resetBareModelRoutesForTest, bareModelFallbacks, bareModelRoutes, bareModelRoutesRegistered, bareModelRoutesUnregistered, bareModelVia, registerBareModelRoutes } from "./model/bare-model-via.js";
export type { BareModelFallback, BareModelRoutes, BareModelVia } from "./model/bare-model-via.js";

export { registerProvider, registerPostgres } from "./memory/provider.js";
export { resolveMemoryProviderId, MEMORY_PROVIDER_FLOOR } from "./memory/provider.js";
export type { MemoryProvider, MemoryAccess } from "./memory/provider.js";
export { registerConnectorMemory, connectorMemoryFor, connectorMemoryCapabilities, assertConnectorMemoryGrants, resetConnectorMemoryForTest } from "./memory/connector-memory.js";
export type { ConnectorMemoryCapability, ConnectorMemoryMode, DomainMemoryGrants } from "./memory/connector-memory.js";
export { initPostgresSchema } from "./memory/postgres.js";
export type { PgClient } from "./memory/postgres.js";
export { registerOperationalPostgres, getOperationalStore, registerOperationalStore, resetOperationalStore } from "./operational/provider.js";
export { resolveOperationalSelection } from "./operational/provider.js";
export type { OperationalFloor } from "./operational/provider.js";
export { stampSurfaceEventVerified, surfaceEventVerifiedAt, _resetSurfaceEventStampMemoForTest } from "./operational/surface-evidence.js";
export type {
  ProactiveAddress,
  OperationalStore,
  IngressDeliveryKey,
  IngressDeliveryWrite,
  DueIngressDelivery,
  ClaimedIngressDelivery,
} from "./operational/store.js";
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
export { buildHomeView, runHomeAction, hasHomeAction, homeDomainsFor, registerHomeSection, registerHomeAction, SLACK_HOME_WIRE } from "./home/home-view.js";
export type { HomeViewer, HomeBlock, HomeItemAction, HomeButton, HomeRoom, HomeDomainMembership, HomeSection, HomeActionResult } from "./home/home-view.js";
export { MEMORY_HOME_ACTIONS } from "./home/memory-home.js";
export { OPT_OUT_HOME_ACTIONS } from "./home/opt-out-home.js";
export { readPersonOptOut, auditPersonOptOutRefusal, PERSON_OPT_OUT_SHORTCUT_NOTICE, PERSON_OPT_OUT_UNREADABLE_NOTICE } from "./identity/person-opt-out.js";
export type { PersonOptOutState, PersonOptOutWhere } from "./identity/person-opt-out.js";
export { RULES_HOME_ACTIONS } from "./home/rules-home.js";
export { WATCH_HOME_ACTIONS } from "./home/watch-home.js";
export { DOING_HOME_ACTIONS } from "./home/doing-home.js";
export { coverForWake } from "./cover/wake.js";
export { readDomainMemory, renderMemoryMarkdown, domainsNamingSilo, isLineDigest } from "./memory/visible.js";
export { memoryLineForReader } from "./memory/provenance-mark.js";
export type { MemoryGroup, MemoryItem } from "./memory/visible.js";
export { registerMemoryWriteObserver } from "./memory/write-road.js";
export type { MemoryWriteEvent } from "./memory/write-road.js";
export type { ModelRoute } from "./memory/domain.js";
export { liveIdentity, resolvePrimaryModel } from "./model/routing.js";
export type { ModelBackend, RoutedCallOptions } from "./model/routing.js";
export { registerImageDescriber } from "./model/vision.js";
export type { ImageDescribeRequest, ImageDescribeResult, ImageDescribeUsage, ImageDescriber } from "./model/vision.js";
export { judgeFromCompletion, registerDreamJudge, dreamJudge } from "./memory/dream/judge.js";
export type { DreamCompletion, DreamJudge } from "./memory/dream/judge.js";
export { facetJudgeFromCompletion, registerFailureFacetJudge } from "./memory/dream/mode3.js";
export { registerApprovalJudgeCompletion } from "./access/approval-judge.js";
export type { ApprovalJudgeCompletion, JudgePass } from "./access/approval-judge.js";
export { stampModelCall, readModelStamp, swapModelStamp, withModelStampScope } from "./model/model-stamp.js";
export { MODEL_AB_RATING_MIN, MODEL_AB_RATING_MAX } from "./model/ab-test.js";
export type { BindableContext } from "./identity/binding.js";

export { installLogShipping } from "./observability/ship.js";
export { initTelemetry, emitTelemetry, registerSurfaceCredentialProbe } from "./observability/telemetry.js";
export { registerStatusProbe, registerSurfaceStatusReporter } from "./ops/status.js";
export { unifiedDomainSessionKey } from "./channels/unified-supervisor.js";
export type { StatusProbe, ProbeAnswer, SurfaceStatus, StatusVerdict } from "./ops/status.js";

export { connectorActingIdentityForTurn, CONNECTOR_ACTING_IDENTITY_ACTION } from "./connections/own-account-gate.js";
export type { ActingIdentityVerdict, OwnAccountVendor } from "./connections/own-account-ask.js";
export { ownAccountVendorFor } from "./connections/own-account-vendors.js";
export { assertGithubActingIdentity, GITHUB_CONNECTOR, GITHUB_OWN_ACCOUNT_VENDOR } from "./scm/github-acting-identity.js";

export { auditToolAction, auditErrorDetail, scrubAuditText } from "./audit/tool-action.js";
export type { AuditDetail, AuditDetailBuilder, AuditTextField, ScrubbedAuditText } from "./audit/scrubbed-text.js";
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

export { registerIdentityMapper, registeredIdentityMapperPlatforms, deploymentOrg, bindFrom, auditSurfaceModeStamp, auditSurfaceModeFrom, assertTurnSurface, TurnOriginFenceError, currentTurnIssue, currentTurnOrganization, authPrincipalId, attestedFireCreatorId } from "./identity/binding.js";
export type { IdentityMapper, RawIdentity, Visibility, SurfaceBinding } from "./identity/binding.js";
export type { SessionMode } from "./access/resolver.js";

export { noteAuthoredRecordRead } from "./channels/read-reach.js";
export type { AuthoredRecordKind, AuthoredRecordRead } from "./channels/read-reach.js";
export { connectorReadsThisTurn } from "./channels/reply-provenance.js";
export type { ConnectorRead, ConnectorReadRecord, SourceLink } from "./channels/reply-provenance.js";

export { surfaceKeySegment, trustGroupKeyFor } from "./identity/binding.js";

export { registerSurfaces, defineSurface, _resetSurfacesForTest } from "./identity/trust.js";

export {
  registerDeploymentIdentity,
  _setDeploymentIdentityForTest,
  _resetDeploymentIdentityForTest,
} from "./identity/deployment-identity.js";
export type { DeploymentIdentity } from "./identity/deployment-identity.js";
export { registerSubtreePlatform, applySubtreeSurfaceClaims, subtreeSurfaceKeys, _resetSubtreePlatformsForTest } from "./identity/trust.js";
export type { Surface, SurfaceTrust, SubtreeSurfaceHandler } from "./identity/trust.js";

export {
  matchesAgentName,
  agentNameTokens,
  agentNameTokenPattern,
  configuredAgentName,
  configuredAgentShortName,
  agentDisplayName,
  agentCommandName,
  DEFAULT_AGENT_SHORT_NAME,
  DEFAULT_AGENT_FULL_NAME,
  DEFAULT_AGENT_DISPLAY_NAME,
  OE_ADDRESSED_ATTR,
  OE_BOT_NAME_ATTR,
} from "./identity/bot-name.js";

export { declaredMcpServers, defineMcpServers } from "./connections/mcp-servers.js";
export type { McpServerDeclaration } from "./connections/mcp-servers.js";

export {
  declareSurfaceCommandScope,
  registerSurfaceCommandReconciler,
  surfaceCommandScopeFor,
  reconcileSurfaceCommands,
  resetSurfaceCommandRegistryForTest,
} from "./channels/command-registration.js";
export type {
  SurfaceCommandScope,
  SurfaceCommandReconciler,
  SurfaceCommandOutcome,
  SurfaceCommandStatus,
  SurfaceCommandReport,
} from "./channels/command-registration.js";

export { registerBotDisplayName, botDisplayNameFor, _resetBotDisplayNamesForTest } from "./identity/bot-display-name.js";
export type { BotDisplayNameArm } from "./identity/bot-display-name.js";

export { registerAccountDisplayName, accountProfileFor, humanAccountLabel, _resetAccountDisplayNamesForTest } from "./identity/account-display-name.js";
export type { AccountProfile, AccountDisplayNameArm } from "./identity/account-display-name.js";

export { registerAccountDirectory, hasAccountDirectory, lookupAccountDirectory, rankDirectoryCandidates, _resetAccountDirectoriesForTest } from "./identity/account-directory.js";
export type { DirectoryCandidate, AccountDirectoryArm, DirectoryLookup } from "./identity/account-directory.js";

export { LINK_CONSENT_CLICK_PREFIX, LINK_CONSENT_CLICK_ACTION, linkConsentClickId, parseLinkConsentClickId, linkConsentActions, resolveLinkConsentClick, commitLinkConsent } from "./identity/link-consent.js";
export type { LinkConsentVerdict, LinkConsentClickResult, ConsentingAccount } from "./identity/link-consent.js";
export { linkTenantOf, tryLinkTenantOf, LINK_TENANT_NONE } from "./identity/link-tenant.js";

export { setRegisteredConnectorCredentials, resetRegisteredConnectorCredentials } from "./access/connector-credentials.js";

export { ingestUntrustedModelOutput, untrustedCloseTag, normalizeFenceNonce, UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from "./access/untrusted.js";

export { ageAtRead } from "./access/dated-read.js";

export type { IngestionSource, IngestionKind, IngestionTier, IngestionVerdict } from "./access/taint-tiers.js";
export { classifyIngestion, INGESTION_KINDS } from "./access/taint-tiers.js";
export { noteIngestionVerdict } from "./access/taint-enforcement.js";
export { registerTaintVerdictSink, currentTaintVerdictSink } from "./access/taint-enforcement.js";
export { taintMarkLands } from "./access/taint-signal.js";

export { untrustedIngestedThisTurn, taintKindsThisTurn } from "./access/taint-signal.js";

export {
  nonMemberChatTrust,
  chatWakeIngestsNonMember,
  nonMemberChatAttrs,
  stampNonMemberChatAuth,
  OE_CHAT_NONMEMBER_ATTR,
  taintedFireAttrs,
} from "./access/taint-signal.js";
export type { IngestedChatMessage, ChatWakeRoom } from "./access/taint-signal.js";

export { sourceScopedMount, workerChatArmMount } from "./access/source-scoped-mount.js";

export { preRegisterDynamicEntry, replayStepNames } from "./access/window-gated.js";
export type { ReplayableToolEntry } from "./access/window-gated.js";

export { markRepliedThisTurn } from "./channels/reply-signal.js";
export { markNoReplyThisTurn } from "./channels/no-reply-signal.js";

export { readAudit } from "./audit/audit.js";

export { registerCapabilityManifest, capabilitiesForPlatform, registeredCapabilityManifestPlatforms } from "./identity/capabilities.js";
export type { CapabilityManifest } from "./identity/capabilities.js";

export {
  registerSurfaceParity,
  surfaceParityFor,
  registeredSurfaceParityPlatforms,
  checkSurfaceParity,
  renderParityTable,
  renderParityMatrix,
  isSupported,
  declarationNote,
  SURFACE_CAPABILITIES,
} from "./identity/surface-parity.js";
export type {
  SurfaceParityDeclaration,
  SurfaceCapability,
  SurfaceCapabilityId,
  CapabilityDeclaration,
  CapabilityGroup,
  CapabilityProbe,
  ParityProblem,
} from "./identity/surface-parity.js";

export { registerPostArm, registeredPostArmPlatforms } from "./channels/post-arms.js";
export type { PostArm, PostIntent, TargetResolveBag, DirectMessageRequest, DirectMessageDelivery, DirectMessageAction, ReactTarget } from "./channels/post-arms.js";
export type { ReplyTarget } from "./channels/reply-post.js";
export type { UnifiedReplyDeps } from "./channels/unified-reply.js";
export type { EditLocus } from "./channels/reply-edit.js";
export { markNotApplied, carryFailureSignals, platformFailureClass } from "./channels/platform-failure.js";
export type { PlatformFailureClass } from "./channels/platform-failure.js";
export { recordOwnPost } from "./channels/own-post-ledger.js";

export { dropClosingProse, CLOSING_PROSE_DROPPED_ACTION } from "./channels/closing-prose-drop.js";
export type { ClosingProseDrop, ClosingProseDropRow } from "./channels/closing-prose-drop.js";
export type { ReplyAudit, ReplierLabel } from "./channels/reply-post.js";
export { postHostNotice } from "./channels/reply-post.js";
export { detectBridgeableInputRequest, renderQuestionForSurface } from "./channels/question-bridge.js";
export type { BridgeableQuestion } from "./channels/question-bridge.js";
export {
  rememberBridgedQuestion,
  readBridgedQuestion,
  forgetBridgedQuestion,
  resolveInboundAnswerRouting,
  QUESTION_ANSWERED_AUDIT_ACTION,
  QUESTION_ANSWER_DROPPED_AUDIT_ACTION,
} from "./channels/question-bridge.js";
export type { OutstandingQuestion, InboundAnswerRouting, BridgedQuestionStore } from "./channels/question-bridge.js";
export { bareTokenFromEveContext } from "./channels/window-key.js";

export { auditNoReplySentinelObserved } from "./channels/chat-turn-audit.js";
export type { ChatAuditPartition } from "./channels/chat-turn-audit.js";

export { registerWakeOriginCodec, wakeOriginCodec } from "./channels/wake-origin-codec.js";
export type { WakeOriginCodec } from "./channels/wake-origin-codec.js";
export { registerUnifiedWakeTarget, mintWakeId, singleWindowMentionPolicy, rootDmGrainAttrs, unifiedThreadRef, OE_GRAIN_ATTR, OE_TASK_LABEL_ATTR } from "./channels/unified-window.js";
export type { UnifiedWakeOrigin, UnifiedWindowWake, SingleWindowMentionPolicy } from "./channels/unified-window.js";
export { slackVendorEventTime, discordVendorEventTime, vendorInstantEventTime, receiptEventTime, spreadVendorTs } from "./channels/wake-timing.js";
export type { VendorEventTime, VendorEventSource } from "./channels/wake-timing.js";

export { windowGrainOf } from "./identity/binding.js";
export type { WindowGrain } from "./identity/binding.js";

export { registerReadAdapter, resolveReadAdapter, READ_ADAPTERS, SUPPORTED_READ_PLATFORMS, supportedReadPlatforms } from "./channels/channel-read.js";
export type { ReadAdapter, WakeReadAddress, AdapterReadFetch } from "./channels/channel-read.js";
export { ChannelScopeError } from "./channels/read-scope-error.js";

export { registerWorkSearchAdapter, registerCoreWorkSearchAdapter, workSearchAdapterFor, registeredSearchConnectors, searchGrantedConnectors } from "./channels/work-search.js";
export type { WorkSearchAdapter, WorkSearchHit, WorkSearchAbsence, WorkSearchOpts } from "./channels/work-search.js";
export { EventDedupe, ThreadFifo } from "./channels/front-queue.js";

export { registerReactionSurface, isRegisteredReactionSurface } from "./channels/reaction-ingest.js";

export { renderWake, mkMessageTrigger } from "./channels/normalized-wake.js";
export type { NormalizedWake, WakeEngagementTier } from "./channels/normalized-wake.js";
export type { WakeMessageInput, WakeTrust, WakeReason } from "./channels/wake-envelope.js";
export { engagedFollowUpContract, ENGAGED_FOLLOW_UP_CONTEXT } from "./channels/engaged-wake.js";
export { auditNameDropWoke, auditNameDropSilent, NAME_DROP_WOKE_ACTION, NAME_DROP_SILENT_ACTION } from "./channels/name-drop-wake-audit.js";
export type { NameDropRoad, NameDropVia, NameDropAuditKey } from "./channels/name-drop-wake-audit.js";

export { divertToUnifiedWindow } from "./channels/unified.js";

export {
  isPrunedDeploymentWakeError,
  markUndeliveredAfterHeal,
  isUndeliveredAfterHeal,
  healPrunedDeploymentStrand,
  RUN_KEY_FETCH_MARKER,
  HTTP_404_MARKER,
  PRUNED_DEPLOYMENT_AUDIT_ACTION,
} from "./channels/stranded-seat.js";
export type { StrandHealInput, StrandHealOutcome } from "./channels/stranded-seat.js";

export { supervisorGrainFor, grainUsesUnifiedWindow, mintRotationToken } from "./channels/unified-supervisor.js";
export type { SupervisorGrain } from "./channels/unified-supervisor.js";

export { claimRuntimeRotation, stampMintedRuntime } from "./channels/runtime-rotation.js";

export { completeSupervisorTurn, auditSupervisorFailure, consumeSupervisorReplyMark } from "./channels/supervisor-complete.js";
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
  wakeNameDropTokens,
  NO_REPLY_SENTINEL,
  NO_REPLY_SENTINEL_REASON,
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
  externalPolicyIsInert,
  roomIsExternalClass,
  roomIsSilenced,
  silentRoomNotice,
  silentNoticeKey,
  WITHHELD_BODY_MARKER,
  EXTERNAL_SENDER_NOTICE,
  EXTERNAL_MENTION_ACK,
  owesSuppressedMentionAck,
  suppressionRendering,
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

export { ambientSupervisorEnabled, admissionNameFor, standingSeatDomainFor, windowedSupervisorEnabled, engagementTierFor, domainForChannel, resolveDomainForChannel, domainReachVerdict, domainRoster, domainContainers, ambientSkipFor, assertDomainsValid, partitionTenantProblems } from "./memory/domain.js";
export type { EngagementTier, Domain, DomainVia, DomainRouting, AmbientSkip } from "./memory/domain.js";
export { auditAmbientSkip, resetAmbientSkipSightings } from "./channels/ambient-skip.js";
export type { AmbientSkipRecord } from "./channels/ambient-skip.js";

export { credentialOverrideFor, domainCredentialId, connectorIntegrations } from "./access/domain-credentials.js";
export type { DomainCredentialOverride, ConnectorIntegration, CredentialBoundDomain } from "./access/domain-credentials.js";
export { callerWorkDomain, callerWorkGrant, workGrantCredential, hasWorkGrant, type WorkDomainResolver } from "./access/work-grant.js";
export type { GrantOwnerSubject } from "./access/credential-grant-owner.js";
export type { CredentialGrantRow, CredentialGrantMode } from "./operational/credential-grant-rows.js";
export { workDestinationPlatforms } from "./channels/work-destinations.js";
export { getOperatorSecret, OperatorSecretNotSetError } from "./credentials/operator-secrets.js";

export { windowTopologyEnabled } from "./access/capabilities.js";

export type { ContextLine } from "./channels/context-render.js";

export { postOnce, outboundKey } from "./operational/post-once.js";

export { liveMemoryDeltaDep } from "./memory/wake-delta.js";

export { swallowRoomPost, swallowRoomOp } from "./channels/egress-spoof.js";
export { registerSurfaceMessageOps, surfaceMessageOps, postSurfaceText, resolveMessagePermalink, setSurfaceReaction } from "./channels/surface-message-ops.js";
export type { SurfaceMessageOps, OutboundFile, MessageRef } from "./channels/surface-message-ops.js";

export { cancelAnchoredTurn, isStopDirective, TURN_CANCEL_ACTION } from "./channels/turn-cancel.js";
export type { AttachSessionForCancel, CancelAnchoredTurnInput, CancelResult, CancelOutcome } from "./channels/turn-cancel.js";
export { turnAnchorKey, turnChannelKey, TURN_ANCHOR_TTL_MS } from "./channels/turn-registry.js";

export { registerSurfaceSessionState } from "./channels/surface-session-state.js";
export type { SurfaceSessionPinner, SurfaceSessionSetter, SurfaceSessionStatus } from "./channels/surface-session-state.js";

export {
  registerCardPoster,
  cardPosterFor,
  registerJudgeLiftNoticePoster,
  judgeLiftNoticePosterFor,
  resolveApprovalClick,
  deliverDecisionFeedback,
  discordDecisionWakeTarget,
  postDiscordDecisionNotice,
  registerDecisionFeedbackSurface,
  decisionFeedbackSurfaceFor,
} from "./approvals/flow.js";
export type { CardPoster, JudgeLiftNoticePoster, ApprovalClickResolution, DecisionWakeDeps, DecisionFeedbackSurface } from "./approvals/flow.js";
export { registerOwnCardRoom, ownCardRoom } from "./approvals/card-venue.js";
export type { OwnCardRoom, OwnCardRoomResolver } from "./approvals/card-venue.js";
export { clickerFloorRefusalNotice } from "./approvals/clicker-floor.js";
export type { ClickerFloorRefusal } from "./approvals/clicker-floor.js";
export { judgeContradictionNotice } from "./approvals/judge-contradiction.js";
export type { ContradictJudgeAllowOutcome } from "./approvals/judge-contradiction.js";
export { admitInputResponse, inputResponseRefusalNotice, INPUT_RESPONSE_DENIED_AUDIT_ACTION } from "./approvals/input-response-floor.js";
export type { InputResponseAdmission, InputResponseRefusal, InputResponseScope } from "./approvals/input-response-floor.js";
export type { ApprovalOutcome } from "./approvals/decision-wake.js";
export { rememberNonMemberAnswer } from "./access/held-question.js";

export { registerNativeAdminCheck, registerNativeMemberCheck } from "./access/native-admin.js";
export { registerDomainMembershipProbe, domainMembershipProbe } from "./access/domain-membership.js";
export type { DomainMembershipProbe, DomainMembershipAnswer, DomainMembershipRoom, DomainMembershipQuery } from "./access/domain-membership.js";
export { registerBotAskProbe, botAskProbe, admitAskedBotReply, rememberBotAsk, BOT_ASK_WINDOW_MS } from "./channels/bot-ask.js";
export type { BotAskProbe, BotAskProbeAnswer, BotAskProbeQuery, BotAskProbeRefusal, BotAskRow, BotAskStore, BotReplyFacts, BotReplyRoute } from "./channels/bot-ask.js";
export type { NativeAdminCheck, NativeMemberCheck } from "./access/native-admin.js";

export { registerScopeLabelResolver } from "./approvals/scope-label.js";
export type { ScopeLabelResolver } from "./approvals/scope-label.js";

export { registerMeetingInviteResolver } from "./meetings/invite.js";
export type { MeetingInviteLookup, MeetingInviteResolver } from "./meetings/invite.js";

export { oeCommandName, oeSlash, runOeCommand } from "./commands/core.js";
export { commandFailureText, COMMAND_FAILED_TEXT, PersonFacingError, TURN_FAILED_TEXT } from "./channels/person-text.js";
export type { OeCommand, OeCommandDeps } from "./commands/core.js";

export { verifyWebhookSignature, webhookMaxSkewSeconds } from "./webhooks/gate.js";

export { getOrMintSelfSecret, selfSecretsArmed } from "./credentials/self-secrets.js";
export { readCappedBody, selfDispatchBaseUrl } from "./channels/self-dispatch.js";

export { securePageResponse, escapeHtml, BUTTON_STYLE, CODE_BLOCK_STYLE } from "./credentials/page-chrome.js";
export { pageBaseUrl } from "./credentials/page-token.js";

export { registerBootNotice, runBootNotices, registeredBootNoticeNames } from "./boot/notices.js";
export { announceJudgeWithoutRules } from "./access/approval-judge.js";
export type { BootNotice } from "./boot/notices.js";

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
export { registerEventReach } from "./routines/event-reach.js";
export type { EventReachProbe } from "./routines/event-reach.js";
export {
  registerProviderEvents,
  providerEventsFor,
  registeredProviderEventPlatforms,
  checkProviderEvents,
  renderProviderEventTable,
  renderProviderEventInventory,
  renderProviderEventMatrix,
} from "./routines/provider-events.js";
export type {
  ProviderEvent,
  ProviderEventDeclaration,
  ProviderEventProblem,
  EventRouting,
  NormalizerFacts,
  NormalizerProbe,
} from "./routines/provider-events.js";
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

export { unifiedSupervisorToken, standingSeatRegistryKey, dmWindowRegistryKey } from "./channels/unified-supervisor.js";

export { nameDropWakeEnabled } from "./memory/domain.js";

export {
  wakeAfterArm,
  wakeArmOffered,
  wakeArmTimeoutMs,
  WAKE_ARM_SURFACE_CONTRACT,
  WAKE_ARM_MAX_TEXT_CHARS,
} from "./channels/wake-arm.js";
export type {
  WakeArmAnswer,
  WakeArmField,
  WakeArmInput,
  WakeArmMessage,
  WakeArmSurface,
  WakeArmSurfaceDeclaration,
  BuiltInWakeAnswer,
} from "./channels/wake-arm.js";

export { renderContext, capLines, sinceLastAgentReply, WAKE_BACKSCROLL_MAX, contextLineIngestion, contextLinesNotInEnvelope, hydrationSlices } from "./channels/context-render.js";
export type { HydrationSlices } from "./channels/context-render.js";
export { fetchedBackscroll, approxMessageTokens, seatCatchUpSinceMs, catchUpSender, SUPERVISOR_BACKSCROLL_REACHBACK_HOURS } from "./channels/backscroll-window.js";
export type { NormalizedMessage, BackscrollTrustFor } from "./channels/backscroll-window.js";
export {
  registerSeatCatchUp,
  seatCatchUp,
  seatCatchUpFetchFor,
  seatCatchUpPrecisionFor,
  seatCatchUpBounds,
  seatAdmissionFor,
  catchUpUnavailableReason,
  _resetSeatCatchUp,
  SEAT_CATCH_UP_ACTION,
  DEFAULT_TIMESTAMP_PRECISION_MS,
} from "./channels/seat-catch-up.js";
export type { SeatCatchUpFetch, SeatCatchUpRequest, SeatCatchUpResult, SeatCatchUpOpts, SeatCatchUpDeclaration } from "./channels/seat-catch-up.js";

export { admissionFunction, admissionFunctionNames, isAdmissionFunctionName, admitToSeat, admitContextLines, DEFAULT_ADMISSION } from "./channels/seat-admission.js";
export type { SeatAdmissionFn, SeatAdmissionCandidate } from "./channels/seat-admission.js";

export { buildTail, selectTail, tailEntryToWakeMessage, tailAuthorGrain, approxEntryTokens, tailTokenCap, SESSION_TAIL_MAX_ENTRIES } from "./channels/session-tail.js";
export type { SessionTailEntry, SessionTailWakeRow } from "./channels/session-tail.js";
export { recordWakeTail, recordPostTail, carryTailForward, seedTailWindow } from "./channels/session-tail-record.js";

export {
  bumpThreadSilentStreak,
  disengageThread,
  getThreadEngagement,
  isThreadEngaged,
  markThreadEngaged,
  roomEngagementAddress,
  WARM_SILENT_LIMIT,
} from "./channels/engagement.js";

export { scopeOverBudget } from "./spend/check.js";
export { capBypassFor } from "./spend/bypass.js";
export { ingressSpendGate, spendRefusalCopy, spendBypassWarnCopy, UNICODE_SPEND_BADGES, SLACK_SPEND_BADGES, type SpendRefusalCopyInput } from "./spend/ingress-gate.js";
export type { IngressSpendGateInput, SpendGateBadges, SpendGateDecision, SpendGateDoor, SpendGateAuditRow } from "./spend/ingress-gate.js";

export { classifyWakeMapping, unmappedWakeCopy, UNMAPPED_WAKE_DROP_REASON } from "./access/wake-mapping.js";
export type { WakeMappingDecision, WakeMappingInput } from "./access/wake-mapping.js";

export { classifyTenantAdmission, admittedTenants, admittedTenantsFromConfig, unadmittedTenantLog, multiTenantPrincipalsAllowed, UNADMITTED_TENANT_DROP_REASON, MULTI_TENANT_SETTING } from "./access/tenant-admission.js";
export type { TenantAdmissionDecision, TenantAdmissionInput } from "./access/tenant-admission.js";

export { consumeCardPostedThisTurn, peekCardPostedThisTurn } from "./approvals/card-signal.js";

export { sessionGrantKind, grantButtonLabel, pendingCardExpiryClause } from "./approvals/session-grant.js";

export { isAllowedDriver } from "./testing/driver-allowlist.js";

export { buildIngestedReaction, ingestReaction, liveReactionSink } from "./channels/reaction-ingest.js";
export type { ReactionSinkDeps, ReactionIngestOutcome, ReactionVerb } from "./channels/reaction-ingest.js";

export { recordReplyFeedback, REPLY_FEEDBACK_ACTION } from "./channels/reply-feedback.js";
export type { ReplyFeedbackClick, ReplyFeedbackRating, ReplyFeedbackSurface } from "./channels/reply-feedback.js";

export { assertSurfaceAllowed, chatReadIngestion, readChannelResult, readThreadResult } from "./channels/channel-read.js";
export type { ReadFile, RenderedLine } from "./channels/channel-read.js";

export { encodeChannelKey, decodeChannelKey, isChannelKey, CHANNEL_KEY_PREFIX } from "./channels/channel-key.js";
export type { ChannelAddress } from "./channels/channel-key.js";

export { refutedReadAuthorIds, distinctReadAuthorIds } from "./channels/read-author-trust.js";
export type { ReadAuthorProbe } from "./channels/read-author-trust.js";

export { auditChannelReadRefusal, auditOriginFenceRefusal, auditSourcesGateRefusal } from "./channels/read-scope-audit.js";
export type { ReadScopeAuditDeps, ReadScopeReason, ReadScopeRefusal } from "./channels/read-scope-audit.js";

export type { Trust } from "./identity/binding.js";

export { registerSlackBridge, _resetSlackBridgeForTest, slackBridge } from "./channels/slack-bridge.js";
export type { SlackBridge, SlackFormFn, SlackReadCallFn } from "./channels/slack-bridge.js";

export { registerTeamsBridge, _resetTeamsBridgeForTest, teamsBridge } from "./channels/teams-bridge.js";
export type {
  TeamsBridge,
  TeamsRoomMembershipCheck,
  TeamsAccountActiveCheck,
  TeamsRoomMembership,
  TeamsMembershipUnresolved,
} from "./channels/teams-bridge.js";

export { markThreadStopped, shouldDeliverReply, classifyParticipation, STAND_DOWN_DELIVERY_REFUSAL } from "./channels/engagement.js";
export type { ReplyDecision, ParticipationSignals } from "./channels/engagement.js";

export { resolveWakeTrust, backscrollTrustResolver } from "./identity/wake-trust.js";

export { ingestUntrusted } from "./access/untrusted.js";

export { statusVerbsFor, DEFAULT_STATUS_VERBS } from "./memory/domain.js";

export type { EngagementRow, ChannelSessionRow, SlackAttachmentRow } from "./operational/store.js";
export { EVENT_DEDUPE_MAX_RETENTION_MS } from "./operational/store.js";

export {
  isSurfaceOnboarded,
  markSurfaceOnboarded,
  extractPinnedInstructions,
  introMessage,
  instructionBullet,
  ONBOARDED_MARKER,
} from "./onboarding/onboarding.js";

export { consumeNoReplyThisTurn } from "./channels/no-reply-signal.js";
export { withEndsTurnFinalChannel } from "./channels/ends-turn-final.js";
export { consumeReactedThisTurn } from "./channels/react-signal.js";
export { consumeStandDownSilenceThisTurn, STAND_DOWN_SILENCE_REASON } from "./channels/stand-down-silence.js";

export { MAX_MESSAGES } from "./channels/context-render.js";

export type { WakeAttachment, WakeParticipant } from "./channels/wake-envelope.js";
export { PREFER_NO_REPLY_TOOL } from "./channels/normalized-wake.js";

export { registeredReactionSurfaces } from "./channels/reaction-ingest.js";
export type { IngestedReaction } from "./channels/reaction-ingest.js";

export { testValveArmed, __setTestValveForTest, type TestValve } from "./testing/test-valves.js";
export { isAllowedSlackDriver, parseDriverAllowlist, configuredDriverAllowlist, driverAllowlistProblem, e2eDriverPrincipals, isE2eDriver, e2eDriversProblem } from "./testing/driver-allowlist.js";
export type { E2eDriverIdentity } from "./testing/driver-allowlist.js";

export { STATUS_REACTION, renderPinned, isPinnedStatusMessage, STOP_HAND_SLACK_NAME, STOP_HAND_UNICODE } from "./status/status.js";
export type { ReactionState } from "./status/status.js";

export { SURFACE, tierId } from "./memory/store.js";
export { getProvider, providerById } from "./memory/provider.js";
export { writeMemoryTier, type MemoryWriteRequest, type MemoryWriteResult, type MemoryWriteRoad, type MemoryWriteKind } from "./memory/write-road.js";
export { upsertUnderSection } from "./memory/markdown.js";
export { planFor, surfaceProvider } from "./memory/resolve.js";

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

export { OE_GRANT_ACTION_PREFIX, grantCardActionId, parseGrantCardActionId, grantCardActions, grantCardText, GRANT_MODE_WORDS } from "./access/credential-grant-card.js";
export type { GrantCardAnswer } from "./access/credential-grant-card.js";
export { handleGrantCardClick, resolveGrantCardClick, GRANT_CARD_CLICK_ACTION } from "./access/credential-grant-click.js";
export type { GrantClicker, GrantClickResult, GrantClickInput } from "./access/credential-grant-click.js";

export { buildRecord, enqueue, flushLogShip } from "./observability/ship.js";

export { parseSlackCommandText, parseOeCommandTokens } from "./commands/core.js";

export { assertSafeFetchUrl, setHostEgressLookup, type EgressDispatch, type EgressRefusalCause } from "./access/host-egress.js";
export { hostPlaneFetch, hostPlanePolicy } from "./access/host-plane-egress.js";
export { useSelfHostEgress } from "./access/self-host-egress.js";
export {
  egressAuditFields,
  hostCallAuditFields,
  sandboxPolicyAuditFields,
  normaliseVerbs,
  EGRESS_AUDIT_ROW_FIELDS,
  type EgressAuditRow,
  type EgressPlane,
  type EgressRowUnit,
  type EgressOutcome,
} from "./access/egress.js";

export { REACTION_FEEDBACK_ACTION } from "./channels/reaction-ingest.js";
export { classifyEmoji } from "./channels/reaction-ingest.js";

export { registeredProjectionNames } from "./access/untrusted-projection.js";
export { projectToolSet } from "./access/untrusted-projection.js";

export type { Check } from "./ops/quickstart.js";
export { registerSurfaceAppManifest, DEPLOY_HOST_PLACEHOLDER } from "./ops/surface-manifest.js";
export { registerSurfaceAppPackage } from "./ops/surface-manifest.js";
export type { SurfaceAppPackageFinding, SurfaceAppPackageInput, SurfaceAppPackageResult } from "./ops/surface-manifest.js";
export { surfaceAppManifest, surfaceAppManifestSurfaces, surfaceAppNameProblem, normalizeDeployHost } from "./ops/surface-manifest.js";
export { surfaceAppPackageSource, surfaceAppPackageSurfaces } from "./ops/surface-manifest.js";
export type { SurfaceAppPackageSource } from "./ops/surface-manifest.js";
export type { SurfaceAppManifestSource, SurfaceAppManifest } from "./ops/surface-manifest.js";
export { registerSurfaceAppCreateFlow, surfaceAppCreateFlow, surfaceAppCreateSurfaces } from "./ops/surface-app-create.js";
export type { SurfaceAppCreateFlow, SurfaceAppCreateResult, SurfaceAppCreateVariant } from "./ops/surface-app-create.js";
export { scmAppPermissionFloor, unionPermissions, SCM_MINT_JOB_SETS } from "./scm/app-permissions.js";
export type { PermissionGrade } from "./scm/app-permissions.js";
export { registerPreflightProbe } from "./ops/probes.js";
export type { PreflightProbe } from "./ops/probes.js";

export { _resetOperationalDbForTest } from "./operational/sqlite.js";

export { resolveAccessFor } from "./access/request.js";
export { resolveAccess } from "./access/resolver.js";
export type { EffectiveAccess } from "./access/resolver.js";
export { defineBundle, defineBinding } from "./access/bundle.js";
export { parseSurfaceKeyEntry, surfaceKeyEntryMatches } from "./identity/surface-key-grammar.js";
export type { SurfaceKeyEntry } from "./identity/surface-key-grammar.js";

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

export { registerEntityActionAdapter, entityActionFn } from "./channels/entity-actions.js";
export type { EntityActionAdapter, EntityActionFn, EntityRef, EntityVerb } from "./channels/entity-actions.js";
export type { RepoCapability } from "./access/repo-capabilities.js";

export { registerTicketCreateAdapter } from "./channels/ticket-create.js";
export type { TicketCreateAdapter, TicketCreateFn, TicketDestination, TicketDraft, CreatedTicket } from "./channels/ticket-create.js";

export { gateGithubDelivery, verifyGithubSignature } from "./routines/events.js";
export { fanOutGitHubDelivery } from "./routines/github-fanout.js";

export { registerRoutineDispatch } from "./schedules/routine-dispatch.js";
export type { RoutineDispatchProvider, RoutineTestRunArm, DispatchTarget, DeclaredTargetSpec, DeclaredTargetResolution } from "./schedules/routine-dispatch.js";
export type { Routine } from "./routines/routine.js";

export { appendUsageEvent, usageForSession } from "./spend/usage-events.js";
export type { ModelPricing } from "./spend/pricing.js";
export { recordSpend, spendTotals } from "./spend/store.js";
export { periodOf } from "./spend/spend.js";
export { estimateSandboxCostUsd } from "./spend/sandbox-pricing.js";
export { routineIdOf, turnSurfaceMode } from "./hooks/spend.js";
export { default as spendHook } from "./hooks/spend.js";

export { liveTaskIds, liveTaskCount } from "./access/live-delegated-tasks.js";
export { workSessionSandboxState } from "./channels/work-generation.js";
export { LIVE_DELEGATED_TASKS_STATE_KEY } from "./access/live-delegated-tasks.js";

export { withRetryAfter, withRetryAfterLoose, parseRetryAfterMs, RateLimitExhaustedError } from "./channels/rate-limit-retry.js";
export { RATE_LIMITED_STATUS, DEFAULT_MAX_ATTEMPTS, DEFAULT_CAP_MS, DEFAULT_FALLBACK_MS, DEFAULT_TOTAL_BUDGET_MS } from "./channels/rate-limit-retry.js";
export type { RateLimitRetryOptions, RetryPolicy } from "./channels/rate-limit-retry.js";

export { classifyConnectorOpTier } from "./access/consequence.js";

export { dispatchNativeWakeWithRetry } from "./channels/native-wake-retry.js";
export type { NativeWakeRetryAttribution } from "./channels/native-wake-retry.js";

export {
  friendlySlackBody,
  friendlyDiscordBody,
  friendlyTeamsActivity,
  friendlyGitHubComment,
  friendlyOutboundText,
  friendlyGuardSource,
  isFriendlyGuarded,
  registerFriendlyNameResolver,
} from "./channels/friendly-outbound.js";
export type { FriendlyNameResolver } from "./channels/friendly-outbound.js";
export type { FriendlyName, FriendlyNameKind } from "./channels/friendly-ids.js";

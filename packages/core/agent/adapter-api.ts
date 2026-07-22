export { CredentialError, registerBroker, getSecretVia, resetBrokers } from "./access/credentials.js";
export type { CredentialBroker } from "./access/credentials.js";

export { registerRefCodec } from "./credentials/ref.js";
export type { RefCodec, CredentialRefDeriveInput, ParsedCredentialRef } from "./credentials/ref.js";

export { registerCredentialHome, hostWriteHomeAvailable } from "./credentials/home.js";
export type { CredentialHome, CredentialHomeStoreInput } from "./credentials/home.js";

export {
  registerExclusiveCredentialHome,
  executorHome,
  vercelConnectorHome,
  executorHomeOf,
  vercelConnectorOf,
} from "./access/providers.js";
export type { ExclusiveCredentialHome, CredentialHomeRef, ExecutorConnectionRef, ProviderCredentialType } from "./access/providers.js";

export { registerDbCredentialBroker, CREDENTIAL_KEY_ENV } from "./credentials/db-broker.js";

export { encryptedKvVault } from "./credentials/kv-vault.js";
export type { EncryptedKvVault, EncryptedKvVaultDeps } from "./credentials/kv-vault.js";

export { registerOeOauthCallbackCompleter, OE_OAUTH_CALLBACK_PATH } from "./connections/oe-oauth-callback.js";
export type { OeOauthCallbackArgs, OeOauthCallbackResult, OeOauthCallbackCompleter } from "./connections/oe-oauth-callback.js";

export type { Connection, CredentialAuthorizationDetail } from "./access/bundle.js";

export { registerUserAuthFlow } from "./connections/user-auth-flow.js";
export type { UserAuthFlowProvider, UserAuthSubject, UserTokenMintParams } from "./connections/user-auth-flow.js";

export { registerConnectorTransport } from "./connections/connector-transport.js";
export type {
  ConnectorTransport,
  ConnectorTransportSpec,
  ResolvedConnectorTransport,
  PausableTransport,
  PausableDispatch,
  TransportPause,
  TransportPauseInteraction,
} from "./connections/connector-transport.js";

export { registerExecutorTransportClient } from "./connections/executor-transport.js";
export { registerExecutorProvisioningClient } from "./connections/executor-user-oauth.js";
export { registerExecutorConnectionStore } from "./credentials/executor-store.js";

export { registerActionKind } from "./approvals/actions.js";
export type { ActionKind, PendingActionRow } from "./approvals/types.js";

export { platformName, onVercel } from "./access/platform.js";

export { setBlobPutter } from "./blob/hosting.js";
export type { BlobPutter } from "./blob/hosting.js";

export { getConfig, registerConfig } from "./access/config.js";

export { registerProvider, registerPostgres } from "./memory/provider.js";
export type { MemoryProvider } from "./memory/provider.js";
export { registerGitHubMemory } from "./memory/github.js";
export { initPostgresSchema } from "./memory/postgres.js";
export type { PgClient } from "./memory/postgres.js";
export { registerOperationalPostgres } from "./operational/provider.js";
export { initOperationalSchema } from "./operational/postgres.js";

export { safeName } from "./memory/layout.js";
export { domainKeyOf, resolvePartition } from "./memory/partition.js";
export type { Partition } from "./memory/partition.js";
export type { MemorySilo } from "./memory/silo.js";
export { makeSelector, normalizeSelection } from "./memory/selection.js";
export type { Selector } from "./memory/selection.js";
export { siloTier } from "./memory/store.js";
export type { Tier, MemoryFiles } from "./memory/store.js";

export { modelRouteFor, memoryRefs, defineDomain } from "./memory/domain.js";
export type { ModelRoute } from "./memory/domain.js";
export { createRoutedCompactionModel, liveIdentity, resolvePrimaryModel } from "./model/routing.js";
export type { ModelBackend, RoutedCallOptions } from "./model/routing.js";
export { registerImageDescriber } from "./model/vision.js";
export type { ImageDescribeRequest, ImageDescribeResult, ImageDescriber } from "./model/vision.js";
export { judgeFromCompletion, registerDreamJudge, dreamJudge } from "./memory/dream/judge.js";
export type { DreamCompletion, DreamJudge } from "./memory/dream/judge.js";
export { facetJudgeFromCompletion, registerFailureFacetJudge } from "./memory/dream/mode3.js";
export { registerHandoffCompletion } from "./model/rotation-handoff.js";
export { stampModelCall, readModelStamp } from "./model/model-stamp.js";
export type { BindableContext } from "./identity/binding.js";

export { installLogShipping } from "./observability/ship.js";
export { initTelemetry, emitTelemetry } from "./observability/telemetry.js";

export { auditToolAction } from "./audit/tool-action.js";
export { registerAuditDropCounter } from "./audit/audit.js";

export { appendUsageEvent } from "./spend/usage-events.js";
export type { ModelPricing, PricingSource } from "./spend/pricing.js";

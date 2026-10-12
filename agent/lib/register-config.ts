import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { registerSettings } from "@open-everywhere/core/agent/settings/settings.js";
import { registerModelPricing } from "@open-everywhere/core/agent/spend/pricing.js";
import { loadModelPricing } from "../spend/model-pricing.js";
import { SETTINGS_OVERRIDES } from "../settings/settings.js";
import { setRegisteredConnectorCredentials } from "@open-everywhere/core/agent/access/connector-credentials.js";
import { assertRoutesWithinPolicy } from "@open-everywhere/core/agent/model/policy.js";
import { assertDomainCredentialsResolvable } from "@open-everywhere/core/agent/access/domain-credentials.js";
import {
  assertWindowSourcesVouched,
  assertGovernanceDomains,
  assertReportChannels,
  warnSilentRoomGrainWithoutPublicSignal,
} from "@open-everywhere/core/agent/memory/domain.js";
import { isVouchedInternal, declaredTrustForKeys } from "@open-everywhere/core/agent/identity/trust.js";
import { resolveExternalPolicy } from "@open-everywhere/core/agent/access/external-policy.js";
import { loadBundles, loadBindings } from "../access/bundles.js";
import { loadNetworkAccess } from "../access/network-access.js";
import { loadConnectorCredentials } from "../access/connector-credentials.js";
import { loadAccessRequests } from "../access/access-requests.js";
import { PLUGIN_REGISTRY } from "../plugins/registry.js";
import { SKILL_CONTENT } from "../plugins/skill-content.js";
import { notionRestSessionFiles } from "../plugins/notion-rest.js";
import { loadDomains, loadSilos, domainsForSurface } from "../memory/config/domains.js";
import { loadRoles } from "../roles/roles.js";
import { loadWebhooks } from "../webhooks/hooks.js";
import { loadSpendBudgets } from "../spend/budgets.js";
import { loadSpendCheckpoints } from "../spend/checkpoints.js";
import { loadModelPolicy } from "../model/policy.js";
import { registerModelAbTest } from "@open-everywhere/core/agent/model/ab-test.js";
import { loadModelAbTest } from "../model/ab-test.js";
import { loadPrincipals } from "../identity/principals.js";
import { loadGroups } from "../identity/groups.js";
import { registerA2aAgents } from "@open-everywhere/core/agent/a2a/agents.js";
import { A2A_AGENTS } from "../access/a2a-agents.js";
import { assertA2aInboundDomains, registerA2aInbound } from "@open-everywhere/core/agent/a2a/inbound/declaration.js";
import { registerA2aInboundPlatform } from "@open-everywhere/core/agent/a2a/inbound/platform.js";
import { A2A_INBOUND } from "../access/a2a-inbound.js";
import "../identity/surfaces.js";
import "../access/browser-hosts.js";
import "../meetings/policy.js";
import "../email/policy.js";
import "../google-chat/policy.js";
import "../personal-browser/policy.js";
import "../identity/authors.js";
import "../routines/collectors.js";
import "../commands/discord-commands.js";
import "./register-docs.js";

registerSettings(SETTINGS_OVERRIDES);

registerModelPricing(loadModelPricing());

registerA2aAgents(A2A_AGENTS);

registerA2aInbound(A2A_INBOUND);
assertA2aInboundDomains(A2A_INBOUND, loadDomains());
registerA2aInboundPlatform();

registerConfig({
  loadBundles,
  loadBindings,
  loadNetworkAccess,
  loadConnectorCredentials,
  pluginRegistry: PLUGIN_REGISTRY,
  skillContent: SKILL_CONTENT,
  skillSessionFiles: { "notion-rest": notionRestSessionFiles },
  loadDomains,
  loadSilos,
  loadRoles,
  domainsForSurface,
  loadWebhooks,
  loadSpendBudgets,
  loadSpendCheckpoints,
  loadAccessRequests,
  loadModelPolicy,
  loadPrincipals,
  loadGroups,
});

registerModelAbTest(loadModelAbTest());

setRegisteredConnectorCredentials(loadConnectorCredentials());

assertRoutesWithinPolicy(loadDomains(), loadRoles(), loadModelPolicy());

assertWindowSourcesVouched(loadDomains(), isVouchedInternal);

assertGovernanceDomains(loadDomains(), isVouchedInternal);

assertReportChannels(loadDomains());

assertDomainCredentialsResolvable(loadDomains(), loadConnectorCredentials());

warnSilentRoomGrainWithoutPublicSignal(loadDomains(), resolveExternalPolicy().roomGrain, (workspaceKey, surfaceKey) =>
  declaredTrustForKeys(workspaceKey, surfaceKey) === "public",
);

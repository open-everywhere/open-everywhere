import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { registerSettings } from "@open-everywhere/core/agent/settings/settings.js";
import { SETTINGS_OVERRIDES } from "../settings/settings.js";
import { setRegisteredProviders } from "@open-everywhere/core/agent/access/providers.js";
import { assertRoutesWithinPolicy } from "@open-everywhere/core/agent/model/policy.js";
import { assertDomainCredentialsResolvable } from "@open-everywhere/core/agent/access/domain-credentials.js";
import { assertWindowSourcesVouched, assertGovernanceDomains, assertComplianceDomains, assertReportChannels } from "@open-everywhere/core/agent/memory/domain.js";
import { isVouchedInternal } from "@open-everywhere/core/agent/identity/trust.js";
import { loadBundles, loadBindings } from "../access/bundles.js";
import { loadNetworkAccess } from "../access/network-access.js";
import { loadProviders } from "../access/providers.js";
import { loadAccessRequests } from "../access/access-requests.js";
import { PLUGIN_REGISTRY } from "../plugins/registry.js";
import { SKILL_CONTENT } from "../plugins/skill-content.js";
import { loadDomains, loadSilos, domainsForSurface } from "../memory/domains.js";
import { loadRoles } from "../roles/roles.js";
import { loadWebhooks } from "../webhooks/hooks.js";
import { loadSpendBudgets } from "../spend/budgets.js";
import { loadSpendCheckpoints } from "../spend/checkpoints.js";
import { loadModelPolicy } from "../model/policy.js";
import { loadBlobHosting } from "../blob/hosting.js";
import { loadPrincipals } from "../identity/principals.js";
import { loadGroups } from "../identity/groups.js";
import "../identity/surfaces.js";
import "./register-docs.js";

registerSettings(SETTINGS_OVERRIDES);

registerConfig({
  loadBundles,
  loadBindings,
  loadNetworkAccess,
  loadProviders,
  pluginRegistry: PLUGIN_REGISTRY,
  skillContent: SKILL_CONTENT,
  loadDomains,
  loadSilos,
  loadRoles,
  domainsForSurface,
  loadWebhooks,
  loadSpendBudgets,
  loadSpendCheckpoints,
  loadAccessRequests,
  loadModelPolicy,
  loadBlobHosting,
  loadPrincipals,
  loadGroups,
});

setRegisteredProviders(loadProviders());

assertRoutesWithinPolicy(loadDomains(), loadRoles(), loadModelPolicy());

assertWindowSourcesVouched(loadDomains(), isVouchedInternal);

assertGovernanceDomains(loadDomains(), isVouchedInternal);

assertReportChannels(loadDomains());

assertComplianceDomains(loadDomains());

assertDomainCredentialsResolvable(loadDomains(), loadProviders());

import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { setRegisteredProviders } from "@open-everywhere/core/agent/access/providers.js";
import { assertRoutesWithinPolicy } from "@open-everywhere/core/agent/model/policy.js";
import { assertWindowSourcesVouched } from "@open-everywhere/core/agent/memory/domain.js";
import { vouchedSurfaces } from "@open-everywhere/core/agent/identity/trust.js";
import { loadBundles, loadBindings } from "../access/bundles.js";
import { loadProviders } from "../access/providers.js";
import { loadAccessRequests } from "../access/access-requests.js";
import { PLUGIN_REGISTRY } from "../plugins/registry.js";
import { SKILL_CONTENT } from "../plugins/skill-content.js";
import { loadDomains, loadSilos, domainsForSurface } from "../memory/domains.js";
import { loadRoles } from "../roles/roles.js";
import { loadWebhooks } from "../webhooks/hooks.js";
import { loadSpendBudgets } from "../spend/budgets.js";
import { loadModelPolicy } from "../model/policy.js";
import { loadBlobHosting } from "../blob/hosting.js";
import { loadPrincipals } from "../identity/principals.js";
import "../identity/trusted-surfaces.js";
import postFileGated from "@open-everywhere/core/agent/tools/post_file.js";
import { setScreenshotPoster } from "@open-everywhere/core/agent/tools/browser_qa.js";
import { resolveWindowGated } from "@open-everywhere/core/agent/access/window-gated.js";
setScreenshotPoster(async (input, ctx) => {
  const entry = (await resolveWindowGated(postFileGated, ctx as never)) as { execute(i: unknown, c: unknown): Promise<unknown> } | null;
  if (!entry) throw new Error("post_file is not available on this seat — deliver the screenshot path instead.");
  return entry.execute(input, ctx);
});

registerConfig({
  loadBundles,
  loadBindings,
  loadProviders,
  pluginRegistry: PLUGIN_REGISTRY,
  skillContent: SKILL_CONTENT,
  loadDomains,
  loadSilos,
  loadRoles,
  domainsForSurface,
  loadWebhooks,
  loadSpendBudgets,
  loadAccessRequests,
  loadModelPolicy,
  loadBlobHosting,
  loadPrincipals,
});

setRegisteredProviders(loadProviders());

assertRoutesWithinPolicy(loadDomains(), loadRoles(), loadModelPolicy());

assertWindowSourcesVouched(loadDomains(), vouchedSurfaces());

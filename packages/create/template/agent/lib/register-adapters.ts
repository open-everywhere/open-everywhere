import { registerDefaultAdapters } from "@open-everywhere/adapters/agent/register-defaults.js";
import { SELECTED_PROVIDERS } from "./providers.generated.js";
import { loadDomains, loadSilos } from "../memory/config/domains.js";
import { domainMemoryGrants } from "./memory-grants.js";

await registerDefaultAdapters({
  providers: SELECTED_PROVIDERS,
  memory: { domains: loadDomains, silos: loadSilos, grants: domainMemoryGrants },
  customAdapters: () => {
  },
});

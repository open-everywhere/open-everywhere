import { defineChannel, GET, POST, type RouteHandlerArgs } from "eve/channels";
import { a2aInboundDeclaration } from "../a2a/inbound/declaration.js";
import { a2aInboundAuditor } from "../a2a/inbound/audit.js";
import { A2A_INBOUND_CARD_ROUTE, A2A_INBOUND_RPC_PATH } from "../a2a/inbound/card.js";
import { handleA2aInboundCard, handleA2aInboundRpc, type A2aInboundHttpDeps } from "../a2a/inbound/handler.js";
import { landA2aInboundCall } from "../a2a/inbound/land.js";
import { pageBaseUrl } from "../credentials/page-token.js";
import { deploymentOrg } from "../identity/binding.js";
import { getOperationalStore } from "../operational/provider.js";
import { getSettings } from "../settings/settings.js";

function liveDeps(to: RouteHandlerArgs["to"] | undefined): A2aInboundHttpDeps {
  const org = deploymentOrg();
  const store = getOperationalStore();
  return {
    enabled: () => getSettings().a2a.inbound,
    declaration: a2aInboundDeclaration,
    store,
    org,
    land: (input) => {
      if (to === undefined) throw new Error("a2a inbound: no live dispatch on this route");
      return landA2aInboundCall(to, input, { org });
    },
    audit: a2aInboundAuditor({ org, markSeen: (o, k, at, ttl) => store.markEventSeen(o, k, at, ttl) }),
    baseUrl: (req) => pageBaseUrl() ?? new URL(req.url).origin,
  };
}

export default defineChannel({
  routes: [
    GET(A2A_INBOUND_CARD_ROUTE, async (req) => handleA2aInboundCard(req, liveDeps(undefined))),
    POST(A2A_INBOUND_RPC_PATH, async (req, { to }) => handleA2aInboundRpc(req, liveDeps(to))),
  ],
});

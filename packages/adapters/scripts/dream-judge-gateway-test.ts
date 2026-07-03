import { utilityRouteForScope, dreamCallSettings, gatewayDreamJudge, registerGatewayDreamJudge } from "../agent/model/dream-judge.js";
import { dreamJudge } from "@open-everywhere/core/agent/memory/dream/judge.js";
import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
const eq = (a: unknown, b: unknown, label: string) => ok(JSON.stringify(a) === JSON.stringify(b), label);

const DEFAULTS = { id: "zai/glm-5.2", gateway: { only: ["fireworks"], zeroDataRetention: true, caching: "auto" } };

{
  eq(utilityRouteForScope("payments-brain"), {}, "route: no config registered → empty route (static defaults, fail quiet)");
}

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    defineDomain({ name: "org", match: "org", models: { utility: { id: "zai/glm-5.2-air" } } }),
    defineDomain({ name: "payments", channels: ["slack/T1/C_PAY"], memory: "payments-brain", models: { utility: { reasoning: "low" } } }),
    defineDomain({ name: "misc", channels: ["slack/T1/C_MISC"], memory: ["misc-brain"] }),
  ],
  loadSilos: () => [],
  domainsForSurface: () => [],
} as never);

{
  eq(utilityRouteForScope("slack/T1/C_PAY"), { id: "zai/glm-5.2-air", reasoning: "low" }, "route: a channel-key scope routes directly (field-inherited org ← domain)");
  eq(utilityRouteForScope("payments-brain"), { id: "zai/glm-5.2-air", reasoning: "low" }, "route: a silo-name scope routes via its owning domain's channels");
  eq(utilityRouteForScope("misc-brain"), { id: "zai/glm-5.2-air" }, "route: a silo in a route-less domain inherits the org utility route");
  eq(utilityRouteForScope("no-such-scope"), { id: "zai/glm-5.2-air" }, "route: an unknown scope falls through to the org pseudo-domain layer");
}

{
  const s = dreamCallSettings({}, DEFAULTS);
  ok(s.id === DEFAULTS.id && s.reasoning === undefined, "settings: empty route → default model, no reasoning override");
  eq((s.providerOptions?.gateway as Record<string, unknown>).only, ["fireworks"], "settings: static gateway defaults backfilled (dream calls arrive bare, like compaction)");

  const routed = dreamCallSettings({ id: "zai/glm-5.2-air", reasoning: "low" }, DEFAULTS);
  ok(routed.id === "zai/glm-5.2-air" && routed.reasoning === "low", "settings: routed id + reasoning applied");
  const gw = routed.providerOptions?.gateway as Record<string, unknown>;
  ok(gw.only === undefined && gw.zeroDataRetention === true, "settings: id change strips the pin, posture keys survive");

  const pinned = dreamCallSettings({ providers: ["zai"] }, DEFAULTS);
  eq((pinned.providerOptions?.gateway as Record<string, unknown>).only, ["zai"], "settings: route providers → gateway `only` pin");
}

{
  const judge = gatewayDreamJudge(DEFAULTS);
  ok(typeof judge.judge === "function" && typeof judge.distill === "function", "judge: gateway transport yields a full DreamJudge");
  registerGatewayDreamJudge(DEFAULTS);
  const registered = dreamJudge();
  ok(registered !== null && typeof registered.judge === "function", "judge: registerGatewayDreamJudge lands it in core's registry (the v2 opt-in)");
}

console.log(`dream-judge-gateway: ${passed} assertions passed`);
